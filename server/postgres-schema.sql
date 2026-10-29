-- =============================================================================
-- E-Junkie PostgreSQL Schema
-- Compatible with Render PostgreSQL, Neon, Supabase, and AWS RDS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(180) NOT NULL UNIQUE,
  phone VARCHAR(40),
  role VARCHAR(20) NOT NULL CHECK (role IN ('customer', 'collector', 'admin')),
  active SMALLINT NOT NULL DEFAULT 1,
  password_hash TEXT NOT NULL,
  must_change_password SMALLINT NOT NULL DEFAULT 0,
  availability VARCHAR(255),
  exception_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash VARCHAR(128) PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS service_areas (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  city VARCHAR(120) NOT NULL,
  pincodes TEXT NOT NULL,
  active SMALLINT NOT NULL DEFAULT 1,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS addresses (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label VARCHAR(80),
  address_line TEXT NOT NULL,
  unit VARCHAR(100),
  area VARCHAR(120) NOT NULL,
  city VARCHAR(120) NOT NULL,
  pincode VARCHAR(20) NOT NULL,
  access_instructions TEXT,
  archived SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS item_categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  accepted SMALLINT NOT NULL DEFAULT 1,
  handling_notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pickup_slots (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  start_time VARCHAR(20) NOT NULL,
  end_time VARCHAR(20) NOT NULL,
  area_id INTEGER NOT NULL REFERENCES service_areas(id) ON DELETE CASCADE,
  capacity INTEGER NOT NULL CHECK (capacity >= 0),
  booked INTEGER NOT NULL DEFAULT 0 CHECK (booked >= 0),
  active SMALLINT NOT NULL DEFAULT 1,
  CONSTRAINT uq_slot UNIQUE (date, start_time, area_id),
  CONSTRAINT chk_slot_cap CHECK (booked <= capacity)
);

CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  booking_code VARCHAR(40) NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES users(id),
  address_id INTEGER REFERENCES addresses(id),
  address_text TEXT NOT NULL,
  access_instructions TEXT,
  area_id INTEGER NOT NULL REFERENCES service_areas(id),
  slot_id INTEGER NOT NULL REFERENCES pickup_slots(id),
  requested_date DATE NOT NULL,
  time_window VARCHAR(40) NOT NULL,
  contact_name VARCHAR(120) NOT NULL,
  contact_phone VARCHAR(40) NOT NULL,
  customer_notes TEXT,
  collector_id INTEGER REFERENCES users(id),
  route_order INTEGER,
  status VARCHAR(40) NOT NULL,
  fee_rupees NUMERIC(10, 2) NOT NULL DEFAULT 0,
  data_wipe_ack SMALLINT NOT NULL DEFAULT 0,
  cancellation_cutoff TIMESTAMPTZ NOT NULL,
  exception_note TEXT,
  collected_at TIMESTAMPTZ,
  collected_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS booking_items (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES item_categories(id),
  est_qty INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collected_items (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES item_categories(id),
  quantity INTEGER NOT NULL DEFAULT 0,
  weight_kg NUMERIC(10, 3)
);

CREATE TABLE IF NOT EXISTS status_history (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  status VARCHAR(40) NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  by_user_id INTEGER REFERENCES users(id),
  note TEXT
);

CREATE TABLE IF NOT EXISTS recyclers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(140) NOT NULL,
  contact_name VARCHAR(120),
  phone VARCHAR(40),
  address TEXT,
  verified SMALLINT NOT NULL DEFAULT 0,
  certification_claim TEXT,
  show_certified SMALLINT NOT NULL DEFAULT 0,
  active SMALLINT NOT NULL DEFAULT 1,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS recycler_handoffs (
  id SERIAL PRIMARY KEY,
  reference VARCHAR(60) NOT NULL UNIQUE,
  recycler_id INTEGER NOT NULL REFERENCES recyclers(id),
  handoff_date DATE NOT NULL,
  receipt_ref VARCHAR(100),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS handoff_bookings (
  handoff_id INTEGER NOT NULL REFERENCES recycler_handoffs(id) ON DELETE CASCADE,
  booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS handoff_items (
  id SERIAL PRIMARY KEY,
  handoff_id INTEGER NOT NULL REFERENCES recycler_handoffs(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES item_categories(id),
  quantity INTEGER NOT NULL DEFAULT 0,
  weight_kg NUMERIC(10, 3)
);

CREATE TABLE IF NOT EXISTS eco_rules (
  id SERIAL PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES item_categories(id),
  valuation_method VARCHAR(20) NOT NULL CHECK (valuation_method IN ('per_item', 'per_kg')),
  rate_type VARCHAR(20) NOT NULL CHECK (rate_type IN ('points', 'rupees')),
  rate NUMERIC(10, 2) NOT NULL CHECK (rate >= 0),
  effective_date DATE NOT NULL,
  active SMALLINT NOT NULL DEFAULT 1,
  is_sample SMALLINT NOT NULL DEFAULT 0,
  admin_notes TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS redemptions (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES users(id),
  points INTEGER NOT NULL,
  rupee_value NUMERIC(10, 2) NOT NULL,
  method VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('Requested', 'Fulfilled', 'Rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  reference VARCHAR(120),
  admin_note TEXT
);

CREATE TABLE IF NOT EXISTS wallet_txns (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES users(id),
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  category_id INTEGER NOT NULL REFERENCES item_categories(id),
  collected_item_id INTEGER REFERENCES collected_items(id),
  verified_qty INTEGER,
  verified_weight_kg NUMERIC(10, 3),
  rule_id INTEGER REFERENCES eco_rules(id),
  rule_used VARCHAR(120),
  points INTEGER NOT NULL DEFAULT 0,
  rupee_value NUMERIC(10, 2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Redeemed')),
  redemption_id INTEGER REFERENCES redemptions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  admin_note TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key VARCHAR(80) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  entity VARCHAR(40) NOT NULL,
  entity_id INTEGER,
  action VARCHAR(60) NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB
);

CREATE TABLE IF NOT EXISTS collector_areas (
  collector_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  area_id INTEGER NOT NULL REFERENCES service_areas(id) ON DELETE CASCADE,
  PRIMARY KEY (collector_id, area_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_collector_areas ON collector_areas(collector_id, area_id);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_collector ON bookings(collector_id);
CREATE INDEX IF NOT EXISTS idx_wallet_customer ON wallet_txns(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_history_booking ON status_history(booking_id);
CREATE INDEX IF NOT EXISTS idx_slots_area_date ON pickup_slots(area_id, date);

-- Initial configuration seeds
INSERT INTO service_areas (name, city, pincodes, active, notes)
VALUES ('Visakhapatnam', 'Visakhapatnam', '530013, 530016, 530017, 530026, 530041, 530048', 1, 'Initial launch area.')
ON CONFLICT DO NOTHING;

INSERT INTO item_categories (name, description, accepted, handling_notes, sort_order) VALUES
  ('Mobile phones & tablets', 'Smartphones, feature phones, tablets, e-readers.', 1, 'Remove SIM and memory cards. Back up and factory-reset before pickup.', 1),
  ('Laptops & computers', 'Laptops, desktops, CPUs, servers.', 1, 'Back up and wipe drives. Hard disks can be removed and kept if preferred.', 2),
  ('Computer accessories', 'Keyboards, mice, webcams, routers, modems, hard disks.', 1, NULL, 3),
  ('TVs & monitors', 'LCD/LED TVs, CRT TVs, computer monitors.', 1, 'Large screens need two people — mention the floor and whether there is a lift.', 4),
  ('Small appliances', 'Mixers, irons, kettles, hair dryers, set-top boxes.', 1, NULL, 5),
  ('Large appliances', 'Fridges, washing machines, air conditioners, microwaves.', 1, 'Disconnect and defrost fridges a day before. Two-person lift.', 6),
  ('Batteries & power banks', 'Li-ion packs, power banks, UPS batteries.', 1, 'Tape the terminals. Do not hand over swollen or leaking batteries — tell us first.', 7),
  ('Chargers, cables & wires', 'Chargers, adapters, extension boards, wiring.', 1, NULL, 8),
  ('Printers & ink', 'Printers, scanners, toner and ink cartridges.', 1, NULL, 9),
  ('CFL & tube lights', 'Mercury-containing lamps.', 0, 'Not accepted yet — needs a specialised handler.', 10)
ON CONFLICT DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('pickup_fee_rupees', '0'),
  ('change_cutoff_hours', '12'),
  ('redemption_enabled', '0'),
  ('points_rupee_value', '0.25'),
  ('redemption_min_points', '100'),
  ('support_phone', ''),
  ('support_email', '')
ON CONFLICT DO NOTHING;

