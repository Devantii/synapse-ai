package ai.synapse.android;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

/** Home-screen widget: today's phone time, pickups and top app. Refreshed by each sync. */
public class SynapseWidget extends AppWidgetProvider {

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        render(context, manager, ids, context.getSharedPreferences("synapse_widget", Context.MODE_PRIVATE));
    }

    /** Save the latest numbers and redraw every Synapse widget. */
    static void update(Context c, String total, String pickups, String top) {
        android.content.SharedPreferences sp = c.getSharedPreferences("synapse_widget", Context.MODE_PRIVATE);
        sp.edit().putString("total", total).putString("pickups", pickups).putString("top", top).apply();
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        int[] ids = m.getAppWidgetIds(new ComponentName(c, SynapseWidget.class));
        if (ids != null && ids.length > 0) render(c, m, ids, sp);
    }

    private static void render(Context c, AppWidgetManager m, int[] ids, android.content.SharedPreferences sp) {
        Intent open = new Intent(c, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(c, 5, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        for (int id : ids) {
            RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget);
            v.setTextViewText(R.id.widget_total, sp.getString("total", "–"));
            v.setTextViewText(R.id.widget_pickups, sp.getString("pickups", ""));
            v.setTextViewText(R.id.widget_top, sp.getString("top", "Open Synapse to start"));
            v.setOnClickPendingIntent(R.id.widget_root, pi);
            m.updateAppWidget(id, v);
        }
    }
}
