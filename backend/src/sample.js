// "Try with sample data": three weeks of realistic, clearly marked activity so a new account can see
// Progress, Screen time and the ML + fuzzy Insights working before it has its own history.
// Sample rows are flagged (sample = 1, usage source 'sample') and removed in one click.
const db = require('./db');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const shift = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const pad = (n) => String(n).padStart(2, '0');

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A student/knowledge worker whose second week drifts: more scrolling, later nights, fewer breaks.
const APPS = [
  ['VS Code', 'work', 95, 40], ['Google Docs', 'work', 50, 25], ['Coursera', 'study', 35, 25], ['Notion', 'study', 25, 15],
  ['WhatsApp', 'communication', 35, 15], ['Gmail', 'communication', 20, 8],
  ['Instagram', 'social', 45, 30], ['YouTube', 'entertainment', 60, 35], ['Netflix', 'entertainment', 25, 30], ['Reddit', 'social', 15, 15],
];

function build(today, seed) {
  const r = rng(seed);
  const usage = [], sessions = [], moods = [];
  for (let back = 20; back >= 0; back--) {
    const day = shift(today, -back);
    const drift = back <= 6 ? 1 : back <= 13 ? 0.35 : 0; // recent week drifts most
    const weekend = [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());
    for (const [app, category, base, spread] of APPS) {
      const leisure = ['social', 'entertainment'].includes(category);
      let m = base + (r() - 0.5) * spread * 2;
      if (leisure) m *= 1 + 0.7 * drift + (weekend ? 0.5 : 0);
      else if (weekend) m *= 0.4;
      if (back === 0) m *= 0.55; // today is only partly over
      if (m >= 3) usage.push({ day, app, category, minutes: Math.round(m) });
    }
    if (weekend && r() < 0.5) continue; // some days off
    const blocks = 2 + Math.floor(r() * (weekend ? 2 : 4)) - (back === 0 ? 1 : 0);
    let hour = 9 + Math.floor(r() * 2) + Math.round(drift * 3);
    for (let i = 0; i < blocks; i++) {
      const planned = r() < 0.6 ? 25 : 50;
      const abandoned = r() < 0.12 + 0.15 * drift;
      const actual = abandoned ? Math.round(planned * (0.25 + r() * 0.5)) : planned;
      const startH = Math.min(hour + (drift && i === blocks - 1 && r() < 0.6 ? 7 : 0), 23);
      const startM = Math.floor(r() * 50);
      const tag = ['Thesis', 'Coding', 'Reading', 'Coursework'][Math.floor(r() * 4)];
      sessions.push({ day, kind: 'focus', planned, actual, completed: abandoned ? 0 : 1, tag, start: `${day}T${pad(startH)}:${pad(startM)}`, minutes: actual });
      if (!abandoned && r() > 0.25 + 0.35 * drift) {
        const bm = planned >= 50 ? 10 : 5;
        sessions.push({ day, kind: 'break', planned: bm, actual: bm, completed: 1, tag: null, start: `${day}T${pad(Math.min(startH + 1, 23))}:${pad(Math.floor(r() * 50))}`, minutes: bm });
      }
      hour += planned >= 50 ? 2 : 1;
    }
    if (r() < 0.8) {
      moods.push({
        day,
        energy: Math.max(1, Math.min(5, Math.round(3.6 - 1.3 * drift + (r() - 0.5) * 1.6))),
        stress: Math.max(1, Math.min(5, Math.round(2.4 + 1.4 * drift + (r() - 0.5) * 1.6))),
        sleep: Math.round((7.4 - 1.3 * drift + (r() - 0.5) * 1.2) * 2) / 2,
      });
    }
  }
  // Tasks: a few finished most weekdays, three open for today (one already half done).
  const tasks = [];
  const TASKS = ['Revise DBMS unit 3', 'Thesis: related work', 'Fix login bug', 'Read 2 papers', 'Coursera week 4 quiz', 'Outline presentation', 'Clean up notes', 'Practice SQL joins', 'Email supervisor'];
  for (let back = 13; back >= 1; back--) {
    const day = shift(today, -back);
    if ([0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay())) continue;
    const n = 1 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++) {
      const est = 1 + Math.floor(r() * 3);
      tasks.push({ title: TASKS[Math.floor(r() * TASKS.length)], estimate: est, blocks: est, done: 1, day, doneDay: day });
    }
  }
  tasks.push({ title: 'Thesis: methods section', estimate: 3, blocks: 1, done: 0, day: today, doneDay: null });
  tasks.push({ title: 'Revise DBMS unit 4', estimate: 2, blocks: 0, done: 0, day: today, doneDay: null });
  tasks.push({ title: 'Reply to group chat about project', estimate: 1, blocks: 0, done: 0, day: today, doneDay: null });
  // Distractions noticed during focus blocks: phone and social media most, worse in the drifting week.
  const distractions = [];
  const KINDS = ['phone', 'phone', 'social', 'social', 'messages', 'thoughts', 'noise', 'tired', 'people'];
  for (const s of sessions) {
    if (s.kind !== 'focus' || s.day === today) continue;
    const back = Math.round((new Date(`${today}T12:00:00Z`) - new Date(`${s.day}T12:00:00Z`)) / 864e5);
    if (r() < (back <= 6 ? 0.55 : 0.2)) {
      const at = `${s.start.slice(0, 14)}${pad(Math.min(59, Number(s.start.slice(14, 16)) + 5 + Math.floor(r() * 8)))}`;
      distractions.push({ day: s.day, at, kind: KINDS[Math.floor(r() * KINDS.length)] });
    }
  }
  return { usage, sessions, moods, tasks, distractions };
}

const endTs = (start, minutes) => {
  const d = new Date(`${start}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + Math.round(minutes));
  return d.toISOString().slice(0, 16);
};

/** Adds sample data ending on the user's local `today`. Replaces earlier sample data; never touches real rows. */
async function add(userId, today, now) {
  if (!DAY.test(String(today))) today = new Date().toISOString().slice(0, 10);
  if (!/^\d{2}:\d{2}$/.test(String(now))) now = '23:59';
  const built = build(today, userId * 7919 + 17);
  const { usage, moods, tasks, distractions } = built;
  // Nothing from later today: a 4 pm visit must not show a block that "ended" at 11 pm.
  const sessions = built.sessions.filter((s) => s.day !== today || endTs(s.start, s.minutes) <= `${today}T${now}`);
  await remove(userId);
  await db.tx(async (t) => {
    for (const u of usage)
      await t.run('INSERT INTO app_usage (user_id, day, app, category, minutes, source) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, day, app, source) DO NOTHING',
        [userId, u.day, u.app, u.category, u.minutes, 'sample']);
    for (const s of sessions)
      await t.run(`INSERT INTO focus_sessions (user_id, kind, planned_min, actual_min, completed, tag, day, started_at, ended_at, sample)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`, [userId, s.kind, s.planned, s.actual, s.completed, s.tag, s.day, s.start, endTs(s.start, s.minutes)]);
    for (const m of moods) // a real check-in on the same day wins
      await t.run('INSERT INTO mood_checkins (user_id, day, energy, stress, sleep_h, sample) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT (user_id, day) DO NOTHING',
        [userId, m.day, m.energy, m.stress, m.sleep]);
    let pos = 0;
    for (const k of tasks)
      await t.run('INSERT INTO tasks (user_id, title, estimate, blocks_done, done, day, done_day, position, sample) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)',
        [userId, k.title, k.estimate, k.blocks, k.done, k.day, k.doneDay, pos++]);
    for (const d of distractions)
      await t.run('INSERT INTO distractions (user_id, day, at, kind, sample) VALUES (?, ?, ?, ?, 1)', [userId, d.day, d.at, d.kind]);
  });
  return { days: 21, usageRows: usage.length, sessions: sessions.length, checkins: moods.length, tasks: tasks.length, distractions: distractions.length };
}

async function remove(userId) {
  await db.tx(async (t) => {
    await t.run("DELETE FROM app_usage WHERE user_id = ? AND source = 'sample'", [userId]);
    await t.run('DELETE FROM focus_sessions WHERE user_id = ? AND sample = 1', [userId]);
    await t.run('DELETE FROM mood_checkins WHERE user_id = ? AND sample = 1', [userId]);
    await t.run('DELETE FROM tasks WHERE user_id = ? AND sample = 1', [userId]);
    await t.run('DELETE FROM distractions WHERE user_id = ? AND sample = 1', [userId]);
  });
}

async function has(userId) {
  return !!(await db.get('SELECT 1 AS ok FROM focus_sessions WHERE user_id = ? AND sample = 1 LIMIT 1', [userId]))
    || !!(await db.get("SELECT 1 AS ok FROM app_usage WHERE user_id = ? AND source = 'sample' LIMIT 1", [userId]));
}

module.exports = { add, remove, has };
