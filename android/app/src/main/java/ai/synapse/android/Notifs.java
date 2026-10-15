package ai.synapse.android;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;

import ai.synapse.android.core.PhoneLogic;

/** All notifications: daily limits, the running focus timer, "block done", and the bedtime nudge. */
final class Notifs {
    static final String CH_LIMITS = "limits", CH_FOCUS = "focus", CH_DONE = "focus_done", CH_BEDTIME = "bedtime";
    static final int ID_FOCUS = 10, ID_DONE = 11, ID_BEDTIME = 12, ID_LIMIT_BASE = 1000;
    private static final int ACCENT = Color.parseColor("#3F7355");

    private Notifs() {}

    static void ensureChannels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        nm.createNotificationChannel(channel(CH_LIMITS, "Daily limits", "Heads-up at 80% and 100% of a daily limit", NotificationManager.IMPORTANCE_DEFAULT));
        nm.createNotificationChannel(channel(CH_FOCUS, "Focus timer", "The countdown while a focus block or break runs", NotificationManager.IMPORTANCE_LOW));
        nm.createNotificationChannel(channel(CH_DONE, "Focus finished", "When a focus block or break ends", NotificationManager.IMPORTANCE_HIGH));
        nm.createNotificationChannel(channel(CH_BEDTIME, "Bedtime nudge", "A gentle reminder when you're on your phone after bedtime", NotificationManager.IMPORTANCE_DEFAULT));
    }

    private static NotificationChannel channel(String id, String name, String desc, int importance) {
        NotificationChannel ch = new NotificationChannel(id, name, importance);
        ch.setDescription(desc);
        return ch;
    }

    static boolean allowed(Context c) {
        if (Build.VERSION.SDK_INT >= 33 && c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        return nm != null && nm.areNotificationsEnabled();
    }

    private static PendingIntent openApp(Context c, String tab) {
        Intent i = new Intent(c, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra("tab", tab);
        return PendingIntent.getActivity(c, tab.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static Notification.Builder base(Context c, String channel, String title, String text) {
        return new Notification.Builder(c, channel)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(ACCENT)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setAutoCancel(true);
    }

    private static void post(Context c, int id, Notification n) {
        if (!allowed(c)) return;
        ensureChannels(c);
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(id, n);
    }

    static void limit(Context c, PhoneLogic.Alert a) {
        post(c, ID_LIMIT_BASE + (a.key.hashCode() & 0xffff), base(c, CH_LIMITS, a.title(), a.text()).setContentIntent(openApp(c, "today")).build());
    }

    static void bedtime(Context c, int minutesSince, int bedtimeHour) {
        String text = "You've been on your phone about " + minutesSince + " min since " + PhoneLogic.hourLabel(bedtimeHour)
                + ". Putting it down now helps tomorrow's focus.";
        post(c, ID_BEDTIME, base(c, CH_BEDTIME, "Time to wind down?", text).setContentIntent(openApp(c, "today")).build());
    }

    /** Ongoing countdown while a block runs. */
    static void focusRunning(Context c, PhoneLogic.Timer t) {
        boolean focus = "focus".equals(t.mode);
        String title = focus ? "Focusing" + (t.tag.isEmpty() ? "" : ": " + t.tag) : "Break";
        String text = focus ? "Distracting sites are paused on your connected browser too." : "Stretch, breathe, look away from screens.";
        Notification n = base(c, CH_FOCUS, title, text)
                .setOngoing(true)
                .setAutoCancel(false)
                .setUsesChronometer(true)
                .setChronometerCountDown(true)
                .setWhen(t.endsAt)
                .setShowWhen(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(openApp(c, "focus"))
                .build();
        post(c, ID_FOCUS, n);
    }

    static void cancelFocus(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(ID_FOCUS);
    }

    /** "Focus block done" with a one-tap break. */
    static void focusDone(Context c, PhoneLogic.Timer t, String reward) {
        boolean focus = "focus".equals(t.mode);
        String title = focus ? "Focus block done" : "Break's over";
        String text = focus ? (reward.isEmpty() ? "Nice work. " : reward + ". ") + "Take a short break before the next one." : "Ready for the next focus block?";
        Notification.Builder b = base(c, CH_DONE, title, text).setContentIntent(openApp(c, "focus"));
        if (focus) {
            int mins = t.plannedMin >= 50 ? 10 : 5;
            Intent i = new Intent(c, FocusAlarmReceiver.class).setAction(FocusAlarmReceiver.ACTION_START_BREAK).putExtra("minutes", mins);
            PendingIntent pi = PendingIntent.getBroadcast(c, 77, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            b.addAction(new Notification.Action.Builder(null, "Start " + mins + "-min break", pi).build());
        }
        post(c, ID_DONE, b.build());
    }
}
