import { initI18n } from './i18n.js';
// Synapse AI web dashboard. Plain ES modules, no build step.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTs = (d = new Date()) => `${localDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const shiftDay = (day, n) => { const d = new Date(day + 'T12:00:00'); d.setDate(d.getDate() + n); return localDay(d); };
const fmtDur = (ms) => { const m = Math.floor(ms / 60000); return m < 1 ? '<1m' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };
const fmtMin = (m) => { m = Math.round(m || 0); const h = Math.floor(m / 60), r = m % 60; return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`; };
const initials = (n) => String(n || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const ago = (sqlTs) => {
  const t = Date.parse(String(sqlTs).replace(' ', 'T') + (String(sqlTs).endsWith('Z') ? '' : 'Z'));
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const state = { token: store.get('synapse.token'), me: null, socket: null, cleanup: [] };

// ---------------------------------------------------------------- api
class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data; } }
async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401 && state.token && !url.startsWith('/auth') && url !== '/account') { signOut('Your session ended. Please sign in again.'); throw new ApiError('Signed out', 401); }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data);
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : 4200);
}
const fail = (e) => { if (e.status !== 401) toast(e.message, 'err'); };

function celebrate(res) {
  if (!res) return;
  for (const m of res.newMilestones || []) toast(`Milestone reached: ${m.title}`, 'win');
  if (res.leveledUp) toast(`Level ${res.rewards.level} reached`, 'win');
}

// ---------------------------------------------------------------- consents
const CONSENTS = [
  { key: 'activity_tracking', title: 'Save focus activity', desc: 'Store your timer sessions so you earn points, grow trees and keep streaks.' },
  { key: 'usage_tracking', title: 'Save screen-time data', desc: 'Store the app and site totals you enter, plus how long this Synapse tab is open and in front.' },
  { key: 'ai_insights', title: 'AI wellbeing insights', desc: 'Analyse your saved activity and private mood check-ins to give explained suggestions. Coach messages go to the AI provider only if the server has one configured.' },
  { key: 'community_profile', title: 'Show my name in the community', desc: 'Off posts your check-ins as "Anonymous member". Room chat always shows your name.' },
];
function consentControls(values) {
  return CONSENTS.map((c) => `
    <label class="switch"><strong>${c.title}</strong><p>${c.desc}</p>
      <input type="checkbox" name="${c.key}" ${values?.[c.key] ? 'checked' : ''} /></label>`).join('');
}
async function saveConsents(form) {
  const body = Object.fromEntries(CONSENTS.map((c) => [c.key, form.elements[c.key].checked]));
  state.me.consents = await api('PUT', '/consents', body);
  foreground.sync();
}

// ---------------------------------------------------------------- auth
function setupAuth() {
  const form = $('#auth-form');
  form.dataset.mode = 'login';
  $$('[data-auth-tab]').forEach((b) => b.addEventListener('click', () => {
    form.dataset.mode = b.dataset.authTab;
    $$('[data-auth-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    $('button[type=submit]', form).textContent = b.dataset.authTab === 'login' ? 'Sign in' : 'Create account';
    form.elements.password.autocomplete = b.dataset.authTab === 'login' ? 'current-password' : 'new-password';
    $('.form-error', form).textContent = '';
  }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = form.dataset.mode;
    const btn = $('button[type=submit]', form);
    const body = { username: form.elements.username.value.trim(), password: form.elements.password.value };
    if (mode === 'register') body.displayName = form.elements.displayName.value.trim() || body.username;
    btn.disabled = true;
    try {
      const r = await api('POST', mode === 'login' ? '/auth/login' : '/auth/register', body);
      state.token = r.token;
      store.set('synapse.token', r.token);
      form.reset();
      await enterApp(mode === 'register');
    } catch (err) {
      $('.form-error', form).textContent = err.message;
    } finally { btn.disabled = false; }
  });
  setupGoogle();
}

// "Continue with Google" (Google Identity Services). Shown only when the server has GOOGLE_CLIENT_ID.
const gsi = {
  clientId: undefined, handler: null, ready: null,
  async load() {
    if (this.clientId === undefined) {
      try { this.clientId = (await api('GET', '/auth/config')).googleClientId; } catch { this.clientId = null; }
    }
    if (!this.clientId) return false;
    this.ready ??= loadScript('https://accounts.google.com/gsi/client').then(() => {
      google.accounts.id.initialize({ client_id: this.clientId, callback: (r) => this.handler?.(r.credential), ux_mode: 'popup', auto_select: false, itp_support: true });
      return true;
    }).catch(() => { this.ready = null; return false; });
    return this.ready;
  },
  /** Draws Google's button into el; onCredential gets the signed ID token. */
  async button(el, onCredential, text = 'continue_with') {
    if (!el || !(await this.load())) return false;
    this.handler = onCredential;
    el.innerHTML = '';
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    google.accounts.id.renderButton(el, { theme: dark ? 'filled_black' : 'outline', size: 'large', shape: 'pill', text, logo_alignment: 'left',
      width: Math.min(400, Math.max(220, el.clientWidth || 320)) });
    return true;
  },
};

async function setupGoogle() {
  const box = $('#google-auth');
  const err = $('.form-error', $('#auth-form'));
  const ok = await gsi.button($('#google-btn'), async (credential) => {
    err.textContent = '';
    try {
      const r = await api('POST', '/auth/google', { credential });
      state.token = r.token;
      store.set('synapse.token', r.token);
      await enterApp(r.created);
    } catch (e) { err.textContent = e.message; }
  });
  box.hidden = !ok;
}

async function enterApp(isNew) {
  state.me = await api('GET', '/me');
  $('#auth').hidden = true;
  $('#app').hidden = false;
  $('#who').textContent = state.me.user.displayName;
  $('#nav-admin').hidden = !state.me.isAdmin;
  paintSideLevel();
  connectSocket();
  foreground.sync();
  timer.broadcast(); // re-sync a timer that was running before a reload
  if (isNew) {
    const dlg = $('#onboarding');
    $('[data-consent-host]', dlg).innerHTML = consentControls({ activity_tracking: 1, usage_tracking: 0, ai_insights: 0, community_profile: 1 });
    dlg.showModal();
    dlg.addEventListener('close', async () => {
      try { await saveConsents($('#onboarding-form')); } catch (e) { fail(e); }
      route();
    }, { once: true });
  }
  const qs = new URLSearchParams(location.search);
  if (qs.get('email')) {
    toast(qs.get('email') === 'verified' ? 'Email confirmed. You can turn on the weekly report now.' : 'That confirmation link has expired. Save your address again.', qs.get('email') === 'verified' ? 'win' : 'err');
    history.replaceState(null, '', location.pathname + location.hash);
  }
  if (!location.hash) location.hash = '#/today';
  route();
}

function signOut(msg) {
  foreground.flush();
  ambient.stop();
  rtc.leave();
  state.socket?.disconnect();
  state.socket = null;
  state.token = null;
  state.me = null;
  store.del('synapse.token');
  $('#app').hidden = true;
  $('#auth').hidden = false;
  if (msg) toast(msg);
}

// ---------------------------------------------------------------- socket
function connectSocket() {
  if (state.socket || typeof io === 'undefined') return;
  const s = io({ auth: { token: state.token } });
  state.socket = s;
  s.on('connect_error', (err) => { if (err.message === 'unauthorized') signOut('Your session ended. Please sign in again.'); });
  s.on('rtc:signal', (m) => rtc.onSignal(m));
  s.on('audio:peer-left', ({ socketId }) => rtc.dropPeer(socketId));
  s.on('connect', () => { if (rooms.current) s.emit('room:join', { roomId: rooms.current }); });
  s.on('buddy:cheer', (m) => { toast(`${m.text}.`, 'win'); chime(); if (currentView() === 'community') renderBuddies(); });
  s.on('buddy:request', (m) => { toast(`${m.from} wants to be accountability buddies. See Community.`); if (currentView() === 'community') renderBuddies(); });
}
const emitAck = (ev, data) => new Promise((resolve) => state.socket ? state.socket.timeout(8000).emit(ev, data, (err, r) => resolve(err ? { error: 'Connection timed out.' } : r)) : resolve({ error: 'Not connected.' }));

// ---------------------------------------------------------------- foreground time (this tab only)
const foreground = {
  acc: 0, last: null, timer: null, enabled: false,
  sync() {
    this.enabled = !!state.me?.consents?.usage_tracking;
    clearInterval(this.timer);
    this.last = this.active() ? Date.now() : null;
    if (this.enabled) this.timer = setInterval(() => this.tick(true), 15000);
  },
  active() { return document.visibilityState === 'visible' && document.hasFocus(); },
  tick(maybeSend) {
    const now = Date.now();
    if (this.last) this.acc += now - this.last;
    this.last = this.active() ? now : null;
    if (maybeSend && this.acc >= 60000) this.flush();
  },
  flush(keepalive = false) {
    if (!this.enabled || !state.token) { this.acc = 0; return; }
    this.tick(false);
    const minutes = Math.min(10, this.acc / 60000);
    if (minutes < 0.1) return;
    this.acc = 0;
    fetch('/api/usage/foreground', {
      method: 'POST', keepalive,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
      body: JSON.stringify({ day: localDay(), minutes: Math.round(minutes * 100) / 100 }),
    }).catch(() => {});
  },
};
['visibilitychange', 'focus', 'blur'].forEach((ev) => window.addEventListener(ev, () => {
  if (!foreground.enabled) return;
  foreground.tick(false);
  if (document.visibilityState === 'hidden') foreground.flush(true);
}));
window.addEventListener('pagehide', () => foreground.flush(true));

// ---------------------------------------------------------------- timer
const PRESETS = { focus: [15, 25, 50], break: [5, 10, 15] };
const DISTRACT = { phone: 'Phone', social: 'Social media', messages: 'Messages', thoughts: 'Wandering thoughts', people: 'Someone interrupted', noise: 'Noise', tired: 'Tired or hungry', other: 'Other' };
let distractCount = 0;
const timer = {
  s: store.get('synapse.timer') || { mode: 'focus', planned: 25, running: false, startedAt: null, endsAt: null, tag: '' },
  withered: false,
  save() { store.set('synapse.timer', this.s); },
  remaining() { return this.s.running ? Math.max(0, this.s.endsAt - Date.now()) : this.s.planned * 60000; },
  progress() { return this.s.running ? 1 - this.remaining() / (this.s.planned * 60000) : 0; },
  setMode(mode, planned) {
    if (this.s.running) return;
    this.withered = false;
    this.s.mode = mode;
    this.s.planned = planned ?? PRESETS[mode][mode === 'focus' ? 1 : 0];
    this.save(); paintTimer();
  },
  start() {
    if (this.s.running) return;
    if (!state.me.consents.activity_tracking) toast('Sessions will not be saved until you enable "Save focus activity" in Privacy.');
    this.withered = false;
    this.s.running = true;
    this.s.startedAt = Date.now();
    this.s.endsAt = Date.now() + this.s.planned * 60000;
    this.save(); paintTimer(); this.broadcast();
  },
  async stop(completed) {
    if (!this.s.running) return;
    const s = { ...this.s };
    const actual = Math.min(s.planned, (Date.now() - s.startedAt) / 60000);
    this.s.running = false;
    if (!completed && s.mode === 'focus') this.withered = true;
    this.save(); this.broadcast();
    if (completed) {
      chime();
      if (s.mode === 'focus') notify('Focus block done', `Nice work. Take a ${s.planned >= 50 ? 10 : 5}-minute break: stretch, breathe or rest your eyes.`);
      else notify("Break's over", 'Ready for the next focus block?');
    }
    try {
      if (state.me.consents.activity_tracking) {
        const started = new Date(s.startedAt);
        const res = await api('POST', '/sessions', {
          kind: s.mode, plannedMin: s.planned, actualMin: completed ? s.planned : Math.round(actual * 100) / 100, completed,
          tag: s.tag || undefined, day: localDay(started), startedAt: localTs(started), endedAt: localTs(),
          taskId: s.mode === 'focus' && s.taskId ? s.taskId : undefined,
        });
        state.me.rewards = res.rewards;
        if (s.mode === 'focus' && completed) toast(res.tree ? `+${res.earned} points and a new ${res.tree.species} in your garden` : `+${res.earned} points`, 'win');
        else if (s.mode === 'break' && completed) toast(`Break taken, +${res.earned} points`, 'win');
        else if (res.earned) toast(`Session ended early. +${res.earned} points, the tree did not make it this time.`);
        if (res.capped) toast("You've hit today's point cap. Rest counts too.");
        celebrate(res);
      }
    } catch (e) { fail(e); }
    if (completed && s.mode === 'focus') this.setMode('break', s.planned >= 50 ? 10 : 5);
    else if (completed && s.mode === 'break') this.setMode('focus', 25);
    else paintTimer();
    if (currentView() === 'today') renderTodaySide();
  },
  broadcast() {
    state.socket?.emit('room:status', { focusing: this.s.running && this.s.mode === 'focus', focusEndsAt: this.s.running ? this.s.endsAt : null });
    // Lets the browser extension pause distracting sites while a focus block runs.
    if (state.token) api('PUT', '/focus/state', this.s.running ? { mode: this.s.mode, endsAt: this.s.endsAt } : { mode: null }).catch(() => {});
  },
};
setInterval(() => {
  if (timer.s.running && timer.remaining() <= 0) timer.stop(true);
  paintTimer();
}, 1000);

function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [523.25, 659.25, 783.99].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + i * 0.18 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.9);
      o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + i * 0.18); o.stop(ctx.currentTime + i * 0.18 + 1);
    });
  } catch {}
}

// ---------------------------------------------------------------- Ambient sounds
// Generated live with the Web Audio API (no audio files): rain, ocean waves, wind and brown noise.
const ambient = {
  SOUNDS: { lofi: 'Lo-fi music', rain: 'Rain', waves: 'Waves', wind: 'Wind', brown: 'Brown noise' },
  ctx: null, master: null, nodes: [], kind: null,
  vol: store.get('synapse.ambient')?.vol ?? 0.5,
  buffer(brown) {
    const ctx = this.ctx, len = ctx.sampleRate * 4, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
    }
    return buf;
  },
  source(brown) { const s = this.ctx.createBufferSource(); s.buffer = this.buffer(brown); s.loop = true; this.nodes.push(s); return s; },
  lfo(freq, depth, target) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.value = freq; g.gain.value = depth; o.connect(g).connect(target); o.start(); this.nodes.push(o);
  },
  play(kind) {
    this.stop(true);
    if (!kind || !this.SOUNDS[kind]) return this.paint();
    this.ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    this.ctx.resume();
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.gain.linearRampToValueAtTime(this.vol * 0.6, ctx.currentTime + 1.5); // fade in
    this.master.connect(ctx.destination);
    if (kind === 'brown') this.source(true).connect(this.master);
    if (kind === 'rain') {
      const hiss = this.source(false), bp = ctx.createBiquadFilter(), g = ctx.createGain();
      bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 0.5; g.gain.value = 0.35;
      hiss.connect(bp).connect(g).connect(this.master);
      const body = this.source(true), lp = ctx.createBiquadFilter(), g2 = ctx.createGain();
      lp.type = 'lowpass'; lp.frequency.value = 900; g2.gain.value = 0.6;
      body.connect(lp).connect(g2).connect(this.master);
      this.lfo(0.13, 0.08, g.gain);
    }
    if (kind === 'waves') {
      const n = this.source(true), lp = ctx.createBiquadFilter(), g = ctx.createGain();
      lp.type = 'lowpass'; lp.frequency.value = 700; g.gain.value = 0.55;
      n.connect(lp).connect(g).connect(this.master);
      this.lfo(0.09, 0.45, g.gain); // slow swell
      this.lfo(0.09, 350, lp.frequency);
    }
    if (kind === 'lofi') this.lofi();
    if (kind === 'wind') {
      const n = this.source(false), bp = ctx.createBiquadFilter(), g = ctx.createGain();
      bp.type = 'bandpass'; bp.frequency.value = 600; bp.Q.value = 1.2; g.gain.value = 0.5;
      n.connect(bp).connect(g).connect(this.master);
      this.lfo(0.05, 300, bp.frequency);
      this.lfo(0.11, 0.25, g.gain);
    }
    this.nodes.forEach((x) => x.start && !(x instanceof OscillatorNode) && x.start());
    this.kind = kind;
    this.save(); this.paint();
  },
  // Endless generative lo-fi: jazzy 7th chords, a soft melody, a lazy beat and vinyl crackle at 72 bpm.
  lofi() {
    const ctx = this.ctx, out = ctx.createGain(), lp = ctx.createBiquadFilter();
    out.gain.value = 0.9; lp.type = 'lowpass'; lp.frequency.value = 2200;
    lp.connect(out).connect(this.master);
    const crackle = this.source(false), hp = ctx.createBiquadFilter(), cg = ctx.createGain();
    hp.type = 'highpass'; hp.frequency.value = 4000; cg.gain.value = 0.012;
    crackle.connect(hp).connect(cg).connect(out);
    const noise = this.buffer(false);
    const hz = (m) => 440 * 2 ** ((m - 69) / 12);
    const CHORDS = [[48, 55, 59, 64], [45, 52, 55, 60], [50, 57, 60, 65], [43, 50, 53, 59]]; // Cmaj7 Am7 Dm7 G7
    const SCALE = [72, 74, 76, 79, 81, 84];
    const eighth = 60 / 72 / 2;
    const tone = (freq, t, dur, vol, type = 'sine') => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.04); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(lp); o.start(t); o.stop(t + dur + 0.05);
    };
    const hit = (t, dur, vol, type, f) => {
      const n = ctx.createBufferSource(), flt = ctx.createBiquadFilter(), g = ctx.createGain();
      n.buffer = noise; flt.type = type; flt.frequency.value = f;
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      n.connect(flt).connect(g).connect(out); n.start(t, Math.random() * 2); n.stop(t + dur + 0.02);
    };
    const kick = (t) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
      g.gain.setValueAtTime(0.55, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g).connect(out); o.start(t); o.stop(t + 0.32);
    };
    let step = 0, next = ctx.currentTime + 0.15;
    const schedule = () => {
      while (next < ctx.currentTime + 0.5) {
        const t = next + (step % 2 ? 0.035 : 0); // a little swing
        const chord = CHORDS[Math.floor(step / 8) % CHORDS.length];
        if (step % 8 === 0) chord.forEach((m, i) => { tone(hz(m), t, eighth * 8, 0.05, i % 2 ? 'triangle' : 'sine'); });
        if (step % 8 === 0 || step % 8 === 5) kick(t);
        if (step % 8 === 4) hit(t, 0.16, 0.12, 'bandpass', 1800);
        if (step % 2 === 1) hit(t, 0.04, 0.035, 'highpass', 7000);
        if (Math.random() < 0.3 && step % 8 !== 0) tone(hz(SCALE[Math.floor(Math.random() * SCALE.length)]), t, eighth * 2.5, 0.035, 'triangle');
        next += eighth; step++;
      }
    };
    schedule();
    this.lofiTimer = setInterval(schedule, 120);
  },
  stop(quick) {
    clearInterval(this.lofiTimer);
    this.lofiTimer = null;
    const old = this.nodes, master = this.master;
    this.nodes = []; this.master = null; this.kind = null;
    if (master && this.ctx) {
      master.gain.cancelScheduledValues(this.ctx.currentTime);
      master.gain.setTargetAtTime(0, this.ctx.currentTime, quick ? 0.05 : 0.3);
      setTimeout(() => { old.forEach((x) => { try { x.stop(); } catch {} }); master.disconnect(); }, quick ? 300 : 1500);
    }
    if (!quick) { this.save(); this.paint(); }
  },
  setVol(v) {
    this.vol = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v * 0.6, this.ctx.currentTime, 0.1);
    this.save();
  },
  save() { store.set('synapse.ambient', { vol: this.vol }); },
  paint() {
    $$('[data-amb]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.amb || null) === this.kind || (!b.dataset.amb && !this.kind))));
    $$('.amb-vol').forEach((r) => { r.disabled = !this.kind; });
  },
  controls() {
    return `<div class="ambient"><span class="amb-label"><svg aria-hidden="true"><use href="#i-sound"/></svg>Sounds</span>
      <div class="chips">${Object.entries(this.SOUNDS).map(([k, v]) => `<button type="button" class="chip" data-amb="${k}" aria-pressed="${this.kind === k}">${v}</button>`).join('')}
      <button type="button" class="chip" data-amb="" aria-pressed="${!this.kind}">Off</button></div>
      <input type="range" class="amb-vol" min="0" max="1" step="0.05" value="${this.vol}" aria-label="Sound volume" ${this.kind ? '' : 'disabled'} /></div>`;
  },
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-amb]');
  if (b) ambient.play(b.dataset.amb || null);
});
document.addEventListener('input', (e) => { if (e.target.classList?.contains('amb-vol')) ambient.setVol(+e.target.value); });

function speciesFor(min) { return min >= 50 ? 'oak' : min >= 40 ? 'cedar' : min >= 30 ? 'maple' : 'sapling'; }

function paintTimer() {
  const rem = timer.remaining();
  const mm = Math.floor(rem / 60000), ss = Math.floor((rem % 60000) / 1000);
  const digits = `${pad(mm)}:${pad(ss)}`;
  const mini = $('#mini-timer');
  if (mini) {
    const show = timer.s.running && currentView() !== 'today' && !$('#app').hidden;
    mini.hidden = !show;
    if (show) mini.innerHTML = `<a href="#/today" style="color:inherit;text-decoration:none">${timer.s.mode === 'focus' ? 'Focus' : 'Break'} ${digits}</a>`;
  }
  const plot = $('.plot');
  if (!plot) return;
  const p = timer.progress();
  plot.dataset.mode = timer.s.mode;
  plot.toggleAttribute('data-withered', timer.withered);
  $('.digits', plot).textContent = digits;
  $('.phase', plot).textContent = timer.s.running
    ? timer.s.mode === 'focus' ? 'Growing. Stay with it.' : 'Rest. Look away from the screen.'
    : timer.withered ? 'This one wilted. Try a shorter block.' : timer.s.mode === 'focus' ? 'Ready to focus' : 'Break is ready';
  const C = 2 * Math.PI * 47;
  $('.ring-fill', plot).style.strokeDashoffset = String(C * (1 - p));
  const tree = $('.plot-tree', plot);
  tree.style.setProperty('--grow', String(timer.s.mode === 'focus' ? 0.24 + 0.76 * (timer.withered ? 0.5 : p) : 0.0001));
  $('use', tree).setAttribute('href', `#tree-${speciesFor(timer.s.planned)}`);
  document.title = timer.s.running ? `${digits} - Synapse AI` : 'Synapse AI';

  const ctr = $('.timer-controls');
  const key = `${timer.s.running}-${timer.s.mode}`;
  if (ctr && ctr.dataset.key !== key) {
    ctr.dataset.key = key;
    ctr.innerHTML = timer.s.running
      ? timer.s.mode === 'focus'
        ? `<button class="btn" data-act="distracted" aria-expanded="false">Got distracted?</button><button class="btn" data-act="giveup">Give up</button>
           <div class="distract-pick" id="distract-pick" hidden><p>What pulled you away? Tap it, then come straight back. The timer keeps going.</p>
             <div class="chips">${Object.entries(DISTRACT).map(([k, v]) => `<button type="button" class="chip" data-distract="${k}">${v}</button>`).join('')}</div></div>
           <small class="muted distract-count" id="distract-count">${distractCount ? `${distractCount} logged this block` : ''}</small>`
        : `<button class="btn" data-act="endbreak">End break</button>`
      : timer.s.mode === 'focus'
        ? `<button class="btn grow" data-act="start">Start ${timer.s.planned}-minute focus</button><button class="btn quiet" data-act="tobreak">Take a break instead</button>`
        : `<button class="btn rest" data-act="start">Start ${timer.s.planned}-minute break</button><button class="btn quiet" data-act="tofocus">Skip break</button>`;
    $('.presets').hidden = timer.s.running;
    if ($('#suggest')) $('#suggest').hidden = timer.s.running || timer.s.mode !== 'focus';
    if (timer.s.running) distractCount = timer.s.mode === 'focus' ? distractCount : 0; else distractCount = 0;
    $('.presets').innerHTML = PRESETS[timer.s.mode].map((m) => `<button class="chip" aria-pressed="${m === timer.s.planned}" data-preset="${m}">${m} min</button>`).join('');
    $('#tag-field').hidden = timer.s.running || timer.s.mode !== 'focus';
    breakGuide.sync();
  }
  if (ctr) $$('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.preset === timer.s.planned)));
}

// ---------------------------------------------------------------- guided breaks
// Short routines that make a break restorative instead of a phone scroll.
const GUIDES = {
  breathe: { label: 'Breathe', blurb: 'Box breathing calms your nervous system in about a minute.' },
  stretch: {
    label: 'Stretch', blurb: 'Loosen what sitting tightens. 30 seconds each.',
    steps: [
      ['Neck', 'Drop your right ear toward your shoulder, breathe, then switch sides.'],
      ['Shoulders', 'Roll your shoulders back slowly ten times, then forward ten times.'],
      ['Chest', 'Clasp your hands behind your back and gently lift them as you open your chest.'],
      ['Wrists', 'Stretch each arm out, palm up, and gently pull your fingers back with the other hand.'],
      ['Reach', 'Stand up, reach both arms overhead and lean slowly to each side.'],
    ],
  },
  eyes: {
    label: 'Rest your eyes', blurb: 'The 20-20-20 rule eases screen strain.',
    steps: [
      ['Look far', 'Find something at least 6 metres (20 ft) away and look at it.'],
      ['Blink', 'Blink slowly and fully, about ten times.'],
      ['Palm', 'Close your eyes and cup your palms over them. Let the darkness rest them.'],
    ],
    secs: 20,
  },
  move: {
    label: 'Move', blurb: 'Your body has been still. Pick any two.',
    checklist: ['Refill your water and drink half a glass', 'Walk to a window or step outside', 'Do 10 slow calf raises', 'Look away from every screen, including your phone'],
  },
};
const breakGuide = {
  timer: null,
  kind: store.get('synapse.breakGuide') || 'breathe',
  stop() { clearTimeout(this.timer); this.timer = null; },
  sync() {
    const el = $('#break-guide');
    if (!el) return this.stop();
    const show = timer.s.mode === 'break';
    if (!show) { el.hidden = true; el.innerHTML = ''; return this.stop(); }
    if (!el.hidden && el.dataset.kind === this.kind) return;
    el.hidden = false;
    this.render(el);
  },
  choose(kind) { this.kind = kind; store.set('synapse.breakGuide', kind); const el = $('#break-guide'); if (el) this.render(el); },
  render(el) {
    this.stop();
    el.dataset.kind = this.kind;
    const g = GUIDES[this.kind];
    el.innerHTML = `
      <div class="chips" role="tablist" aria-label="Break activity">${Object.entries(GUIDES).map(([k, v]) =>
        `<button class="chip" role="tab" aria-selected="${k === this.kind}" aria-pressed="${k === this.kind}" data-guide="${k}">${v.label}</button>`).join('')}</div>
      <p class="muted guide-blurb">${g.blurb}</p>
      <div class="guide-body" aria-live="polite"></div>`;
    el.onclick = (e) => { const b = e.target.closest('[data-guide]'); if (b) this.choose(b.dataset.guide); };
    const body = $('.guide-body', el);
    if (this.kind === 'breathe') return this.breathe(body);
    if (g.checklist) {
      body.innerHTML = `<ul class="guide-check">${g.checklist.map((c, i) => `<li><label><input type="checkbox" id="gc${i}" /> ${c}</label></li>`).join('')}</ul>`;
      return;
    }
    this.steps(body, g.steps, g.secs || 30);
  },
  breathe(body) {
    const phases = [['Breathe in', 1], ['Hold', 1], ['Breathe out', 0.55], ['Hold', 0.55]];
    body.innerHTML = `<div class="breath"><div class="breath-orb"></div><div class="breath-text"><b></b><span class="num"></span></div></div><p class="muted guide-foot">Four counts each. <span class="num" id="breath-rounds">0</span> rounds so far.</p>`;
    const orb = $('.breath-orb', body), word = $('.breath-text b', body), count = $('.breath-text span', body);
    let phase = 0, n = 4, rounds = 0;
    const step = () => {
      if (!body.isConnected) return this.stop();
      if (n === 4) { word.textContent = phases[phase][0]; orb.style.transform = `scale(${phases[phase][1]})`; }
      count.textContent = n;
      n -= 1;
      if (n === 0) { n = 4; phase = (phase + 1) % 4; if (phase === 0) $('#breath-rounds', body).textContent = ++rounds; }
      this.timer = setTimeout(step, 1000);
    };
    step();
  },
  steps(body, steps, secs) {
    let i = 0, left = secs;
    body.innerHTML = `<div class="guide-step"><div class="guide-count num"></div><div><b class="guide-title"></b><p class="guide-text"></p></div></div>
      <div class="guide-nav"><span class="muted num guide-pos"></span><button class="btn quiet" data-next>Next</button></div>`;
    const paint = () => {
      $('.guide-title', body).textContent = steps[i][0];
      $('.guide-text', body).textContent = steps[i][1];
      $('.guide-count', body).textContent = left;
      $('.guide-pos', body).textContent = `${i + 1} of ${steps.length}`;
      $('[data-next]', body).textContent = i === steps.length - 1 ? 'Start over' : 'Next';
    };
    const next = () => { i = (i + 1) % steps.length; left = secs; paint(); };
    $('[data-next]', body).onclick = () => { next(); };
    const tick = () => {
      if (!body.isConnected) return this.stop();
      left -= 1;
      if (left <= 0) { if (i === steps.length - 1) { left = 0; paint(); $('.guide-count', body).textContent = '✓'; return; } next(); } else paint();
      this.timer = setTimeout(tick, 1000);
    };
    paint();
    this.timer = setTimeout(tick, 1000);
  },
};

// ---------------------------------------------------------------- router
const VIEWS = {};
const currentView = () => (location.hash.replace(/^#\//, '').split('/')[0] || 'today');
async function route() {
  if (!state.me) return;
  state.cleanup.forEach((f) => { try { f(); } catch {} });
  state.cleanup = [];
  breakGuide.stop();
  const tip = document.getElementById('chart-tip'); if (tip) tip.hidden = true;
  const [view, arg] = location.hash.replace(/^#\//, '').split('/');
  const name = VIEWS[view] ? view : 'today';
  $$('.rail a').forEach((a) => (a.dataset.nav === name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  // Fresh <main> per view so listeners from the previous view don't pile up.
  const old = $('#main');
  const main = old.cloneNode(false);
  old.replaceWith(main);
  try { await VIEWS[name](main, arg ? decodeURIComponent(arg) : null); } catch (e) { fail(e); }
  paintTimer();
}
window.addEventListener('hashchange', () => { route(); $('#main').focus({ preventScroll: true }); window.scrollTo(0, 0); });

// ---------------------------------------------------------------- Today
VIEWS.today = async (main) => {
  const C = 2 * Math.PI * 47;
  main.innerHTML = `
    <div class="today">
      <section class="plot-wrap" aria-label="Focus timer">
        <div class="plot" data-mode="focus">
          <svg class="ring" viewBox="0 0 100 100" aria-hidden="true">
            <circle class="ring-track" cx="50" cy="50" r="47" fill="none" stroke-width="3" />
            <circle class="ring-fill" cx="50" cy="50" r="47" fill="none" stroke-width="3" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C}" />
          </svg>
          <div class="plot-bed"></div>
          <svg class="plot-tree" viewBox="0 0 200 200" aria-hidden="true"><use href="#tree-sapling" /></svg>
          <div class="plot-time" role="timer" aria-live="off"><div class="digits num">25:00</div><div class="phase"></div></div>
        </div>
        <div class="chips presets"></div>
        <p class="suggest" id="suggest" hidden></p>
        <label class="field" id="tag-field" style="width:min(320px,100%);margin:0">What are you working on? <small>Optional</small>
          <input id="tag" maxlength="40" placeholder="Chapter 3 notes" value="${esc(timer.s.tag)}" /></label>
        <div class="timer-controls"></div>
        <div id="break-guide" class="break-guide" hidden></div>
        ${ambient.controls()}
      </section>
      <section class="today-side" id="today-side"></section>
    </div>`;
  $('#tag').addEventListener('input', (e) => { timer.s.tag = e.target.value; timer.s.taskId = null; timer.save(); $$('.task.current').forEach((x) => x.classList.remove('current')); });
  main.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.preset) { timer.s.planned = +b.dataset.preset; timer.save(); $('.timer-controls').dataset.key = ''; paintTimer(); }
    const act = b.dataset.act;
    if (act === 'start') timer.start();
    if (act === 'giveup' && confirm('Give up this session? The tree will wilt, but you keep partial points.')) timer.stop(false);
    if (act === 'endbreak') timer.stop(false);
    if (act === 'tobreak') timer.setMode('break');
    if (act === 'tofocus') timer.setMode('focus');
    if (act === 'distracted') { const pk = $('#distract-pick'); pk.hidden = !pk.hidden; b.setAttribute('aria-expanded', String(!pk.hidden)); }
    if (b.dataset.distract) logDistraction(b.dataset.distract);
    if (b.dataset.suggest) { timer.s.planned = +b.dataset.suggest; timer.save(); $('.timer-controls').dataset.key = ''; paintTimer(); loadSuggestion(); }
  });
  paintTimer();
  loadSuggestion();
  await renderTodaySide();
};

async function renderTodaySide() {
  const side = $('#today-side');
  if (!side) return;
  const [rewards, sessions, tasks] = await Promise.all([api('GET', '/rewards'), api('GET', '/sessions?days=2'), api('GET', `/tasks?day=${localDay()}`)]);
  side.onclick = (e) => { if (e.target.closest('#notify-on')) enableNotifications(); taskClick(e); };
  side.onsubmit = taskSubmit;
  side.onchange = taskChange;
  state.me.rewards = rewards;
  paintSideLevel();
  const today = sessions.filter((s) => s.day === localDay());
  const focusMin = today.filter((s) => s.kind === 'focus' && s.completed).reduce((a, s) => a + s.actual_min, 0);
  const breaks = today.filter((s) => s.kind === 'break' && s.completed).length;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  let warning = null;
  if (state.me.consents.ai_insights) { try { warning = (await api('GET', `/insights/trend?day=${localDay()}`)).warning; } catch {} }
  side.innerHTML = `
    ${warning ? `<a class="warn-banner ${warning.level}" href="#/insights"><b>Early warning.</b> ${esc(warning.text)} <span>See why →</span></a>` : ''}
    <h1>${greet}, ${esc(state.me.user.displayName)}.</h1>
    <p class="muted">${hour >= 22 ? "It's late. A short wind-down session is better than a long push." : 'Work in blocks and take the break when the timer offers it.'}</p>
    ${goalHtml(focusMin)}
    <div class="statline">
      <div><b class="num">${fmtMin(focusMin)}</b><span>focused today</span></div>
      <div><b class="num">${breaks}</b><span>breaks taken</span></div>
      <div><b class="num">${rewards.currentStreak}</b><span>day streak</span></div>
    </div>
    <div>
      <div style="display:flex;justify-content:space-between;font-size:var(--step--1)"><b>Level ${rewards.level}</b><span class="muted num">${rewards.points} / ${rewards.nextLevelAt} points</span></div>
      <div class="level-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(rewards.progress * 100)}" aria-label="Progress to next level"><i style="width:${Math.round(rewards.progress * 100)}%"></i></div>
      <small>${rewards.trees} ${rewards.trees === 1 ? 'tree' : 'trees'} grown · best streak ${rewards.bestStreak} days</small>
    </div>
    ${tasksHtml(tasks)}
    <h2 style="margin-top:28px;font-size:var(--step-1)">Today's sessions</h2>
    ${today.length ? `<ul class="session-log">${today.map((s) => `
      <li><span><i class="dot ${s.kind === 'break' ? 'break' : s.completed ? '' : 'abandoned'}"></i>${s.kind === 'break' ? 'Break' : esc(s.tag || 'Focus')}${s.completed ? '' : ' (ended early)'}</span>
      <span class="muted num">${s.started_at.slice(11, 16)} · ${fmtMin(s.actual_min)}</span></li>`).join('')}</ul>`
      : `<p class="empty">No sessions yet today. A 15-minute block is a good way in.</p>`}
    ${notifySupported() && Notification.permission === 'default' ? `<p class="note" style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap"><span>Get a notification when a session ends, even if this tab is in the background.</span><button class="btn" id="notify-on">Turn on</button></p>` : ''}
    ${state.me.consents.activity_tracking ? '' : `<p class="note"><strong>Sessions aren't being saved.</strong> Turn on "Save focus activity" in <a href="#/privacy">Privacy</a> to earn points and grow trees.</p>`}`;
}

// Weekly focus leaderboard (opt-in, completed focus blocks Monday to Sunday).
async function renderLeaderboard() {
  const el = $('#leaderboard');
  if (!el) return;
  const now = new Date();
  const from = shiftDay(localDay(now), -((now.getDay() + 6) % 7));
  let lb;
  try { lb = await api('GET', `/leaderboard?from=${from}`); } catch { return; }
  const myRow = lb.rows.find((r) => r.isMe);
  el.innerHTML = `<div class="lb-head"><div><h2 style="font-size:var(--step-1);margin:0">This week's focus</h2>
      <p class="muted" style="margin:4px 0 0;font-size:var(--step--1)">Completed focus blocks since Monday. Only people who opt in are listed, by display name.</p></div>
      <label class="switch lb-switch"><strong>Show me</strong><input type="checkbox" id="lb-opt" ${lb.optedIn ? 'checked' : ''} /></label></div>
    ${lb.rows.length ? `<ol class="lb">${lb.rows.map((r) => `<li class="${r.isMe ? 'me' : ''}"><span class="rank num">${r.rank}</span><span class="face">${esc(initials(r.name))}</span>
        <span class="lb-name">${esc(r.name)}${r.isMe ? ' (you)' : ''} ${levelChip(r.level)}</span><span class="lb-bar"><i style="width:${Math.max(4, Math.round((r.minutes / lb.rows[0].minutes) * 100))}%"></i></span><b class="num">${fmtMin(r.minutes)}</b></li>`).join('')}</ol>`
      : '<p class="empty">Nobody on the board yet this week. Opt in and finish a focus block to be first.</p>'}
    ${myRow ? '' : `<p class="muted" style="font-size:var(--step--1);margin-bottom:0">Your week: <b>${fmtMin(lb.me.minutes)}</b> in ${lb.me.blocks} ${lb.me.blocks === 1 ? 'block' : 'blocks'}${lb.optedIn ? '' : ' (only you can see this)'}.</p>`}`;
  $('#lb-opt').onchange = async (e) => {
    try { state.me.prefs = await api('PUT', '/prefs', { leaderboard: e.target.checked }); renderLeaderboard(); } catch (err) { fail(err); }
  };
}

// Distraction log: tap what pulled you away without stopping the block.
async function logDistraction(kind) {
  $('#distract-pick').hidden = true;
  try {
    await api('POST', '/distractions', { kind, at: localTs() });
    distractCount++;
    const c = $('#distract-count'); if (c) c.textContent = `${distractCount} logged this block`;
    toast(`Noted. Back to it: ${fmtMin(timer.remaining() / 60000)} left.`);
  } catch (e) { fail(e); }
}

// Smart block length: based on what you finish at this time of day and today's check-in.
async function loadSuggestion() {
  const el = $('#suggest');
  if (!el || timer.s.running || timer.s.mode !== 'focus') return;
  try {
    const r = await api('GET', `/suggest-block?day=${localDay()}&hour=${new Date().getHours()}`);
    el.innerHTML = `<span><b>Suggested: ${r.minutes} min.</b> ${esc(r.reason)}</span>${r.minutes !== timer.s.planned ? `<button class="link" data-suggest="${r.minutes}">Use ${r.minutes} min</button>` : ''}`;
    el.hidden = timer.s.running || timer.s.mode !== 'focus';
  } catch { el.hidden = true; }
}

function paintSideLevel() {
  const r = state.me?.rewards;
  const el = $('#who-level');
  if (el && r) el.innerHTML = `<a href="#/garden">Lv ${r.level} · ${esc(r.levelTitle || '')}</a>`;
}

// Daily focus goal.
const GOALS = [30, 60, 90, 120, 180, 240, 300, 360];
function goalHtml(focusMin) {
  const goal = state.me.prefs?.dailyGoalMin || 120;
  const pct = Math.min(1, focusMin / goal);
  return `<div class="goal ${pct >= 1 ? 'met' : ''}">
    <div class="goal-head"><b>${pct >= 1 ? 'Daily goal reached' : 'Daily focus goal'}</b>
      <label class="goal-pick"><span class="sr" style="position:absolute;left:-999px">Daily goal</span>
        <select id="goal-select">${GOALS.map((g) => `<option value="${g}" ${g === goal ? 'selected' : ''}>${fmtMin(g)}</option>`).join('')}</select></label></div>
    <div class="level-bar goal-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${Math.round(focusMin)}" aria-label="Focus goal progress"><i style="width:${Math.round(pct * 100)}%"></i></div>
    <small>${fmtMin(focusMin)} of ${fmtMin(goal)}${pct >= 1 ? '. Anything more is a bonus; rest counts too.' : `, ${fmtMin(goal - focusMin)} to go`}</small></div>`;
}

// Today's tasks: carried over until done; a focus block can be linked to one.
function tasksHtml(tasks) {
  const open = tasks.filter((t) => !t.done), done = tasks.filter((t) => t.done);
  const pips = (t) => `<span class="pips" aria-label="${t.blocksDone} of ${t.estimate} focus blocks">${Array.from({ length: Math.max(t.estimate, t.blocksDone) }, (_, i) => `<i class="${i < t.blocksDone ? 'on' : ''}"></i>`).join('')}</span>`;
  const row = (t) => `<li class="task ${t.done ? 'done' : ''} ${timer.s.taskId === t.id ? 'current' : ''}" data-task="${t.id}" data-title="${esc(t.title)}">
      <input type="checkbox" ${t.done ? 'checked' : ''} aria-label="Done: ${esc(t.title)}" data-task-done />
      <span class="task-title">${esc(t.title)}${t.day < localDay() && !t.done ? ' <small class="muted">from earlier</small>' : ''}</span>${pips(t)}
      ${t.done ? '' : `<button type="button" class="btn task-go" data-task-focus title="Focus on this">Focus</button>`}
      <button type="button" class="link task-del" data-task-del aria-label="Delete task">✕</button></li>`;
  return `<h2 style="margin-top:28px;font-size:var(--step-1)">Today's tasks</h2>
    <form id="task-form" class="task-form"><input name="title" maxlength="120" placeholder="Add a task, e.g. Revise chapter 3" autocomplete="off" aria-label="New task" />
      <select name="estimate" aria-label="Focus blocks needed">${[1, 2, 3, 4].map((n) => `<option value="${n}">${n} ${n === 1 ? 'block' : 'blocks'}</option>`).join('')}</select>
      <button class="btn primary">Add</button></form>
    ${tasks.length ? `<ul class="tasks">${open.map(row).join('')}${done.map(row).join('')}</ul>` : '<p class="empty" style="margin-top:8px">Plan the day in a few tasks, then press Focus on one to start a block for it.</p>'}`;
}
async function taskSubmit(e) {
  if (e.target.id !== 'task-form') return;
  e.preventDefault();
  const f = e.target, title = f.elements.title.value.trim();
  if (!title) return;
  try { await api('POST', '/tasks', { title, estimate: +f.elements.estimate.value, day: localDay() }); renderTodaySide(); } catch (err) { fail(err); }
}
async function taskChange(e) {
  if (e.target.id === 'goal-select') {
    try { state.me.prefs = await api('PUT', '/prefs', { dailyGoalMin: +e.target.value }); toast('Daily goal updated'); renderTodaySide(); } catch (err) { fail(err); }
    return;
  }
  const li = e.target.closest('[data-task]');
  if (!li || !e.target.matches('[data-task-done]')) return;
  const id = +li.dataset.task;
  try {
    await api('PUT', `/tasks/${id}`, { done: e.target.checked, day: localDay() });
    if (e.target.checked) { if (timer.s.taskId === id && !timer.s.running) { timer.s.taskId = null; timer.save(); } chime(); toast('Task done. Nice.', 'win'); }
    renderTodaySide();
  } catch (err) { fail(err); }
}
async function taskClick(e) {
  const li = e.target.closest('[data-task]');
  if (!li) return;
  const id = +li.dataset.task;
  if (e.target.closest('[data-task-del]')) {
    try { await api('DELETE', `/tasks/${id}`); if (timer.s.taskId === id) { timer.s.taskId = null; timer.save(); } renderTodaySide(); } catch (err) { fail(err); }
  }
  if (e.target.closest('[data-task-focus]')) {
    if (timer.s.running) return toast('Finish or end the current block first.');
    timer.s.taskId = id;
    timer.s.tag = li.dataset.title.slice(0, 40);
    if (timer.s.mode !== 'focus') timer.setMode('focus');
    timer.save();
    const tag = $('#tag'); if (tag) tag.value = timer.s.tag;
    $$('.task.current').forEach((x) => x.classList.remove('current'));
    li.classList.add('current');
    timer.start();
  }
}

// ---------------------------------------------------------------- Rooms
const rooms = { current: null };
VIEWS.rooms = async (main, roomId) => {
  if (roomId) return renderRoom(main, roomId);
  if (rooms.current) { state.socket?.emit('room:leave'); rooms.current = null; rtc.leave(); }
  const list = await api('GET', '/rooms');
  main.innerHTML = `
    <div class="page-head"><div><h1>Focus rooms</h1><p>Work alongside other people. Study on camera with others, chat, or just work quietly together. Camera and mic only start when you choose.</p></div></div>
    <div class="room-list">${list.map((r) => `
      <button class="room-tile" data-room="${esc(r.id)}">
        <h3>${esc(r.name)}</h3><p>${esc(r.description)}</p>
        <div class="faces">${r.members.slice(0, 4).map((m) => `<span class="face" title="${esc(m.name)}">${esc(initials(m.name))}</span>`).join('')}
          <span>${r.members.length ? `${r.members.length} here${r.members.some((m) => m.focusing) ? `, ${r.members.filter((m) => m.focusing).length} focusing` : ''}` : 'Nobody here yet'}</span></div>
      </button>`).join('')}</div>
    <section class="panel leaderboard" id="leaderboard"></section>`;
  main.addEventListener('click', (e) => { const t = e.target.closest('[data-room]'); if (t) location.hash = `#/rooms/${t.dataset.room}`; });
  renderLeaderboard();
  const refresh = () => currentView() === 'rooms' && !location.hash.split('/')[2] && VIEWS.rooms(main);
  state.socket?.on('rooms:counts', refresh);
  state.cleanup.push(() => state.socket?.off('rooms:counts', refresh));
};

async function renderRoom(main, roomId) {
  const list = await api('GET', '/rooms');
  const room = list.find((r) => r.id === roomId);
  if (!room) { main.innerHTML = `<p class="empty">That room doesn't exist. <a href="#/rooms">See all rooms</a></p>`; return; }
  main.innerHTML = `
    <div class="page-head"><div><a href="#/rooms" class="muted">All rooms</a><h1>${esc(room.name)}</h1><p>${esc(room.description)}</p></div></div>
    <section class="panel room-bar">
      <div class="room-clock"><svg aria-hidden="true"><use href="#i-timer"/></svg><div><b class="num" id="room-elapsed">0:00</b><span>in this room</span></div>
        <div><b class="num" id="room-today">–</b><span>in rooms today</span></div></div>
      ${ambient.controls()}
    </section>
    <section class="panel call">
      <div class="stage" id="stage" aria-label="People on camera"></div>
      <div class="stage-empty" id="stage-empty"><svg aria-hidden="true"><use href="#i-cam"/></svg>
        <p><b>Study together on camera.</b> Turn your camera on so others can see you working, or join without it. Mics start off: it's a quiet room.</p></div>
      <div class="call-bar" id="call-bar"></div>
    </section>
    <div class="room">
      <aside class="stack room-side">
        <section class="panel"><h2 style="font-size:var(--step-1)">Group timer</h2><div id="group-timer"></div></section>
        <section class="panel"><h2 style="font-size:var(--step-1)">Here now</h2><ul class="people" id="people"></ul></section>
      </aside>
      <section class="panel chat">
        <div class="chat-log" id="chat-log" aria-live="polite"></div>
        <div class="replying" id="replying" hidden><span></span><button type="button" class="link" id="reply-cancel" aria-label="Cancel reply">Cancel</button></div>
        <form class="chat-form" id="chat-form"><label class="sr" style="position:absolute;left:-999px" for="chat-input">Message</label>
          <input id="chat-input" maxlength="500" autocomplete="off" placeholder="Say what you're starting on" /><button class="btn primary">Send</button></form>
      </section>
    </div>`;
  const log = $('#chat-log');
  const addMsg = (m) => {
    if (!m.isMine && state.me.blockedUserIds?.includes(m.userId)) return; // blocked: never shown
    const mine = m.isMine || m.userId === state.me.user.id;
    const quote = m.reply ? `<button class="quote" data-jump="${m.reply.id}"><b>${esc(m.reply.author)}</b> ${esc(m.reply.body)}</button>` : '';
    log.insertAdjacentHTML('beforeend', `<div class="msg ${mine ? 'mine' : ''}" data-mid="${m.id}" data-author="${esc(mine ? 'yourself' : m.author)}"><div class="who">${mine ? 'You' : esc(m.author)}${mine ? '' : levelChip(m.level)} · ${ago(m.created_at)}
      <button class="link msg-reply" data-reply="${m.id}">Reply</button>${mine ? '' : modMenu('message', m.id)}</div>${quote}<div class="bubble">${esc(m.body)}</div></div>`);
    log.scrollTop = log.scrollHeight;
  };
  let replyTo = null;
  const setReply = (id) => {
    replyTo = id;
    const box = $('#replying');
    box.hidden = !id;
    if (id) {
      const el = log.querySelector(`[data-mid="${id}"]`);
      $('span', box).textContent = `Replying to ${el?.dataset.author || 'message'}: ${(el?.querySelector('.bubble')?.textContent || '').slice(0, 80)}`;
      $('#chat-input').focus();
    }
  };
  log.addEventListener('click', (e) => {
    const r = e.target.closest('[data-reply]');
    if (r) return setReply(+r.dataset.reply);
    const j = e.target.closest('[data-jump]');
    const target = j && log.querySelector(`[data-mid="${j.dataset.jump}"]`);
    if (target) { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 1200); }
  });
  $('#reply-cancel').addEventListener('click', () => setReply(null));
  (await api('GET', `/rooms/${roomId}/messages`)).forEach(addMsg);
  if (!log.children.length) log.innerHTML = `<p class="empty" id="chat-empty">No messages yet. Say what you're working on so others know you're here.</p>`;

  let lastMembers = [];
  const paintPeople = (members) => {
    lastMembers = members;
    $('#people').innerHTML = members.map((m) => {
      const mins = m.focusEndsAt ? Math.max(0, Math.ceil((m.focusEndsAt - Date.now()) / 60000)) : null;
      return `<li><span class="face">${esc(initials(m.name))}</span><span><b>${esc(m.name)}${m.socketId === state.socket?.id ? ' (you)' : ''}</b>${levelChip(m.level)}<br>
        <span class="status ${m.focusing ? 'focusing' : ''}">${m.focusing ? `Focusing${mins != null ? `, ${mins} min left` : ''}` : 'Here'}${m.joinedAt ? ` · ${fmtDur(Date.now() - m.joinedAt)}` : ''}${m.audio ? (m.video ? ' · on camera' : ' · in call') + (m.muted ? '' : ' · mic on') : ''}</span></span></li>`;
    }).join('');
    stage.paint(members);
  };
  const onPresence = (m) => paintPeople(m);
  const onMessage = (m) => { $('#chat-empty')?.remove(); addMsg(m); };
  state.socket.on('room:presence', onPresence);
  state.socket.on('room:message', onMessage);

  const join = await emitAck('room:join', { roomId, day: localDay() });
  if (join.error) return toast(join.error, 'err');
  rooms.current = roomId;
  paintPeople(join.members);

  // Room clock: how long you've been here, and your total in rooms today.
  const myJoin = join.members.find((m) => m.socketId === state.socket.id)?.joinedAt || Date.now();
  let earlierToday = 0;
  api('GET', `/rooms/time?day=${localDay()}`).then((t) => { earlierToday = t.todaySeconds * 1000; }).catch(() => {});
  const paintClock = () => {
    const el = $('#room-elapsed');
    if (!el) return;
    const ms = Date.now() - myJoin;
    const sec = Math.floor(ms / 1000), h = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
    el.textContent = h ? `${h}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
    $('#room-today').textContent = fmtDur(earlierToday + ms);
  };
  paintClock();
  const clockTick = setInterval(paintClock, 1000);

  // Shared group timer: one block everyone in the room can see and focus along with.
  let gt = join.timer || null, gMode = 'focus', gMin = 25;
  const paintGroup = () => {
    const el = $('#group-timer');
    if (!el) return;
    if (gt && gt.endsAt <= Date.now()) gt = null;
    if (gt) {
      const rem = gt.endsAt - Date.now();
      const mine = gt.by === state.me.user.id;
      const along = timer.s.running && Math.abs(timer.s.endsAt - gt.endsAt) < 90000;
      el.innerHTML = `<div class="gt-run ${gt.mode}"><b class="num gt-digits">${pad(Math.floor(rem / 60000))}:${pad(Math.floor((rem % 60000) / 1000))}</b>
        <span>${gt.mode === 'focus' ? 'Group focus' : 'Group break'} · ${gt.minutes} min · started by ${mine ? 'you' : esc(gt.byName)}</span></div>
        <div class="row-btns">${along ? '<span class="muted">You\'re focusing along. Your own timer is synced.</span>' : `<button class="btn grow" data-g="along">${gt.mode === 'focus' ? 'Focus along' : 'Take the break too'}</button>`}
        ${mine ? '<button class="btn" data-g="stop">Stop</button>' : ''}</div>`;
    } else {
      el.innerHTML = `<p class="muted" style="margin-top:0">Start a block for the whole room. Everyone sees the same countdown and can focus along.</p>
        <div class="chips">${[['focus', 25], ['focus', 50], ['break', 5], ['break', 10]].map(([m, n]) => `<button type="button" class="chip" data-gpick="${m}:${n}" aria-pressed="${gMode === m && gMin === n}">${m === 'focus' ? 'Focus' : 'Break'} ${n}</button>`).join('')}</div>
        <button class="btn primary" data-g="start" style="margin-top:10px">Start group ${gMode} (${gMin} min)</button>`;
    }
  };
  const onTimer = (t) => {
    const was = gt;
    gt = t;
    if (t && (!was || was.startedAt !== t.startedAt) && t.by !== state.me.user.id) toast(`${t.byName} started a ${t.minutes}-minute group ${t.mode}.`);
    paintGroup();
  };
  state.socket.on('room:timer', onTimer);
  paintGroup();
  $('#group-timer').addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-gpick]');
    if (pick) { [gMode, gMin] = [pick.dataset.gpick.split(':')[0], +pick.dataset.gpick.split(':')[1]]; return paintGroup(); }
    const a = e.target.closest('[data-g]')?.dataset.g;
    if (a === 'start') { const r = await emitAck('room:timer:start', { mode: gMode, minutes: gMin }); if (r.error) return toast(r.error, 'err'); gt = r.timer; if (!timer.s.running) { timer.setMode(gt.mode, gt.minutes); timer.start(); } paintGroup(); }
    if (a === 'stop') { const r = await emitAck('room:timer:stop'); if (r.error) toast(r.error, 'err'); }
    if (a === 'along' && gt) {
      if (timer.s.running) return toast('Your own timer is already running.');
      const planned = Math.max(1, Math.floor((gt.endsAt - Date.now()) / 60000));
      timer.setMode(gt.mode, planned);
      timer.start();
      toast(`Focusing along for ${planned} min. Your session is saved as usual.`);
      paintGroup();
    }
  });
  const gTick = setInterval(() => { const d = $('#group-timer .gt-digits'); if (gt && d && gt.endsAt > Date.now()) { const rem = gt.endsAt - Date.now(); d.textContent = `${pad(Math.floor(rem / 60000))}:${pad(Math.floor((rem % 60000) / 1000))}`; } else if (gt) paintGroup(); }, 1000);
  timer.broadcast();

  $('#chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = $('#chat-input');
    const body = inp.value.trim();
    if (!body) return;
    const r = await emitAck('room:message', replyTo ? { body, replyTo } : { body });
    if (r.error) toast(r.error, 'err'); else { inp.value = ''; setReply(null); }
  });

  const paintCall_ = () => {
    const bar = $('#call-bar');
    if (!bar) return;
    const big = state.me.voiceMode === 'livekit';
    bar.innerHTML = rtc.active
      ? `<button class="btn ${rtc.camOn ? '' : 'off'}" data-a="cam" aria-pressed="${rtc.camOn}"><svg><use href="#${rtc.camOn ? 'i-cam' : 'i-cam-off'}"/></svg>${rtc.camOn ? 'Camera on' : 'Camera off'}</button>
         <button class="btn ${rtc.micOn ? '' : 'off'}" data-a="mic" aria-pressed="${rtc.micOn}"><svg><use href="#${rtc.micOn ? 'i-mic' : 'i-mic-off'}"/></svg>${rtc.micOn ? 'Mic on' : 'Mic off'}</button>
         <button class="btn danger" data-a="leave">Leave call</button>`
      : `<button class="btn grow" data-a="join-cam"><svg><use href="#i-cam"/></svg>Join with camera</button>
         <button class="btn" data-a="join">Join without camera</button>
         <small>Your camera and mic are used only after you click. ${big ? 'Calls run through a media server, so big rooms work.' : 'Best for up to 6 people on the call.'}</small>`;
  };
  paintCall = paintCall_;
  paintCall_();
  $('#call-bar').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-a]');
    if (!btn) return;
    const a = btn.dataset.a;
    btn.disabled = true;
    if (a === 'join-cam' || a === 'join') await rtc.join(roomId, { camera: a === 'join-cam' });
    if (a === 'leave') rtc.leave();
    if (a === 'mic') await rtc.setMic(!rtc.micOn);
    if (a === 'cam') await rtc.setCam(!rtc.camOn);
    paintCall_();
    stage.refresh();
  });
  const tick = setInterval(() => paintPeople(lastMembers), 30000); // refresh "min left" and time in room

  state.cleanup.push(() => {
    clearInterval(tick);
    state.socket?.off('room:presence', onPresence);
    state.socket?.off('room:message', onMessage);
    paintCall = null;
    clearInterval(gTick);
    clearInterval(clockTick);
    state.socket?.off('room:timer', onTimer);
    if (!location.hash.startsWith(`#/rooms/${roomId}`)) { rtc.leave(); state.socket?.emit('room:leave'); rooms.current = null; }
  });
}

// ---------------------------------------------------------------- Live call (camera + mic)
// Study-room style: cameras on, mics off by default. rtc picks the transport: LiveKit (SFU) when the
// server has it configured, otherwise a peer-to-peer mesh (fine for ~6 people).
const VIDEO = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 20 }, facingMode: 'user' };
const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

const mediaError = (e, what) => toast(e?.name === 'NotAllowedError'
  ? `${what === 'camera' ? 'Camera' : 'Microphone'} access was blocked. Allow it in your browser's site settings and try again.`
  : e?.name === 'NotFoundError' ? `No ${what} found on this device.`
  : e?.name === 'NotReadableError' ? `Your ${what} is being used by another app.`
  : `Could not start the ${what}: ${e?.message || e}`, 'err');

// The video grid: one tile per person on the call, keyed by socket id.
const stage = {
  members: [], local: null, streams: new Map(), // remote: socketId (mesh) or 'user-<id>' (LiveKit) -> MediaStream
  refresh() { this.paint(this.members); },
  paint(members) {
    this.members = members;
    const el = document.getElementById('stage');
    if (!el) return;
    const meId = state.socket?.id;
    const onCall = members.filter((m) => m.audio);
    el.dataset.count = String(Math.min(onCall.length, 9));
    const keep = new Set();
    for (const m of onCall) {
      const key = m.socketId;
      keep.add(key);
      let tile = el.querySelector(`[data-key="${CSS.escape(key)}"]`);
      if (!tile) {
        tile = document.createElement('div');
        tile.className = 'tile';
        tile.dataset.key = key;
        tile.innerHTML = `<video autoplay playsinline muted></video><div class="tile-face"></div><div class="tile-name"></div>`;
        el.append(tile);
      }
      const mine = key === meId;
      const src = mine ? this.local : this.streams.get(key) || this.streams.get(`user-${m.userId}`);
      const v = tile.querySelector('video');
      const showVideo = !!(m.video && src && src.getVideoTracks().length);
      if (showVideo && v.srcObject !== src) { v.srcObject = src; v.play().catch(() => {}); }
      if (!showVideo && v.srcObject) v.srcObject = null;
      tile.classList.toggle('has-video', showVideo);
      tile.classList.toggle('mine', mine);
      tile.querySelector('.tile-face').textContent = initials(m.name);
      const mins = m.focusEndsAt ? Math.max(0, Math.ceil((m.focusEndsAt - Date.now()) / 60000)) : null;
      tile.querySelector('.tile-name').innerHTML = `${m.muted ? '<svg class="mic-off" aria-label="mic off"><use href="#i-mic-off"/></svg>' : '<svg aria-label="mic on"><use href="#i-mic"/></svg>'}
        <span>${esc(mine ? 'You' : m.name)}${m.joinedAt ? ` · ${fmtDur(Date.now() - m.joinedAt)}` : ''}</span>${m.focusing ? `<em>${mins != null ? `${mins}m left` : 'focusing'}</em>` : ''}`;
    }
    el.querySelectorAll('.tile').forEach((t) => { if (!keep.has(t.dataset.key)) { const v = t.querySelector('video'); v.srcObject = null; t.remove(); } });
    const empty = document.getElementById('stage-empty');
    if (empty) empty.hidden = onCall.length > 0;
  },
  clear() { this.local = null; this.streams.clear(); this.refresh(); },
};

const rtc = {
  impl: null,
  get active() { return !!this.impl?.active; },
  get micOn() { return !!this.impl?.micOn; },
  get camOn() { return !!this.impl?.camOn; },
  async join(roomId, { camera }) {
    if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) return toast('This browser does not support live rooms.', 'err');
    let cfg;
    try { cfg = await api('GET', `/rooms/${encodeURIComponent(roomId)}/voice`); } catch (e) { return fail(e); }
    this.impl = cfg.mode === 'livekit' ? lk : mesh;
    await this.impl.join(cfg, { camera });
    if (!this.impl?.active) this.impl = null;
  },
  async setMic(on) { await this.impl?.setMic(on); },
  async setCam(on) { await this.impl?.setCam(on); },
  leave() { mesh.leave(); lk.leave(); this.impl = null; stage.clear(); },
  onSignal(m) { mesh.onSignal(m); },
  dropPeer(id) { mesh.dropPeer(id); },
};

// LiveKit SFU.
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = Object.assign(document.createElement('script'), { src, async: true, onload: resolve, onerror: () => { s.remove(); reject(new Error('Could not load a needed script. Check your connection.')); } });
    document.head.append(s);
  });
}
const lk = {
  room: null, micOn: false, camOn: false,
  get active() { return !!this.room; },
  status() { state.socket?.emit('voice:status', { on: !!this.room, muted: !this.micOn, video: this.camOn }); },
  localVideo() {
    const t = this.room?.localParticipant.getTrackPublication(window.LivekitClient.Track.Source.Camera)?.track;
    stage.local = this.camOn && t ? new MediaStream([t.mediaStreamTrack]) : null;
  },
  async join(cfg, { camera }) {
    try { await loadScript('/vendor/livekit-client.umd.js'); } catch (e) { return toast(e.message, 'err'); }
    const { Room, RoomEvent, Track } = window.LivekitClient;
    const room = new Room({ adaptiveStream: false, dynacast: true, audioCaptureDefaults: AUDIO, videoCaptureDefaults: { resolution: { width: 640, height: 360, frameRate: 15 } } });
    room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach();
        el.dataset.lk = '1';
        el.dataset.identity = participant.identity;
        $('#audio-sinks').append(el);
      } else if (track.kind === Track.Kind.Video) {
        stage.streams.set(participant.identity, new MediaStream([track.mediaStreamTrack]));
        stage.refresh();
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
      if (track.kind === Track.Kind.Video) { stage.streams.delete(participant.identity); stage.refresh(); }
      track.detach().forEach((el) => el.remove());
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      stage.streams.delete(participant.identity);
      $$('#audio-sinks [data-lk]').filter((el) => el.dataset.identity === participant.identity).forEach((el) => { el.srcObject = null; el.remove(); });
      stage.refresh();
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.room !== room) return;
      this.room = null;
      $$('#audio-sinks [data-lk]').forEach((el) => el.remove());
      this.micOn = this.camOn = false;
      this.status();
      stage.clear();
      toast('Call disconnected.');
      paintCall?.();
    });
    try {
      await room.connect(cfg.url, cfg.token);
    } catch (e) {
      return toast(`Could not reach the call server: ${e.message}`, 'err');
    }
    this.room = room;
    this.micOn = false;
    this.camOn = false;
    if (camera) {
      try { await room.localParticipant.setCameraEnabled(true); this.camOn = true; } catch (e) { mediaError(e, 'camera'); }
    }
    this.localVideo();
    room.startAudio().catch(() => {});
    this.status();
    stage.refresh();
  },
  async setMic(on) {
    if (!this.room) return;
    try { await this.room.localParticipant.setMicrophoneEnabled(on); this.micOn = on; } catch (e) { mediaError(e, 'microphone'); }
    this.status();
  },
  async setCam(on) {
    if (!this.room) return;
    try { await this.room.localParticipant.setCameraEnabled(on); this.camOn = on; } catch (e) { mediaError(e, 'camera'); }
    this.localVideo();
    this.status();
    stage.refresh();
  },
  leave() {
    if (!this.room) return;
    const r = this.room;
    this.room = null;
    this.micOn = this.camOn = false;
    r.disconnect().catch(() => {});
    $$('#audio-sinks [data-lk]').forEach((el) => el.remove());
    state.socket?.emit('voice:status', { on: false });
  },
};

// Peer-to-peer mesh (no media server). Every connection has one audio and one video slot, so turning the
// camera or mic on later just swaps the track in (no renegotiation).
const mesh = {
  active: false, pcs: new Map(), ice: null, audio: null, video: null, micOn: false, camOn: false,
  async join(cfg, { camera }) {
    try { this.ice ??= await api('GET', '/rtc-config'); } catch (e) { return fail(e); }
    if (camera) await this.startCamera();
    const r = await emitAck('audio:join', { video: this.camOn, muted: true });
    if (r.error) { this.stopTracks(); return toast(r.error, 'err'); }
    this.active = true;
    this.micOn = false;
    for (const p of r.peers) this.connect(p.socketId, true);
    stage.refresh();
  },
  async startCamera() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: VIDEO, audio: false });
      this.video = s.getVideoTracks()[0];
      this.camOn = true;
      stage.local = new MediaStream([this.video]);
      return true;
    } catch (e) {
      mediaError(e, 'camera');
      return false;
    }
  },
  senders(kind) { return [...this.pcs.values()].flatMap((pc) => pc.getTransceivers().filter((t) => (t.receiver.track?.kind) === kind).map((t) => t.sender)); },
  attach(pc) {
    for (const t of pc.getTransceivers()) {
      const kind = t.receiver.track?.kind;
      if (!kind || t.stopped) continue;
      t.direction = 'sendrecv';
      t.sender.replaceTrack(kind === 'audio' ? this.audio : this.camOn ? this.video : null).catch(() => {});
    }
  },
  connect(peerId, initiator) {
    const pc = new RTCPeerConnection(this.ice);
    this.pcs.set(peerId, pc);
    pc.onicecandidate = (e) => e.candidate && state.socket.emit('rtc:signal', { to: peerId, data: { candidate: e.candidate.toJSON() } });
    pc.ontrack = (e) => {
      if (e.track.kind === 'audio') {
        let el = document.getElementById('audio-' + peerId);
        if (!el) { el = document.createElement('audio'); el.id = 'audio-' + peerId; el.autoplay = true; $('#audio-sinks').append(el); }
        el.srcObject = new MediaStream([e.track]);
        el.play().catch(() => {});
      } else {
        stage.streams.set(peerId, new MediaStream([e.track]));
        e.track.onunmute = () => stage.refresh();
        stage.refresh();
      }
    };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) this.dropPeer(peerId); };
    if (initiator) {
      pc.addTransceiver('audio', { direction: 'sendrecv' });
      pc.addTransceiver('video', { direction: 'sendrecv' });
      this.attach(pc);
      pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() =>
        state.socket.emit('rtc:signal', { to: peerId, data: { sdp: pc.localDescription.toJSON() } })).catch((e) => console.warn('offer failed', e));
    }
    return pc;
  },
  async onSignal({ from, data }) {
    if (!this.active) return;
    let pc = this.pcs.get(from);
    try {
      if (data.sdp) {
        if (data.sdp.type === 'offer' && !pc) pc = this.connect(from, false);
        if (!pc) return;
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          this.attach(pc);
          await pc.setLocalDescription(await pc.createAnswer());
          state.socket.emit('rtc:signal', { to: from, data: { sdp: pc.localDescription.toJSON() } });
        }
      } else if (data.candidate && pc) {
        await pc.addIceCandidate(data.candidate);
      }
    } catch (e) { console.warn('rtc signal error', e); }
  },
  dropPeer(id) {
    this.pcs.get(id)?.close();
    this.pcs.delete(id);
    stage.streams.delete(id);
    document.getElementById('audio-' + id)?.remove();
    stage.refresh();
  },
  async setMic(on) {
    if (on && !this.audio) {
      try {
        this.audio = (await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: false })).getAudioTracks()[0];
      } catch (e) { return mediaError(e, 'microphone'); }
      this.senders('audio').forEach((s) => s.replaceTrack(this.audio).catch(() => {}));
    }
    this.micOn = on;
    if (this.audio) this.audio.enabled = on;
    state.socket?.emit('audio:mute', { muted: !on });
  },
  async setCam(on) {
    if (on) {
      if (!(await this.startCamera())) return;
    } else {
      this.video?.stop(); // turns the camera light off
      this.video = null;
      this.camOn = false;
      stage.local = null;
    }
    this.senders('video').forEach((s) => s.replaceTrack(on ? this.video : null).catch(() => {}));
    state.socket?.emit('audio:mute', { video: this.camOn });
    stage.refresh();
  },
  stopTracks() {
    this.audio?.stop(); this.video?.stop();
    this.audio = this.video = null;
    this.micOn = this.camOn = false;
    stage.local = null;
  },
  leave() {
    if (!this.active && !this.pcs.size && !this.audio && !this.video) return;
    [...this.pcs.keys()].forEach((id) => this.dropPeer(id));
    this.stopTracks();
    if (this.active) state.socket?.emit('audio:leave');
    this.active = false;
  },
};
let paintCall = null; // set by the open room page

// ---------------------------------------------------------------- Community safety
// "⋯" menu on other people's posts, replies and chat messages: report, hide (posts), block.
function modMenu(type, id, canHide) {
  return `<details class="mod-menu"><summary aria-label="More options">⋯</summary><div class="mod-pop">
    <button type="button" data-mod="report" data-type="${type}" data-id="${id}">Report</button>
    ${canHide ? `<button type="button" data-mod="hide" data-type="${type}" data-id="${id}">Hide this post</button>` : ''}
    <button type="button" data-mod="block" data-type="${type}" data-id="${id}">Block this person</button></div></details>`;
}
const REPORT_REASONS = { spam: 'Spam or advertising', harassment: 'Harassment or bullying', hate: 'Hate or discrimination', selfharm: 'Self-harm or suicide risk', sexual: 'Sexual content', other: 'Something else' };
function openReport(type, id) {
  const dlg = $('#report-dialog'), form = $('#report-form');
  form.reset();
  $('.form-error', form).textContent = '';
  $('#selfharm-note').hidden = true;
  $('#report-reasons').innerHTML = Object.entries(REPORT_REASONS).map(([k, v]) => `<label class="radio"><input type="radio" name="reason" value="${k}" /> ${v}</label>`).join('');
  form.onchange = () => { $('#selfharm-note').hidden = form.elements.reason.value !== 'selfharm'; };
  $('#report-send').onclick = async (e) => {
    e.preventDefault();
    const reason = form.elements.reason.value;
    if (!reason) { $('.form-error', form).textContent = 'Pick a reason.'; return; }
    try {
      const r = await api('POST', '/reports', { type, id, reason, note: form.elements.note.value.trim() || undefined });
      dlg.close();
      toast(r.already ? 'You already reported this. Thanks.' : 'Thanks. The admins will review it.');
    } catch (err) { $('.form-error', form).textContent = err.message; }
  };
  dlg.showModal();
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-mod]');
  if (!b) return;
  b.closest('details')?.removeAttribute('open');
  const { mod, type } = b.dataset, id = +b.dataset.id;
  if (mod === 'report') return openReport(type, id);
  try {
    if (mod === 'hide') {
      await api('POST', `/posts/${id}/hide`);
      b.closest('.post')?.remove();
      toast('Post hidden. You can show hidden posts again in Privacy.');
    }
    if (mod === 'block') {
      if (!confirm("Block this person? You won't see their posts, replies or chat messages, and they can't add you as a buddy. They aren't told.")) return;
      const r = await api('POST', '/blocks', { type, id });
      state.me = await api('GET', '/me');
      toast(`Blocked ${r.label}.`);
      route();
    }
  } catch (err) { fail(err); }
});

// Weekly email report settings (Privacy page).
async function renderEmail() {
  const el = $('#email-panel');
  if (!el) return;
  const e = await api('GET', '/email');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  el.innerHTML = `<h2 style="font-size:var(--step-1)">Weekly email report</h2>
    <p class="muted" style="font-size:var(--step--1)">Every Sunday evening: your focus hours, screen-time trend day by day, and one suggestion for the week. Only to an address you've confirmed; unsubscribe from any email.</p>
    ${e.mailEnabled ? '' : '<p class="note" style="margin:8px 0">Email isn\'t set up on this server yet, so reports can\'t be sent. You can still preview yours. (Admin: set SMTP_URL and MAIL_FROM.)</p>'}
    <form id="email-form" class="task-form"><input name="email" type="email" value="${esc(e.email || '')}" placeholder="you@example.com" autocomplete="email" aria-label="Email address" ${e.mailEnabled ? '' : 'disabled'} />
      <button class="btn" ${e.mailEnabled ? '' : 'disabled'}>${e.email ? 'Change' : 'Save'}</button></form>
    ${e.email ? `<p style="font-size:var(--step--1);margin:6px 0 0">${e.verified ? '<span class="chg good">✓</span> Confirmed' : e.pending ? 'Check your inbox for a confirmation link (and spam).' : 'Not confirmed yet.'}</p>` : ''}
    <label class="switch"><strong>Send me the weekly report</strong><p>Sunday around 6 pm your time (${esc(tz)}).</p>
      <input type="checkbox" id="weekly-on" ${e.weekly ? 'checked' : ''} ${e.verified && e.mailEnabled ? '' : 'disabled'} /></label>
    <div class="row-btns" style="margin-top:12px"><button class="btn" id="email-preview">Preview this week's email</button>
      ${e.verified && e.mailEnabled ? '<button class="btn" id="email-test">Send me one now</button>' : ''}</div>`;
  el.onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api('PUT', '/email', { email: ev.target.elements.email.value }); toast('Sent a confirmation link. Check your inbox.'); renderEmail(); } catch (err) { fail(err); }
  };
  el.onchange = async (ev) => {
    if (ev.target.id !== 'weekly-on') return;
    try { state.me.prefs = await api('PUT', '/prefs', { weeklyEmail: ev.target.checked, tz }); toast(ev.target.checked ? 'Weekly report on. See you Sunday.' : 'Weekly report off'); } catch (err) { fail(err); }
  };
  el.onclick = async (ev) => {
    try {
      if (ev.target.id === 'email-test') { const r = await api('POST', '/email/test', { day: localDay() }); toast(`Sent: "${r.subject}"`); }
      if (ev.target.id === 'email-preview') {
        const r = await api('GET', `/email/preview?day=${localDay()}`);
        let d = $('#email-preview-dialog');
        if (!d) { d = document.createElement('dialog'); d.id = 'email-preview-dialog'; d.className = 'sheet email-sheet'; document.body.append(d); }
        d.innerHTML = `<form method="dialog"><h2 style="font-size:var(--step-1)">${esc(r.subject)}</h2><iframe title="Email preview" sandbox></iframe>
          <div class="sheet-actions"><button class="btn primary">Close</button></div></form>`;
        $('iframe', d).srcdoc = r.html;
        d.showModal();
      }
    } catch (err) { fail(err); }
  };
}

async function renderBlocked() {
  const el = $('#blocked-panel');
  if (!el) return;
  const rows = await api('GET', '/blocks');
  el.innerHTML = `<h2 style="font-size:var(--step-1)">Blocked people</h2>
    <p class="muted" style="font-size:var(--step--1)">You don't see their posts, replies or chat messages, and they can't send you buddy requests. They aren't told.</p>
    ${rows.length ? `<div class="divided">${rows.map((r) => `<div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><span><b>${esc(r.label)}</b><br><small>since ${ago(r.created_at)}</small></span><button class="btn" data-unblock="${r.id}">Unblock</button></div>`).join('')}</div>`
      : '<p class="empty" style="margin:0">Nobody blocked.</p>'}
    <button class="link" id="unhide" style="margin-top:10px">Show posts I hid again</button>`;
  el.onclick = async (e) => {
    try {
      const u = e.target.closest('[data-unblock]');
      if (u) { await api('DELETE', `/blocks/${u.dataset.unblock}`); state.me = await api('GET', '/me'); toast('Unblocked'); renderBlocked(); }
      if (e.target.id === 'unhide') { await api('DELETE', '/hidden-posts'); toast('Hidden posts will show again'); }
    } catch (err) { fail(err); }
  };
}

VIEWS.admin = async (main, arg) => {
  if (!state.me.isAdmin) { main.innerHTML = '<p class="empty">Admins only.</p>'; return; }
  const status = ['open', 'removed', 'dismissed'].includes(arg) ? arg : 'open';
  const q = await api('GET', `/admin/reports?status=${status}`);
  const TYPE = { post: 'Community post', reply: 'Reply', message: 'Room chat message' };
  main.innerHTML = `
    <div class="page-head"><div><h1>Moderation</h1><p>Reported content, most urgent first. Anything with ${q.autoHideAt}+ open reports is already hidden from everyone except its author until you decide.</p></div></div>
    <div class="chips" style="margin-bottom:16px">${['open', 'removed', 'dismissed'].map((s) => `<a class="chip" href="#/admin/${s}" aria-pressed="${s === status}">${s[0].toUpperCase() + s.slice(1)}</a>`).join('')}</div>
    ${q.items.length ? `<ul class="mod-queue">${q.items.map((i) => `
      <li class="panel ${i.urgent ? 'urgent' : ''}">
        <header><b>${TYPE[i.type]}</b> by <b>${esc(i.author)}</b>${i.username ? ` <span class="muted">@${esc(i.username)}</span>` : ''}${i.suspended ? ' <span class="pill bad">suspended</span>' : ''}
          ${i.hidden ? '<span class="pill">auto-hidden</span>' : ''}${i.urgent ? '<span class="pill bad">possible self-harm: check first</span>' : ''}<time>${ago(i.lastAt)}</time></header>
        <blockquote>${esc(i.text)}</blockquote>
        <p class="muted" style="margin:0 0 8px">${i.reports} ${i.reports === 1 ? 'report' : 'reports'}: ${i.reasons.map((r) => `${esc(r.label)} (${r.n})`).join(', ')}${i.notes.length ? `<br>Notes: ${i.notes.map((n) => `"${esc(n)}"`).join(' · ')}` : ''}</p>
        ${status === 'open' ? `<div class="row-btns"><button class="btn" data-adm="dismiss" data-t="${i.type}" data-i="${i.id}">Keep it</button>
          <button class="btn danger" data-adm="remove" data-t="${i.type}" data-i="${i.id}">Remove</button>
          ${i.userId && !i.suspended ? `<button class="btn danger" data-adm="suspend" data-t="${i.type}" data-i="${i.id}">Remove and suspend author</button>` : ''}</div>` : ''}
      </li>`).join('')}</ul>` : `<p class="empty">Nothing ${status === 'open' ? 'to review. Quiet is good' : 'here'}.</p>`}
    <section class="panel" style="margin-top:20px"><h2 style="font-size:var(--step-1)">Suspended accounts</h2>
      ${q.suspendedUsers.length ? `<div class="divided">${q.suspendedUsers.map((u) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px"><span><b>${esc(u.display_name)}</b> <span class="muted">@${esc(u.username)}</span></span><button class="btn" data-unsuspend="${u.id}">Lift suspension</button></div>`).join('')}</div>`
        : '<p class="empty" style="margin:0">None.</p>'}
      <p class="muted" style="font-size:var(--step--1)">Suspended people can still use their own timer and data, but can't post, reply, chat or send cheers.</p></section>`;
  main.onclick = async (e) => {
    const b = e.target.closest('[data-adm],[data-unsuspend]');
    if (!b) return;
    try {
      if (b.dataset.unsuspend) await api('POST', `/admin/users/${b.dataset.unsuspend}/suspend`, { suspended: false });
      else {
        if (b.dataset.adm === 'suspend' && !confirm('Remove this and suspend the author?')) return;
        await api('POST', `/admin/reports/${b.dataset.t}/${b.dataset.i}`, { action: b.dataset.adm });
      }
      toast('Done'); route();
    } catch (err) { fail(err); }
  };
};

// ---------------------------------------------------------------- Community
VIEWS.community = async (main) => {
  const MOOD_WORDS = { calm: 'Calm', focused: 'Focused', proud: 'Proud', tired: 'Tired', stressed: 'Stressed', hopeful: 'Hopeful' };
  const RX = { cheer: 'Cheer', hug: 'Hug', same: 'Same here' };
  let mood = null, oldest = null;
  main.innerHTML = `
    <div class="page-head"><div><h1>Community</h1><p>Short check-ins from people working on their screen habits. Be kind; there's no follower count here.</p></div></div>
    <div class="split">
      <section>
        <button class="btn banner" id="new-banner" hidden>New check-ins. Show them</button>
        <ul class="feed" id="feed"></ul>
        <button class="btn" id="more" hidden>Load older check-ins</button>
      </section>
      <aside class="panel composer">
        <h2 style="font-size:var(--step-1)">Check in</h2>
        <form id="post-form">
          <div class="chips" role="group" aria-label="How are you feeling?">${Object.entries(MOOD_WORDS).map(([k, v]) => `<button type="button" class="chip" aria-pressed="false" data-mood="${k}">${v}</button>`).join('')}</div>
          <label class="field" style="margin-top:12px">What's going on? <textarea name="body" maxlength="500" placeholder="Phone stayed in the other room for the whole morning block."></textarea></label>
          <button class="btn primary wide">Post check-in</button>
        </form>
        <p class="muted" style="margin-top:12px;font-size:var(--step--1)">Posting as <b>${state.me.consents.community_profile ? esc(state.me.user.displayName) : 'Anonymous member'}</b>. Change this in <a href="#/privacy">Privacy</a>.</p>
        ${state.me.suspended ? '<p class="warn-banner high" style="margin-top:12px">Your account can\'t post, reply or chat right now. Contact the site admin if you think this is a mistake.</p>' : ''}
        <div class="buddies" id="buddies"></div>
      </aside>
    </div>`;
  const feed = $('#feed');
  const postHtml = (p) => `
    <li class="post" data-id="${p.id}"><header><b>${esc(p.author)}${p.isMine ? ' (you)' : ''}</b>${levelChip(p.level)}<span class="mood ${esc(p.mood)}">${esc(MOOD_WORDS[p.mood] || p.mood)}</span><time>${ago(p.created_at)}</time></header>
      <p>${esc(p.body)}</p>
      <div class="reacts">${Object.entries(RX).map(([k, label]) => `<button class="react" data-react="${k}" aria-pressed="${p.reactions[k].mine}">${label}${p.reactions[k].count ? ` <span class="num">${p.reactions[k].count}</span>` : ''}</button>`).join('')}
      <button class="react" data-reply-toggle>Reply${p.replies.length ? ` <span class="num">${p.replies.length}</span>` : ''}</button>
      ${p.isMine ? `<button class="link" data-delete style="margin-left:auto;font-size:13px">Delete</button>` : modMenu('post', p.id, true)}</div>
      <div class="replies" ${p.replies.length ? '' : 'hidden'}>${p.replies.map(replyHtml).join('')}</div>
      <form class="reply-form" hidden><label class="sr" style="position:absolute;left:-999px">Reply</label>
        <input name="body" maxlength="400" autocomplete="off" placeholder="Write a kind reply" required /><button class="btn primary">Reply</button></form></li>`;
  const replyHtml = (r) => `<div class="reply" data-rid="${r.id}"><b>${esc(r.author)}${r.isMine ? ' (you)' : ''}</b>${levelChip(r.level)} <time>${ago(r.created_at)}</time>
      ${r.isMine ? '<button class="link" data-reply-delete>Delete</button>' : modMenu('reply', r.id)}<p>${esc(r.body)}</p></div>`;
  async function load(reset) {
    const r = await api('GET', `/posts?limit=15${!reset && oldest ? `&before=${oldest}` : ''}`);
    if (reset) feed.innerHTML = '';
    feed.insertAdjacentHTML('beforeend', r.posts.map(postHtml).join(''));
    if (r.posts.length) oldest = r.posts[r.posts.length - 1].id;
    $('#more').hidden = r.posts.length < 15;
    if (!feed.children.length) feed.innerHTML = `<li class="empty">No check-ins yet. Share how today's focus went and you'll be the first.</li>`;
  }
  await load(true);

  $$('[data-mood]').forEach((b) => b.addEventListener('click', () => { mood = b.dataset.mood; $$('[data-mood]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); }));
  $('#post-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!mood) return toast('Pick how you are feeling first.', 'err');
    try {
      const r = await api('POST', '/posts', { mood, body: e.target.elements.body.value });
      e.target.reset(); mood = null; $$('[data-mood]').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      celebrate(r); toast('Check-in posted');
      oldest = null; await load(true);
    } catch (err) { fail(err); }
  });
  $('#more').addEventListener('click', () => load(false));
  feed.addEventListener('click', async (e) => {
    const li = e.target.closest('.post');
    if (!li) return;
    const btn = e.target.closest('[data-react]');
    try {
      if (btn) {
        const r = await api('POST', `/posts/${li.dataset.id}/react`, { kind: btn.dataset.react });
        const n = btn.querySelector('.num');
        const count = (n ? +n.textContent : 0) + (r.active ? 1 : -1);
        btn.setAttribute('aria-pressed', String(r.active));
        btn.innerHTML = `${RX[btn.dataset.react]}${count ? ` <span class="num">${count}</span>` : ''}`;
      }
      if (e.target.closest('[data-delete]') && confirm('Delete this check-in?')) {
        await api('DELETE', `/posts/${li.dataset.id}`); li.remove(); toast('Check-in deleted');
      }
      if (e.target.closest('[data-reply-toggle]')) {
        const f = $('.reply-form', li);
        f.hidden = !f.hidden;
        $('.replies', li).hidden = f.hidden && !$('.replies', li).children.length;
        if (!f.hidden) f.elements.body.focus();
      }
      const rdel = e.target.closest('[data-reply-delete]');
      if (rdel && confirm('Delete this reply?')) {
        const rep = rdel.closest('.reply');
        await api('DELETE', `/posts/${li.dataset.id}/replies/${rep.dataset.rid}`);
        rep.remove();
        paintReplyCount(li);
      }
    } catch (err) { fail(err); }
  });
  const paintReplyCount = (li) => {
    const n = $('.replies', li).children.length;
    $('[data-reply-toggle]', li).innerHTML = `Reply${n ? ` <span class="num">${n}</span>` : ''}`;
  };
  feed.addEventListener('submit', async (e) => {
    const f = e.target.closest('.reply-form');
    if (!f) return;
    e.preventDefault();
    const li = f.closest('.post');
    const body = f.elements.body.value.trim();
    if (!body) return;
    const btn = $('button', f);
    btn.disabled = true;
    try {
      const r = await api('POST', `/posts/${li.dataset.id}/replies`, { body });
      $('.replies', li).innerHTML = r.replies.map(replyHtml).join('');
      $('.replies', li).hidden = false;
      f.reset();
      paintReplyCount(li);
    } catch (err) { fail(err); } finally { btn.disabled = false; }
  });
  renderBuddies();
  const onNew = () => { $('#new-banner').hidden = false; };
  $('#new-banner').addEventListener('click', async () => { $('#new-banner').hidden = true; oldest = null; await load(true); });
  state.socket?.on('community:new', onNew);
  state.cleanup.push(() => state.socket?.off('community:new', onNew));
};

// ---------------------------------------------------------------- Screen time
const CAT_COLORS = { work: 'var(--lichen)', study: 'var(--dusk)', communication: '#4C86A8', social: 'var(--berry)', entertainment: 'var(--amber)', games: '#B15E8F', news: '#7C8A3C', other: 'var(--ink-3)' };
const CAT_LABEL = { work: 'Work', study: 'Study', communication: 'Messaging & email', social: 'Social media', entertainment: 'Video & streaming', games: 'Games', news: 'News', other: 'Other' };

VIEWS['screen-time'] = async (main) => {
  let day = localDay();
  main.innerHTML = `
    <div class="page-head"><div><h1>Screen time</h1><p>Log how long you spent in each app or site. Your phone's Digital Wellbeing or Screen Time page has these numbers.</p></div></div>
    ${sampleBanner(false)}
    <div class="stack">
      <section class="panel">
        <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px"><h2 style="font-size:var(--step-1)">Last 14 days</h2><span class="muted" id="week-avg"></span></div>
        <div class="chart" id="usage-chart"></div><div class="legend" id="legend"></div>
      </section>
      <section class="panel" id="limits-panel">
        <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px"><h2 style="font-size:var(--step-1);margin:0">Daily limits</h2><small>Today, counted across all your sources</small></div>
        <p class="muted" style="font-size:var(--step--1);margin:6px 0 14px">Pick a number that feels kind, not punishing. With the browser extension connected, you get a heads-up at 80% and the site pauses at 100% until tomorrow; you can still open it for 5 minutes. Apps and phone time show here as progress only.</p>
        <div id="limit-list"></div>
        <form id="limit-form" class="limit-form">
          <label class="field">App or site<input name="app" maxlength="60" placeholder="instagram.com" list="app-suggest" required /></label>
          <label class="field">Minutes a day<input name="minutes" type="number" min="5" max="1440" step="5" inputmode="numeric" placeholder="45" required /></label>
          <button class="btn primary">Set limit</button>
        </form>
      </section>
      <div class="split">
        <section class="panel">
          <div style="display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin-bottom:14px">
            <label class="field" style="margin:0">Day <input type="date" id="usage-day" value="${day}" max="${localDay()}" min="${shiftDay(localDay(), -89)}" /></label>
            <h2 style="font-size:var(--step-1);margin:0 0 10px">Enter totals</h2>
          </div>
          <form id="usage-form"><div class="usage-rows" id="usage-rows"></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px"><button type="button" class="btn" id="add-row">Add app or site</button><button class="btn primary">Save totals</button></div>
          </form>
          <div id="day-table" style="margin-top:24px"></div>
        </section>
        <aside class="note" style="font-size:var(--step--1)">
          <p><strong>What Synapse can and can't see.</strong> A website can only measure itself. Synapse records how long this tab is open and in front of you (shown as "Synapse AI, measured"), if you allow screen-time saving.</p>
          <p>It cannot see other apps or websites by itself. To track them automatically, connect the <strong>browser extension</strong> (per-site time), the <strong>desktop tracker</strong> for Windows or Mac (per-app time), or the <strong>Android app</strong> (per-app phone time) in <a href="#/privacy">Privacy</a>. iPhones don't share app usage with ordinary apps, so enter iPhone time here.</p>
          <p>Phone time adds to computer time. A typed-in total only counts if it's larger than everything tracked for that app, so estimates are never counted twice.</p>
          <p style="margin:0">Totals for one day can't exceed 24 hours. Saving an app again for the same day replaces its total.</p>
        </aside>
      </div>
    </div>`;
  if (!state.me.consents.usage_tracking) {
    $('#usage-form').insertAdjacentHTML('beforebegin', `<p class="note" style="margin-bottom:14px"><strong>Saving is off.</strong> Turn on "Save screen-time data" in <a href="#/privacy">Privacy</a> to store these totals.</p>`);
  }
  const rowHtml = (e = {}) => {
    const m = Math.round(e.minutes || 0);
    return `<div class="usage-row">
      <label class="app-field">App or site<input name="app" maxlength="60" value="${esc(e.app || '')}" placeholder="Instagram" list="app-suggest" /></label>
      <label>Category<select name="category">${Object.entries(CAT_LABEL).map(([k, v]) => `<option value="${k}" ${e.category === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Hours<input name="h" type="number" min="0" max="24" inputmode="numeric" value="${m ? Math.floor(m / 60) : ''}" /></label>
      <label>Minutes<input name="m" type="number" min="0" max="59" inputmode="numeric" value="${m ? m % 60 : ''}" /></label>
      <button type="button" class="btn quiet" data-remove aria-label="Remove row">Remove</button></div>`;
  };
  if (!document.getElementById('app-suggest')) document.body.insertAdjacentHTML('beforeend', `<datalist id="app-suggest">${['Instagram', 'YouTube', 'WhatsApp', 'Chrome', 'VS Code', 'Slack', 'Gmail', 'X', 'Reddit', 'Netflix', 'LinkedIn', 'Notion', 'Spotify', 'Telegram'].map((a) => `<option value="${a}">`).join('')}</datalist>`);

  async function load() {
    const r = await api('GET', `/usage?days=14&to=${localDay()}`);
    drawUsageChart(r.daily);
    const dayData = await api('GET', `/usage?days=1&to=${day}`);
    const self = dayData.entries.filter((e) => e.source === 'self');
    $('#usage-rows').innerHTML = (self.length ? self : [{}, {}, {}]).map(rowHtml).join('');
    const total = dayData.daily[0]?.total || 0;
    $('#day-table').innerHTML = dayData.entries.length ? `
      <table class="usage-table"><thead><tr><th>App or site</th><th>Category</th><th class="r">Time</th><th class="r"><span style="position:absolute;left:-999px">Actions</span></th></tr></thead><tbody>
      ${dayData.entries.map((e) => `<tr${e.counted ? '' : ' class="muted"'}><td>${esc(e.app)}<br><small>${esc(e.sourceLabel)}${e.counted ? '' : ' · not counted, overlaps a larger entry'}</small></td><td>${CAT_LABEL[e.category] || esc(e.category)}</td><td class="r num">${fmtMin(e.minutes)}</td>
        <td class="r"><button class="link" data-del="${e.id}" data-source="${esc(e.source)}">Delete</button></td></tr>`).join('')}
      <tr><td colspan="2"><b>Total</b></td><td class="r num"><b>${fmtMin(total)}</b></td><td></td></tr></tbody></table>`
      : `<p class="empty">Nothing logged for this day yet.</p>`;
  }
  async function loadLimits() {
    const { limits } = await api('GET', `/limits?day=${localDay()}`);
    $('#limit-list').innerHTML = limits.length ? `<ul class="limits">${limits.map((l) => {
      const r = Math.min(1, l.ratio);
      const tone = l.ratio >= 1 ? 'over' : l.ratio >= 0.8 ? 'near' : '';
      return `<li class="${tone}"><div class="limit-head"><b>${esc(l.app)}</b><span class="num">${fmtMin(l.used)} of ${fmtMin(l.minutes)}${l.ratio >= 1 ? ' · reached' : l.ratio >= 0.8 ? ' · almost there' : ''}</span>
        <button class="link" data-limit-del="${l.id}" aria-label="Remove limit for ${esc(l.app)}">Remove</button></div>
        <div class="limit-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${l.minutes}" aria-valuenow="${Math.round(l.used)}" aria-label="${esc(l.app)} today"><i style="width:${(r * 100).toFixed(1)}%"></i></div></li>`;
    }).join('')}</ul>` : '<p class="empty" style="padding:4px 0 12px">No limits yet. Start with the one app that eats your evenings.</p>';
  }
  await Promise.all([load(), loadLimits()]);
  $('#limit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      const r = await api('PUT', '/limits', { app: f.app.value, minutes: Number(f.minutes.value) });
      toast(`Daily limit set: ${r.app}, ${fmtMin(r.minutes)}`);
      e.target.reset();
      await loadLimits();
    } catch (err) { fail(err); }
  });
  $('#limit-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-limit-del]');
    if (!b) return;
    try { await api('DELETE', `/limits/${b.dataset.limitDel}`); toast('Limit removed'); await loadLimits(); } catch (err) { fail(err); }
  });
  $('#usage-day').addEventListener('change', (e) => { if (e.target.value) { day = e.target.value; load().catch(fail); } });
  $('#add-row').addEventListener('click', () => $('#usage-rows').insertAdjacentHTML('beforeend', rowHtml()));
  main.addEventListener('click', async (e) => {
    if (e.target.closest('[data-remove]')) e.target.closest('.usage-row').remove();
    const del = e.target.closest('[data-del]');
    if (del && ['extension', 'desktop'].includes(del.dataset.source) &&
      !confirm('This entry came from a tracker, which re-sends today and the last 7 days. It will reappear on the next sync unless you exclude this app or site in the tracker\'s settings. Delete anyway?')) return;
    if (del) { try { await api('DELETE', `/usage/${del.dataset.del}`); toast('Entry deleted'); await load(); } catch (err) { fail(err); } }
  });
  $('#usage-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const entries = $$('.usage-row', e.target).map((r) => ({
      app: $('[name=app]', r).value.trim(), category: $('[name=category]', r).value,
      minutes: (+$('[name=h]', r).value || 0) * 60 + (+$('[name=m]', r).value || 0),
    })).filter((x) => x.app && x.minutes > 0);
    if (!entries.length) return toast('Add at least one app with a time.', 'err');
    try { const r = await api('PUT', '/usage', { day, entries }); celebrate(r); toast(`Saved ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} for ${day === localDay() ? 'today' : day}`); await load(); }
    catch (err) { fail(err); }
  });
};

function drawUsageChart(daily) {
  const el = $('#usage-chart');
  if (!el) return;
  const days = Array.from({ length: 14 }, (_, i) => shiftDay(localDay(), i - 13));
  const map = Object.fromEntries(daily.map((d) => [d.day, d]));
  const maxMin = Math.max(120, ...daily.map((d) => d.total));
  const niceMax = Math.ceil(maxMin / 120) * 120;
  const W = 700, H = 230, L = 34, B = 26, T = 8;
  const bw = (W - L) / 14;
  const cats = Object.keys(CAT_COLORS);
  let bars = '';
  days.forEach((d, i) => {
    let y = H - B;
    const x = L + i * bw + bw * 0.18;
    const dd = map[d];
    if (dd) for (const c of cats) {
      const m = dd.byCategory[c]; if (!m) continue;
      const h = (m / niceMax) * (H - B - T);
      y -= h;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" fill="${CAT_COLORS[c]}" rx="2"><title>${d}: ${CAT_LABEL[c]} ${fmtMin(m)}</title></rect>`;
    }
    const lbl = new Date(d + 'T12:00:00');
    if (i % 2 === 1 || i === 13) bars += `<text x="${(x + bw * 0.32).toFixed(1)}" y="${H - 8}" text-anchor="middle">${i === 13 ? 'Today' : lbl.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</text>`;
  });
  let grid = '';
  for (let m = 0; m <= niceMax; m += niceMax / 4) {
    const y = H - B - (m / niceMax) * (H - B - T);
    grid += `<line x1="${L}" x2="${W}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-dasharray="${m ? '3 4' : ''}"/><text x="${L - 6}" y="${y + 4}" text-anchor="end">${m / 60}h</text>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Stacked daily screen time by category for the last 14 days">${grid}${bars}</svg>`;
  const used = cats.filter((c) => daily.some((d) => d.byCategory[c]));
  $('#legend').innerHTML = used.map((c) => `<span><i style="background:${CAT_COLORS[c]}"></i>${CAT_LABEL[c]}</span>`).join('') || '<span>Log a day to see your chart.</span>';
  const last7 = daily.filter((d) => d.day > shiftDay(localDay(), -7));
  $('#week-avg').textContent = last7.length ? `7-day average ${fmtMin(last7.reduce((s, d) => s + d.total, 0) / last7.length)} on logged days` : '';
}

// ---------------------------------------------------------------- Progress
const tipEl = () => document.getElementById('chart-tip') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'chart-tip', className: 'chart-tip', role: 'status' }));
function wireTips(root) {
  const tip = tipEl();
  const show = (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t || !root.contains(t)) { tip.hidden = true; return; }
    tip.textContent = t.dataset.tip;
    tip.hidden = false;
    const r = t.getBoundingClientRect();
    const x = Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2));
    const y = r.top - tip.offsetHeight - 8 < 8 ? r.bottom + 8 : r.top - tip.offsetHeight - 8;
    tip.style.transform = `translate(${x}px, ${y}px)`;
  };
  root.addEventListener('pointerover', show);
  root.addEventListener('focusin', show);
  root.addEventListener('pointerleave', () => (tip.hidden = true));
  root.addEventListener('focusout', () => (tip.hidden = true));
  tip.hidden = true;
}
const hourLabel = (h) => (h === 0 ? '12 am' : h < 12 ? `${h} am` : h === 12 ? '12 pm' : `${h - 12} pm`);
const shortDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function heatmapSvg(daily, today, weeks = 26) {
  const end = new Date(today + 'T12:00:00');
  const dow = (end.getDay() + 6) % 7; // Monday = 0
  const start = new Date(end); start.setDate(end.getDate() - dow - (weeks - 1) * 7);
  const cell = 15, gap = 4, L = 32, T = 20;
  const level = (m) => (!m ? 0 : m < 25 ? 1 : m < 60 ? 2 : m < 120 ? 3 : 4);
  let rects = '', months = '', lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const day = new Date(start); day.setDate(start.getDate() + w * 7 + d);
      if (day > end) continue;
      const key = localDay(day);
      const m = Math.round(daily[key] || 0);
      const x = L + w * (cell + gap), y = T + d * (cell + gap);
      rects += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" class="hm l${level(m)}" tabindex="-1" data-tip="${shortDate(key)}: ${m ? fmtMin(m) + ' focused' : 'no focus logged'}"></rect>`;
      if (d === 0 && day.getMonth() !== lastMonth) {
        lastMonth = day.getMonth();
        if (w < weeks - 1) months += `<text x="${x}" y="11">${day.toLocaleDateString(undefined, { month: 'short' })}</text>`;
      }
    }
  }
  const days = ['Mon', '', 'Wed', '', 'Fri', '', ''].map((t, i) => (t ? `<text x="0" y="${T + i * (cell + gap) + 11}">${t}</text>` : '')).join('');
  const W = L + weeks * (cell + gap), H = T + 7 * (cell + gap);
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" role="img" aria-label="Focus minutes per day for the last ${weeks} weeks">${months}${days}${rects}</svg>`;
}

function weeklySvg(weeks) {
  const W = 640, H = 220, L = 34, B = 26, T = 22, R = 8;
  const max = Math.max(60, ...weeks.flatMap((w) => [w.focus, w.screen]));
  const step = max <= 600 ? 120 : max <= 1800 ? 300 : max <= 3600 ? 600 : 1200;
  const top = Math.ceil(max / step) * step;
  const y = (m) => H - B - (m / top) * (H - B - T);
  const gw = (W - L - R) / weeks.length, bw = Math.min(22, gw * 0.3);
  let grid = '', bars = '';
  for (let m = 0; m <= top; m += step) grid += `<line x1="${L}" x2="${W - R}" y1="${y(m)}" y2="${y(m)}" class="grid${m ? '' : ' base'}"/><text x="${L - 6}" y="${y(m) + 4}" text-anchor="end">${m / 60}h</text>`;
  const bar = (x, v, cls, tip) => {
    const h = Math.max(v ? 2 : 0, H - B - y(v));
    if (!h) return `<rect x="${x}" y="${H - B - 1}" width="${bw}" height="1" class="${cls} empty" data-tip="${tip}"></rect>`;
    const r = Math.min(4, h / 2, bw / 2), yy = H - B - h;
    return `<path class="${cls}" d="M${x},${H - B} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${H - B} Z" data-tip="${tip}"></path>
      <rect x="${x - 3}" y="${T}" width="${bw + 6}" height="${H - B - T}" fill="transparent" data-tip="${tip}"></rect>`;
  };
  weeks.forEach((w, i) => {
    const cx = L + gw * i + gw / 2;
    const label = `${shortDate(w.start)}–${shortDate(w.end)}`;
    bars += bar(cx - bw - 1, w.focus, 'bar-focus', `${label}: ${fmtMin(w.focus)} focused`);
    bars += bar(cx + 1, w.screen, 'bar-screen', `${label}: ${w.screenDays ? fmtMin(w.screen) + ' screen time (' + w.screenDays + ' logged ' + (w.screenDays === 1 ? 'day' : 'days') + ')' : 'no screen time logged'}`);
    if (i % 2 === 1 || i === weeks.length - 1) bars += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${i === weeks.length - 1 ? 'This week' : shortDate(w.start)}</text>`;
  });
  const direct = ''; // this week's values are stated in the chart subtitle instead, so no label collides with a bar
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly focus time and screen time for the last 8 weeks">${grid}${bars}${direct}</svg>`;
}

function hoursSvg(hours) {
  const W = 640, H = 170, L = 8, B = 24, T = 10;
  const max = Math.max(1, ...hours.map((h) => h.minutes));
  const top3 = [...hours].filter((h) => h.minutes).sort((a, b) => b.minutes - a.minutes).slice(0, 3).map((h) => h.hour);
  const bw = (W - L * 2) / 24;
  let out = `<line x1="${L}" x2="${W - L}" y1="${H - B}" y2="${H - B}" class="grid base"/>`;
  hours.forEach((h) => {
    const x = L + h.hour * bw + 2, w = bw - 4;
    const hh = h.minutes ? Math.max(3, (h.minutes / max) * (H - B - T)) : 0;
    const tip = `${hourLabel(h.hour)}–${hourLabel((h.hour + 1) % 24)}: ${h.minutes ? fmtMin(h.minutes) + ' across ' + h.sessions + ' ' + (h.sessions === 1 ? 'block' : 'blocks') : 'no completed blocks'}`;
    if (hh) {
      const r = Math.min(4, hh / 2), yy = H - B - hh;
      out += `<path class="${top3.includes(h.hour) ? 'bar-focus' : 'bar-focus soft'}" d="M${x},${H - B} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + w - r} Q${x + w},${yy} ${x + w},${yy + r} V${H - B} Z"></path>`;
    }
    out += `<rect x="${x - 2}" y="${T}" width="${w + 4}" height="${H - B - T}" fill="transparent" data-tip="${tip}"></rect>`;
    if (h.hour % 3 === 0) out += `<text x="${x + w / 2}" y="${H - 7}" text-anchor="middle">${hourLabel(h.hour).replace(' ', '')}</text>`;
  });
  return { svg: `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Completed focus minutes by hour of day">${out}</svg>`, top3 };
}

VIEWS.progress = async (main) => {
  const d = await api('GET', `/stats?days=182&today=${localDay()}`);
  const t = d.totals;
  const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
  if (!t.sessions && !d.weeks.some((w) => w.screen)) {
    main.innerHTML = `<div class="page-head"><div><h1>Progress</h1><p>Your focus patterns over the last six months.</p></div></div>
      ${sampleBanner(true)}
      <section class="panel"><h2>Nothing to chart yet</h2><p>Finish a focus block on <a href="#/today">Today</a> and this page fills in: a calendar of your focus days, weekly trends, and the hours you focus best.</p></section>`;
    return;
  }
  const { svg: hoursChart, top3 } = hoursSvg(d.hours);
  const bestHours = top3.length ? top3.slice().sort((a, b) => a - b).map((h) => `${hourLabel(h)}–${hourLabel((h + 1) % 24)}`) : [];
  const finishedBest = d.lengths.filter((l) => l.started >= 2).sort((a, b) => b.completed / b.started - a.completed / a.started)[0];
  const thisWeek = d.weeks[7], lastWeek = d.weeks[6];
  const trend = lastWeek.focus ? Math.round(((thisWeek.focus - lastWeek.focus) / lastWeek.focus) * 100) : null;
  const maxTag = Math.max(1, ...d.tags.map((x) => x.minutes));
  main.innerHTML = `
    <div class="page-head"><div><h1>Progress</h1><p>Your focus patterns over the last six months. Hover or tap any square or bar for details.</p></div></div>
    ${sampleBanner(false)}
    <section class="panel review" id="review"></section>
    <div class="progress stack">
      <div class="statline progress-stats">
        <div><b class="num">${fmtMin(t.focusMinutes)}</b><span>focused in 6 months</span></div>
        <div><b class="num">${t.sessions}</b><span>blocks finished</span></div>
        <div><b class="num">${pct(t.completionRate)}</b><span>of blocks finished</span></div>
        <div><b class="num">${t.bestStreak}</b><span>day best streak</span></div>
      </div>
      <section class="panel">
        <div class="chart-head"><h2>Focus calendar</h2><span class="muted">${t.activeDays} focus ${t.activeDays === 1 ? 'day' : 'days'} · ${fmtMin(t.avgPerActiveDay)} on an average focus day</span></div>
        <div class="heatmap">${heatmapSvg(d.daily, d.today)}</div>
        <div class="hm-legend" aria-hidden="true">Less <i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i> More <span class="muted">(under 25 min · 1 h · 2 h · 2 h+)</span></div>
      </section>
      <div class="grid-2">
        <section class="panel">
          <div class="chart-head"><h2>Focus vs screen time, by week</h2><span class="muted">This week: ${fmtMin(thisWeek.focus)} focus${thisWeek.screenDays ? `, ${fmtMin(thisWeek.screen)} screen time` : ''}${trend == null ? '' : trend >= 0 ? ` · focus up ${trend}%` : ` · focus down ${-trend}%`}</span></div>
          <div class="legend"><span><i style="background:var(--c-focus)"></i>Focus time</span><span><i style="background:var(--c-screen)"></i>Screen time (logged days)</span></div>
          <div class="chart pchart">${weeklySvg(d.weeks)}</div>
          <details><summary>Show as table</summary><table class="usage-table"><thead><tr><th>Week</th><th class="r">Focus</th><th class="r">Screen time</th></tr></thead><tbody>
            ${d.weeks.slice().reverse().map((w) => `<tr><td>${shortDate(w.start)}–${shortDate(w.end)}</td><td class="r num">${fmtMin(w.focus)}</td><td class="r num">${w.screenDays ? fmtMin(w.screen) : '–'}</td></tr>`).join('')}</tbody></table></details>
        </section>
        <section class="panel">
          <div class="chart-head"><h2>When you focus</h2></div>
          <p class="muted chart-note">${bestHours.length ? `Your strongest hours: <b>${bestHours.join(', ')}</b>. Try protecting them for your hardest work.` : 'Finish a few blocks to see your strongest hours.'}</p>
          <div class="chart pchart">${hoursChart}</div>
        </section>
      </div>
      <div class="grid-2">
        <section class="panel">
          <div class="chart-head"><h2>Block lengths you finish</h2></div>
          ${d.lengths.length ? `<ul class="limits">${d.lengths.map((l) => `<li><div class="limit-head"><b>${l.planned} min</b><span class="num">finished ${l.completed} of ${l.started} (${pct(l.completed / l.started)})</span></div>
            <div class="limit-bar"><i style="width:${(l.completed / l.started) * 100}%"></i></div></li>`).join('')}</ul>
            ${finishedBest ? `<p class="muted chart-note">You finish ${finishedBest.planned}-minute blocks most reliably. If longer ones keep ending early, lean on those.</p>` : ''}` : '<p class="empty">No focus blocks yet.</p>'}
        </section>
        <section class="panel">
          <div class="chart-head"><h2>What you focus on</h2></div>
          ${d.tags.length ? `<ul class="limits">${d.tags.map((x) => `<li><div class="limit-head"><b>${esc(x.tag)}</b><span class="num">${fmtMin(x.minutes)}</span></div><div class="limit-bar"><i style="width:${(x.minutes / maxTag) * 100}%"></i></div></li>`).join('')}</ul>`
            : '<p class="empty">Add a label in "What are you working on?" when you start a block, and your top topics appear here.</p>'}
        </section>
      </div>
    </div>`;
  wireTips($('.progress', main));
  renderReview();
};

// ---------------------------------------------------------------- Insights
async function addSampleData(btn) {
  if (btn) btn.disabled = true;
  try {
    state.me.consents = await api('PUT', '/consents', { activity_tracking: true, usage_tracking: true, ai_insights: true });
    await api('POST', '/sample-data', { today: localDay() });
    state.me = await api('GET', '/me');
    toast('Added 3 weeks of sample data. Remove it any time.');
    route();
  } catch (e) { fail(e); if (btn) btn.disabled = false; }
}
async function removeSampleData() {
  try { await api('DELETE', '/sample-data'); state.me = await api('GET', '/me'); toast('Sample data removed'); route(); } catch (e) { fail(e); }
}
/** Banner shown on data pages while sample data is loaded, or an offer when the account is empty. */
function sampleBanner(empty) {
  if (state.me.hasSampleData) return `<div class="sample-banner"><span><b>Sample data.</b> You're seeing 3 weeks of made-up activity mixed with your own, so you can explore. It's not you.</span><button class="btn" data-sample="remove">Remove sample data</button></div>`;
  if (empty) return `<div class="sample-banner offer"><span><b>Nothing to analyse yet.</b> Use the timer and log screen time for a few days, or explore with 3 weeks of sample data first.</span><button class="btn grow" data-sample="add">Try with sample data</button></div>`;
  return '';
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sample]');
  if (!b) return;
  if (b.dataset.sample === 'add') addSampleData(b);
  else if (confirm('Remove all sample data? Your own data stays.')) removeSampleData();
});

const insightsTabs = (cur) => `<div class="chips tabs-inline" role="tablist" style="margin:-6px 0 18px">
  <a class="chip" role="tab" href="#/insights" aria-pressed="${cur === 'overview'}">Overview</a>
  <a class="chip" role="tab" href="#/insights/trends" aria-pressed="${cur === 'trends'}">Trends</a></div>`;

VIEWS.insights = async (main, arg) => {
  if (arg === 'trends') return renderTrendsView(main);
  if (!state.me.consents.ai_insights) {
    main.innerHTML = `<div class="page-head"><div><h1>Insights</h1><p>Machine learning and fuzzy logic that explain how balanced your week looks.</p></div></div>
      ${insightsTabs('overview')}
      <div class="split"><section class="panel"><h2>Insights are off</h2><p>When you turn them on, Synapse analyses your saved focus sessions, screen-time totals and private mood check-ins to estimate how balanced your week looks, and shows exactly which patterns drove that estimate.</p>
      <ol class="how-ml">
        <li><b>10 patterns</b> are measured from your last 7 days: screen time, share on social and video, late-night sessions, breaks, deep-focus time, abandoned sessions, week-over-week change, stress, energy and sleep.</li>
        <li><b>A machine-learning model</b> (logistic regression) turns them into a load estimate and shows how much each pattern pushed it up or down.</li>
        <li><b>Fuzzy logic</b> rates screen load, recovery and strain as low, medium or high and combines them with readable rules.</li>
        <li><b>Suggestions</b> come with a "because" so you can see why each one was made.</li></ol>
      <div class="row-btns"><button class="btn primary" id="enable-ai">Turn on insights</button>
      ${state.me.hasSampleData ? '' : '<button class="btn grow" data-sample="add">Turn on and try with sample data</button>'}</div>
      <p class="muted" style="font-size:var(--step--1);margin-top:12px">Sample data turns on saving focus, screen time and insights, then adds 3 weeks of clearly marked made-up activity you can remove in one click.</p></section></div>`;
    $('#enable-ai').addEventListener('click', async () => { try { state.me.consents = await api('PUT', '/consents', { ai_insights: true }); route(); } catch (e) { fail(e); } });
    return;
  }
  const [ins, checkins] = await Promise.all([api('GET', `/insights?day=${localDay()}`), api('GET', '/checkins')]);
  const todayCheck = checkins.find((c) => c.day === localDay());
  const stateClass = 'state-' + ins.state.replace(' ', '-');
  const C = 2 * Math.PI * 42;
  const maxC = Math.max(0.5, ...ins.ml.factors.map((f) => Math.abs(f.contribution)));
  const stateWords = { balanced: 'Your week looks balanced', strained: 'Some strain is showing', 'at risk': 'Your patterns point to overload' };

  main.innerHTML = `
    <div class="page-head"><div><h1>Insights</h1><p>Based on the last 7 days. ${esc(ins.disclaimer)}</p></div></div>
    ${insightsTabs('overview')}
    ${sampleBanner(ins.daysWithData < 2)}
    <div class="split">
      <div class="stack">
        <section class="panel verdict">
          <div class="gauge ${stateClass}"><svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="42" fill="none" stroke="var(--surface-2)" stroke-width="9"/>
            <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - ins.score / 100)}"/></svg>
            <b class="num" aria-label="Load score ${ins.score} out of 100">${ins.score}</b></div>
          <div><h2 class="${stateClass}" style="margin-bottom:6px">${stateWords[ins.state]}</h2>
            <p style="margin:0">Load score ${ins.score}/100, where lower is calmer. Confidence is <b>${ins.confidence}</b>: ${ins.daysWithData} ${ins.daysWithData === 1 ? 'day' : 'days'} with data, ${ins.counts.focusSessions} focus sessions, ${ins.counts.checkins} check-ins.</p>
            ${ins.confidence !== 'good' ? `<p class="muted" style="margin:8px 0 0;font-size:var(--step--1)">Log screen time and use the timer on a few more days for a steadier reading.</p>` : ''}</div>
        </section>
        <section class="panel" id="trend-panel"><h2 style="font-size:var(--step-1)">Early warning</h2><p class="muted">Loading the last 14 days…</p></section>
        <section class="panel"><h2 style="font-size:var(--step-1)">Suggestions for this week</h2>
          <ul class="recs">${ins.recommendations.map((r) => `<li class="rec" data-p="${r.priority}"><h3>${esc(r.title)}</h3><p>${esc(r.action)}</p><div class="because">Because: ${esc(r.because)}.</div></li>`).join('')}</ul></section>
        <section class="panel" id="patterns-panel"></section>
        <section class="panel"><h2 style="font-size:var(--step-1)">What influenced the score</h2>
          <p class="muted" style="font-size:var(--step--1)">Each bar shows how far one pattern pushed the machine-learning estimate up (towards overload) or down, compared with a typical week.</p>
          ${ins.ml.factors.length ? ins.ml.factors.map((f) => {
            const w = (Math.abs(f.contribution) / maxC) * 50;
            return `<div class="factor"><b>${esc(f.label)}</b><span class="val">Yours ${esc(f.display)}, typical ${esc(f.typical)} · ${f.direction} the score</span>
              <span class="fbar" aria-hidden="true"><i class="${f.contribution > 0 ? 'up' : 'down'}" style="width:${w.toFixed(1)}%"></i></span></div>`;
          }).join('') : '<p class="empty">Not enough data yet. Use the timer and log screen time to see what drives your score.</p>'}
          <details style="margin-top:14px"><summary>Fuzzy rules that fired</summary>
            <p class="muted" style="font-size:var(--step--1)">A second, rule-based model rates screen load, recovery (breaks and sleep) and strain (stress, late sessions, abandoned sessions) as low, medium or high, then combines them. Its load estimate was ${Math.round(ins.fuzzy.load)}/100 ("${esc(ins.fuzzy.state)}"); the final score averages it with the ML estimate (${Math.round(ins.ml.risk * 100)}/100).</p>
            <ul class="rules">${ins.fuzzy.firedRules.map((r) => `<li><span>${esc(r.rule)}</span><span>${Math.round(r.strength * 100)}%</span></li>`).join('')}</ul></details>
          <details><summary>All measured patterns</summary>
            <table class="usage-table"><tbody>${ins.features.map((f) => `<tr><td>${esc(f.label)}</td><td class="r num">${f.value == null ? '<span class="muted">no data</span>' : esc(f.display)}</td></tr>`).join('')}</tbody></table>
            <p class="muted" style="font-size:12px;margin-top:10px">Model: ${esc(ins.ml.model.type)} trained on ${esc(ins.ml.model.trainedOn)} (fit accuracy ${Math.round(ins.ml.model.trainAccuracy * 100)}%). It's a consistent coaching heuristic, not a validated clinical instrument.</p></details>
        </section>
      </div>
      <div class="stack">
        <section class="panel"><h2 style="font-size:var(--step-1)">How are you today?</h2>
          <p class="muted" style="font-size:var(--step--1)">Private. Only you and the insights model see this.</p>
          <form id="mood-form">
            <div class="field">Energy <div class="scale" data-scale="energy">${[1, 2, 3, 4, 5].map((n) => `<button type="button" aria-pressed="${todayCheck?.energy === n}" data-v="${n}" aria-label="Energy ${n} of 5">${n}</button>`).join('')}</div><small>1 drained, 5 full of energy</small></div>
            <div class="field">Stress <div class="scale" data-scale="stress">${[1, 2, 3, 4, 5].map((n) => `<button type="button" aria-pressed="${todayCheck?.stress === n}" data-v="${n}" aria-label="Stress ${n} of 5">${n}</button>`).join('')}</div><small>1 relaxed, 5 overwhelmed</small></div>
            <label class="field">Hours slept last night <input name="sleep" type="number" step="0.5" min="0" max="16" value="${todayCheck?.sleep_h ?? ''}" inputmode="decimal" /></label>
            <button class="btn primary wide">${todayCheck ? 'Update check-in' : 'Save check-in'}</button>
          </form></section>
        <section class="panel" id="distract-panel"></section>
        <section class="panel"><h2 style="font-size:var(--step-1)">Ask the coach</h2>
          <p class="muted" style="font-size:var(--step--1)">${state.me.llmEnabled ? 'Replies come from an AI model that sees your summary above, not your raw data.' : 'No AI provider is configured on this server, so replies are rule-based from your insights.'}</p>
          <div class="coach-log" id="coach-log" aria-live="polite"></div>
          <form class="chat-form" id="coach-form"><input id="coach-input" maxlength="1000" placeholder="I keep scrolling at night. What should I try?" autocomplete="off" aria-label="Message the coach" /><button class="btn primary">Ask</button></form>
        </section>
      </div>
    </div>`;

  renderTrend(); renderPatterns(); renderDistractions();
  const picked = { energy: todayCheck?.energy, stress: todayCheck?.stress };
  $$('[data-scale]').forEach((sc) => sc.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    picked[sc.dataset.scale] = +b.dataset.v;
    $$('button', sc).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
  $('#mood-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!picked.energy || !picked.stress) return toast('Choose both energy and stress.', 'err');
    try { await api('PUT', '/checkins', { day: localDay(), energy: picked.energy, stress: picked.stress, sleepHours: e.target.elements.sleep.value }); toast('Check-in saved. Insights updated.'); route(); }
    catch (err) { fail(err); }
  });

  const history = [];
  const clog = $('#coach-log');
  const addC = (role, text, src) => {
    const safe = esc(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    clog.insertAdjacentHTML('beforeend', `<div class="msg ${role === 'user' ? 'mine' : ''}"><div class="who">${role === 'user' ? 'You' : src === 'llm' ? 'Coach (AI)' : src === 'safety' ? 'Coach' : 'Coach (rule-based)'}</div><div class="bubble">${safe}</div></div>`);
    clog.scrollTop = clog.scrollHeight;
  };
  $('#coach-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = $('#coach-input'); const message = inp.value.trim();
    if (!message) return;
    inp.value = ''; addC('user', message);
    const btn = $('button', e.target); btn.disabled = true;
    try {
      const r = await api('POST', '/coach', { message, day: localDay(), history });
      history.push({ role: 'user', content: message }, { role: 'assistant', content: r.text });
      addC('assistant', r.text, r.source);
    } catch (err) { fail(err); } finally { btn.disabled = false; }
  });
};

// ---------------------------------------------------------------- Insights > Trends
function barsSvg(values, labels, { cls = 'focus', fmt = fmtMin, h = 140, tips } = {}) {
  const W = 560, L = 4, R = 4, T = 18, B = 22, n = values.length;
  const max = Math.max(1, ...values.map((v) => v || 0));
  const slot = (W - L - R) / n, bw = Math.min(26, slot * 0.64);
  const last = values.length - 1;
  return `<svg class="bars ${cls}" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(labels.map((l, i) => `${l}: ${values[i] == null ? 'no data' : fmt(values[i])}`).join(', '))}">
    <line x1="${L}" x2="${W - R}" y1="${h - B}" y2="${h - B}" class="base"/>
    ${values.map((v, i) => {
      const x = L + slot * i + (slot - bw) / 2, bh = v ? Math.max(2, (v / max) * (h - T - B)) : 0;
      return `<g><title>${esc(tips ? tips[i] : `${labels[i]}: ${v == null ? 'no data' : fmt(v)}`)}</title>
        ${v == null ? `<text x="${x + bw / 2}" y="${h - B - 4}" text-anchor="middle" class="nd">·</text>` : `<rect x="${x.toFixed(1)}" y="${(h - B - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" class="${i === last ? 'today' : ''}"/>`}
        ${i % 2 === last % 2 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle">${esc(labels[i])}</text>` : ''}</g>`;
    }).join('')}
    ${values[last] ? `<text x="${(L + slot * last + slot / 2).toFixed(1)}" y="${Math.max(12, h - B - Math.max(2, (values[last] / max) * (h - T - B)) - 5).toFixed(1)}" text-anchor="middle" class="val">${esc(fmt(values[last]))}</text>` : ''}
  </svg>`;
}

function moodSvg(series) {
  const W = 560, H = 170, L = 26, R = 8, T = 10, B = 22, n = series.length;
  const x = (i) => L + (i / (n - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - 1) / 4) * (H - T - B);
  const line = (k) => {
    let d = '', pen = false;
    series.forEach((p, i) => { if (p[k] == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`; pen = true; });
    return d;
  };
  const dots = (k) => series.map((p, i) => (p[k] == null ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(p[k]).toFixed(1)}" r="3.5" class="${k}"><title>${shortDate(p.day)}: ${k} ${p[k]}/5</title></circle>`)).join('');
  return `<svg class="moodchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Energy and stress over 14 days">
    ${[1, 3, 5].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
    <path d="${line('energy')}" class="energy"/><path d="${line('stress')}" class="stress"/>${dots('energy')}${dots('stress')}
    <text x="${L}" y="${H - 5}">${shortDate(series[0].day)}</text><text x="${W - R}" y="${H - 5}" text-anchor="end">Today</text></svg>`;
}

async function renderTrendsView(main) {
  const t = await api('GET', `/insights/trends?day=${localDay()}`);
  const S = t.series, labels = S.map((d) => new Date(d.day + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'narrow' }));
  const avg = (k) => { const v = S.map((d) => d[k]).filter((x) => x != null && (k !== 'focusMin' || x > 0)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const focusAvg = S.reduce((a, d) => a + d.focusMin, 0) / 14, screenAvg = avg('screenMin'), sleepAvg = avg('sleep');
  const roomTotal = t.roomMin.reduce((a, b) => a + b, 0);
  const maxHeat = Math.max(1, ...t.heat.flat());
  const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const empty = !S.some((d) => d.focusMin || d.screenMin != null || d.energy != null);
  main.innerHTML = `
    <div class="page-head"><div><h1>Insights</h1><p>How your focus, screen time, mood and sleep moved over the last two weeks.</p></div></div>
    ${insightsTabs('trends')}
    ${sampleBanner(empty)}
    <div class="review-grid trend-tiles">
      <div><b class="num">${fmtMin(focusAvg)}</b><span>focus a day (14-day average)</span></div>
      <div><b class="num">${screenAvg != null ? fmtMin(screenAvg) : '–'}</b><span>screen time a day</span></div>
      <div><b class="num">${sleepAvg != null ? (Math.round(sleepAvg * 10) / 10) + 'h' : '–'}</b><span>average sleep</span></div>
      <div><b class="num">${fmtMin(roomTotal)}</b><span>in study rooms</span></div>
    </div>
    <div class="split trends">
      <div class="stack">
        <section class="panel"><h2 style="font-size:var(--step-1)">Focus per day</h2>${barsSvg(S.map((d) => d.focusMin), labels, { cls: 'focus', tips: S.map((d) => `${shortDate(d.day)}: ${fmtMin(d.focusMin)} focused`) })}</section>
        <section class="panel"><h2 style="font-size:var(--step-1)">Screen time per day</h2>${barsSvg(S.map((d) => d.screenMin), labels, { cls: 'screen', tips: S.map((d) => `${shortDate(d.day)}: ${d.screenMin == null ? 'not logged' : fmtMin(d.screenMin)}`) })}
          <p class="muted" style="font-size:12px;margin:4px 0 0">A dot means no screen time was logged that day.</p></section>
        <section class="panel"><h2 style="font-size:var(--step-1)">When you focus</h2>
          <p class="muted" style="font-size:var(--step--1)">Focus minutes by weekday and start hour, last 8 weeks.${t.best ? ` Your strongest slot: <b>${esc(t.best.weekday)}s around ${esc(t.best.hour)}</b>.` : ''}</p>
          <div class="heat-wrap"><table class="heat" aria-label="Focus minutes by weekday and hour">
            <thead><tr><th></th>${Array.from({ length: 24 }, (_, h) => `<th>${h % 3 === 0 ? (h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : (h - 12) + 'p') : ''}</th>`).join('')}</tr></thead>
            <tbody>${t.heat.map((row, wd) => `<tr><th>${WD[wd]}</th>${row.map((m, h) => `<td style="--a:${m ? (0.18 + 0.82 * m / maxHeat).toFixed(2) : 0}" title="${WD[wd]} ${h}:00 · ${m ? fmtMin(m) : 'no focus'}"></td>`).join('')}</tr>`).join('')}</tbody></table></div></section>
      </div>
      <div class="stack">
        <section class="panel"><h2 style="font-size:var(--step-1)">Energy and stress</h2>
          ${S.some((d) => d.energy != null) ? moodSvg(S) + '<div class="trend-key"><span><i class="en"></i>Energy</span><span><i class="st"></i>Stress</span><span>From your private check-ins (1–5)</span></div>'
            : '<p class="empty" style="margin:0">Check in on the Insights page (energy, stress, sleep) to see this.</p>'}</section>
        <section class="panel"><h2 style="font-size:var(--step-1)">Sleep</h2>${S.some((d) => d.sleep != null) ? barsSvg(S.map((d) => d.sleep), labels, { cls: 'sleep', fmt: (v) => `${v}h`, h: 110, tips: S.map((d) => `${shortDate(d.day)}: ${d.sleep == null ? 'not logged' : d.sleep + 'h'}`) }) : '<p class="empty" style="margin:0">Add hours slept in your check-ins.</p>'}</section>
        <section class="panel"><h2 style="font-size:var(--step-1)">Time in study rooms</h2>${roomTotal ? barsSvg(t.roomMin, labels, { cls: 'rooms', h: 110, tips: S.map((d, i) => `${shortDate(d.day)}: ${fmtMin(t.roomMin[i])} in rooms`) }) : '<p class="empty" style="margin:0">Join a room on the Rooms page; time you spend there shows up here.</p>'}</section>
        <section class="panel"><h2 style="font-size:var(--step-1)">Distractions logged</h2>${S.some((d) => d.distractions) ? barsSvg(S.map((d) => d.distractions || 0), labels, { cls: 'dist', fmt: (v) => String(v), h: 110 }) : '<p class="empty" style="margin:0">Tap "Got distracted?" during focus blocks to track this.</p>'}</section>
      </div>
    </div>`;
}

// Weekly review (Progress page).
async function renderReview() {
  const el = $('#review');
  if (!el) return;
  let r;
  try { r = await api('GET', `/review?day=${localDay()}`); } catch { el.hidden = true; return; }
  const chg = (x, goodUp = true) => (x == null ? '' : `<span class="chg ${(x > 0) === goodUp ? 'good' : 'bad'}">${x > 0 ? '▲' : '▼'} ${Math.abs(Math.round(x * 100))}%</span>`);
  el.innerHTML = `<h2 style="font-size:var(--step-1)">Your week in review <small class="muted">${shortDate(r.from)} – ${shortDate(r.to)}</small></h2>
    <div class="review-grid">
      <div><b class="num">${fmtMin(r.focusMin)}</b><span>focused ${chg(r.focusChange)}</span></div>
      <div><b class="num">${r.activeDays}/7</b><span>days with focus</span></div>
      <div><b class="num">${r.screenAvgMin != null ? fmtMin(r.screenAvgMin) : '–'}</b><span>screen a day ${chg(r.screenChange, false)}</span></div>
      <div><b class="num">${r.tasksDone}</b><span>tasks done</span></div>
      <div><b class="num">${r.bestDay ? new Date(r.bestDay.day + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' }) : '–'}</b><span>best day${r.bestDay ? `, ${fmtMin(r.bestDay.focusMin)}` : ''}</span></div>
      <div><b class="num">${r.sleepAvg != null ? r.sleepAvg + 'h' : '–'}</b><span>average sleep</span></div>
    </div>
    ${r.topDistraction ? `<p class="muted" style="margin:10px 0 0">Top distraction: <b>${esc(r.topDistraction.label)}</b> (${r.topDistraction.n}×). ${r.abandoned ? `${r.abandoned} blocks ended early.` : ''}</p>` : ''}
    <p class="review-next"><b>For next week:</b> ${esc(r.focusNext)}</p>`;
}

// Accountability buddies (Community page): see each other's daily goal progress and send cheers.
async function renderBuddies() {
  const el = $('#buddies');
  if (!el) return;
  let b;
  try { b = await api('GET', `/buddies?day=${localDay()}`); } catch { return; }
  el.innerHTML = `<h2 style="font-size:var(--step-1)">Accountability buddies</h2>
    <p class="muted" style="font-size:var(--step--1)">Buddies see only your focus time today, your daily goal and your streak. Nothing else.${b.buddies.some((x) => x.sample) ? ' The two marked "sample" are made up, to show how it works; they go when you remove sample data.' : ''}</p>
    ${b.incoming.map((r) => `<div class="buddy req"><span><b>${esc(r.name)}</b> wants to be buddies</span><button class="btn grow" data-bud-accept="${r.id}">Accept</button><button class="link" data-bud-del="${r.id}">Decline</button></div>`).join('')}
    ${b.buddies.map((x) => {
      const pct = Math.min(1, x.today.focusMin / x.today.goalMin);
      if (x.sample) return `<div class="buddy sample"><span class="face">${esc(initials(x.name.replace('Sample buddy: ', '')))}</span><div class="bud-main"><b>${esc(x.name.replace('Sample buddy: ', ''))}</b> <span class="pill">sample</span>
        <div class="level-bar goal-bar"><i style="width:${Math.round(Math.min(1, x.today.focusMin / x.today.goalMin) * 100)}%"></i></div>
        <small>${fmtMin(x.today.focusMin)} of ${fmtMin(x.today.goalMin)} today · ${x.streak}-day streak</small></div>
        <div class="bud-act"><button class="btn" disabled title="Sample buddies are just for the demo">${x.today.focusMin ? 'Cheer' : 'Nudge'}</button></div></div>`;
      return `<div class="buddy"><span class="face">${esc(initials(x.name))}</span><div class="bud-main"><b>${esc(x.name)}</b>
        <div class="level-bar goal-bar"><i style="width:${Math.round(pct * 100)}%"></i></div>
        <small>${fmtMin(x.today.focusMin)} of ${fmtMin(x.today.goalMin)} today · ${x.streak}-day streak</small></div>
        <div class="bud-act"><button class="btn" data-bud-cheer="${x.id}" data-kind="${x.today.focusMin ? 'cheer' : 'nudge'}">${x.today.focusMin ? 'Cheer' : 'Nudge'}</button>
        <button class="link" data-bud-del="${x.id}" aria-label="Remove ${esc(x.name)}">Remove</button></div></div>`;
    }).join('')}
    ${b.outgoing.map((r) => `<div class="buddy req"><span>Waiting for <b>${esc(r.name)}</b></span><button class="link" data-bud-del="${r.id}">Cancel</button></div>`).join('')}
    <form id="bud-form" class="task-form"><input name="username" placeholder="Their username" maxlength="24" autocomplete="off" aria-label="Buddy's username" /><button class="btn primary">Add buddy</button></form>
    ${b.cheers.length ? `<ul class="cheers">${b.cheers.slice(0, 5).map((c) => `<li>${esc(c.from)} ${c.kind === 'nudge' ? 'nudged you to start a block' : c.kind === 'proud' ? 'is proud of you' : 'cheered you on'} <time>${ago(c.created_at)}</time></li>`).join('')}</ul>` : ''}`;
  el.onsubmit = async (e) => {
    e.preventDefault();
    const u = e.target.elements.username.value.trim();
    if (!u) return;
    try { const r = await api('POST', '/buddies', { username: u }); toast(r.status === 'accepted' ? 'You are now buddies' : 'Request sent'); renderBuddies(); } catch (err) { fail(err); }
  };
  el.onclick = async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    try {
      if (t.dataset.budAccept) { await api('POST', `/buddies/${t.dataset.budAccept}/accept`); toast('You are now buddies'); }
      else if (t.dataset.budCheer) { await api('POST', `/buddies/${t.dataset.budCheer}/cheer`, { kind: t.dataset.kind }); toast(t.dataset.kind === 'nudge' ? 'Nudge sent' : 'Cheer sent', 'win'); }
      else if (t.dataset.budDel) { if (!confirm('Remove this buddy or request?')) return; await api('DELETE', `/buddies/${t.dataset.budDel}`); }
      else return;
      renderBuddies();
    } catch (err) { fail(err); }
  };
}

// Early warning: load score for each of the last 14 days, with the state bands.
async function renderTrend() {
  const el = $('#trend-panel');
  if (!el) return;
  let t;
  try { t = await api('GET', `/insights/trend?day=${localDay()}`); } catch { el.hidden = true; return; }
  const pts = t.points;
  const head = `<h2 style="font-size:var(--step-1)">Early warning</h2>`;
  if (pts.length < 3) { el.innerHTML = `${head}<p class="empty">A trend appears after a few days of data. It watches for your load score climbing before it turns into burnout.</p>`; return; }
  const W = 600, H = 170, L = 30, R = 12, T = 12, B = 26;
  const days = Array.from({ length: 14 }, (_, i) => shiftDay(localDay(), i - 13));
  const x = (day) => L + (days.indexOf(day) / 13) * (W - L - R);
  const y = (v) => T + (1 - v / 100) * (H - T - B);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)},${y(p.score).toFixed(1)}`).join('');
  const cls = (sc) => (sc < 40 ? 'ok' : sc < 65 ? 'mid' : 'hi');
  const last = pts[pts.length - 1];
  el.innerHTML = `${head}
    ${t.warning ? `<p class="warn-banner ${t.warning.level}" style="margin:8px 0 12px">${esc(t.warning.text)}</p>` : `<p class="muted" style="margin:4px 0 10px">No warning signs: your load score isn't climbing. Synapse flags it if it rises 3 days running or jumps on last week.</p>`}
    <svg class="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="Load score for the last 14 days, latest ${last.score} out of 100">
      <rect x="${L}" y="${y(100)}" width="${W - L - R}" height="${y(65) - y(100)}" class="band hi"/>
      <rect x="${L}" y="${y(65)}" width="${W - L - R}" height="${y(40) - y(65)}" class="band mid"/>
      <rect x="${L}" y="${y(40)}" width="${W - L - R}" height="${y(0) - y(40)}" class="band ok"/>
      ${[0, 40, 65, 100].map((v) => `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
      <text x="${L}" y="${H - 6}">${shortDate(days[0])}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">Today</text>
      <path d="${path}" class="line"/>
      ${pts.map((p) => `<circle cx="${x(p.day).toFixed(1)}" cy="${y(p.score).toFixed(1)}" r="${p === last ? 5 : 3.5}" class="pt ${cls(p.score)}"><title>${shortDate(p.day)}: ${p.score}/100 (${p.state})</title></circle>`).join('')}
    </svg>
    <div class="trend-key"><span><i class="ok"></i>Balanced (under 40)</span><span><i class="mid"></i>Strained</span><span><i class="hi"></i>At risk (65+)</span></div>`;
}

const PATTERN_ICON = { sleep: '☾', stress: '〜', leisure: '▢', distractions: '◔', hour: '☀', length: '◷', weekday: '▦' };
async function renderPatterns() {
  const el = $('#patterns-panel');
  if (!el) return;
  let p;
  try { p = await api('GET', `/patterns?day=${localDay()}`); } catch { el.hidden = true; return; }
  el.innerHTML = `<h2 style="font-size:var(--step-1)">Your personal patterns</h2>
    <p class="muted" style="font-size:var(--step--1)">Found by comparing your own days over the last 60 days (${p.daysAnalysed} with data). ${esc(p.note)}</p>
    ${p.findings.length ? `<ul class="findings">${p.findings.map((f) => `<li><span class="f-icon" aria-hidden="true">${PATTERN_ICON[f.kind] || '•'}</span><div><p>${esc(f.text)}</p><small>Based on ${esc(f.basedOn)}</small></div></li>`).join('')}</ul>`
      : '<p class="empty">No clear patterns yet. After a couple of weeks of focus blocks and check-ins, Synapse can tell you things like which hours and block lengths work best for you.</p>'}`;
}

async function renderDistractions() {
  const el = $('#distract-panel');
  if (!el) return;
  let d;
  try { d = await api('GET', `/distractions?day=${localDay()}&days=30`); } catch { el.hidden = true; return; }
  const max = Math.max(1, ...d.top.map((t) => t.n));
  el.innerHTML = `<h2 style="font-size:var(--step-1)">What pulls you away</h2>
    ${d.total ? `<p class="muted" style="font-size:var(--step--1)">${d.total} distractions logged in 30 days${d.peakLabel ? `, most around ${d.peakLabel}` : ''}.</p>
      <div class="dist-bars">${d.top.map((t) => `<div><span>${esc(t.label)}</span><span class="lb-bar"><i style="width:${Math.round((t.n / max) * 100)}%"></i></span><b class="num">${t.n}</b></div>`).join('')}</div>`
      : `<p class="empty" style="margin:0">During a focus block on Today, tap <b>Got distracted?</b> to note what pulled you away. Patterns show up here.</p>`}`;
}

// ---------------------------------------------------------------- Garden
VIEWS.garden = async (main) => {
  const r = await api('GET', '/rewards');
  const got = r.milestones.filter((m) => m.achievedAt).length;
  main.innerHTML = `
    <div class="page-head"><div><h1>Garden and badges</h1><p>Every completed focus block of 20 minutes or more plants a tree. Longer blocks grow bigger species. Badges reward healthy habits, not hours of screen time.</p></div>
      <div class="muted num">${r.trees} ${r.trees === 1 ? 'tree' : 'trees'} · best streak ${r.bestStreak} ${r.bestStreak === 1 ? 'day' : 'days'}</div></div>
    <section class="panel">
      ${r.garden.length ? `<div class="garden">${r.garden.map((t) => `<figure><svg viewBox="0 0 200 200" role="img" aria-label="${t.species}"><use href="#tree-${t.species}"/></svg><figcaption>${new Date(t.planted_at.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</figcaption></figure>`).join('')}</div>`
        : `<p class="empty">Your garden is empty. Finish a 25-minute focus block on the <a href="#/today">Today</a> page to plant your first sapling.</p>`}
      <p class="muted" style="font-size:var(--step--1);margin:12px 0 0">Sapling under 30 min · maple 30+ · cedar 40+ · oak 50+. Points are capped at ${r.dailyPointCap} a day so resting never costs you.</p>
    </section>
    <section class="panel level-card">
      <div class="lvl-big"><span class="lvl-num num">${r.level}</span><div><b>${esc(r.levelTitle)}</b><small>Level ${r.level}</small></div></div>
      <div class="lvl-prog"><div style="display:flex;justify-content:space-between;font-size:var(--step--1)"><span>${r.points} points</span><span class="muted">${r.nextLevelAt - r.points} to Level ${r.level + 1} · ${esc(r.nextLevelTitle)}</span></div>
        <div class="level-bar"><i style="width:${Math.round(r.progress * 100)}%"></i></div>
        <small class="muted">Your level and title show next to your name in the community and rooms (not on anonymous posts).</small></div>
    </section>
    <section class="panel"><h2 style="font-size:var(--step-1)">Badges <span class="muted num" style="font-weight:400">${got} of ${r.milestones.length}</span></h2>
      <ul class="badges">${r.milestones.map((m) => `<li class="${m.achievedAt ? 'got' : ''}"><span class="badge-icon" aria-hidden="true">${BADGE_ICON[m.code] || '★'}</span>
        <div><b>${esc(m.title)}</b><small>${esc(m.desc)}</small>${m.achievedAt ? `<small class="when">Earned ${ago(m.achievedAt)}</small>` : ''}</div></li>`).join('')}</ul></section>`;
};

const BADGE_ICON = { first_focus: '🌱', first_break: '☕', trees_5: '🌳', trees_25: '🌲', trees_100: '🏞️', streak_3: '🔥', streak_7: '📅', streak_30: '🌿',
  level_5: '🪴', level_10: '🌍', balanced_day: '⚖️', first_post: '💬', usage_logged: '🪞', early_bird: '🌅', tasks_10: '✅', distraction_aware: '🧭',
  room_hour: '👥', room_10h: '🏠', first_reply: '🤝', cheer_5: '📣', buddy: '🫶', goal_met: '🎯' };
const levelChip = (lv) => (lv ? `<span class="lvl" title="Level ${lv.level} · ${esc(lv.title)} · ${lv.badges} ${lv.badges === 1 ? 'badge' : 'badges'}">Lv ${lv.level}<span class="lvl-t">· ${esc(lv.title)}</span></span>` : '');

// ---------------------------------------------------------------- Privacy
VIEWS.privacy = async (main) => {
  const [c, log] = await Promise.all([api('GET', '/consents'), api('GET', '/consents/log')]);
  const FIELD = Object.fromEntries(CONSENTS.map((x) => [x.key, x.title]));
  main.innerHTML = `
    <div class="page-head"><div><h1>Privacy and data</h1><p>Your data is stored in this server's database and is only visible to your account, except community check-ins and room messages, which other members see.</p></div></div>
    <div class="split">
      <div class="stack">
        <section class="panel"><h2 style="font-size:var(--step-1)">What Synapse may save</h2><form id="consent-form">${consentControls(c)}</form></section>
        <section class="panel" id="devices"><h2 style="font-size:var(--step-1)">Connected trackers</h2>
          <p>The browser extension, desktop tracker and Android app send daily totals using a device key. A key can only upload screen time; it can't read your data or sign in. Revoke it any time.</p>
          <div id="device-list"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px"><button class="btn" data-connect="extension">Connect browser extension</button><button class="btn" data-connect="desktop">Connect desktop tracker</button><button class="btn" data-connect="phone">Connect Android phone</button></div>
          ${c.usage_tracking ? '' : '<p class="note" style="margin-top:14px"><strong>Syncing is paused.</strong> Trackers can only upload while "Save screen-time data" is on.</p>'}
        </section>
        <section class="panel"><h2 style="font-size:var(--step-1)">Download or delete</h2>
          <p>Download everything stored for your account as a JSON file.</p>
          <button class="btn" id="export">Download my data</button>
          <div class="divided" style="margin-top:22px">
            ${[['activity', 'Focus sessions and rewards', 'Removes sessions, points, trees, streaks and milestones.'],
               ['usage', 'Screen-time data', 'Removes every app and site total, including measured Synapse time.'],
               ['wellbeing', 'Mood check-ins', 'Removes energy, stress and sleep entries.'],
               ['community', 'Community posts and room messages', 'Removes your check-ins, reactions and chat messages.']]
              .map(([k, t, d]) => `<div style="display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap"><div><b>${t}</b><br><small>${d}</small></div><button class="btn danger" data-scope="${k}">Delete</button></div>`).join('')}
          </div></section>
        <section class="panel"><h2 style="font-size:var(--step-1)">Sign-in methods</h2>
          <div class="divided">
            <div style="display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap"><div><b>Username</b><br><small>${esc(state.me.user.username)}${state.me.user.hasPassword ? ' · with a password' : ' · no password (Google only)'}</small></div></div>
            <div style="display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap" id="google-link-row"><div><b>Google</b><br><small>${state.me.user.google ? `Linked${state.me.user.email ? ` as ${esc(state.me.user.email)}` : ''}` : state.me.googleClientId ? 'Not linked. Link it to sign in with one tap.' : "Not available on this server."}</small></div>
              ${state.me.user.google ? (state.me.user.hasPassword ? '<button class="btn" id="google-unlink">Unlink</button>' : '') : state.me.googleClientId ? '<div id="google-link-btn"></div>' : ''}</div>
          </div></section>
        <section class="panel" id="email-panel"><h2 style="font-size:var(--step-1)">Weekly email report</h2><p class="muted">Loading…</p></section>
        <section class="panel" id="blocked-panel"><h2 style="font-size:var(--step-1)">Blocked people</h2><p class="muted">Loading…</p></section>
        <section class="panel"><h2 style="font-size:var(--step-1)">Delete account</h2><p>Permanently removes your account and all of the data above. This can't be undone.</p>
          <button class="btn danger" id="del-account">Delete my account</button></section>
      </div>
      <aside class="stack">
        <section class="note"><p><strong>What isn't collected.</strong> Synapse doesn't read other apps, other browser tabs, your location or your contacts. The camera and microphone are used only while you're on a room call and you've switched them on. Video and audio go directly between participants (or through the room's media server if one is set up) and are never recorded or stored.</p>
          <p style="margin:0"><strong>Not a medical tool.</strong> Insights describe patterns in your own data and can't diagnose burnout or any condition. If you're struggling, talk to someone you trust or a professional.</p></section>
        <section class="panel"><h2 style="font-size:var(--step-1)">Consent history</h2>
          ${log.length ? `<ul class="session-log">${log.map((l) => `<li><span>${esc(FIELD[l.field] || l.field)} turned ${l.value ? 'on' : 'off'}</span><span class="muted">${ago(l.changed_at)}</span></li>`).join('')}</ul>` : '<p class="empty">No changes yet.</p>'}</section>
      </aside>
    </div>
    <dialog id="key-dialog" class="sheet"><form method="dialog"><h2>Your device key</h2>
      <p>Copy this key now. For your security it won't be shown again.</p>
      <div class="qr-connect" id="qr-connect" hidden>
        <div class="qr" id="qr"></div>
        <div><b>Scan with your phone's camera</b><p class="muted">With the Synapse app installed, this connects it in one tap. No typing.</p>
          <a class="btn" id="qr-link" href="#">Already on your phone? Tap to connect</a></div>
      </div>
      <div class="keybox"><code id="key-value"></code><button type="button" class="btn" id="copy-key">Copy</button></div>
      <p style="margin-top:16px">Server address: <code id="key-server"></code></p>
      <p class="muted" id="key-help" style="font-size:var(--step--1)"></p>
      <div class="sheet-actions"><button class="btn primary" value="done">Done</button></div></form></dialog>
    <dialog id="del-dialog" class="sheet"><form method="dialog" id="del-form"><h2>Delete your account?</h2>${state.me.user.hasPassword
        ? `<p>Enter your password to confirm. Everything is removed immediately.</p>
      <label class="field">Password <input type="password" name="password" autocomplete="current-password" required /></label>`
        : `<p>Type your username <b>${esc(state.me.user.username)}</b> to confirm. Everything is removed immediately.</p>
      <label class="field">Username <input name="confirm" autocomplete="off" required /></label>`}
      <p class="form-error" role="alert"></p>
      <div class="sheet-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn danger" value="confirm" id="del-confirm">Delete account</button></div></form></dialog>`;

  $('#consent-form').addEventListener('change', async (e) => {
    try { await saveConsents(e.currentTarget); toast('Privacy setting saved'); route(); }
    catch (err) { fail(err); }
  });
  const KIND = { extension: 'Browser extension', desktop: 'Desktop tracker', phone: 'Android phone' };
  const paintDevices = (list) => {
    $('#device-list').innerHTML = list.length ? `<ul class="session-log">${list.map((d) => `
      <li><span><b>${esc(d.name)}</b><br><small>${KIND[d.kind]} · key ${esc(d.prefix)}… · ${d.last_used_at ? `last synced ${ago(d.last_used_at)}` : 'never synced'}</small></span>
      <button class="btn danger" data-revoke="${d.id}">Revoke</button></li>`).join('')}</ul>` : '<p class="empty" style="padding:8px 0">Nothing connected yet.</p>';
  };
  paintDevices(await api('GET', '/devices'));
  $('#devices').addEventListener('click', async (e) => {
    const con = e.target.closest('[data-connect]');
    const rev = e.target.closest('[data-revoke]');
    try {
      if (con) {
        const kind = con.dataset.connect;
        const what = { extension: ['browser', 'Chrome on my laptop'], desktop: ['computer', 'My laptop'], phone: ['phone', 'My Android phone'] }[kind];
        const name = prompt(`Name this ${what[0]} so you can recognise it later:`, what[1]);
        if (name === null) return;
        const r = await api('POST', '/devices', { kind, name: name.trim() || undefined });
        $('#key-value').textContent = r.token;
        $('#key-server').textContent = location.origin;
        $('#key-help').textContent = {
          extension: 'Open the Synapse extension, choose Settings, and paste the server address and key.',
          desktop: 'Run the tracker once with "python3 synapse_tracker.py setup" (Windows or Mac) and paste the server address and key when asked.',
          phone: 'Open the Synapse app on your phone and paste the server address and key. Tip: use Copy, then send it to yourself.',
        }[kind];
        const qrBox = $('#qr-connect');
        qrBox.hidden = kind !== 'phone';
        if (kind === 'phone') {
          const link = `synapse://connect?server=${encodeURIComponent(location.origin)}&key=${encodeURIComponent(r.token)}`;
          $('#qr-link').href = link;
          try {
            await loadScript('/vendor/qrcode.js');
            const qr = window.qrcode(0, 'M');
            qr.addData(link);
            qr.make();
            $('#qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
            $('#qr svg').setAttribute('role', 'img');
            $('#qr svg').setAttribute('aria-label', 'QR code that connects the Synapse Android app');
          } catch { $('#qr').textContent = 'QR code unavailable. Use the key below.'; }
        }
        $('#key-dialog').showModal();
        paintDevices(await api('GET', '/devices'));
      }
      if (rev && confirm('Revoke this key? That tracker will stop syncing until you connect it again. Data it already sent stays.')) {
        await api('DELETE', `/devices/${rev.dataset.revoke}`);
        toast('Key revoked');
        paintDevices(await api('GET', '/devices'));
      }
    } catch (err) { fail(err); }
  });
  $('#copy-key').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#key-value').textContent); toast('Key copied'); }
    catch { const r = document.createRange(); r.selectNodeContents($('#key-value')); getSelection().removeAllRanges(); getSelection().addRange(r); toast('Press Ctrl+C to copy the selected key'); }
  });

  $('#export').addEventListener('click', async () => {
    try {
      const data = await api('GET', '/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `synapse-export-${localDay()}.json` });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Export downloaded');
    } catch (err) { fail(err); }
  });
  main.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-scope]');
    if (!b) return;
    if (!confirm(`Delete ${b.closest('div').querySelector('b').textContent.toLowerCase()}? This can't be undone.`)) return;
    try { await api('DELETE', '/data', { scope: b.dataset.scope }); toast('Deleted'); state.me = await api('GET', '/me'); }
    catch (err) { fail(err); }
  });
  gsi.button($('#google-link-btn'), async (credential) => {
    try { await api('POST', '/account/google', { credential }); toast('Google linked. You can now sign in with it.'); state.me = await api('GET', '/me'); route(); }
    catch (err) { fail(err); }
  }, 'signin_with');
  $('#google-unlink')?.addEventListener('click', async () => {
    try { await api('DELETE', '/account/google'); toast('Google unlinked'); state.me = await api('GET', '/me'); route(); }
    catch (err) { fail(err); }
  });
  renderBlocked();
  renderEmail();
  const dlg = $('#del-dialog');
  $('#del-account').addEventListener('click', () => { $('.form-error', dlg).textContent = ''; dlg.showModal(); });
  $('#del-confirm').addEventListener('click', async (e) => {
    e.preventDefault();
    const f = $('#del-form').elements;
    try { await api('DELETE', '/account', { password: f.password?.value, confirm: f.confirm?.value }); dlg.close(); store.del('synapse.timer'); signOut('Your account and data were deleted.'); }
    catch (err) { $('.form-error', dlg).textContent = err.message; }
  });
};

// ---------------------------------------------------------------- installable app + notifications
let swReg = null;
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('/sw.js').then((r) => { swReg = r; }).catch(() => {});
}
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  if (matchMedia('(max-width: 760px)').matches) return; // phones: keep the browser's own install banner
  e.preventDefault();
  installPrompt = e;
  $('#install').hidden = false;
});
window.addEventListener('appinstalled', () => { installPrompt = null; $('#install').hidden = true; toast('Synapse is installed. Open it from your apps.'); });
$('#install').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  $('#install').hidden = true;
});

const notifySupported = () => 'Notification' in window;
async function enableNotifications() {
  if (!notifySupported()) return toast('This browser does not support notifications.', 'err');
  const p = await Notification.requestPermission();
  if (p === 'granted') { toast("You'll get a notification when a session ends."); notify('Notifications are on', 'Synapse will tell you when a focus block or break ends.', true); }
  else toast('Notifications are blocked. You can allow them in your browser settings for this site.');
  if (currentView() === 'today') renderTodaySide();
}
/** System notification; skipped while you're looking at the tab unless `always`. */
async function notify(title, body, always = false) {
  if (!notifySupported() || Notification.permission !== 'granted') return;
  if (!always && document.visibilityState === 'visible' && document.hasFocus()) return;
  const opts = { body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: 'synapse-timer', renotify: true };
  try {
    const reg = swReg || (await navigator.serviceWorker?.getRegistration());
    if (reg) return reg.showNotification(title, opts);
    new Notification(title, opts);
  } catch {}
}

// ---------------------------------------------------------------- boot
$('#logout').addEventListener('click', () => signOut());
initI18n();
setupAuth();
(async () => {
  if (state.token) {
    try { await enterApp(false); return; } catch { store.del('synapse.token'); state.token = null; }
  }
  $('#auth').hidden = false;
})();
