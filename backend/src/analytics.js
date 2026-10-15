// Wellbeing analytics: feature extraction -> ML risk model + fuzzy inference -> explainable recommendations.
//
// HONESTY NOTE: the logistic-regression model is trained at startup on a synthetic dataset
// labelled by a published-heuristics-inspired scoring function (weak supervision). It is a
// coaching aid that turns activity patterns into a consistent score with per-feature
// explanations. It is NOT a clinically validated burnout or mental-health assessment.
const db = require('./db');
const { dedupe } = require('./usage');

// ---------------------------------------------------------------------------
// 1. Feature extraction
// ---------------------------------------------------------------------------
const FEATURES = [
  { key: 'screenHours', label: 'Average daily screen time', unit: 'h/day', mean: 5, sd: 2.5 },
  { key: 'leisureShare', label: 'Share of screen time on social/entertainment', unit: '%', mean: 0.35, sd: 0.2, pct: true },
  { key: 'lateRatio', label: 'Focus sessions started after 10 pm', unit: '%', mean: 0.15, sd: 0.2, pct: true },
  { key: 'breakRatio', label: 'Breaks taken per completed focus session', unit: 'ratio', mean: 0.7, sd: 0.4 },
  { key: 'focusHours', label: 'Average daily deep-focus time', unit: 'h/day', mean: 2, sd: 1.5 },
  { key: 'abandonRate', label: 'Focus sessions abandoned early', unit: '%', mean: 0.2, sd: 0.2, pct: true },
  { key: 'screenTrend', label: 'Screen time change vs previous week', unit: '%', mean: 0, sd: 0.3, pct: true },
  { key: 'stress', label: 'Self-reported stress (1-5)', unit: '/5', mean: 2.8, sd: 1 },
  { key: 'energy', label: 'Self-reported energy (1-5)', unit: '/5', mean: 3.2, sd: 1 },
  { key: 'sleepHours', label: 'Self-reported sleep', unit: 'h/night', mean: 7, sd: 1.2 },
];
const LEISURE = new Set(['social', 'entertainment', 'games', 'news']);

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}
function shiftDay(day, n) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
}

function extractFeatures(userId, today) {
  const start7 = shiftDay(today, -6);
  const start14 = shiftDay(today, -13);

  // Flatten de-duplicated daily totals (see usage.js) into day/category rows.
  const usage = dedupe(db.prepare(
    `SELECT day, app, category, minutes, source FROM app_usage WHERE user_id = ? AND day BETWEEN ? AND ?`
  ).all(userId, start14, today)).flatMap((d) => Object.entries(d.byCategory).map(([category, m]) => ({ day: d.day, category, m })));
  const sessions = db.prepare(
    `SELECT kind, actual_min, completed, day, started_at FROM focus_sessions
      WHERE user_id = ? AND day BETWEEN ? AND ?`
  ).all(userId, start7, today);
  const moods = db.prepare(
    `SELECT energy, stress, sleep_h FROM mood_checkins WHERE user_id = ? AND day BETWEEN ? AND ?`
  ).all(userId, start7, today);

  const thisWeek = usage.filter((u) => u.day >= start7);
  const lastWeek = usage.filter((u) => u.day < start7);
  const usageDays = new Set(thisWeek.map((u) => u.day));
  const lastDays = new Set(lastWeek.map((u) => u.day));
  const totalThis = thisWeek.reduce((s, u) => s + u.m, 0);
  const totalLast = lastWeek.reduce((s, u) => s + u.m, 0);
  const leisure = thisWeek.filter((u) => LEISURE.has(u.category)).reduce((s, u) => s + u.m, 0);

  const focus = sessions.filter((s) => s.kind === 'focus');
  const doneFocus = focus.filter((s) => s.completed);
  const doneBreaks = sessions.filter((s) => s.kind === 'break' && s.completed);
  const late = focus.filter((s) => {
    const h = parseInt(String(s.started_at).slice(11, 13), 10);
    return h >= 22 || h < 5;
  });
  const focusDays = new Set(sessions.map((s) => s.day));

  const avgThis = usageDays.size ? totalThis / usageDays.size : null;
  const avgLast = lastDays.size ? totalLast / lastDays.size : null;
  const avg = (arr, k) => {
    const v = arr.map((r) => r[k]).filter((x) => x != null);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };

  const raw = {
    screenHours: avgThis != null ? avgThis / 60 : null,
    leisureShare: totalThis ? leisure / totalThis : null,
    lateRatio: focus.length ? late.length / focus.length : null,
    breakRatio: doneFocus.length ? doneBreaks.length / doneFocus.length : null,
    focusHours: focusDays.size ? doneFocus.reduce((s, f) => s + f.actual_min, 0) / 60 / focusDays.size : null,
    abandonRate: focus.length ? (focus.length - doneFocus.length) / focus.length : null,
    screenTrend: avgThis != null && avgLast ? (avgThis - avgLast) / avgLast : null,
    stress: moods.length ? avg(moods, 'stress') : null,
    energy: moods.length ? avg(moods, 'energy') : null,
    sleepHours: moods.some((m) => m.sleep_h != null) ? avg(moods, 'sleep_h') : null,
  };

  const daysWithData = new Set([...usageDays, ...focusDays]).size;
  return { raw, daysWithData, counts: { focusSessions: focus.length, usageDays: usageDays.size, checkins: moods.length } };
}

// ---------------------------------------------------------------------------
// 2. Machine-learning model: logistic regression trained on synthetic weak labels
// ---------------------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rand) {
  return Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Expert prior used only to label synthetic training data (weak supervision).
function priorRisk(f) {
  return (
    0.35 * (f.screenHours - 5) + 2.2 * (f.leisureShare - 0.35) + 2.5 * (f.lateRatio - 0.15) -
    1.6 * (f.breakRatio - 0.7) + 0.35 * (f.focusHours - 2) * (f.breakRatio < 0.4 ? 1.5 : 0.3) +
    1.8 * (f.abandonRate - 0.2) + 1.5 * (f.screenTrend) + 0.8 * (f.stress - 2.8) -
    0.6 * (f.energy - 3.2) - 0.55 * (f.sleepHours - 7)
  );
}

function standardize(f) {
  return FEATURES.map((d) => ((f[d.key] ?? d.mean) - d.mean) / d.sd);
}

function trainModel() {
  const rand = mulberry32(42);
  const X = [], y = [];
  for (let i = 0; i < 4000; i++) {
    const f = {
      screenHours: clamp(5 + 2.5 * gauss(rand), 0.5, 16),
      leisureShare: clamp(0.35 + 0.2 * gauss(rand), 0, 1),
      lateRatio: clamp(0.15 + 0.2 * gauss(rand), 0, 1),
      breakRatio: clamp(0.7 + 0.4 * gauss(rand), 0, 2),
      focusHours: clamp(2 + 1.5 * gauss(rand), 0, 9),
      abandonRate: clamp(0.2 + 0.2 * gauss(rand), 0, 1),
      screenTrend: clamp(0.3 * gauss(rand), -0.8, 1.5),
      stress: clamp(2.8 + gauss(rand), 1, 5),
      energy: clamp(3.2 + gauss(rand), 1, 5),
      sleepHours: clamp(7 + 1.2 * gauss(rand), 3, 11),
    };
    const p = 1 / (1 + Math.exp(-(priorRisk(f) + 0.6 * gauss(rand))));
    X.push(standardize(f));
    y.push(rand() < p ? 1 : 0);
  }
  // Batch gradient descent with L2 regularisation.
  const n = FEATURES.length;
  const w = new Array(n).fill(0);
  let b = 0;
  const lr = 0.3, l2 = 0.001;
  for (let epoch = 0; epoch < 300; epoch++) {
    const gw = new Array(n).fill(0);
    let gb = 0;
    for (let i = 0; i < X.length; i++) {
      let z = b;
      for (let j = 0; j < n; j++) z += w[j] * X[i][j];
      const err = 1 / (1 + Math.exp(-z)) - y[i];
      for (let j = 0; j < n; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < n; j++) w[j] -= lr * (gw[j] / X.length + l2 * w[j]);
    b -= lr * (gb / X.length);
  }
  let correct = 0;
  for (let i = 0; i < X.length; i++) {
    let z = b;
    for (let j = 0; j < n; j++) z += w[j] * X[i][j];
    if ((z > 0 ? 1 : 0) === y[i]) correct++;
  }
  return { w, b, trainAccuracy: correct / X.length, samples: X.length };
}

const MODEL = trainModel();

function mlPredict(raw) {
  const x = standardize(raw);
  let z = MODEL.b;
  const contributions = FEATURES.map((d, j) => {
    const missing = raw[d.key] == null;
    const c = missing ? 0 : MODEL.w[j] * x[j]; // contribution relative to an average user
    z += c;
    return { key: d.key, label: d.label, value: raw[d.key], contribution: c, missing };
  });
  return { risk: 1 / (1 + Math.exp(-z)), contributions };
}

// ---------------------------------------------------------------------------
// 3. Fuzzy inference (Mamdani style, centroid defuzzification)
// ---------------------------------------------------------------------------
const tri = (x, a, b, c) => (x <= a || x >= c ? 0 : x === b ? 1 : x < b ? (x - a) / (b - a) : (c - x) / (c - b));
const trapL = (x, b, c) => (x <= b ? 1 : x >= c ? 0 : (c - x) / (c - b)); // shoulder left
const trapR = (x, a, b) => (x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a)); // shoulder right

function fuzzyInfer(raw) {
  // Linguistic inputs, each normalised to an intuitive range with neutral defaults when missing.
  const screen = raw.screenHours ?? 5;
  const recovery = clamp(
    0.5 * clamp((raw.breakRatio ?? 0.7) / 1, 0, 1) + 0.5 * clamp(((raw.sleepHours ?? 7) - 4) / 4, 0, 1),
    0, 1
  ); // 0 poor .. 1 good
  const strain = clamp(
    0.4 * clamp(((raw.stress ?? 2.8) - 1) / 4, 0, 1) + 0.3 * (raw.lateRatio ?? 0.15) + 0.3 * (raw.abandonRate ?? 0.2),
    0, 1
  ); // 0 low .. 1 high

  const mf = {
    screen: { low: trapL(screen, 2, 4), moderate: tri(screen, 3, 5.5, 8), high: trapR(screen, 7, 10) },
    recovery: { poor: trapL(recovery, 0.3, 0.5), ok: tri(recovery, 0.35, 0.55, 0.75), good: trapR(recovery, 0.6, 0.8) },
    strain: { low: trapL(strain, 0.2, 0.4), medium: tri(strain, 0.25, 0.45, 0.65), high: trapR(strain, 0.5, 0.7) },
  };

  // Output sets on a 0-100 "load" axis.
  const out = {
    balanced: (u) => trapL(u, 25, 45),
    strained: (u) => tri(u, 30, 55, 80),
    atRisk: (u) => trapR(u, 65, 85),
  };

  const rules = [
    { text: 'IF screen time is high AND recovery is poor THEN at risk', fire: Math.min(mf.screen.high, mf.recovery.poor), out: 'atRisk' },
    { text: 'IF strain is high AND recovery is poor THEN at risk', fire: Math.min(mf.strain.high, mf.recovery.poor), out: 'atRisk' },
    { text: 'IF strain is high AND screen time is moderate THEN strained', fire: Math.min(mf.strain.high, mf.screen.moderate), out: 'strained' },
    { text: 'IF screen time is high AND recovery is ok THEN strained', fire: Math.min(mf.screen.high, mf.recovery.ok), out: 'strained' },
    { text: 'IF strain is medium AND recovery is ok THEN strained', fire: Math.min(mf.strain.medium, mf.recovery.ok), out: 'strained' },
    { text: 'IF recovery is poor AND strain is medium THEN strained', fire: Math.min(mf.recovery.poor, mf.strain.medium), out: 'strained' },
    { text: 'IF recovery is good AND strain is low THEN balanced', fire: Math.min(mf.recovery.good, mf.strain.low), out: 'balanced' },
    { text: 'IF screen time is low AND strain is low THEN balanced', fire: Math.min(mf.screen.low, mf.strain.low), out: 'balanced' },
    { text: 'IF screen time is moderate AND recovery is good THEN balanced', fire: Math.min(mf.screen.moderate, mf.recovery.good), out: 'balanced' },
  ];

  let num = 0, den = 0;
  for (let u = 0; u <= 100; u += 1) {
    let m = 0;
    for (const r of rules) if (r.fire > 0) m = Math.max(m, Math.min(r.fire, out[r.out](u)));
    num += u * m;
    den += m;
  }
  const load = den ? num / den : 50;
  const state = load < 40 ? 'balanced' : load < 65 ? 'strained' : 'at risk';
  return {
    load,
    state,
    inputs: { screenHours: screen, recovery, strain },
    memberships: mf,
    firedRules: rules.filter((r) => r.fire > 0.01).sort((a, b) => b.fire - a.fire).map((r) => ({ rule: r.text, strength: r.fire })),
  };
}

// ---------------------------------------------------------------------------
// 4. Recommendations with "because" explanations
// ---------------------------------------------------------------------------
const fmt = (d, v) => (v == null ? 'n/a' : d.pct ? `${Math.round(v * 100)}%` : `${Math.round(v * 10) / 10} ${d.unit}`);

function recommend(raw, ml, fuzzy) {
  const recs = [];
  const D = Object.fromEntries(FEATURES.map((d) => [d.key, d]));
  const add = (key, title, action, priority) =>
    recs.push({ title, action, priority, because: `${D[key].label} is ${fmt(D[key], raw[key])}`, feature: key });

  if (raw.breakRatio != null && raw.breakRatio < 0.5)
    add('breakRatio', 'Protect your breaks', 'Let the timer roll into a 5-minute break after every focus block. Stand up, look 20 ft away, refill water.', 3);
  if (raw.lateRatio != null && raw.lateRatio > 0.25)
    add('lateRatio', 'Set a focus curfew', 'Schedule your last focus session to end by 9:30 pm and use the Night Owls room\'s hard stop.', 3);
  if (raw.screenHours != null && raw.screenHours > 7)
    add('screenHours', 'Trim one screen block', 'Pick your biggest leisure app below and set a daily limit 30 minutes lower than today.', 2);
  if (raw.leisureShare != null && raw.leisureShare > 0.5)
    add('leisureShare', 'Swap a scroll for a reset', 'Replace one social/entertainment session with a 10-minute walk or a call with a friend.', 2);
  if (raw.screenTrend != null && raw.screenTrend > 0.2)
    add('screenTrend', 'Notice the upward drift', 'Your screen time rose this week. Check which app grew most in History and decide if that was intentional.', 2);
  if (raw.abandonRate != null && raw.abandonRate > 0.35)
    add('abandonRate', 'Shorten your sessions', 'Many sessions end early - try 15 or 25 minutes instead of 50 until finishing feels easy again.', 2);
  if (raw.focusHours != null && raw.focusHours > 5 && (raw.breakRatio ?? 1) < 0.7)
    add('focusHours', 'Ease the intensity', 'Long focus days with few breaks are a classic overload pattern. Cap deep work at 4 hours today.', 3);
  if (raw.sleepHours != null && raw.sleepHours < 6.5)
    add('sleepHours', 'Prioritise sleep', 'Short sleep amplifies stress. Aim for a consistent wind-down 30 minutes before bed with screens away.', 3);
  if (raw.stress != null && raw.stress >= 4)
    add('stress', 'Lower the load', 'High stress reported. Post a check-in, join the Gentle Start room, or talk to someone you trust. If stress persists, consider a professional.', 3);
  if (raw.energy != null && raw.energy <= 2)
    add('energy', 'Plan a low-energy day', 'Choose one must-do task, do it in a 15-minute session, and give yourself credit for it.', 1);

  if (!recs.length)
    recs.push({
      title: 'Keep your rhythm',
      action: 'Your patterns look balanced. Keep pairing focus with breaks and log screen time to keep insights accurate.',
      priority: 1,
      because: `Fuzzy state is "${fuzzy.state}" and no single factor stands out`,
      feature: null,
    });
  return recs.sort((a, b) => b.priority - a.priority).slice(0, 4);
}

function analyze(userId, today = isoDay(new Date())) {
  const { raw, daysWithData, counts } = extractFeatures(userId, today);
  const ml = mlPredict(raw);
  const fuzzy = fuzzyInfer(raw);
  const combined = 0.5 * ml.risk * 100 + 0.5 * fuzzy.load;
  const confidence = daysWithData >= 5 ? 'good' : daysWithData >= 2 ? 'limited' : 'very low';
  const D = Object.fromEntries(FEATURES.map((d) => [d.key, d]));

  const factors = ml.contributions
    .filter((c) => !c.missing && Math.abs(c.contribution) > 0.05)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .map((c) => ({
      ...c,
      display: fmt(D[c.key], c.value),
      typical: fmt(D[c.key], D[c.key].mean),
      direction: c.contribution > 0 ? 'raises' : 'lowers',
    }));

  return {
    day: today,
    score: Math.round(combined),
    state: combined < 40 ? 'balanced' : combined < 65 ? 'strained' : 'at risk',
    confidence,
    daysWithData,
    counts,
    ml: { risk: ml.risk, factors, model: { type: 'logistic regression', trainedOn: `${MODEL.samples} synthetic weak-labelled profiles`, trainAccuracy: MODEL.trainAccuracy } },
    fuzzy: { load: fuzzy.load, state: fuzzy.state, inputs: fuzzy.inputs, firedRules: fuzzy.firedRules },
    features: FEATURES.map((d) => ({ key: d.key, label: d.label, value: raw[d.key], display: fmt(d, raw[d.key]) })),
    recommendations: recommend(raw, ml, fuzzy),
    disclaimer: 'Coaching aid based on your activity patterns - not a medical or clinical assessment.',
  };
}

module.exports = { analyze, extractFeatures, fuzzyInfer, mlPredict, MODEL, FEATURES };
