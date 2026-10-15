package ai.synapse.android;

import java.util.HashMap;
import java.util.Map;

/** Interface language: English or Hindi. Exact-match lookup; text with numbers/names stays as is. */
final class Tr {
    private Tr() {}

    static String lang = "en";
    private static final Map<String, String> HI = new HashMap<>();

    private static void hi(String... pairs) {
        for (int i = 0; i + 1 < pairs.length; i += 2) HI.put(pairs[i], pairs[i + 1]);
    }

    static {
        hi("Today", "आज", "Week", "हफ़्ता", "Focus", "फ़ोकस", "Insights", "इनसाइट्स", "Settings", "सेटिंग्स",
           "Phone time today", "आज फ़ोन पर समय", "pickups", "बार फ़ोन उठाया", "first pickup", "पहली बार", "focus streak", "फ़ोकस स्ट्रीक",
           "Daily limits", "रोज़ की सीमाएँ", "Top apps today", "आज के टॉप ऐप", "Nothing yet today.", "आज अभी कुछ नहीं।", "Sync now", "अभी सिंक करें",
           "Syncing…", "सिंक हो रहा है…", "Last 7 days", "पिछले 7 दिन", "Apps", "ऐप", "Tap a day to see its details.", "किसी दिन पर टैप करें।",
           "Break", "ब्रेक", "Give up", "छोड़ दें", "End break", "ब्रेक खत्म करें", "Start focus", "फ़ोकस शुरू करें", "Start break", "ब्रेक शुरू करें",
           "How it works", "यह कैसे काम करता है", "points", "पॉइंट", "level", "लेवल", "streak", "स्ट्रीक", "trees", "पेड़",
           "Got distracted?", "ध्यान भटका?", "What pulled you away?", "ध्यान किसने भटकाया?", "Phone", "फ़ोन", "Social media", "सोशल मीडिया",
           "Messages", "मैसेज", "Wandering thoughts", "भटकते विचार", "Someone interrupted", "किसी ने टोका", "Noise", "शोर", "Tired or hungry", "थकान या भूख", "Other", "अन्य",
           "Daily focus goal", "रोज़ का फ़ोकस लक्ष्य", "Daily goal reached", "आज का लक्ष्य पूरा", "Today's tasks", "आज के काम", "Add task", "काम जोड़ें",
           "Focus on a task", "किसी काम पर फ़ोकस करें", "No task", "कोई काम नहीं", "Early warning", "पहली चेतावनी",
           "Your week in review", "आपका हफ़्ता", "Your personal patterns", "आपके निजी पैटर्न", "Badges", "बैज", "Load score, last 14 days", "लोड स्कोर, पिछले 14 दिन",
           "focused", "फ़ोकस किया", "days with focus", "फ़ोकस वाले दिन", "tasks done", "काम पूरे", "average sleep", "औसत नींद", "screen a day", "रोज़ स्क्रीन",
           "Synapse connection", "Synapse कनेक्शन", "Disconnect", "डिस्कनेक्ट", "Connect", "कनेक्ट करें", "Usage access", "यूसेज एक्सेस",
           "Reminders", "रिमाइंडर", "Daily limit alerts", "रोज़ की सीमा अलर्ट", "Bedtime nudge", "सोने का रिमाइंडर", "Home-screen widget", "होम-स्क्रीन विजेट",
           "Privacy", "प्राइवेसी", "Language", "भाषा", "Pause distracting apps during focus", "फ़ोकस के दौरान ध्यान भटकाने वाले ऐप रोकें",
           "Allow notifications", "नोटिफ़िकेशन की अनुमति दें", "Allow usage access", "यूसेज एक्सेस की अनुमति दें", "Connect to Synapse", "Synapse से कनेक्ट करें",
           "Set up connection", "कनेक्शन सेट करें", "Back to focus", "फ़ोकस पर लौटें", "End focus block", "फ़ोकस ब्लॉक खत्म करें",
           "Paused during focus", "फ़ोकस के दौरान रोका गया", "Open usage access settings", "यूसेज एक्सेस सेटिंग खोलें",
           "Turn on usage access", "यूसेज एक्सेस चालू करें", "Manage usage access", "यूसेज एक्सेस प्रबंधित करें", "Allow display over apps", "दूसरे ऐप के ऊपर दिखाने की अनुमति दें",
           "Connect Synapse to see insights.", "इनसाइट्स देखने के लिए Synapse से कनेक्ट करें।", "Loading…", "लोड हो रहा है…");
    }

    static String t(CharSequence s) {
        if (s == null) return null;
        String str = s.toString();
        if (!"hi".equals(lang)) return str;
        String hit = HI.get(str);
        return hit != null ? hit : str;
    }
}
