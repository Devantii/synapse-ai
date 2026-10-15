// Device keys let the browser extension and desktop tracker send usage totals without ever holding the
// user's password or a full session. A key can only read basic status (focus state, daily limits) and
// upload usage for its own kind.
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('./db');

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const KINDS = { extension: 'extension', desktop: 'desktop' };
const CATEGORIES = ['work', 'study', 'social', 'entertainment', 'games', 'news', 'communication', 'other'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function create(userId, name, kind) {
  const token = 'syn_' + crypto.randomBytes(24).toString('base64url');
  const id = await db.insert('INSERT INTO device_tokens (user_id, name, kind, token_hash, prefix) VALUES (?, ?, ?, ?, ?)',
    [userId, name, kind, hash(token), token.slice(0, 10)]);
  return { id, token };
}

function list(userId) {
  return db.all(
    'SELECT id, name, kind, prefix, created_at, last_used_at FROM device_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY id DESC',
    [userId]
  );
}

async function revoke(userId, id) {
  const r = await db.run('UPDATE device_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [db.now(), id, userId]);
  return r.changes;
}

// ---------------- router used by the trackers ----------------
const router = express.Router();

// Bearer tokens only (no cookies), so allowing any origin is safe and lets the extension call from its own origin.
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

router.use(wrap(async (req, res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token.startsWith('syn_')) return res.status(401).json({ error: 'Missing device key.' });
  const row = await db.get(
    `SELECT d.id, d.user_id, d.kind, d.name, u.display_name FROM device_tokens d JOIN users u ON u.id = d.user_id
      WHERE d.token_hash = ? AND d.revoked_at IS NULL`,
    [hash(token)]
  );
  if (!row) return res.status(401).json({ error: 'This device key was revoked or is invalid. Create a new one in Synapse > Privacy.' });
  await db.run('UPDATE device_tokens SET last_used_at = ? WHERE id = ?', [db.now(), row.id]);
  req.device = row;
  next();
}));

router.use(rateLimit({ windowMs: 60 * 1000, limit: 90, keyGenerator: (req) => 'dev' + req.device.id, standardHeaders: true, legacyHeaders: false }));

const consentOn = async (userId) => !!(await db.get('SELECT usage_tracking FROM consents WHERE user_id = ?', [userId]))?.usage_tracking;

router.get('/ping', wrap(async (req, res) => {
  res.json({ ok: true, user: req.device.display_name, device: req.device.name, kind: req.device.kind, usageConsent: await consentOn(req.device.user_id) });
}));

// GET /api/device/focus -> { focusing, endsAt } so the extension knows when to pause distracting sites.
router.get('/focus', wrap(async (req, res) => {
  const row = await db.get('SELECT mode, ends_at FROM focus_state WHERE user_id = ?', [req.device.user_id]);
  const live = !!row && row.ends_at > Date.now();
  const focusing = live && row.mode === 'focus';
  res.json({ focusing, endsAt: focusing ? row.ends_at : null, mode: live ? row.mode : null });
}));

// GET /api/device/limits -> { limits: [{ app, minutes }] } daily limits set in the dashboard.
router.get('/limits', wrap(async (req, res) => {
  res.json({ limits: await db.all('SELECT app, minutes FROM app_limits WHERE user_id = ? ORDER BY app', [req.device.user_id]) });
}));

/**
 * PUT /api/device/usage
 * { days: [{ day: 'YYYY-MM-DD', entries: [{ app, category, minutes }] }] }
 * Each day's entries are the device's complete totals for that day and replace what it sent before,
 * so re-sending is always safe.
 */
router.put('/usage', wrap(async (req, res) => {
  if (!(await consentOn(req.device.user_id)))
    return res.status(403).json({ error: 'Turn on "Save screen-time data" in Synapse > Privacy to sync.', consentRequired: 'usage_tracking' });
  const days = Array.isArray(req.body?.days) ? req.body.days : null;
  if (!days || !days.length || days.length > 31) return res.status(400).json({ error: 'Send 1-31 days.' });

  const now = Date.now();
  const clean = [];
  for (const d of days) {
    if (typeof d.day !== 'string' || !DAY_RE.test(d.day)) return res.status(400).json({ error: `Invalid day "${d.day}".` });
    const diff = (Date.parse(d.day + 'T00:00:00Z') - now) / 86400000;
    if (isNaN(diff) || diff > 1.5 || diff < -31) return res.status(400).json({ error: `Day ${d.day} is outside the last 30 days.` });
    const entries = Array.isArray(d.entries) ? d.entries : [];
    if (entries.length > 300) return res.status(400).json({ error: 'Too many entries for one day (max 300).' });
    const merged = new Map();
    for (const e of entries) {
      const app = typeof e.app === 'string' ? e.app.trim().slice(0, 60) : '';
      const minutes = Number(e.minutes);
      if (!app || !Number.isFinite(minutes) || minutes < 0) continue;
      const prev = merged.get(app);
      merged.set(app, { app, category: CATEGORIES.includes(e.category) ? e.category : prev?.category || 'other', minutes: (prev?.minutes || 0) + minutes });
    }
    const list = [...merged.values()].filter((e) => e.minutes >= 0.05);
    const total = list.reduce((s, e) => s + e.minutes, 0);
    if (total > 1440.5) return res.status(400).json({ error: `Totals for ${d.day} exceed 24 hours.` });
    clean.push({ day: d.day, list });
  }

  const source = KINDS[req.device.kind];
  const userId = req.device.user_id;
  await db.tx(async (t) => {
    for (const d of clean) {
      await t.run('DELETE FROM app_usage WHERE user_id = ? AND day = ? AND source = ?', [userId, d.day, source]);
      for (const e of d.list)
        await t.run('INSERT INTO app_usage (user_id, day, app, category, minutes, source) VALUES (?, ?, ?, ?, ?, ?)',
          [userId, d.day, e.app, e.category, Math.round(e.minutes * 100) / 100, source]);
    }
    await t.run("INSERT INTO milestones (user_id, code) VALUES (?, 'usage_logged') ON CONFLICT DO NOTHING", [userId]);
  });
  res.json({ ok: true, days: clean.length, entries: clean.reduce((s, d) => s + d.list.length, 0) });
}));

module.exports = { router, create, list, revoke, KINDS };
