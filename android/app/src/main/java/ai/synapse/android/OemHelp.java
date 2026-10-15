package ai.synapse.android;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import java.util.Locale;

/**
 * Some phone makers (Oppo/Realme/OnePlus ColorOS, Xiaomi, Vivo, Samsung...) stop background apps to save
 * battery, which can delay the focus-end alarm, the focus guard and syncing. These helpers open the right
 * screens so the user can let Synapse keep running.
 */
final class OemHelp {
    private OemHelp() {}

    static String maker() {
        return Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase(Locale.ROOT);
    }

    static boolean isColorOs() {
        String m = maker();
        return m.contains("oppo") || m.contains("realme") || m.contains("oneplus");
    }

    static boolean aggressive() {
        String m = maker();
        return isColorOs() || m.contains("xiaomi") || m.contains("redmi") || m.contains("poco") || m.contains("vivo")
                || m.contains("iqoo") || m.contains("huawei") || m.contains("honor") || m.contains("samsung") || m.contains("tecno") || m.contains("infinix");
    }

    static boolean batteryUnrestricted(Context c) {
        PowerManager pm = c.getSystemService(PowerManager.class);
        return pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName());
    }

    /** Asks Android to stop optimising (pausing) Synapse in the background. */
    static void askBattery(Activity a) {
        try {
            a.startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + a.getPackageName())));
        } catch (RuntimeException e) {
            openAppDetails(a);
        }
    }

    // Known "auto-start / background activity" screens, newest first. Each is tried until one opens.
    private static final String[][] AUTOSTART = {
            {"com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"},
            {"com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"},
            {"com.oplus.safecenter", "com.oplus.safecenter.permission.startup.StartupAppListActivity"},
            {"com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"},
            {"com.coloros.oppoguardelf", "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity"},
            {"com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"},
            {"com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"},
            {"com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"},
            {"com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"},
            {"com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"},
    };

    /** Opens the maker's auto-start screen if there is one, otherwise this app's settings page. */
    static void openAutoStart(Activity a) {
        for (String[] c : AUTOSTART) {
            try {
                a.startActivity(new Intent().setComponent(new ComponentName(c[0], c[1])).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                return;
            } catch (RuntimeException ignored) {
                // not this maker / version
            }
        }
        openAppDetails(a);
    }

    static void openAppDetails(Activity a) {
        a.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + a.getPackageName())));
    }

    /** Short, maker-specific steps shown in Settings. */
    static String steps(boolean hindi) {
        if (isColorOs()) return hindi
                ? "Oppo/ColorOS पर: 1) \"बैटरी प्रतिबंध हटाएँ\" दबाएँ और Allow चुनें। 2) \"ऑटो-स्टार्ट खोलें\" में Synapse चालू करें। 3) Recent apps में Synapse को नीचे खींचकर लॉक करें। 4) Settings > Battery > More settings में \"Optimise battery use\" से Synapse हटाएँ।"
                : "On Oppo (ColorOS): 1) Tap \"Remove battery restriction\" and choose Allow. 2) Tap \"Open auto-start\" and switch Synapse on (Auto launch / Allow background activity). "
                + "3) In Recent apps, pull Synapse down to lock it so cleaning doesn't close it. 4) In Settings > Battery > More settings > Optimise battery use, set Synapse to \"Don't optimise\".";
        return hindi
                ? "कुछ फ़ोन बैटरी बचाने के लिए बैकग्राउंड ऐप बंद कर देते हैं। बैटरी प्रतिबंध हटाएँ और ऑटो-स्टार्ट चालू करें।"
                : "Some phones stop background apps to save battery, which can delay the focus timer and pause screen. Remove the battery restriction and allow auto-start.";
    }
}
