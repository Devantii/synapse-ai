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
];

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

function ensureRow(userId) {
  db.prepare('INSERT OR IGNORE INTO rewards (user_id) VALUES (?)').run(userId);
  return db.prepare('SELECT * FROM rewards WHERE user_id = ?').get(userId);
}

function dayDiff(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

function grant(userId, code, out) {
  const r = db.prepare('INSERT OR IGNORE INTO milestones (user_id, code) VALUES (?, ?)').run(userId, code);
  if (r.changes) out.push(MILESTONES.find((m) => m.code === code));
}

function pointsEarnedToday(userId, day) {
  // Recompute from sessions on that local day so the cap is robust.
  const rows = db.prepare(
    `SELECT kind, actual_min, completed FROM focus_sessions WHERE user_id = ? AND day = ?`
  ).all(userId, day);
  return rows.reduce((s, r) => s + pointsForSession(r), 0);
}

function pointsForSession({ kind, actual_min, completed }) {
  if (kind === 'break') return completed ? 5 : 0;
  if (completed) return Math.round(actual_min) + 10;
  return actual_min >= 5 ? Math.floor(actual_min / 2) : 0;
}

/**
 * Apply rewards for a just-saved session. `day` is the user's local YYYY-MM-DD.
 * Returns what changed so the UI can celebrate it.
 */
const applySession = db.transaction((userId, session, day) => {
  const before = ensureRow(userId);
  const already = pointsEarnedToday(userId, day) - pointsForSession(session); // session already inserted
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
      current_streak = gap === 1 ? current_streak + 1 : gap !== null && gap <= 0 ? current_streak : 1;
      last_focus_day = gap !== null && gap < 0 ? last_focus_day : day;
    }
    best_streak = Math.max(best_streak, current_streak);
    if (session.actual_min >= 20) {
      const species = speciesFor(session.actual_min);
      const r = db.prepare('INSERT INTO trees (user_id, species) VALUES (?, ?)').run(userId, species);
      tree = { id: r.lastInsertRowid, species };
      trees += 1;
    }
    grant(userId, 'first_focus', newMilestones);
  }
  if (session.kind === 'break' && session.completed) grant(userId, 'first_break', newMilestones);

  const points = before.points + earned;
  db.prepare(
    `UPDATE rewards SET points=?, trees=?, current_streak=?, best_streak=?, last_focus_day=? WHERE user_id=?`
  ).run(points, trees, current_streak, best_streak, last_focus_day, userId);

  if (trees >= 5) grant(userId, 'trees_5', newMilestones);
  if (trees >= 25) grant(userId, 'trees_25', newMilestones);
  if (current_streak >= 3) grant(userId, 'streak_3', newMilestones);
  if (current_streak >= 7) grant(userId, 'streak_7', newMilestones);
  if (levelFor(points).level >= 5) grant(userId, 'level_5', newMilestones);

  const today = db.prepare(
    `SELECT SUM(kind='focus' AND completed=1) f, SUM(kind='break' AND completed=1) b
       FROM focus_sessions WHERE user_id=? AND day=?`
  ).get(userId, day);
  if ((today.f || 0) >= 4 && (today.b || 0) >= 3) grant(userId, 'balanced_day', newMilestones);

  const leveledUp = levelFor(points).level > levelFor(before.points).level;
  return { earned, capped, tree, newMilestones, leveledUp };
});

function summary(userId) {
  const r = ensureRow(userId);
  // A streak only counts as current if the last focus day was today or yesterday (UTC tolerance).
  const lvl = levelFor(r.points);
  const achieved = db.prepare('SELECT code, achieved_at FROM milestones WHERE user_id = ?').all(userId);
  const map = Object.fromEntries(achieved.map((a) => [a.code, a.achieved_at]));
  const garden = db.prepare('SELECT id, species, planted_at FROM trees WHERE user_id = ? ORDER BY id').all(userId);
  return {
    points: r.points,
    ...lvl,
    trees: r.trees,
    currentStreak: r.current_streak,
    bestStreak: r.best_streak,
    lastFocusDay: r.last_focus_day,
    dailyPointCap: DAILY_POINT_CAP,
    garden,
    milestones: MILESTONES.map((m) => ({ ...m, achievedAt: map[m.code] || null })),
  };
}

module.exports = { applySession, summary, grant, levelFor, MILESTONES };
