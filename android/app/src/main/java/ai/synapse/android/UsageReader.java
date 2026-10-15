package ai.synapse.android;

import android.Manifest;
import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.os.Process;

import ai.synapse.android.core.AppCategories;
import ai.synapse.android.core.Payload;
import ai.synapse.android.core.UsageAggregator;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Reads Android's own usage event log (the same data Digital Wellbeing uses).
 * Needs the user to switch on Settings > Usage access > Synapse.
 */
final class UsageReader {
    private UsageReader() {}

    static boolean hasAccess(Context c) {
        AppOpsManager ops = (AppOpsManager) c.getSystemService(Context.APP_OPS_SERVICE);
        int mode;
        if (Build.VERSION.SDK_INT >= 29) {
            mode = ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), c.getPackageName());
        } else {
            mode = ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), c.getPackageName());
        }
        if (mode == AppOpsManager.MODE_DEFAULT) {
            return c.checkCallingOrSelfPermission(Manifest.permission.PACKAGE_USAGE_STATS) == PackageManager.PERMISSION_GRANTED;
        }
        return mode == AppOpsManager.MODE_ALLOWED;
    }

    /** Foreground time per app for today and the previous (days - 1) days: day -> package -> ms. */
    static Map<String, Map<String, Long>> read(Context c, int days) {
        return analyze(c, days).apps;
    }

    /** Per-app time plus hourly usage, pickups and first pickup for each day. */
    static UsageAggregator.Result analyze(Context c, int days) {
        UsageStatsManager usm = (UsageStatsManager) c.getSystemService(Context.USAGE_STATS_SERVICE);
        ZoneId zone = ZoneId.systemDefault();
        long start = LocalDate.now(zone).minusDays(days - 1).atStartOfDay(zone).toInstant().toEpochMilli();
        long end = System.currentTimeMillis();
        List<UsageAggregator.Event> list = new ArrayList<>();
        UsageEvents events = usm.queryEvents(start, end);
        if (events != null) {
            UsageEvents.Event e = new UsageEvents.Event();
            while (events.hasNextEvent()) {
                events.getNextEvent(e);
                list.add(new UsageAggregator.Event(e.getTimeStamp(), e.getPackageName(), e.getEventType()));
            }
        }
        return new UsageAggregator(zone, ignored(c)).analyze(list, end);
    }

    /** Home screens, the system UI and this app itself aren't "using an app". */
    static Set<String> ignored(Context c) {
        Set<String> s = new HashSet<>();
        s.add(c.getPackageName());
        s.add("android");
        s.add("com.android.systemui");
        Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        for (ResolveInfo r : c.getPackageManager().queryIntentActivities(home, 0)) {
            if (r.activityInfo != null) s.add(r.activityInfo.packageName);
        }
        return s;
    }

    /** Display name + category for each package, as Synapse shows them. */
    static Payload.AppLookup lookup(Context c) {
        PackageManager pm = c.getPackageManager();
        return pkg -> {
            try {
                ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
                return new Payload.AppInfo(pm.getApplicationLabel(ai).toString(), AppCategories.forApp(pkg, ai.category));
            } catch (PackageManager.NameNotFoundException e) {
                return new Payload.AppInfo(null, AppCategories.forApp(pkg, AppCategories.CATEGORY_UNDEFINED));
            }
        };
    }
}
