package ai.synapse.android.core;

import static ai.synapse.android.core.UsageAggregator.*;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public class UsageAggregatorTest {
    private static final ZoneId IST = ZoneId.of("Asia/Kolkata");
    private static final long MIN = 60_000L;
    private static final long NOON = LocalDate.of(2026, 10, 15).atTime(12, 0).atZone(IST).toInstant().toEpochMilli();
    private static final String INSTA = "com.instagram.android", WA = "com.whatsapp", LAUNCHER = "com.google.android.apps.nexuslauncher";

    private final UsageAggregator agg = new UsageAggregator(IST, new HashSet<>(Arrays.asList(LAUNCHER, "ai.synapse.android")));

    private static Event ev(long minuteOffset, String pkg, int type) {
        return new Event(NOON + minuteOffset * MIN, pkg, type);
    }

    private static long mins(Map<String, Map<String, Long>> out, String day, String pkg) {
        Map<String, Long> d = out.get(day);
        return d == null || d.get(pkg) == null ? 0 : d.get(pkg) / MIN;
    }

    @Test
    public void resumeThenPauseCountsTheGap() {
        List<Event> e = Arrays.asList(ev(0, INSTA, ACTIVITY_RESUMED), ev(25, INSTA, ACTIVITY_PAUSED));
        assertEquals(25, mins(agg.aggregate(e, NOON + 60 * MIN), "2026-10-15", INSTA));
    }

    @Test
    public void switchingAppsWithoutPauseClosesThePreviousOne() {
        List<Event> e = Arrays.asList(ev(0, INSTA, ACTIVITY_RESUMED), ev(10, WA, ACTIVITY_RESUMED), ev(15, INSTA, ACTIVITY_PAUSED), ev(18, WA, ACTIVITY_PAUSED));
        Map<String, Map<String, Long>> out = agg.aggregate(e, NOON + 60 * MIN);
        assertEquals(10, mins(out, "2026-10-15", INSTA));
        assertEquals(8, mins(out, "2026-10-15", WA));
    }

    @Test
    public void screenOffAndLockStopTheClock() {
        List<Event> e = Arrays.asList(ev(0, INSTA, ACTIVITY_RESUMED), ev(5, null, SCREEN_NON_INTERACTIVE),
                ev(30, null, SCREEN_INTERACTIVE), ev(31, WA, ACTIVITY_RESUMED), ev(33, null, KEYGUARD_SHOWN));
        Map<String, Map<String, Long>> out = agg.aggregate(e, NOON + 60 * MIN);
        assertEquals(5, mins(out, "2026-10-15", INSTA));
        assertEquals(2, mins(out, "2026-10-15", WA));
    }

    @Test
    public void appStillOpenCountsUntilNow() {
        List<Event> e = Arrays.asList(ev(0, WA, ACTIVITY_RESUMED));
        assertEquals(12, mins(agg.aggregate(e, NOON + 12 * MIN), "2026-10-15", WA));
    }

    @Test
    public void launcherAndOwnAppAreIgnored() {
        List<Event> e = Arrays.asList(ev(0, LAUNCHER, ACTIVITY_RESUMED), ev(10, LAUNCHER, ACTIVITY_PAUSED),
                ev(10, "ai.synapse.android", ACTIVITY_RESUMED), ev(12, "ai.synapse.android", ACTIVITY_PAUSED));
        assertTrue(agg.aggregate(e, NOON + 60 * MIN).isEmpty());
    }

    @Test
    public void splitsAtLocalMidnight() {
        long beforeMidnight = LocalDate.of(2026, 10, 15).atTime(23, 50).atZone(IST).toInstant().toEpochMilli();
        List<Event> e = Arrays.asList(new Event(beforeMidnight, INSTA, ACTIVITY_RESUMED), new Event(beforeMidnight + 25 * MIN, INSTA, ACTIVITY_PAUSED));
        Map<String, Map<String, Long>> out = agg.aggregate(e, beforeMidnight + 60 * MIN);
        assertEquals(10, mins(out, "2026-10-15", INSTA));
        assertEquals(15, mins(out, "2026-10-16", INSTA));
    }

    @Test
    public void missingPauseIsCappedNotCountedForever() {
        List<Event> e = Arrays.asList(ev(0, INSTA, ACTIVITY_RESUMED));
        UsageAggregator capped = new UsageAggregator(IST, new HashSet<>(), 30 * MIN);
        assertEquals(30, mins(capped.aggregate(e, NOON + 600 * MIN), "2026-10-15", INSTA));
    }

    @Test
    public void unorderedEventsAreSorted() {
        List<Event> e = Arrays.asList(ev(20, INSTA, ACTIVITY_PAUSED), ev(0, INSTA, ACTIVITY_RESUMED));
        assertEquals(20, mins(agg.aggregate(e, NOON + 60 * MIN), "2026-10-15", INSTA));
    }

    @Test
    public void pickupsFirstPickupAndHourly() {
        List<Event> e = Arrays.asList(
                ev(-300, null, SCREEN_INTERACTIVE), ev(-299, null, KEYGUARD_HIDDEN),   // 7:00 am first unlock
                ev(-298, WA, ACTIVITY_RESUMED), ev(-290, WA, ACTIVITY_PAUSED),         // 8 min at 7 am
                ev(-30, null, SCREEN_INTERACTIVE), ev(-29, null, KEYGUARD_HIDDEN),
                ev(-10, INSTA, ACTIVITY_RESUMED), ev(20, INSTA, ACTIVITY_PAUSED),       // 11:50 -> 12:20 spans two hours
                ev(25, null, SCREEN_INTERACTIVE));                                      // screen-on without unlock: not a pickup
        UsageAggregator.Result r = agg.analyze(e, NOON + 60 * MIN);
        assertEquals(2, (int) r.pickups.get("2026-10-15"));
        assertEquals(NOON - 299 * MIN, (long) r.firstPickup.get("2026-10-15"));
        long[] h = r.hourly.get("2026-10-15");
        assertEquals(8, h[7] / MIN);
        assertEquals(10, h[11] / MIN);
        assertEquals(20, h[12] / MIN);
        assertEquals(38, r.totalMs("2026-10-15") / MIN);
    }

    @Test
    public void phonesWithoutLockScreenCountScreenOns() {
        List<Event> e = Arrays.asList(ev(0, null, SCREEN_INTERACTIVE), ev(30, null, SCREEN_INTERACTIVE), ev(60, null, SCREEN_INTERACTIVE));
        assertEquals(3, (int) agg.analyze(e, NOON + 90 * MIN).pickups.get("2026-10-15"));
    }

    @Test
    public void pauseOfAnotherAppDoesNotStopCurrent() {
        List<Event> e = Arrays.asList(ev(0, INSTA, ACTIVITY_RESUMED), ev(3, WA, ACTIVITY_PAUSED), ev(9, INSTA, ACTIVITY_PAUSED));
        Map<String, Map<String, Long>> out = agg.aggregate(e, NOON + 60 * MIN);
        assertEquals(9, mins(out, "2026-10-15", INSTA));
        assertFalse(out.get("2026-10-15").containsKey(WA));
        assertNull(out.get("2026-10-14"));
    }
}
