#!/usr/bin/env python3
"""
Synapse desktop tracker for Windows.

Measures how long each desktop app is in the foreground while you are active, and syncs daily
totals to your Synapse AI account using a revocable device key. Standard library only.

What it records: the app's program name (e.g. "VS Code", "Excel") and seconds per day.
What it never records: window titles, file names, keystrokes, screenshots or anything you type.
Browsers are skipped by default because the Synapse browser extension measures websites in detail.

Usage:
    python synapse_tracker.py setup              connect to your Synapse server (asks for address + key)
    python synapse_tracker.py run                start tracking (keep running; use pythonw to hide the window)
    python synapse_tracker.py status             show today's totals and the last sync
    python synapse_tracker.py sync               upload now
    python synapse_tracker.py install-startup    start silently when you sign in to Windows
    python synapse_tracker.py uninstall-startup  stop starting automatically
    python synapse_tracker.py clear              delete totals stored on this computer
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import ntpath
import logging.handlers
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

VERSION = "1.0.0"
SAMPLE_S = 1.0          # how often the foreground app is checked
SAVE_EVERY_S = 30       # write totals to disk
SYNC_EVERY_S = 300      # upload every 5 minutes
MAX_STEP_S = 5.0        # longer gaps (sleep, hibernate) are not credited
SYNC_DAYS = 7
KEEP_DAYS = 30

DEFAULT_CONFIG = {
    "server": "",
    "key": "",
    "idle_seconds": 120,          # no keyboard/mouse input for this long = away
    "ignore_browsers": True,      # the browser extension tracks websites; avoids double counting
    "excluded_apps": [],          # program names to never record, e.g. ["KeePassXC"]
    "category_overrides": {},     # {"Obsidian": "study"}
}

BROWSERS = {"chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "opera_gx.exe", "vivaldi.exe", "arc.exe", "iexplore.exe", "waterfox.exe", "librewolf.exe"}
# Windows shell pieces that aren't "using an app".
IGNORED = {"lockapp.exe", "searchhost.exe", "searchapp.exe", "shellexperiencehost.exe", "startmenuexperiencehost.exe", "logonui.exe", "screenclippinghost.exe", "textinputhost.exe", "systemsettingsbroker.exe"}

FRIENDLY = {
    "code.exe": "VS Code", "devenv.exe": "Visual Studio", "pycharm64.exe": "PyCharm", "idea64.exe": "IntelliJ IDEA", "webstorm64.exe": "WebStorm",
    "windowsterminal.exe": "Terminal", "cmd.exe": "Command Prompt", "powershell.exe": "PowerShell", "pwsh.exe": "PowerShell",
    "explorer.exe": "File Explorer", "notepad.exe": "Notepad", "notepad++.exe": "Notepad++",
    "winword.exe": "Word", "excel.exe": "Excel", "powerpnt.exe": "PowerPoint", "onenote.exe": "OneNote", "outlook.exe": "Outlook", "olk.exe": "Outlook",
    "ms-teams.exe": "Teams", "teams.exe": "Teams", "slack.exe": "Slack", "discord.exe": "Discord", "zoom.exe": "Zoom",
    "whatsapp.exe": "WhatsApp", "whatsapp.root.exe": "WhatsApp", "telegram.exe": "Telegram", "signal.exe": "Signal",
    "spotify.exe": "Spotify", "vlc.exe": "VLC", "netflix.exe": "Netflix", "steam.exe": "Steam", "steamwebhelper.exe": "Steam",
    "notion.exe": "Notion", "obsidian.exe": "Obsidian", "figma.exe": "Figma", "postman.exe": "Postman", "docker desktop.exe": "Docker Desktop",
    "acrobat.exe": "Acrobat", "acrord32.exe": "Acrobat Reader", "sumatrapdf.exe": "SumatraPDF", "photoshop.exe": "Photoshop", "blender.exe": "Blender",
    "chrome.exe": "Chrome", "msedge.exe": "Edge", "firefox.exe": "Firefox", "brave.exe": "Brave",
    "systemsettings.exe": "Settings", "calculatorapp.exe": "Calculator", "mstsc.exe": "Remote Desktop", "anki.exe": "Anki",
}

CATEGORIES = {
    "work": {"VS Code", "Visual Studio", "PyCharm", "IntelliJ IDEA", "WebStorm", "Terminal", "Command Prompt", "PowerShell", "Word", "Excel", "PowerPoint", "OneNote", "Notion", "Figma", "Postman", "Docker Desktop", "Acrobat", "Photoshop", "Blender", "Notepad++", "Remote Desktop"},
    "study": {"Obsidian", "Anki", "Acrobat Reader", "SumatraPDF"},
    "communication": {"Outlook", "Teams", "Slack", "Discord", "Zoom", "WhatsApp", "Telegram", "Signal"},
    "entertainment": {"Spotify", "VLC", "Netflix"},
    "games": {"Steam"},
}
VALID_CATEGORIES = {"work", "study", "social", "entertainment", "games", "news", "communication", "other"}

APP_DIR = Path(os.environ.get("APPDATA") or Path.home() / ".config") / "SynapseTracker"
CONFIG_PATH = APP_DIR / "config.json"
TOTALS_PATH = APP_DIR / "totals.json"
STATE_PATH = APP_DIR / "state.json"
LOG_PATH = APP_DIR / "tracker.log"
LOCK_PATH = APP_DIR / "tracker.lock"

log = logging.getLogger("synapse")


# --------------------------------------------------------------------------- storage helpers
def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path: Path, data) -> None:
    """Atomic write so a crash or power cut never leaves a half-written file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def load_config() -> dict:
    return {**DEFAULT_CONFIG, **read_json(CONFIG_PATH, {})}


def friendly_name(exe_path: str) -> str:
    exe = ntpath.basename(exe_path).lower()
    if exe in FRIENDLY:
        return FRIENDLY[exe]
    stem = ntpath.splitext(ntpath.basename(exe_path))[0]
    return stem[:1].upper() + stem[1:] if stem else "Unknown app"


def categorize(app: str, overrides: dict) -> str:
    if overrides.get(app) in VALID_CATEGORIES:
        return overrides[app]
    for cat, apps in CATEGORIES.items():
        if app in apps:
            return cat
    return "other"


# --------------------------------------------------------------------------- Windows APIs
class WindowsPlatform:
    """Foreground process and idle time via user32/kernel32 (ctypes, no extra packages)."""

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

    def __init__(self):
        import ctypes
        from ctypes import wintypes

        self.ctypes, self.wintypes = ctypes, wintypes
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        u, k = self.user32, self.kernel32

        class LASTINPUTINFO(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]

        self.LASTINPUTINFO = LASTINPUTINFO
        u.GetForegroundWindow.restype = wintypes.HWND
        u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        u.GetWindowThreadProcessId.restype = wintypes.DWORD
        u.GetLastInputInfo.argtypes = [ctypes.POINTER(LASTINPUTINFO)]
        u.GetLastInputInfo.restype = wintypes.BOOL
        self.EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        u.EnumChildWindows.argtypes = [wintypes.HWND, self.EnumProc, wintypes.LPARAM]
        u.EnumChildWindows.restype = wintypes.BOOL
        k.GetTickCount.restype = wintypes.DWORD
        k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k.OpenProcess.restype = wintypes.HANDLE
        k.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        k.QueryFullProcessImageNameW.restype = wintypes.BOOL
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        k.CloseHandle.restype = wintypes.BOOL

    def idle_seconds(self) -> float:
        lii = self.LASTINPUTINFO()
        lii.cbSize = self.ctypes.sizeof(self.LASTINPUTINFO)
        if not self.user32.GetLastInputInfo(self.ctypes.byref(lii)):
            return 0.0
        return ((self.kernel32.GetTickCount() - lii.dwTime) & 0xFFFFFFFF) / 1000.0

    def _pid_of(self, hwnd) -> int:
        pid = self.wintypes.DWORD()
        self.user32.GetWindowThreadProcessId(hwnd, self.ctypes.byref(pid))
        return pid.value

    def _exe_of(self, pid: int) -> str | None:
        h = self.kernel32.OpenProcess(self.PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return None
        try:
            size = self.wintypes.DWORD(1024)
            buf = self.ctypes.create_unicode_buffer(size.value)
            if self.kernel32.QueryFullProcessImageNameW(h, 0, buf, self.ctypes.byref(size)):
                return buf.value
            return None
        finally:
            self.kernel32.CloseHandle(h)

    def foreground_exe(self) -> str | None:
        hwnd = self.user32.GetForegroundWindow()
        if not hwnd:
            return None  # nothing focused, e.g. the workstation is locked
        pid = self._pid_of(hwnd)
        exe = self._exe_of(pid)
        # Store apps (Calculator, Settings, WhatsApp...) run inside ApplicationFrameHost; find the real process.
        if exe and ntpath.basename(exe).lower() == "applicationframehost.exe":
            found = []

            def cb(child, _):
                cpid = self._pid_of(child)
                if cpid and cpid != pid:
                    found.append(cpid)
                    return False
                return True

            self.user32.EnumChildWindows(hwnd, self.EnumProc(cb), 0)
            if found:
                exe = self._exe_of(found[0]) or exe
        return exe


# --------------------------------------------------------------------------- tracker
class Tracker:
    def __init__(self, platform, config: dict, clock=time.time):
        self.platform = platform
        self.config = config
        self.clock = clock
        self.totals: dict[str, dict[str, float]] = read_json(TOTALS_PATH, {})
        self.state: dict = read_json(STATE_PATH, {})
        self.last_tick: float | None = None
        self.last_save = self.last_sync = clock()
        self.current: str | None = None
        self.sync_backoff = 0.0

    # -- sampling
    def active_app(self) -> str | None:
        if self.platform.idle_seconds() >= self.config["idle_seconds"]:
            return None
        exe = self.platform.foreground_exe()
        if not exe:
            return None
        base = ntpath.basename(exe).lower()
        if base in IGNORED or base.endswith(".scr"):
            return None
        if self.config["ignore_browsers"] and base in BROWSERS:
            return None
        app = friendly_name(exe)
        excluded = {a.lower() for a in self.config.get("excluded_apps", [])}
        if app.lower() in excluded or base in excluded or base.removesuffix(".exe") in excluded:
            return None
        return app

    def tick(self) -> None:
        now = self.clock()
        if self.last_tick is not None and self.current:
            step = min(now - self.last_tick, MAX_STEP_S)
            if step > 0:
                day = dt.datetime.fromtimestamp(now - step / 2).strftime("%Y-%m-%d")
                bucket = self.totals.setdefault(day, {})
                bucket[self.current] = bucket.get(self.current, 0.0) + step
        self.last_tick = now
        try:
            self.current = self.active_app()
        except Exception as e:  # never let one bad sample stop tracking
            log.warning("sample failed: %s", e)
            self.current = None

        if now - self.last_save >= SAVE_EVERY_S:
            self.save()
        if now - self.last_sync >= SYNC_EVERY_S + self.sync_backoff:
            self.sync()

    def prune(self) -> None:
        cutoff = (dt.date.today() - dt.timedelta(days=KEEP_DAYS)).isoformat()
        for day in [d for d in self.totals if d < cutoff]:
            del self.totals[day]

    def save(self) -> None:
        self.prune()
        write_json(TOTALS_PATH, self.totals)
        write_json(STATE_PATH, self.state)
        self.last_save = self.clock()

    # -- syncing
    def payload(self) -> list[dict]:
        overrides = self.config.get("category_overrides", {})
        days = []
        for day in sorted(self.totals)[-SYNC_DAYS:]:
            entries = [
                {"app": app, "category": categorize(app, overrides), "minutes": round(sec / 60, 2)}
                for app, sec in sorted(self.totals[day].items(), key=lambda kv: -kv[1])
                if sec >= 3
            ]
            if entries:
                days.append({"day": day, "entries": entries[:300]})
        return days

    def sync(self) -> bool:
        self.last_sync = self.clock()
        server, key = self.config.get("server"), self.config.get("key")
        if not server or not key:
            self.state.update(ok=False, last_error="Not connected. Run: python synapse_tracker.py setup")
            return False
        days = self.payload()
        if not days:
            return True
        try:
            api(server, key, "PUT", "/api/device/usage", {"days": days})
            self.state.update(ok=True, last_sync=time.time(), last_error=None)
            self.sync_backoff = 0
            log.info("synced %d day(s)", len(days))
            return True
        except ApiError as e:
            self.state.update(ok=False, last_error=str(e), last_error_at=time.time())
            # revoked key: wait an hour; consent off or server down: back off up to 30 minutes
            self.sync_backoff = 3600 if e.status == 401 else min(1800, (self.sync_backoff or 60) * 2)
            log.warning("sync failed: %s", e)
            return False
        finally:
            write_json(STATE_PATH, self.state)

    def run(self) -> None:
        log.info("tracker %s started (idle after %ss, browsers %s)", VERSION, self.config["idle_seconds"], "ignored" if self.config["ignore_browsers"] else "counted")
        try:
            while True:
                self.tick()
                time.sleep(SAMPLE_S)
        except KeyboardInterrupt:
            pass
        finally:
            self.tick()
            self.save()
            self.sync()
            log.info("tracker stopped")


# --------------------------------------------------------------------------- HTTP
class ApiError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def api(server: str, key: str, method: str, path: str, body=None):
    req = urllib.request.Request(
        server.rstrip("/") + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json", "User-Agent": f"SynapseTracker/{VERSION}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("error")
        except Exception:
            msg = None
        raise ApiError(msg or f"Server replied {e.code}", e.code) from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ApiError(f"Could not reach {server} ({getattr(e, 'reason', e)})") from None


# --------------------------------------------------------------------------- single instance
def acquire_lock():
    APP_DIR.mkdir(parents=True, exist_ok=True)
    f = open(LOCK_PATH, "a+")
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return None
    return f


# --------------------------------------------------------------------------- commands
def fmt(sec: float) -> str:
    m = round(sec / 60)
    return f"{m // 60}h {m % 60:02d}m" if m >= 60 else f"{m}m"


def cmd_setup(_args) -> int:
    cfg = load_config()
    print("Connect the desktop tracker to Synapse.")
    print("In Synapse, open Privacy > Connect desktop tracker to get a key.\n")
    server = input(f"Server address [{cfg['server'] or 'http://localhost:3000'}]: ").strip() or cfg["server"] or "http://localhost:3000"
    if not server.startswith(("http://", "https://")):
        print("The address must start with http:// or https://")
        return 1
    key = input("Device key (starts with syn_): ").strip() or cfg["key"]
    if not key.startswith("syn_"):
        print("That doesn't look like a Synapse device key.")
        return 1
    try:
        info = api(server, key, "GET", "/api/device/ping")
    except ApiError as e:
        print(f"Couldn't connect: {e}")
        return 1
    cfg.update(server=server.rstrip("/"), key=key)
    browsers = input("Also count time in web browsers? Say no if you use the Synapse browser extension [y/N]: ").strip().lower()
    cfg["ignore_browsers"] = browsers not in ("y", "yes")
    write_json(CONFIG_PATH, cfg)
    print(f"\nConnected as {info['user']} ({info['device']}).")
    if not info.get("usageConsent"):
        print('Turn on "Save screen-time data" in Synapse > Privacy, or uploads will be refused.')
    print("Start tracking with:  pythonw synapse_tracker.py run")
    print("Start automatically:  python synapse_tracker.py install-startup")
    return 0


def setup_logging(to_console: bool) -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    handlers = [logging.handlers.RotatingFileHandler(LOG_PATH, maxBytes=512_000, backupCount=2, encoding="utf-8")]
    if to_console and sys.stdout:
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=handlers)


def cmd_run(_args) -> int:
    if os.name != "nt":
        print("The desktop tracker currently supports Windows only.")
        return 1
    setup_logging(to_console=sys.stdout is not None and sys.stdout.isatty())
    lock = acquire_lock()
    if not lock:
        print("The tracker is already running.")
        return 0
    cfg = load_config()
    if not cfg["server"] or not cfg["key"]:
        print("Not connected yet. Run:  python synapse_tracker.py setup")
        log.warning("not configured; tracking locally only")
    Tracker(WindowsPlatform(), cfg).run()
    return 0


def cmd_status(_args) -> int:
    cfg, totals, state = load_config(), read_json(TOTALS_PATH, {}), read_json(STATE_PATH, {})
    today = dt.date.today().isoformat()
    apps = sorted(totals.get(today, {}).items(), key=lambda kv: -kv[1])
    print(f"Synapse desktop tracker {VERSION}")
    print(f"Server: {cfg['server'] or 'not connected'}   Browsers: {'ignored' if cfg['ignore_browsers'] else 'counted'}")
    if state.get("last_sync"):
        print("Last sync:", dt.datetime.fromtimestamp(state["last_sync"]).strftime("%Y-%m-%d %H:%M"))
    if state.get("last_error"):
        print("Last problem:", state["last_error"])
    print(f"\nToday ({today}): {fmt(sum(s for _, s in apps))}")
    for app, sec in apps[:15]:
        print(f"  {app:<28}{fmt(sec):>9}  {categorize(app, cfg['category_overrides'])}")
    if not apps:
        print("  Nothing recorded yet today. Is the tracker running?")
    return 0


def cmd_sync(_args) -> int:
    t = Tracker(None, load_config())
    ok = t.sync()
    print("Synced." if ok else f"Sync failed: {t.state.get('last_error')}")
    return 0 if ok else 1


def startup_script() -> Path:
    return Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup" / "SynapseTracker.vbs"


def cmd_install_startup(_args) -> int:
    if os.name != "nt":
        print("Windows only.")
        return 1
    pyw = Path(sys.executable).with_name("pythonw.exe")
    if not pyw.exists():
        pyw = Path(sys.executable)
    script = Path(__file__).resolve()
    # Run hidden (window style 0) so no console appears at sign-in.
    startup_script().write_text(f'CreateObject("WScript.Shell").Run """{pyw}"" ""{script}"" run", 0, False\r\n', encoding="utf-8")
    print(f"Installed. The tracker will start silently when you sign in.\n  {startup_script()}")
    print("Start it now without signing out:  pythonw synapse_tracker.py run")
    return 0


def cmd_uninstall_startup(_args) -> int:
    try:
        startup_script().unlink()
        print("Removed from startup. If it's running now, end pythonw.exe in Task Manager.")
    except (FileNotFoundError, KeyError):
        print("It wasn't set to start automatically.")
    return 0


def cmd_clear(_args) -> int:
    if input("Delete totals stored on this computer? Data already sent to Synapse stays. [y/N]: ").strip().lower() in ("y", "yes"):
        write_json(TOTALS_PATH, {})
        print("Cleared. Restart the tracker if it's running.")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Synapse desktop tracker", formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("Usage:")[1])
    p.add_argument("command", nargs="?", default="run", choices=["setup", "run", "status", "sync", "install-startup", "uninstall-startup", "clear"])
    args = p.parse_args(argv)
    return {
        "setup": cmd_setup, "run": cmd_run, "status": cmd_status, "sync": cmd_sync,
        "install-startup": cmd_install_startup, "uninstall-startup": cmd_uninstall_startup, "clear": cmd_clear,
    }[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
