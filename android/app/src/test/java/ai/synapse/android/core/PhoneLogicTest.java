package ai.synapse.android.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.Test;

public class PhoneLogicTest {
    private static final ZoneId IST = ZoneId.of("Asia/Kolkata");

    @Test
    public void appKeyMatchesServerRule() {
        assertEquals("instagram", PhoneLogic.appKey("Instagram"));
        assertEquals("instagram", PhoneLogic.appKey("https://www.instagram.com/feed"));
        assertEquals("youtube", PhoneLogic.appKey("YouTube"));
        assertEquals("bbc", PhoneLogic.appKey("bbc.co.uk"));
        assertEquals("vscode", PhoneLogic.appKey("VS Code"));
    }

    @Test
    public void limitAlertsAt80And100OncePerDay() {
        List<PhoneLogic.Limit> limits = Arrays.asList(new PhoneLogic.Limit("instagram.com", 45), new PhoneLogic.Limit("YouTube", 60), new PhoneLogic.Limit("Netflix", 30));
        Map<String, Double> used = new HashMap<>();
        used.put("Instagram", 38.0);   // 84% -> 80% alert
        used.put("YouTube", 61.5);     // over -> 100% alert only
        used.put("Netflix", 10.0);     // fine
        Set<String> sent = new HashSet<>();
        List<PhoneLogic.Alert> a = PhoneLogic.limitAlerts(limits, used, sent);
        assertEquals(2, a.size());
        assertEquals(80, a.get(0).level);
        assertEquals("7 min left on instagram.com today", a.get(0).title());
        assertEquals(100, a.get(1).level);
        assertEquals("YouTube: daily limit reached", a.get(1).title());
        for (PhoneLogic.Alert x : a) sent.add(x.key + "|" + x.level);
        assertTrue(PhoneLogic.limitAlerts(limits, used, sent).isEmpty());   // no repeats
        used.put("Instagram", 46.0);
        List<PhoneLogic.Alert> b = PhoneLogic.limitAlerts(limits, used, sent);
        assertEquals(1, b.size());
        assertEquals(100, b.get(0).level);
    }

    @Test
    public void timerCountdownAndSessionJson() {
        long start = LocalDate.of(2026, 10, 15).atTime(9, 0).atZone(IST).toInstant().toEpochMilli();
        PhoneLogic.Timer t = new PhoneLogic.Timer("focus", 25, start, "Thesis");
        assertEquals("25:00", t.countdown(start));
        assertEquals("24:59", t.countdown(start + 1000));
        assertEquals("00:00", t.countdown(start + 26 * 60_000L));
        assertTrue(t.done(t.endsAt));
        assertEquals(0.5, t.progress(start + 750_000L), 1e-9);
        assertEquals("{\"kind\":\"focus\",\"plannedMin\":25,\"actualMin\":25.00,\"completed\":true,\"tag\":\"Thesis\","
                + "\"day\":\"2026-10-15\",\"startedAt\":\"2026-10-15T09:00:00\",\"endedAt\":\"2026-10-15T09:25:00\"}",
                t.sessionJson(t.endsAt + 5000, true, IST));
        String partial = t.sessionJson(start + 12 * 60_000L + 30_000L, false, IST);
        assertTrue(partial, partial.contains("\"actualMin\":12.50") && partial.contains("\"completed\":false") && partial.contains("\"endedAt\":\"2026-10-15T09:12:30\""));
    }

    @Test
    public void timerSurvivesSaveAndRestore() {
        PhoneLogic.Timer t = new PhoneLogic.Timer("break", 5, 1_000_000L, "with | pipe");
        PhoneLogic.Timer back = PhoneLogic.Timer.parse(t.serialize());
        assertEquals("break", back.mode);
        assertEquals(5, back.plannedMin);
        assertEquals(1_000_000L, back.startedAt);
        assertEquals("with | pipe", back.tag);
        assertNull(PhoneLogic.Timer.parse("garbage"));
        assertNull(PhoneLogic.Timer.parse(""));
    }

    @Test
    public void connectLinkFromQrCode() {
        PhoneLogic.ConnectInfo c = PhoneLogic.parseConnectLink("synapse://connect?server=https%3A%2F%2Fsynapse-ai.onrender.com&key=syn_abc-123_XY");
        assertEquals("https://synapse-ai.onrender.com", c.server);
        assertEquals("syn_abc-123_XY", c.key);
        String[] bad = {"https://example.com", "synapse://connect?server=https%3A%2F%2Fx.com", "synapse://connect?key=syn_x", "synapse://other?server=a&key=syn_x", "not a link"};
        for (String b : bad) {
            boolean threw = false;
            try {
                PhoneLogic.parseConnectLink(b);
            } catch (IllegalArgumentException e) {
                threw = true;
            }
            assertTrue("should reject " + b, threw);
        }
    }

    @Test
    public void bedtimeWindowAndMinutes() {
        assertTrue(PhoneLogic.inBedtimeWindow(23, 23));
        assertTrue(PhoneLogic.inBedtimeWindow(1, 23));
        assertFalse(PhoneLogic.inBedtimeWindow(22, 23));
        assertFalse(PhoneLogic.inBedtimeWindow(6, 23));
        assertTrue(PhoneLogic.inBedtimeWindow(0, 0));     // midnight bedtime
        assertFalse(PhoneLogic.inBedtimeWindow(23, 0));
        long[] today = new long[24], yesterday = new long[24];
        yesterday[23] = 20 * 60_000L;
        today[0] = 15 * 60_000L;
        today[22] = 30 * 60_000L;
        assertEquals(35.0, PhoneLogic.minutesSinceBedtime(today, yesterday, 0, 23), 1e-9); // 12:xx am: last night + now
        assertEquals(0.0, PhoneLogic.minutesSinceBedtime(today, yesterday, 22, 23), 1e-9); // before bedtime
        long now = 10_000_000_000L;
        assertTrue(PhoneLogic.shouldNudge(true, 0, 23, 35, now, 0));
        assertFalse(PhoneLogic.shouldNudge(true, 0, 23, 35, now, now - 10 * 60_000L));      // nudged 10 min ago
        assertFalse(PhoneLogic.shouldNudge(false, 0, 23, 35, now, 0));                       // switched off
        assertFalse(PhoneLogic.shouldNudge(true, 0, 23, 5, now, 0));                         // only 5 min
        assertEquals("11 pm", PhoneLogic.hourLabel(23));
        assertEquals("12 am", PhoneLogic.hourLabel(0));
    }

    @Test
    public void miniJsonReadsServerReplies() {
        Map<String, Object> m = MiniJson.obj(MiniJson.parse("{\"limits\":[{\"app\":\"Insta \\\"gram\\\"\",\"minutes\":45}],\"ok\":true,\"x\":null,\"n\":-1.5e2,\"u\":\"\\u00e9\"}"));
        Map<String, Object> first = MiniJson.obj(MiniJson.arr(m.get("limits")).get(0));
        assertEquals("Insta \"gram\"", MiniJson.str(first, "app"));
        assertEquals(45.0, MiniJson.num(first, "minutes", 0), 1e-9);
        assertTrue(MiniJson.bool(m, "ok"));
        assertNull(m.get("x"));
        assertEquals(-150.0, MiniJson.num(m, "n", 0), 1e-9);
        assertEquals("é", MiniJson.str(m, "u"));
        boolean threw = false;
        try {
            MiniJson.parse("{\"a\":1,}");
        } catch (IllegalArgumentException e) {
            threw = true;
        }
        assertTrue(threw);
    }
}
