// Device keys let the browser extension and desktop tracker send usage totals without ever holding the
// user's password or a full session. A key can only read basic status and upload usage for its own kind.
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('./db');

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const KINDS = { extension: 'extension', desktop: 'desktop' };
const CATEGORIES = ['work', 'study', 'social', 'entertainment', 'games', 'news', 'communication', 'other'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function create(userId, name, kind) {
  const token = 'syn_' + crypto.randomBytes(24).toString('base64url');
  const r = db.prepare('INSERT INTO device_tokens (user_id, name, kind, token_hash, prefix) VALUES (?, ?, ?, ?, ?)')
    .run(userId, name, kind, hash(token), token.slice(0, 10));
  return { id: r.lastInsertRowid, token };
}

function list(userId) {
  return db.prepare(
    `SELECT id, name, kind, prefix, created_at, last_used_at FROM device_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY id DESC`
  ).all(userId);
}

function revoke(userId, id) {
  return db.prepare(`UPDATE device_tokens SET revoked_at = datetime('now') WHERE id = ? AND user_id = ? AND revoked_at IS NULL`).run(id, userId).changes;
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

router.use((req, res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token.startsWith('syn_')) return res.status(401).json({ error: 'Missing device key.' });
  const row = db.prepare(
    `SELECT d.id, d.user_id, d.kind, d.name, u.display_name FROM device_tokens d JOIN users u ON u.id = d.user_id
      WHERE d.token_hash = ? AND d.revoked_at IS NULL`
  ).get(hash(token));
  if (!row) return res.status(401).json({ error: 'This device key was revoked or is invalid. Create a new one in Synapse > Privacy.' });
  db.prepare(`UPDATE device_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(row.id);
  req.device = row;
  next();
});

router.use(rateLimit({ windowMs: 60 * 1000, limit: 60, keyGenerator: (req) => 'dev' + req.device.id, standardHeaders: true, legacyHeaders: false }));

const consentOn = (userId) => !!db.prepare('SELECT usage_tracking FROM consents WHERE user_id = ?').get(userId)?.usage_tracking;

router.get('/ping', (req, res) => {
  res.json({ ok: true, user: req.device.display_name, device: req.device.name, kind: req.device.kind, usageConsent: consentOn(req.device.user_id) });
});

// GET /api/device/focus -> { focusing, endsAt } so the extension knows when to pause distracting sites.
router.get('/focus', (req, res) => {
  const row = db.prepare('SELECT mode, ends_at FROM focus_state WHERE user_id = ?').get(req.device.user_id);
  const focusing = !!row && row.mode === 'focus' && row.ends_at > Date.now();
  res.json({ focusing, endsAt: focusing ? row.ends_at : null, mode: row && row.ends_at > Date.now() ? row.mode : null });
});

/**
 * PUT /api/device/usage
 * { days: [{ day: 'YYYY-MM-DD', entries: [{ app, category, minutes }] }] }
 * Each day's entries are the device's complete totals for that day and replace what it sent before,
 * so re-sending is always safe.
 */
router.put('/usage', (req, res) => {
  if (!consentOn(req.device.user_id))
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
  const del = db.prepare('DELETE FROM app_usage WHERE user_id = ? AND day = ? AND source = ?');
  const ins = db.prepare('INSERT INTO app_usage (user_id, day, app, category, minutes, source) VALUES (?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (const d of clean) {
      del.run(req.device.user_id, d.day, source);
      for (const e of d.list) ins.run(req.device.user_id, d.day, e.app, e.category, Math.round(e.minutes * 100) / 100, source);
    }
  })();
  db.prepare("INSERT OR IGNORE INTO milestones (user_id, code) VALUES (?, 'usage_logged')").run(req.device.user_id);
  res.json({ ok: true, days: clean.length, entries: clean.reduce((s, d) => s + d.list.length, 0) });
});

module.exports = { router, create, list, revoke, KINDS };
