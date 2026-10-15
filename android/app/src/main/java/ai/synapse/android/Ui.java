package ai.synapse.android;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/** Small helpers for building the screens in code (keeps the app free of layout libraries). */
final class Ui {
    final Context ctx;
    final Palette p;

    Ui(Context ctx, Palette p) {
        this.ctx = ctx;
        this.p = p;
    }

    int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.getResources().getDisplayMetrics()));
    }

    LinearLayout column() {
        LinearLayout l = new LinearLayout(ctx);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    LinearLayout row() {
        LinearLayout l = new LinearLayout(ctx);
        l.setOrientation(LinearLayout.HORIZONTAL);
        l.setGravity(Gravity.CENTER_VERTICAL);
        return l;
    }

    TextView text(CharSequence s, float sp, int color, boolean bold) {
        TextView t = new TextView(ctx);
        t.setText(s instanceof String ? Tr.t(s) : s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setLineSpacing(0, 1.15f);
        if (bold) t.setTypeface(Typeface.create("sans-serif-medium", Typeface.BOLD));
        t.setPadding(0, dp(2), 0, dp(4));
        return t;
    }

    TextView title(CharSequence s) {
        return text(s, 18, p.ink, true);
    }

    TextView body(CharSequence s) {
        return text(s, 15, p.ink2, false);
    }

    TextView note(CharSequence s) {
        return text(s, 13, p.muted, false);
    }

    TextView big(CharSequence s, float sp) {
        TextView t = text(s, sp, p.ink, true);
        t.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
        t.setLetterSpacing(-0.02f);
        return t;
    }

    GradientDrawable shape(int fill, int stroke, float radiusDp) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(dp(radiusDp));
        if (stroke != 0) g.setStroke(dp(1), stroke);
        return g;
    }

    Button button(String label, int style) {
        // style: 0 = primary (ink), 1 = secondary (outline), 2 = grow (green), 3 = danger
        Button b = new Button(ctx);
        b.setText(Tr.t(label));
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        b.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        int fill, text, stroke;
        switch (style) {
            case 0: fill = p.ink; text = p.bg; stroke = p.ink; break;
            case 2: fill = p.lichen; text = Color.WHITE; stroke = p.lichen; break;
            case 3: fill = Color.TRANSPARENT; text = p.berry; stroke = p.berry; break;
            default: fill = p.surface; text = p.ink; stroke = p.line;
        }
        b.setTextColor(text);
        b.setBackground(shape(fill, stroke, 12));
        b.setStateListAnimator(null);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50));
        lp.topMargin = dp(10);
        b.setLayoutParams(lp);
        return b;
    }

    /** Pill-shaped choice; call select(true/false) via {@link #setChip}. */
    TextView chip(String label, boolean selected) {
        TextView t = text(label, 14, selected ? p.bg : p.ink2, true);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(16), dp(9), dp(16), dp(9));
        setChip(t, selected);
        t.setClickable(true);
        return t;
    }

    void setChip(TextView t, boolean selected) {
        t.setTextColor(selected ? p.bg : p.ink2);
        t.setBackground(shape(selected ? p.ink : p.surface, selected ? p.ink : p.line, 99));
    }

    EditText input(String hint, int type) {
        EditText e = new EditText(ctx);
        e.setHint(hint);
        e.setInputType(type);
        e.setSingleLine(true);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        e.setTextColor(p.ink);
        e.setHintTextColor(p.muted);
        e.setBackground(shape(p.surface, p.line, 10));
        e.setPadding(dp(12), dp(12), dp(12), dp(12));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(8);
        e.setLayoutParams(lp);
        return e;
    }

    /** A rounded panel with an optional title, added to parent. */
    LinearLayout card(LinearLayout parent, String title) {
        LinearLayout c = column();
        c.setBackground(shape(p.surface, p.line, 20));
        int pad = dp(16);
        c.setPadding(pad, dp(14), pad, pad);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(14);
        parent.addView(c, lp);
        if (title != null) c.addView(title(title));
        return c;
    }

    ProgressBar bar(double fraction, int color) {
        ProgressBar b = new ProgressBar(ctx, null, android.R.attr.progressBarStyleHorizontal);
        b.setMax(1000);
        b.setProgress((int) Math.round(1000 * Math.max(0, Math.min(1, fraction))));
        b.setProgressTintList(ColorStateList.valueOf(color));
        b.setProgressBackgroundTintList(ColorStateList.valueOf(p.surface2));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(8));
        lp.topMargin = dp(2);
        lp.bottomMargin = dp(10);
        b.setLayoutParams(lp);
        return b;
    }

    /** "Label ............ value" line followed by a bar. */
    void meterRow(LinearLayout parent, String label, String value, double fraction, int color, int valueColor) {
        LinearLayout r = row();
        TextView name = text(label, 15, p.ink, false);
        name.setSingleLine(true);
        name.setEllipsize(android.text.TextUtils.TruncateAt.END);
        r.addView(name, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        r.addView(text(value, 14, valueColor, false));
        parent.addView(r);
        parent.addView(bar(fraction, color));
    }

    /** Equal-width stat tiles: big number + small label. */
    LinearLayout stats(String[][] items) {
        LinearLayout r = row();
        r.setBaselineAligned(false);
        for (int i = 0; i < items.length; i++) {
            LinearLayout tile = column();
            tile.setBackground(shape(p.surface, p.line, 16));
            tile.setPadding(dp(12), dp(10), dp(12), dp(10));
            tile.addView(big(items[i][0], 22));
            tile.addView(note(items[i][1]));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1);
            if (i > 0) lp.leftMargin = dp(8);
            r.addView(tile, lp);
        }
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(14);
        r.setLayoutParams(lp);
        return r;
    }

    View space(int dpHeight) {
        View v = new View(ctx);
        v.setLayoutParams(new LinearLayout.LayoutParams(1, dp(dpHeight)));
        return v;
    }

    static String fmt(double minutes) {
        long m = Math.round(minutes);
        if (m >= 60) return (m / 60) + "h " + (m % 60) + "m";
        if (minutes > 0 && m == 0) return "<1m";
        return m + "m";
    }
}
