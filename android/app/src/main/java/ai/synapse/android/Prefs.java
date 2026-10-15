package ai.synapse.android;

import android.content.Context;
import android.content.SharedPreferences;

/** Settings and sync status, stored privately on the phone. */
final class Prefs {
    private Prefs() {}

    private static SharedPreferences p(Context c) {
        return c.getSharedPreferences("synapse", Context.MODE_PRIVATE);
    }

    static String server(Context c) { return p(c).getString("server", ""); }
    static String key(Context c) { return p(c).getString("key", ""); }
    static String connectedAs(Context c) { return p(c).getString("connectedAs", ""); }
    static boolean configured(Context c) { return !server(c).isEmpty() && key(c).startsWith("syn_"); }
    static long lastSync(Context c) { return p(c).getLong("lastSync", 0); }
    static String lastError(Context c) { return p(c).getString("lastError", null); }

    static void connect(Context c, String server, String key, String connectedAs) {
        p(c).edit().putString("server", server).putString("key", key).putString("connectedAs", connectedAs).remove("lastError").apply();
    }

    static void disconnect(Context c) {
        p(c).edit().remove("key").remove("connectedAs").remove("lastSync").remove("lastError").apply();
    }

    static void recordSync(Context c, String error) {
        SharedPreferences.Editor e = p(c).edit();
        if (error == null) e.putLong("lastSync", System.currentTimeMillis()).remove("lastError");
        else e.putString("lastError", error);
        e.apply();
    }
}
