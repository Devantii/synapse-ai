// Shared screen-time helpers.
//
// Overlap rule: the same app can arrive from several sources (typed in by the user, measured by the
// browser extension or the desktop tracker). "Instagram" typed in and "instagram.com" from the extension
// are treated as the same app; for each day and app only the largest value counts towards totals.
// Rows still exist individually so the user can see and delete each one.

const SOURCE_LABEL = { self: 'entered by you', synapse: 'this tab, measured', extension: 'browser extension', desktop: 'desktop tracker' };

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
function dedupe(rows) {
  const best = new Map(); // day|key -> row
  for (const r of rows) {
    const k = r.day + '|' + appKey(r.app);
    const cur = best.get(k);
    if (!cur || r.minutes > cur.minutes) best.set(k, r);
  }
  const winners = new Set(best.values());
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
