package ai.synapse.android;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

import ai.synapse.android.core.Payload;
import ai.synapse.android.core.PhoneLogic;
import ai.synapse.android.core.SynapseApi;
import ai.synapse.android.core.UsageAggregator;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.TextStyle;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** The whole app: Today, Week, Focus and Settings tabs, built in code. */
public class MainActivity extends Activity {
    private static final String[] TABS = {"today", "week", "focus", "insights", "settings"};
    private static final String[] TAB_LABELS = {"Today", "Week", "Focus", "Insights", "Settings"};

    private Palette p;
    private Ui ui;
    private LinearLayout content, nav;
    private ScrollView scroll;
    private String tab = "today";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable ticker;

    // usage data (loaded in the background)
    private UsageAggregator.Result result;
    private Map<String, List<Payload.Entry>> days;
    private boolean loading;
    private int selectedDay = 6;

    // focus tab choices
    private String focusMode = "focus";
    private int focusMinutes = 25;
    private TextView countdown, focusLabel;
    private boolean busy;

    // from your Synapse account (tasks, goal, insights, badges)
    private AppData server;
    private boolean serverLoading;
    private String serverError;
    private long focusTaskId;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Tr.lang = Prefs.lang(this);
        p = Palette.of(this);
        ui = new Ui(this, p);
        styleWindow();
        Notifs.ensureChannels(this);

        LinearLayout root = ui.column();
        root.setBackgroundColor(p.bg);
        root.setFitsSystemWindows(true);

        LinearLayout header = ui.row();
        header.setPadding(ui.dp(20), ui.dp(14), ui.dp(20), ui.dp(6));
        TextView logo = ui.big("Synapse", 22);
        header.addView(logo, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        root.addView(header);

        scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        content = ui.column();
        content.setPadding(ui.dp(16), 0, ui.dp(16), ui.dp(24));
        scroll.addView(content);
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        nav = ui.row();
        nav.setBackgroundColor(p.surface);
        nav.setPadding(ui.dp(8), ui.dp(6), ui.dp(8), ui.dp(6));
        for (int i = 0; i < TABS.length; i++) {
            final String t = TABS[i];
            TextView b = ui.text(TAB_LABELS[i], 14, p.ink2, true);
            b.setGravity(Gravity.CENTER);
            b.setPadding(0, ui.dp(10), 0, ui.dp(10));
            b.setOnClickListener(v -> show(t));
            nav.addView(b, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        }
        root.addView(nav);
        setContentView(root);

        if (getIntent() != null && getIntent().getStringExtra("tab") != null) tab = getIntent().getStringExtra("tab");
        if (Prefs.timer(this) != null) tab = "focus";
        askNotifications();
        if (Prefs.configured(this)) SyncJobService.schedule(this);
        handleLink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent.getStringExtra("tab") != null) show(intent.getStringExtra("tab"));
        handleLink(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        PhoneLogic.Timer t = Prefs.timer(this);
        if (t != null && t.done(System.currentTimeMillis())) {
            // The alarm may have been missed (e.g. after a restart): finish the block now.
            FocusController.background(() -> {
                FocusController.finish(getApplicationContext(), true);
                runOnUiThread(this::render);
            });
        }
        loadUsage();
        loadServer();
        render();
        startTicker();
    }

    private void loadServer() {
        if (serverLoading || !Prefs.configured(this)) return;
        serverLoading = true;
        FocusController.background(() -> {
            AppData d = null;
            String err = null;
            try {
                d = AppData.load(getApplicationContext());
            } catch (SynapseApi.ApiException e) {
                err = e.getMessage();
            } catch (RuntimeException e) {
                err = "Couldn't read your Synapse data.";
            }
            final AppData fd = d;
            final String fe = err;
            runOnUiThread(() -> {
                serverLoading = false;
                if (fd != null) server = fd;
                serverError = fe;
                if (!"focus".equals(tab) || Prefs.timer(this) == null) render();
            });
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (ticker != null) handler.removeCallbacks(ticker);
    }

    // ------------------------------------------------------------------ setup

    @SuppressWarnings("deprecation")
    private void styleWindow() {
        getWindow().setStatusBarColor(p.bg);
        getWindow().setNavigationBarColor(p.surface);
        if (!p.night) {
            int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= 26) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            getWindow().getDecorView().setSystemUiVisibility(flags);
        }
    }

    private void askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && !Prefs.askedNotifications(this)
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            Prefs.setAskedNotifications(this);
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }

    /** synapse://connect?server=...&key=... from the QR code on the website. */
    private void handleLink(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction()) || intent.getData() == null) return;
        String link = intent.getData().toString();
        intent.setData(null);
        PhoneLogic.ConnectInfo info;
        try {
            info = PhoneLogic.parseConnectLink(link);
        } catch (IllegalArgumentException e) {
            toastDialog("Couldn't connect", e.getMessage());
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("Connect to Synapse?")
                .setMessage("This phone will send its daily app totals to\n" + info.server + "\n\nOnly app names and minutes are sent, never what you do inside apps.")
                .setPositiveButton("Connect", (d, w) -> connect(info.server, info.key))
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void connect(String server, String key) {
        if (busy) return;
        busy = true;
        render();
        FocusController.background(() -> {
            String error = null;
            try {
                String s = SynapseApi.normalizeServer(server);
                SynapseApi.Ping ping = new SynapseApi(s, key).ping();
                Prefs.connect(this, s, key.trim(), ping.user);
                SyncJobService.schedule(this);
                if (!ping.usageConsent) error = "Connected. Turn on \"Track screen time\" in Synapse > Privacy so your phone time is saved.";
                try {
                    Sync.run(getApplicationContext());
                } catch (SynapseApi.ApiException ignored) {
                }
            } catch (SynapseApi.ApiException e) {
                error = e.getMessage();
            }
            final String msg = error;
            runOnUiThread(() -> {
                busy = false;
                if (msg != null) toastDialog(Prefs.configured(this) ? "Connected" : "Couldn't connect", msg);
                show("today");
            });
        });
    }

    private void toastDialog(String title, String msg) {
        new AlertDialog.Builder(this).setTitle(title).setMessage(msg).setPositiveButton("OK", null).show();
    }

    // ------------------------------------------------------------------ data

    private void loadUsage() {
        if (loading || !UsageReader.hasAccess(this)) return;
        loading = true;
        FocusController.background(() -> {
            UsageAggregator.Result r = null;
            Map<String, List<Payload.Entry>> d = null;
            try {
                r = UsageReader.analyze(getApplicationContext(), Sync.DAYS);
                d = Payload.entries(r.apps, UsageReader.lookup(getApplicationContext()));
            } catch (RuntimeException ignored) {
            }
            final UsageAggregator.Result fr = r;
            final Map<String, List<Payload.Entry>> fd = d;
            runOnUiThread(() -> {
                loading = false;
                if (fr != null) {
                    result = fr;
                    days = fd;
                }
                if (!"focus".equals(tab)) render();
            });
        });
    }

    private void syncNow() {
        if (busy) return;
        busy = true;
        render();
        FocusController.background(() -> {
            String msg;
            try {
                msg = Sync.run(getApplicationContext());
            } catch (SynapseApi.ApiException e) {
                msg = e.getMessage();
            }
            final String m = msg;
            runOnUiThread(() -> {
                busy = false;
                android.widget.Toast.makeText(this, m, android.widget.Toast.LENGTH_SHORT).show();
                loadUsage();
                render();
            });
        });
    }

    private static List<String> lastDays() {
        List<String> out = new ArrayList<>();
        LocalDate today = LocalDate.now();
        for (int i = Sync.DAYS - 1; i >= 0; i--) out.add(today.minusDays(i).toString());
        return out;
    }

    private double minutesOn(String day) {
        return result == null ? 0 : result.totalMs(day) / 60000.0;
    }

    // ------------------------------------------------------------------ rendering

    private void show(String t) {
        tab = t;
        scroll.scrollTo(0, 0);
        render();
    }

    private void render() {
        content.removeAllViews();
        countdown = null;
        focusLabel = null;
        for (int i = 0; i < TABS.length; i++) {
            TextView b = (TextView) nav.getChildAt(i);
            boolean on = TABS[i].equals(tab);
            b.setTextColor(on ? p.lichen : p.muted);
            b.setBackground(on ? ui.shape(p.lichenSoft, 0, 12) : null);
        }
        switch (tab) {
            case "week": renderWeek(); break;
            case "focus": renderFocus(); break;
            case "settings": renderSettings(); break;
            case "insights": renderInsights(); break;
            default: renderToday();
        }
    }

    private boolean needsAccess() {
        if (UsageReader.hasAccess(this)) return false;
        LinearLayout c = ui.card(content, "Allow usage access");
        c.addView(ui.body("Synapse reads how long each app is open from Android's own usage log, the same data Digital Wellbeing uses. Nothing else."));
        Button b = ui.button("Open usage access settings", 0);
        b.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)));
        c.addView(b);
        c.addView(ui.note("Find Synapse in the list and switch it on, then come back."));
        return true;
    }

    private void renderToday() {
        if (needsAccess()) return;
        if (!Prefs.configured(this)) {
            LinearLayout c = ui.card(content, "Connect to Synapse");
            c.addView(ui.body("See your phone and laptop time together, get limit alerts from the dashboard, and earn points for focus blocks."));
            Button b = ui.button("Set up connection", 1);
            b.setOnClickListener(v -> show("settings"));
            c.addView(b);
        }
        if (result == null) {
            content.addView(ui.note(loading ? "Reading today's usage…" : "No usage data yet."));
            return;
        }
        String today = LocalDate.now().toString();
        double total = minutesOn(today);
        double sum = 0;
        int n = 0;
        for (String d : lastDays()) {
            if (d.equals(today)) continue;
            double m = minutesOn(d);
            if (m > 0) { sum += m; n++; }
        }

        LinearLayout hero = ui.card(content, null);
        hero.addView(ui.note("Phone time today"));
        hero.addView(ui.big(Ui.fmt(total), 40));
        if (n > 0) {
            double avg = sum / n;
            double diff = total - avg;
            String cmp = Math.abs(diff) < 5 ? "About the same as your daily average (" + Ui.fmt(avg) + ")"
                    : Ui.fmt(Math.abs(diff)) + (diff > 0 ? " more" : " less") + " than your daily average (" + Ui.fmt(avg) + ")";
            TextView t = ui.body(cmp);
            t.setTextColor(diff > 15 ? p.amber : p.ink2);
            hero.addView(t);
        }

        Integer pickups = result.pickups.get(today);
        Long first = result.firstPickup.get(today);
        int[] s = Prefs.summary(this);
        content.addView(ui.stats(new String[][]{
                {pickups == null ? "0" : String.valueOf(pickups), "pickups"},
                {first == null ? "–" : DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault()).format(Instant.ofEpochMilli(first).atZone(ZoneId.systemDefault())), "first pickup"},
                {s == null ? "–" : s[2] + "d", "focus streak"}}));

        renderTodayServer();

        List<PhoneLogic.Limit> limits = Prefs.limits(this);
        Map<String, Double> mins = Sync.todayMinutes(days);
        if (!limits.isEmpty()) {
            LinearLayout c = ui.card(content, "Daily limits");
            Map<String, Double> used = PhoneLogic.usedPerLimit(limits, mins);
            for (PhoneLogic.Limit l : limits) {
                double u = used.get(l.app);
                double f = l.minutes <= 0 ? 0 : u / l.minutes;
                int color = f >= 1 ? p.berry : f >= 0.8 ? p.amber : p.lichen;
                ui.meterRow(c, l.app, Ui.fmt(u) + " / " + Ui.fmt(l.minutes), f, color, f >= 0.8 ? color : p.muted);
            }
            c.addView(ui.note("Limits are set in the Synapse dashboard under Screen time and count your laptop too."));
        }

        List<Payload.Entry> list = days == null ? null : days.get(today);
        LinearLayout c = ui.card(content, "Top apps today");
        if (list == null || list.isEmpty()) {
            c.addView(ui.note("Nothing yet today."));
        } else {
            double max = list.get(0).minutes;
            for (int i = 0; i < Math.min(8, list.size()); i++) {
                Payload.Entry e = list.get(i);
                ui.meterRow(c, e.app, Ui.fmt(e.minutes), e.minutes / max, p.category(e.category), p.muted);
            }
        }
        syncFooter();
    }

    private void syncFooter() {
        if (!Prefs.configured(this)) return;
        long last = Prefs.lastSync(this);
        String err = Prefs.lastError(this);
        String line = last == 0 ? "Not synced yet." : "Last synced " + DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault())
                .format(Instant.ofEpochMilli(last).atZone(ZoneId.systemDefault())) + ". Syncs about every 15 minutes.";
        TextView t = ui.note(err != null ? "Sync problem: " + err : line);
        if (err != null) t.setTextColor(p.berry);
        t.setPadding(0, ui.dp(14), 0, 0);
        content.addView(t);
        Button b = ui.button(busy ? "Syncing…" : "Sync now", 1);
        b.setEnabled(!busy);
        b.setOnClickListener(v -> syncNow());
        content.addView(b);
    }

    private void renderWeek() {
        if (needsAccess()) return;
        if (result == null) {
            content.addView(ui.note(loading ? "Reading your week…" : "No usage data yet."));
            return;
        }
        List<String> ds = lastDays();
        float[] values = new float[ds.size()];
        String[] labels = new String[ds.size()], tips = new String[ds.size()];
        double total = 0;
        for (int i = 0; i < ds.size(); i++) {
            double m = minutesOn(ds.get(i));
            total += m;
            values[i] = (float) m;
            labels[i] = LocalDate.parse(ds.get(i)).getDayOfWeek().getDisplayName(TextStyle.SHORT, Locale.getDefault());
            tips[i] = Ui.fmt(m);
        }
        LinearLayout c = ui.card(content, null);
        c.addView(ui.note("Last 7 days"));
        c.addView(ui.big(Ui.fmt(total / ds.size()) + " a day", 30));
        BarChartView chart = new BarChartView(this);
        chart.setColors(p.night ? Color.parseColor("#8D78E0") : Color.parseColor("#6B4FC8"), p.surface2, p.ink2, p.line);
        chart.setHeightDp(170);
        chart.setData(values, labels, tips, selectedDay);
        chart.setOnBarTap(i -> { selectedDay = i; render(); });
        c.addView(chart);
        c.addView(ui.note("Tap a day to see its details."));

        String day = ds.get(Math.max(0, Math.min(ds.size() - 1, selectedDay)));
        LocalDate ld = LocalDate.parse(day);
        String name = day.equals(LocalDate.now().toString()) ? "Today" : ld.getDayOfWeek().getDisplayName(TextStyle.FULL, Locale.getDefault()) + " " + ld.getDayOfMonth();

        long[] hourly = result.hourly.get(day);
        LinearLayout h = ui.card(content, name + " by hour");
        if (hourly == null) {
            h.addView(ui.note("No phone time that day."));
        } else {
            float[] hv = new float[24];
            String[] hl = new String[24], ht = new String[24];
            int peak = 0;
            for (int i = 0; i < 24; i++) {
                hv[i] = hourly[i] / 60000f;
                hl[i] = i % 6 == 0 ? PhoneLogic.hourLabel(i).replace(" ", "") : "";
                ht[i] = PhoneLogic.hourLabel(i) + " · " + Ui.fmt(hv[i]);
                if (hourly[i] > hourly[peak]) peak = i;
            }
            BarChartView hc = new BarChartView(this);
            hc.setColors(p.night ? Color.parseColor("#8D78E0") : Color.parseColor("#6B4FC8"), p.surface2, p.ink2, p.line);
            hc.setHeightDp(130);
            hc.setData(hv, hl, ht, -1);
            h.addView(hc);
            Integer pk = result.pickups.get(day);
            h.addView(ui.note("Busiest hour: " + PhoneLogic.hourLabel(peak) + ". " + (pk == null ? 0 : pk) + " pickups."));
        }

        List<Payload.Entry> list = days == null ? null : days.get(day);
        LinearLayout a = ui.card(content, "Apps");
        if (list == null || list.isEmpty()) {
            a.addView(ui.note("No app time."));
        } else {
            double max = list.get(0).minutes;
            for (int i = 0; i < Math.min(12, list.size()); i++) {
                Payload.Entry e = list.get(i);
                ui.meterRow(a, e.app, Ui.fmt(e.minutes), e.minutes / max, p.category(e.category), p.muted);
            }
        }
    }

    private void renderFocus() {
        PhoneLogic.Timer t = Prefs.timer(this);
        LinearLayout c = ui.card(content, null);
        c.setGravity(Gravity.CENTER_HORIZONTAL);
        if (t != null) {
            boolean focus = "focus".equals(t.mode);
            focusLabel = ui.note(focus ? "Focusing" + (t.tag.isEmpty() ? "" : " on " + t.tag) : "Break");
            focusLabel.setGravity(Gravity.CENTER);
            c.addView(focusLabel);
            countdown = ui.big(t.countdown(System.currentTimeMillis()), 64);
            countdown.setGravity(Gravity.CENTER);
            c.addView(countdown);
            c.addView(ui.bar(t.progress(System.currentTimeMillis()), focus ? p.lichen : p.dusk));
            TextView hint = ui.note(focus ? "Put the phone face down. Distracting sites are paused on your connected browser."
                    : "Stand up, stretch, look at something far away.");
            hint.setGravity(Gravity.CENTER);
            c.addView(hint);
            if (focus) {
                if (Prefs.guard(this) && FocusGuardService.canRun(this)) {
                    TextView g = ui.note(Tr.lang.equals("hi") ? "सोशल, वीडियो और गेम ऐप इस ब्लॉक के खत्म होने तक रुके हैं।" : "Social, video and game apps are paused until this block ends.");
                    g.setGravity(Gravity.CENTER);
                    g.setTextColor(p.lichen);
                    c.addView(g);
                }
                Button distracted = ui.button("Got distracted?", 1);
                distracted.setOnClickListener(v -> askDistraction());
                c.addView(distracted);
            }
            Button stop = ui.button(busy ? "Saving…" : focus ? "Give up" : "End break", 3);
            stop.setEnabled(!busy);
            stop.setOnClickListener(v -> {
                if (!focus) { finishTimer(false); return; }
                new AlertDialog.Builder(this).setTitle("Give up this block?")
                        .setMessage("It's saved as unfinished and earns no tree.")
                        .setPositiveButton("Give up", (d, w) -> finishTimer(false))
                        .setNegativeButton("Keep going", null).show();
            });
            c.addView(stop);
        } else {
            LinearLayout modes = ui.row();
            modes.setGravity(Gravity.CENTER);
            TextView fm = ui.chip("Focus", "focus".equals(focusMode));
            TextView bm = ui.chip("Break", "break".equals(focusMode));
            fm.setOnClickListener(v -> { focusMode = "focus"; focusMinutes = 25; render(); });
            bm.setOnClickListener(v -> { focusMode = "break"; focusMinutes = 5; render(); });
            modes.addView(fm);
            LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            gap.leftMargin = ui.dp(8);
            modes.addView(bm, gap);
            c.addView(modes);

            TextView big = ui.big(focusMinutes + ":00", 64);
            big.setGravity(Gravity.CENTER);
            c.addView(big);

            LinearLayout presets = ui.row();
            presets.setGravity(Gravity.CENTER);
            int[] opts = "focus".equals(focusMode) ? new int[]{15, 25, 50} : new int[]{5, 10, 15};
            for (int i = 0; i < opts.length; i++) {
                final int m = opts[i];
                TextView chip = ui.chip(m + " min", m == focusMinutes);
                chip.setOnClickListener(v -> { focusMinutes = m; render(); });
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                if (i > 0) lp.leftMargin = ui.dp(8);
                presets.addView(chip, lp);
            }
            c.addView(presets);

            if ("focus".equals(focusMode) && server != null && server.suggestReason != null) {
                TextView sg = ui.note((Tr.lang.equals("hi") ? "सुझाव: " : "Suggested: ") + server.suggestMin + " min. " + server.suggestReason);
                sg.setGravity(Gravity.CENTER);
                if (server.suggestMin != focusMinutes) {
                    sg.setTextColor(p.lichen);
                    sg.setOnClickListener(v -> { focusMinutes = server.suggestMin; render(); });
                }
                c.addView(sg);
            }

            EditText tag = null;
            if ("focus".equals(focusMode) && server != null && !server.openTasks().isEmpty()) {
                TextView th = ui.text("Focus on a task", 14, p.ink2, true);
                th.setPadding(0, ui.dp(12), 0, ui.dp(4));
                c.addView(th);
                android.widget.HorizontalScrollView hs = new android.widget.HorizontalScrollView(this);
                hs.setHorizontalScrollBarEnabled(false);
                LinearLayout chips = ui.row();
                TextView none = ui.chip(Tr.t("No task"), focusTaskId == 0);
                none.setOnClickListener(v -> { focusTaskId = 0; render(); });
                chips.addView(none);
                for (AppData.Task task : server.openTasks()) {
                    TextView ch = ui.chip(task.title + "  " + task.blocksDone + "/" + task.estimate, focusTaskId == task.id);
                    ch.setOnClickListener(v -> { focusTaskId = task.id; Prefs.setLastFocusTag(this, task.title.length() > 40 ? task.title.substring(0, 40) : task.title); render(); });
                    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                    lp.leftMargin = ui.dp(8);
                    chips.addView(ch, lp);
                }
                hs.addView(chips);
                c.addView(hs);
            }
            if ("focus".equals(focusMode)) {
                tag = ui.input("What are you working on? (optional)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
                tag.setText(Prefs.lastFocusTag(this));
                c.addView(tag);
            }
            final EditText tagInput = tag;
            Button start = ui.button("Start " + ("focus".equals(focusMode) ? "focus" : "break"), "focus".equals(focusMode) ? 2 : 0);
            start.setOnClickListener(v -> {
                String tg = tagInput == null ? "" : tagInput.getText().toString().trim();
                FocusController.start(getApplicationContext(), focusMode, focusMinutes, tg, "focus".equals(focusMode) ? focusTaskId : 0);
                if ("focus".equals(focusMode) && Prefs.guard(this) && !FocusGuardService.canRun(this))
                    android.widget.Toast.makeText(this, Tr.lang.equals("hi") ? "ऐप रोकने के लिए सेटिंग्स में अनुमति दें।" : "To pause apps, finish the permissions in Settings.", android.widget.Toast.LENGTH_LONG).show();
                render();
                startTicker();
            });
            c.addView(start);
            String reward = Prefs.lastReward(this);
            if (!reward.isEmpty()) {
                TextView r = ui.body(reward);
                r.setGravity(Gravity.CENTER);
                r.setTextColor(reward.startsWith("Not saved") ? p.berry : p.lichen);
                c.addView(r);
            }
        }

        int[] s = Prefs.summary(this);
        if (s != null) {
            content.addView(ui.stats(new String[][]{{String.valueOf(s[0]), "points"}, {"Lv " + s[1], "level"},
                    {s[2] + "d", "streak"}, {String.valueOf(s[3]), "trees"}}));
        } else if (!Prefs.configured(this)) {
            content.addView(ui.note("Connect Synapse in Settings to earn points and grow trees for finished blocks."));
        }
        LinearLayout tips = ui.card(content, "How it works");
        tips.addView(ui.body("The timer keeps running if you leave the app, and you'll get a notification when it ends. Finished focus blocks earn points and a tree in your Synapse garden, the same as on the website."));
    }

    private static final String[][] DISTRACTIONS = {{"phone", "Phone"}, {"social", "Social media"}, {"messages", "Messages"}, {"thoughts", "Wandering thoughts"},
            {"people", "Someone interrupted"}, {"noise", "Noise"}, {"tired", "Tired or hungry"}, {"other", "Other"}};

    private void askDistraction() {
        String[] names = new String[DISTRACTIONS.length];
        for (int i = 0; i < names.length; i++) names[i] = Tr.t(DISTRACTIONS[i][1]);
        new AlertDialog.Builder(this).setTitle(Tr.t("What pulled you away?"))
                .setItems(names, (d, i) -> {
                    if (!Prefs.configured(this)) { android.widget.Toast.makeText(this, Tr.t("Connect Synapse to see insights."), android.widget.Toast.LENGTH_SHORT).show(); return; }
                    String kind = DISTRACTIONS[i][0];
                    String at = java.time.LocalDateTime.now().format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm"));
                    FocusController.background(() -> {
                        String msg;
                        try {
                            new SynapseApi(Prefs.server(this), Prefs.key(this)).app("POST", "/distractions", "{\"kind\":\"" + kind + "\",\"at\":\"" + at + "\"}");
                            msg = Tr.lang.equals("hi") ? "दर्ज हो गया। वापस फ़ोकस पर।" : "Noted. Back to it.";
                        } catch (SynapseApi.ApiException e) {
                            msg = e.getMessage();
                        }
                        final String m = msg;
                        runOnUiThread(() -> android.widget.Toast.makeText(this, m, android.widget.Toast.LENGTH_SHORT).show());
                    });
                }).show();
    }

    /** Today tab: daily goal, early warning and tasks from your Synapse account. */
    private void renderTodayServer() {
        if (!Prefs.configured(this)) return;
        if (server == null) {
            if (serverError != null) content.addView(ui.note(serverError));
            return;
        }
        if (server.warning != null) {
            LinearLayout w = ui.card(content, Tr.t("Early warning"));
            w.setBackground(ui.shape(p.night ? 0xFF3A2328 : 0xFFF7E3E6, "high".equals(server.warningLevel) ? p.berry : p.amber, 20));
            w.addView(ui.body(server.warning));
        }
        LinearLayout g = ui.card(content, server.todayFocusMin >= server.goalMin ? Tr.t("Daily goal reached") : Tr.t("Daily focus goal"));
        double f = server.goalMin <= 0 ? 0 : (double) server.todayFocusMin / server.goalMin;
        g.addView(ui.bar(f, p.lichen));
        g.addView(ui.note(Ui.fmt(server.todayFocusMin) + " / " + Ui.fmt(server.goalMin)
                + (f >= 1 ? "" : (Tr.lang.equals("hi") ? " · " + Ui.fmt(server.goalMin - server.todayFocusMin) + " बाकी" : " · " + Ui.fmt(server.goalMin - server.todayFocusMin) + " to go"))));

        LinearLayout tc = ui.card(content, Tr.t("Today's tasks"));
        if (server.tasks.isEmpty()) tc.addView(ui.note(Tr.lang.equals("hi") ? "कोई काम नहीं। नीचे जोड़ें।" : "No tasks yet. Add one below, then focus on it from the Focus tab."));
        for (AppData.Task task : server.tasks) {
            LinearLayout r = ui.row();
            android.widget.CheckBox cb = new android.widget.CheckBox(this);
            cb.setChecked(task.done);
            cb.setButtonTintList(android.content.res.ColorStateList.valueOf(p.lichen));
            cb.setOnCheckedChangeListener((b, on) -> FocusController.background(() -> {
                try {
                    new SynapseApi(Prefs.server(this), Prefs.key(this)).app("PUT", "/tasks/" + task.id, "{\"done\":" + on + ",\"day\":\"" + LocalDate.now() + "\"}");
                } catch (SynapseApi.ApiException ignored) {
                }
                runOnUiThread(this::loadServer);
            }));
            r.addView(cb);
            TextView name = ui.text(task.title, 15, task.done ? p.muted : p.ink, false);
            if (task.done) name.setPaintFlags(name.getPaintFlags() | android.graphics.Paint.STRIKE_THRU_TEXT_FLAG);
            r.addView(name, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            r.addView(ui.note(task.blocksDone + "/" + task.estimate));
            tc.addView(r);
        }
        EditText add = ui.input(Tr.lang.equals("hi") ? "काम जोड़ें, जैसे अध्याय 3 दोहराना" : "Add a task, e.g. Revise chapter 3", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        add.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_DONE);
        tc.addView(add);
        Button addBtn = ui.button("Add task", 1);
        addBtn.setOnClickListener(v -> {
            String title = add.getText().toString().trim();
            if (title.isEmpty()) return;
            FocusController.background(() -> {
                String err = null;
                try {
                    new SynapseApi(Prefs.server(this), Prefs.key(this)).app("POST", "/tasks",
                            "{\"title\":" + ai.synapse.android.core.Payload.quote(title) + ",\"day\":\"" + LocalDate.now() + "\"}");
                } catch (SynapseApi.ApiException e) {
                    err = e.getMessage();
                }
                final String fe = err;
                runOnUiThread(() -> {
                    if (fe != null) android.widget.Toast.makeText(this, fe, android.widget.Toast.LENGTH_SHORT).show();
                    loadServer();
                });
            });
        });
        tc.addView(addBtn);
    }

    /** Insights tab: weekly review, early warning trend, personal patterns, level and badges. */
    private void renderInsights() {
        if (!Prefs.configured(this)) {
            LinearLayout c = ui.card(content, "Insights");
            c.addView(ui.body("Connect Synapse to see insights."));
            Button b = ui.button("Set up connection", 1);
            b.setOnClickListener(v -> show("settings"));
            c.addView(b);
            return;
        }
        if (server == null) {
            content.addView(ui.note(serverError != null ? serverError : Tr.t("Loading…")));
            return;
        }
        // level
        LinearLayout lv = ui.card(content, null);
        LinearLayout lr = ui.row();
        TextView num = ui.big(String.valueOf(server.level), 26);
        num.setTextColor(0xFFFFFFFF);
        num.setGravity(Gravity.CENTER);
        num.setBackground(ui.shape(p.lichen, 0, 99));
        lr.addView(num, new LinearLayout.LayoutParams(ui.dp(56), ui.dp(56)));
        LinearLayout lt = ui.column();
        lt.setPadding(ui.dp(14), 0, 0, 0);
        lt.addView(ui.title(server.levelTitle == null ? "Level " + server.level : server.levelTitle));
        lt.addView(ui.note(server.points + " " + Tr.t("points") + " · " + (server.nextLevelAt - server.points) + (Tr.lang.equals("hi") ? " अगले लेवल तक" : " to " + server.nextLevelTitle)));
        lr.addView(lt, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        lv.addView(lr);
        lv.addView(ui.bar(server.levelProgress, p.lichen));

        // weekly review
        LinearLayout rv = ui.card(content, Tr.t("Your week in review"));
        rv.addView(ui.stats(new String[][]{{Ui.fmt(server.weekFocusMin), Tr.t("focused") + pct(server.focusChange, true)},
                {server.activeDays + "/7", Tr.t("days with focus")}}));
        rv.addView(ui.stats(new String[][]{{server.screenAvgMin == null ? "–" : Ui.fmt(server.screenAvgMin), Tr.t("screen a day") + pct(server.screenChange, false)},
                {server.sleepAvg == null ? "–" : (Math.round(server.sleepAvg * 10) / 10.0) + "h", Tr.t("average sleep")}}));
        if (server.topDistraction != null) rv.addView(ui.note((Tr.lang.equals("hi") ? "सबसे बड़ा भटकाव: " : "Top distraction: ") + server.topDistraction));
        if (server.focusNext != null) {
            TextView nx = ui.body((Tr.lang.equals("hi") ? "अगले हफ़्ते के लिए: " : "For next week: ") + server.focusNext);
            nx.setBackground(ui.shape(p.lichenSoft, 0, 12));
            nx.setPadding(ui.dp(12), ui.dp(10), ui.dp(12), ui.dp(10));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.topMargin = ui.dp(10);
            rv.addView(nx, lp);
        }

        // early warning trend
        LinearLayout tr = ui.card(content, Tr.t("Load score, last 14 days"));
        if (server.insightsError != null) tr.addView(ui.note(server.insightsError));
        else if (server.trend.size() < 3) tr.addView(ui.note(Tr.lang.equals("hi") ? "कुछ दिनों के डेटा के बाद रुझान दिखेगा।" : "A trend appears after a few days of data."));
        else {
            if (server.warning != null) {
                TextView w = ui.body(server.warning);
                w.setTextColor("high".equals(server.warningLevel) ? p.berry : p.amber);
                tr.addView(w);
            }
            float[] vals = new float[server.trend.size()];
            String[] labels = new String[vals.length], tips = new String[vals.length];
            for (int i = 0; i < vals.length; i++) {
                vals[i] = server.trend.get(i)[0];
                labels[i] = i == vals.length - 1 ? (Tr.lang.equals("hi") ? "आज" : "Today") : "";
                tips[i] = server.trend.get(i)[0] + "/100";
            }
            BarChartView chart = new BarChartView(this);
            int last = server.trend.get(vals.length - 1)[0];
            chart.setColors(last >= 65 ? p.berry : last >= 40 ? p.amber : p.lichen, p.surface2, p.ink2, p.line);
            chart.setHeightDp(120);
            chart.setData(vals, labels, tips, vals.length - 1);
            tr.addView(chart);
            tr.addView(ui.note(Tr.lang.equals("hi") ? "40 से कम संतुलित · 65+ जोखिम" : "Under 40 balanced · 65+ at risk. Not a medical assessment."));
        }

        // patterns
        LinearLayout pt = ui.card(content, Tr.t("Your personal patterns"));
        if (server.patterns.isEmpty()) pt.addView(ui.note(Tr.lang.equals("hi") ? "अभी कोई साफ़ पैटर्न नहीं। कुछ हफ़्तों बाद दिखेंगे।" : "No clear patterns yet. After a couple of weeks of focus blocks and check-ins, they show up here."));
        for (int i = 0; i < server.patterns.size(); i++) {
            pt.addView(ui.body("• " + server.patterns.get(i)));
            pt.addView(ui.note(server.patternBasis.get(i)));
        }

        // badges
        int earned = 0;
        for (AppData.Badge b : server.badges) if (b.earned) earned++;
        LinearLayout bd = ui.card(content, Tr.t("Badges") + "  " + earned + "/" + server.badges.size());
        for (AppData.Badge b : server.badges) {
            LinearLayout r = ui.row();
            r.setPadding(0, ui.dp(6), 0, ui.dp(6));
            TextView icon = ui.text(b.earned ? "★" : "☆", 20, b.earned ? p.lichen : p.muted, true);
            icon.setPadding(0, 0, ui.dp(12), 0);
            r.addView(icon);
            LinearLayout col = ui.column();
            col.addView(ui.text(b.title, 15, b.earned ? p.ink : p.muted, true));
            col.addView(ui.note(b.desc));
            r.addView(col, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            bd.addView(r);
        }
        if (Prefs.guardBlocks(this) > 0)
            content.addView(ui.note((Tr.lang.equals("hi") ? "फ़ोकस गार्ड ने अब तक इतनी बार ऐप रोके: " : "Focus guard has paused distracting apps ") + Prefs.guardBlocks(this) + (Tr.lang.equals("hi") ? "" : " times so far.")));
    }

    private static String pct(Double x, boolean upGood) {
        if (x == null) return "";
        return " " + (x > 0 ? "▲" : "▼") + Math.abs(Math.round(x * 100)) + "%";
    }

    private void finishTimer(boolean completed) {
        busy = true;
        render();
        FocusController.background(() -> {
            FocusController.finish(getApplicationContext(), completed);
            runOnUiThread(() -> { busy = false; render(); });
        });
    }

    private void startTicker() {
        if (ticker != null) handler.removeCallbacks(ticker);
        ticker = new Runnable() {
            @Override
            public void run() {
                PhoneLogic.Timer t = Prefs.timer(MainActivity.this);
                if (t != null && countdown != null) {
                    long now = System.currentTimeMillis();
                    countdown.setText(t.countdown(now));
                    if (t.done(now) && !busy) finishTimer(true);
                } else if (t == null && countdown != null && !busy) {
                    render(); // finished in the background (alarm)
                }
                handler.postDelayed(this, 1000);
            }
        };
        handler.post(ticker);
    }

    private void renderSettings() {
        // connection
        LinearLayout c = ui.card(content, "Synapse connection");
        if (Prefs.configured(this)) {
            c.addView(ui.body("Connected as " + Prefs.connectedAs(this) + "\n" + Prefs.server(this)));
            Button sync = ui.button(busy ? "Syncing…" : "Sync now", 1);
            sync.setEnabled(!busy);
            sync.setOnClickListener(v -> syncNow());
            c.addView(sync);
            Button dis = ui.button("Disconnect", 3);
            dis.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("Disconnect this phone?")
                    .setMessage("It stops syncing. Time already sent stays in Synapse until you delete it there.")
                    .setPositiveButton("Disconnect", (d, w) -> { Prefs.disconnect(this); SyncJobService.cancel(this); render(); })
                    .setNegativeButton("Cancel", null).show());
            c.addView(dis);
        } else {
            c.addView(ui.body("Fastest: on your laptop open Synapse > Privacy > Connect Android phone, then scan the QR code with your phone's camera."));
            c.addView(ui.note("Or type the address and key it shows:"));
            EditText server = ui.input("Server address, e.g. https://synapse-ai.onrender.com", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
            server.setText(Prefs.server(this));
            EditText key = ui.input("Device key (starts with syn_)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
            c.addView(server);
            c.addView(key);
            Button go = ui.button(busy ? "Connecting…" : "Connect", 0);
            go.setEnabled(!busy);
            go.setOnClickListener(v -> connect(server.getText().toString(), key.getText().toString()));
            c.addView(go);
        }

        // access
        LinearLayout a = ui.card(content, "Usage access");
        boolean access = UsageReader.hasAccess(this);
        a.addView(ui.body(access ? "On. Synapse can read how long apps are open." : "Off. Synapse can't see app time until you switch it on."));
        Button ab = ui.button(access ? "Manage usage access" : "Turn on usage access", access ? 1 : 0);
        ab.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)));
        a.addView(ab);

        // notifications
        LinearLayout n = ui.card(content, "Reminders");
        if (!Notifs.allowed(this)) {
            n.addView(ui.note("Notifications are off for Synapse, so reminders can't show."));
            Button nb = ui.button("Allow notifications", 1);
            nb.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())));
            n.addView(nb);
        }
        n.addView(toggle("Daily limit alerts", "At 80% and 100% of limits you set in the dashboard.", Prefs.limitAlerts(this),
                on -> Prefs.setLimitAlerts(this, on)));
        n.addView(toggle("Bedtime nudge", "A gentle reminder if you're on your phone 10+ minutes after " + PhoneLogic.hourLabel(Prefs.bedtimeHour(this)) + ".",
                Prefs.bedtimeNudge(this), on -> Prefs.setBedtimeNudge(this, on)));
        Button bed = ui.button("Bedtime: " + PhoneLogic.hourLabel(Prefs.bedtimeHour(this)), 1);
        bed.setOnClickListener(v -> pickBedtime());
        n.addView(bed);

        // focus guard: pause distracting apps during a focus block
        LinearLayout fg = ui.card(content, Tr.t("Pause distracting apps during focus"));
        fg.addView(ui.body(Tr.lang.equals("hi")
                ? "फ़ोकस ब्लॉक के दौरान सोशल, वीडियो और गेम ऐप (और जिन ऐप की रोज़ की सीमा है) खोलने पर Synapse एक \"रुका हुआ\" स्क्रीन दिखाएगा। आप 2 मिनट के लिए खोल सकते हैं।"
                : "During a focus block, opening a social, video or game app (or one with a daily limit) shows a \"paused\" screen instead. You can still open it for 2 minutes if you really need to."));
        fg.addView(toggle(Tr.t("Pause distracting apps during focus"), Tr.lang.equals("hi") ? "सिर्फ़ फ़ोकस ब्लॉक के दौरान।" : "Only while a focus block runs.", Prefs.guard(this), on -> {
            Prefs.setGuard(this, on);
            if (on && !android.provider.Settings.canDrawOverlays(this)) render();
        }));
        if (Prefs.guard(this) && !android.provider.Settings.canDrawOverlays(this)) {
            fg.addView(ui.note(Tr.lang.equals("hi") ? "इसके लिए \"दूसरे ऐप के ऊपर दिखाएँ\" की अनुमति चाहिए।" : "This needs the \"Display over other apps\" permission so the pause screen can appear."));
            Button ov = ui.button("Allow display over apps", 0);
            ov.setOnClickListener(v -> startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION, android.net.Uri.parse("package:" + getPackageName()))));
            fg.addView(ov);
        }

        // language
        LinearLayout lg = ui.card(content, Tr.t("Language"));
        LinearLayout lrow = ui.row();
        String[][] langs = {{"en", "English"}, {"hi", "हिन्दी"}};
        for (int i = 0; i < langs.length; i++) {
            final String code = langs[i][0];
            TextView ch = ui.chip(langs[i][1], code.equals(Tr.lang));
            ch.setOnClickListener(v -> { Prefs.setLang(this, code); Tr.lang = code; recreate(); });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            if (i > 0) lp.leftMargin = ui.dp(8);
            lrow.addView(ch, lp);
        }
        lg.addView(lrow);

        // widget + privacy
        LinearLayout w = ui.card(content, "Home-screen widget");
        w.addView(ui.body("Long-press your home screen, choose Widgets, and add Synapse to see today's phone time at a glance."));
        LinearLayout pr = ui.card(content, "Privacy");
        pr.addView(ui.body("Only app names and minutes per day leave this phone, and only to your own Synapse server. Never what you type, watch or read. Turn on \"Track screen time\" in Synapse > Privacy for it to be saved, and delete it there any time."));
        pr.addView(ui.note("Synapse is not a medical tool."));
    }

    private interface OnToggle { void set(boolean on); }

    private View toggle(String label, String desc, boolean on, OnToggle cb) {
        LinearLayout r = ui.row();
        r.setPadding(0, ui.dp(8), 0, ui.dp(4));
        LinearLayout txt = ui.column();
        txt.addView(ui.text(label, 15, p.ink, true));
        txt.addView(ui.note(desc));
        r.addView(txt, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Switch s = new Switch(this);
        s.setChecked(on);
        s.setOnCheckedChangeListener((b, v) -> cb.set(v));
        r.addView(s);
        return r;
    }

    private void pickBedtime() {
        int[] hours = {21, 22, 23, 0, 1};
        String[] names = new String[hours.length];
        int cur = Prefs.bedtimeHour(this), checked = 2;
        for (int i = 0; i < hours.length; i++) {
            names[i] = PhoneLogic.hourLabel(hours[i]);
            if (hours[i] == cur) checked = i;
        }
        new AlertDialog.Builder(this).setTitle("Bedtime")
                .setSingleChoiceItems(names, checked, (d, i) -> {
                    Prefs.setBedtimeHour(this, hours[i]);
                    d.dismiss();
                    render();
                }).show();
    }
}
