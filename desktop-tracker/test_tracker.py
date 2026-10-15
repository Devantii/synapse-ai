"""
Tests for the tracking logic, using a simulated Windows foreground/idle source and clock.
Runs on any OS:  python test_tracker.py
Optional live sync test against a running Synapse server:
    set SYNAPSE_TEST_SERVER=http://localhost:3000 and SYNAPSE_TEST_KEY=syn_...
"""
import datetime as dt
import os
import sys
import tempfile
import unittest

os.environ["APPDATA"] = tempfile.mkdtemp()  # keep test data out of the real profile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import synapse_tracker as st  # noqa: E402


class FakeClock:
    def __init__(self, start):
        self.t = start

    def __call__(self):
        return self.t


class FakePlatform:
    def __init__(self):
        self.exe, self.idle = None, 0.0

    def foreground_exe(self):
        return self.exe

    def idle_seconds(self):
        return self.idle


def run(tracker, clock, seconds):
    for _ in range(int(seconds)):
        clock.t += 1
        tracker.tick()


class TrackerTests(unittest.TestCase):
    def setUp(self):
        st.write_json(st.TOTALS_PATH, {})
        st.write_json(st.STATE_PATH, {})
        noon = dt.datetime.combine(dt.date.today(), dt.time(12, 0)).timestamp()
        self.clock = FakeClock(noon)
        self.pf = FakePlatform()
        self.cfg = {**st.DEFAULT_CONFIG, "excluded_apps": ["KeePassXC"]}
        self.t = st.Tracker(self.pf, self.cfg, clock=self.clock)
        self.t.last_sync = float("inf")  # no network during unit tests
        self.today = dt.date.today().isoformat()

    def totals(self):
        return {k: round(v) for k, v in self.t.totals.get(self.today, {}).items()}

    def test_counts_foreground_apps(self):
        self.pf.exe = r"C:\Users\me\AppData\Local\Programs\Microsoft VS Code\Code.exe"
        self.t.tick()
        run(self.t, self.clock, 60)
        self.pf.exe = r"C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE"
        run(self.t, self.clock, 30)
        self.t.tick()
        self.assertEqual(self.totals(), {"VS Code": 61, "Excel": 29})  # 1 s sampling: the switch second goes to the previous app

    def test_browsers_ignored_by_default_and_optional(self):
        self.pf.exe = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
        self.t.tick()
        run(self.t, self.clock, 20)
        self.assertEqual(self.totals(), {})
        self.cfg["ignore_browsers"] = False
        run(self.t, self.clock, 20)
        self.assertEqual(self.totals(), {"Chrome": 19})

    def test_idle_time_not_counted(self):
        self.pf.exe = r"C:\x\Code.exe"
        self.t.tick()
        run(self.t, self.clock, 10)
        self.pf.idle = 500
        run(self.t, self.clock, 300)
        self.pf.idle = 0
        run(self.t, self.clock, 10)
        self.assertEqual(self.totals(), {"VS Code": 20})

    def test_locked_or_nothing_focused(self):
        self.pf.exe = None
        self.t.tick()
        run(self.t, self.clock, 30)
        self.pf.exe = r"C:\Windows\SystemApps\LockApp.exe"
        run(self.t, self.clock, 30)
        self.assertEqual(self.totals(), {})

    def test_sleep_gap_is_not_credited(self):
        self.pf.exe = r"C:\x\Code.exe"
        self.t.tick()
        run(self.t, self.clock, 10)
        self.clock.t += 3600  # laptop slept for an hour
        self.t.tick()
        self.assertLessEqual(self.totals()["VS Code"], 10 + st.MAX_STEP_S)

    def test_excluded_apps(self):
        self.pf.exe = r"C:\Program Files\KeePassXC\KeePassXC.exe"
        self.t.tick()
        run(self.t, self.clock, 30)
        self.assertEqual(self.totals(), {})

    def test_midnight_split(self):
        midnight = dt.datetime.combine(dt.date.today(), dt.time(0, 0)).timestamp()
        self.clock.t = midnight - 10
        self.pf.exe = r"C:\x\Code.exe"
        self.t.tick()
        run(self.t, self.clock, 20)
        yesterday = (dt.date.today() - dt.timedelta(days=1)).isoformat()
        self.assertEqual(round(self.t.totals[yesterday]["VS Code"]), 10)
        self.assertEqual(round(self.t.totals[self.today]["VS Code"]), 10)

    def test_payload_categories_and_threshold(self):
        self.t.totals = {self.today: {"VS Code": 600, "Spotify": 120, "Mystery": 1, "Teams": 60}}
        self.cfg["category_overrides"] = {"Spotify": "study"}
        days = self.t.payload()
        self.assertEqual(len(days), 1)
        entries = {e["app"]: (e["category"], e["minutes"]) for e in days[0]["entries"]}
        self.assertEqual(entries, {"VS Code": ("work", 10.0), "Spotify": ("study", 2.0), "Teams": ("communication", 1.0)})

    def test_friendly_names(self):
        self.assertEqual(st.friendly_name(r"C:\a\WINWORD.EXE"), "Word")
        self.assertEqual(st.friendly_name(r"C:\a\someTool.exe"), "SomeTool")

    def test_persistence_roundtrip(self):
        self.pf.exe = r"C:\x\Code.exe"
        self.t.tick()
        run(self.t, self.clock, 5)
        self.t.save()
        again = st.Tracker(self.pf, self.cfg, clock=self.clock)
        self.assertEqual(round(again.totals[self.today]["VS Code"]), 5)

    @unittest.skipUnless(os.environ.get("SYNAPSE_TEST_SERVER"), "set SYNAPSE_TEST_SERVER and SYNAPSE_TEST_KEY")
    def test_live_sync(self):
        self.cfg.update(server=os.environ["SYNAPSE_TEST_SERVER"], key=os.environ["SYNAPSE_TEST_KEY"])
        self.t.totals = {self.today: {"VS Code": 1800, "Excel": 600}}
        self.assertTrue(self.t.sync(), self.t.state.get("last_error"))
        self.t.totals = {self.today: {"VS Code": 2400, "Excel": 600}}  # re-sync replaces, never adds
        self.assertTrue(self.t.sync())
        bad = st.Tracker(self.pf, {**self.cfg, "key": "syn_revoked"}, clock=self.clock)
        bad.totals = self.t.totals
        self.assertFalse(bad.sync())
        self.assertEqual(bad.sync_backoff, 3600)


if __name__ == "__main__":
    unittest.main(verbosity=2)
