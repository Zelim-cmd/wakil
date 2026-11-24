// База данных — один файл data/wakil.db (SQLite, встроен в Node, ничего ставить не нужно).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL,              -- waqr | wacloud | instagram | test
  chat_id TEXT NOT NULL,
  name TEXT DEFAULT '', phone TEXT DEFAULT '', username TEXT DEFAULT '', lang TEXT DEFAULT '',
  created_at INTEGER NOT NULL, last_at INTEGER, last_in_at INTEGER, last_out_at INTEGER,
  stage TEXT DEFAULT 'new',           -- new | consulting | offer | deciding | booking | paid | lost
  mode TEXT DEFAULT 'bot',            -- bot | owner (в этом чате бот выключен)
  paused_until INTEGER DEFAULT 0,     -- владелец ответил сам — бот молчит до этого времени
  attention INTEGER DEFAULT 0, attention_reason TEXT DEFAULT '',
  facts TEXT DEFAULT '{}', summary TEXT DEFAULT '', notes TEXT DEFAULT '', lost_reason TEXT DEFAULT '',
  fallback_at INTEGER DEFAULT 0,
  UNIQUE(channel, chat_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL,
  dir TEXT NOT NULL,                  -- in | out
  author TEXT NOT NULL,               -- client | bot | owner | system
  text TEXT DEFAULT '',
  media_kind TEXT DEFAULT '', media_path TEXT DEFAULT '',
  at INTEGER NOT NULL,
  ext_id TEXT,
  corrected TEXT DEFAULT '',          -- как надо было ответить (исправление владельца)
  UNIQUE(contact_id, ext_id)
);
CREATE INDEX IF NOT EXISTS messages_contact ON messages(contact_id, at);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  status TEXT DEFAULT 'open',         -- open | booked | lost | closed
  city TEXT DEFAULT '', hotels TEXT DEFAULT '[]',
  check_in TEXT DEFAULT '', check_out TEXT DEFAULT '', nights INTEGER, guests INTEGER, rooms INTEGER,
  room_type TEXT DEFAULT '', meals TEXT DEFAULT '', budget REAL, currency TEXT DEFAULT '', trip_type TEXT DEFAULT '',
  notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS interests (
  id INTEGER PRIMARY KEY, contact_id INTEGER NOT NULL, hotel TEXT NOT NULL, city TEXT DEFAULT '', at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stage_log (
  id INTEGER PRIMARY KEY, contact_id INTEGER NOT NULL, stage TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hotels (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, city TEXT DEFAULT '', stars INTEGER, distance TEXT DEFAULT '', area TEXT DEFAULT '',
  description TEXT DEFAULT '', prices TEXT DEFAULT '', prices_until TEXT DEFAULT '',
  private_note TEXT DEFAULT '', active INTEGER DEFAULT 1, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER, hotel TEXT DEFAULT '', city TEXT DEFAULT '',
  check_in TEXT DEFAULT '', check_out TEXT DEFAULT '', nights INTEGER, guests INTEGER, rooms INTEGER, room_type TEXT DEFAULT '',
  total REAL DEFAULT 0, currency TEXT DEFAULT '', commission REAL DEFAULT 0,
  status TEXT DEFAULT 'pending',      -- pending | confirmed | completed | cancelled
  created_at INTEGER NOT NULL, note TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER, contact_id INTEGER,
  amount REAL DEFAULT 0, currency TEXT DEFAULT '', method TEXT DEFAULT '',
  at INTEGER NOT NULL,
  status TEXT DEFAULT 'claimed',      -- claimed (клиент сказал, что оплатил) | confirmed | rejected
  note TEXT DEFAULT '', media_path TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY,
  kind TEXT DEFAULT 'rule',           -- rule | example | faq
  text TEXT NOT NULL, why TEXT DEFAULT '',
  source TEXT DEFAULT 'owner',        -- owner | correction | review | teach
  status TEXT DEFAULT 'active',       -- active | proposed | rejected
  created_at INTEGER NOT NULL, contact_id INTEGER
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY, contact_id INTEGER, text TEXT NOT NULL, at INTEGER NOT NULL,
  status TEXT DEFAULT 'open', answer TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, contact_id INTEGER, data TEXT DEFAULT '{}', seen INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_at ON events(at);
CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, purpose TEXT, provider TEXT, model TEXT, ms INTEGER, ok INTEGER, error TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}
export function closeDb() { if (db) { db.close(); db = null; } }

const norm = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
export const get = (sql, ...p) => db.prepare(sql).get(...norm(p));
export const all = (sql, ...p) => db.prepare(sql).all(...norm(p));
export const run = (sql, ...p) => db.prepare(sql).run(...norm(p));
export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** Вставить строку из объекта; возвращает id. */
export function insert(table, obj) {
  const keys = Object.keys(obj);
  const r = run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => obj[k]));
  return Number(r.lastInsertRowid);
}
/** Обновить строку по id только указанными полями. */
export function update(table, id, obj) {
  const keys = Object.keys(obj);
  if (!keys.length) return;
  run(`UPDATE ${table} SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`, ...keys.map((k) => obj[k]), id);
}

export function kvGet(key, def = null) { const r = get('SELECT value FROM kv WHERE key = ?', key); return r ? JSON.parse(r.value) : def; }
export function kvSet(key, value) { run('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value)); }

export function addEvent(type, contactId = null, data = {}) {
  return insert('events', { at: Date.now(), type, contact_id: contactId, data: JSON.stringify(data) });
}
