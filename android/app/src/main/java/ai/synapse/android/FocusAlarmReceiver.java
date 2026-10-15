package ai.synapse.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Finishes a block when its time is up (even if the app is closed), and starts a break from the notification. */
public class FocusAlarmReceiver extends BroadcastReceiver {
    static final String ACTION_COMPLETE = "ai.synapse.android.FOCUS_COMPLETE";
    static final String ACTION_START_BREAK = "ai.synapse.android.START_BREAK";

    @Override
    public void onReceive(Context context, Intent intent) {
        Context c = context.getApplicationContext();
        String action = intent.getAction();
        PendingResult pending = goAsync();
        FocusController.background(() -> {
            try {
                if (ACTION_COMPLETE.equals(action)) {
                    FocusController.finish(c, true);
                } else if (ACTION_START_BREAK.equals(action)) {
                    android.app.NotificationManager nm = c.getSystemService(android.app.NotificationManager.class);
                    if (nm != null) nm.cancel(Notifs.ID_DONE);
                    if (Prefs.timer(c) == null) FocusController.start(c, "break", intent.getIntExtra("minutes", 5), "");
                }
            } finally {
                pending.finish();
            }
        });
    }
}
