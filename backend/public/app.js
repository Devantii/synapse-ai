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
  if (!location.hash) location.hash = '#/today';
  route();
}

function signOut(msg) {
  foreground.flush();
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
        ? `<button class="btn" data-act="giveup">Give up</button>`
        : `<button class="btn" data-act="endbreak">End break</button>`
      : timer.s.mode === 'focus'
        ? `<button class="btn grow" data-act="start">Start ${timer.s.planned}-minute focus</button><button class="btn quiet" data-act="tobreak">Take a break instead</button>`
        : `<button class="btn rest" data-act="start">Start ${timer.s.planned}-minute break</button><button class="btn quiet" data-act="tofocus">Skip break</button>`;
    $('.presets').hidden = timer.s.running;
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
        <label class="field" id="tag-field" style="width:min(320px,100%);margin:0">What are you working on? <small>Optional</small>
          <input id="tag" maxlength="40" placeholder="Chapter 3 notes" value="${esc(timer.s.tag)}" /></label>
        <div class="timer-controls"></div>
        <div id="break-guide" class="break-guide" hidden></div>
      </section>
      <section class="today-side" id="today-side"></section>
    </div>`;
  $('#tag').addEventListener('input', (e) => { timer.s.tag = e.target.value; timer.save(); });
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
  });
  paintTimer();
  await renderTodaySide();
};

async function renderTodaySide() {
  const side = $('#today-side');
  if (!side) return;
  const [rewards, sessions] = await Promise.all([api('GET', '/rewards'), api('GET', '/sessions?days=2')]);
  side.onclick = (e) => { if (e.target.closest('#notify-on')) enableNotifications(); };
  state.me.rewards = rewards;
  const today = sessions.filter((s) => s.day === localDay());
  const focusMin = today.filter((s) => s.kind === 'focus' && s.completed).reduce((a, s) => a + s.actual_min, 0);
  const breaks = today.filter((s) => s.kind === 'break' && s.completed).length;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  side.innerHTML = `
    <h1>${greet}, ${esc(state.me.user.displayName)}.</h1>
    <p class="muted">${hour >= 22 ? "It's late. A short wind-down session is better than a long push." : 'Work in blocks and take the break when the timer offers it.'}</p>
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
    <h2 style="margin-top:28px;font-size:var(--step-1)">Today's sessions</h2>
    ${today.length ? `<ul class="session-log">${today.map((s) => `
      <li><span><i class="dot ${s.kind === 'break' ? 'break' : s.completed ? '' : 'abandoned'}"></i>${s.kind === 'break' ? 'Break' : esc(s.tag || 'Focus')}${s.completed ? '' : ' (ended early)'}</span>
      <span class="muted num">${s.started_at.slice(11, 16)} · ${fmtMin(s.actual_min)}</span></li>`).join('')}</ul>`
      : `<p class="empty">No sessions yet today. A 15-minute block is a good way in.</p>`}
    ${notifySupported() && Notification.permission === 'default' ? `<p class="note" style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap"><span>Get a notification when a session ends, even if this tab is in the background.</span><button class="btn" id="notify-on">Turn on</button></p>` : ''}
    ${state.me.consents.activity_tracking ? '' : `<p class="note"><strong>Sessions aren't being saved.</strong> Turn on "Save focus activity" in <a href="#/privacy">Privacy</a> to earn points and grow trees.</p>`}`;
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
      </button>`).join('')}</div>`;
  main.addEventListener('click', (e) => { const t = e.target.closest('[data-room]'); if (t) location.hash = `#/rooms/${t.dataset.room}`; });
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
    <section class="panel call">
      <div class="stage" id="stage" aria-label="People on camera"></div>
      <div class="stage-empty" id="stage-empty"><svg aria-hidden="true"><use href="#i-cam"/></svg>
        <p><b>Study together on camera.</b> Turn your camera on so others can see you working, or join without it. Mics start off: it's a quiet room.</p></div>
      <div class="call-bar" id="call-bar"></div>
    </section>
    <div class="room">
      <aside class="panel"><h2 style="font-size:var(--step-1)">Here now</h2><ul class="people" id="people"></ul></aside>
      <section class="panel chat">
        <div class="chat-log" id="chat-log" aria-live="polite"></div>
        <form class="chat-form" id="chat-form"><label class="sr" style="position:absolute;left:-999px" for="chat-input">Message</label>
          <input id="chat-input" maxlength="500" autocomplete="off" placeholder="Say what you're starting on" /><button class="btn primary">Send</button></form>
      </section>
    </div>`;
  const log = $('#chat-log');
  const addMsg = (m) => {
    const mine = m.isMine || m.userId === state.me.user.id;
    log.insertAdjacentHTML('beforeend', `<div class="msg ${mine ? 'mine' : ''}"><div class="who">${mine ? 'You' : esc(m.author)} · ${ago(m.created_at)}</div><div class="bubble">${esc(m.body)}</div></div>`);
    log.scrollTop = log.scrollHeight;
  };
  (await api('GET', `/rooms/${roomId}/messages`)).forEach(addMsg);
  if (!log.children.length) log.innerHTML = `<p class="empty" id="chat-empty">No messages yet. Say what you're working on so others know you're here.</p>`;

  let lastMembers = [];
  const paintPeople = (members) => {
    lastMembers = members;
    $('#people').innerHTML = members.map((m) => {
      const mins = m.focusEndsAt ? Math.max(0, Math.ceil((m.focusEndsAt - Date.now()) / 60000)) : null;
      return `<li><span class="face">${esc(initials(m.name))}</span><span><b>${esc(m.name)}${m.socketId === state.socket?.id ? ' (you)' : ''}</b><br>
        <span class="status ${m.focusing ? 'focusing' : ''}">${m.focusing ? `Focusing${mins != null ? `, ${mins} min left` : ''}` : 'Here'}${m.audio ? (m.video ? ' · on camera' : ' · in call') + (m.muted ? '' : ' · mic on') : ''}</span></span></li>`;
    }).join('');
    stage.paint(members);
  };
  const onPresence = (m) => paintPeople(m);
  const onMessage = (m) => { $('#chat-empty')?.remove(); addMsg(m); };
  state.socket.on('room:presence', onPresence);
  state.socket.on('room:message', onMessage);

  const join = await emitAck('room:join', { roomId });
  if (join.error) return toast(join.error, 'err');
  rooms.current = roomId;
  paintPeople(join.members);
  timer.broadcast();

  $('#chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = $('#chat-input');
    const body = inp.value.trim();
    if (!body) return;
    const r = await emitAck('room:message', { body });
    if (r.error) toast(r.error, 'err'); else inp.value = '';
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
  const tick = setInterval(() => paintPeople(lastMembers), 30000); // refresh "min left"

  state.cleanup.push(() => {
    clearInterval(tick);
    state.socket?.off('room:presence', onPresence);
    state.socket?.off('room:message', onMessage);
    paintCall = null;
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
        <span>${esc(mine ? 'You' : m.name)}</span>${m.focusing ? `<em>${mins != null ? `${mins}m` : 'focusing'}</em>` : ''}`;
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
      </aside>
    </div>`;
  const feed = $('#feed');
  const postHtml = (p) => `
    <li class="post" data-id="${p.id}"><header><b>${esc(p.author)}${p.isMine ? ' (you)' : ''}</b><span class="mood ${esc(p.mood)}">${esc(MOOD_WORDS[p.mood] || p.mood)}</span><time>${ago(p.created_at)}</time></header>
      <p>${esc(p.body)}</p>
      <div class="reacts">${Object.entries(RX).map(([k, label]) => `<button class="react" data-react="${k}" aria-pressed="${p.reactions[k].mine}">${label}${p.reactions[k].count ? ` <span class="num">${p.reactions[k].count}</span>` : ''}</button>`).join('')}
      ${p.isMine ? `<button class="link" data-delete style="margin-left:auto;font-size:13px">Delete</button>` : ''}</div></li>`;
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
    } catch (err) { fail(err); }
  });
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
};

// ---------------------------------------------------------------- Insights
VIEWS.insights = async (main) => {
  if (!state.me.consents.ai_insights) {
    main.innerHTML = `<div class="page-head"><div><h1>Insights</h1></div></div>
      <section class="panel"><h2>Insights are off</h2><p>When you turn them on, Synapse analyses your saved focus sessions, screen-time totals and private mood check-ins to estimate how balanced your week looks, and shows exactly which patterns drove that estimate.</p>
      <button class="btn primary" id="enable-ai">Turn on insights</button></section>`;
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
        <section class="panel"><h2 style="font-size:var(--step-1)">Suggestions for this week</h2>
          <ul class="recs">${ins.recommendations.map((r) => `<li class="rec" data-p="${r.priority}"><h3>${esc(r.title)}</h3><p>${esc(r.action)}</p><div class="because">Because: ${esc(r.because)}.</div></li>`).join('')}</ul></section>
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
        <section class="panel"><h2 style="font-size:var(--step-1)">Ask the coach</h2>
          <p class="muted" style="font-size:var(--step--1)">${state.me.llmEnabled ? 'Replies come from an AI model that sees your summary above, not your raw data.' : 'No AI provider is configured on this server, so replies are rule-based from your insights.'}</p>
          <div class="coach-log" id="coach-log" aria-live="polite"></div>
          <form class="chat-form" id="coach-form"><input id="coach-input" maxlength="1000" placeholder="I keep scrolling at night. What should I try?" autocomplete="off" aria-label="Message the coach" /><button class="btn primary">Ask</button></form>
        </section>
      </div>
    </div>`;

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

// ---------------------------------------------------------------- Garden
VIEWS.garden = async (main) => {
  const r = await api('GET', '/rewards');
  const got = r.milestones.filter((m) => m.achievedAt).length;
  main.innerHTML = `
    <div class="page-head"><div><h1>Your garden</h1><p>Every completed focus block of 20 minutes or more plants a tree. Longer blocks grow bigger species.</p></div>
      <div class="muted num">Level ${r.level} · ${r.points} points · best streak ${r.bestStreak} days</div></div>
    <section class="panel">
      ${r.garden.length ? `<div class="garden">${r.garden.map((t) => `<figure><svg viewBox="0 0 200 200" role="img" aria-label="${t.species}"><use href="#tree-${t.species}"/></svg><figcaption>${new Date(t.planted_at.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</figcaption></figure>`).join('')}</div>`
        : `<p class="empty">Your garden is empty. Finish a 25-minute focus block on the <a href="#/today">Today</a> page to plant your first sapling.</p>`}
      <p class="muted" style="font-size:var(--step--1);margin:12px 0 0">Sapling under 30 min · maple 30+ · cedar 40+ · oak 50+. Points are capped at ${r.dailyPointCap} a day so resting never costs you.</p>
    </section>
    <section class="panel"><h2 style="font-size:var(--step-1)">Milestones <span class="muted num" style="font-weight:400">${got} of ${r.milestones.length}</span></h2>
      <ul class="milestones">${r.milestones.map((m) => `<li class="${m.achievedAt ? 'got' : ''}"><b>${esc(m.title)}</b><small>${esc(m.desc)}</small></li>`).join('')}</ul></section>`;
};

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
setupAuth();
(async () => {
  if (state.token) {
    try { await enterApp(false); return; } catch { store.del('synapse.token'); state.token = null; }
  }
  $('#auth').hidden = false;
})();
