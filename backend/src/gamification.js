// Points, levels, streaks, trees and milestones.
// Design intent: reward *healthy* focus (completed sessions AND taken breaks),
// never raw screen time, and cap daily points so grinding isn't incentivised.
const db = require('./db');

const DAILY_POINT_CAP = 400;

const MILESTONES = [
  { code: 'first_focus', title: 'First seed', desc: 'Complete your first focus session.' },
  { code: 'first_break', title: 'Pause button', desc: 'Take your first restorative break.' },
  { code: 'trees_5', title: 'Grove', desc: 'Grow 5 trees.' },
  { code: 'trees_25', title: 'Forest keeper', desc: 'Grow 25 trees.' },
  { code: 'streak_3', title: 'Rhythm', desc: 'Focus 3 days in a row.' },
  { code: 'streak_7', title: 'Steady week', desc: 'Focus 7 days in a row.' },
  { code: 'level_5', title: 'Rooted', desc: 'Reach level 5.' },
  { code: 'balanced_day', title: 'Balanced day', desc: 'Pair 4 focus sessions with 3+ breaks in one day.' },
  { code: 'first_post', title: 'Kind voice', desc: 'Share a check-in with the community.' },
  { code: 'usage_logged', title: 'Honest mirror', desc: 'Log your screen time for a day.' },
  // v1.9: more badges (checked whenever your rewards are read)
  { code: 'streak_30', title: 'Evergreen', desc: 'Focus 30 days in a row.' },
  { code: 'level_10', title: 'Old growth', desc: 'Reach level 10.' },
  { code: 'trees_100', title: 'Woodland', desc: 'Grow 100 trees.' },
  { code: 'early_bird', title: 'Early bird', desc: 'Finish a focus block that started before 8 am.' },
  { code: 'tasks_10', title: 'Finisher', desc: 'Complete 10 tasks.' },
  { code: 'distraction_aware', title: 'Self-aware', desc: 'Notice and log 10 distractions.' },
  { code: 'room_hour', title: 'Study buddy', desc: 'Spend an hour in focus rooms.' },
  { code: 'room_10h', title: 'Regular', desc: 'Spend 10 hours in focus rooms.' },
  { code: 'first_reply', title: 'Good neighbour', desc: 'Reply kindly to someone\'s check-in.' },
  { code: 'cheer_5', title: 'Cheerleader', desc: 'Send 5 cheers or nudges to buddies.' },
  { code: 'buddy', title: 'Accountable', desc: 'Pair up with an accountability buddy.' },
  { code: 'goal_met', title: 'Goal getter', desc: 'Reach your daily focus goal.' },
  { code: 'rested', title: 'Rest is part of it', desc: 'Plan a rest day and keep your streak.' },
];

// Level names (shown next to your name in the community).
const LEVEL_TITLES = ['Seedling', 'Sprout', 'Sapling', 'Young tree', 'Rooted', 'Branching', 'Canopy', 'Old growth', 'Grove keeper', 'Forest guardian'];
const levelTitle = (level) => LEVEL_TITLES[Math.min(LEVEL_TITLES.length, Math.max(1, level)) - 1];

/** Badges earned from activity outside the timer (tasks, rooms, community). Cheap counts; safe to run often. */
async function checkBadges(userId) {
  const one = async (sql, p = [userId]) => Number((await db.get(sql, p))?.n || 0);
  const r = await ensureRow(userId);
  const checks = [
    ['streak_30', r.best_streak >= 30], ['level_10', levelFor(r.points).level >= 10], ['trees_100', r.trees >= 100],
    ['early_bird', async () => (await one("SELECT COUNT(*) AS n FROM focus_sessions WHERE user_id = ? AND kind = 'focus' AND completed = 1 AND sample = 0 AND substr(started_at, 12, 2) < '08'")) > 0],
    ['tasks_10', async () => (await one('SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND done = 1 AND sample = 0')) >= 10],
    ['distraction_aware', async () => (await one('SELECT COUNT(*) AS n FROM distractions WHERE user_id = ? AND sample = 0')) >= 10],
    ['room_hour', async () => (await one('SELECT COALESCE(SUM(seconds), 0) AS n FROM room_visits WHERE user_id = ?')) >= 3600],
    ['room_10h', async () => (await one('SELECT COALESCE(SUM(seconds), 0) AS n FROM room_visits WHERE user_id = ?')) >= 36000],
    ['first_reply', async () => (await one('SELECT COUNT(*) AS n FROM post_replies WHERE user_id = ?')) > 0],
    ['cheer_5', async () => (await one('SELECT COUNT(*) AS n FROM cheers WHERE from_id = ?')) >= 5],
    ['buddy', async () => (await one("SELECT COUNT(*) AS n FROM buddies WHERE (requester_id = ? OR addressee_id = ?) AND status = 'accepted'", [userId, userId])) > 0],
    ['rested', async () => (await one('SELECT COUNT(*) AS n FROM rest_days WHERE user_id = ?')) > 0],
    ['goal_met', async () => {
      const goal = Number((await db.get('SELECT daily_goal_min FROM user_prefs WHERE user_id = ?', [userId]))?.daily_goal_min || 120);
      return !!(await db.get(`SELECT day FROM focus_sessions WHERE user_id = ? AND kind = 'focus' AND completed = 1 AND sample = 0
        GROUP BY day HAVING SUM(actual_min) >= ? LIMIT 1`, [userId, goal]));
    }],
  ];
  const have = new Set((await db.all('SELECT code FROM milestones WHERE user_id = ?', [userId])).map((m) => m.code));
  const out = [];
  for (const [code, test] of checks) {
    if (have.has(code)) continue;
    if (typeof test === 'function' ? await test() : test) await grant(userId, code, out);
  }
  return out;
}

/** Public level for a batch of users: { id: { level, title, badges } }. */
async function publicLevels(ids) {
  const uniq = [...new Set(ids.filter((x) => Number.isInteger(x)))];
  if (!uniq.length) return {};
  const marks = uniq.map(() => '?').join(',');
  const pts = await db.all(`SELECT user_id, points FROM rewards WHERE user_id IN (${marks})`, uniq);
  const badges = await db.all(`SELECT user_id, COUNT(*) AS n FROM milestones WHERE user_id IN (${marks}) GROUP BY user_id`, uniq);
  const out = {};
  for (const id of uniq) {
    const p = pts.find((r) => r.user_id === id)?.points || 0;
    const level = levelFor(p).level;
    out[id] = { level, title: levelTitle(level), badges: Number(badges.find((r) => r.user_id === id)?.n || 0) };
  }
  return out;
}

function levelFor(points) {
  // Level n needs 50*n*(n-1) points total: 0, 100, 300, 600, 1000...
  const level = Math.floor((1 + Math.sqrt(1 + (8 * points) / 100)) / 2);
  const cur = 50 * level * (level - 1);
  const next = 50 * (level + 1) * level;
  return { level, levelFloor: cur, nextLevelAt: next, progress: (points - cur) / (next - cur) };
}

function speciesFor(minutes) {
  if (minutes >= 50) return 'oak';
  if (minutes >= 40) return 'cedar';
  if (minutes >= 30) return 'maple';
  return 'sapling';
}

async function ensureRow(userId, q = db, lock = false) {
  await q.run('INSERT INTO rewards (user_id) VALUES (?) ON CONFLICT DO NOTHING', [userId]);
  return q.get('SELECT * FROM rewards WHERE user_id = ?' + (lock ? db.forUpdate : ''), [userId]);
}

function dayDiff(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/** Record a milestone once; pushes it to `out` if it's new. Pass the transaction handle as `q` inside a tx. */
async function grant(userId, code, out, q = db) {
  const r = await q.run('INSERT INTO milestones (user_id, code) VALUES (?, ?) ON CONFLICT DO NOTHING', [userId, code]);
  if (r.changes) out.push(MILESTONES.find((m) => m.code === code));
}

function pointsForSession({ kind, actual_min, completed }) {
  if (kind === 'break') return completed ? 5 : 0;
  if (completed) return Math.round(actual_min) + 10;
  return actual_min >= 5 ? Math.floor(actual_min / 2) : 0;
}

async function pointsEarnedToday(userId, day, q) {
  // Recompute from sessions on that local day so the cap is robust.
  const rows = await q.all('SELECT kind, actual_min, completed FROM focus_sessions WHERE user_id = ? AND day = ? AND sample = 0', [userId, day]);
  return rows.reduce((s, r) => s + pointsForSession(r), 0);
}

/**
 * Save a session and apply its rewards in one transaction. `day` is the user's local YYYY-MM-DD.
 * Returns the new session id plus what changed so the UI can celebrate it.
 */
function recordSession(userId, session) {
  return db.tx(async (t) => {
    // Lock this user's rewards row first so parallel saves are applied one after another.
    const before = await ensureRow(userId, t, true);
    const id = await t.insert(
      `INSERT INTO focus_sessions (user_id, kind, planned_min, actual_min, completed, tag, day, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, session.kind, session.planned_min, session.actual_min, session.completed, session.tag, session.day, session.started_at, session.ended_at]
    );
    const day = session.day;
    const already = (await pointsEarnedToday(userId, day, t)) - pointsForSession(session); // session already inserted
    let earned = pointsForSession(session);
    const room = Math.max(0, DAILY_POINT_CAP - already);
    const capped = earned > room;
    earned = Math.min(earned, room);

    const newMilestones = [];
    let tree = null;
    let { current_streak, best_streak, last_focus_day, trees } = before;

    if (session.kind === 'focus' && session.completed) {
      if (last_focus_day !== day) {
        const gap = last_focus_day ? dayDiff(last_focus_day, day) : null;
        // Planned rest days in between don't break the streak (rest is part of the plan).
        let bridged = false;
        if (gap > 1) {
          const rest = await t.get('SELECT COUNT(*) AS n FROM rest_days WHERE user_id = ? AND day > ? AND day < ?', [userId, last_focus_day, day]);
          bridged = Number(rest.n) === gap - 1;
        }
        current_streak = gap === 1 || bridged ? current_streak + 1 : gap !== null && gap <= 0 ? current_streak : 1;
        last_focus_day = gap !== null && gap < 0 ? last_focus_day : day;
      }
      best_streak = Math.max(best_streak, current_streak);
      if (session.actual_min >= 20) {
        const species = speciesFor(session.actual_min);
        tree = { id: await t.insert('INSERT INTO trees (user_id, species) VALUES (?, ?)', [userId, species]), species };
        trees += 1;
      }
      await grant(userId, 'first_focus', newMilestones, t);
    }
    if (session.kind === 'break' && session.completed) await grant(userId, 'first_break', newMilestones, t);

    const points = before.points + earned;
    await t.run(
      'UPDATE rewards SET points = ?, trees = ?, current_streak = ?, best_streak = ?, last_focus_day = ? WHERE user_id = ?',
      [points, trees, current_streak, best_streak, last_focus_day, userId]
    );

    if (trees >= 5) await grant(userId, 'trees_5', newMilestones, t);
    if (trees >= 25) await grant(userId, 'trees_25', newMilestones, t);
    if (current_streak >= 3) await grant(userId, 'streak_3', newMilestones, t);
    if (current_streak >= 7) await grant(userId, 'streak_7', newMilestones, t);
    if (levelFor(points).level >= 5) await grant(userId, 'level_5', newMilestones, t);

    const today = await t.get(
      `SELECT SUM(CASE WHEN kind = 'focus' AND completed = 1 THEN 1 ELSE 0 END) AS f,
              SUM(CASE WHEN kind = 'break' AND completed = 1 THEN 1 ELSE 0 END) AS b
         FROM focus_sessions WHERE user_id = ? AND day = ? AND sample = 0`,
      [userId, day]
    );
    if ((today.f || 0) >= 4 && (today.b || 0) >= 3) await grant(userId, 'balanced_day', newMilestones, t);

    const leveledUp = levelFor(points).level > levelFor(before.points).level;
    return { id, earned, capped, tree, newMilestones, leveledUp };
  });
}

async function summary(userId) {
  await checkBadges(userId).catch((e) => console.error('[badges]', e.message));
  const r = await ensureRow(userId);
  const lvl = levelFor(r.points);
  const achieved = await db.all('SELECT code, achieved_at FROM milestones WHERE user_id = ?', [userId]);
  const map = Object.fromEntries(achieved.map((a) => [a.code, a.achieved_at]));
  const garden = await db.all('SELECT id, species, planted_at FROM trees WHERE user_id = ? ORDER BY id', [userId]);
  return {
    points: r.points,
    ...lvl,
    levelTitle: levelTitle(lvl.level),
    nextLevelTitle: levelTitle(lvl.level + 1),
    trees: r.trees,
    currentStreak: r.current_streak,
    bestStreak: r.best_streak,
    lastFocusDay: r.last_focus_day,
    dailyPointCap: DAILY_POINT_CAP,
    garden,
    milestones: MILESTONES.map((m) => ({ ...m, achievedAt: map[m.code] || null })),
  };
}

/**
 * What the garden would look like from the clearly marked sample sessions. Nothing is saved or granted:
 * it only lets a new account see trees, a level and badges before it has its own history.
 */
async function samplePreview(userId) {
  const rows = await db.all("SELECT kind, actual_min, completed, day, ended_at FROM focus_sessions WHERE user_id = ? AND sample = 1 ORDER BY started_at", [userId]);
  if (!rows.length) return null;
  const perDay = {};
  const garden = [];
  let n = 0;
  for (const r of rows) {
    perDay[r.day] = Math.min(DAILY_POINT_CAP, (perDay[r.day] || 0) + pointsForSession(r));
    if (r.kind === 'focus' && r.completed && r.actual_min >= 20) garden.push({ id: -(++n), species: speciesFor(r.actual_min), planted_at: String(r.ended_at).replace('T', ' ') + ':00', sample: true });
  }
  const points = Object.values(perDay).reduce((a, b) => a + b, 0);
  const days = [...new Set(rows.filter((r) => r.kind === 'focus' && r.completed).map((r) => r.day))].sort();
  let best = 0, cur = 0, prev = null;
  for (const d of days) { cur = prev && dayDiff(prev, d) === 1 ? cur + 1 : 1; best = Math.max(best, cur); prev = d; }
  const lvl = levelFor(points);
  const earned = new Set(['first_focus', 'first_break', 'usage_logged', 'tasks_10', 'distraction_aware', 'goal_met']);
  if (garden.length >= 5) earned.add('trees_5');
  if (garden.length >= 25) earned.add('trees_25');
  if (best >= 3) earned.add('streak_3');
  if (best >= 7) earned.add('streak_7');
  if (lvl.level >= 5) earned.add('level_5');
  const byDay = {};
  for (const r of rows) if (r.completed) { byDay[r.day] = byDay[r.day] || { f: 0, b: 0 }; byDay[r.day][r.kind === 'focus' ? 'f' : 'b']++; }
  if (Object.values(byDay).some((x) => x.f >= 4 && x.b >= 3)) earned.add('balanced_day');
  return {
    points, ...lvl, levelTitle: levelTitle(lvl.level), nextLevelTitle: levelTitle(lvl.level + 1),
    trees: garden.length, garden, currentStreak: cur, bestStreak: best,
    earned: [...earned],
  };
}

module.exports = { samplePreview, recordSession, summary, grant, levelFor, levelTitle, publicLevels, checkBadges, MILESTONES };
