package ai.synapse.android;

import android.app.Service;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;

import ai.synapse.android.core.AppCategories;
import ai.synapse.android.core.Payload;
import ai.synapse.android.core.PhoneLogic;
import ai.synapse.android.core.UsageAggregator;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Focus guard: while a focus block runs (and the user switched this on), checks every 1.5 s which app is in
 * front. Social, video and game apps (and apps with a daily limit) get a "paused" screen on top.
 * Needs Usage access and "Display over other apps". Runs as a foreground service with the countdown notification.
 */
public class FocusGuardService extends Service {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String, Boolean> distracting = new HashMap<>();
    private Payload.AppLookup lookup;
    private String lastBlocked;
    private long lastBlockedAt;

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            PhoneLogic.Timer t = Prefs.timer(FocusGuardService.this);
            if (t == null || !"focus".equals(t.mode) || t.done(System.currentTimeMillis())) {
                stopSelf();
                return;
            }
            try {
                check(t);
            } catch (RuntimeException ignored) {
                // Usage access may have been switched off; keep the timer running regardless.
            }
            handler.postDelayed(this, 1500);
        }
    };

    static void start(Context c) {
        if (!canRun(c)) return;
        Intent i = new Intent(c, FocusGuardService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
            else c.startService(i);
        } catch (RuntimeException ignored) {
            // Starting from the background can be refused; the timer still works without the guard.
        }
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, FocusGuardService.class));
    }

    static boolean canRun(Context c) {
        return Prefs.guard(c) && UsageReader.hasAccess(c) && Settings.canDrawOverlays(c);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        PhoneLogic.Timer t = Prefs.timer(this);
        if (t == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (Build.VERSION.SDK_INT >= 34) startForeground(Notifs.ID_FOCUS, Notifs.focusNotification(this, t), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(Notifs.ID_FOCUS, Notifs.focusNotification(this, t));
        lookup = UsageReader.lookup(this);
        handler.removeCallbacks(poll);
        handler.post(poll);
        return START_NOT_STICKY;
    }

    private void check(PhoneLogic.Timer t) {
        UsageStatsManager usm = (UsageStatsManager) getSystemService(Context.USAGE_STATS_SERVICE);
        long now = System.currentTimeMillis();
        UsageEvents events = usm.queryEvents(now - 15000, now);
        List<UsageAggregator.Event> list = new ArrayList<>();
        if (events != null) {
            UsageEvents.Event e = new UsageEvents.Event();
            while (events.hasNextEvent()) {
                events.getNextEvent(e);
                list.add(new UsageAggregator.Event(e.getTimeStamp(), e.getPackageName(), e.getEventType()));
            }
        }
        String pkg = PhoneLogic.foreground(list);
        if (pkg == null || pkg.equals(getPackageName()) || !isDistracting(pkg)) return;
        if (Prefs.allowedUntil(this, pkg) > now) return;
        if (pkg.equals(lastBlocked) && now - lastBlockedAt < 3000) return; // don't stack screens
        lastBlocked = pkg;
        lastBlockedAt = now;
        Prefs.countGuardBlock(this);
        Intent i = new Intent(this, BlockActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NO_ANIMATION)
                .putExtra("pkg", pkg)
                .putExtra("label", label(pkg));
        startActivity(i);
    }

    private boolean isDistracting(String pkg) {
        Boolean cached = distracting.get(pkg);
        if (cached != null) return cached;
        Payload.AppInfo info = lookup.lookup(pkg);
        boolean d = PhoneLogic.isDistracting(info.category);
        if (!d && info.label != null) {
            String key = PhoneLogic.appKey(info.label);
            for (PhoneLogic.Limit l : Prefs.limits(this)) if (PhoneLogic.appKey(l.app).equals(key)) d = true;
        }
        distracting.put(pkg, d);
        return d;
    }

    private String label(String pkg) {
        Payload.AppInfo info = lookup.lookup(pkg);
        return info.label != null ? info.label : pkg;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(poll);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @SuppressWarnings("unused")
    private static String category(String pkg) {
        return AppCategories.forApp(pkg, AppCategories.CATEGORY_UNDEFINED);
    }
}
