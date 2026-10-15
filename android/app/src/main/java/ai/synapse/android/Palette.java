package ai.synapse.android;

import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Color;

/** Synapse colours for light and dark mode (same palette as the website). */
final class Palette {
    final boolean night;
    final int bg, surface, surface2, ink, ink2, muted, line, lichen, lichenSoft, dusk, amber, berry, chartFocus;

    private Palette(boolean night) {
        this.night = night;
        if (night) {
            bg = c("#10181E"); surface = c("#18232B"); surface2 = c("#1F2C35"); ink = c("#E4ECEF"); ink2 = c("#A9B8C0");
            muted = c("#7E8E97"); line = c("#2C3B45"); lichen = c("#7DBE93"); lichenSoft = c("#1E3328"); dusk = c("#A99BDB");
            amber = c("#E0A84A"); berry = c("#E07D8E"); chartFocus = c("#46A86B");
        } else {
            bg = c("#EEF2F3"); surface = c("#FFFFFF"); surface2 = c("#E3E9EB"); ink = c("#1C2A33"); ink2 = c("#4A5B66");
            muted = c("#74838C"); line = c("#CDD6DA"); lichen = c("#3F7355"); lichenSoft = c("#DCEADF"); dusk = c("#6A5A99");
            amber = c("#B0761A"); berry = c("#A33A4C"); chartFocus = c("#2F8A57");
        }
    }

    static Palette of(Context ctx) {
        int mode = ctx.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return new Palette(mode == Configuration.UI_MODE_NIGHT_YES);
    }

    /** Colour for a Synapse category, matching the website's chart. */
    int category(String cat) {
        if (cat == null) return muted;
        switch (cat) {
            case "work": return lichen;
            case "study": return dusk;
            case "communication": return c(night ? "#6FA8C9" : "#4C86A8");
            case "social": return berry;
            case "entertainment": return amber;
            case "games": return c(night ? "#D58BB5" : "#B15E8F");
            case "news": return c(night ? "#A9B65F" : "#7C8A3C");
            default: return muted;
        }
    }

    private static int c(String hex) {
        return Color.parseColor(hex);
    }
}
