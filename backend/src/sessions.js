// Shared rules for saving focus sessions and the live timer state, used by the website API and
// the phone's device API, so both validate and reward sessions identically.
const db = require('./db');
const game = require('./gamification');

/** An error whose message is safe to show; route error handlers send it with its status. */
class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

const LOCAL_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function num(v, name, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new InputError(`${name} must be between ${min} and ${max}.`);
  return n;
}

function recentDay(day) {
  if (typeof day !== 'string' || !DAY_RE.test(day) || isNaN(Date.parse(day + 'T00:00:00Z'))) throw new InputError('Invalid day (expected YYYY-MM-DD).');
  const diff = (Date.parse(day + 'T00:00:00Z') - Date.now()) / 86400000;
  if (diff > 1.5) throw new InputError('Day cannot be in the future.');
  if (diff < -2) throw new InputError('Day must be within the last 2 days.');
  return day;
}

/** Validate a session from a request body and save it with its rewards. */
async function record(userId, body) {
  const kind = body.kind === 'break' ? 'break' : body.kind === 'focus' ? 'focus' : null;
  if (!kind) throw new InputError('kind must be "focus" or "break".');
  const plannedMin = num(body.plannedMin, 'plannedMin', 1, 120);
  const actualMin = num(body.actualMin, 'actualMin', 0, plannedMin + 1);
  const completed = body.completed ? 1 : 0;
  if (completed && actualMin < plannedMin - 0.5) throw new InputError('A completed session must run its planned length.');
  const day = recentDay(body.day);
  const startedAt = String(body.startedAt || '');
  const endedAt = String(body.endedAt || '');
  if (!LOCAL_TS.test(startedAt) || !LOCAL_TS.test(endedAt)) throw new InputError('startedAt/endedAt must be local timestamps (YYYY-MM-DDTHH:MM).');
  let tag = null;
  if (body.tag) {
    tag = String(body.tag).trim();
    if (tag.length < 1 || tag.length > 40) throw new InputError('Tag must be 1-40 characters.');
  }
  // Rate guard: you cannot log more focus minutes in a day than exist in it.
  const sum = (await db.get('SELECT COALESCE(SUM(actual_min), 0) AS m FROM focus_sessions WHERE user_id = ? AND day = ?', [userId, day])).m;
  if (sum + actualMin > 24 * 60) throw new InputError('That exceeds the minutes in a day.');
  const session = { kind, planned_min: plannedMin, actual_min: actualMin, completed, tag, day, started_at: startedAt, ended_at: endedAt };
  const result = await game.recordSession(userId, session);
  // A completed focus block linked to a task counts towards it (website and phone).
  if (Number.isInteger(body.taskId) && kind === 'focus' && completed)
    await db.run('UPDATE tasks SET blocks_done = blocks_done + 1 WHERE id = ? AND user_id = ?', [body.taskId, userId]);
  return result;
}

/** Save the running timer (mode 'focus' | 'break' | null) so other devices can react to it. */
async function setFocusState(userId, body) {
  const mode = body.mode === 'focus' || body.mode === 'break' ? body.mode : null;
  let endsAt = null;
  if (mode) {
    endsAt = Number(body.endsAt);
    const now = Date.now();
    if (!Number.isFinite(endsAt) || endsAt < now - 60000 || endsAt > now + 125 * 60000) throw new InputError('endsAt must be within the next 2 hours.');
    endsAt = Math.round(endsAt);
  }
  await db.run(
    `INSERT INTO focus_state (user_id, mode, ends_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET mode = excluded.mode, ends_at = excluded.ends_at, updated_at = excluded.updated_at`,
    [userId, mode, endsAt, db.now()]
  );
}

async function getFocusState(userId) {
  const row = await db.get('SELECT mode, ends_at FROM focus_state WHERE user_id = ?', [userId]);
  const live = !!row && row.ends_at > Date.now();
  return { focusing: live && row.mode === 'focus', mode: live ? row.mode : null, endsAt: live ? row.ends_at : null };
}

module.exports = { record, setFocusState, getFocusState, InputError };
