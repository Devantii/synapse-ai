// Database layer: PostgreSQL when DATABASE_URL is set, otherwise a local SQLite file.
//
// Every user-owned table carries user_id and every query filters on the signed-in user, so private
// data stays scoped to its owner.
//
// Queries are written once in portable SQL with `?` placeholders and run through a small async API:
//   await db.get(sql, params)     -> first row or undefined
//   await db.all(sql, params)     -> rows
//   await db.run(sql, params)     -> { changes }
//   await db.insert(sql, params)  -> new row id
//   await db.tx(async (t) => ...) -> runs a transaction; use `t` (same API) inside it
// Timestamps are stored as 'YYYY-MM-DD HH:MM:SS' UTC text in both databases (see db.now()).
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;
const dialect = DATABASE_URL ? 'postgres' : 'sqlite';

const T = dialect === 'postgres'
  ? { ID: 'SERIAL PRIMARY KEY', REAL: 'DOUBLE PRECISION', NOW: "(to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS'))" }
  : { ID: 'INTEGER PRIMARY KEY AUTOINCREMENT', REAL: 'REAL', NOW: "(datetime('now'))" };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            ${T.ID},
  username      TEXT NOT NULL UNIQUE,          -- always stored lowercase
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT ${T.NOW}
);

CREATE TABLE IF NOT EXISTS consents (
  user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  activity_tracking INTEGER NOT NULL DEFAULT 0,
  usage_tracking    INTEGER NOT NULL DEFAULT 0,
  ai_insights       INTEGER NOT NULL DEFAULT 0,
  community_profile INTEGER NOT NULL DEFAULT 1,
  updated_at        TEXT NOT NULL DEFAULT ${T.NOW}
);

-- Append-only log of consent changes (who changed what, when).
CREATE TABLE IF NOT EXISTS consent_log (
  id         ${T.ID},
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field      TEXT NOT NULL,
  value      INTEGER NOT NULL,
  changed_at TEXT NOT NULL DEFAULT ${T.NOW}
);

CREATE TABLE IF NOT EXISTS focus_sessions (
  id           ${T.ID},
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('focus','break')),
  planned_min  INTEGER NOT NULL,
  actual_min   ${T.REAL} NOT NULL,
  completed    INTEGER NOT NULL,
  tag          TEXT,
  day          TEXT NOT NULL,            -- user's local YYYY-MM-DD
  started_at   TEXT NOT NULL,
  ended_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON focus_sessions(user_id, day);

-- Daily usage per app/site. source = 'self' (user entered), 'synapse' (this tab's foreground time),
-- 'extension' (browser extension) or 'desktop' (desktop tracker).
CREATE TABLE IF NOT EXISTS app_usage (
  id       ${T.ID},
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      TEXT NOT NULL,
  app      TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  minutes  ${T.REAL} NOT NULL,
  source   TEXT NOT NULL DEFAULT 'self',
  UNIQUE (user_id, day, app, source)
);
CREATE INDEX IF NOT EXISTS idx_usage_user_day ON app_usage(user_id, day);

-- Daily limits per app or site (the browser extension warns at 80% and pauses sites at 100%).
CREATE TABLE IF NOT EXISTS app_limits (
  id         ${T.ID},
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app        TEXT NOT NULL,
  minutes    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${T.NOW},
  UNIQUE (user_id, app)
);

CREATE TABLE IF NOT EXISTS mood_checkins (
  id         ${T.ID},
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,
  energy     INTEGER NOT NULL CHECK (energy BETWEEN 1 AND 5),
  stress     INTEGER NOT NULL CHECK (stress BETWEEN 1 AND 5),
  sleep_h    ${T.REAL},
  created_at TEXT NOT NULL DEFAULT ${T.NOW},
  UNIQUE (user_id, day)
);

CREATE TABLE IF NOT EXISTS rewards (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  points         INTEGER NOT NULL DEFAULT 0,
  trees          INTEGER NOT NULL DEFAULT 0,
  current_streak INTEGER NOT NULL DEFAULT 0,
  best_streak    INTEGER NOT NULL DEFAULT 0,
  last_focus_day TEXT
);

CREATE TABLE IF NOT EXISTS trees (
  id         ${T.ID},
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  species    TEXT NOT NULL,
  planted_at TEXT NOT NULL DEFAULT ${T.NOW}
);

CREATE TABLE IF NOT EXISTS milestones (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  achieved_at TEXT NOT NULL DEFAULT ${T.NOW},
  PRIMARY KEY (user_id, code)
);

CREATE TABLE IF NOT EXISTS posts (
  id         ${T.ID},
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mood       TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${T.NOW}
);

CREATE TABLE IF NOT EXISTS reactions (
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${T.NOW},
  PRIMARY KEY (post_id, user_id, kind)
);

-- Revocable keys for the browser extension, desktop tracker and Android app. Only a SHA-256 hash is stored.
CREATE TABLE IF NOT EXISTS device_tokens (
  id           ${T.ID},
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('extension','desktop','phone')),
  token_hash   TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT ${T.NOW},
  last_used_at TEXT,
  revoked_at   TEXT
);

-- The running timer, so the browser extension can pause distracting sites during focus blocks.
CREATE TABLE IF NOT EXISTS focus_state (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode       TEXT,               -- 'focus', 'break' or NULL when idle
  ends_at    BIGINT,             -- epoch milliseconds
  updated_at TEXT NOT NULL DEFAULT ${T.NOW}
);

CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_messages (
  id         ${T.ID},
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${T.NOW}
);
CREATE INDEX IF NOT EXISTS idx_room_msgs ON room_messages(room_id, id);
`;

const ROOMS = [
  ['deep-work', 'Deep Work', 'Quiet co-working on camera. Mics off, heads down, 50/10 cycles.'],
  ['study-hall', 'Study Hall', 'Study on camera with students and learners keeping each other accountable.'],
  ['gentle-start', 'Gentle Start', 'Short 15-minute sessions for low-energy days.'],
  ['night-owls', 'Night Owls', 'Late focus sessions with a hard stop before bed.'],
];

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// ------------------------------------------------------------------ SQLite
function sqliteDriver() {
  const Database = require('better-sqlite3');
  const file = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = conn.prepare(sql); cache.set(sql, s); }
    return s;
  };
  // better-sqlite3 is synchronous; a promise chain serialises transactions that span awaits.
  let chain = Promise.resolve();
  const exclusive = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };
  const ops = {
    get: async (sql, p = []) => stmt(sql).get(...p),
    all: async (sql, p = []) => stmt(sql).all(...p),
    run: async (sql, p = []) => ({ changes: stmt(sql).run(...p).changes }),
    insert: async (sql, p = []) => stmt(sql + ' RETURNING id').get(...p).id,
  };
  const locked = Object.fromEntries(Object.entries(ops).map(([k, f]) => [k, (sql, p) => exclusive(() => f(sql, p))]));
  return {
    ...locked,
    tx: (fn) => exclusive(async () => {
      conn.exec('BEGIN');
      try {
        const r = await fn(ops);
        conn.exec('COMMIT');
        return r;
      } catch (e) {
        conn.exec('ROLLBACK');
        throw e;
      }
    }),
    exec: async (sql) => conn.exec(sql),
    close: async () => conn.close(),
    describe: () => `SQLite (${file})`,
  };
}

// ------------------------------------------------------------------ PostgreSQL
function postgresDriver() {
  const pg = require('pg');
  pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // BIGINT/COUNT -> number
  pg.types.setTypeParser(1700, (v) => parseFloat(v)); // NUMERIC -> number
  const ssl = process.env.DATABASE_SSL === 'no-verify' ? { rejectUnauthorized: false } : undefined;
  const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl, max: Number(process.env.DATABASE_POOL_MAX) || 10 });
  pool.on('error', (e) => console.error('[db] idle client error:', e.message));
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => '$' + ++i); };
  const make = (q) => ({
    get: async (sql, p = []) => (await q(toPg(sql), p)).rows[0],
    all: async (sql, p = []) => (await q(toPg(sql), p)).rows,
    run: async (sql, p = []) => ({ changes: (await q(toPg(sql), p)).rowCount }),
    insert: async (sql, p = []) => (await q(toPg(sql + ' RETURNING id'), p)).rows[0].id,
  });
  return {
    ...make((sql, p) => pool.query(sql, p)),
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await fn(make((sql, p) => client.query(sql, p)));
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    exec: async (sql) => pool.query(sql),
    close: () => pool.end(),
    describe: () => {
      try { const u = new URL(DATABASE_URL); return `PostgreSQL (${u.hostname}${u.pathname})`; } catch { return 'PostgreSQL'; }
    },
  };
}

const driver = dialect === 'postgres' ? postgresDriver() : sqliteDriver();

// Upgrades for databases created by older versions. Each step is idempotent.
async function migrate() {
  // v1.3: device_tokens.kind also allows 'phone' (Android app).
  if (dialect === 'postgres') {
    await driver.exec(`ALTER TABLE device_tokens DROP CONSTRAINT IF EXISTS device_tokens_kind_check;
      ALTER TABLE device_tokens ADD CONSTRAINT device_tokens_kind_check CHECK (kind IN ('extension','desktop','phone'))`);
  } else {
    const row = await driver.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'device_tokens'");
    if (row && !row.sql.includes("'phone'")) {
      // SQLite can't alter a CHECK constraint, so rebuild the table with the same rows.
      await driver.tx(async (t) => {
        const newSql = row.sql.replace("CHECK (kind IN ('extension','desktop'))", "CHECK (kind IN ('extension','desktop','phone'))")
          .replace(/CREATE TABLE (IF NOT EXISTS )?"?device_tokens"?/, 'CREATE TABLE device_tokens_v2');
        await t.run(newSql);
        await t.run('INSERT INTO device_tokens_v2 SELECT * FROM device_tokens');
        await t.run('DROP TABLE device_tokens');
        await t.run('ALTER TABLE device_tokens_v2 RENAME TO device_tokens');
      });
    }
  }
}

let readyPromise;
/** Create tables and seed rooms. Safe to call repeatedly. */
function init() {
  readyPromise ??= (async () => {
    await driver.exec(SCHEMA);
    await migrate();
    for (const r of ROOMS) await driver.run('INSERT INTO rooms (id, name, description) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description', r);
  })();
  return readyPromise;
}

/** Test helper: wipe every table. Refuses unless NODE_ENV=test. */
async function resetForTests() {
  if (process.env.NODE_ENV !== 'test') throw new Error('resetForTests is only allowed with NODE_ENV=test');
  if (dialect === 'postgres') await driver.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  readyPromise = null;
  await init();
}

module.exports = {
  dialect,
  // Row lock for read-modify-write inside db.tx (SQLite transactions are already serialised).
  forUpdate: dialect === 'postgres' ? ' FOR UPDATE' : '',
  get: driver.get,
  all: driver.all,
  run: driver.run,
  insert: driver.insert,
  tx: driver.tx,
  close: driver.close,
  describe: driver.describe,
  now,
  init,
  resetForTests,
};
