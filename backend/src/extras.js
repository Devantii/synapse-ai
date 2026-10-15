// Burnout-prevention extras: distraction log, personal patterns, early-warning trend, smart block
// length, accountability buddies and the weekly review. Mounted from routes.js (signed-in users only).
const { dedupe } = require('./usage');

const DISTRACTIONS = ['phone', 'social', 'messages', 'thoughts', 'people', 'noise', 'tired', 'other'];
const DIST_LABEL = { phone: 'Picked up phone', social: 'Social media', messages: 'Messages', thoughts: 'Wandering thoughts', people: 'Someone interrupted', noise: 'Noise', tired: 'Tired or hungry', other: 'Something else' };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const shift = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayOf = (v) => (DAY_RE.test(String(v || '')) ? String(v) : new Date().toISOString().slice(0, 10));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const round = (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d;
const hourLabel = (h) => (h === 0 ? '12 am' : h < 12 ? `${h} am` : h === 12 ? '12 pm' : `${h - 12} pm`);
const fmtMin = (m) => { m = Math.round(m); const h = Math.floor(m / 60), r = m % 60; return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`; };
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

module.exports = function extras({ get, post, del, HttpError, text, intId, requireConsent, prefs, db, analyze, game }) {
  // ------------------------------------------------------------------ data helpers
  /** Per-day focus, screen, mood and distraction numbers for [from, to]. */
  async function daily(userId, from, to) {
    const days = {};
    const d = (day) => (days[day] ??= { day, focusMin: 0, blocks: 0, abandoned: 0, screenMin: null, leisureMin: 0, sleep: null, stress: null, energy: null, distractions: 0 });
    for (const s of await db.all(`SELECT kind, actual_min, completed, day, started_at FROM focus_sessions WHERE user_id = ? AND day BETWEEN ? AND ?`, [userId, from, to])) {
      if (s.kind !== 'focus') continue;
      if (s.completed) { d(s.day).focusMin += Number(s.actual_min); d(s.day).blocks++; } else d(s.day).abandoned++;
    }
    const usage = dedupe(await db.all('SELECT day, app, category, minutes, source FROM app_usage WHERE user_id = ? AND day BETWEEN ? AND ?', [userId, from, to]));
    for (const u of usage) {
      const x = d(u.day);
      x.screenMin = u.total;
      x.leisureMin = ['social', 'entertainment', 'games'].reduce((s, c) => s + (u.byCategory[c] || 0), 0);
    }
    for (const m of await db.all('SELECT day, energy, stress, sleep_h FROM mood_checkins WHERE user_id = ? AND day BETWEEN ? AND ?', [userId, from, to]))
      Object.assign(d(m.day), { sleep: m.sleep_h == null ? null : Number(m.sleep_h), stress: m.stress, energy: m.energy });
    for (const r of await db.all('SELECT day, COUNT(*) AS n FROM distractions WHERE user_id = ? AND day BETWEEN ? AND ? GROUP BY day', [userId, from, to]))
      d(r.day).distractions = Number(r.n);
    return Object.values(days).sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  // ------------------------------------------------------------------ 1. distraction log
  post('/distractions', requireConsent('activity_tracking', 'Save focus activity'), async (req, res) => {
    const kind = DISTRACTIONS.includes(req.body.kind) ? req.body.kind : null;
    if (!kind) throw new HttpError(400, 'Unknown distraction.');
    const at = TS_RE.test(String(req.body.at || '')) ? String(req.body.at).slice(0, 16) : null;
    if (!at) throw new HttpError(400, 'at must be a local timestamp.');
    const note = req.body.note ? text(req.body.note, 'Note', 1, 140) : null;
    const recent = await db.get('SELECT COUNT(*) AS n FROM distractions WHERE user_id = ? AND day = ?', [req.user.id, at.slice(0, 10)]);
    if (Number(recent.n) >= 200) throw new HttpError(429, "That's a lot for one day. Maybe take a real break?");
    const id = await db.insert('INSERT INTO distractions (user_id, day, at, kind, note) VALUES (?, ?, ?, ?, ?)', [req.user.id, at.slice(0, 10), at, kind, note]);
    res.status(201).json({ id, today: Number(recent.n) + 1 });
  });

  get('/distractions', async (req, res) => {
    const to = dayOf(req.query.day), days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
    const from = shift(to, -(days - 1));
    const rows = await db.all('SELECT kind, at FROM distractions WHERE user_id = ? AND day BETWEEN ? AND ?', [req.user.id, from, to]);
    const byKind = Object.fromEntries(DISTRACTIONS.map((k) => [k, 0]));
    const byHour = new Array(24).fill(0);
    for (const r of rows) { byKind[r.kind]++; byHour[parseInt(String(r.at).slice(11, 13), 10) || 0]++; }
    const today = rows.filter((r) => String(r.at).startsWith(to)).length;
    const top = Object.entries(byKind).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).map(([kind, n]) => ({ kind, label: DIST_LABEL[kind], n }));
    const peak = byHour.indexOf(Math.max(...byHour));
    res.json({ from, to, total: rows.length, today, top, byHour, peakHour: rows.length ? peak : null, peakLabel: rows.length ? hourLabel(peak) : null, kinds: DIST_LABEL });
  });

  // ------------------------------------------------------------------ 2. personal patterns
  /** Compares focus between two groups of days; only reported with enough days on each side. */
  function contrast(rows, test, labelYes, labelNo, minEach = 3) {
    const yes = rows.filter((r) => test(r) === true), no = rows.filter((r) => test(r) === false);
    if (yes.length < minEach || no.length < minEach) return null;
    const a = mean(yes.map((r) => r.focusMin)), b = mean(no.map((r) => r.focusMin));
    if (b == null || a == null || Math.max(a, b) < 10) return null;
    const diff = a - b;
    const rel = b > 0 ? diff / b : 1;
    if (Math.abs(diff) < 10 || Math.abs(rel) < 0.15) return null;
    return { a, b, diff, rel, n: yes.length + no.length, nYes: yes.length, nNo: no.length, labelYes, labelNo };
  }

  get('/patterns', async (req, res) => {
    const to = dayOf(req.query.day), from = shift(to, -59);
    const rows = (await daily(req.user.id, from, to)).filter((r) => r.day < to); // finished days only
    const active = rows.filter((r) => r.focusMin > 0 || r.screenMin != null);
    const findings = [];
    const push = (c, kind, icon, sentence) => c && findings.push({ kind, icon, text: sentence(c), strength: Math.min(1, Math.abs(c.rel)), basedOn: `${c.nYes} vs ${c.nNo} days` });

    push(contrast(active, (r) => (r.sleep == null ? null : r.sleep >= 7), '7h+ sleep', 'under 7h'), 'sleep', 'moon',
      (c) => `On days after 7+ hours of sleep you focused ${fmtMin(c.a)} on average, vs ${fmtMin(c.b)} after shorter nights (${c.rel > 0 ? '+' : ''}${Math.round(c.rel * 100)}%).`);
    push(contrast(active, (r) => (r.stress == null ? null : r.stress >= 4 ? true : r.stress <= 2 ? false : null), 'high stress', 'low stress'), 'stress', 'wave',
      (c) => `High-stress days averaged ${fmtMin(c.a)} of focus, vs ${fmtMin(c.b)} on calm days. ${c.diff < 0 ? 'Stress costs you focus, so short blocks and real breaks matter more then.' : 'You push harder when stressed; watch that it does not become a pattern.'}`);
    const leisureCut = mean(active.filter((r) => r.screenMin != null).map((r) => r.leisureMin));
    if (leisureCut != null)
      push(contrast(active, (r) => (r.screenMin == null ? null : r.leisureMin > leisureCut * 1.25)), 'leisure', 'phone',
        (c) => `On heavy scrolling days (over ${fmtMin(leisureCut * 1.25)} on social and video) you focused ${fmtMin(c.a)}, vs ${fmtMin(c.b)} on lighter days.`);
    push(contrast(active, (r) => (r.distractions ? r.distractions >= 3 : r.focusMin ? false : null)), 'distractions', 'bell',
      (c) => `Days with 3+ logged distractions averaged ${fmtMin(c.a)} of focus, vs ${fmtMin(c.b)} on quieter days.`);

    // Best hour and best block length by completion rate.
    const sess = await db.all(`SELECT planned_min, completed, started_at FROM focus_sessions WHERE user_id = ? AND kind = 'focus' AND day BETWEEN ? AND ?`, [req.user.id, from, to]);
    const byHour = {};
    for (const s of sess) { const h = parseInt(String(s.started_at).slice(11, 13), 10); (byHour[h] ??= []).push(s.completed ? 1 : 0); }
    const hours = Object.entries(byHour).filter(([, v]) => v.length >= 3).map(([h, v]) => ({ h: +h, rate: mean(v), n: v.length }));
    if (hours.length >= 2) {
      hours.sort((a, b) => b.rate - a.rate || b.n - a.n);
      const best = hours[0], worst = hours[hours.length - 1];
      if (best.rate - worst.rate >= 0.15)
        findings.push({ kind: 'hour', icon: 'sun', strength: best.rate - worst.rate, basedOn: `${sess.length} blocks`,
          text: `You finish ${Math.round(best.rate * 100)}% of blocks started around ${hourLabel(best.h)}, but only ${Math.round(worst.rate * 100)}% around ${hourLabel(worst.h)}. Put hard work near ${hourLabel(best.h)}.` });
    }
    const byLen = { short: [], long: [] };
    for (const s of sess) (s.planned_min >= 45 ? byLen.long : byLen.short).push(s.completed ? 1 : 0);
    if (byLen.short.length >= 4 && byLen.long.length >= 4) {
      const rs = mean(byLen.short), rl = mean(byLen.long);
      if (Math.abs(rs - rl) >= 0.15)
        findings.push({ kind: 'length', icon: 'timer', strength: Math.abs(rs - rl), basedOn: `${sess.length} blocks`,
          text: rs > rl ? `You finish ${Math.round(rs * 100)}% of short blocks (under 45 min) but ${Math.round(rl * 100)}% of long ones. Shorter blocks suit you right now.`
            : `You finish ${Math.round(rl * 100)}% of long blocks vs ${Math.round(rs * 100)}% of short ones. You settle in once you start, so longer blocks work for you.` });
    }
    const byDow = {};
    for (const r of active.filter((r) => r.focusMin > 0)) (byDow[new Date(`${r.day}T12:00:00Z`).getUTCDay()] ??= []).push(r.focusMin);
    const dows = Object.entries(byDow).filter(([, v]) => v.length >= 2).map(([d, v]) => ({ d: +d, m: mean(v) })).sort((a, b) => b.m - a.m);
    if (dows.length >= 3 && dows[0].m - dows[dows.length - 1].m >= 20)
      findings.push({ kind: 'weekday', icon: 'calendar', strength: 0.3, basedOn: `${active.length} days`,
        text: `${WEEKDAY[dows[0].d]}s are your strongest day (${fmtMin(dows[0].m)} on average); ${WEEKDAY[dows[dows.length - 1].d]}s the lightest (${fmtMin(dows[dows.length - 1].m)}).` });

    findings.sort((a, b) => b.strength - a.strength);
    res.json({ from, to, daysAnalysed: active.length, findings: findings.slice(0, 6),
      note: 'Patterns in your own data, not proof of cause. Each one needs at least a few days on both sides.' });
  });

  // ------------------------------------------------------------------ 3. early-warning trend
  get('/insights/trend', requireConsent('ai_insights', 'AI wellbeing insights'), async (req, res) => {
    const to = dayOf(req.query.day);
    const points = [];
    for (let i = 13; i >= 0; i--) {
      const day = shift(to, -i);
      const a = await analyze(req.user.id, day);
      if (a.daysWithData >= 2) points.push({ day, score: a.score, state: a.state });
    }
    const last = points.slice(-4);
    const rising = last.length === 4 && last.every((p, i) => i === 0 || p.score > last[i - 1].score);
    const weekAgo = points.find((p) => p.day === shift(to, -7));
    const now = points.find((p) => p.day === to);
    const jump = weekAgo && now ? now.score - weekAgo.score : null;
    let warning = null;
    if (now && ((rising && now.score >= 50) || (jump != null && jump >= 15 && now.score >= 50) || now.score >= 70)) {
      warning = {
        level: now.score >= 70 ? 'high' : 'rising',
        text: now.score >= 70 ? `Your load score is ${now.score}/100. That's high: plan a lighter day and protect your sleep.`
          : rising ? `Your load score has risen 3 days in a row (${last.map((p) => p.score).join(' → ')}). Catch it early: shorter blocks, real breaks, screens off earlier.`
            : `Your load score is up ${jump} points on last week. Worth a lighter day before it builds.`,
      };
    }
    res.json({ points, warning });
  });

  // ------------------------------------------------------------------ 4. smart block length
  get('/suggest-block', async (req, res) => {
    const day = dayOf(req.query.day);
    const hour = Math.min(23, Math.max(0, parseInt(req.query.hour, 10) || new Date().getHours()));
    const sess = await db.all(`SELECT planned_min, completed, started_at FROM focus_sessions WHERE user_id = ? AND kind = 'focus' AND day BETWEEN ? AND ?`, [req.user.id, shift(day, -29), day]);
    const mood = await db.get('SELECT energy, stress, sleep_h FROM mood_checkins WHERE user_id = ? AND day = ?', [req.user.id, day]);
    const rate = (list) => (list.length ? mean(list.map((s) => (s.completed ? 1 : 0))) : null);
    const near = sess.filter((s) => Math.abs(parseInt(String(s.started_at).slice(11, 13), 10) - hour) <= 1);
    const pool = near.length >= 4 ? near : sess;
    const r50 = rate(pool.filter((s) => s.planned_min >= 45)), r25 = rate(pool.filter((s) => s.planned_min >= 20 && s.planned_min < 45));
    let minutes = 25;
    const why = [];
    if (r50 != null && r50 >= 0.75 && pool.filter((s) => s.planned_min >= 45).length >= 3) { minutes = 50; why.push(`you finish ${Math.round(r50 * 100)}% of 50-minute blocks${pool === near ? ' around this time' : ''}`); }
    else if (r25 != null && r25 < 0.6 && pool.length >= 4) { minutes = 15; why.push(`only ${Math.round(r25 * 100)}% of your 25-minute blocks get finished${pool === near ? ' around this time' : ''}`); }
    else if (r25 != null) why.push(`25 minutes is a steady default for you (${Math.round(r25 * 100)}% finished)`);
    if (mood && (mood.energy <= 2 || mood.stress >= 4)) { minutes = Math.min(minutes, 15); why.push(mood.energy <= 2 ? 'your energy is low today' : 'your stress is high today'); }
    else if (mood && mood.energy >= 4 && minutes === 25 && (r50 == null || r50 >= 0.6)) { minutes = 50; why.push('your energy is high today'); }
    if (hour >= 22 || hour < 5) { minutes = Math.min(minutes, 15); why.push("it's late, so keep it short and stop before bed"); }
    if (!why.length) why.push('a short block is the easiest way in; Synapse will tune this as you use it');
    res.json({ minutes, reason: why.join(', and ').replace(/^./, (c) => c.toUpperCase()) + '.', basedOn: pool.length });
  });

  // ------------------------------------------------------------------ 5. accountability buddies
  const buddyRow = (userId) => `SELECT b.id, b.status, b.requester_id, b.addressee_id, b.created_at,
      CASE WHEN b.requester_id = ? THEN b.addressee_id ELSE b.requester_id END AS other_id
    FROM buddies b WHERE (b.requester_id = ? OR b.addressee_id = ?)`;

  get('/buddies', async (req, res) => {
    const me = req.user.id, today = dayOf(req.query.day);
    const rows = await db.all(`${buddyRow(me)} ORDER BY b.id`, [me, me, me]);
    const out = { buddies: [], incoming: [], outgoing: [] };
    for (const r of rows) {
      const u = await db.get('SELECT id, username, display_name FROM users WHERE id = ?', [r.other_id]);
      if (!u) continue;
      const base = { id: r.id, name: u.display_name, username: u.username };
      if (r.status === 'pending') { (r.requester_id === me ? out.outgoing : out.incoming).push(base); continue; }
      const f = await db.get(`SELECT COALESCE(SUM(actual_min), 0) AS m, COUNT(*) AS n FROM focus_sessions WHERE user_id = ? AND kind = 'focus' AND completed = 1 AND sample = 0 AND day = ?`, [u.id, today]);
      const p = await prefs(u.id);
      const rw = await game.summary(u.id);
      const lastCheer = await db.get('SELECT created_at FROM cheers WHERE from_id = ? AND to_id = ? ORDER BY id DESC LIMIT 1', [me, u.id]);
      out.buddies.push({ ...base, today: { focusMin: Math.round(Number(f.m)), blocks: Number(f.n), goalMin: p.dailyGoalMin }, streak: rw.currentStreak || 0, lastCheerAt: lastCheer?.created_at || null });
    }
    out.cheers = (await db.all(`SELECT c.id, c.kind, c.created_at, u.display_name AS "from" FROM cheers c JOIN users u ON u.id = c.from_id
      WHERE c.to_id = ? ORDER BY c.id DESC LIMIT 10`, [me]));
    res.json(out);
  });

  post('/buddies', async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase().replace(/^@/, '');
    if (!username) throw new HttpError(400, 'Enter a username.');
    const u = await db.get('SELECT id, display_name FROM users WHERE username = ?', [username]);
    if (!u) throw new HttpError(404, 'No one with that username.');
    if (u.id === req.user.id) throw new HttpError(400, "That's you.");
    const existing = await db.get(`${buddyRow(req.user.id)} AND (b.requester_id = ? OR b.addressee_id = ?)`, [req.user.id, req.user.id, req.user.id, u.id, u.id]);
    if (existing) {
      if (existing.status === 'pending' && existing.addressee_id === req.user.id) { // they asked you first: accept
        await db.run("UPDATE buddies SET status = 'accepted' WHERE id = ?", [existing.id]);
        return res.json({ ok: true, status: 'accepted' });
      }
      throw new HttpError(409, existing.status === 'accepted' ? 'You are already buddies.' : 'Request already sent.');
    }
    const count = await db.get("SELECT COUNT(*) AS n FROM buddies WHERE requester_id = ? AND status = 'pending'", [req.user.id]);
    if (Number(count.n) >= 20) throw new HttpError(429, 'Too many open requests.');
    await db.insert("INSERT INTO buddies (requester_id, addressee_id, status) VALUES (?, ?, 'pending')", [req.user.id, u.id]);
    req.app.get('io')?.to(`user:${u.id}`).emit('buddy:request', { from: req.user.name });
    res.status(201).json({ ok: true, status: 'pending' });
  });

  post('/buddies/:id/accept', async (req, res) => {
    const r = await db.run("UPDATE buddies SET status = 'accepted' WHERE id = ? AND addressee_id = ? AND status = 'pending'", [intId(req.params.id), req.user.id]);
    if (!r.changes) throw new HttpError(404, 'Request not found.');
    res.json({ ok: true });
  });

  del('/buddies/:id', async (req, res) => {
    const r = await db.run('DELETE FROM buddies WHERE id = ? AND (requester_id = ? OR addressee_id = ?)', [intId(req.params.id), req.user.id, req.user.id]);
    if (!r.changes) throw new HttpError(404, 'Buddy not found.');
    res.json({ ok: true });
  });

  const CHEERS = { cheer: 'cheered you on', nudge: 'nudged you to start a block', proud: 'is proud of your progress' };
  post('/buddies/:id/cheer', async (req, res) => {
    const kind = CHEERS[req.body.kind] ? req.body.kind : 'cheer';
    const b = await db.get(`${buddyRow(req.user.id)} AND b.id = ? AND b.status = 'accepted'`, [req.user.id, req.user.id, req.user.id, intId(req.params.id)]);
    if (!b) throw new HttpError(404, 'Buddy not found.');
    const since = new Date(Date.now() - 30 * 60000).toISOString().replace('T', ' ').slice(0, 19);
    if (await db.get('SELECT 1 AS ok FROM cheers WHERE from_id = ? AND to_id = ? AND created_at > ?', [req.user.id, b.other_id, since]))
      throw new HttpError(429, 'You sent one recently. Give them a little time.');
    await db.insert('INSERT INTO cheers (from_id, to_id, kind) VALUES (?, ?, ?)', [req.user.id, b.other_id, kind]);
    req.app.get('io')?.to(`user:${b.other_id}`).emit('buddy:cheer', { from: req.user.name, kind, text: `${req.user.name} ${CHEERS[kind]}` });
    res.status(201).json({ ok: true });
  });

  // ------------------------------------------------------------------ 6. weekly review
  get('/review', async (req, res) => {
    const to = dayOf(req.query.day), from = shift(to, -6), prevFrom = shift(to, -13), prevTo = shift(to, -7);
    const all = await daily(req.user.id, prevFrom, to);
    const week = all.filter((r) => r.day >= from), prev = all.filter((r) => r.day < from);
    const sum = (a, k) => a.reduce((s, r) => s + (r[k] || 0), 0);
    const focus = sum(week, 'focusMin'), prevFocus = sum(prev, 'focusMin');
    const screenDays = week.filter((r) => r.screenMin != null), prevScreenDays = prev.filter((r) => r.screenMin != null);
    const screen = screenDays.length ? sum(screenDays, 'screenMin') / screenDays.length : null;
    const prevScreen = prevScreenDays.length ? sum(prevScreenDays, 'screenMin') / prevScreenDays.length : null;
    const best = week.filter((r) => r.focusMin > 0).sort((a, b) => b.focusMin - a.focusMin)[0] || null;
    const topD = await db.get('SELECT kind, COUNT(*) AS n FROM distractions WHERE user_id = ? AND day BETWEEN ? AND ? GROUP BY kind ORDER BY n DESC LIMIT 1', [req.user.id, from, to]);
    const tasksDone = await db.get('SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND done = 1 AND done_day BETWEEN ? AND ?', [req.user.id, from, to]);
    const sleepVals = week.map((r) => r.sleep).filter((x) => x != null);
    const activeDays = week.filter((r) => r.focusMin > 0).length;
    let focusNext;
    if (!activeDays) focusNext = 'Start small: one 15-minute block a day is enough to build the habit.';
    else if (sleepVals.length >= 3 && mean(sleepVals) < 6.5) focusNext = `You averaged ${round(mean(sleepVals), 1)}h of sleep. Protect bedtime this week; it will do more than any extra block.`;
    else if (topD) focusNext = `"${DIST_LABEL[topD.kind]}" pulled you away most (${topD.n} times). Plan one change for it, like phone in another room.`;
    else if (screen != null && prevScreen && screen > prevScreen * 1.15) focusNext = `Screen time is up ${Math.round((screen / prevScreen - 1) * 100)}% on last week. Set a daily limit on your biggest leisure app.`;
    else if (activeDays < 4) focusNext = `You focused on ${activeDays} days. Aim for 4 this week, even if some are short.`;
    else focusNext = 'Solid week. Keep the rhythm and keep taking the breaks.';
    res.json({
      from, to, activeDays,
      focusMin: Math.round(focus), prevFocusMin: Math.round(prevFocus), focusChange: prevFocus ? (focus - prevFocus) / prevFocus : null,
      blocks: sum(week, 'blocks'), abandoned: sum(week, 'abandoned'),
      screenAvgMin: screen != null ? Math.round(screen) : null, screenChange: screen != null && prevScreen ? (screen - prevScreen) / prevScreen : null,
      bestDay: best ? { day: best.day, focusMin: Math.round(best.focusMin) } : null,
      topDistraction: topD ? { kind: topD.kind, label: DIST_LABEL[topD.kind], n: Number(topD.n) } : null,
      distractions: sum(week, 'distractions'), tasksDone: Number(tasksDone.n),
      sleepAvg: sleepVals.length ? round(mean(sleepVals), 1) : null,
      focusNext,
    });
  });
};
module.exports.DISTRACTIONS = DISTRACTIONS;
