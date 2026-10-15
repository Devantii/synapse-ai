const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { sign, requireAuth } = require('./auth');
const game = require('./gamification');
const { analyze, modelCard } = require('./analytics');
const coach = require('./coach');
const devices = require('./devices');
const voice = require('./voice');
const google = require('./google');
const sample = require('./sample');
const safety = require('./safety');
const mailer = require('./mailer');
const weekly = require('./weekly');
const { hmac } = require('./auth');
const crypto = require('crypto');
let ext = null; // extras (set below), used by the weekly email
const { dedupe, appKey, SOURCE_LABEL } = require('./usage');
const sessions = require('./sessions');

const router = express.Router();

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
// Every handler is async; errors (including thrown HttpErrors) go to the error handler at the bottom.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const get = (path, ...h) => router.get(path, ...h.slice(0, -1), wrap(h.at(-1)));
const post = (path, ...h) => router.post(path, ...h.slice(0, -1), wrap(h.at(-1)));
const put = (path, ...h) => router.put(path, ...h.slice(0, -1), wrap(h.at(-1)));
const del = (path, ...h) => router.delete(path, ...h.slice(0, -1), wrap(h.at(-1)));

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
const intId = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'Not found.');
  return n;
};
const CATEGORIES = ['work', 'study', 'social', 'entertainment', 'games', 'news', 'communication', 'other'];
const serverToday = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function consents(userId, q = db) {
  await q.run('INSERT INTO consents (user_id) VALUES (?) ON CONFLICT DO NOTHING', [userId]);
  return q.get('SELECT activity_tracking, usage_tracking, ai_insights, community_profile, updated_at FROM consents WHERE user_id = ?', [userId]);
}
function requireConsent(field, label) {
  return wrap(async (req, res, next) => {
    if (!(await consents(req.user.id))[field])
      return res.status(403).json({ error: `Enable "${label}" in Privacy settings first.`, consentRequired: field });
    next();
  });
}

// ---------- auth ----------
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

post('/auth/register', authLimiter, async (req, res) => {
  const username = text(req.body.username, 'Username', 3, 24).toLowerCase();
  if (!/^[a-z0-9_.-]+$/.test(username)) throw new HttpError(400, 'Username may use letters, numbers, dot, dash and underscore.');
  const displayName = text(req.body.displayName || username, 'Display name', 1, 40);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (password.length < 8 || password.length > 128) throw new HttpError(400, 'Password must be 8-128 characters.');
  if (await db.get('SELECT 1 AS ok FROM users WHERE username = ?', [username])) throw new HttpError(409, 'That username is taken.');
  const hash = await bcrypt.hash(password, 11);
  let id;
  try {
    id = await db.insert('INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)', [username, displayName, hash]);
  } catch (e) {
    if (/unique|duplicate/i.test(e.message)) throw new HttpError(409, 'That username is taken.'); // lost a signup race
    throw e;
  }
  await consents(id);
  const user = { id, username, display_name: displayName };
  res.status(201).json({ token: sign(user), user: { id, username, displayName } });
});

post('/auth/login', authLimiter, async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
  const ok = user && hasPassword(user) && (await bcrypt.compare(String(req.body.password || ''), user.password_hash));
  if (!ok) throw new HttpError(401, user && !hasPassword(user) ? 'This account uses "Continue with Google".' : 'Incorrect username or password.');
  res.json({ token: sign(user), user: { id: user.id, username: user.username, displayName: user.display_name } });
});

const hasPassword = (u) => typeof u.password_hash === 'string' && u.password_hash.startsWith('$2');
const authReply = (u) => ({ token: sign(u), user: { id: u.id, username: u.username, displayName: u.display_name } });

// Public sign-in options for the login screen.
router.get('/auth/config', (req, res) => res.json({ googleClientId: google.enabled ? google.clientId : null }));

async function googleIdentity(credential) {
  if (!google.enabled) throw new HttpError(404, 'Google sign-in is not set up on this server.');
  if (typeof credential !== 'string' || credential.length < 20 || credential.length > 4096) throw new HttpError(400, 'Missing Google credential.');
  let g;
  try {
    g = await google.verify(credential);
  } catch {
    throw new HttpError(400, 'Google sign-in failed. Please try again.');
  }
  if (!g?.sub) throw new HttpError(400, 'Google sign-in failed. Please try again.');
  return g;
}

/** A free username from the Google email or name, e.g. "asha.k" or "asha.k2". */
async function freeUsername(g) {
  const base = (String(g.email || g.name || 'member').split('@')[0].toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 20) || 'member').padEnd(3, '0');
  for (let i = 0; i < 50; i++) {
    const name = i === 0 ? base : `${base.slice(0, 20)}${i + 1}`;
    if (!(await db.get('SELECT 1 AS ok FROM users WHERE username = ?', [name]))) return name;
  }
  return `${base.slice(0, 14)}${Date.now().toString(36).slice(-6)}`;
}

// POST /auth/google { credential }: sign in, or create an account on first use.
post('/auth/google', authLimiter, async (req, res) => {
  const g = await googleIdentity(req.body.credential);
  let user = await db.get('SELECT * FROM users WHERE google_sub = ?', [g.sub]);
  if (user) return res.json({ ...authReply(user), created: false });
  const displayName = String(g.name || g.email?.split('@')[0] || 'Member').trim().slice(0, 40) || 'Member';
  let id;
  for (let attempt = 0; ; attempt++) {
    const username = await freeUsername(g);
    try {
      id = await db.insert('INSERT INTO users (username, display_name, password_hash, google_sub, email, email_verified) VALUES (?, ?, ?, ?, ?, ?)',
        [username, displayName, '!', g.sub, g.emailVerified ? g.email : null, g.emailVerified ? 1 : 0]);
      break;
    } catch (e) {
      if (!/unique|duplicate/i.test(e.message) || attempt > 3) throw e;
      user = await db.get('SELECT * FROM users WHERE google_sub = ?', [g.sub]); // same Google account signed up twice at once
      if (user) return res.json({ ...authReply(user), created: false });
    }
  }
  await consents(id);
  user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  res.status(201).json({ ...authReply(user), created: true });
});

// ---------- images: public by unguessable id (needed for <img> tags) ----------
router.get('/img/:id', wrap(async (req, res) => {
  const id = String(req.params.id);
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(id)) return res.status(404).end();
  const img = await db.get('SELECT mime, data FROM images WHERE id = ?', [id]);
  if (!img) return res.status(404).end();
  res.set({ 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
  res.send(Buffer.from(img.data, 'base64'));
}));

// ---------- forgot password (public; needs email set up and a confirmed address) ----------
const resetLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
router.get('/auth/reset-available', (req, res) => res.json({ available: mailer.enabled }));
post('/auth/forgot', resetLimiter, async (req, res) => {
  if (!mailer.enabled) throw new HttpError(503, 'Password reset by email is not set up on this server. Ask the admin.');
  const who = String(req.body.username || '').trim().toLowerCase();
  // Same reply whether or not the account exists, so this can't be used to discover usernames or emails.
  const reply = { ok: true, message: 'If that account has a confirmed email, a reset link is on its way. Check your inbox (and spam).' };
  if (!who) return res.json(reply);
  const u = await db.get('SELECT id, display_name, email FROM users WHERE (username = ? OR lower(email) = ?) AND email_verified = 1 AND email IS NOT NULL', [who, who]);
  if (!u) return res.json(reply);
  const token = crypto.randomBytes(32).toString('base64url');
  await db.run('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [sha(token), u.id, Date.now() + 3600 * 1000]);
  const link = `${weekly.baseUrl()}/?reset=${token}`;
  await mailer.send({ to: u.email, subject: 'Reset your Synapse password',
    text: `Hi ${u.display_name},\n\nReset your password here (valid for 1 hour, one use):\n${link}\n\nIf you didn't ask for this, ignore this email; your password stays the same.`,
    html: `<p>Hi ${String(u.display_name).replace(/[<>&]/g, '')},</p><p><a href="${link}" style="display:inline-block;background:#1C2A33;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:700">Choose a new password</a></p><p style="color:#74838C;font-size:12px">Valid for 1 hour, one use. If you didn't ask for this, ignore this email.</p>` });
  res.json(reply);
});
post('/auth/reset', resetLimiter, async (req, res) => {
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (password.length < 8 || password.length > 128) throw new HttpError(400, 'Password must be 8-128 characters.');
  const row = await db.get('SELECT user_id, expires_at, used FROM password_resets WHERE token_hash = ?', [sha(req.body.token || '')]);
  if (!row || row.used || Number(row.expires_at) < Date.now()) throw new HttpError(400, 'This reset link has expired or was already used. Ask for a new one.');
  await db.tx(async (t) => {
    await t.run('UPDATE password_resets SET used = 1 WHERE token_hash = ?', [sha(req.body.token)]);
    await t.run('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(password, 11), row.user_id]);
  });
  const user = await db.get('SELECT * FROM users WHERE id = ?', [row.user_id]);
  res.json(authReply(user));
});

// ---------- weekly email: public links ----------
router.get('/email/verify', wrap(async (req, res) => {
  const token = String(req.query.token || '');
  const u = token.length >= 20 ? await db.get('SELECT id FROM users WHERE email_token = ?', [token]) : null;
  if (!u) return res.redirect('/?email=invalid#/privacy');
  await db.run('UPDATE users SET email_verified = 1, email_token = NULL WHERE id = ?', [u.id]);
  res.redirect('/?email=verified#/privacy');
}));
router.get('/email/unsubscribe', wrap(async (req, res) => {
  const id = parseInt(req.query.u, 10);
  const ok = Number.isInteger(id) && String(req.query.t || '') === hmac(`unsub:${id}`);
  if (ok) await db.run('UPDATE user_prefs SET weekly_email = 0 WHERE user_id = ?', [id]);
  res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width"><title>Synapse</title>
    <body style="font-family:system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 20px;color:#1C2A33">
    <h1>${ok ? "You're unsubscribed" : 'That link did not work'}</h1>
    <p>${ok ? "You won't get the weekly report any more. Turn it back on any time in Synapse &gt; Privacy." : 'Open Synapse &gt; Privacy to change email settings.'}</p>
    <p><a href="/#/privacy">Open Synapse</a></p></body>`);
}));
// External scheduler (e.g. the GitHub Actions workflow) wakes a sleeping server and sends due reports.
router.post('/cron/weekly', wrap(async (req, res) => {
  const key = process.env.CRON_SECRET;
  if (!key || req.get('x-cron-key') !== key) return res.status(404).json({ error: 'Not found.' });
  res.json(await weekly.runDue(ext.review));
}));

router.get('/health', (req, res) => res.json({ ok: true, db: db.dialect, llm: coach.llmEnabled, voice: voice.enabled ? 'livekit' : 'mesh' }));

// Everything below needs a signed-in user.
router.use(requireAuth);

get('/me', async (req, res) => {
  const u = await db.get('SELECT id, username, display_name, created_at, password_hash, google_sub, email FROM users WHERE id = ?', [req.user.id]);
  if (!u) return res.status(401).json({ error: 'Account no longer exists.' });
  res.json({
    user: { id: u.id, username: u.username, displayName: u.display_name, createdAt: u.created_at,
      hasPassword: hasPassword(u), google: !!u.google_sub, email: u.email || null },
    googleClientId: google.enabled ? google.clientId : null,
    hasSampleData: await sample.has(u.id),
    isAdmin: safety.isAdmin(u.username),
    suspended: await safety.suspended(u.id),
    blockedUserIds: (await db.all('SELECT blocked_id FROM blocks WHERE blocker_id = ?', [u.id])).map((r) => r.blocked_id),
    prefs: await prefs(u.id),
    consents: await consents(u.id),
    rewards: await game.summary(u.id),
    llmEnabled: coach.llmEnabled,
    voiceMode: voice.enabled ? 'livekit' : 'mesh',
    devices: await devices.list(u.id),
  });
});

// ---------- consent ----------
const CONSENT_FIELDS = ['activity_tracking', 'usage_tracking', 'ai_insights', 'community_profile'];
get('/consents', async (req, res) => res.json(await consents(req.user.id)));
put('/consents', async (req, res) => {
  await db.tx(async (t) => {
    const cur = await consents(req.user.id, t);
    for (const f of CONSENT_FIELDS) {
      if (req.body[f] === undefined) continue;
      const v = req.body[f] ? 1 : 0;
      if (v === cur[f]) continue;
      await t.run(`UPDATE consents SET ${f} = ?, updated_at = ? WHERE user_id = ?`, [v, db.now(), req.user.id]);
      await t.run('INSERT INTO consent_log (user_id, field, value) VALUES (?, ?, ?)', [req.user.id, f, v]);
    }
  });
  res.json(await consents(req.user.id));
});
get('/consents/log', async (req, res) =>
  res.json(await db.all('SELECT field, value, changed_at FROM consent_log WHERE user_id = ? ORDER BY id DESC LIMIT 100', [req.user.id]))
);

// ---------- focus sessions ----------
post('/sessions', requireConsent('activity_tracking', 'Save focus activity'), async (req, res) => {
  const result = await sessions.record(req.user.id, req.body);
  res.status(201).json({ ...result, rewards: await game.summary(req.user.id) });
});

get('/sessions', async (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
  res.json(await db.all(
    `SELECT id, kind, planned_min, actual_min, completed, tag, day, started_at, ended_at FROM focus_sessions
      WHERE user_id = ? AND day >= ? ORDER BY started_at DESC LIMIT 500`,
    [req.user.id, daysAgo(days)]
  ));
});

// Current timer state (lets the browser extension block distracting sites during focus).
put('/focus/state', async (req, res) => {
  await sessions.setFocusState(req.user.id, req.body);
  res.json({ ok: true });
});
get('/focus/state', async (req, res) => res.json(await sessions.getFocusState(req.user.id)));

// ---------- screen time ----------
put('/usage', requireConsent('usage_tracking', 'Save screen-time data'), async (req, res) => {
  const day = validDay(req.body.day);
  const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
  if (!entries.length || entries.length > 50) throw new HttpError(400, 'Provide 1-50 entries.');
  const clean = entries.map((e) => ({
    app: text(e.app, 'App/site name', 1, 60),
    category: CATEGORIES.includes(e.category) ? e.category : 'other',
    minutes: num(e.minutes, 'Minutes', 0, 1440),
  }));
  const existing = (await db.get(
    `SELECT COALESCE(SUM(minutes), 0) AS m FROM app_usage WHERE user_id = ? AND day = ? AND source = 'self' AND app NOT IN (${clean.map(() => '?').join(',')})`,
    [req.user.id, day, ...clean.map((c) => c.app)]
  )).m;
  if (existing + clean.reduce((s, c) => s + c.minutes, 0) > 1440) throw new HttpError(400, 'Total for the day cannot exceed 24 hours.');
  const out = [];
  await db.tx(async (t) => {
    for (const c of clean)
      await t.run(
        `INSERT INTO app_usage (user_id, day, app, category, minutes, source) VALUES (?, ?, ?, ?, ?, 'self')
         ON CONFLICT (user_id, day, app, source) DO UPDATE SET minutes = excluded.minutes, category = excluded.category`,
        [req.user.id, day, c.app, c.category, c.minutes]
      );
    await game.grant(req.user.id, 'usage_logged', out, t);
  });
  res.json({ ok: true, newMilestones: out });
});

// Synapse tab foreground time, sent by the dashboard in small increments.
post('/usage/foreground', requireConsent('usage_tracking', 'Save screen-time data'), async (req, res) => {
  const day = validDay(req.body.day, { maxPastDays: 2 });
  const minutes = num(req.body.minutes, 'minutes', 0, 10); // heartbeat chunks are <= 10 minutes
  const cur = await db.get(`SELECT minutes FROM app_usage WHERE user_id = ? AND day = ? AND app = 'Synapse AI' AND source = 'synapse'`, [req.user.id, day]);
  if ((cur?.minutes || 0) + minutes > 1440) throw new HttpError(400, 'Daily limit reached.');
  await db.run(
    `INSERT INTO app_usage (user_id, day, app, category, minutes, source) VALUES (?, ?, 'Synapse AI', 'work', ?, 'synapse')
     ON CONFLICT (user_id, day, app, source) DO UPDATE SET minutes = app_usage.minutes + excluded.minutes`,
    [req.user.id, day, minutes]
  );
  res.json({ ok: true });
});

del('/usage/:id', async (req, res) => {
  const r = await db.run('DELETE FROM app_usage WHERE id = ? AND user_id = ?', [intId(req.params.id), req.user.id]);
  if (!r.changes) throw new HttpError(404, 'Entry not found.');
  res.json({ ok: true });
});

get('/usage', async (req, res) => {
  const to = req.query.to ? validDay(req.query.to, { maxPastDays: 365 }) : serverToday();
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
  const from = new Date(Date.parse(to + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10);
  const rows = await db.all(
    'SELECT id, day, app, category, minutes, source FROM app_usage WHERE user_id = ? AND day BETWEEN ? AND ? ORDER BY day DESC, minutes DESC',
    [req.user.id, from, to]
  );
  const daily = dedupe(rows); // also marks rows.counted (overlapping sources count once)
  res.json({ from, to, entries: rows.map((r) => ({ ...r, counted: !!r.counted, sourceLabel: SOURCE_LABEL[r.source] || r.source })), daily, categories: CATEGORIES });
});

// ---------- daily limits ----------
// Today's minutes per limited app, using the same overlap rule as the totals.
async function limitsWithUsage(userId, day) {
  const limits = await db.all('SELECT id, app, minutes FROM app_limits WHERE user_id = ? ORDER BY app', [userId]);
  const rows = await db.all('SELECT day, app, category, minutes, source FROM app_usage WHERE user_id = ? AND day = ?', [userId, day]);
  dedupe(rows);
  const used = new Map();
  for (const r of rows) if (r.counted) used.set(appKey(r.app), (used.get(appKey(r.app)) || 0) + r.minutes);
  return limits.map((l) => {
    const usedMin = Math.round((used.get(appKey(l.app)) || 0) * 10) / 10;
    return { ...l, used: usedMin, ratio: l.minutes ? usedMin / l.minutes : 0 };
  });
}

get('/limits', async (req, res) => {
  const day = req.query.day ? validDay(req.query.day, { maxPastDays: 2 }) : serverToday();
  res.json({ day, limits: await limitsWithUsage(req.user.id, day) });
});
put('/limits', async (req, res) => {
  let app = text(req.body.app, 'App or site', 1, 60);
  app = app.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '') || app;
  const minutes = Math.round(num(req.body.minutes, 'Daily limit (minutes)', 5, 1440));
  const count = (await db.get('SELECT COUNT(*) AS n FROM app_limits WHERE user_id = ?', [req.user.id])).n;
  const exists = await db.get('SELECT id FROM app_limits WHERE user_id = ? AND app = ?', [req.user.id, app]);
  if (!exists && count >= 30) throw new HttpError(400, 'You can set up to 30 limits.');
  await db.run(
    `INSERT INTO app_limits (user_id, app, minutes) VALUES (?, ?, ?)
     ON CONFLICT (user_id, app) DO UPDATE SET minutes = excluded.minutes`,
    [req.user.id, app, minutes]
  );
  res.json({ ok: true, app, minutes });
});
del('/limits/:id', async (req, res) => {
  const r = await db.run('DELETE FROM app_limits WHERE id = ? AND user_id = ?', [intId(req.params.id), req.user.id]);
  if (!r.changes) throw new HttpError(404, 'Limit not found.');
  res.json({ ok: true });
});

// ---------- mood check-ins (private, feed the insights) ----------
put('/checkins', requireConsent('ai_insights', 'AI wellbeing insights'), async (req, res) => {
  const day = validDay(req.body.day, { maxPastDays: 7 });
  const energy = Math.round(num(req.body.energy, 'Energy', 1, 5));
  const stress = Math.round(num(req.body.stress, 'Stress', 1, 5));
  const sleep = req.body.sleepHours === '' || req.body.sleepHours == null ? null : num(req.body.sleepHours, 'Sleep hours', 0, 16);
  await db.run(
    `INSERT INTO mood_checkins (user_id, day, energy, stress, sleep_h) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, day) DO UPDATE SET energy = excluded.energy, stress = excluded.stress, sleep_h = excluded.sleep_h`,
    [req.user.id, day, energy, stress, sleep]
  );
  res.json({ ok: true });
});
get('/checkins', async (req, res) =>
  res.json(await db.all('SELECT day, energy, stress, sleep_h FROM mood_checkins WHERE user_id = ? ORDER BY day DESC LIMIT 30', [req.user.id]))
);

// ---------- insights + coach ----------
get('/insights', requireConsent('ai_insights', 'AI wellbeing insights'), async (req, res) => {
  const day = req.query.day ? validDay(req.query.day) : serverToday();
  res.json(await analyze(req.user.id, day));
});

// "How the AI works": model card with real evaluation numbers and your personal model's status.
get('/model', requireConsent('ai_insights', 'AI wellbeing insights'), async (req, res) => {
  const day = req.query.day ? validDay(req.query.day) : serverToday();
  res.json(await modelCard(req.user.id, day));
});

// ---------- rest days ----------
const weekOf = (day) => { const d = new Date(`${day}T12:00:00Z`); const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6); return [mon.toISOString().slice(0, 10), sun.toISOString().slice(0, 10)]; };
get('/rest-days', async (req, res) => {
  res.json((await db.all('SELECT day FROM rest_days WHERE user_id = ? ORDER BY day DESC LIMIT 60', [req.user.id])).map((r) => r.day));
});
const restDay = (v) => {
  if (typeof v !== 'string' || !DAY_RE.test(v) || isNaN(Date.parse(v + 'T00:00:00Z'))) throw new HttpError(400, 'Invalid day (expected YYYY-MM-DD).');
  return v;
};
post('/rest-days', async (req, res) => {
  const day = restDay(req.body.day);
  let today = req.body.today && DAY_RE.test(req.body.today) ? req.body.today : serverToday();
  // The browser's "today" is trusted only within a day of the server's (time zones).
  if (Math.abs(Date.parse(today) - Date.parse(serverToday())) > 2 * 86400000) today = serverToday();
  const ahead = (Date.parse(day) - Date.parse(today)) / 86400000;
  if (ahead < 0 || ahead > 14) throw new HttpError(400, 'Plan rest days from today up to two weeks ahead.');
  const [mon, sun] = weekOf(day);
  const n = await db.get('SELECT COUNT(*) AS n FROM rest_days WHERE user_id = ? AND day BETWEEN ? AND ? AND day <> ?', [req.user.id, mon, sun, day]);
  if (Number(n.n) >= 2) throw new HttpError(400, 'Two rest days a week keep the streak meaningful. Pick another week.');
  await db.run('INSERT INTO rest_days (user_id, day) VALUES (?, ?) ON CONFLICT DO NOTHING', [req.user.id, day]);
  res.status(201).json({ ok: true, day });
});
del('/rest-days/:day', async (req, res) => {
  await db.run('DELETE FROM rest_days WHERE user_id = ? AND day = ?', [req.user.id, restDay(req.params.day)]);
  res.json({ ok: true });
});

const coachLimiter = rateLimit({ windowMs: 60 * 1000, limit: 12, keyGenerator: (req) => String(req.user.id), standardHeaders: true, legacyHeaders: false });
post('/coach', coachLimiter, requireConsent('ai_insights', 'AI wellbeing insights'), async (req, res) => {
  const message = text(req.body.message, 'Message', 1, 1000);
  const day = req.body.day ? validDay(req.body.day) : serverToday();
  const history = Array.isArray(req.body.history) ? req.body.history.slice(-6) : [];
  res.json(await coach.reply(message, await analyze(req.user.id, day), history));
});

// ---------- rewards ----------
get('/rewards', async (req, res) => {
  const out = await game.summary(req.user.id);
  // Before the first real tree, show what the sample sessions would grow (marked sample, nothing granted).
  if (!out.trees) { const pv = await game.samplePreview(req.user.id); if (pv) out.sample = pv; }
  res.json(out);
});

// ---------- progress stats ----------
// Everything the Progress page needs, computed from the user's own sessions and screen time.
get('/stats', async (req, res) => {
  const today = req.query.today ? validDay(req.query.today, { maxPastDays: 2 }) : serverToday();
  const days = Math.min(371, Math.max(7, parseInt(req.query.days, 10) || 182));
  const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const from = shift(today, -(days - 1));
  const sessions = await db.all(
    'SELECT kind, planned_min, actual_min, completed, tag, day, started_at FROM focus_sessions WHERE user_id = ? AND day BETWEEN ? AND ?',
    [req.user.id, from, today]
  );
  const usage = dedupe(await db.all(
    'SELECT day, app, category, minutes, source FROM app_usage WHERE user_id = ? AND day BETWEEN ? AND ?',
    [req.user.id, shift(today, -55), today]
  ));

  // Daily focus minutes (completed focus blocks) for the heatmap.
  const daily = {};
  for (const s of sessions) if (s.kind === 'focus' && s.completed) daily[s.day] = (daily[s.day] || 0) + s.actual_min;

  // Last 8 weeks (ending today): focus vs screen time, both in minutes.
  const weeks = [];
  for (let w = 7; w >= 0; w--) {
    const end = shift(today, -7 * w), start = shift(end, -6);
    const inWeek = (d) => d >= start && d <= end;
    weeks.push({
      start, end,
      focus: Math.round(Object.entries(daily).filter(([d]) => inWeek(d)).reduce((a, [, m]) => a + m, 0)),
      screen: Math.round(usage.filter((u) => inWeek(u.day)).reduce((a, u) => a + u.total, 0)),
      screenDays: usage.filter((u) => inWeek(u.day)).length,
    });
  }

  // When you focus: completed focus minutes by local starting hour.
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, minutes: 0, sessions: 0 }));
  for (const s of sessions) {
    if (s.kind !== 'focus' || !s.completed) continue;
    const h = parseInt(String(s.started_at).slice(11, 13), 10);
    if (h >= 0 && h < 24) { hours[h].minutes += s.actual_min; hours[h].sessions += 1; }
  }
  hours.forEach((h) => (h.minutes = Math.round(h.minutes)));

  // Which block lengths you actually finish.
  const lengths = {};
  for (const s of sessions) {
    if (s.kind !== 'focus') continue;
    const k = s.planned_min;
    lengths[k] ??= { planned: k, started: 0, completed: 0 };
    lengths[k].started += 1;
    if (s.completed) lengths[k].completed += 1;
  }

  // What you focus on.
  const tags = {};
  for (const s of sessions) if (s.kind === 'focus' && s.completed && s.tag) tags[s.tag] = (tags[s.tag] || 0) + s.actual_min;

  const focusSessions = sessions.filter((s) => s.kind === 'focus');
  const done = focusSessions.filter((s) => s.completed);
  const activeDays = Object.keys(daily).length;
  const totalFocus = done.reduce((a, s) => a + s.actual_min, 0);
  const rewards = await game.summary(req.user.id);
  res.json({
    from, today, days,
    totals: {
      focusMinutes: Math.round(totalFocus),
      sessions: done.length,
      breaks: sessions.filter((s) => s.kind === 'break' && s.completed).length,
      completionRate: focusSessions.length ? done.length / focusSessions.length : null,
      activeDays,
      avgPerActiveDay: activeDays ? Math.round(totalFocus / activeDays) : 0,
      bestStreak: rewards.bestStreak,
      currentStreak: rewards.currentStreak,
    },
    daily,
    weeks,
    hours,
    lengths: Object.values(lengths).sort((a, b) => a.planned - b.planned),
    tags: Object.entries(tags).map(([tag, minutes]) => ({ tag, minutes: Math.round(minutes) })).sort((a, b) => b.minutes - a.minutes).slice(0, 8),
  });
});

// ---------- community ----------
const MOODS = ['calm', 'focused', 'proud', 'tired', 'stressed', 'hopeful'];
const REACTIONS = ['cheer', 'hug', 'same'];

/**
 * Community feed. opts: before (id, for "latest"), offset (for "top"), sort 'latest'|'top' (most supported in
 * the last 7 days), mood, q (search), scope 'all'|'mine'|'buddies' (named posts by your buddies only).
 */
async function feed(userId, limit, beforeId, opts = {}) {
  const vis = safety.visible('p', 'post', userId, { hiddenPosts: true });
  const params = [...vis.params];
  let where = `WHERE ${vis.sql}`;
  if (beforeId && opts.sort !== 'top') { where += ' AND p.id < ?'; params.push(beforeId); }
  if (opts.mood && MOODS.includes(opts.mood)) { where += ' AND p.mood = ?'; params.push(opts.mood); }
  if (opts.q) { where += ' AND lower(p.body) LIKE ?'; params.push(`%${String(opts.q).toLowerCase().replace(/[%_]/g, '').slice(0, 60)}%`); }
  if (opts.scope === 'mine') { where += ' AND p.user_id = ?'; params.push(userId); }
  if (opts.scope === 'buddies') {
    where += ` AND COALESCE(c.community_profile, 1) = 1 AND p.user_id IN (
      SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END FROM buddies WHERE (requester_id = ? OR addressee_id = ?) AND status = 'accepted')`;
    params.push(userId, userId, userId);
  }
  let order = 'ORDER BY p.id DESC';
  if (opts.sort === 'top') {
    where += ' AND p.created_at >= ?';
    params.push(new Date(Date.now() - 7 * 86400000).toISOString().replace('T', ' ').slice(0, 19));
    order = `ORDER BY ((SELECT COUNT(*) FROM reactions rx WHERE rx.post_id = p.id) + 2 * (SELECT COUNT(*) FROM post_replies pr WHERE pr.post_id = p.id)) DESC, p.id DESC`;
  }
  params.push(limit);
  let paging = 'LIMIT ?';
  if (opts.sort === 'top' && opts.offset) { paging += ' OFFSET ?'; params.push(Math.min(500, Math.max(0, opts.offset))); }
  const rows = await db.all(
    `SELECT p.id, p.mood, p.body, p.created_at, p.user_id, p.sensitive, p.cw,
            CASE WHEN c.community_profile = 0 THEN 'Anonymous member' ELSE u.display_name END AS author
       FROM posts p JOIN users u ON u.id = p.user_id LEFT JOIN consents c ON c.user_id = p.user_id
      ${where} ${order} ${paging}`,
    params
  );
  const ids = rows.map((r) => r.id);
  const rx = ids.length
    ? await db.all(
      `SELECT post_id, kind, COUNT(*) AS n, SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine
         FROM reactions WHERE post_id IN (${ids.map(() => '?').join(',')}) GROUP BY post_id, kind`,
      [userId, ...ids]
    )
    : [];
  const replies = ids.length ? await repliesFor(userId, ids) : [];
  const lv = await game.publicLevels(rows.filter((r) => r.author !== 'Anonymous member').map((r) => r.user_id));
  const imgs = ids.length ? await db.all(`SELECT id, post_id, width, height FROM images WHERE post_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at`, ids) : [];
  return rows.map((p) => {
    const reactions = Object.fromEntries(REACTIONS.map((k) => [k, { count: 0, mine: false }]));
    for (const r of rx) if (r.post_id === p.id) reactions[r.kind] = { count: r.n, mine: !!r.mine };
    const { user_id, ...rest } = p;
    return { ...rest, sensitive: !!p.sensitive, isMine: user_id === userId, reactions, level: lv[user_id] || null,
      images: imgs.filter((i) => i.post_id === p.id).map((i) => ({ url: `/api/img/${i.id}`, width: i.width, height: i.height })),
      replies: replies.filter((r) => r.post_id === p.id).map(({ post_id, ...r }) => r) };
  });
}

async function repliesFor(userId, postIds) {
  const rows = await db.all(
    `SELECT r.id, r.post_id, r.body, r.created_at, r.user_id,
            CASE WHEN c.community_profile = 0 THEN 'Anonymous member' ELSE u.display_name END AS author
       FROM post_replies r JOIN users u ON u.id = r.user_id LEFT JOIN consents c ON c.user_id = r.user_id
      WHERE r.post_id IN (${postIds.map(() => '?').join(',')}) AND ${safety.visible('r', 'reply', userId).sql} ORDER BY r.id`,
    [...postIds, ...safety.visible('r', 'reply', userId).params]
  );
  const lv = await game.publicLevels(rows.filter((r) => r.author !== 'Anonymous member').map((r) => r.user_id));
  return rows.map(({ user_id, ...r }) => ({ ...r, isMine: user_id === userId, level: lv[user_id] || null }));
}

get('/posts', async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const before = req.query.before ? parseInt(req.query.before, 10) || null : null;
  const opts = { sort: req.query.sort === 'top' ? 'top' : 'latest', mood: req.query.mood || null, q: (req.query.q || '').trim() || null,
    scope: ['mine', 'buddies'].includes(req.query.scope) ? req.query.scope : 'all', offset: parseInt(req.query.offset, 10) || 0 };
  res.json({ posts: await feed(req.user.id, limit, before, opts), moods: MOODS, reactions: REACTIONS });
});

// ---------- images (community posts) ----------
const MAGIC = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46] };
const imageLimiter = rateLimit({ windowMs: 24 * 60 * 60 * 1000, limit: 40, keyGenerator: (req) => String(req.user.id), standardHeaders: true, legacyHeaders: false });
// POST /images { data: "data:image/jpeg;base64,...", width, height } -> { id, url }. Attach to a post within a day.
post('/images', imageLimiter, async (req, res) => {
  await notSuspended(req);
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.data || ''));
  if (!m) throw new HttpError(400, 'Upload a JPEG, PNG or WebP image.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 1_600_000) throw new HttpError(413, 'That image is too large (max about 1.5 MB after resizing).');
  const magic = MAGIC[m[1]];
  if (!magic.every((b, i) => buf[i] === b) || (m[1] === 'image/webp' && buf.slice(8, 12).toString() !== 'WEBP'))
    throw new HttpError(400, "That file isn't a valid image.");
  const id = crypto.randomBytes(18).toString('base64url');
  const dim = (v) => (Number.isInteger(v) && v > 0 && v <= 4096 ? v : null);
  await db.run('INSERT INTO images (id, user_id, mime, data, bytes, width, height) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, req.user.id, m[1], m[2], buf.length, dim(req.body.width), dim(req.body.height)]);
  res.status(201).json({ id, url: `/api/img/${id}` });
});

// Words that suggest someone may be in crisis (English, Hinglish, Hindi). Not a diagnosis: it only triggers a
// supportive message to the writer, a blur for readers and an urgent flag for admins.
const CRISIS = /\b(kill(ing)? myself|suicid(e|al)|end (it all|my life)|want(ed)? to die|wanna die|better off dead|no reason to (live|go on)|self[- ]?harm|hurt(ing)? myself|cut(ting)? myself|marna chaht[aie]|mar jaun|khudkushi|jaan de (du|doon|dunga|dungi))\b|आत्महत्या|मरना चाहत|खुदकुशी/i;
const HELP = [
  { name: 'Tele-MANAS (India, free, 24/7)', contact: '14416 or 1-800-891-4416' },
  { name: 'KIRAN mental health helpline (India)', contact: '1800-599-0019' },
  { name: 'Emergency', contact: '112' },
];

const postLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 10, keyGenerator: (req) => String(req.user.id), standardHeaders: true, legacyHeaders: false });
const notSuspended = async (req) => {
  if (await safety.suspended(req.user.id)) throw new HttpError(403, "Your account can't post in the community right now. Contact the site admin if you think this is a mistake.");
};
post('/posts', postLimiter, async (req, res) => {
  await notSuspended(req);
  const mood = MOODS.includes(req.body.mood) ? req.body.mood : null;
  if (!mood) throw new HttpError(400, 'Pick a mood.');
  const body = text(req.body.body, 'Check-in', 2, 500);
  const imageIds = Array.isArray(req.body.images) ? [...new Set(req.body.images.map(String))].slice(0, 5) : [];
  if (imageIds.length > 4) throw new HttpError(400, 'Up to 4 images per check-in.');
  if (imageIds.length) {
    const mine = await db.all(`SELECT id FROM images WHERE user_id = ? AND post_id IS NULL AND id IN (${imageIds.map(() => '?').join(',')})`, [req.user.id, ...imageIds]);
    if (mine.length !== imageIds.length) throw new HttpError(400, 'Some images are missing. Add them again.');
  }
  const crisis = CRISIS.test(body);
  // Check with the writer first: they see support options and can still post (blurred, flagged for care).
  if (crisis && !req.body.acknowledgeSupport) return res.status(200).json({ needsSupport: true, help: HELP });
  const sensitive = crisis || !!req.body.sensitive;
  const cw = crisis ? 'Mentions self-harm or suicide' : req.body.sensitive ? (req.body.cw ? text(req.body.cw, 'Content warning', 1, 60) : 'Sensitive') : null;
  const id = await db.insert('INSERT INTO posts (user_id, mood, body, sensitive, cw) VALUES (?, ?, ?, ?, ?)', [req.user.id, mood, body, sensitive ? 1 : 0, cw]);
  if (imageIds.length) await db.run(`UPDATE images SET post_id = ? WHERE user_id = ? AND id IN (${imageIds.map(() => '?').join(',')})`, [id, req.user.id, ...imageIds]);
  if (crisis) // urgent item in the admin queue so a person can check in
    await db.insert("INSERT INTO reports (reporter_id, target_type, target_id, target_user_id, reason, note, snapshot) VALUES (?, 'post', ?, ?, 'selfharm', ?, ?)",
      [req.user.id, id, req.user.id, 'Automatic: possible crisis language. Consider reaching out kindly.', body.slice(0, 1000)]);
  const out = [];
  await game.grant(req.user.id, 'first_post', out);
  req.app.get('io')?.emit('community:new', { id });
  res.status(201).json({ id, newMilestones: out, sensitive, help: crisis ? HELP : undefined });
});

post('/posts/:id/react', async (req, res) => {
  const kind = REACTIONS.includes(req.body.kind) ? req.body.kind : null;
  if (!kind) throw new HttpError(400, 'Unknown reaction.');
  const post_ = await db.get('SELECT id FROM posts WHERE id = ?', [intId(req.params.id)]);
  if (!post_) throw new HttpError(404, 'Post not found.');
  const removed = await db.run('DELETE FROM reactions WHERE post_id = ? AND user_id = ? AND kind = ?', [post_.id, req.user.id, kind]);
  if (!removed.changes)
    await db.run('INSERT INTO reactions (post_id, user_id, kind) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [post_.id, req.user.id, kind]);
  res.json({ active: !removed.changes });
});

// Replies to a check-in.
const replyLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, keyGenerator: (req) => String(req.user.id), standardHeaders: true, legacyHeaders: false });
post('/posts/:id/replies', replyLimiter, async (req, res) => {
  await notSuspended(req);
  const p = await db.get('SELECT id FROM posts WHERE id = ?', [intId(req.params.id)]);
  if (!p) throw new HttpError(404, 'Post not found.');
  const body = text(req.body.body, 'Reply', 1, 400);
  const id = await db.insert('INSERT INTO post_replies (post_id, user_id, body) VALUES (?, ?, ?)', [p.id, req.user.id, body]);
  req.app.get('io')?.emit('community:reply', { postId: p.id, id });
  res.status(201).json({ id, replies: await repliesFor(req.user.id, [p.id]) });
});
del('/posts/:id/replies/:rid', async (req, res) => {
  const r = await db.run('DELETE FROM post_replies WHERE id = ? AND post_id = ? AND user_id = ?', [intId(req.params.rid), intId(req.params.id), req.user.id]);
  if (!r.changes) throw new HttpError(404, 'Reply not found or not yours.');
  res.json({ ok: true });
});

del('/posts/:id', async (req, res) => {
  const r = await db.run('DELETE FROM posts WHERE id = ? AND user_id = ?', [intId(req.params.id), req.user.id]);
  if (!r.changes) throw new HttpError(404, 'Post not found or not yours.');
  res.json({ ok: true });
});

// ---------- rooms ----------
get('/rooms', async (req, res) => {
  const presence = req.app.get('presence') || (() => []);
  res.json((await db.all('SELECT id, name, description FROM rooms ORDER BY name')).map((r) => ({ ...r, members: presence(r.id) })));
});
get('/rooms/:id/messages', async (req, res) => {
  const rows = await db.all(
    `SELECT m.id, m.body, m.created_at, m.user_id AS "userId", u.display_name AS author, CASE WHEN m.user_id = ? THEN 1 ELSE 0 END AS "isMine",
            m.reply_to AS "replyId", pu.display_name AS "replyAuthor", p.body AS "replyBody"
       FROM room_messages m JOIN users u ON u.id = m.user_id
       LEFT JOIN room_messages p ON p.id = m.reply_to LEFT JOIN users pu ON pu.id = p.user_id
      WHERE m.room_id = ? AND ${safety.visible('m', 'message', req.user.id).sql} ORDER BY m.id DESC LIMIT 50`,
    [req.user.id, String(req.params.id), ...safety.visible('m', 'message', req.user.id).params]
  );
  const lv = await game.publicLevels(rows.map((r) => r.userId));
  res.json(rows.reverse().map(({ replyId, replyAuthor, replyBody, ...m }) => ({
    level: lv[m.userId] || null,
    ...m, reply: replyId ? { id: replyId, author: replyAuthor || 'Deleted message', body: replyBody ? String(replyBody).slice(0, 140) : '' } : null })));
});

// ---------- connected devices (extension / desktop tracker) ----------
get('/devices', async (req, res) => res.json(await devices.list(req.user.id)));
post('/devices', async (req, res) => {
  const kind = devices.KINDS[req.body.kind];
  if (!kind) throw new HttpError(400, 'kind must be "extension", "desktop" or "phone".');
  const DEFAULT_NAMES = { extension: 'Browser extension', desktop: 'Desktop tracker', phone: 'Android phone' };
  const name = text(req.body.name || DEFAULT_NAMES[kind], 'Name', 1, 40);
  if ((await devices.list(req.user.id)).length >= 10) throw new HttpError(400, 'You can connect up to 10 devices. Revoke one first.');
  const { id, token } = await devices.create(req.user.id, name, kind);
  res.status(201).json({ id, token, name, kind, note: 'Copy this key now. It will not be shown again.' });
});
del('/devices/:id', async (req, res) => {
  if (!(await devices.revoke(req.user.id, intId(req.params.id)))) throw new HttpError(404, 'Device not found.');
  res.json({ ok: true });
});

// ---------- voice ----------
get('/rooms/:id/voice', async (req, res) => {
  if (!(await db.get('SELECT 1 AS ok FROM rooms WHERE id = ?', [String(req.params.id)]))) throw new HttpError(404, 'Room not found.');
  if (!voice.enabled) return res.json({ mode: 'mesh', maxPeers: voice.MESH_LIMIT });
  res.json({ mode: 'livekit', url: voice.url, token: await voice.tokenFor(req.user, req.params.id) });
});

// ---------- export & deletion ----------
get('/export', async (req, res) => {
  const id = req.user.id;
  const q = (sql) => db.all(sql, [id]);
  const data = {
    exportedAt: new Date().toISOString(),
    account: await db.get('SELECT id, username, display_name, created_at FROM users WHERE id = ?', [id]),
    consents: await consents(id),
    consentLog: await q('SELECT field, value, changed_at FROM consent_log WHERE user_id = ? ORDER BY id'),
    focusSessions: await q('SELECT kind, planned_min, actual_min, completed, tag, day, started_at, ended_at FROM focus_sessions WHERE user_id = ? ORDER BY id'),
    appUsage: await q('SELECT day, app, category, minutes, source FROM app_usage WHERE user_id = ? ORDER BY day'),
    dailyLimits: await q('SELECT app, minutes, created_at FROM app_limits WHERE user_id = ? ORDER BY app'),
    moodCheckins: await q('SELECT day, energy, stress, sleep_h FROM mood_checkins WHERE user_id = ? ORDER BY day'),
    rewards: await game.summary(id),
    communityPosts: await q('SELECT id, mood, body, created_at FROM posts WHERE user_id = ? ORDER BY id'),
    reactionsGiven: await q('SELECT post_id, kind, created_at FROM reactions WHERE user_id = ?'),
    roomMessages: await q('SELECT room_id, body, created_at FROM room_messages WHERE user_id = ? ORDER BY id'),
    tasks: await q('SELECT title, estimate, blocks_done, done, day, done_day FROM tasks WHERE user_id = ? ORDER BY id'),
    preferences: await prefs(id),
    email: (await db.get('SELECT email, email_verified FROM users WHERE id = ?', [id])),
    distractions: await q('SELECT day, at, kind, note FROM distractions WHERE user_id = ? ORDER BY id'),
    roomVisits: await q('SELECT room_id, day, seconds, joined_at FROM room_visits WHERE user_id = ? ORDER BY id'),
    buddies: await db.all(`SELECT u.display_name AS name, b.status, b.created_at FROM buddies b JOIN users u
      ON u.id = CASE WHEN b.requester_id = ? THEN b.addressee_id ELSE b.requester_id END WHERE b.requester_id = ? OR b.addressee_id = ?`, [id, id, id]),
    cheersReceived: await q('SELECT kind, created_at FROM cheers WHERE to_id = ? ORDER BY id'),
    images: await q('SELECT id, post_id, mime, bytes, created_at FROM images WHERE user_id = ? ORDER BY created_at'),
    communityReplies: await q('SELECT post_id, body, created_at FROM post_replies WHERE user_id = ? ORDER BY id'),
    connectedDevices: await q('SELECT name, kind, created_at, last_used_at, revoked_at FROM device_tokens WHERE user_id = ? ORDER BY id'),
  };
  res.setHeader('Content-Disposition', `attachment; filename="synapse-export-${serverToday()}.json"`);
  res.json(data);
});

const DELETE_SCOPES = {
  activity: ['focus_sessions', 'trees', 'milestones', 'rewards', 'focus_state', 'tasks', 'distractions', 'room_visits', 'rest_days'],
  usage: ['app_usage', 'app_limits'],
  wellbeing: ['mood_checkins'],
  community: ['images', 'posts', 'post_replies', 'reactions', 'room_messages', 'hidden_posts'],
};
del('/data', async (req, res) => {
  const scope = req.body.scope;
  const tables = scope === 'all' ? Object.values(DELETE_SCOPES).flat() : DELETE_SCOPES[scope];
  if (!tables) throw new HttpError(400, 'scope must be activity, usage, wellbeing, community or all.');
  await db.tx(async (t) => {
    for (const table of tables) await t.run(`DELETE FROM ${table} WHERE user_id = ?`, [req.user.id]);
  });
  res.json({ ok: true, deleted: scope });
});

// ---------- tasks ----------
const dayParam = (v) => (DAY_RE.test(String(v || '')) ? String(v) : new Date().toISOString().slice(0, 10));
const TASK_COLS = 'id, title, estimate, blocks_done AS "blocksDone", done, day, done_day AS "doneDay", position';
// Open tasks (from any day) plus the ones finished today.
get('/tasks', async (req, res) => {
  const day = dayParam(req.query.day);
  res.json(await db.all(`SELECT ${TASK_COLS} FROM tasks WHERE user_id = ? AND (done = 0 OR done_day = ?) ORDER BY done, position, id`, [req.user.id, day]));
});
post('/tasks', async (req, res) => {
  const title = text(req.body.title, 'Task', 1, 120);
  const estimate = Math.min(8, Math.max(1, parseInt(req.body.estimate, 10) || 1));
  const open = await db.get('SELECT COUNT(*) AS n, MAX(position) AS p FROM tasks WHERE user_id = ? AND done = 0', [req.user.id]);
  if (Number(open.n) >= 50) throw new HttpError(400, 'That is a lot of open tasks. Finish or delete a few first.');
  const id = await db.insert('INSERT INTO tasks (user_id, title, estimate, day, position) VALUES (?, ?, ?, ?, ?)',
    [req.user.id, title, estimate, dayParam(req.body.day), (Number(open.p) || 0) + 1]);
  res.status(201).json(await db.get(`SELECT ${TASK_COLS} FROM tasks WHERE id = ?`, [id]));
});
put('/tasks/:id', async (req, res) => {
  const t = await db.get('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [intId(req.params.id), req.user.id]);
  if (!t) throw new HttpError(404, 'Task not found.');
  const title = req.body.title !== undefined ? text(req.body.title, 'Task', 1, 120) : t.title;
  const estimate = req.body.estimate !== undefined ? Math.min(8, Math.max(1, parseInt(req.body.estimate, 10) || 1)) : t.estimate;
  const done = req.body.done !== undefined ? (req.body.done ? 1 : 0) : t.done;
  const doneDay = done ? (t.done ? t.done_day : dayParam(req.body.day)) : null;
  await db.run('UPDATE tasks SET title = ?, estimate = ?, done = ?, done_day = ? WHERE id = ?', [title, estimate, done, doneDay, t.id]);
  res.json(await db.get(`SELECT ${TASK_COLS} FROM tasks WHERE id = ?`, [t.id]));
});
del('/tasks/:id', async (req, res) => {
  const r = await db.run('DELETE FROM tasks WHERE id = ? AND user_id = ?', [intId(req.params.id), req.user.id]);
  if (!r.changes) throw new HttpError(404, 'Task not found.');
  res.json({ ok: true });
});

// ---------- preferences: daily goal, leaderboard ----------
async function prefs(userId) {
  const p = await db.get('SELECT daily_goal_min, leaderboard, weekly_email, tz, blur_images FROM user_prefs WHERE user_id = ?', [userId]);
  return { dailyGoalMin: p ? p.daily_goal_min : 120, leaderboard: !!p?.leaderboard, weeklyEmail: !!p?.weekly_email, tz: p?.tz || null, blurImages: !!p?.blur_images };
}
get('/prefs', async (req, res) => res.json(await prefs(req.user.id)));
put('/prefs', async (req, res) => {
  const cur = await prefs(req.user.id);
  const goal = req.body.dailyGoalMin !== undefined ? Math.min(720, Math.max(15, parseInt(req.body.dailyGoalMin, 10) || 120)) : cur.dailyGoalMin;
  const lb = req.body.leaderboard !== undefined ? !!req.body.leaderboard : cur.leaderboard;
  const we = req.body.weeklyEmail !== undefined ? !!req.body.weeklyEmail : cur.weeklyEmail;
  const blur = req.body.blurImages !== undefined ? !!req.body.blurImages : cur.blurImages;
  let tz = cur.tz;
  if (req.body.tz !== undefined) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: String(req.body.tz) }); tz = String(req.body.tz).slice(0, 64); } catch { throw new HttpError(400, 'Unknown time zone.'); }
  }
  await db.run(`INSERT INTO user_prefs (user_id, daily_goal_min, leaderboard, weekly_email, tz, blur_images) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET daily_goal_min = excluded.daily_goal_min, leaderboard = excluded.leaderboard,
      weekly_email = excluded.weekly_email, tz = excluded.tz, blur_images = excluded.blur_images`, [req.user.id, goal, lb ? 1 : 0, we ? 1 : 0, tz, blur ? 1 : 0]);
  res.json(await prefs(req.user.id));
});

// Weekly focus leaderboard: only people who opted in are listed; you always see your own total.
get('/leaderboard', async (req, res) => {
  const from = dayParam(req.query.from);
  const to = (() => { const d = new Date(`${from}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 6); return d.toISOString().slice(0, 10); })();
  const rows = await db.all(
    `SELECT u.id, u.display_name AS name, SUM(s.actual_min) AS minutes, COUNT(*) AS blocks
       FROM focus_sessions s JOIN users u ON u.id = s.user_id JOIN user_prefs p ON p.user_id = s.user_id
      WHERE p.leaderboard = 1 AND s.kind = 'focus' AND s.completed = 1 AND s.sample = 0 AND s.day BETWEEN ? AND ?
      GROUP BY u.id, u.display_name ORDER BY minutes DESC, u.id LIMIT 20`, [from, to]);
  const mine = await db.get(
    `SELECT COALESCE(SUM(actual_min), 0) AS minutes, COUNT(*) AS blocks FROM focus_sessions
      WHERE user_id = ? AND kind = 'focus' AND completed = 1 AND sample = 0 AND day BETWEEN ? AND ?`, [req.user.id, from, to]);
  res.json({
    from, to, optedIn: (await prefs(req.user.id)).leaderboard,
    me: { minutes: Number(mine.minutes) || 0, blocks: Number(mine.blocks) || 0 },
    rows: await (async () => { const lv = await game.publicLevels(rows.map((r) => r.id));
      return rows.map((r, i) => ({ rank: i + 1, name: r.name, minutes: Math.round(Number(r.minutes)), blocks: Number(r.blocks), isMe: r.id === req.user.id, level: lv[r.id] || null })); })(),
  });
});

// ---------- sample data ----------
// Three weeks of clearly marked sample activity so a new account can see Progress and Insights working.
post('/sample-data', async (req, res) => {
  res.status(201).json(await sample.add(req.user.id, req.body.today, req.body.now));
});
del('/sample-data', async (req, res) => {
  await sample.remove(req.user.id);
  res.json({ ok: true });
});

// ---------- Google link ----------
// Link Google to an existing account so it can sign in with either.
post('/account/google', async (req, res) => {
  const g = await googleIdentity(req.body.credential);
  const other = await db.get('SELECT id FROM users WHERE google_sub = ?', [g.sub]);
  if (other && other.id !== req.user.id) throw new HttpError(409, 'That Google account is already used by another Synapse account.');
  if (g.emailVerified) await db.run('UPDATE users SET google_sub = ?, email = ?, email_verified = 1, email_token = NULL WHERE id = ?', [g.sub, g.email, req.user.id]);
  else await db.run('UPDATE users SET google_sub = ? WHERE id = ?', [g.sub, req.user.id]);
  res.json({ ok: true, email: g.emailVerified ? g.email : null });
});
del('/account/google', async (req, res) => {
  const u = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!hasPassword(u)) throw new HttpError(400, "Google is this account's only way to sign in, so it can't be unlinked.");
  await db.run('UPDATE users SET google_sub = NULL WHERE id = ?', [req.user.id]);
  res.json({ ok: true });
});

del('/account', async (req, res) => {
  const user = await db.get('SELECT username, password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!user) throw new HttpError(401, 'Account no longer exists.');
  if (hasPassword(user)) {
    if (!(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) throw new HttpError(401, 'Password is incorrect.');
  } else if (String(req.body.confirm || '').trim().toLowerCase() !== user.username) {
    throw new HttpError(400, `Type your username (${user.username}) to confirm.`);
  }
  await db.run('DELETE FROM users WHERE id = ?', [req.user.id]); // ON DELETE CASCADE removes everything
  res.json({ ok: true });
});

// ---------- community safety (safety.js) ----------
safety.routes({ get, post, del, HttpError, text, intId, rateLimit });

// ---------- burnout-prevention extras (extras.js) ----------
ext = require('./extras')({ get, post, del, HttpError, text, intId, requireConsent, prefs, db, analyze, game });

// ---------- weekly email report (weekly.js) ----------
const emailLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, keyGenerator: (req) => String(req.user.id), standardHeaders: true, legacyHeaders: false });
get('/email', async (req, res) => {
  const u = await db.get('SELECT email, email_verified, email_token FROM users WHERE id = ?', [req.user.id]);
  const p = await prefs(req.user.id);
  res.json({ email: u.email, verified: !!u.email_verified, pending: !!u.email_token, weekly: p.weeklyEmail, tz: p.tz, mailEnabled: mailer.enabled });
});
put('/email', emailLimiter, async (req, res) => {
  if (!mailer.enabled) throw new HttpError(503, 'Email is not set up on this server yet (the admin needs to add SMTP_URL).');
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(email)) throw new HttpError(400, 'That email address does not look right.');
  const cur = await db.get('SELECT email, email_verified FROM users WHERE id = ?', [req.user.id]);
  if (cur.email === email && cur.email_verified) return res.json({ ok: true, verified: true });
  const token = crypto.randomBytes(24).toString('base64url');
  await db.run('UPDATE users SET email = ?, email_verified = 0, email_token = ? WHERE id = ?', [email, token, req.user.id]);
  const link = `${weekly.baseUrl()}/api/email/verify?token=${token}`;
  await mailer.send({ to: email, subject: 'Confirm your email for Synapse weekly reports',
    text: `Confirm this address to get your weekly Synapse report:\n\n${link}\n\nIf you didn't ask for this, ignore this email.`,
    html: `<p>Confirm this address to get your weekly Synapse report.</p><p><a href="${link}" style="display:inline-block;background:#1C2A33;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:700">Confirm email</a></p><p style="color:#74838C;font-size:12px">If you didn't ask for this, ignore this email.</p>` });
  res.json({ ok: true, verified: false, sent: true });
});
get('/email/preview', async (req, res) => {
  const u = await db.get('SELECT display_name FROM users WHERE id = ?', [req.user.id]);
  res.json(weekly.build(u.display_name, await ext.review(req.user.id, req.query.day), req.user.id));
});
post('/email/test', emailLimiter, async (req, res) => {
  const m = await weekly.sendReport(req.user.id, ext.review, req.body.day);
  res.json({ ok: true, subject: m.subject });
});
weekly.startScheduler(ext.review);

// ---------- errors ----------
router.use((err, req, res, next) => {
  if (err instanceof HttpError || err.expose) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

module.exports = router;
router.review = (...a) => ext.review(...a); // used by tests and the scheduler
