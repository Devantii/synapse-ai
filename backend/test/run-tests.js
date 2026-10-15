// End-to-end API + realtime tests against a throwaway database.
// Run: npm test                      (SQLite in a temp folder)
//      TEST_DATABASE_URL=postgres://... npm test   (a Postgres database that will be WIPED)
// Tests never read DATABASE_URL, so your real database in .env is never touched.
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-test-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';
// An empty string (not undefined) stops dotenv from filling DATABASE_URL in from .env.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || '';
process.env.OPENAI_API_KEY = '';
process.env.LIVEKIT_URL = '';

const { server, ready, db } = require('../src/server');
const { io: ioc } = require('socket.io-client');

let base;
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ', name); }
  catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }
async function api(method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const localDay = (offset = 0) => { const d = new Date(Date.now() + offset * 86400000); return d.toISOString().slice(0, 10); };
const ts = (day, hh) => `${day}T${hh}:00`;

(async () => {
  await ready;
  await db.resetForTests();
  console.log(`Database: ${db.describe()}`);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  const today = localDay();
  let A, B, postId;

  console.log('Auth');
  await test('register validates password length', async () => {
    const r = await api('POST', '/api/auth/register', { username: 'alice', password: 'short' });
    assert(r.status === 400, 'expected 400, got ' + r.status);
  });
  await test('register + login', async () => {
    let r = await api('POST', '/api/auth/register', { username: 'alice', displayName: 'Alice', password: 'correct-horse' });
    assert(r.status === 201 && r.data.token, 'register failed');
    r = await api('POST', '/api/auth/login', { username: 'ALICE', password: 'correct-horse' });
    assert(r.status === 200, 'login failed'); A = r.data.token;
    r = await api('POST', '/api/auth/register', { username: 'bob', displayName: 'Bob', password: 'battery-staple' });
    B = r.data.token;
  });
  await test('duplicate username rejected', async () => {
    const r = await api('POST', '/api/auth/register', { username: 'Alice', password: 'whatever123' });
    assert(r.status === 409);
  });
  await test('wrong password rejected', async () => {
    const r = await api('POST', '/api/auth/login', { username: 'alice', password: 'nope-nope' });
    assert(r.status === 401);
  });
  await test('protected routes need a token', async () => {
    assert((await api('GET', '/api/me')).status === 401);
    assert((await api('GET', '/api/me', null, 'garbage')).status === 401);
  });

  console.log('Sign in with Google');
  const google = require('../src/google');
  // Stand-in for Google's token check: "gtest|<sub>|<email>|<name>" (real tokens are verified with Google's keys).
  google._setVerifier(async (t) => {
    const [tag, sub, email, name] = t.split('|');
    if (tag !== 'gtest-credential-xxxxxxxx') throw new Error('bad token');
    return { sub, email, emailVerified: true, name };
  });
  const gcred = (sub, email, name) => `gtest-credential-xxxxxxxx|${sub}|${email}|${name}`;
  let G;
  await test('auth config advertises Google', async () => {
    const r = await api('GET', '/api/auth/config');
    assert(r.status === 200 && 'googleClientId' in r.data);
  });
  await test('first Google sign-in creates an account', async () => {
    const r = await api('POST', '/api/auth/google', { credential: gcred('g-111', 'Priya.S@gmail.com', 'Priya Sharma') });
    assert(r.status === 201 && r.data.created === true && r.data.token, JSON.stringify(r.data));
    assert(r.data.user.username === 'priya.s' && r.data.user.displayName === 'Priya Sharma', JSON.stringify(r.data.user));
    G = r.data.token;
    const me = await api('GET', '/api/me', null, G);
    assert(me.data.user.google === true && me.data.user.hasPassword === false && me.data.user.email === 'Priya.S@gmail.com');
  });
  await test('second Google sign-in returns the same account', async () => {
    const r = await api('POST', '/api/auth/google', { credential: gcred('g-111', 'Priya.S@gmail.com', 'Priya Sharma') });
    assert(r.status === 200 && r.data.created === false && r.data.user.username === 'priya.s');
  });
  await test('a different Google user with the same email name gets a free username', async () => {
    const r = await api('POST', '/api/auth/google', { credential: gcred('g-222', 'priya.s@outlook.com', 'Priya S') });
    assert(r.status === 201 && r.data.user.username === 'priya.s2', JSON.stringify(r.data.user));
  });
  await test('bad Google credential rejected', async () => {
    const r = await api('POST', '/api/auth/google', { credential: 'not-a-real-google-credential-token' });
    assert(r.status === 400, 'got ' + r.status);
  });
  await test('Google-only account cannot use password login', async () => {
    const r = await api('POST', '/api/auth/login', { username: 'priya.s', password: '!' });
    assert(r.status === 401 && /Google/.test(r.data.error), JSON.stringify(r.data));
  });
  await test('link Google to a password account, then sign in with Google', async () => {
    let r = await api('POST', '/api/account/google', { credential: gcred('g-alice', 'alice@gmail.com', 'Alice') }, A);
    assert(r.status === 200, JSON.stringify(r.data));
    r = await api('POST', '/api/auth/google', { credential: gcred('g-alice', 'alice@gmail.com', 'Alice') });
    assert(r.status === 200 && r.data.user.username === 'alice');
    r = await api('POST', '/api/account/google', { credential: gcred('g-111', 'x@gmail.com', 'X') }, A);
    assert(r.status === 409, 'Google account used elsewhere must be refused');
    r = await api('DELETE', '/api/account/google', null, A);
    assert(r.status === 200);
    r = await api('POST', '/api/auth/google', { credential: gcred('g-alice', 'alice@gmail.com', 'Alice') });
    assert(r.status === 201 && r.data.user.username !== 'alice', 'unlinked: a new account, not Alice');
  });
  await test("Google-only account can't unlink Google, and deletes by typing its username", async () => {
    assert((await api('DELETE', '/api/account/google', null, G)).status === 400);
    assert((await api('DELETE', '/api/account', { confirm: 'wrong' }, G)).status === 400);
    const r = await api('DELETE', '/api/account', { confirm: 'Priya.S' }, G);
    assert(r.status === 200, JSON.stringify(r.data));
    assert((await api('GET', '/api/me', null, G)).status === 401);
  });

  console.log('Consent gates');
  await test('session save blocked until consent', async () => {
    const r = await api('POST', '/api/sessions', { kind: 'focus', plannedMin: 25, actualMin: 25, completed: true, day: today, startedAt: ts(today, '09:00'), endedAt: ts(today, '09:25') }, A);
    assert(r.status === 403 && r.data.consentRequired === 'activity_tracking');
  });
  await test('consent update is logged', async () => {
    const r = await api('PUT', '/api/consents', { activity_tracking: true, usage_tracking: true, ai_insights: true }, A);
    assert(r.data.activity_tracking === 1 && r.data.ai_insights === 1);
    const log = await api('GET', '/api/consents/log', null, A);
    assert(log.data.length === 3, 'expected 3 log rows');
  });

  console.log('Focus + gamification');
  await test('completed focus earns points, a tree and milestone', async () => {
    const r = await api('POST', '/api/sessions', { kind: 'focus', plannedMin: 25, actualMin: 25, completed: true, tag: 'Thesis', day: today, startedAt: ts(today, '09:00'), endedAt: ts(today, '09:25') }, A);
    assert(r.status === 201, JSON.stringify(r.data));
    assert(r.data.earned === 35, 'earned ' + r.data.earned);
    assert(r.data.tree && r.data.tree.species === 'sapling');
    assert(r.data.newMilestones.some((m) => m.code === 'first_focus'));
    assert(r.data.rewards.currentStreak === 1);
  });
  await test('break earns points', async () => {
    const r = await api('POST', '/api/sessions', { kind: 'break', plannedMin: 5, actualMin: 5, completed: true, day: today, startedAt: ts(today, '09:25'), endedAt: ts(today, '09:30') }, A);
    assert(r.data.earned === 5 && r.data.newMilestones.some((m) => m.code === 'first_break'));
  });
  await test('abandoned session: partial points, no tree', async () => {
    const r = await api('POST', '/api/sessions', { kind: 'focus', plannedMin: 50, actualMin: 12, completed: false, day: today, startedAt: ts(today, '23:00'), endedAt: ts(today, '23:12') }, A);
    assert(r.data.earned === 6 && !r.data.tree);
  });
  await test('cannot claim completion without the time', async () => {
    const r = await api('POST', '/api/sessions', { kind: 'focus', plannedMin: 50, actualMin: 10, completed: true, day: today, startedAt: ts(today, '10:00'), endedAt: ts(today, '10:10') }, A);
    assert(r.status === 400);
  });
  await test('rewards summary', async () => {
    const r = await api('GET', '/api/rewards', null, A);
    assert(r.data.points === 46 && r.data.trees === 1 && r.data.garden.length === 1, JSON.stringify(r.data).slice(0, 200));
  });

  console.log('Screen time');
  await test('save self-reported usage + daily totals', async () => {
    let r = await api('PUT', '/api/usage', { day: today, entries: [
      { app: 'Instagram', category: 'social', minutes: 180 },
      { app: 'YouTube', category: 'entertainment', minutes: 150 },
      { app: 'VS Code', category: 'work', minutes: 240 },
    ] }, A);
    assert(r.status === 200, JSON.stringify(r.data));
    r = await api('POST', '/api/usage/foreground', { day: today, minutes: 2.5 }, A);
    assert(r.status === 200);
    r = await api('GET', '/api/usage?days=7', null, A);
    const d = r.data.daily.find((x) => x.day === today);
    assert(d && Math.abs(d.total - 572.5) < 0.01, 'total ' + d?.total);
  });
  await test('usage cannot exceed 24h', async () => {
    const r = await api('PUT', '/api/usage', { day: today, entries: [{ app: 'Netflix', category: 'entertainment', minutes: 1000 }] }, A);
    assert(r.status === 400);
  });
  await test('usage is private to its owner', async () => {
    const r = await api('GET', '/api/usage?days=7', null, B);
    assert(r.data.entries.length === 0);
    const mine = await api('GET', '/api/usage?days=7', null, A);
    const del = await api('DELETE', '/api/usage/' + mine.data.entries[0].id, null, B);
    assert(del.status === 404, 'bob deleted alice data!');
  });

  console.log('Insights + coach');
  await test('mood check-in', async () => {
    const r = await api('PUT', '/api/checkins', { day: today, energy: 2, stress: 4, sleepHours: 5.5 }, A);
    assert(r.status === 200);
  });
  await test('insights are explainable', async () => {
    const r = await api('GET', '/api/insights?day=' + today, null, A);
    assert(r.status === 200, JSON.stringify(r.data));
    assert(typeof r.data.score === 'number' && r.data.ml.factors.length > 0 && r.data.fuzzy.firedRules.length > 0);
    assert(r.data.recommendations.every((x) => x.because));
    assert(r.data.disclaimer);
  });
  await test('insights need consent', async () => {
    assert((await api('GET', '/api/insights', null, B)).status === 403);
  });
  await test('coach demo reply without API key', async () => {
    const r = await api('POST', '/api/coach', { message: 'I feel burnt out', day: today }, A);
    assert(r.data.source === 'demo' && r.data.text.length > 20);
  });
  await test('coach safety reply', async () => {
    const r = await api('POST', '/api/coach', { message: 'I want to end my life', day: today }, A);
    assert(r.data.source === 'safety');
  });

  console.log('Community');
  await test('post, react (toggle), delete own only', async () => {
    let r = await api('POST', '/api/posts', { mood: 'proud', body: 'Finished 3 sessions without doomscrolling!' }, A);
    assert(r.status === 201); postId = r.data.id;
    r = await api('POST', `/api/posts/${postId}/react`, { kind: 'cheer' }, B);
    assert(r.data.active === true);
    r = await api('GET', '/api/posts', null, A);
    assert(r.data.posts[0].reactions.cheer.count === 1 && r.data.posts[0].isMine);
    r = await api('POST', `/api/posts/${postId}/react`, { kind: 'cheer' }, B);
    assert(r.data.active === false);
    r = await api('DELETE', `/api/posts/${postId}`, null, B);
    assert(r.status === 404, 'bob deleted alice post!');
  });
  await test('anonymous community profile hides name', async () => {
    await api('PUT', '/api/consents', { community_profile: false }, A);
    const r = await api('GET', '/api/posts', null, B);
    assert(r.data.posts[0].author === 'Anonymous member');
    await api('PUT', '/api/consents', { community_profile: true }, A);
  });

  console.log('Realtime rooms');
  await test('presence, chat persistence and signaling relay', async () => {
    const connect = (token) => new Promise((res, rej) => {
      const s = ioc(base, { auth: { token }, transports: ['websocket'] });
      s.on('connect', () => res(s)); s.on('connect_error', rej);
    });
    const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
    const sa = await connect(A), sb = await connect(B);
    await emit(sa, 'room:join', { roomId: 'deep-work' });
    const presence = new Promise((r) => sa.on('room:presence', (m) => m.length === 2 && r(m)));
    await emit(sb, 'room:join', { roomId: 'deep-work' });
    assert((await presence).length === 2);
    const got = new Promise((r) => sb.on('room:message', r));
    assert((await emit(sa, 'room:message', { body: 'Starting a 50 min block' })).ok);
    assert((await got).body === 'Starting a 50 min block');
    const hist = await api('GET', '/api/rooms/deep-work/messages', null, B);
    assert(hist.data.length === 1);
    // reply to a chat message
    const firstId = hist.data[0].id;
    const gotReply = new Promise((r) => sa.on('room:message', (m) => m.reply && r(m)));
    assert((await emit(sb, 'room:message', { body: 'Same, good luck!', replyTo: firstId })).ok);
    const rm = await gotReply;
    assert(rm.reply.id === firstId && rm.reply.body === 'Starting a 50 min block', JSON.stringify(rm));
    assert((await emit(sb, 'room:message', { body: 'x', replyTo: 999999 })).error, 'reply to a missing message must fail');
    const hist2 = await api('GET', '/api/rooms/deep-work/messages', null, A);
    assert(hist2.data.length === 2 && hist2.data[1].reply.author && hist2.data[0].reply === null, JSON.stringify(hist2.data));
    const rooms = await api('GET', '/api/rooms', null, A);
    assert(rooms.data.find((r) => r.id === 'deep-work').members.length === 2);
    // audio signaling
    const ja = await emit(sa, 'audio:join');
    const pres = new Promise((r) => sa.on('room:presence', (m) => { const b = m.find((x) => x.socketId === sb.id); if (b?.audio) r(b); }));
    const jb = await emit(sb, 'audio:join', { video: true, muted: true });
    assert(ja.ok && jb.peers.length === 1 && jb.peers[0].socketId === sa.id);
    const bp = await pres;
    assert(bp.video === true && bp.muted === true, 'camera on, mic off by default: ' + JSON.stringify(bp));
    const camOff = new Promise((r) => sa.on('room:presence', (m) => { const b = m.find((x) => x.socketId === sb.id); if (b && !b.video) r(b); }));
    sb.emit('audio:mute', { video: false });
    assert((await camOff).muted === true, 'turning the camera off keeps mic state');
    const sig = new Promise((r) => sa.on('rtc:signal', r));
    sb.emit('rtc:signal', { to: sa.id, data: { type: 'offer', sdp: 'v=0' } });
    assert((await sig).from === sb.id);
    const unauth = await new Promise((r) => { const s = ioc(base, { auth: { token: 'bad' }, transports: ['websocket'] }); s.on('connect_error', () => { s.close(); r(true); }); s.on('connect', () => { s.close(); r(false); }); });
    assert(unauth, 'unauthenticated socket connected');
    sa.close(); sb.close();
  });

  console.log('Connected devices');
  let devToken, devId;
  const devApi = (method, url, body, token) => api(method, url, body, token);
  await test('create device key (shown once)', async () => {
    const r = await api('POST', '/api/devices', { kind: 'extension', name: 'Chrome on laptop' }, A);
    assert(r.status === 201 && r.data.token.startsWith('syn_'), JSON.stringify(r.data));
    devToken = r.data.token; devId = r.data.id;
    const l = await api('GET', '/api/devices', null, A);
    assert(l.data.length === 1 && !('token' in l.data[0]) && l.data[0].prefix === devToken.slice(0, 10));
  });
  await test('device key cannot use session API', async () => {
    assert((await api('GET', '/api/me', null, devToken)).status === 401);
  });
  await test('session token cannot use device API', async () => {
    assert((await api('GET', '/api/device/ping', null, A)).status === 401);
  });
  await test('device ping + CORS preflight', async () => {
    const r = await devApi('GET', '/api/device/ping', null, devToken);
    assert(r.data.ok && r.data.usageConsent === true && r.data.kind === 'extension');
    const pre = await fetch(base + '/api/device/usage', { method: 'OPTIONS', headers: { Origin: 'chrome-extension://abc', 'Access-Control-Request-Method': 'PUT' } });
    assert(pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*');
  });
  await test('device usage sync + overlap counted once', async () => {
    let r = await devApi('PUT', '/api/device/usage', { days: [{ day: today, entries: [
      { app: 'instagram.com', category: 'social', minutes: 200 }, { app: 'docs.google.com', category: 'work', minutes: 30 }] }] }, devToken);
    assert(r.status === 200 && r.data.entries === 2, JSON.stringify(r.data));
    r = await api('GET', '/api/usage?days=1', null, A);
    const d = r.data.daily[0];
    // VS Code 240 + YouTube 150 + instagram max(180 self, 200 ext) + docs 30 + Synapse 2.5
    assert(Math.abs(d.total - 622.5) < 0.01, 'total ' + d.total);
    const self = r.data.entries.find((e) => e.app === 'Instagram');
    assert(self.counted === false, 'typed Instagram should be overshadowed');
  });
  await test('re-sync replaces, never double counts', async () => {
    await devApi('PUT', '/api/device/usage', { days: [{ day: today, entries: [
      { app: 'instagram.com', category: 'social', minutes: 210 }, { app: 'docs.google.com', category: 'work', minutes: 30 }] }] }, devToken);
    const r = await api('GET', '/api/usage?days=1', null, A);
    assert(Math.abs(r.data.daily[0].total - 632.5) < 0.01, 'total ' + r.data.daily[0].total);
    assert(r.data.entries.filter((e) => e.source === 'extension').length === 2);
  });
  await test('device sync validates input', async () => {
    assert((await devApi('PUT', '/api/device/usage', { days: [{ day: '2001-01-01', entries: [] }] }, devToken)).status === 400);
    assert((await devApi('PUT', '/api/device/usage', { days: [{ day: today, entries: [{ app: 'x', minutes: 2000 }] }] }, devToken)).status === 400);
  });
  await test('device sync needs consent', async () => {
    const r = await api('POST', '/api/devices', { kind: 'desktop' }, B);
    const s2 = await devApi('PUT', '/api/device/usage', { days: [{ day: today, entries: [{ app: 'Code.exe', minutes: 5 }] }] }, r.data.token);
    assert(s2.status === 403 && s2.data.consentRequired === 'usage_tracking');
  });
  await test('revoked key stops working', async () => {
    const r2 = await api('POST', '/api/devices', { kind: 'desktop', name: 'Old PC' }, A);
    assert((await api('DELETE', '/api/devices/' + r2.data.id, null, B)).status === 404, 'bob revoked alice key');
    assert((await api('DELETE', '/api/devices/' + r2.data.id, null, A)).status === 200);
    assert((await devApi('GET', '/api/device/ping', null, r2.data.token)).status === 401);
  });
  await test('focus state drives device focus endpoint', async () => {
    let f = await api('GET', '/api/device/focus', null, devToken);
    assert(f.data.focusing === false);
    const endsAt = Date.now() + 25 * 60000;
    assert((await api('PUT', '/api/focus/state', { mode: 'focus', endsAt }, A)).status === 200);
    f = await api('GET', '/api/device/focus', null, devToken);
    assert(f.data.focusing === true && f.data.endsAt === endsAt);
    await api('PUT', '/api/focus/state', { mode: 'break', endsAt }, A);
    assert((await api('GET', '/api/device/focus', null, devToken)).data.focusing === false, 'break is not focus');
    await api('PUT', '/api/focus/state', { mode: null }, A);
    assert((await api('GET', '/api/device/focus', null, devToken)).data.focusing === false);
    assert((await api('PUT', '/api/focus/state', { mode: 'focus', endsAt: Date.now() + 10 * 3600000 }, A)).status === 400);
  });
  await test('phone key: Android usage adds to computer time', async () => {
    const k = await api('POST', '/api/devices', { kind: 'phone', name: 'Pixel 8' }, A);
    assert(k.status === 201, JSON.stringify(k.data));
    const r = await api('PUT', '/api/device/usage', { days: [{ day: today, entries: [{ app: 'Instagram', category: 'social', minutes: 40 }] }] }, k.data.token);
    assert(r.status === 200, JSON.stringify(r.data));
    const u = await api('GET', '/api/usage?days=1', null, A);
    const insta = u.data.entries.filter((e) => /instagram/i.test(e.app));
    // typed 180 < extension 210 + phone 40, so extension and phone both count (250)
    assert(insta.find((e) => e.source === 'phone').counted && insta.find((e) => e.source === 'extension').counted, JSON.stringify(insta));
    assert(insta.find((e) => e.source === 'phone').sourceLabel === 'Android phone');
    await api('DELETE', '/api/devices/' + k.data.id, null, A);
    await api('DELETE', '/api/usage/' + insta.find((e) => e.source === 'phone').id, null, A);
  });
  await test('phone focus timer: focus state, sessions with rewards, summary', async () => {
    const k = (await api('POST', '/api/devices', { kind: 'phone', name: 'Focus phone' }, A)).data;
    const endsAt = Date.now() + 25 * 60000;
    assert((await api('PUT', '/api/device/focus', { mode: 'focus', endsAt }, k.token)).status === 200);
    const f = await api('GET', '/api/device/focus', null, devToken); // the browser extension sees the phone's block
    assert(f.data.focusing === true && f.data.endsAt === endsAt, JSON.stringify(f.data));
    assert((await api('PUT', '/api/device/focus', { mode: null }, k.token)).status === 200);
    const before = (await api('GET', '/api/device/summary', null, k.token)).data;
    const r = await api('POST', '/api/device/sessions', { kind: 'focus', plannedMin: 25, actualMin: 25, completed: true, tag: 'Phone block',
      day: today, startedAt: ts(today, '14:00'), endedAt: ts(today, '14:25') }, k.token);
    assert(r.status === 201 && r.data.earned === 35 && r.data.tree, JSON.stringify(r.data));
    assert(r.data.rewards.points === before.points + 35, 'points added');
    const bad = await api('POST', '/api/device/sessions', { kind: 'focus', plannedMin: 50, actualMin: 3, completed: true, day: today, startedAt: ts(today, '15:00'), endedAt: ts(today, '15:03') }, k.token);
    assert(bad.status === 400 && /planned length/.test(bad.data.error), 'validation shared with website');
    // only phone keys may do this
    assert((await api('PUT', '/api/device/focus', { mode: null }, devToken)).status === 403);
    assert((await api('POST', '/api/device/sessions', {}, devToken)).status === 403);
    assert((await api('GET', '/api/device/summary', null, devToken)).status === 403);
    // consent still applies
    const kb = (await api('POST', '/api/devices', { kind: 'phone' }, B)).data;
    const nb = await api('POST', '/api/device/sessions', { kind: 'break', plannedMin: 5, actualMin: 5, completed: true, day: today, startedAt: ts(today, '10:00'), endedAt: ts(today, '10:05') }, kb.token);
    assert(nb.status === 403 && nb.data.consentRequired === 'activity_tracking');
    await api('DELETE', '/api/devices/' + k.id, null, A);
    await api('DELETE', '/api/devices/' + kb.id, null, B);
  });
  await test('voice endpoint falls back to mesh without LiveKit', async () => {
    const r = await api('GET', '/api/rooms/deep-work/voice', null, A);
    assert(r.data.mode === 'mesh');
  });

  console.log('Progress');
  await test('stats summarise sessions, hours, lengths and weeks', async () => {
    const r = await api('GET', '/api/stats?days=30&today=' + today, null, A);
    assert(r.status === 200, JSON.stringify(r.data));
    const d = r.data;
    // includes the 25-min block saved by the phone test above
    assert(d.totals.sessions === 2 && d.totals.focusMinutes === 50 && d.totals.breaks === 1, JSON.stringify(d.totals));
    assert(Math.abs(d.totals.completionRate - 2 / 3) < 1e-9, 'two finished, one abandoned');
    assert(d.daily[today] === 50 && d.hours[9].minutes === 25 && d.hours[14].minutes === 25 && d.hours[23].minutes === 0, 'hour of day uses local start time');
    assert(d.weeks.length === 8 && d.weeks[7].focus === 50 && d.weeks[7].screen > 0, JSON.stringify(d.weeks[7]));
    assert(d.lengths.find((l) => l.planned === 25).completed === 2 && d.lengths.find((l) => l.planned === 50).completed === 0);
    assert(d.tags.length === 2 && d.tags.every((t) => t.minutes === 25) && d.tags.some((t) => t.tag === 'Thesis'));
    const other = await api('GET', '/api/stats', null, B);
    assert(other.data.totals.sessions === 0, 'stats are private');
  });

  console.log('Daily limits');
  await test('set, update, list with today\'s usage, delete', async () => {
    // instagram.com 210 (extension) overshadows typed Instagram 180, see overlap rule
    let r = await api('PUT', '/api/limits', { app: 'https://www.instagram.com/feed', minutes: 240 }, A);
    assert(r.status === 200 && r.data.app === 'instagram.com', JSON.stringify(r.data));
    await api('PUT', '/api/limits', { app: 'instagram.com', minutes: 300 }, A); // update, not duplicate
    await api('PUT', '/api/limits', { app: 'YouTube', minutes: 60 }, A);
    r = await api('GET', '/api/limits?day=' + today, null, A);
    const insta = r.data.limits.find((l) => l.app === 'instagram.com');
    const yt = r.data.limits.find((l) => l.app === 'YouTube');
    assert(r.data.limits.length === 2 && insta.minutes === 300, JSON.stringify(r.data));
    assert(insta.used === 210 && yt.used === 150 && yt.ratio === 2.5, JSON.stringify(r.data.limits));
    const dev = await api('GET', '/api/device/limits', null, devToken);
    assert(dev.data.limits.length === 2 && dev.data.limits.every((l) => l.app && l.minutes), 'device sees limits');
    assert((await api('PUT', '/api/limits', { app: 'x', minutes: 1 }, A)).status === 400, 'min 5 minutes');
    assert((await api('DELETE', '/api/limits/' + yt.id, null, B)).status === 404, 'bob deleted alice limit');
    assert((await api('DELETE', '/api/limits/' + yt.id, null, A)).status === 200);
    assert((await api('GET', '/api/limits', null, B)).data.limits.length === 0, 'limits are private');
  });

  console.log('Replies + sample data');
  await test('reply to a community check-in', async () => {
    const p = await api('POST', '/api/posts', { mood: 'tired', body: 'Long day, short focus.' }, A);
    let r = await api('POST', `/api/posts/${p.data.id}/replies`, { body: 'You still showed up. That counts.' }, B);
    assert(r.status === 201 && r.data.replies.length === 1 && r.data.replies[0].isMine, JSON.stringify(r.data));
    const feed = await api('GET', '/api/posts', null, A);
    const post = feed.data.posts.find((x) => x.id === p.data.id);
    assert(post.replies.length === 1 && post.replies[0].author && !post.replies[0].isMine);
    assert((await api('DELETE', `/api/posts/${p.data.id}/replies/${r.data.id}`, null, A)).status === 404, 'only the author can delete a reply');
    assert((await api('DELETE', `/api/posts/${p.data.id}/replies/${r.data.id}`, null, B)).status === 200);
    assert((await api('POST', '/api/posts/999999/replies', { body: 'hi' }, B)).status === 404);
  });
  await test('sample data fills Insights and removes cleanly', async () => {
    const reg = await api('POST', '/api/auth/register', { username: 'sampler', password: 'sample-pass-1' });
    const S = reg.data.token;
    await api('PUT', '/api/consents', { activity_tracking: true, usage_tracking: true, ai_insights: true }, S);
    const today = new Date().toISOString().slice(0, 10);
    const before = await api('GET', `/api/insights?day=${today}`, null, S);
    assert(before.data.daysWithData === 0);
    await api('PUT', '/api/checkins', { day: today, energy: 4, stress: 2, sleepHours: 8 }, S); // a real check-in
    const add = await api('POST', '/api/sample-data', { today }, S);
    assert(add.status === 201 && add.data.sessions > 20, JSON.stringify(add.data));
    assert((await api('GET', '/api/me', null, S)).data.hasSampleData === true);
    const ins = await api('GET', `/api/insights?day=${today}`, null, S);
    assert(ins.data.daysWithData >= 5 && ins.data.confidence === 'good' && ins.data.ml.factors.length > 0, JSON.stringify(ins.data.counts));
    const stats = await api('GET', '/api/stats', null, S);
    assert(stats.status === 200);
    assert((await api('DELETE', '/api/sample-data', null, S)).status === 200);
    const after = await api('GET', `/api/insights?day=${today}`, null, S);
    assert(after.data.daysWithData === 0 && after.data.counts.focusSessions === 0, JSON.stringify(after.data.counts));
    const ch = await api('GET', '/api/checkins', null, S);
    assert(ch.data.length === 1 && ch.data[0].energy === 4, 'real check-in kept');
    assert((await api('GET', '/api/me', null, S)).data.hasSampleData === false);
  });

  console.log('Export + deletion');
  await test('export contains only own data', async () => {
    const r = await api('GET', '/api/export', null, A);
    assert(r.data.account.username === 'alice' && r.data.focusSessions.length === 4 && r.data.appUsage.length === 6 && r.data.connectedDevices.length === 4 && r.data.dailyLimits.length === 1);
    const rb = await api('GET', '/api/export', null, B);
    assert(rb.data.focusSessions.length === 0 && rb.data.communityPosts.length === 0);
  });
  await test('delete usage scope', async () => {
    await api('DELETE', '/api/data', { scope: 'usage' }, A);
    const r = await api('GET', '/api/usage', null, A);
    assert(r.data.entries.length === 0);
    const s = await api('GET', '/api/sessions', null, A);
    assert(s.data.length === 4, 'sessions should remain');
  });
  await test('delete account requires password and cascades', async () => {
    assert((await api('DELETE', '/api/account', { password: 'wrong' }, A)).status === 401);
    assert((await api('DELETE', '/api/account', { password: 'correct-horse' }, A)).status === 200);
    assert((await api('GET', '/api/me', null, A)).status === 401);
    const posts = await api('GET', '/api/posts', null, B);
    assert(posts.data.posts.length === 0, 'posts should cascade');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
