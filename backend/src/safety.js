// Community safety: report, hide, block, suspend, and an admin review queue.
// Admins are the usernames listed in ADMIN_USERNAMES (comma separated).
const db = require('./db');

const ADMINS = new Set((process.env.ADMIN_USERNAMES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const AUTO_HIDE = 3; // content with this many open reports is hidden until an admin reviews it
const REASONS = { spam: 'Spam or advertising', harassment: 'Harassment or bullying', hate: 'Hate or discrimination', selfharm: 'Self-harm or suicide risk', sexual: 'Sexual content', other: 'Something else' };

const isAdmin = (username) => ADMINS.has(String(username || '').toLowerCase());

/** SQL (and params) that keeps rows visible to `me`: not from someone I blocked, and not auto-hidden by reports. */
function visible(alias, type, me, { hiddenPosts = false } = {}) {
  const sql = [
    `NOT EXISTS (SELECT 1 FROM blocks bl WHERE bl.blocker_id = ? AND bl.blocked_id = ${alias}.user_id)`,
    `(${alias}.user_id = ? OR (SELECT COUNT(*) FROM reports rp WHERE rp.target_type = '${type}' AND rp.target_id = ${alias}.id AND rp.status = 'open') < ${AUTO_HIDE})`,
  ];
  const params = [me, me];
  if (hiddenPosts) { sql.push(`NOT EXISTS (SELECT 1 FROM hidden_posts hp WHERE hp.user_id = ? AND hp.post_id = ${alias}.id)`); params.push(me); }
  return { sql: sql.join(' AND '), params };
}

async function suspended(userId) {
  return !!(await db.get('SELECT suspended FROM users WHERE id = ?', [userId]))?.suspended;
}

async function blockedEitherWay(a, b) {
  return !!(await db.get('SELECT 1 AS ok FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)', [a, b, b, a]));
}

/** The content row a report/block refers to: { userId, text, author }. */
async function target(type, id) {
  const table = { post: 'posts', reply: 'post_replies', message: 'room_messages' }[type];
  if (!table || !Number.isInteger(id)) return null;
  const row = await db.get(`SELECT t.id, t.user_id, t.body, u.display_name, COALESCE(c.community_profile, 1) AS public
    FROM ${table} t JOIN users u ON u.id = t.user_id LEFT JOIN consents c ON c.user_id = t.user_id WHERE t.id = ?`, [id]);
  if (!row) return null;
  // Room chat always shows names; community posts and replies respect the anonymous setting.
  const shownName = type === 'message' || row.public ? row.display_name : 'Anonymous member';
  return { userId: row.user_id, text: row.body, shownName, table };
}

function routes({ get, post, del, HttpError, text, intId, rateLimit }) {
  const reportLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, keyGenerator: (req) => String(req.user.id), standardHeaders: true, legacyHeaders: false });

  // ---- report
  post('/reports', reportLimiter, async (req, res) => {
    const type = String(req.body.type || '');
    const id = Number(req.body.id);
    const reason = REASONS[req.body.reason] ? req.body.reason : null;
    if (!reason) throw new HttpError(400, 'Pick a reason.');
    const t = await target(type, id);
    if (!t) throw new HttpError(404, 'That content is gone.');
    if (t.userId === req.user.id) throw new HttpError(400, "You can't report your own content.");
    const note = req.body.note ? text(req.body.note, 'Note', 1, 300) : null;
    try {
      await db.insert('INSERT INTO reports (reporter_id, target_type, target_id, target_user_id, reason, note, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [req.user.id, type, id, t.userId, reason, note, String(t.text).slice(0, 1000)]);
    } catch (e) {
      if (/unique|duplicate/i.test(e.message)) return res.json({ ok: true, already: true });
      throw e;
    }
    res.status(201).json({ ok: true, selfHarm: reason === 'selfharm' });
  });

  // ---- hide a post (only for you)
  post('/posts/:id/hide', async (req, res) => {
    const p = await db.get('SELECT id FROM posts WHERE id = ?', [intId(req.params.id)]);
    if (!p) throw new HttpError(404, 'Post not found.');
    await db.run('INSERT INTO hidden_posts (user_id, post_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [req.user.id, p.id]);
    res.json({ ok: true });
  });
  del('/hidden-posts', async (req, res) => {
    await db.run('DELETE FROM hidden_posts WHERE user_id = ?', [req.user.id]);
    res.json({ ok: true });
  });

  // ---- block the author of a post, reply or message (works for anonymous authors without revealing them)
  post('/blocks', async (req, res) => {
    const t = await target(String(req.body.type || ''), Number(req.body.id));
    if (!t) throw new HttpError(404, 'That content is gone.');
    if (t.userId === req.user.id) throw new HttpError(400, "You can't block yourself.");
    await db.tx(async (q) => {
      await q.run('INSERT INTO blocks (blocker_id, blocked_id, label) VALUES (?, ?, ?) ON CONFLICT (blocker_id, blocked_id) DO NOTHING', [req.user.id, t.userId, t.shownName]);
      // Blocking ends any buddy link between you.
      await q.run('DELETE FROM buddies WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)', [req.user.id, t.userId, t.userId, req.user.id]);
    });
    res.status(201).json({ ok: true, label: t.shownName });
  });
  get('/blocks', async (req, res) => {
    // The blocked person's account id is never returned, so anonymous authors stay anonymous.
    res.json(await db.all('SELECT id, label, created_at FROM blocks WHERE blocker_id = ? ORDER BY id', [req.user.id]));
  });
  del('/blocks/:id', async (req, res) => {
    const r = await db.run('DELETE FROM blocks WHERE id = ? AND blocker_id = ?', [intId(req.params.id), req.user.id]);
    if (!r.changes) throw new HttpError(404, 'Not found.');
    res.json({ ok: true });
  });

  // ---- admin
  const adminOnly = async (req) => {
    const u = await db.get('SELECT username FROM users WHERE id = ?', [req.user.id]);
    if (!u || !isAdmin(u.username)) throw new HttpError(403, 'Admins only.');
  };

  get('/admin/reports', async (req, res) => {
    await adminOnly(req);
    const status = ['open', 'removed', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
    const rows = await db.all(`SELECT r.target_type, r.target_id, r.target_user_id, r.reason, r.note, r.snapshot, r.created_at, u.display_name AS author, u.username, u.suspended
      FROM reports r LEFT JOIN users u ON u.id = r.target_user_id WHERE r.status = ? ORDER BY r.id DESC LIMIT 500`, [status]);
    const groups = new Map();
    for (const r of rows) {
      const k = `${r.target_type}:${r.target_id}`;
      if (!groups.has(k)) groups.set(k, { type: r.target_type, id: r.target_id, userId: r.target_user_id, author: r.author || '(deleted account)', username: r.username, suspended: !!r.suspended,
        text: r.snapshot, reports: 0, reasons: {}, notes: [], lastAt: r.created_at, urgent: false });
      const g = groups.get(k);
      g.reports++;
      g.reasons[r.reason] = (g.reasons[r.reason] || 0) + 1;
      if (r.note) g.notes.push(r.note);
      if (r.reason === 'selfharm') g.urgent = true;
    }
    const items = [...groups.values()].map((g) => ({ ...g, hidden: g.reports >= AUTO_HIDE, reasons: Object.entries(g.reasons).map(([k, n]) => ({ reason: k, label: REASONS[k], n })) }))
      .sort((a, b) => b.urgent - a.urgent || b.reports - a.reports);
    const suspendedUsers = await db.all('SELECT id, username, display_name FROM users WHERE suspended = 1 ORDER BY username');
    res.json({ status, items, reasons: REASONS, autoHideAt: AUTO_HIDE, suspendedUsers });
  });

  // action: 'dismiss' (keep it), 'remove' (delete the content), 'suspend' (delete it and suspend the author)
  post('/admin/reports/:type/:id', async (req, res) => {
    await adminOnly(req);
    const type = String(req.params.type), id = intId(req.params.id), action = String(req.body.action || '');
    if (!['dismiss', 'remove', 'suspend'].includes(action)) throw new HttpError(400, 'Unknown action.');
    const open = await db.get('SELECT target_user_id FROM reports WHERE target_type = ? AND target_id = ? LIMIT 1', [type, id]);
    if (!open) throw new HttpError(404, 'No reports for that content.');
    const table = { post: 'posts', reply: 'post_replies', message: 'room_messages' }[type];
    await db.tx(async (q) => {
      if (action !== 'dismiss') await q.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
      if (action === 'suspend' && open.target_user_id) await q.run('UPDATE users SET suspended = 1 WHERE id = ?', [open.target_user_id]);
      await q.run("UPDATE reports SET status = ?, resolved_at = ? WHERE target_type = ? AND target_id = ? AND status = 'open'",
        [action === 'dismiss' ? 'dismissed' : 'removed', new Date().toISOString().replace('T', ' ').slice(0, 19), type, id]);
    });
    res.json({ ok: true });
  });

  post('/admin/users/:id/suspend', async (req, res) => {
    await adminOnly(req);
    const on = req.body.suspended !== false;
    const r = await db.run('UPDATE users SET suspended = ? WHERE id = ?', [on ? 1 : 0, intId(req.params.id)]);
    if (!r.changes) throw new HttpError(404, 'User not found.');
    res.json({ ok: true, suspended: on });
  });
}

module.exports = { routes, visible, suspended, blockedEitherWay, isAdmin, AUTO_HIDE, REASONS };
