package ai.synapse.android.core;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Turns Android usage events into foreground time per app per local day.
 *
 * Pure Java (no Android classes) so it can be unit-tested on any JVM.
 *
 * Rules:
 *  - An app is "in front" from ACTIVITY_RESUMED until it is paused, another app resumes,
 *    the screen turns off, the lock screen shows, or the device shuts down.
 *  - Time is split at local midnight.
 *  - A single unbroken stretch is capped (default 3 h) to protect against missing pause events.
 *  - Packages in the ignore set (launchers, system UI, this app) are never counted.
 */
public final class UsageAggregator {

    // Values of android.app.usage.UsageEvents.Event constants (stable public API values).
    public static final int ACTIVITY_RESUMED = 1;
    public static final int ACTIVITY_PAUSED = 2;
    public static final int SCREEN_INTERACTIVE = 15;
    public static final int SCREEN_NON_INTERACTIVE = 16;
    public static final int KEYGUARD_SHOWN = 17;
    public static final int DEVICE_SHUTDOWN = 26;

    public static final long DEFAULT_MAX_STRETCH_MS = 3L * 60 * 60 * 1000;

    /** One usage event. */
    public static final class Event {
        public final long time;
        public final String pkg;
        public final int type;

        public Event(long time, String pkg, int type) {
            this.time = time;
            this.pkg = pkg;
            this.type = type;
        }
    }

    private final ZoneId zone;
    private final Set<String> ignored;
    private final long maxStretchMs;

    public UsageAggregator(ZoneId zone, Set<String> ignored) {
        this(zone, ignored, DEFAULT_MAX_STRETCH_MS);
    }

    public UsageAggregator(ZoneId zone, Set<String> ignored, long maxStretchMs) {
        this.zone = zone;
        this.ignored = ignored;
        this.maxStretchMs = maxStretchMs;
    }

    /**
     * @param events events in any order
     * @param endTime the moment the query window ends (usually "now"); an app still in front is counted up to here
     * @return day (YYYY-MM-DD) -> package -> milliseconds, days in ascending order
     */
    public Map<String, Map<String, Long>> aggregate(List<Event> events, long endTime) {
        List<Event> sorted = new ArrayList<>(events);
        sorted.sort(Comparator.comparingLong(e -> e.time));
        Map<String, Map<String, Long>> out = new TreeMap<>();
        String current = null;
        long since = 0;
        for (Event e : sorted) {
            switch (e.type) {
                case ACTIVITY_RESUMED:
                    if (e.pkg == null) break;
                    if (current != null && !current.equals(e.pkg)) {
                        add(out, current, since, e.time);
                        current = null;
                    }
                    if (current == null) {
                        current = e.pkg;
                        since = e.time;
                    }
                    break;
                case ACTIVITY_PAUSED:
                    if (current != null && current.equals(e.pkg)) {
                        add(out, current, since, e.time);
                        current = null;
                    }
                    break;
                case SCREEN_NON_INTERACTIVE:
                case KEYGUARD_SHOWN:
                case DEVICE_SHUTDOWN:
                    if (current != null) {
                        add(out, current, since, e.time);
                        current = null;
                    }
                    break;
                default:
                    break;
            }
        }
        if (current != null && endTime > since) add(out, current, since, endTime);
        return out;
    }

    private void add(Map<String, Map<String, Long>> out, String pkg, long from, long to) {
        if (to <= from || ignored.contains(pkg)) return;
        if (to - from > maxStretchMs) to = from + maxStretchMs;
        long t = from;
        while (t < to) {
            ZonedDateTime start = Instant.ofEpochMilli(t).atZone(zone);
            LocalDate day = start.toLocalDate();
            long nextMidnight = day.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli();
            long end = Math.min(to, nextMidnight);
            out.computeIfAbsent(day.toString(), k -> new TreeMap<>()).merge(pkg, end - t, Long::sum);
            t = end;
        }
    }
}
