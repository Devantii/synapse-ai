package ai.synapse.android;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import ai.synapse.android.core.MiniJson;
import ai.synapse.android.core.PhoneLogic;
import ai.synapse.android.core.SynapseApi;

import java.time.ZoneId;
import java.util.Map;

/**
 * Runs focus blocks and breaks on the phone. The running timer is saved, so it survives the app
 * being closed; an alarm finishes it on time; Synapse is told so other devices react (the browser
 * extension pauses distracting sites), and the finished session earns points like on the website.
 */
final class FocusController {
    private FocusController() {}

    static void start(Context c, String mode, int minutes, String tag) {
        PhoneLogic.Timer t = new PhoneLogic.Timer(mode, minutes, System.currentTimeMillis(), tag);
        Prefs.setTimer(c, t);
        if ("focus".equals(mode)) Prefs.setLastFocusTag(c, t.tag);
        scheduleAlarm(c, t.endsAt);
        Notifs.focusRunning(c, t);
        background(() -> {
            if (Prefs.configured(c)) {
                try {
                    api(c).setFocus(t.mode, t.endsAt);
                } catch (SynapseApi.ApiException ignored) {
                    // The block still runs on the phone; other devices just won't know about it.
                }
            }
        });
    }

    /**
     * Ends the running block (completed = ran its full length). Saves it to Synapse.
     * Blocking network call: call from a background thread. Returns a short result line, or null if nothing was running.
     */
    static String finish(Context c, boolean completed) {
        PhoneLogic.Timer t = Prefs.takeTimer(c);
        if (t == null) return null;
        long now = System.currentTimeMillis();
        if (completed && !t.done(now)) completed = false;
        cancelAlarm(c);
        Notifs.cancelFocus(c);
        String reward = "";
        if (Prefs.configured(c)) {
            SynapseApi api = api(c);
            try {
                api.setFocus(null, 0);
            } catch (SynapseApi.ApiException ignored) {
            }
            try {
                Map<String, Object> r = api.recordSession(t.sessionJson(now, completed, ZoneId.systemDefault()));
                reward = rewardLine(r, t, completed);
                Map<String, Object> rw = MiniJson.obj(r.get("rewards"));
                if (!rw.isEmpty()) Prefs.saveSummary(c, (int) MiniJson.num(rw, "points", 0), (int) MiniJson.num(rw, "level", 1),
                        (int) MiniJson.num(rw, "currentStreak", 0), (int) MiniJson.num(rw, "trees", 0));
            } catch (SynapseApi.ApiException e) {
                reward = e.status == 403 ? "Not saved: turn on \"Save focus activity\" in Synapse > Privacy" : "Not saved: " + e.getMessage();
            }
        } else if (completed && "focus".equals(t.mode)) {
            reward = "Connect Synapse to earn points for blocks like this";
        }
        Prefs.setLastReward(c, reward);
        if (completed) Notifs.focusDone(c, t, reward.startsWith("Not saved") ? "" : reward);
        return reward;
    }

    private static String rewardLine(Map<String, Object> r, PhoneLogic.Timer t, boolean completed) {
        int earned = (int) MiniJson.num(r, "earned", 0);
        Map<String, Object> tree = MiniJson.obj(r.get("tree"));
        String species = MiniJson.str(tree, "species");
        if (!completed) return earned > 0 ? "Ended early. +" + earned + " points" : "Ended early. Try a shorter block next time";
        if ("break".equals(t.mode)) return "Break taken. +" + earned + " points";
        return "+" + earned + " points" + (species != null ? " and a new " + species + " in your garden" : "");
    }

    static void scheduleAlarm(Context c, long at) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        if (am == null) return;
        PendingIntent pi = alarmIntent(c);
        if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi); // may be a little late without the exact-alarm permission
    }

    static void cancelAlarm(Context c) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        if (am != null) am.cancel(alarmIntent(c));
    }

    private static PendingIntent alarmIntent(Context c) {
        Intent i = new Intent(c, FocusAlarmReceiver.class).setAction(FocusAlarmReceiver.ACTION_COMPLETE);
        return PendingIntent.getBroadcast(c, 42, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static SynapseApi api(Context c) {
        return new SynapseApi(Prefs.server(c), Prefs.key(c));
    }

    static void background(Runnable r) {
        new Thread(r, "synapse-focus").start();
    }
}
