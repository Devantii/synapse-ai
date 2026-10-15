// Shared screen-time helpers.
//
// Overlap rule, per day and app ("Instagram", "instagram.com" and "com.instagram.android" style names
// are matched by appKey):
//   - Computer trackers (browser extension, desktop tracker, this tab) can measure the same minutes,
//     so among them only the largest counts.
//   - Phone time happens on a different screen, so it ADDS to computer time.
//   - A typed-in total is the user's own estimate of everything; it counts only if it is larger than
//     phone + computer tracked time combined (and then replaces them).
// Rows still exist individually so the user can see and delete each one.

const SOURCE_LABEL = { self: 'entered by you', synapse: 'this tab, measured', extension: 'browser extension', desktop: 'desktop tracker', phone: 'Android phone', sample: 'sample data' };

function appKey(name) {
  let s = String(name).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  s = s.replace(/\.exe$/, '');
  // "instagram.com" -> "instagram", "mail.google.com" -> "mail.google"
  const parts = s.split('.');
  if (parts.length > 1 && /^[a-z]{2,6}$/.test(parts[parts.length - 1])) parts.pop();
  if (parts.length > 1 && ['co', 'com', 'org', 'net', 'ac', 'gov'].includes(parts[parts.length - 1])) parts.pop();
  return parts.join('.').replace(/\s+/g, '');
}

/** Marks each row with counted=true/false and returns daily totals (minutes, capped at 24h). */
const COMPUTER = new Set(['extension', 'desktop', 'synapse']);
function dedupe(rows) {
  const groups = new Map(); // day|key -> rows
  for (const r of rows) {
    const k = r.day + '|' + appKey(r.app);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const winners = new Set();
  for (const group of groups.values()) {
    const maxOf = (list) => list.reduce((best, r) => (!best || r.minutes > best.minutes ? r : best), null);
    const self = maxOf(group.filter((r) => r.source === 'self'));
    const computer = maxOf(group.filter((r) => COMPUTER.has(r.source)));
    const phone = group.filter((r) => r.source === 'phone');
    const tracked = (computer ? computer.minutes : 0) + phone.reduce((a, r) => a + r.minutes, 0);
    if (self && self.minutes > tracked) winners.add(self);
    else {
      if (computer) winners.add(computer);
      phone.forEach((r) => winners.add(r));
      if (!computer && !phone.length && self) winners.add(self);
    }
    // Anything else (other sources) counts as-is.
    group.filter((r) => r.source !== 'self' && r.source !== 'phone' && !COMPUTER.has(r.source)).forEach((r) => winners.add(r));
  }
  const daily = {};
  for (const r of rows) {
    r.counted = winners.has(r);
    if (!r.counted) continue;
    daily[r.day] ??= { day: r.day, total: 0, byCategory: {}, bySource: {} };
    const d = daily[r.day];
    d.total += r.minutes;
    d.byCategory[r.category] = (d.byCategory[r.category] || 0) + r.minutes;
    d.bySource[r.source] = (d.bySource[r.source] || 0) + r.minutes;
  }
  for (const d of Object.values(daily)) {
    if (d.total > 1440) {
      const f = 1440 / d.total;
      d.total = 1440;
      for (const k of Object.keys(d.byCategory)) d.byCategory[k] *= f;
    }
  }
  return Object.values(daily).sort((a, b) => a.day.localeCompare(b.day));
}

module.exports = { appKey, dedupe, SOURCE_LABEL };
