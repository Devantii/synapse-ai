package ai.synapse.android;

import android.content.Context;

import ai.synapse.android.core.MiniJson;
import ai.synapse.android.core.Payload;
import ai.synapse.android.core.PhoneLogic;
import ai.synapse.android.core.SynapseApi;
import ai.synapse.android.core.UsageAggregator;

import java.time.LocalDate;
import java.time.LocalTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * One sync: read the last 7 days from Android, upload them, refresh daily limits and rewards,
 * then run the on-phone checks (limit alerts, bedtime nudge, widget). Each upload replaces the previous one.
 */
final class Sync {
    static final int DAYS = 7;

    private Sync() {}

    /** Runs on a background thread. Returns a short status line; throws with a user-facing message on failure. */
    static String run(Context c) throws SynapseApi.ApiException {
        try {
            if (!UsageReader.hasAccess(c)) throw new SynapseApi.ApiException("Usage access is off. Turn it on in Settings.", 0);
            UsageAggregator.Result r = UsageReader.analyze(c, DAYS);
            Map<String, List<Payload.Entry>> days = Payload.entries(r.apps, UsageReader.lookup(c));
            String status;
            if (!Prefs.configured(c)) {
                status = "Not connected to Synapse yet.";
            } else {
                SynapseApi api = new SynapseApi(Prefs.server(c), Prefs.key(c));
                int n = days.isEmpty() ? 0 : api.uploadUsage(Payload.toJson(days));
                try {
                    Prefs.saveLimits(c, api.limits());
                } catch (SynapseApi.ApiException ignored) {
                    // keep the cached limits
                }
                try {
                    Map<String, Object> s = api.summary();
                    Prefs.saveSummary(c, (int) MiniJson.num(s, "points", 0), (int) MiniJson.num(s, "level", 1),
                            (int) MiniJson.num(s, "currentStreak", 0), (int) MiniJson.num(s, "trees", 0));
                } catch (SynapseApi.ApiException ignored) {
                }
                Prefs.recordSync(c, null);
                status = days.isEmpty() ? "Nothing to sync yet." : "Synced " + n + " app totals.";
            }
            checks(c, r, days);
            return status;
        } catch (SynapseApi.ApiException e) {
            Prefs.recordSync(c, e.getMessage());
            throw e;
        } catch (RuntimeException e) {
            String msg = "Something went wrong reading usage: " + e.getClass().getSimpleName();
            Prefs.recordSync(c, msg);
            throw new SynapseApi.ApiException(msg, 0);
        }
    }

    /** Today's minutes per app (by display name). */
    static Map<String, Double> todayMinutes(Map<String, List<Payload.Entry>> days) {
        Map<String, Double> out = new HashMap<>();
        List<Payload.Entry> today = days.get(LocalDate.now().toString());
        if (today != null) for (Payload.Entry e : today) out.merge(e.app, e.minutes, Double::sum);
        return out;
    }

    /** Things the phone does on its own: limit alerts, bedtime nudge, widget. Safe without a connection. */
    static void checks(Context c, UsageAggregator.Result r, Map<String, List<Payload.Entry>> days) {
        String today = LocalDate.now().toString();
        String yesterday = LocalDate.now().minusDays(1).toString();
        Map<String, Double> minutes = todayMinutes(days);

        if (Prefs.limitAlerts(c)) {
            Set<String> sent = Prefs.sentAlerts(c);
            List<PhoneLogic.Alert> alerts = PhoneLogic.limitAlerts(Prefs.limits(c), minutes, sent);
            for (PhoneLogic.Alert a : alerts) {
                Notifs.limit(c, a);
                sent.add(a.key + "|" + a.level);
            }
            if (!alerts.isEmpty()) Prefs.markSent(c, sent);
        }

        int hour = LocalTime.now().getHour();
        int bed = Prefs.bedtimeHour(c);
        double since = PhoneLogic.minutesSinceBedtime(r.hourly.get(today), r.hourly.get(yesterday), hour, bed);
        long now = System.currentTimeMillis();
        if (PhoneLogic.shouldNudge(Prefs.bedtimeNudge(c), hour, bed, since, now, Prefs.lastNudge(c))) {
            Notifs.bedtime(c, (int) Math.round(since), bed);
            Prefs.setLastNudge(c, now);
        }

        List<Payload.Entry> list = days.get(today);
        Integer pickups = r.pickups.get(today);
        SynapseWidget.update(c,
                Ui.fmt(r.totalMs(today) / 60000.0),
                (pickups == null ? 0 : pickups) + " pickups",
                list == null || list.isEmpty() ? "No app time yet today" : "Top: " + list.get(0).app + " · " + Ui.fmt(list.get(0).minutes));
    }
}
