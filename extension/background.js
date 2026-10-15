// Synapse Screen Time - background service worker.
//
// What it measures: seconds the active tab of the focused browser window spends on each website,
// only while you are not idle (no input for 60 s) and the screen is not locked.
// What it stores: hostnames and second counts per local day. Never full URLs, page titles or content.
// What it sends: daily per-site minutes, to the Synapse server you configure, with a revocable device key.
import { categorize } from './categories.js';

const TICK_MIN = 0.5;        // checkpoint (and check focus state) every 30 s
const SYNC_MIN = 5;          // upload every 5 minutes
const MAX_GAP_S = 120;       // never credit more than 2 min for a single unobserved gap (sleep, crashes)
const IDLE_S = 60;
const KEEP_DAYS = 30;
const SYNC_DAYS = 7;
const DEFAULT_BLOCKING = { enabled: true, categories: ['social', 'entertainment', 'games'], sites: [] };
const DEFAULT_CONFIG = { server: '', key: '', paused: false, excluded: [], overrides: {}, blocking: DEFAULT_BLOCKING };
const ALLOW_MIN = 5;

// Serialise all state changes: Chrome can fire several events at once and storage writes would race.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

const pad = (n) => String(n).padStart(2, '0');
const localDay = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

async function load() {
  const s = await chrome.storage.local.get(['config', 'totals', 'current', 'status', 'focus', 'allowUntil']);
  const config = { ...DEFAULT_CONFIG, ...(s.config || {}) };
  config.blocking = { ...DEFAULT_BLOCKING, ...(config.blocking || {}) };
  return { config, totals: s.totals || {}, current: s.current || null, status: s.status || {}, focus: s.focus || null, allowUntil: s.allowUntil || {} };
}

export function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

function isExcluded(host, config) {
  const serverHost = config.server ? hostOf(config.server) : null;
  if (serverHost && host === serverHost) return true; // the Synapse dashboard measures itself
  return (config.excluded || []).some((e) => host === e || host.endsWith('.' + e));
}

async function activeHost(config) {
  if (config.paused) return null;
  const idle = await chrome.idle.queryState(IDLE_S);
  if (idle !== 'active') return null;
  const win = await chrome.windows.getLastFocused().catch(() => null);
  if (!win || !win.focused || win.incognito) return null;
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  if (!tab || tab.incognito) return null;
  const host = hostOf(tab.url || tab.pendingUrl || '');
  if (!host || isExcluded(host, config)) return null;
  return host;
}

// Credit [from, to) to host, splitting at local midnight.
function addTime(totals, host, from, to) {
  let t = from;
  while (t < to) {
    const d = new Date(t);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const end = Math.min(to, next);
    const day = localDay(t);
    totals[day] ??= {};
    totals[day][host] = (totals[day][host] || 0) + (end - t) / 1000;
    t = end;
  }
}

function prune(totals) {
  const cutoff = localDay(Date.now() - KEEP_DAYS * 86400000);
  for (const day of Object.keys(totals)) if (day < cutoff) delete totals[day];
}

/** Close the running segment, credit its time, and open a new one for whatever is active now. */
export function checkpoint() {
  return serial(async () => {
    const s = await load();
    const now = Date.now();
    if (s.current?.host && s.current.since < now) {
      const counted = Math.min((now - s.current.since) / 1000, MAX_GAP_S);
      if (counted > 0) addTime(s.totals, s.current.host, now - counted * 1000, now);
    }
    const host = await activeHost(s.config);
    prune(s.totals);
    await chrome.storage.local.set({ totals: s.totals, current: host ? { host, since: now } : null });
    return host;
  });
}

function buildPayload(totals, overrides) {
  const days = Object.keys(totals).sort().slice(-SYNC_DAYS);
  return days.map((day) => {
    let entries = Object.entries(totals[day])
      .map(([host, sec]) => ({ app: host, category: categorize(host, overrides), minutes: Math.round((sec / 60) * 100) / 100 }))
      .filter((e) => e.minutes >= 0.05)
      .sort((a, b) => b.minutes - a.minutes);
    if (entries.length > 300) {
      const rest = entries.slice(299).reduce((s, e) => s + e.minutes, 0);
      entries = entries.slice(0, 299).concat({ app: 'Other sites', category: 'other', minutes: Math.round(rest * 100) / 100 });
    }
    return { day, entries };
  }).filter((d) => d.entries.length);
}

async function setStatus(patch) {
  const { status = {} } = await chrome.storage.local.get('status');
  await chrome.storage.local.set({ status: { ...status, ...patch } });
}

async function request(server, key, method, path, body) {
  const res = await fetch(server.replace(/\/+$/, '') + path, {
    method,
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data?.error || `Server replied ${res.status}`);
    err.status = res.status;
    err.consent = data?.consentRequired;
    throw err;
  }
  return data;
}

/** Upload the last 7 days of totals. Each upload replaces earlier ones for those days, so retries are safe. */
export function sync() {
  return serial(async () => {
    const s = await load();
    if (!s.config.server || !s.config.key) {
      await setStatus({ ok: false, lastError: 'Not connected. Open Settings to add your server and device key.' });
      return { ok: false };
    }
    const days = buildPayload(s.totals, s.config.overrides);
    if (!days.length) {
      await setStatus({ ok: true, lastError: null, lastSync: Date.now() });
      return { ok: true, days: 0 };
    }
    try {
      const r = await request(s.config.server, s.config.key, 'PUT', '/api/device/usage', { days });
      await setStatus({ ok: true, lastError: null, lastSync: Date.now(), consentRequired: false });
      return { ok: true, ...r };
    } catch (e) {
      await setStatus({ ok: false, lastError: e.message, lastErrorAt: Date.now(), consentRequired: !!e.consent });
      return { ok: false, error: e.message };
    }
  });
}

async function ensureAlarms() {
  const existing = await chrome.alarms.getAll();
  if (!existing.some((a) => a.name === 'tick')) chrome.alarms.create('tick', { periodInMinutes: TICK_MIN });
  if (!existing.some((a) => a.name === 'sync')) chrome.alarms.create('sync', { periodInMinutes: SYNC_MIN, delayInMinutes: 1 });
}

// ---------------- focus-mode blocking ----------------
const focusActive = (focus) => !!focus?.focusing && focus.endsAt > Date.now();

function shouldBlock(host, s) {
  const b = s.config.blocking;
  if (!b.enabled || !focusActive(s.focus) || !host) return false;
  if ((s.allowUntil[host] || 0) > Date.now()) return false;
  if (isExcluded(host, s.config)) return false; // never block the Synapse dashboard or ignored sites
  if ((b.sites || []).some((x) => host === x || host.endsWith('.' + x))) return true;
  return (b.categories || []).includes(categorize(host, s.config.overrides));
}

async function enforce(tab, s) {
  if (!tab?.id || tab.incognito) return;
  const url = tab.url || tab.pendingUrl || '';
  const host = hostOf(url);
  if (!shouldBlock(host, s)) return;
  const page = chrome.runtime.getURL('blocked.html') +
    `?host=${encodeURIComponent(host)}&until=${s.focus.endsAt}&url=${encodeURIComponent(url)}`;
  await chrome.tabs.update(tab.id, { url: page }).catch(() => {});
}

async function enforceAll() {
  const s = await load();
  if (!focusActive(s.focus) || !s.config.blocking.enabled) return;
  for (const tab of await chrome.tabs.query({})) await enforce(tab, s);
}

/** Ask Synapse whether a focus block is running. Pauses open distracting tabs when one starts. */
async function refreshFocus() {
  const s = await load();
  if (!s.config.server || !s.config.key || !s.config.blocking.enabled) return s.focus;
  try {
    const f = await request(s.config.server, s.config.key, 'GET', '/api/device/focus');
    const focus = { focusing: !!f.focusing, endsAt: f.endsAt, checkedAt: Date.now() };
    const started = focusActive(focus) && !focusActive(s.focus);
    await chrome.storage.local.set({ focus });
    if (started) await enforceAll();
    return focus;
  } catch {
    return s.focus; // offline: keep the last known block until it expires on its own
  }
}

// ---------------- events ----------------
chrome.idle.setDetectionInterval(IDLE_S);
chrome.idle.onStateChanged.addListener(() => checkpoint());
chrome.tabs.onActivated.addListener(() => checkpoint());
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.url) await enforce(tab, await load());
  if (tab.active && (info.url || info.status === 'complete')) checkpoint();
});
chrome.tabs.onRemoved.addListener(() => checkpoint());
chrome.windows.onFocusChanged.addListener(() => checkpoint());
chrome.alarms.onAlarm.addListener(async (a) => {
  await checkpoint();
  if (a.name === 'tick') await refreshFocus();
  if (a.name === 'sync') await sync();
});
chrome.runtime.onStartup.addListener(() => { ensureAlarms(); checkpoint(); });
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await ensureAlarms();
  await checkpoint();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

// ---------------- messages from popup / options ----------------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  (async () => {
    switch (msg?.type) {
      case 'status': {
        await checkpoint();
        const s = await load();
        const { key, ...safeConfig } = s.config;
        return reply({ config: { ...safeConfig, hasKey: !!key }, today: s.totals[localDay(Date.now())] || {}, totals: s.totals, current: s.current, status: s.status, focus: focusActive(s.focus) ? s.focus : null });
      }
      case 'sync':
        await checkpoint();
        await refreshFocus();
        return reply(await sync());
      case 'allowTemp': {
        const host = hostOf('https://' + String(msg.host || ''));
        if (!host) return reply({ ok: false });
        const { allowUntil = {} } = await chrome.storage.local.get('allowUntil');
        for (const [h, t] of Object.entries(allowUntil)) if (t < Date.now()) delete allowUntil[h];
        allowUntil[host] = Date.now() + ALLOW_MIN * 60000;
        await chrome.storage.local.set({ allowUntil });
        return reply({ ok: true, until: allowUntil[host] });
      }
      case 'saveBlocking': {
        const s = await load();
        const b = msg.blocking || {};
        const blocking = {
          enabled: !!b.enabled,
          categories: (b.categories || []).filter((c) => typeof c === 'string'),
          sites: (b.sites || []).map((h) => hostOf('https://' + String(h).replace(/^https?:\/\//, '')) || '').filter(Boolean),
        };
        await chrome.storage.local.set({ config: { ...s.config, blocking } });
        if (blocking.enabled) { await refreshFocus(); await enforceAll(); }
        return reply({ ok: true });
      }
      case 'setPaused': {
        await checkpoint();
        const s = await load();
        await chrome.storage.local.set({ config: { ...s.config, paused: !!msg.paused } });
        await checkpoint();
        return reply({ ok: true });
      }
      case 'saveConfig': {
        const s = await load();
        const next = { ...s.config };
        if (typeof msg.server === 'string') next.server = msg.server.trim().replace(/\/+$/, '');
        if (typeof msg.key === 'string' && msg.key.trim()) next.key = msg.key.trim();
        if (Array.isArray(msg.excluded)) next.excluded = msg.excluded.map((h) => hostOf('https://' + h.replace(/^https?:\/\//, '')) || '').filter(Boolean);
        if (msg.overrides && typeof msg.overrides === 'object') next.overrides = msg.overrides;
        await chrome.storage.local.set({ config: next });
        await checkpoint();
        return reply({ ok: true });
      }
      case 'test': {
        const s = await load();
        const server = (msg.server ?? s.config.server).trim();
        const key = (msg.key || s.config.key || '').trim();
        if (!/^https?:\/\//.test(server)) return reply({ ok: false, error: 'Server address must start with http:// or https://' });
        if (!key) return reply({ ok: false, error: 'Paste the device key from Synapse > Privacy.' });
        try { return reply({ ok: true, ...(await request(server, key, 'GET', '/api/device/ping')) }); }
        catch (e) { return reply({ ok: false, error: e.status ? e.message : `Could not reach ${server}. Is the server running?` }); }
      }
      case 'disconnect': {
        const s = await load();
        await chrome.storage.local.set({ config: { ...s.config, key: '' }, status: {} });
        return reply({ ok: true });
      }
      case 'clearData':
        await serial(() => chrome.storage.local.set({ totals: {}, current: null }));
        return reply({ ok: true });
      default:
        return reply({ ok: false, error: 'Unknown request' });
    }
  })();
  return true; // async reply
});

// Debug/test hook (only reachable from the extension's own devtools).
self.synapse = { checkpoint, sync, load, buildPayload, refreshFocus, enforceAll };
ensureAlarms();
