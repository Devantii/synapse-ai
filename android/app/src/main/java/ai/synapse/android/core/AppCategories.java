package ai.synapse.android.core;

import java.util.HashMap;
import java.util.Map;

/**
 * Maps an Android app to a Synapse category: work, study, communication, social, entertainment,
 * games, news or other. Known packages win; otherwise the app's own Play Store category is used.
 */
public final class AppCategories {

    // Values of android.content.pm.ApplicationInfo.CATEGORY_* (stable public API values).
    public static final int CATEGORY_UNDEFINED = -1;
    public static final int CATEGORY_GAME = 0;
    public static final int CATEGORY_AUDIO = 1;
    public static final int CATEGORY_VIDEO = 2;
    public static final int CATEGORY_IMAGE = 3;
    public static final int CATEGORY_SOCIAL = 4;
    public static final int CATEGORY_NEWS = 5;
    public static final int CATEGORY_MAPS = 6;
    public static final int CATEGORY_PRODUCTIVITY = 7;

    private static final Map<String, String> KNOWN = new HashMap<>();

    private static void put(String category, String... packages) {
        for (String p : packages) KNOWN.put(p, category);
    }

    static {
        put("social", "com.instagram.android", "com.instagram.barcelona", "com.facebook.katana", "com.facebook.lite",
                "com.twitter.android", "com.zhiliaoapp.musically", "com.ss.android.ugc.trill", "com.snapchat.android",
                "com.reddit.frontpage", "com.linkedin.android", "com.pinterest", "in.mohalla.sharechat", "com.tumblr",
                "com.bsky.app", "org.joinmastodon.android", "com.quora.android");
        put("communication", "com.whatsapp", "com.whatsapp.w4b", "org.telegram.messenger", "com.google.android.gm",
                "com.microsoft.office.outlook", "com.Slack", "com.discord", "com.google.android.apps.messaging",
                "us.zoom.videomeetings", "com.google.android.apps.meetings", "com.microsoft.teams", "com.facebook.orca",
                "org.thoughtcrime.securesms", "com.samsung.android.messaging", "com.google.android.dialer");
        put("entertainment", "com.google.android.youtube", "com.google.android.apps.youtube.music", "com.netflix.mediaclient",
                "com.amazon.avod.thirdpartyclient", "in.startv.hotstar", "com.spotify.music", "com.jio.media.jiobeats",
                "com.graymatrix.did", "com.sonyliv", "com.mxtech.videoplayer.ad", "tv.twitch.android.app",
                "com.jio.jioplay.tv", "com.disney.disneyplus", "com.crunchyroll.crunchyroid");
        put("news", "com.google.android.apps.magazines", "com.nis.app", "com.toi.reader.activities", "com.ndtv.india",
                "com.htmedia.mint", "bbc.mobile.news.ww", "com.cnn.mobile.android.phone", "com.guardian", "com.nytimes.android");
        put("work", "com.google.android.apps.docs", "com.google.android.apps.docs.editors.docs",
                "com.google.android.apps.docs.editors.sheets", "com.google.android.apps.docs.editors.slides",
                "com.microsoft.office.word", "com.microsoft.office.excel", "com.microsoft.office.powerpoint",
                "com.microsoft.office.officehubrow", "notion.id", "com.github.android", "com.atlassian.android.jira.core",
                "com.google.android.calendar", "com.todoist", "com.trello", "com.asana.app", "com.figma.mirror",
                "com.google.android.keep", "com.openai.chatgpt", "com.anthropic.claude");
        put("study", "com.duolingo", "org.coursera.android", "com.udemy.android", "org.khanacademy.android",
                "com.google.android.apps.classroom", "org.wikipedia", "com.byjus.thelearningapp", "com.unacademyapp",
                "com.amazon.kindle", "com.google.android.apps.books", "com.quizlet.quizletandroid");
        put("games", "com.supercell.clashofclans", "com.supercell.clashroyale", "com.pubg.imobile", "com.dts.freefireth",
                "com.king.candycrushsaga", "com.chess", "org.lichess.mobileapp", "com.roblox.client", "com.mojang.minecraftpe");
    }

    private AppCategories() {}

    /** @param androidCategory ApplicationInfo.category, or CATEGORY_UNDEFINED if unknown */
    public static String forApp(String pkg, int androidCategory) {
        String known = KNOWN.get(pkg);
        if (known != null) return known;
        switch (androidCategory) {
            case CATEGORY_GAME: return "games";
            case CATEGORY_AUDIO:
            case CATEGORY_VIDEO: return "entertainment";
            case CATEGORY_SOCIAL: return "social";
            case CATEGORY_NEWS: return "news";
            case CATEGORY_PRODUCTIVITY: return "work";
            default: return "other";
        }
    }
}
