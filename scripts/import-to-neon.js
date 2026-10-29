import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlitePath = process.env.EJ_DB || path.join(here, '..', 'data', 'ejunkie.db');
const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_URL_POOLED;

if (!dbUrl) {
  console.error('Error: DATABASE_URL is not set.');
  process.exit(1);
}

console.log(`Reading local SQLite database from: ${sqlitePath}`);
const sqlite = new DatabaseSync(sqlitePath);

console.log('Connecting to Neon PostgreSQL...');
const pgClient = new pg.Client({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
});

// Tables in foreign-key dependency order
const TABLES = [
  {
    name: 'service_areas',
    conflict: 'id',
    cols: ['id', 'name', 'city', 'pincodes', 'active', 'notes'],
  },
  {
    name: 'item_categories',
    conflict: 'id',
    cols: ['id', 'name', 'description', 'accepted', 'handling_notes', 'sort_order'],
  },
  {
    name: 'settings',
    conflict: 'key',
    cols: ['key', 'value', 'updated_by', 'updated_at'],
  },
  {
    name: 'users',
    conflict: 'id',
    cols: ['id', 'name', 'email', 'phone', 'role', 'active', 'password_hash', 'must_change_password', 'availability', 'exception_notes', 'created_at'],
  },
  {
    name: 'collector_areas',
    conflict: 'collector_id, area_id',
    cols: ['collector_id', 'area_id'],
  },
  {
    name: 'sessions',
    conflict: 'token_hash',
    cols: ['token_hash', 'user_id', 'expires_at'],
  },
  {
    name: 'addresses',
    conflict: 'id',
    cols: ['id', 'customer_id', 'label', 'address_line', 'unit', 'area', 'city', 'pincode', 'access_instructions', 'archived', 'created_at'],
  },
  {
    name: 'pickup_slots',
    conflict: 'id',
    cols: ['id', 'date', 'start_time', 'end_time', 'area_id', 'capacity', 'booked', 'active'],
  },
  {
    name: 'eco_rules',
    conflict: 'id',
    cols: ['id', 'category_id', 'valuation_method', 'rate_type', 'rate', 'effective_date', 'active', 'is_sample', 'admin_notes', 'updated_by', 'updated_at'],
  },
  {
    name: 'bookings',
    conflict: 'id',
    cols: [
      'id', 'booking_code', 'customer_id', 'address_id', 'address_text', 'access_instructions',
      'area_id', 'slot_id', 'requested_date', 'time_window', 'contact_name', 'contact_phone',
      'customer_notes', 'collector_id', 'route_order', 'status', 'fee_rupees', 'data_wipe_ack',
      'cancellation_cutoff', 'exception_note', 'collected_at', 'collected_by', 'created_at',
    ],
  },
  {
    name: 'booking_items',
    conflict: 'id',
    cols: ['id', 'booking_id', 'category_id', 'est_qty'],
  },
  {
    name: 'collected_items',
    conflict: 'id',
    cols: ['id', 'booking_id', 'category_id', 'quantity', 'weight_kg'],
  },
  {
    name: 'status_history',
    conflict: 'id',
    cols: ['id', 'booking_id', 'status', 'at', 'by_user_id', 'note'],
  },
  {
    name: 'recyclers',
    conflict: 'id',
    cols: ['id', 'name', 'contact_name', 'phone', 'address', 'verified', 'certification_claim', 'show_certified', 'active', 'notes'],
  },
  {
    name: 'recycler_handoffs',
    conflict: 'id',
    cols: ['id', 'reference', 'recycler_id', 'handoff_date', 'receipt_ref', 'notes', 'created_by', 'created_at'],
  },
  {
    name: 'handoff_bookings',
    conflict: 'booking_id',
    cols: ['handoff_id', 'booking_id'],
  },
  {
    name: 'handoff_items',
    conflict: 'id',
    cols: ['id', 'handoff_id', 'category_id', 'quantity', 'weight_kg'],
  },
  {
    name: 'redemptions',
    conflict: 'id',
    cols: ['id', 'customer_id', 'points', 'rupee_value', 'method', 'status', 'created_at', 'reviewed_by', 'reviewed_at', 'reference', 'admin_note'],
  },
  {
    name: 'wallet_txns',
    conflict: 'id',
    cols: [
      'id', 'customer_id', 'booking_id', 'category_id', 'collected_item_id', 'verified_qty',
      'verified_weight_kg', 'rule_id', 'rule_used', 'points', 'rupee_value', 'status',
      'redemption_id', 'created_at', 'reviewed_by', 'reviewed_at', 'admin_note',
    ],
  },
  {
    name: 'audit_log',
    conflict: 'id',
    cols: ['id', 'entity', 'entity_id', 'action', 'actor_id', 'at', 'details'],
  },
];

async function importTable(tableSpec) {
  const { name, cols, conflict } = tableSpec;
  const rows = sqlite.prepare(`SELECT * FROM "${name}"`).all();
  if (rows.length === 0) {
    console.log(`  - ${name}: 0 rows (skipped)`);
    return 0;
  }

  let imported = 0;
  for (const r of rows) {
    const values = cols.map((c) => {
      let val = r[c];
      if (val === undefined) val = null;
      if (c === 'details' && val !== null) {
        // Validate JSON for JSONB columns
        try {
          JSON.parse(val);
        } catch {
          val = JSON.stringify({ note: val });
        }
      }
      return val;
    });

    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const updateAssignments = cols
      .filter((c) => !conflict.includes(c))
      .map((c) => `"${c}" = EXCLUDED."${c}"`)
      .join(', ');

    const onConflictClause = updateAssignments.length
      ? `ON CONFLICT (${conflict}) DO UPDATE SET ${updateAssignments}`
      : `ON CONFLICT (${conflict}) DO NOTHING`;

    const sql = `INSERT INTO "${name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders}) ${onConflictClause}`;
    await pgClient.query(sql, values);
    imported++;
  }

  // If table has serial id, update the Postgres sequence
  if (cols.includes('id')) {
    try {
      await pgClient.query(`
        SELECT setval(pg_get_serial_sequence('${name}', 'id'), COALESCE((SELECT MAX(id) FROM "${name}"), 1));
      `);
    } catch {}
  }

  console.log(`  ✓ ${name}: ${imported} rows imported`);
  return imported;
}

async function main() {
  await pgClient.connect();
  console.log('Connected to Neon PostgreSQL.');
  console.log('Starting data import...\n');

  let totalRows = 0;
  for (const t of TABLES) {
    try {
      const count = await importTable(t);
      totalRows += count;
    } catch (err) {
      console.error(`Error importing ${t.name}:`, err.message);
    }
  }

  console.log(`\n🎉 Data import complete! Total ${totalRows} rows synced to Neon.`);
  await pgClient.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
