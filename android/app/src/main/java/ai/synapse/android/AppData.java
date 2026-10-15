package ai.synapse.android;

import android.content.Context;

import ai.synapse.android.core.MiniJson;
import ai.synapse.android.core.SynapseApi;

import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** What the app shows from your Synapse account: tasks, goal, suggestion, insights, level and badges. */
final class AppData {
    static final class Task {
        final long id;
        final String title;
        final int estimate, blocksDone;
        final boolean done;

        Task(Map<String, Object> m) {
            id = (long) MiniJson.num(m, "id", 0);
            title = String.valueOf(MiniJson.str(m, "title"));
            estimate = (int) MiniJson.num(m, "estimate", 1);
            blocksDone = (int) MiniJson.num(m, "blocksDone", 0);
            done = MiniJson.num(m, "done", 0) > 0;
        }
    }

    static final class Badge {
        final String code, title, desc;
        final boolean earned;

        Badge(Map<String, Object> m) {
            code = MiniJson.str(m, "code");
            title = MiniJson.str(m, "title");
            desc = MiniJson.str(m, "desc");
            earned = MiniJson.str(m, "achievedAt") != null;
        }
    }

    final List<Task> tasks = new ArrayList<>();
    final List<Badge> badges = new ArrayList<>();
    final List<String> patterns = new ArrayList<>();
    final List<String> patternBasis = new ArrayList<>();
    final List<int[]> trend = new ArrayList<>(); // [score]
    int goalMin = 120, suggestMin = 0;
    String suggestReason, warning, warningLevel, levelTitle, nextLevelTitle, focusNext, insightsError;
    int level = 1, points, nextLevelAt = 100, streak, trees;
    double levelProgress;
    // weekly review
    int weekFocusMin, activeDays, tasksDone, todayFocusMin;
    Integer screenAvgMin;
    Double sleepAvg, focusChange, screenChange;
    String bestDay, topDistraction;

    /** Blocking: call from a background thread. Missing pieces (e.g. insights switched off) are skipped. */
    static AppData load(Context c) throws SynapseApi.ApiException {
        SynapseApi api = new SynapseApi(Prefs.server(c), Prefs.key(c));
        String day = LocalDate.now().toString();
        AppData d = new AppData();
        for (Object o : MiniJson.arr(api.app("GET", "/tasks?day=" + day, null))) d.tasks.add(new Task(MiniJson.obj(o)));

        Map<String, Object> prefs = MiniJson.obj(api.app("GET", "/prefs", null));
        d.goalMin = (int) MiniJson.num(prefs, "dailyGoalMin", 120);

        Map<String, Object> s = MiniJson.obj(api.app("GET", "/suggest-block?day=" + day + "&hour=" + LocalTime.now().getHour(), null));
        d.suggestMin = (int) MiniJson.num(s, "minutes", 25);
        d.suggestReason = MiniJson.str(s, "reason");

        Map<String, Object> r = MiniJson.obj(api.app("GET", "/rewards", null));
        d.level = (int) MiniJson.num(r, "level", 1);
        d.points = (int) MiniJson.num(r, "points", 0);
        d.nextLevelAt = (int) MiniJson.num(r, "nextLevelAt", 100);
        d.levelProgress = MiniJson.num(r, "progress", 0);
        d.levelTitle = MiniJson.str(r, "levelTitle");
        d.nextLevelTitle = MiniJson.str(r, "nextLevelTitle");
        d.streak = (int) MiniJson.num(r, "currentStreak", 0);
        d.trees = (int) MiniJson.num(r, "trees", 0);
        for (Object o : MiniJson.arr(r.get("milestones"))) d.badges.add(new Badge(MiniJson.obj(o)));
        Prefs.saveSummary(c, d.points, d.level, d.streak, d.trees);

        Map<String, Object> rv = MiniJson.obj(api.app("GET", "/review?day=" + day, null));
        d.weekFocusMin = (int) MiniJson.num(rv, "focusMin", 0);
        d.activeDays = (int) MiniJson.num(rv, "activeDays", 0);
        d.tasksDone = (int) MiniJson.num(rv, "tasksDone", 0);
        d.focusNext = MiniJson.str(rv, "focusNext");
        d.screenAvgMin = rv.get("screenAvgMin") == null ? null : (int) MiniJson.num(rv, "screenAvgMin", 0);
        d.sleepAvg = rv.get("sleepAvg") == null ? null : MiniJson.num(rv, "sleepAvg", 0);
        d.focusChange = rv.get("focusChange") == null ? null : MiniJson.num(rv, "focusChange", 0);
        d.screenChange = rv.get("screenChange") == null ? null : MiniJson.num(rv, "screenChange", 0);
        Map<String, Object> best = MiniJson.obj(rv.get("bestDay"));
        d.bestDay = MiniJson.str(best, "day");
        d.topDistraction = MiniJson.str(MiniJson.obj(rv.get("topDistraction")), "label");
        for (Object o : MiniJson.arr(rv.get("days"))) {
            Map<String, Object> x = MiniJson.obj(o);
            if (day.equals(MiniJson.str(x, "day"))) d.todayFocusMin = (int) MiniJson.num(x, "focusMin", 0);
        }

        Map<String, Object> pt = MiniJson.obj(api.app("GET", "/patterns?day=" + day, null));
        for (Object o : MiniJson.arr(pt.get("findings"))) {
            Map<String, Object> f = MiniJson.obj(o);
            d.patterns.add(MiniJson.str(f, "text"));
            d.patternBasis.add(MiniJson.str(f, "basedOn"));
        }

        try {
            Map<String, Object> tr = MiniJson.obj(api.app("GET", "/insights/trend?day=" + day, null));
            for (Object o : MiniJson.arr(tr.get("points"))) d.trend.add(new int[]{(int) MiniJson.num(MiniJson.obj(o), "score", 0)});
            Map<String, Object> w = MiniJson.obj(tr.get("warning"));
            d.warning = MiniJson.str(w, "text");
            d.warningLevel = MiniJson.str(w, "level");
        } catch (SynapseApi.ApiException e) {
            d.insightsError = e.status == 403 ? "Turn on \"AI wellbeing insights\" in Synapse > Privacy to see your load score and early warnings." : e.getMessage();
        }
        return d;
    }

    List<Task> openTasks() {
        List<Task> out = new ArrayList<>();
        for (Task t : tasks) if (!t.done) out.add(t);
        return out;
    }
}
