# Synapse desktop tracker (Windows and macOS)

Measures how long each desktop app is in front of you while you're active, and adds the daily totals to your Synapse account. A single Python file using only the standard library.

On a Mac, see [macOS](#macos) below; everything else in this guide applies to both.

## Requirements

- Windows 10 or 11
- Python 3.9 or newer (from python.org or the Microsoft Store). Check with `python --version`.

## Set up

1. In Synapse, go to **Privacy → Connect desktop tracker**, name it, and copy the key.
2. Make sure **Save screen-time data** is on in the same page.
3. In a terminal in this folder:

   ```powershell
   python synapse_tracker.py setup
   ```

   Paste the server address (for example `http://localhost:3000`) and the key. Say **no** to counting browsers if you use the Synapse browser extension, so web time isn't counted twice.

4. Start it:

   ```powershell
   pythonw synapse_tracker.py run
   ```

   `pythonw` runs it without a console window. Use `python synapse_tracker.py run` instead to watch the log.

5. Optional: start it automatically when you sign in:

   ```powershell
   python synapse_tracker.py install-startup
   ```

   This adds a small launcher to your Startup folder. Remove it with `uninstall-startup`.

## macOS

Requires macOS 11 or newer and Python 3.9+. Check with `python3 --version`; if it's missing, macOS offers to install it.

```bash
python3 synapse_tracker.py setup            # paste the server address and key from Synapse > Privacy
python3 synapse_tracker.py run              # Ctrl+C to stop
python3 synapse_tracker.py install-startup  # start at login, in the background
```

- **How it measures:** the foreground app comes from `lsappinfo` and idle time from `ioreg`. Both are built into macOS, so no Accessibility or Screen Recording permission is needed.
- **Starting at login:** `install-startup` adds a LaunchAgent at `~/Library/LaunchAgents/ai.synapse.tracker.plist`, which also starts it now and restarts it if it crashes. `uninstall-startup` removes it.
- **Not counted:** Safari, Chrome, Arc, Firefox, Edge and Brave by default (the browser extension covers them), plus the lock screen, screen saver, Dock and Control Center.
- **Where data lives:** `~/Library/Application Support/SynapseTracker/`.

## Everyday commands

```powershell
python synapse_tracker.py status   # today's totals and last sync
python synapse_tracker.py sync     # upload now
python synapse_tracker.py clear    # delete totals stored on this computer
```

To stop it, end `pythonw.exe` in Task Manager, or press Ctrl+C if it's running in a console.

## What counts as time

Each second it checks which window is in front:

- **Counted:** the foreground app, while you've used the keyboard or mouse in the last 2 minutes.
- **Not counted:**
  - idle time and a locked screen;
  - Windows shell pieces (Start menu, search, lock screen);
  - apps on your exclude list;
  - browsers, unless you chose to count them.
- **Store apps** (Calculator, Settings, WhatsApp) are resolved to the real app rather than the generic "ApplicationFrameHost".
- **Gaps:** if the computer sleeps or the tracker stalls, at most 5 seconds of that gap is credited.

## Data

| | |
|---|---|
| **Recorded** | The app's name (e.g. "VS Code", "Excel") and seconds per local day, kept 30 days. |
| **Never recorded** | Window titles, file names, keystrokes, screenshots, anything you type. |
| **Stored** | `%APPDATA%\SynapseTracker\` (`config.json`, `totals.json`, `state.json`, `tracker.log`). |
| **Sent** | Per-app minutes for the last 7 days, every 5 minutes, using your device key. Each upload replaces the last one for those days. |

The key can only upload screen time; it can't read your Synapse data. Revoke it in Synapse any time.

## Settings

Edit `%APPDATA%\SynapseTracker\config.json`, then restart the tracker:

```json
{
  "idle_seconds": 120,
  "ignore_browsers": true,
  "excluded_apps": ["KeePassXC", "Banking App"],
  "category_overrides": { "Obsidian": "study", "Spotify": "work" }
}
```

Categories: `work`, `study`, `communication`, `social`, `entertainment`, `games`, `news`, `other`.

## Make a standalone .exe (optional)

To run it on PCs without Python:

```powershell
pip install pyinstaller
pyinstaller --onefile --noconsole --name SynapseTracker synapse_tracker.py
```

Run `SynapseTracker.exe setup` once from a terminal, then `SynapseTracker.exe run`.

## Tests

`python test_tracker.py` runs the tracking logic against a simulated Windows foreground and idle source. It covers idle time, sleep gaps, midnight split, exclusions, browsers, categories and persistence.

Add `SYNAPSE_TEST_SERVER` and `SYNAPSE_TEST_KEY` environment variables to also test a live sync.
