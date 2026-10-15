package ai.synapse.android.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.junit.Test;

public class PayloadTest {
    private static final Payload.AppLookup LOOKUP = pkg -> {
        switch (pkg) {
            case "com.instagram.android": return new Payload.AppInfo("Instagram", AppCategories.forApp(pkg, AppCategories.CATEGORY_SOCIAL));
            case "com.instagram.lite": return new Payload.AppInfo("Instagram", "social");
            case "com.weird": return new Payload.AppInfo("Say \"hi\"\n", "other");
            default: return new Payload.AppInfo(null, AppCategories.forApp(pkg, AppCategories.CATEGORY_UNDEFINED));
        }
    };

    private static Map<String, Map<String, Long>> usage() {
        Map<String, Map<String, Long>> u = new TreeMap<>();
        Map<String, Long> day = new TreeMap<>();
        day.put("com.instagram.android", 30 * 60_000L);
        day.put("com.instagram.lite", 6 * 60_000L);   // same label -> merged
        day.put("com.example.tool", 90_000L);          // no label -> package name
        day.put("com.blink", 1_000L);                  // 1 s -> dropped
        day.put("com.weird", 60_000L);
        u.put("2026-10-15", day);
        return u;
    }

    @Test
    public void mergesByLabelDropsTinyAndSorts() {
        List<Payload.Entry> e = Payload.entries(usage(), LOOKUP).get("2026-10-15");
        assertEquals(3, e.size());
        assertEquals("Instagram", e.get(0).app);
        assertEquals(36.0, e.get(0).minutes, 1e-9);
        assertEquals("social", e.get(0).category);
        assertEquals("com.example.tool", e.get(1).app);
        assertEquals(1.5, e.get(1).minutes, 1e-9);
    }

    @Test
    public void jsonMatchesTheServerFormatAndEscapes() {
        String json = Payload.toJson(Payload.entries(usage(), LOOKUP));
        assertTrue(json, json.startsWith("{\"days\":[{\"day\":\"2026-10-15\",\"entries\":[{\"app\":\"Instagram\",\"category\":\"social\",\"minutes\":36.00}"));
        assertTrue(json, json.contains("\"app\":\"Say \\\"hi\\\"\""));
        assertTrue(json, json.endsWith("]}]}"));
    }

    @Test
    public void categoriesFromKnownPackagesAndPlayStore() {
        assertEquals("communication", AppCategories.forApp("com.whatsapp", AppCategories.CATEGORY_UNDEFINED));
        assertEquals("entertainment", AppCategories.forApp("com.google.android.youtube", AppCategories.CATEGORY_VIDEO));
        assertEquals("games", AppCategories.forApp("com.some.game", AppCategories.CATEGORY_GAME));
        assertEquals("work", AppCategories.forApp("com.some.notes", AppCategories.CATEGORY_PRODUCTIVITY));
        assertEquals("other", AppCategories.forApp("com.some.app", AppCategories.CATEGORY_MAPS));
    }
}
