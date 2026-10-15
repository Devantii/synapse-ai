package ai.synapse.android;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.text.format.DateUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import ai.synapse.android.core.Payload;
import ai.synapse.android.core.SynapseApi;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The whole app is one screen:
 *  1. allow Usage access, 2. connect to Synapse with a device key, 3. see today's apps, sync.
 * The UI is built in code to keep the project tiny and dependency-free.
 */
public class MainActivity extends Activity {
    private static final int INK = Color.parseColor("#1C2A33");
    private static final int INK2 = Color.parseColor("#4A5B66");
    private static final int MUTED = Color.parseColor("#74838C");
    private static final int LICHEN = Color.parseColor("#3F7355");
    private static final int BERRY = Color.parseColor("#A33A4C");
    private static final int MIST = Color.parseColor("#EEF2F3");
    private static final int LINE = Color.parseColor("#CDD6DA");

    private final ExecutorService bg = Executors.newSingleThreadExecutor();
    private final Handler ui = new Handler(Looper.getMainLooper());

    private TextView accessStatus, connStatus, syncStatus, todayTotal;
    private Button accessButton, connectButton, disconnectButton, syncButton;
    private EditText serverInput, keyInput;
    private LinearLayout connectForm, appsList;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setTitle("Synapse");
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(MIST);
        LinearLayout root = column();
        int pad = dp(20);
        root.setPadding(pad, pad, pad, dp(40));
        scroll.addView(root);

        root.addView(text("Phone screen time for Synapse", 22, INK, true));
        root.addView(text("Measures how long each app is open on this phone and adds the daily totals to your Synapse account.", 15, INK2, false));

        // 1. usage access
        LinearLayout access = card(root, "1. Allow usage access");
        accessStatus = text("", 15, INK2, false);
        access.addView(accessStatus);
        accessButton = button("Allow usage access", true);
        accessButton.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)));
        access.addView(accessButton);

        // 2. connect
        LinearLayout conn = card(root, "2. Connect to Synapse");
        connStatus = text("", 15, INK2, false);
        conn.addView(connStatus);
        connectForm = column();
        connectForm.addView(text("In Synapse, open Privacy and choose Connect Android phone. Enter the address and key it shows.", 14, MUTED, false));
        serverInput = input("Server address, e.g. https://synapse-ai.onrender.com", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        keyInput = input("Device key (starts with syn_)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        connectForm.addView(serverInput);
        connectForm.addView(keyInput);
        connectButton = button("Connect", true);
        connectButton.setOnClickListener(v -> connect());
        connectForm.addView(connectButton);
        conn.addView(connectForm);
        disconnectButton = button("Disconnect", false);
        disconnectButton.setOnClickListener(v -> {
            Prefs.disconnect(this);
            SyncJobService.cancel(this);
            refresh();
        });
        conn.addView(disconnectButton);

        // 3. today
        LinearLayout today = card(root, "Today on this phone");
        todayTotal = text("", 28, INK, true);
        today.addView(todayTotal);
        appsList = column();
        today.addView(appsList);
        syncButton = button("Sync now", true);
        syncButton.setOnClickListener(v -> syncNow());
        today.addView(syncButton);
        syncStatus = text("", 13, MUTED, false);
        today.addView(syncStatus);

        root.addView(text("Privacy: Synapse reads only which app was in front and for how long. It never sees what you do inside apps, "
                + "your messages, notifications or location. Totals for the last 7 days are sent every 30 minutes using your device key, "
                + "which you can revoke in Synapse at any time.", 13, MUTED, false));

        setContentView(scroll);
        serverInput.setText(Prefs.server(this));
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh(); // e.g. coming back from the Usage access settings screen
    }

    @Override
    protected void onDestroy() {
        bg.shutdownNow();
        super.onDestroy();
    }

    private void refresh() {
        boolean access = UsageReader.hasAccess(this);
        accessStatus.setText(access ? "On. Synapse can read how long apps are open." : "Off. Find Synapse in the list and switch it on.");
        accessStatus.setTextColor(access ? LICHEN : BERRY);
        accessButton.setVisibility(access ? View.GONE : View.VISIBLE);

        boolean connected = Prefs.configured(this);
        connStatus.setText(connected ? "Connected as " + Prefs.connectedAs(this) + " to " + Prefs.server(this) : "Not connected yet.");
        connStatus.setTextColor(connected ? LICHEN : INK2);
        connectForm.setVisibility(connected ? View.GONE : View.VISIBLE);
        disconnectButton.setVisibility(connected ? View.VISIBLE : View.GONE);
        syncButton.setEnabled(connected && access);

        long last = Prefs.lastSync(this);
        String err = Prefs.lastError(this);
        if (err != null) {
            syncStatus.setText("Last sync failed: " + err);
            syncStatus.setTextColor(BERRY);
        } else {
            syncStatus.setText(last > 0 ? "Last synced " + DateUtils.getRelativeTimeSpanString(last) + ". Syncs about every 30 minutes." : (connected ? "Syncs about every 30 minutes." : ""));
            syncStatus.setTextColor(MUTED);
        }
        if (connected && access) SyncJobService.schedule(this);
        loadToday(access);
    }

    private void loadToday(boolean access) {
        if (!access) {
            todayTotal.setText("–");
            appsList.removeAllViews();
            return;
        }
        bg.execute(() -> {
            Map<String, List<Payload.Entry>> days;
            try {
                days = Payload.entries(UsageReader.read(this, 1), UsageReader.lookup(this));
            } catch (RuntimeException e) {
                return;
            }
            List<Payload.Entry> list = days.get(LocalDate.now().toString());
            ui.post(() -> showToday(list));
        });
    }

    private void showToday(List<Payload.Entry> list) {
        appsList.removeAllViews();
        double total = 0;
        if (list != null) for (Payload.Entry e : list) total += e.minutes;
        todayTotal.setText(fmt(total));
        if (list == null || list.isEmpty()) {
            appsList.addView(text("Nothing measured yet today.", 14, MUTED, false));
            return;
        }
        double max = list.get(0).minutes;
        for (int i = 0; i < Math.min(8, list.size()); i++) {
            Payload.Entry e = list.get(i);
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            TextView name = text(e.app, 15, INK, false);
            row.addView(name, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            row.addView(text(fmt(e.minutes), 15, INK2, false));
            appsList.addView(row);
            ProgressBar bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
            bar.setMax(1000);
            bar.setProgress((int) Math.round(1000 * e.minutes / max));
            bar.setProgressTintList(android.content.res.ColorStateList.valueOf(LICHEN));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(6));
            lp.bottomMargin = dp(10);
            appsList.addView(bar, lp);
        }
    }

    private void connect() {
        String server = SynapseApi.normalizeServer(serverInput.getText().toString());
        String key = keyInput.getText().toString().trim();
        connectButton.setEnabled(false);
        connStatus.setText("Checking…");
        bg.execute(() -> {
            try {
                SynapseApi.Ping ping = new SynapseApi(server, key).ping();
                Prefs.connect(this, server, key, ping.user + " (" + ping.device + ")");
                String note = ping.usageConsent ? null : "Connected, but \"Save screen-time data\" is off in Synapse > Privacy. Turn it on so totals can upload.";
                ui.post(() -> {
                    keyInput.setText("");
                    connectButton.setEnabled(true);
                    refresh();
                    if (note != null) {
                        syncStatus.setText(note);
                        syncStatus.setTextColor(BERRY);
                    } else if (UsageReader.hasAccess(this)) syncNow();
                });
            } catch (SynapseApi.ApiException e) {
                ui.post(() -> {
                    connectButton.setEnabled(true);
                    connStatus.setText(e.getMessage());
                    connStatus.setTextColor(BERRY);
                });
            }
        });
    }

    private void syncNow() {
        syncButton.setEnabled(false);
        syncStatus.setText("Syncing…");
        syncStatus.setTextColor(MUTED);
        bg.execute(() -> {
            String msg;
            try {
                msg = Sync.run(getApplicationContext());
            } catch (SynapseApi.ApiException e) {
                msg = null;
            }
            String done = msg;
            ui.post(() -> {
                refresh();
                if (done != null) syncStatus.setText(done + " " + syncStatus.getText());
            });
        });
    }

    // ---- tiny view helpers -------------------------------------------------------------
    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private LinearLayout column() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setLineSpacing(0, 1.15f);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(4), 0, dp(6));
        return t;
    }

    private EditText input(String hint, int type) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setInputType(type);
        e.setSingleLine(true);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        return e;
    }

    private Button button(String label, boolean primary) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(primary ? Color.WHITE : INK);
        GradientDrawable bgShape = new GradientDrawable();
        bgShape.setCornerRadius(dp(10));
        bgShape.setColor(primary ? INK : Color.WHITE);
        bgShape.setStroke(dp(1), primary ? INK : LINE);
        b.setBackground(bgShape);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48));
        lp.topMargin = dp(10);
        b.setLayoutParams(lp);
        return b;
    }

    private LinearLayout card(LinearLayout parent, String title) {
        LinearLayout c = column();
        GradientDrawable shape = new GradientDrawable();
        shape.setCornerRadius(dp(18));
        shape.setColor(Color.WHITE);
        shape.setStroke(dp(1), LINE);
        c.setBackground(shape);
        int p = dp(16);
        c.setPadding(p, p, p, p);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(16);
        parent.addView(c, lp);
        TextView t = text(title, 17, INK, true);
        t.setGravity(Gravity.START);
        c.addView(t);
        return c;
    }

    private static String fmt(double minutes) {
        long m = Math.round(minutes);
        return m >= 60 ? (m / 60) + "h " + (m % 60) + "m" : m + "m";
    }
}
