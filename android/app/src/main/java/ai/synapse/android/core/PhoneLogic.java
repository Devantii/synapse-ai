package ai.synapse.android.core;

import java.net.URI;
import java.net.URLDecoder;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Small pieces of phone behaviour, kept in pure Java so they're unit-tested off-device:
 * app-name matching, daily-limit alerts, the focus timer, the scan-to-connect link and the bedtime nudge.
 */
public final class PhoneLogic {
    private PhoneLogic() {}

    // ------------------------------------------------------------------ app names
    /** Same rule as the Synapse server: "Instagram", "instagram.com" and "www.instagram.com" match. */
    public static String appKey(String name) {
        String s = name == null ? "" : name.trim().toLowerCase(Locale.ROOT);
        s = s.replaceFirst("^https?://", "").replaceFirst("^www\\.", "").replaceFirst("/.*$", "").replaceFirst("\\.exe$", "");
        List<String> parts = new ArrayList<>(java.util.Arrays.asList(s.split("\\.")));
        if (parts.size() > 1 && parts.get(parts.size() - 1).matches("[a-z]{2,6}")) parts.remove(parts.size() - 1);
        if (parts.size() > 1 && java.util.Arrays.asList("co", "com", "org", "net", "ac", "gov").contains(parts.get(parts.size() - 1)))
            parts.remove(parts.size() - 1);
        return String.join(".", parts).replaceAll("\\s+", "");
    }

    // ------------------------------------------------------------------ daily limits
    public static final class Limit {
        public final String app;
        public final int minutes;

        public Limit(String app, int minutes) {
            this.app = app;
            this.minutes = minutes;
        }
    }

    public static final class Alert {
        public final String app;
        public final int level; // 80 or 100
        public final int usedMinutes;
        public final int limitMinutes;
        public final String key;

        Alert(String app, int level, int used, int limit, String key) {
            this.app = app;
            this.level = level;
            this.usedMinutes = used;
            this.limitMinutes = limit;
            this.key = key;
        }

        public String title() {
            return level >= 100 ? app + ": daily limit reached" : (limitMinutes - usedMinutes) + " min left on " + app + " today";
        }

        public String text() {
            return level >= 100
                    ? "You've used " + usedMinutes + " of your " + limitMinutes + " minutes today. Maybe close it for now?"
                    : "You've used " + usedMinutes + " of your " + limitMinutes + "-minute daily limit.";
        }
    }

    /** Usage per limit (minutes), matching limits to apps by name. */
    public static Map<String, Double> usedPerLimit(List<Limit> limits, Map<String, Double> minutesByApp) {
        Map<String, Double> byKey = new HashMap<>();
        for (Map.Entry<String, Double> e : minutesByApp.entrySet()) byKey.merge(appKey(e.getKey()), e.getValue(), Double::sum);
        Map<String, Double> out = new HashMap<>();
        for (Limit l : limits) out.put(l.app, byKey.getOrDefault(appKey(l.app), 0.0));
        return out;
    }

    /**
     * Alerts to send now. {@code sent} holds "key|80" / "key|100" markers already sent today; the caller
     * adds the returned alerts' markers. Crossing 100% directly sends only the 100% alert.
     */
    public static List<Alert> limitAlerts(List<Limit> limits, Map<String, Double> minutesByApp, Set<String> sent) {
        Map<String, Double> used = usedPerLimit(limits, minutesByApp);
        List<Alert> out = new ArrayList<>();
        for (Limit l : limits) {
            if (l.minutes <= 0) continue;
            double u = used.get(l.app);
            String key = appKey(l.app);
            int usedMin = (int) Math.floor(u);
            if (u >= l.minutes && !sent.contains(key + "|100")) out.add(new Alert(l.app, 100, usedMin, l.minutes, key));
            else if (u >= 0.8 * l.minutes && u < l.minutes && !sent.contains(key + "|80") && !sent.contains(key + "|100"))
                out.add(new Alert(l.app, 80, usedMin, l.minutes, key));
        }
        return out;
    }

    // ------------------------------------------------------------------ focus timer
    public static final class Timer {
        public final String mode; // "focus" or "break"
        public final int plannedMin;
        public final long startedAt;
        public final long endsAt;
        public final String tag;

        public Timer(String mode, int plannedMin, long startedAt, String tag) {
            this.mode = "break".equals(mode) ? "break" : "focus";
            this.plannedMin = plannedMin;
            this.startedAt = startedAt;
            this.endsAt = startedAt + plannedMin * 60_000L;
            this.tag = tag == null ? "" : tag.trim();
        }

        public long remaining(long now) {
            return Math.max(0, endsAt - now);
        }

        public boolean done(long now) {
            return now >= endsAt;
        }

        /** "24:59" style countdown. */
        public String countdown(long now) {
            long s = (remaining(now) + 999) / 1000;
            return String.format(Locale.ROOT, "%02d:%02d", s / 60, s % 60);
        }

        public double progress(long now) {
            return Math.min(1, Math.max(0, (now - startedAt) / (double) (endsAt - startedAt)));
        }

        /** JSON for POST /api/device/sessions. */
        public String sessionJson(long endedAt, boolean completed, ZoneId zone) {
            DateTimeFormatter local = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss");
            LocalDateTime start = LocalDateTime.ofInstant(Instant.ofEpochMilli(startedAt), zone);
            LocalDateTime end = LocalDateTime.ofInstant(Instant.ofEpochMilli(Math.min(endedAt, endsAt)), zone);
            double actual = completed ? plannedMin : Math.round(Math.min(plannedMin, (endedAt - startedAt) / 60000.0) * 100) / 100.0;
            StringBuilder b = new StringBuilder("{");
            b.append("\"kind\":").append(Payload.quote(mode));
            b.append(",\"plannedMin\":").append(plannedMin);
            b.append(",\"actualMin\":").append(String.format(Locale.ROOT, "%.2f", Math.max(0, actual)));
            b.append(",\"completed\":").append(completed);
            if (!tag.isEmpty()) b.append(",\"tag\":").append(Payload.quote(tag.length() > 40 ? tag.substring(0, 40) : tag));
            b.append(",\"day\":").append(Payload.quote(start.toLocalDate().toString()));
            b.append(",\"startedAt\":").append(Payload.quote(start.format(local)));
            b.append(",\"endedAt\":").append(Payload.quote(end.format(local)));
            return b.append('}').toString();
        }

        /** Compact form for storing the running timer on the phone. */
        public String serialize() {
            return mode + "|" + plannedMin + "|" + startedAt + "|" + tag;
        }

        public static Timer parse(String s) {
            if (s == null || s.isEmpty()) return null;
            String[] p = s.split("\\|", 4);
            if (p.length < 3) return null;
            try {
                return new Timer(p[0], Integer.parseInt(p[1]), Long.parseLong(p[2]), p.length > 3 ? p[3] : "");
            } catch (NumberFormatException e) {
                return null;
            }
        }
    }

    // ------------------------------------------------------------------ scan to connect
    public static final class ConnectInfo {
        public final String server;
        public final String key;

        ConnectInfo(String server, String key) {
            this.server = server;
            this.key = key;
        }
    }

    /** Reads synapse://connect?server=...&key=... from the QR code on the Synapse website. */
    public static ConnectInfo parseConnectLink(String link) {
        URI u;
        try {
            u = new URI(link == null ? "" : link.trim());
        } catch (Exception e) {
            throw new IllegalArgumentException("That isn't a Synapse connect link.");
        }
        if (!"synapse".equalsIgnoreCase(u.getScheme()) || !"connect".equalsIgnoreCase(u.getHost()))
            throw new IllegalArgumentException("That isn't a Synapse connect link.");
        String server = null, key = null;
        String q = u.getRawQuery();
        if (q != null) {
            for (String pair : q.split("&")) {
                int eq = pair.indexOf('=');
                if (eq < 0) continue;
                String k = pair.substring(0, eq);
                String v = decode(pair.substring(eq + 1));
                if (k.equals("server")) server = v;
                if (k.equals("key")) key = v;
            }
        }
        server = SynapseApi.normalizeServer(server);
        if (server.isEmpty() || !(server.startsWith("http://") || server.startsWith("https://")))
            throw new IllegalArgumentException("The link is missing the server address.");
        if (key == null || !key.startsWith("syn_")) throw new IllegalArgumentException("The link is missing a device key.");
        return new ConnectInfo(server, key);
    }

    // URLDecoder.decode(String, Charset) only exists on Android 13+, so use the String overload.
    private static String decode(String v) {
        try {
            return URLDecoder.decode(v, "UTF-8");
        } catch (java.io.UnsupportedEncodingException e) {
            return v;
        }
    }

    // ------------------------------------------------------------------ bedtime nudge
    public static final int WAKE_HOUR = 5;

    /** True between bedtime and 5 am. */
    public static boolean inBedtimeWindow(int hourNow, int bedtimeHour) {
        return bedtimeHour > WAKE_HOUR ? (hourNow >= bedtimeHour || hourNow < WAKE_HOUR) : (hourNow >= bedtimeHour && hourNow < WAKE_HOUR);
    }

    /**
     * Minutes on the phone since bedtime tonight, from hourly usage (whole hours from bedtime).
     * After midnight, yesterday's late hours count too.
     */
    public static double minutesSinceBedtime(long[] today, long[] yesterday, int hourNow, int bedtimeHour) {
        long ms = 0;
        if (bedtimeHour > WAKE_HOUR) {
            if (hourNow >= bedtimeHour) {
                for (int h = bedtimeHour; h <= hourNow && h < 24; h++) ms += at(today, h);
            } else if (hourNow < WAKE_HOUR) {
                for (int h = bedtimeHour; h < 24; h++) ms += at(yesterday, h);
                for (int h = 0; h <= hourNow; h++) ms += at(today, h);
            }
        } else if (hourNow >= bedtimeHour && hourNow < WAKE_HOUR) {
            for (int h = bedtimeHour; h <= hourNow; h++) ms += at(today, h);
        }
        return ms / 60000.0;
    }

    private static long at(long[] a, int h) {
        return a == null || h < 0 || h >= a.length ? 0 : a[h];
    }

    /** Nudge once you've spent 10+ minutes on the phone after bedtime, at most every 45 minutes. */
    public static boolean shouldNudge(boolean enabled, int hourNow, int bedtimeHour, double minutesSince, long now, long lastNudge) {
        return enabled && inBedtimeWindow(hourNow, bedtimeHour) && minutesSince >= 10 && now - lastNudge >= 45 * 60_000L;
    }

    public static String hourLabel(int h) {
        int x = ((h % 24) + 24) % 24;
        return x == 0 ? "12 am" : x < 12 ? x + " am" : x == 12 ? "12 pm" : (x - 12) + " pm";
    }

    // ------------------------------------------------------------------ v3: tasks, focus guard
    /** Adds "taskId" to a session JSON object so the block counts towards that task. */
    public static String withTask(String sessionJson, long taskId) {
        if (taskId <= 0 || sessionJson == null || !sessionJson.endsWith("}")) return sessionJson;
        return sessionJson.substring(0, sessionJson.length() - 1) + ",\"taskId\":" + taskId + "}";
    }

    /** Categories that the focus guard pauses during a focus block. */
    public static boolean isDistracting(String category) {
        return "social".equals(category) || "entertainment".equals(category) || "games".equals(category);
    }

    /**
     * The app in front, from recent usage events (oldest first): the package of the last ACTIVITY_RESUMED that
     * hasn't been paused since. Null if unknown (e.g. the screen is off).
     */
    public static String foreground(java.util.List<UsageAggregator.Event> events) {
        String top = null;
        for (UsageAggregator.Event e : events) {
            if (e.type == UsageAggregator.ACTIVITY_RESUMED) top = e.pkg;
            else if ((e.type == UsageAggregator.ACTIVITY_PAUSED && e.pkg.equals(top)) || e.type == UsageAggregator.SCREEN_NON_INTERACTIVE) top = null;
        }
        return top;
    }

    /** "18:20" style minutes:seconds left. */
    public static String mmss(long ms) {
        long s = Math.max(0, (ms + 999) / 1000);
        return String.format(Locale.ROOT, "%d:%02d", s / 60, s % 60);
    }
}
