package ai.synapse.android.core;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Builds the JSON body for PUT /api/device/usage:
 *   {"days":[{"day":"2026-10-15","entries":[{"app":"Instagram","category":"social","minutes":42.5}]}]}
 * Apps are reported by their display name so "Instagram" on the phone matches "instagram.com" on the
 * computer in Synapse. Two packages with the same name are merged. Tiny amounts (< 3 s) are dropped.
 */
public final class Payload {

    /** What Synapse needs to know about one installed app. */
    public static final class AppInfo {
        public final String label;
        public final String category;

        public AppInfo(String label, String category) {
            this.label = label;
            this.category = category;
        }
    }

    /** Looks up an app's display name and category (on Android: PackageManager). */
    public interface AppLookup {
        AppInfo lookup(String pkg);
    }

    public static final class Entry {
        public final String app;
        public final String category;
        public final double minutes;

        Entry(String app, String category, double minutes) {
            this.app = app;
            this.category = category;
            this.minutes = minutes;
        }
    }

    private Payload() {}

    /** day -> merged entries, sorted by minutes descending. */
    public static Map<String, List<Entry>> entries(Map<String, Map<String, Long>> usage, AppLookup lookup) {
        Map<String, AppInfo> cache = new LinkedHashMap<>();
        Map<String, List<Entry>> out = new LinkedHashMap<>();
        for (Map.Entry<String, Map<String, Long>> day : usage.entrySet()) {
            Map<String, double[]> minutes = new LinkedHashMap<>();
            Map<String, String> categories = new LinkedHashMap<>();
            for (Map.Entry<String, Long> app : day.getValue().entrySet()) {
                AppInfo info = cache.computeIfAbsent(app.getKey(), lookup::lookup);
                String label = info.label == null || info.label.trim().isEmpty() ? app.getKey() : info.label.trim();
                if (label.length() > 60) label = label.substring(0, 60);
                minutes.computeIfAbsent(label, k -> new double[1])[0] += app.getValue() / 60000.0;
                categories.putIfAbsent(label, info.category);
            }
            List<Entry> list = new ArrayList<>();
            for (Map.Entry<String, double[]> m : minutes.entrySet()) {
                double mins = Math.round(m.getValue()[0] * 100) / 100.0;
                if (mins >= 0.05) list.add(new Entry(m.getKey(), categories.get(m.getKey()), mins));
            }
            list.sort((a, b) -> Double.compare(b.minutes, a.minutes));
            if (list.size() > 300) list = new ArrayList<>(list.subList(0, 300));
            if (!list.isEmpty()) out.put(day.getKey(), list);
        }
        return out;
    }

    public static String toJson(Map<String, List<Entry>> days) {
        StringBuilder sb = new StringBuilder("{\"days\":[");
        boolean firstDay = true;
        for (Map.Entry<String, List<Entry>> day : days.entrySet()) {
            if (!firstDay) sb.append(',');
            firstDay = false;
            sb.append("{\"day\":").append(quote(day.getKey())).append(",\"entries\":[");
            boolean first = true;
            for (Entry e : day.getValue()) {
                if (!first) sb.append(',');
                first = false;
                sb.append("{\"app\":").append(quote(e.app))
                  .append(",\"category\":").append(quote(e.category))
                  .append(",\"minutes\":").append(String.format(Locale.ROOT, "%.2f", e.minutes)).append('}');
            }
            sb.append("]}");
        }
        return sb.append("]}").toString();
    }

    static String quote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }
}
