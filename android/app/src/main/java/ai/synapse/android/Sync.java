package ai.synapse.android;

import android.content.Context;

import ai.synapse.android.core.Payload;
import ai.synapse.android.core.SynapseApi;

import java.util.List;
import java.util.Map;

/** One sync: read the last 7 days from Android and upload them. Each upload replaces the previous one. */
final class Sync {
    static final int DAYS = 7;

    private Sync() {}

    /** Runs on a background thread. Returns a short status line; throws with a user-facing message on failure. */
    static String run(Context c) throws SynapseApi.ApiException {
        try {
            if (!Prefs.configured(c)) throw new SynapseApi.ApiException("Not connected to Synapse yet.", 0);
            if (!UsageReader.hasAccess(c)) throw new SynapseApi.ApiException("Usage access is off. Tap \"Allow usage access\" to turn it on.", 0);
            Map<String, List<Payload.Entry>> days = Payload.entries(UsageReader.read(c, DAYS), UsageReader.lookup(c));
            if (days.isEmpty()) {
                Prefs.recordSync(c, null);
                return "Nothing to sync yet.";
            }
            int n = new SynapseApi(Prefs.server(c), Prefs.key(c)).uploadUsage(Payload.toJson(days));
            Prefs.recordSync(c, null);
            return "Synced " + n + " app totals.";
        } catch (SynapseApi.ApiException e) {
            Prefs.recordSync(c, e.getMessage());
            throw e;
        } catch (RuntimeException e) {
            String msg = "Something went wrong reading usage: " + e.getClass().getSimpleName();
            Prefs.recordSync(c, msg);
            throw new SynapseApi.ApiException(msg, 0);
        }
    }
}
