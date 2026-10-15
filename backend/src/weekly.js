// Weekly email report: every Sunday evening (the person's own time zone) for people who turned it on
// and verified their address. Contains focus hours, the screen-time trend and one suggestion.
const db = require('./db');
const mailer = require('./mailer');
const { hmac } = require('./auth');

const SEND_HOUR = 18; // local time on Sunday
const baseUrl = () => (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMin = (m) => { m = Math.round(m || 0); const h = Math.floor(m / 60), r = m % 60; return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`; };
const pct = (x) => (x == null ? '' : `${x > 0 ? '▲' : '▼'} ${Math.abs(Math.round(x * 100))}%`);
const dayName = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
const shortDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Local date, weekday (0 = Sunday) and hour for an instant in a time zone. */
function localParts(now, tz) {
  let zone = 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); zone = tz || 'UTC'; } catch {}
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(now).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday), hour: Number(parts.hour) };
}

/** Is a report due now? Sunday from 18:00 local, once per Sunday. */
function due(now, tz, lastWeek) {
  const p = localParts(now, tz);
  return { due: p.weekday === 0 && p.hour >= SEND_HOUR && lastWeek !== p.day, week: p.day };
}

const unsubLink = (userId) => `${baseUrl()}/api/email/unsubscribe?u=${userId}&t=${hmac(`unsub:${userId}`)}`;

function build(name, r, userId) {
  const subject = `Your Synapse week: ${fmtMin(r.focusMin)} focused${r.screenChange != null ? `, screen time ${pct(r.screenChange)}` : ''}`;
  const maxScreen = Math.max(1, ...r.days.map((d) => d.screenMin || 0));
  const maxFocus = Math.max(1, ...r.days.map((d) => d.focusMin || 0));
  const bar = (v, max, color) => `<div style="height:10px;border-radius:5px;background:${color};width:${Math.max(v ? 3 : 0, Math.round(((v || 0) / max) * 100))}%"></div>`;
  const rows = r.days.map((d) => `<tr>
      <td style="padding:4px 8px 4px 0;color:#4A5B66;font-size:13px;width:38px">${dayName(d.day)}</td>
      <td style="padding:4px 0;width:45%">${bar(d.screenMin, maxScreen, '#6B4FC8')}</td>
      <td style="padding:4px 8px;color:#4A5B66;font-size:12px;width:60px;text-align:right">${d.screenMin != null ? fmtMin(d.screenMin) : '–'}</td>
      <td style="padding:4px 0;width:30%">${bar(d.focusMin, maxFocus, '#2F8A57')}</td>
      <td style="padding:4px 0 4px 8px;color:#4A5B66;font-size:12px;text-align:right">${d.focusMin ? fmtMin(d.focusMin) : '–'}</td></tr>`).join('');
  const stat = (big, label, sub) => `<td style="padding:12px;background:#EEF2F3;border-radius:12px;width:33%;vertical-align:top">
      <div style="font-size:22px;font-weight:800;color:#1C2A33">${big}</div><div style="font-size:12px;color:#4A5B66">${label}${sub ? `<br><b>${sub}</b>` : ''}</div></td>`;
  const html = `<!doctype html><html><body style="margin:0;background:#EEF2F3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1C2A33">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" style="max-width:560px;background:#FFFFFF;border-radius:20px;padding:24px" cellspacing="0" cellpadding="0"><tr><td>
    <div style="font-size:13px;color:#3F7355;font-weight:700;letter-spacing:.04em;text-transform:uppercase">Synapse weekly report</div>
    <h1 style="font-size:24px;margin:6px 0 2px">Hi ${esc(name)}, here's your week</h1>
    <div style="color:#74838C;font-size:13px;margin-bottom:18px">${shortDate(r.from)} – ${shortDate(r.to)}</div>
    <table role="presentation" width="100%" cellspacing="6" cellpadding="0"><tr>
      ${stat(fmtMin(r.focusMin), 'focused', r.focusChange != null ? `${pct(r.focusChange)} vs last week` : '')}
      ${stat(r.screenAvgMin != null ? fmtMin(r.screenAvgMin) : '–', 'screen time a day', r.screenChange != null ? `${pct(r.screenChange)} vs last week` : '')}
      ${stat(`${r.activeDays}/7`, 'days with focus', r.tasksDone ? `${r.tasksDone} tasks done` : '')}
    </tr></table>
    <h2 style="font-size:15px;margin:22px 0 6px">Day by day</h2>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr><td></td><td style="font-size:11px;color:#6B4FC8;font-weight:700">Screen time</td><td></td><td style="font-size:11px;color:#2F8A57;font-weight:700">Focus</td><td></td></tr>${rows}</table>
    ${r.bestDay || r.topDistraction || r.sleepAvg != null ? `<p style="font-size:13px;color:#4A5B66;margin:16px 0 0">${[
      r.bestDay ? `Best day: <b>${dayName(r.bestDay.day)}</b> (${fmtMin(r.bestDay.focusMin)})` : '',
      r.topDistraction ? `Top distraction: <b>${esc(r.topDistraction.label)}</b> (${r.topDistraction.n}×)` : '',
      r.sleepAvg != null ? `Average sleep: <b>${r.sleepAvg}h</b>` : ''].filter(Boolean).join(' · ')}</p>` : ''}
    <div style="margin:20px 0;padding:14px 16px;background:#DCEADF;border-radius:14px;font-size:15px"><b>One thing for this week:</b> ${esc(r.focusNext)}</div>
    <a href="${baseUrl()}/#/progress" style="display:inline-block;background:#1C2A33;color:#FFFFFF;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:12px">Open Synapse</a>
    <p style="font-size:11px;color:#74838C;margin:24px 0 0">You get this because you turned on the weekly report in Synapse &gt; Privacy. Patterns in your own data, not medical advice.
      <a href="${unsubLink(userId)}" style="color:#74838C">Unsubscribe</a></p>
  </td></tr></table></td></tr></table></body></html>`;
  const text = `Your Synapse week (${shortDate(r.from)} - ${shortDate(r.to)})

Focused: ${fmtMin(r.focusMin)} ${r.focusChange != null ? `(${pct(r.focusChange)} vs last week)` : ''}
Screen time a day: ${r.screenAvgMin != null ? fmtMin(r.screenAvgMin) : '-'} ${r.screenChange != null ? `(${pct(r.screenChange)})` : ''}
Days with focus: ${r.activeDays}/7

${r.days.map((d) => `${dayName(d.day)}  screen ${d.screenMin != null ? fmtMin(d.screenMin) : '-'}  focus ${d.focusMin ? fmtMin(d.focusMin) : '-'}`).join('\n')}

One thing for this week: ${r.focusNext}

Open Synapse: ${baseUrl()}/#/progress
Unsubscribe: ${unsubLink(userId)}`;
  return { subject, html, text };
}

async function sendReport(userId, review, localDay) {
  const u = await db.get('SELECT display_name, email, email_verified FROM users WHERE id = ?', [userId]);
  if (!u?.email || !u.email_verified) throw Object.assign(new Error('Verify your email address first.'), { status: 400, expose: true });
  const msg = build(u.display_name, await review(userId, localDay), userId);
  await mailer.send({ to: u.email, ...msg, headers: { 'List-Unsubscribe': `<${unsubLink(userId)}>` } });
  return msg;
}

/** Send every report that is due. Safe to call often (every few minutes, or from an external cron). */
async function runDue(review, now = new Date()) {
  if (!mailer.enabled) return { sent: 0, skipped: 'email not configured' };
  const rows = await db.all(`SELECT p.user_id, p.tz, p.last_report_week FROM user_prefs p JOIN users u ON u.id = p.user_id
    WHERE p.weekly_email = 1 AND u.email_verified = 1 AND u.email IS NOT NULL`);
  let sent = 0, failed = 0;
  for (const r of rows) {
    const d = due(now, r.tz, r.last_report_week);
    if (!d.due) continue;
    // Claim the week first so two runs can't double-send.
    const claim = await db.run('UPDATE user_prefs SET last_report_week = ? WHERE user_id = ? AND (last_report_week IS NULL OR last_report_week <> ?)', [d.week, r.user_id, d.week]);
    if (!claim.changes) continue;
    try { await sendReport(r.user_id, review, d.week); sent++; } catch (e) { failed++; console.error('[weekly] send failed for user', r.user_id, e.message); }
  }
  return { sent, failed, checked: rows.length };
}

let timer = null;
function startScheduler(review) {
  if (timer || !mailer.enabled || process.env.NODE_ENV === 'test') return;
  const tick = () => runDue(review).catch((e) => console.error('[weekly]', e.message));
  timer = setInterval(tick, 10 * 60 * 1000);
  timer.unref();
  setTimeout(tick, 30 * 1000).unref();
}

module.exports = { build, due, localParts, runDue, sendReport, startScheduler, unsubLink, baseUrl };
