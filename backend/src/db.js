// SQLite storage. Every user-owned table carries user_id and every query
// in the routes filters on req.user.id, so private data stays scoped to its owner.
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS consents (
  user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  activity_tracking INTEGER NOT NULL DEFAULT 0,
  usage_tracking    INTEGER NOT NULL DEFAULT 0,
  ai_insights       INTEGER NOT NULL DEFAULT 0,
  community_profile INTEGER NOT NULL DEFAULT 1,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only log of consent changes (who changed what, when).
CREATE TABLE IF NOT EXISTS consent_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field      TEXT NOT NULL,
  value      INTEGER NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS focus_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('focus','break')),
  planned_min  INTEGER NOT NULL,
  actual_min   REAL NOT NULL,
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
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      TEXT NOT NULL,
  app      TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  minutes  REAL NOT NULL,
  source   TEXT NOT NULL DEFAULT 'self',
  UNIQUE (user_id, day, app, source)
);
CREATE INDEX IF NOT EXISTS idx_usage_user_day ON app_usage(user_id, day);

CREATE TABLE IF NOT EXISTS mood_checkins (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,
  energy     INTEGER NOT NULL CHECK (energy BETWEEN 1 AND 5),
  stress     INTEGER NOT NULL CHECK (stress BETWEEN 1 AND 5),
  sleep_h    REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
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
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  species    TEXT NOT NULL,
  planted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS milestones (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  achieved_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, code)
);

CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mood       TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reactions (
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (post_id, user_id, kind)
);

-- Revocable keys for the browser extension and desktop tracker. Only a SHA-256 hash is stored.
CREATE TABLE IF NOT EXISTS device_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('extension','desktop')),
  token_hash   TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at   TEXT
);

-- The running timer, so the browser extension can pause distracting sites during focus blocks.
CREATE TABLE IF NOT EXISTS focus_state (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode       TEXT,               -- 'focus', 'break' or NULL when idle
  ends_at    INTEGER,            -- epoch milliseconds
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_room_msgs ON room_messages(room_id, id);
`);

const seedRooms = db.prepare('INSERT OR IGNORE INTO rooms (id, name, description) VALUES (?, ?, ?)');
[
  ['deep-work', 'Deep Work', 'Quiet co-working. Cameras off, heads down, 50/10 cycles.'],
  ['study-hall', 'Study Hall', 'Students and learners keeping each other accountable.'],
  ['gentle-start', 'Gentle Start', 'Short 15-minute sessions for low-energy days.'],
  ['night-owls', 'Night Owls', 'Late focus sessions with a hard stop before bed.'],
].forEach((r) => seedRooms.run(...r));

module.exports = db;
