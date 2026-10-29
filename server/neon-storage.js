import pg from 'pg';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

// Prevent pg from converting DATE (OID 1082) to Date objects with UTC timezone shift
pg.types.setTypeParser(1082, (val) => val);
// Parse NUMERIC (OID 1700) as numbers
pg.types.setTypeParser(1700, (val) => (val === null ? null : Number(val)));

let pool = null;

export function getNeonPool() {
  const dbUrl = process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL;
  if (!dbUrl) return null;
  if (!pool) {
    try {
      pool = new Pool({
        connectionString: dbUrl,
        ssl: { rejectUnauthorized: false },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });
      pool.on('error', (err) => {
        console.error('NeonTech pool background error:', err.message);
      });
    } catch (err) {
      console.error('Failed to initialize NeonTech pool:', err.message);
      return null;
    }
  }
  return pool;
}

// Safely sanitize connection details for logging (never prints credentials)
export function sanitizeUrl(urlStr) {
  if (!urlStr) return '[empty]';
  try {
    const u = new URL(urlStr);
    return `${u.protocol}//${u.username ? '***' : ''}@${u.host}${u.pathname}`;
  } catch {
    return '[invalid URL format]';
  }
}

// Verify connection and apply safe migrations if necessary
export async function initNeonStorage() {
  const p = getNeonPool();
  if (!p) {
    console.warn('NeonTech database is not configured. (DATABASE_URL not set).');
    return { ok: false, error: 'DATABASE_URL is not set' };
  }

  try {
    const client = await p.connect();
    try {
      await client.query('SELECT 1');
      console.log('✓ Successfully connected to NeonTech cloud database.');

      // Check if schema exists, if not apply postgres-schema.sql
      const { rows } = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'bookings'"
      );
      if (rows.length === 0) {
        console.log('Applying PostgreSQL schema to NeonTech...');
        const schemaSql = await readFile(path.join(here, 'postgres-schema.sql'), 'utf8');
        await client.query(schemaSql);
        console.log('✓ NeonTech schema applied.');
      } else {
        // Safe column migrations
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS availability VARCHAR(255);');
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS exception_notes TEXT;');
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password SMALLINT NOT NULL DEFAULT 0;');
      }
      return { ok: true };
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('NeonTech database connection error:', err.message);
    return { ok: false, error: err.message };
  }
}

// Tables in dependency order for synchronization
export const SYNC_TABLES = [
  'service_areas',
  'item_categories',
  'settings',
  'users',
  'collector_areas',
  'sessions',
  'addresses',
  'pickup_slots',
  'eco_rules',
  'bookings',
  'booking_items',
  'collected_items',
  'status_history',
  'recyclers',
  'recycler_handoffs',
  'handoff_bookings',
  'handoff_items',
  'redemptions',
  'wallet_txns',
  'audit_log',
];

// Hydrate local database from NeonTech (Source of Truth)
export async function syncFromNeon(sqliteDb) {
  const p = getNeonPool();
  if (!p) return { synced: false, reason: 'No pool' };

  const client = await p.connect();
  try {
    let totalRestored = 0;
    sqliteDb.exec('PRAGMA foreign_keys = OFF;');
    sqliteDb.exec('BEGIN IMMEDIATE;');

    for (const table of SYNC_TABLES) {
      const { rows } = await client.query(`SELECT * FROM "${table}"`);
      if (rows.length === 0) continue;

      sqliteDb.exec(`DELETE FROM "${table}";`);

      for (const row of rows) {
        const keys = Object.keys(row);
        const values = keys.map((k) => {
          let v = row[k];
          if (v instanceof Date) {
            if (['date', 'requested_date', 'handoff_date', 'effective_date'].includes(k)) {
              const year = v.getFullYear();
              const month = String(v.getMonth() + 1).padStart(2, '0');
              const day = String(v.getDate()).padStart(2, '0');
              v = `${year}-${month}-${day}`;
            } else {
              v = v.toISOString();
            }
          } else if (typeof v === 'boolean') {
            v = v ? 1 : 0;
          } else if (k === 'details' && typeof v === 'object' && v !== null) {
            v = JSON.stringify(v);
          } else if (v === undefined) {
            v = null;
          }
          return v;
        });

        const placeholders = keys.map(() => '?').join(', ');
        sqliteDb
          .prepare(`INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${placeholders})`)
          .run(...values);
        totalRestored++;
      }
    }

    sqliteDb.exec('COMMIT;');
    sqliteDb.exec('PRAGMA foreign_keys = ON;');
    console.log(`✓ Synchronized ${totalRestored} records from NeonTech cloud database.`);
    return { synced: true, count: totalRestored };
  } catch (err) {
    try {
      sqliteDb.exec('ROLLBACK;');
      sqliteDb.exec('PRAGMA foreign_keys = ON;');
    } catch {}
    console.error('Failed to sync data from NeonTech:', err.message);
    return { synced: false, error: err.message };
  } finally {
    client.release();
  }
}

// Persist a single record to NeonTech in real time
export async function persistRowToNeon(table, row, conflictCol = 'id') {
  const p = getNeonPool();
  if (!p) return null;

  const client = await p.connect();
  try {
    const keys = Object.keys(row);
    const values = keys.map((k) => {
      let v = row[k];
      if (k === 'details' && typeof v === 'string') {
        try {
          return JSON.parse(v);
        } catch {
          return { text: v };
        }
      }
      return v === undefined ? null : v;
    });

    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const updateCols = keys
      .filter((k) => k !== conflictCol)
      .map((k) => `"${k}" = EXCLUDED."${k}"`)
      .join(', ');

    const onConflict = updateCols.length
      ? `ON CONFLICT (${conflictCol}) DO UPDATE SET ${updateCols}`
      : `ON CONFLICT (${conflictCol}) DO NOTHING`;

    const sql = `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${placeholders}) ${onConflict} RETURNING id;`;
    const res = await client.query(sql, values);

    // Update sequence if table has serial id
    if (keys.includes('id') && res.rows[0]?.id) {
      try {
        await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 1));`);
      } catch {}
    }

    return res.rows[0]?.id || true;
  } catch (err) {
    console.error(`Failed to persist to NeonTech [${table}]:`, err.message);
    throw err;
  } finally {
    client.release();
  }
}

// Directly persist a customer booking and all related updates into NeonTech
export async function persistBookingToNeon({ booking, items, slotId, history, address }) {
  const p = getNeonPool();
  if (!p) return;

  const client = await p.connect();
  try {
    await client.query('BEGIN');

    // 1. Persist address if newly created
    if (address && address.id) {
      await client.query(
        `INSERT INTO addresses (id, customer_id, label, address_line, unit, area, city, pincode, access_instructions, archived, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
           address_line = EXCLUDED.address_line,
           unit = EXCLUDED.unit,
           access_instructions = EXCLUDED.access_instructions;`,
        [
          address.id, address.customer_id, address.label, address.address_line,
          address.unit, address.area, address.city, address.pincode,
          address.access_instructions, address.archived ? 1 : 0, address.created_at || new Date().toISOString(),
        ]
      );
    }

    // 2. Persist slot booking capacity update
    if (slotId) {
      await client.query(
        'UPDATE pickup_slots SET booked = booked + 1 WHERE id = $1 AND booked < capacity;',
        [slotId]
      );
    }

    // 3. Persist the booking
    await client.query(
      `INSERT INTO bookings (
         id, booking_code, customer_id, address_id, address_text, access_instructions,
         area_id, slot_id, requested_date, time_window, contact_name, contact_phone,
         customer_notes, status, fee_rupees, data_wipe_ack, cancellation_cutoff, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (booking_code) DO UPDATE SET
         status = EXCLUDED.status,
         slot_id = EXCLUDED.slot_id,
         time_window = EXCLUDED.time_window;`,
      [
        booking.id, booking.booking_code, booking.customer_id, booking.address_id,
        booking.address_text, booking.access_instructions, booking.area_id,
        booking.slot_id, booking.requested_date, booking.time_window,
        booking.contact_name, booking.contact_phone, booking.customer_notes,
        booking.status, booking.fee_rupees, booking.data_wipe_ack ? 1 : 0,
        booking.cancellation_cutoff, booking.created_at || new Date().toISOString(),
      ]
    );

    // 4. Persist booking items
    if (Array.isArray(items)) {
      for (const it of items) {
        await client.query(
          `INSERT INTO booking_items (booking_id, category_id, est_qty)
           VALUES ($1, $2, $3);`,
          [booking.id, it.category_id, it.est_qty]
        );
      }
    }

    // 5. Persist status history
    if (history) {
      await client.query(
        `INSERT INTO status_history (booking_id, status, at, by_user_id, note)
         VALUES ($1, $2, $3, $4, $5);`,
        [history.booking_id, history.status, history.at || new Date().toISOString(), history.by_user_id, history.note || null]
      );
    }

    // Update sequences
    await client.query(`SELECT setval(pg_get_serial_sequence('bookings', 'id'), COALESCE((SELECT MAX(id) FROM bookings), 1));`);
    await client.query(`SELECT setval(pg_get_serial_sequence('booking_items', 'id'), COALESCE((SELECT MAX(id) FROM booking_items), 1));`);
    await client.query(`SELECT setval(pg_get_serial_sequence('status_history', 'id'), COALESCE((SELECT MAX(id) FROM status_history), 1));`);

    await client.query('COMMIT');
    console.log(`✓ Booking ${booking.booking_code} persisted to NeonTech cloud database.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Failed to persist booking ${booking.booking_code} to NeonTech:`, err.message);
    throw err;
  } finally {
    client.release();
  }
}

// Update booking status or cancellation directly in NeonTech
export async function persistBookingUpdateToNeon({ bookingCode, status, slotId, releaseSlotId, note, userId }) {
  const p = getNeonPool();
  if (!p) return;

  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id FROM bookings WHERE booking_code = $1', [bookingCode]);
    if (rows.length > 0) {
      const bookingId = rows[0].id;
      if (status) {
        await client.query('UPDATE bookings SET status = $1 WHERE id = $2', [status, bookingId]);
      }
      if (slotId) {
        await client.query('UPDATE pickup_slots SET booked = booked + 1 WHERE id = $1', [slotId]);
      }
      if (releaseSlotId) {
        await client.query('UPDATE pickup_slots SET booked = CASE WHEN booked > 0 THEN booked - 1 ELSE 0 END WHERE id = $1', [releaseSlotId]);
      }
      if (status) {
        await client.query(
          'INSERT INTO status_history (booking_id, status, at, by_user_id, note) VALUES ($1, $2, NOW(), $3, $4)',
          [bookingId, status, userId || null, note || null]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Failed to update booking ${bookingCode} in NeonTech:`, err.message);
    throw err;
  } finally {
    client.release();
  }
}

// Direct query to verify a booking exists in NeonTech
export async function queryNeonBooking(bookingCode) {
  const p = getNeonPool();
  if (!p) return null;

  const client = await p.connect();
  try {
    const { rows } = await client.query(
      `SELECT b.*,
         (SELECT json_agg(json_build_object('category_id', bi.category_id, 'est_qty', bi.est_qty))
          FROM booking_items bi WHERE bi.booking_id = b.id) AS items
       FROM bookings b WHERE b.booking_code = $1`,
      [bookingCode]
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}
