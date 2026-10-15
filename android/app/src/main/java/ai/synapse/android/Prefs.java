package ai.synapse.android;

import android.content.Context;
import android.content.SharedPreferences;

import ai.synapse.android.core.PhoneLogic;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Settings and status, stored privately on the phone. */
final class Prefs {
    private Prefs() {}

    private static SharedPreferences p(Context c) {
        return c.getSharedPreferences("synapse", Context.MODE_PRIVATE);
    }

    // ---- connection
    static String server(Context c) { return p(c).getString("server", ""); }
    static String key(Context c) { return p(c).getString("key", ""); }
    static String connectedAs(Context c) { return p(c).getString("connectedAs", ""); }
    static boolean configured(Context c) { return !server(c).isEmpty() && key(c).startsWith("syn_"); }

    static void connect(Context c, String server, String key, String connectedAs) {
        p(c).edit().putString("server", server).putString("key", key).putString("connectedAs", connectedAs).remove("lastError").apply();
    }

    static void disconnect(Context c) {
        p(c).edit().remove("key").remove("connectedAs").remove("lastSync").remove("lastError").remove("limits").remove("summary").apply();
    }

    // ---- sync status
    static long lastSync(Context c) { return p(c).getLong("lastSync", 0); }
    static String lastError(Context c) { return p(c).getString("lastError", null); }

    static void recordSync(Context c, String error) {
        SharedPreferences.Editor e = p(c).edit();
        if (error == null) e.putLong("lastSync", System.currentTimeMillis()).remove("lastError");
        else e.putString("lastError", error);
        e.apply();
    }

    // ---- daily limits (cached so alerts work offline)
    static void saveLimits(Context c, List<PhoneLogic.Limit> limits) {
        StringBuilder b = new StringBuilder();
        for (PhoneLogic.Limit l : limits) b.append(l.minutes).append('\t').append(l.app.replace('\n', ' ')).append('\n');
        p(c).edit().putString("limits", b.toString()).apply();
    }

    static List<PhoneLogic.Limit> limits(Context c) {
        List<PhoneLogic.Limit> out = new ArrayList<>();
        for (String line : p(c).getString("limits", "").split("\n")) {
            int tab = line.indexOf('\t');
            if (tab <= 0) continue;
            try {
                out.add(new PhoneLogic.Limit(line.substring(tab + 1), Integer.parseInt(line.substring(0, tab))));
            } catch (NumberFormatException ignored) {
            }
        }
        return out;
    }

    /** "key|80" markers of limit alerts already sent today. */
    static Set<String> sentAlerts(Context c) {
        String raw = p(c).getString("sentAlerts", "");
        String today = LocalDate.now().toString();
        if (!raw.startsWith(today + ";")) return new HashSet<>();
        return new HashSet<>(Arrays.asList(raw.substring(today.length() + 1).split(",")));
    }

    static void markSent(Context c, Set<String> sent) {
        p(c).edit().putString("sentAlerts", LocalDate.now() + ";" + String.join(",", sent)).apply();
    }

    // ---- notification settings
    static boolean limitAlerts(Context c) { return p(c).getBoolean("limitAlerts", true); }
    static void setLimitAlerts(Context c, boolean on) { p(c).edit().putBoolean("limitAlerts", on).apply(); }
    static boolean bedtimeNudge(Context c) { return p(c).getBoolean("bedtimeNudge", false); }
    static void setBedtimeNudge(Context c, boolean on) { p(c).edit().putBoolean("bedtimeNudge", on).apply(); }
    static int bedtimeHour(Context c) { return p(c).getInt("bedtimeHour", 23); }
    static void setBedtimeHour(Context c, int h) { p(c).edit().putInt("bedtimeHour", h).apply(); }
    static long lastNudge(Context c) { return p(c).getLong("lastNudge", 0); }
    static void setLastNudge(Context c, long t) { p(c).edit().putLong("lastNudge", t).apply(); }
    static boolean askedNotifications(Context c) { return p(c).getBoolean("askedNotif", false); }
    static void setAskedNotifications(Context c) { p(c).edit().putBoolean("askedNotif", true).apply(); }

    // ---- focus timer
    static PhoneLogic.Timer timer(Context c) { return PhoneLogic.Timer.parse(p(c).getString("timer", "")); }
    static void setTimer(Context c, PhoneLogic.Timer t) { p(c).edit().putString("timer", t == null ? "" : t.serialize()).apply(); }

    /** Atomically take the running timer (so a block is only finished once). */
    static synchronized PhoneLogic.Timer takeTimer(Context c) {
        PhoneLogic.Timer t = timer(c);
        if (t != null) p(c).edit().putString("timer", "").commit();
        return t;
    }

    static String lastFocusTag(Context c) { return p(c).getString("lastTag", ""); }
    static void setLastFocusTag(Context c, String tag) { p(c).edit().putString("lastTag", tag).apply(); }
    static String lastReward(Context c) { return p(c).getString("lastReward", ""); }
    static void setLastReward(Context c, String s) { p(c).edit().putString("lastReward", s).apply(); }

    /** Points / level / streak / trees from the server, as "points|level|streak|trees". */
    static int[] summary(Context c) {
        String[] s = p(c).getString("summary", "").split("\\|");
        if (s.length < 4) return null;
        try {
            return new int[]{Integer.parseInt(s[0]), Integer.parseInt(s[1]), Integer.parseInt(s[2]), Integer.parseInt(s[3])};
        } catch (NumberFormatException e) {
            return null;
        }
    }

    static void saveSummary(Context c, int points, int level, int streak, int trees) {
        p(c).edit().putString("summary", points + "|" + level + "|" + streak + "|" + trees).apply();
    }
}
