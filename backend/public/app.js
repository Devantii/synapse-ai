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
}

async function enterApp(isNew) {
  state.me = await api('GET', '/me');
  $('#auth').hidden = true;
  $('#app').hidden = false;
  $('#who').textContent = state.me.user.displayName;
  connectSocket();
  foreground.sync();
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
    if (completed) chime();
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
  }
  if (ctr) $$('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.preset === timer.s.planned)));
}

// ---------------------------------------------------------------- router
const VIEWS = {};
const currentView = () => (location.hash.replace(/^#\//, '').split('/')[0] || 'today');
async function route() {
  if (!state.me) return;
  state.cleanup.forEach((f) => { try { f(); } catch {} });
  state.cleanup = [];
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
    ${state.me.consents.activity_tracking ? '' : `<p class="note"><strong>Sessions aren't being saved.</strong> Turn on "Save focus activity" in <a href="#/privacy">Privacy</a> to earn points and grow trees.</p>`}`;
}

// ---------------------------------------------------------------- Rooms
const rooms = { current: null };
VIEWS.rooms = async (main, roomId) => {
  if (roomId) return renderRoom(main, roomId);
  if (rooms.current) { state.socket?.emit('room:leave'); rooms.current = null; rtc.leave(); }
  const list = await api('GET', '/rooms');
  main.innerHTML = `
    <div class="page-head"><div><h1>Focus rooms</h1><p>Work alongside other people. Chat is text-first; voice is optional and only starts when you join it.</p></div></div>
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
    <div class="room">
      <aside class="panel"><h2 style="font-size:var(--step-1)">Here now</h2><ul class="people" id="people"></ul>
        <div class="audio-bar" id="audio-bar"></div></aside>
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
        <span class="status ${m.focusing ? 'focusing' : ''}">${m.focusing ? `Focusing${mins != null ? `, ${mins} min left` : ''}` : 'Here'}${m.audio ? (m.muted ? ' · voice muted' : ' · on voice') : ''}</span></span></li>`;
    }).join('');
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

  const paintAudio = () => {
    $('#audio-bar').innerHTML = rtc.active
      ? `<span class="live">On voice</span><button class="btn" data-a="mute">${rtc.muted ? 'Unmute' : 'Mute'}</button><button class="btn danger" data-a="leave">Leave voice</button>`
      : `<button class="btn" data-a="join"><svg><use href="#i-mic"/></svg>Join voice</button><small>Uses your microphone only after you click. ${state.me.voiceMode === 'livekit' ? 'Voice runs through a media server, so big rooms work.' : 'Best for up to 6 people.'}</small>`;
  };
  paintAudio();
  $('#audio-bar').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'join') { e.target.closest('button').disabled = true; await rtc.join(roomId, paintAudio); paintAudio(); }
    if (a === 'leave') { rtc.leave(); paintAudio(); }
    if (a === 'mute') { rtc.setMuted(!rtc.muted); paintAudio(); }
  });
  const tick = setInterval(() => paintPeople(lastMembers), 30000); // refresh "min left"

  state.cleanup.push(() => {
    clearInterval(tick);
    state.socket?.off('room:presence', onPresence);
    state.socket?.off('room:message', onMessage);
    if (!location.hash.startsWith(`#/rooms/${roomId}`)) { rtc.leave(); state.socket?.emit('room:leave'); rooms.current = null; }
  });
}

// ---------------------------------------------------------------- Voice
// rtc picks the transport: LiveKit (SFU) when the server has it configured, otherwise peer-to-peer mesh.
const rtc = {
  impl: null,
  get active() { return !!this.impl?.active; },
  get muted() { return !!this.impl?.muted; },
  async join(roomId, onChange) {
    if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) return toast('This browser does not support voice rooms.', 'err');
    let cfg;
    try { cfg = await api('GET', `/rooms/${encodeURIComponent(roomId)}/voice`); } catch (e) { return fail(e); }
    this.impl = cfg.mode === 'livekit' ? lk : mesh;
    await this.impl.join(cfg, onChange);
  },
  setMuted(m) { this.impl?.setMuted(m); },
  leave() { mesh.leave(); lk.leave(); this.impl = null; },
  onSignal(m) { mesh.onSignal(m); },
  dropPeer(id) { mesh.dropPeer(id); },
};

const micError = (e) => toast(e?.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in your browser settings to join voice.' : `Could not start the microphone: ${e?.message || e}`, 'err');

// LiveKit SFU voice.
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = Object.assign(document.createElement('script'), { src, onload: resolve, onerror: () => reject(new Error('Could not load the voice library.')) });
    document.head.append(s);
  });
}
const lk = {
  room: null, muted: false,
  get active() { return !!this.room; },
  async join(cfg, onChange) {
    try { await loadScript('/vendor/livekit-client.umd.js'); } catch (e) { return toast(e.message, 'err'); }
    const { Room, RoomEvent, Track } = window.LivekitClient;
    const room = new Room({ adaptiveStream: true, dynacast: true, audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      const el = track.attach();
      el.dataset.lk = '1';
      el.dataset.identity = participant.identity;
      $('#audio-sinks').append(el);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()));
    room.on(RoomEvent.ParticipantDisconnected, (participant) =>
      $$('#audio-sinks [data-lk]').filter((el) => el.dataset.identity === participant.identity).forEach((el) => { el.srcObject = null; el.remove(); }));
    room.on(RoomEvent.Disconnected, () => {
      if (this.room !== room) return;
      this.room = null;
      $$('#audio-sinks [data-lk]').forEach((el) => el.remove());
      state.socket?.emit('voice:status', { on: false });
      toast('Voice disconnected.');
      onChange?.();
    });
    try {
      await room.connect(cfg.url, cfg.token);
    } catch (e) {
      return toast(`Could not reach the voice server: ${e.message}`, 'err');
    }
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch (e) {
      await room.disconnect();
      return micError(e);
    }
    this.room = room;
    this.muted = false;
    room.startAudio().catch(() => {});
    state.socket?.emit('voice:status', { on: true, muted: false });
    const others = room.remoteParticipants.size;
    toast(others ? `Connected to voice with ${others} ${others === 1 ? 'person' : 'people'}` : "You're on voice. Others will hear you when they join.");
  },
  async setMuted(m) {
    if (!this.room) return;
    this.muted = m;
    await this.room.localParticipant.setMicrophoneEnabled(!m);
    state.socket?.emit('voice:status', { on: true, muted: m });
  },
  leave() {
    if (!this.room) return;
    const r = this.room;
    this.room = null;
    r.disconnect().catch(() => {});
    $$('#audio-sinks [data-lk]').forEach((el) => el.remove());
    state.socket?.emit('voice:status', { on: false });
  },
};

// Peer-to-peer mesh voice (no media server needed).
const mesh = {
  get active() { return !!this.stream; },
  stream: null, pcs: new Map(), ice: null, muted: false,
  async join() {
    try {
      this.ice ??= await api('GET', '/rtc-config');
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    } catch (e) {
      this.stream = null;
      return micError(e);
    }
    const r = await emitAck('audio:join');
    if (r.error) { this.stopStream(); return toast(r.error, 'err'); }
    this.muted = false;
    for (const p of r.peers) this.connect(p.socketId, true);
    toast(r.peers.length ? `Connected to voice with ${r.peers.length} ${r.peers.length === 1 ? 'person' : 'people'}` : "You're on voice. Others will hear you when they join.");
  },
  connect(peerId, initiator) {
    const pc = new RTCPeerConnection(this.ice);
    this.pcs.set(peerId, pc);
    this.stream.getTracks().forEach((t) => pc.addTrack(t, this.stream));
    pc.onicecandidate = (e) => e.candidate && state.socket.emit('rtc:signal', { to: peerId, data: { candidate: e.candidate.toJSON() } });
    pc.ontrack = (e) => {
      let el = document.getElementById('audio-' + peerId);
      if (!el) { el = document.createElement('audio'); el.id = 'audio-' + peerId; el.autoplay = true; $('#audio-sinks').append(el); }
      el.srcObject = e.streams[0];
      el.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) this.dropPeer(peerId); };
    if (initiator) {
      pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() =>
        state.socket.emit('rtc:signal', { to: peerId, data: { sdp: pc.localDescription.toJSON() } }));
    }
    return pc;
  },
  async onSignal({ from, data }) {
    if (!this.stream) return;
    let pc = this.pcs.get(from);
    try {
      if (data.sdp) {
        if (data.sdp.type === 'offer' && !pc) pc = this.connect(from, false);
        if (!pc) return;
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
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
    document.getElementById('audio-' + id)?.remove();
  },
  setMuted(m) {
    this.muted = m;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !m));
    state.socket?.emit('audio:mute', { muted: m });
  },
  stopStream() { this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null; },
  leave() {
    if (!this.stream && !this.pcs.size) return;
    [...this.pcs.keys()].forEach((id) => this.dropPeer(id));
    this.stopStream();
    state.socket?.emit('audio:leave');
  },
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
          <p>It cannot see other apps or websites by itself. To track them automatically, install the <strong>Synapse browser extension</strong> (per-site time) or the <strong>Windows desktop tracker</strong> (per-app time) and connect them in <a href="#/privacy">Privacy</a>. Phone usage still needs to be entered here: iOS doesn't share it with ordinary apps, and Android needs a native app.</p>
          <p>If the same app is both typed in and tracked, only the larger number counts.</p>
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
  await load();
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
          <p>The browser extension and desktop tracker send daily totals using a device key. A key can only upload screen time; it can't read your data or sign in. Revoke it any time.</p>
          <div id="device-list"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px"><button class="btn" data-connect="extension">Connect browser extension</button><button class="btn" data-connect="desktop">Connect desktop tracker</button></div>
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
        <section class="panel"><h2 style="font-size:var(--step-1)">Delete account</h2><p>Permanently removes your account and all of the data above. This can't be undone.</p>
          <button class="btn danger" id="del-account">Delete my account</button></section>
      </div>
      <aside class="stack">
        <section class="note"><p><strong>What isn't collected.</strong> Synapse doesn't read other apps, other browser tabs, your location or your contacts. The microphone is used only while you're in a voice room, and audio goes directly between participants rather than through this server.</p>
          <p style="margin:0"><strong>Not a medical tool.</strong> Insights describe patterns in your own data and can't diagnose burnout or any condition. If you're struggling, talk to someone you trust or a professional.</p></section>
        <section class="panel"><h2 style="font-size:var(--step-1)">Consent history</h2>
          ${log.length ? `<ul class="session-log">${log.map((l) => `<li><span>${esc(FIELD[l.field] || l.field)} turned ${l.value ? 'on' : 'off'}</span><span class="muted">${ago(l.changed_at)}</span></li>`).join('')}</ul>` : '<p class="empty">No changes yet.</p>'}</section>
      </aside>
    </div>
    <dialog id="key-dialog" class="sheet"><form method="dialog"><h2>Your device key</h2>
      <p>Copy this key now. For your security it won't be shown again.</p>
      <div class="keybox"><code id="key-value"></code><button type="button" class="btn" id="copy-key">Copy</button></div>
      <p style="margin-top:16px">Server address: <code id="key-server"></code></p>
      <p class="muted" id="key-help" style="font-size:var(--step--1)"></p>
      <div class="sheet-actions"><button class="btn primary" value="done">Done</button></div></form></dialog>
    <dialog id="del-dialog" class="sheet"><form method="dialog" id="del-form"><h2>Delete your account?</h2><p>Enter your password to confirm. Everything is removed immediately.</p>
      <label class="field">Password <input type="password" name="password" autocomplete="current-password" required /></label>
      <p class="form-error" role="alert"></p>
      <div class="sheet-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn danger" value="confirm" id="del-confirm">Delete account</button></div></form></dialog>`;

  $('#consent-form').addEventListener('change', async (e) => {
    try { await saveConsents(e.currentTarget); toast('Privacy setting saved'); route(); }
    catch (err) { fail(err); }
  });
  const KIND = { extension: 'Browser extension', desktop: 'Desktop tracker' };
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
        const name = prompt(`Name this ${kind === 'extension' ? 'browser' : 'computer'} so you can recognise it later:`, kind === 'extension' ? 'Chrome on my laptop' : 'My Windows PC');
        if (name === null) return;
        const r = await api('POST', '/devices', { kind, name: name.trim() || undefined });
        $('#key-value').textContent = r.token;
        $('#key-server').textContent = location.origin;
        $('#key-help').textContent = kind === 'extension'
          ? 'Open the Synapse extension, choose Settings, and paste the server address and key.'
          : 'Run the tracker once with "python synapse_tracker.py setup" and paste the server address and key when asked.';
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
  const dlg = $('#del-dialog');
  $('#del-account').addEventListener('click', () => { $('.form-error', dlg).textContent = ''; dlg.showModal(); });
  $('#del-confirm').addEventListener('click', async (e) => {
    e.preventDefault();
    const pw = $('#del-form').elements.password.value;
    try { await api('DELETE', '/account', { password: pw }); dlg.close(); store.del('synapse.timer'); signOut('Your account and data were deleted.'); }
    catch (err) { $('.form-error', dlg).textContent = err.message; }
  });
};

// ---------------------------------------------------------------- boot
$('#logout').addEventListener('click', () => signOut());
setupAuth();
(async () => {
  if (state.token) {
    try { await enterApp(false); return; } catch { store.del('synapse.token'); state.token = null; }
  }
  $('#auth').hidden = false;
})();
