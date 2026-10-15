package ai.synapse.android;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import ai.synapse.android.core.PhoneLogic;

/** Shown over a distracting app during a focus block: go back to focus, allow 2 minutes, or end the block. */
public class BlockActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private TextView countdown;
    private String pkg;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Tr.lang = Prefs.lang(this);
        Palette p = Palette.of(this);
        Ui ui = new Ui(this, p);
        getWindow().setStatusBarColor(p.bg);
        pkg = getIntent().getStringExtra("pkg");
        String label = getIntent().getStringExtra("label");

        LinearLayout root = ui.column();
        root.setBackgroundColor(p.bg);
        root.setGravity(Gravity.CENTER);
        root.setPadding(ui.dp(28), ui.dp(28), ui.dp(28), ui.dp(28));

        TextView leaf = ui.text("🌱", 56, p.ink, false);
        leaf.setGravity(Gravity.CENTER);
        root.addView(leaf);
        TextView title = ui.big(Tr.t("Paused during focus"), 26);
        title.setGravity(Gravity.CENTER);
        root.addView(title);
        TextView sub = ui.body((label == null ? "This app" : label) + (Tr.lang.equals("hi") ? " फ़ोकस खत्म होने तक रुका है।" : " is paused until your focus block ends."));
        sub.setGravity(Gravity.CENTER);
        root.addView(sub);
        countdown = ui.big("", 54);
        countdown.setTextColor(p.lichen);
        countdown.setGravity(Gravity.CENTER);
        root.addView(countdown);
        TextView left = ui.note(Tr.lang.equals("hi") ? "बचा समय" : "left in this block");
        left.setGravity(Gravity.CENTER);
        root.addView(left);

        LinearLayout buttons = ui.column();
        buttons.setPadding(0, ui.dp(24), 0, 0);
        Button back = ui.button("Back to focus", 2);
        back.setOnClickListener(v -> goHome());
        buttons.addView(back);
        Button allow = ui.button(Tr.lang.equals("hi") ? "2 मिनट के लिए खोलें" : "Use it for 2 minutes", 1);
        allow.setOnClickListener(v -> {
            if (pkg != null) Prefs.allow(this, pkg, System.currentTimeMillis() + 2 * 60_000L);
            finish();
        });
        buttons.addView(allow);
        Button end = ui.button("End focus block", 3);
        end.setOnClickListener(v -> FocusController.background(() -> {
            FocusController.finish(getApplicationContext(), false);
            runOnUiThread(this::finish);
        }));
        buttons.addView(end);
        root.addView(buttons, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        setContentView(root);
        tick();
    }

    private void tick() {
        PhoneLogic.Timer t = Prefs.timer(this);
        if (t == null || t.done(System.currentTimeMillis())) {
            finish();
            return;
        }
        countdown.setText(PhoneLogic.mmss(t.remaining(System.currentTimeMillis())));
        handler.postDelayed(this::tick, 1000);
    }

    private void goHome() {
        startActivity(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        finish();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        goHome();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @SuppressWarnings("unused")
    private static int unused() {
        return Color.TRANSPARENT;
    }
}
