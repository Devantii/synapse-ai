package ai.synapse.android;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.util.TypedValue;
import android.view.MotionEvent;
import android.view.View;

/** A small single-series bar chart with labels, a highlighted bar and tap-to-select. */
final class BarChartView extends View {
    interface OnBarTap {
        void onTap(int index);
    }

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF rect = new RectF();
    private float[] values = new float[0];
    private String[] labels = new String[0];
    private String[] tips = new String[0];
    private int selected = -1;
    private int barColor, softColor, textColor, baseColor;
    private int heightDp = 160;
    private OnBarTap listener;

    BarChartView(Context c) {
        super(c);
        setClickable(true);
    }

    void setColors(int bar, int soft, int text, int base) {
        barColor = bar;
        softColor = soft;
        textColor = text;
        baseColor = base;
    }

    /** @param tips text shown above the selected bar (e.g. "2h 5m") */
    void setData(float[] values, String[] labels, String[] tips, int selected) {
        this.values = values;
        this.labels = labels;
        this.tips = tips;
        this.selected = selected;
        StringBuilder desc = new StringBuilder();
        for (int i = 0; i < values.length; i++) if (labels[i] != null && !labels[i].isEmpty()) desc.append(labels[i]).append(": ").append(tips[i]).append(". ");
        setContentDescription(desc.toString());
        invalidate();
    }

    void setHeightDp(int dp) {
        heightDp = dp;
        requestLayout();
    }

    void setOnBarTap(OnBarTap l) {
        listener = l;
    }

    private float dp(float v) {
        return TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private float sp(float v) {
        return TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, v, getResources().getDisplayMetrics());
    }

    @Override
    protected void onMeasure(int w, int h) {
        setMeasuredDimension(getDefaultSize(getSuggestedMinimumWidth(), w), (int) dp(heightDp));
    }

    @Override
    protected void onDraw(Canvas canvas) {
        int n = values.length;
        if (n == 0) return;
        float w = getWidth(), h = getHeight();
        float top = sp(18), bottom = h - sp(18);
        float slot = w / n, barW = Math.min(dp(28), slot * 0.62f);
        float max = 0;
        for (float v : values) max = Math.max(max, v);
        if (max <= 0) max = 1;
        paint.setColor(baseColor);
        paint.setStrokeWidth(dp(1));
        canvas.drawLine(0, bottom, w, bottom, paint);
        paint.setTextAlign(Paint.Align.CENTER);
        for (int i = 0; i < n; i++) {
            float cx = slot * i + slot / 2;
            float bh = values[i] <= 0 ? 0 : Math.max(dp(3), (values[i] / max) * (bottom - top));
            if (bh > 0) {
                paint.setColor(selected < 0 || i == selected ? barColor : softColor);
                rect.set(cx - barW / 2, bottom - bh, cx + barW / 2, bottom);
                float r = Math.min(dp(5), barW / 2);
                canvas.drawRoundRect(rect, r, r, paint);
                canvas.drawRect(cx - barW / 2, bottom - Math.min(bh, r), cx + barW / 2, bottom, paint); // square base
            }
            if (labels[i] != null && !labels[i].isEmpty()) {
                paint.setColor(textColor);
                paint.setTextSize(sp(11));
                paint.setFakeBoldText(i == selected);
                canvas.drawText(labels[i], cx, h - sp(4), paint);
            }
            if (i == selected && tips[i] != null) {
                paint.setColor(textColor);
                paint.setTextSize(sp(12));
                paint.setFakeBoldText(true);
                float y = Math.max(sp(13), bottom - bh - sp(5));
                canvas.drawText(tips[i], Math.max(sp(20), Math.min(w - sp(20), cx)), y, paint);
            }
        }
        paint.setFakeBoldText(false);
    }

    @Override
    public boolean onTouchEvent(MotionEvent e) {
        if (e.getAction() == MotionEvent.ACTION_UP && values.length > 0) {
            int i = (int) Math.min(values.length - 1, Math.max(0, e.getX() / (getWidth() / (float) values.length)));
            selected = i;
            invalidate();
            if (listener != null) listener.onTap(i);
            performClick();
            return true;
        }
        return e.getAction() == MotionEvent.ACTION_DOWN || super.onTouchEvent(e);
    }

    @Override
    public boolean performClick() {
        return super.performClick();
    }
}
