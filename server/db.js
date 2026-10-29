import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { argon2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { SETTINGS, todayIST, addDays } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.EJ_DB || path.join(here, '..', 'data', 'ejunkie.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  role TEXT NOT NULL CHECK (role IN ('customer','collector','admin')),
  active INTEGER NOT NULL DEFAULT 1,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  availability TEXT,
  exception_notes TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS service_areas (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  pincodes TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES users(id),
  label TEXT,
  address_line TEXT NOT NULL,
  unit TEXT,
  area TEXT NOT NULL,
  city TEXT NOT NULL,
  pincode TEXT NOT NULL,
  access_instructions TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS item_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  accepted INTEGER NOT NULL DEFAULT 1,
  handling_notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pickup_slots (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  area_id INTEGER NOT NULL REFERENCES service_areas(id),
  capacity INTEGER NOT NULL CHECK (capacity >= 0),
  booked INTEGER NOT NULL DEFAULT 0 CHECK (booked >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (date, start_time, area_id),
  CHECK (booked <= capacity)
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  booking_code TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES users(id),
  address_id INTEGER REFERENCES addresses(id),
  address_text TEXT NOT NULL,
  access_instructions TEXT,
  area_id INTEGER NOT NULL REFERENCES service_areas(id),
  slot_id INTEGER NOT NULL REFERENCES pickup_slots(id),
  requested_date TEXT NOT NULL,
  time_window TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  customer_notes TEXT,
  collector_id INTEGER REFERENCES users(id),
  route_order INTEGER,
  status TEXT NOT NULL,
  fee_rupees REAL NOT NULL DEFAULT 0,
  data_wipe_ack INTEGER NOT NULL DEFAULT 0,
  cancellation_cutoff TEXT NOT NULL,
  exception_note TEXT,
  collected_at TEXT,
  collected_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS booking_items (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  category_id INTEGER NOT NULL REFERENCES item_categories(id),
  est_qty INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS collected_items (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  category_id INTEGER NOT NULL REFERENCES item_categories(id),
  quantity INTEGER NOT NULL DEFAULT 0,
  weight_kg REAL
);
CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  status TEXT NOT NULL,
  at TEXT NOT NULL,
  by_user_id INTEGER REFERENCES users(id),
  note TEXT
);
CREATE TABLE IF NOT EXISTS recyclers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  address TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  certification_claim TEXT,
  show_certified INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS recycler_handoffs (
  id INTEGER PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  recycler_id INTEGER NOT NULL REFERENCES recyclers(id),
  handoff_date TEXT NOT NULL,
  receipt_ref TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS handoff_bookings (
  handoff_id INTEGER NOT NULL REFERENCES recycler_handoffs(id),
  booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id)
);
CREATE TABLE IF NOT EXISTS handoff_items (
  id INTEGER PRIMARY KEY,
  handoff_id INTEGER NOT NULL REFERENCES recycler_handoffs(id),
  category_id INTEGER NOT NULL REFERENCES item_categories(id),
  quantity INTEGER NOT NULL DEFAULT 0,
  weight_kg REAL
);
CREATE TABLE IF NOT EXISTS eco_rules (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES item_categories(id),
  valuation_method TEXT NOT NULL CHECK (valuation_method IN ('per_item','per_kg')),
  rate_type TEXT NOT NULL CHECK (rate_type IN ('points','rupees')),
  rate REAL NOT NULL CHECK (rate >= 0),
  effective_date TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  is_sample INTEGER NOT NULL DEFAULT 0,
  admin_notes TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES users(id),
  points INTEGER NOT NULL,
  rupee_value REAL NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Requested','Fulfilled','Rejected')),
  created_at TEXT NOT NULL,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  reference TEXT,
  admin_note TEXT
);
CREATE TABLE IF NOT EXISTS wallet_txns (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES users(id),
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  category_id INTEGER NOT NULL REFERENCES item_categories(id),
  collected_item_id INTEGER REFERENCES collected_items(id),
  verified_qty INTEGER,
  verified_weight_kg REAL,
  rule_id INTEGER REFERENCES eco_rules(id),
  rule_used TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  rupee_value REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('Pending','Approved','Rejected','Redeemed')),
  redemption_id INTEGER REFERENCES redemptions(id),
  created_at TEXT NOT NULL,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  admin_note TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  at TEXT NOT NULL,
  details TEXT
);
CREATE TABLE IF NOT EXISTS collector_areas (
  collector_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  area_id INTEGER NOT NULL REFERENCES service_areas(id) ON DELETE CASCADE,
  PRIMARY KEY (collector_id, area_id)
);
CREATE INDEX IF NOT EXISTS idx_collector_areas ON collector_areas(collector_id, area_id);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_collector ON bookings(collector_id);
CREATE INDEX IF NOT EXISTS idx_wallet_customer ON wallet_txns(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_history_booking ON status_history(booking_id);
CREATE INDEX IF NOT EXISTS idx_slots_area_date ON pickup_slots(area_id, date);
`;

// ---------------------------------------------------------------- passwords (argon2id, PHC string format)
const ARGON = { parallelism: 1, tagLength: 32, memory: 19456, passes: 2 }; // OWASP baseline for argon2id

export function hashPassword(pw) {
  const nonce = randomBytes(16);
  const hash = argon2Sync('argon2id', { message: String(pw), nonce, ...ARGON });
  return `$argon2id$v=19$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}$${nonce.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(pw, stored) {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([\w-]+)\$([\w-]+)$/.exec(String(stored || ''));
  if (!m) return false;
  const expected = Buffer.from(m[5], 'base64url');
  const actual = argon2Sync('argon2id', {
    message: String(pw), nonce: Buffer.from(m[4], 'base64url'), memory: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]), tagLength: expected.length,
  });
  return timingSafeEqual(actual, expected);
}

export const MIN_PASSWORD_LENGTH = 10;

const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

function insert(db, table, row) {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  return Number(db.prepare(sql).run(...keys.map((k) => norm(row[k]))).lastInsertRowid);
}

function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Opens (and if needed initialises) the database. `admin` is { email, password }, normally from
// ADMIN_EMAIL / ADMIN_PASSWORD; it is only used when no admin account exists yet.
export function openDb(file = DB_PATH, { admin } = {}) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  try { db.exec('ALTER TABLE users ADD COLUMN availability TEXT;'); } catch {}
  try { db.exec('ALTER TABLE users ADD COLUMN exception_notes TEXT;'); } catch {}
  for (const [key, def] of Object.entries(SETTINGS)) {
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, def.default);
  }
  if (!db.prepare('SELECT 1 FROM service_areas LIMIT 1').get()) inTransaction(db, () => seedConfiguration(db));
  ensureAdmin(db, admin);
  return db;
}

export class SetupError extends Error {}

// Creates the first admin once. Never updates or resets an existing admin, and never logs the password.
export function ensureAdmin(db, admin) {
  if (db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get()) return { created: false };
  const email = String(admin?.email || '').trim();
  const password = String(admin?.password || '');
  if (!email || !password) {
    throw new SetupError('No admin account exists yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in the .env file (see .env.example), then start again.');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new SetupError('ADMIN_EMAIL is not a valid email address.');
  if (password.length < MIN_PASSWORD_LENGTH) throw new SetupError(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new SetupError('ADMIN_EMAIL already belongs to a non-admin account.');
  const id = insert(db, 'users', {
    name: 'Administrator', email, phone: null, role: 'admin', active: 1, password_hash: hashPassword(password), must_change_password: 1, created_at: new Date().toISOString(),
  });
  insert(db, 'audit_log', { entity: 'user', entity_id: id, action: 'create_initial_admin', actor_id: null, at: new Date().toISOString(), details: null });
  return { created: true };
}

// ---------------------------------------------------------------------------
// Configuration defaults only — no people, bookings or transactions. All of it is editable by the admin.
// ---------------------------------------------------------------------------
const DEFAULT_WINDOWS = [
  ['09:00', '12:00'],
  ['12:00', '15:00'],
  ['15:00', '18:00'],
];
const DEFAULT_SLOT_CAPACITY = 6;
const DEFAULT_SLOT_DAYS = 14;

function seedConfiguration(db) {
  const areaId = insert(db, 'service_areas', {
    name: 'Visakhapatnam', city: 'Visakhapatnam', pincodes: '530013, 530016, 530017, 530026, 530041, 530048', active: 1,
    notes: 'Initial launch area. Edit the PIN code list or split into localities as needed.',
  });

  const categories = [
    ['Mobile phones & tablets', 'Smartphones, feature phones, tablets, e-readers.', 1, 'Remove SIM and memory cards. Back up and factory-reset before pickup.'],
    ['Laptops & computers', 'Laptops, desktops, CPUs, servers.', 1, 'Back up and wipe drives. Hard disks can be removed and kept if preferred.'],
    ['Computer accessories', 'Keyboards, mice, webcams, routers, modems, hard disks.', 1, null],
    ['TVs & monitors', 'LCD/LED TVs, CRT TVs, computer monitors.', 1, 'Large screens need two people — mention the floor and whether there is a lift.'],
    ['Small appliances', 'Mixers, irons, kettles, hair dryers, set-top boxes.', 1, null],
    ['Large appliances', 'Fridges, washing machines, air conditioners, microwaves.', 1, 'Disconnect and defrost fridges a day before. Two-person lift.'],
    ['Batteries & power banks', 'Li-ion packs, power banks, UPS batteries.', 1, 'Tape the terminals. Do not hand over swollen or leaking batteries — tell us first.'],
    ['Chargers, cables & wires', 'Chargers, adapters, extension boards, wiring.', 1, null],
    ['Printers & ink', 'Printers, scanners, toner and ink cartridges.', 1, null],
    ['CFL & tube lights', 'Mercury-containing lamps.', 0, 'Not accepted yet — needs a specialised handler.'],
  ];
  categories.forEach(([name, description, accepted, handling_notes], i) =>
    insert(db, 'item_categories', { name, description, accepted, handling_notes, sort_order: i + 1 }));

  const today = todayIST();
  for (let d = 0; d <= DEFAULT_SLOT_DAYS; d++) {
    for (const [start_time, end_time] of DEFAULT_WINDOWS) {
      insert(db, 'pickup_slots', { date: addDays(today, d), start_time, end_time, area_id: areaId, capacity: DEFAULT_SLOT_CAPACITY, booked: 0, active: 1 });
    }
  }
}
