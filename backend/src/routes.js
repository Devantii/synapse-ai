const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { sign, requireAuth } = require('./auth');
const game = require('./gamification');
const { analyze } = require('./analytics');
const coach = require('./coach');
const devices = require('./devices');
const voice = require('./voice');
const { dedupe, SOURCE_LABEL } = require('./usage');

const router = express.Router();

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDay(day, { maxPastDays = 90 } = {}) {
  if (typeof day !== 'string' || !DAY_RE.test(day) || isNaN(Date.parse(day + 'T00:00:00Z')))
    throw new HttpError(400, 'Invalid day (expected YYYY-MM-DD).');
  const diff = (Date.parse(day + 'T00:00:00Z') - Date.now()) / 86400000;
  if (diff > 1.5) throw new HttpError(400, 'Day cannot be in the future.');
  if (diff < -maxPastDays) throw new HttpError(400, `Day must be within the last ${maxPastDays} days.`);
  return day;
}
function num(v, name, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max}.`);
  return n;
}
function text(v, name, min, max) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max) throw new HttpError(400, `${name} must be ${min}-${max} characters.`);
  return s;
}
const CATEGORIES = ['work', 'study', 'social', 'entertainment', 'games', 'news', 'communication', 'other'];

function consents(userId) {
  db.prepare('INSERT OR IGNORE INTO consents (user_id) VALUES (?)').run(userId);
  return db.prepare('SELECT activity_tracking, usage_tracking, ai_insights, community_profile, updated_at FROM consents WHERE user_id = ?').get(userId);
}
function requireConsent(field, label) {
  return (req, res, next) => {
    if (!consents(req.user.id)[field])
      return res.status(403).json({ error: `Enable "${label}" in Privacy settings first.`, consentRequired: field });
    next();
  };
}
function serverToday() {
  return new Date().toISOString().slice(0, 10);
}

// ---------- auth ----------
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

router.post('/auth/register', authLimiter, wrap(async (req, res) => {
  const username = text(req.body.username, 'Username', 3, 24).toLowerCase();
  if (!/^[a-z0-9_.-]+$/.test(username)) throw new HttpError(400, 'Username may use letters, numbers, dot, dash and underscore.');
  const displayName = text(req.body.displayName || username, 'Display name', 1, 40);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (password.length < 8 || password.length > 128) throw new HttpError(400, 'Password must be 8-128 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken.');
  const hash = await bcrypt.hash(password, 11);
  const r = db.prepare('INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)').run(username, displayName, hash);
  const user = { id: r.lastInsertRowid, username, display_name: displayName };
  consents(user.id);
  res.status(201).json({ token: sign(user), user: { id: user.id, username, displayName } });
}));

router.post('/auth/login', authLimiter, wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = user && (await bcrypt.compare(String(req.body.password || ''), user.password_hash));
  if (!ok) throw new HttpError(401, 'Incorrect username or password.');
  res.json({ token: sign(user), user: { id: user.id, username: user.username, displayName: user.display_name } });
}));

router.get('/health', (req, res) => res.json({ ok: true, llm: coach.llmEnabled, voice: voice.enabled ? 'livekit' : 'mesh' }));

// Everything below needs a signed-in user.
router.use(requireAuth);

router.get('/me', (req, res) => {
  const u = db.prepare('SELECT id, username, display_name, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!u) return res.status(401).json({ error: 'Account no longer exists.' });
  res.json({
    user: { id: u.id, username: u.username, displayName: u.display_name, createdAt: u.created_at },
    consents: consents(u.id),
    rewards: game.summary(u.id),
    llmEnabled: coach.llmEnabled,
    voiceMode: voice.enabled ? 'livekit' : 'mesh',
    devices: devices.list(u.id),
  });
});

// ---------- consent ----------
const CONSENT_FIELDS = ['activity_tracking', 'usage_tracking', 'ai_insights', 'community_profile'];
router.get('/consents', (req, res) => res.json(consents(req.user.id)));
router.put('/consents', (req, res) => {
  const cur = consents(req.user.id);
  const tx = db.transaction(() => {
    for (const f of CONSENT_FIELDS) {
      if (req.body[f] === undefined) continue;
      const v = req.body[f] ? 1 : 0;
      if (v === cur[f]) continue;
      db.prepare(`UPDATE consents SET ${f} = ?, updated_at = datetime('now') WHERE user_id = ?`).run(v, req.user.id);
      db.prepare('INSERT INTO consent_log (user_id, field, value) VALUES (?, ?, ?)').run(req.user.id, f, v);
    }
  });
  tx();
  res.json(consents(req.user.id));
});
router.get('/consents/log', (req, res) =>
  res.json(db.prepare('SELECT field, value, changed_at FROM consent_log WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id))
);

// ---------- focus sessions ----------
const LOCAL_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
router.post('/sessions', requireConsent('activity_tracking', 'Save focus activity'), (req, res) => {
  const kind = req.body.kind === 'break' ? 'break' : req.body.kind === 'focus' ? 'focus' : null;
  if (!kind) throw new HttpError(400, 'kind must be "focus" or "break".');
  const plannedMin = num(req.body.plannedMin, 'plannedMin', 1, 120);
  const actualMin = num(req.body.actualMin, 'actualMin', 0, plannedMin + 1);
  const completed = req.body.completed ? 1 : 0;
  if (completed && actualMin < plannedMin - 0.5) throw new HttpError(400, 'A completed session must run its planned length.');
  const day = validDay(req.body.day, { maxPastDays: 2 });
  const startedAt = String(req.body.startedAt || '');
  const endedAt = String(req.body.endedAt || '');
  if (!LOCAL_TS.test(startedAt) || !LOCAL_TS.test(endedAt)) throw new HttpError(400, 'startedAt/endedAt must be local timestamps (YYYY-MM-DDTHH:MM).');
  const tag = req.body.tag ? text(req.body.tag, 'Tag', 1, 40) : null;

  // Rate guard: you cannot log more focus minutes in a day than exist in it.
  const sum = db.prepare('SELECT COALESCE(SUM(actual_min),0) m FROM focus_sessions WHERE user_id=? AND day=?').get(req.user.id, day).m;
  if (sum + actualMin > 24 * 60) throw new HttpError(400, 'That exceeds the minutes in a day.');

  const session = { kind, planned_min: plannedMin, actual_min: actualMin, completed, tag, day, started_at: startedAt, ended_at: endedAt };
  const r = db.prepare(
    `INSERT INTO focus_sessions (user_id, kind, planned_min, actual_min, completed, tag, day, started_at, ended_at)
     VALUES (@user_id, @kind, @planned_min, @actual_min, @completed, @tag, @day, @started_at, @ended_at)`
  ).run({ user_id: req.user.id, ...session });
  const result = game.applySession(req.user.id, session, day);
  res.status(201).json({ id: r.lastInsertRowid, ...result, rewards: game.summary(req.user.id) });
});

router.get('/sessions', (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
  const rows = db.prepare(
    `SELECT id, kind, planned_min, actual_min, completed, tag, day, started_at, ended_at FROM focus_sessions
      WHERE user_id = ? AND day >= date('now', ?) ORDER BY started_at DESC LIMIT 500`
  ).all(req.user.id, `-${days} days`);
  res.json(rows);
});

// ---------- screen time ----------
router.put('/usage', requireConsent('usage_tracking', 'Save screen-time data'), (req, res) => {
  const day = validDay(req.body.day);
  const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
  if (!entries.length || entries.length > 50) throw new HttpError(400, 'Provide 1-50 entries.');
  const clean = entries.map((e) => ({
    app: text(e.app, 'App/site name', 1, 60),
    category: CATEGORIES.includes(e.category) ? e.category : 'other',
    minutes: num(e.minutes, 'Minutes', 0, 1440),
  }));
  const existing = db.prepare(`SELECT COALESCE(SUM(minutes),0) m FROM app_usage WHERE user_id=? AND day=? AND source='self' AND app NOT IN (${clean.map(() => '?').join(',')})`)
    .get(req.user.id, day, ...clean.map((c) => c.app)).m;
  if (existing + clean.reduce((s, c) => s + c.minutes, 0) > 1440) throw new HttpError(400, 'Total for the day cannot exceed 24 hours.');
  const up = db.prepare(
    `INSERT INTO app_usage (user_id, day, app, category, minutes, source) VALUES (?, ?, ?, ?, ?, 'self')
     ON CONFLICT(user_id, day, app, source) DO UPDATE SET minutes = excluded.minutes, category = excluded.category`
  );
  db.transaction(() => clean.forEach((c) => up.run(req.user.id, day, c.app, c.category, c.minutes)))();
  const out = [];
  game.grant(req.user.id, 'usage_logged', out);
  res.json({ ok: true, newMilestones: out });
});

// Synapse tab foreground time, sent by the dashboard in small increments.
router.post('/usage/foreground', requireConsent('usage_tracking', 'Save screen-time data'), (req, res) => {
  const day = validDay(req.body.day, { maxPastDays: 2 });
  const minutes = num(req.body.minutes, 'minutes', 0, 10); // heartbeat chunks are <= 10 minutes
  const cur = db.prepare(`SELECT minutes FROM app_usage WHERE user_id=? AND day=? AND app='Synapse AI' AND source='synapse'`).get(req.user.id, day);
  if ((cur?.minutes || 0) + minutes > 1440) throw new HttpError(400, 'Daily limit reached.');
  db.prepare(
    `INSERT INTO app_usage (user_id, day, app, category, minutes, source) VALUES (?, ?, 'Synapse AI', 'work', ?, 'synapse')
     ON CONFLICT(user_id, day, app, source) DO UPDATE SET minutes = minutes + excluded.minutes`
  ).run(req.user.id, day, minutes);
  res.json({ ok: true });
});

router.delete('/usage/:id', (req, res) => {
  const r = db.prepare('DELETE FROM app_usage WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!r.changes) throw new HttpError(404, 'Entry not found.');
  res.json({ ok: true });
});

router.get('/usage', (req, res) => {
  const to = req.query.to ? validDay(req.query.to, { maxPastDays: 365 }) : serverToday();
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
  const from = new Date(Date.parse(to + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(
    `SELECT id, day, app, category, minutes, source FROM app_usage WHERE user_id = ? AND day BETWEEN ? AND ? ORDER BY day DESC, minutes DESC`
  ).all(req.user.id, from, to);
  const daily = dedupe(rows); // also marks rows.counted (overlapping sources count once)
  res.json({ from, to, entries: rows.map((r) => ({ ...r, counted: !!r.counted, sourceLabel: SOURCE_LABEL[r.source] || r.source })), daily, categories: CATEGORIES });
});

// ---------- mood check-ins (private, feed the insights) ----------
router.put('/checkins', requireConsent('ai_insights', 'AI wellbeing insights'), (req, res) => {
  const day = validDay(req.body.day, { maxPastDays: 7 });
  const energy = Math.round(num(req.body.energy, 'Energy', 1, 5));
  const stress = Math.round(num(req.body.stress, 'Stress', 1, 5));
  const sleep = req.body.sleepHours === '' || req.body.sleepHours == null ? null : num(req.body.sleepHours, 'Sleep hours', 0, 16);
  db.prepare(
    `INSERT INTO mood_checkins (user_id, day, energy, stress, sleep_h) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, day) DO UPDATE SET energy=excluded.energy, stress=excluded.stress, sleep_h=excluded.sleep_h`
  ).run(req.user.id, day, energy, stress, sleep);
  res.json({ ok: true });
});
router.get('/checkins', (req, res) =>
  res.json(db.prepare('SELECT day, energy, stress, sleep_h FROM mood_checkins WHERE user_id = ? ORDER BY day DESC LIMIT 30').all(req.user.id))
);

// ---------- insights + coach ----------
router.get('/insights', requireConsent('ai_insights', 'AI wellbeing insights'), (req, res) => {
  const day = req.query.day ? validDay(req.query.day) : serverToday();
  res.json(analyze(req.user.id, day));
});

const coachLimiter = rateLimit({ windowMs: 60 * 1000, limit: 12, keyGenerator: (req) => String(req.user.id), standardHeaders: true, legacyHeaders: false });
router.post('/coach', coachLimiter, requireConsent('ai_insights', 'AI wellbeing insights'), wrap(async (req, res) => {
  const message = text(req.body.message, 'Message', 1, 1000);
  const day = req.body.day ? validDay(req.body.day) : serverToday();
  const history = Array.isArray(req.body.history) ? req.body.history.slice(-6) : [];
  res.json(await coach.reply(message, analyze(req.user.id, day), history));
}));

// ---------- rewards ----------
router.get('/rewards', (req, res) => res.json(game.summary(req.user.id)));

// ---------- community ----------
const MOODS = ['calm', 'focused', 'proud', 'tired', 'stressed', 'hopeful'];
const REACTIONS = ['cheer', 'hug', 'same'];

function feed(userId, limit, beforeId) {
  const rows = db.prepare(
    `SELECT p.id, p.mood, p.body, p.created_at, p.user_id,
            CASE WHEN c.community_profile = 0 THEN 'Anonymous member' ELSE u.display_name END AS author
       FROM posts p JOIN users u ON u.id = p.user_id LEFT JOIN consents c ON c.user_id = p.user_id
      WHERE (? IS NULL OR p.id < ?) ORDER BY p.id DESC LIMIT ?`
  ).all(beforeId ?? null, beforeId ?? null, limit);
  const rx = db.prepare('SELECT kind, COUNT(*) n, SUM(user_id = ?) mine FROM reactions WHERE post_id = ? GROUP BY kind');
  return rows.map((p) => {
    const reactions = Object.fromEntries(REACTIONS.map((k) => [k, { count: 0, mine: false }]));
    for (const r of rx.all(userId, p.id)) reactions[r.kind] = { count: r.n, mine: !!r.mine };
    const { user_id, ...rest } = p;
    return { ...rest, isMine: user_id === userId, reactions };
  });
}

router.get('/posts', (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const before = req.query.before ? parseInt(req.query.before, 10) : null;
  res.json({ posts: feed(req.user.id, limit, before), moods: MOODS, reactions: REACTIONS });
});

const postLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 10, keyGenerator: (req) => String(req.user.id), standardHeaders: true, legacyHeaders: false });
router.post('/posts', postLimiter, (req, res) => {
  const mood = MOODS.includes(req.body.mood) ? req.body.mood : null;
  if (!mood) throw new HttpError(400, 'Pick a mood.');
  const body = text(req.body.body, 'Check-in', 2, 500);
  const r = db.prepare('INSERT INTO posts (user_id, mood, body) VALUES (?, ?, ?)').run(req.user.id, mood, body);
  const out = [];
  game.grant(req.user.id, 'first_post', out);
  req.app.get('io')?.emit('community:new', { id: r.lastInsertRowid });
  res.status(201).json({ id: r.lastInsertRowid, newMilestones: out });
});

router.post('/posts/:id/react', (req, res) => {
  const kind = REACTIONS.includes(req.body.kind) ? req.body.kind : null;
  if (!kind) throw new HttpError(400, 'Unknown reaction.');
  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) throw new HttpError(404, 'Post not found.');
  const del = db.prepare('DELETE FROM reactions WHERE post_id=? AND user_id=? AND kind=?').run(post.id, req.user.id, kind);
  if (!del.changes) db.prepare('INSERT INTO reactions (post_id, user_id, kind) VALUES (?, ?, ?)').run(post.id, req.user.id, kind);
  res.json({ active: !del.changes });
});

router.delete('/posts/:id', (req, res) => {
  const r = db.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!r.changes) throw new HttpError(404, 'Post not found or not yours.');
  res.json({ ok: true });
});

// ---------- rooms ----------
router.get('/rooms', (req, res) => {
  const presence = req.app.get('presence') || (() => []);
  res.json(db.prepare('SELECT id, name, description FROM rooms').all().map((r) => ({ ...r, members: presence(r.id) })));
});
router.get('/rooms/:id/messages', (req, res) => {
  res.json(db.prepare(
    `SELECT m.id, m.body, m.created_at, u.display_name AS author, m.user_id = ? AS isMine
       FROM room_messages m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY m.id DESC LIMIT 50`
  ).all(req.user.id, req.params.id).reverse());
});

// ---------- connected devices (extension / desktop tracker) ----------
router.get('/devices', (req, res) => res.json(devices.list(req.user.id)));
router.post('/devices', (req, res) => {
  const kind = devices.KINDS[req.body.kind];
  if (!kind) throw new HttpError(400, 'kind must be "extension" or "desktop".');
  const name = text(req.body.name || (kind === 'extension' ? 'Browser extension' : 'Desktop tracker'), 'Name', 1, 40);
  if (devices.list(req.user.id).length >= 10) throw new HttpError(400, 'You can connect up to 10 devices. Revoke one first.');
  const { id, token } = devices.create(req.user.id, name, kind);
  res.status(201).json({ id, token, name, kind, note: 'Copy this key now. It will not be shown again.' });
});
router.delete('/devices/:id', (req, res) => {
  if (!devices.revoke(req.user.id, req.params.id)) throw new HttpError(404, 'Device not found.');
  res.json({ ok: true });
});

// ---------- voice ----------
router.get('/rooms/:id/voice', wrap(async (req, res) => {
  if (!db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(req.params.id)) throw new HttpError(404, 'Room not found.');
  if (!voice.enabled) return res.json({ mode: 'mesh', maxPeers: voice.MESH_LIMIT });
  res.json({ mode: 'livekit', url: voice.url, token: await voice.tokenFor(req.user, req.params.id) });
}));

// ---------- export & deletion ----------
router.get('/export', (req, res) => {
  const id = req.user.id;
  const q = (sql) => db.prepare(sql).all(id);
  const data = {
    exportedAt: new Date().toISOString(),
    account: db.prepare('SELECT id, username, display_name, created_at FROM users WHERE id = ?').get(id),
    consents: consents(id),
    consentLog: q('SELECT field, value, changed_at FROM consent_log WHERE user_id = ? ORDER BY id'),
    focusSessions: q('SELECT kind, planned_min, actual_min, completed, tag, day, started_at, ended_at FROM focus_sessions WHERE user_id = ? ORDER BY id'),
    appUsage: q('SELECT day, app, category, minutes, source FROM app_usage WHERE user_id = ? ORDER BY day'),
    moodCheckins: q('SELECT day, energy, stress, sleep_h FROM mood_checkins WHERE user_id = ? ORDER BY day'),
    rewards: game.summary(id),
    communityPosts: q('SELECT id, mood, body, created_at FROM posts WHERE user_id = ? ORDER BY id'),
    reactionsGiven: q('SELECT post_id, kind, created_at FROM reactions WHERE user_id = ?'),
    roomMessages: q('SELECT room_id, body, created_at FROM room_messages WHERE user_id = ? ORDER BY id'),
    connectedDevices: q('SELECT name, kind, created_at, last_used_at, revoked_at FROM device_tokens WHERE user_id = ? ORDER BY id'),
  };
  res.setHeader('Content-Disposition', `attachment; filename="synapse-export-${serverToday()}.json"`);
  res.json(data);
});

router.delete('/data', (req, res) => {
  const scope = req.body.scope;
  const id = req.user.id;
  const actions = {
    activity: () => {
      db.prepare('DELETE FROM focus_sessions WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM trees WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM milestones WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM rewards WHERE user_id = ?').run(id);
    },
    usage: () => db.prepare('DELETE FROM app_usage WHERE user_id = ?').run(id),
    wellbeing: () => db.prepare('DELETE FROM mood_checkins WHERE user_id = ?').run(id),
    community: () => {
      db.prepare('DELETE FROM posts WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM reactions WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM room_messages WHERE user_id = ?').run(id);
    },
  };
  if (scope === 'all') db.transaction(() => Object.values(actions).forEach((f) => f()))();
  else if (actions[scope]) db.transaction(actions[scope])();
  else throw new HttpError(400, 'scope must be activity, usage, wellbeing, community or all.');
  res.json({ ok: true, deleted: scope });
});

router.delete('/account', wrap(async (req, res) => {
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash)))
    throw new HttpError(401, 'Password is incorrect.');
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id); // ON DELETE CASCADE removes everything
  res.json({ ok: true });
}));

// ---------- errors ----------
router.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

module.exports = router;
