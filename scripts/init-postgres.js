import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, '..', 'server', 'postgres-schema.sql');

const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_URL_POOLED;
if (!dbUrl) {
  console.error('Error: DATABASE_URL is not set in environment or .env');
  process.exit(1);
}

const parsed = new URL(dbUrl);
const username = parsed.username;
const password = decodeURIComponent(parsed.password);
const host = parsed.hostname;
const database = parsed.pathname.slice(1);

console.log(`Connecting to Postgres host: ${host}, database: ${database}...`);

async function run() {
  const sql = await readFile(schemaPath, 'utf8');

  // Try pg driver if available
  try {
    const { default: pg } = await import('pg');
    const { Client } = pg;
    const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    console.log('Connected via pg client.');
    await client.query(sql);
    console.log('✓ PostgreSQL schema and seeds applied successfully via pg!');

    // Ensure initial admin exists
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (adminEmail && adminPassword) {
      const { rows } = await client.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
      if (rows.length === 0) {
        const { hashPassword } = await import('../server/db.js');
        const hash = hashPassword(adminPassword);
        const ins = await client.query(
          "INSERT INTO users (name, email, role, active, password_hash, must_change_password) VALUES ($1, $2, 'admin', 1, $3, 1) RETURNING id",
          ['Administrator', adminEmail.trim(), hash]
        );
        const adminId = ins.rows[0].id;
        await client.query(
          "INSERT INTO audit_log (entity, entity_id, action, at, details) VALUES ('user', $1, 'create_initial_admin', NOW(), $2)",
          [adminId, JSON.stringify({ email: adminEmail.trim() })]
        );
        console.log(`✓ Initial admin created (${adminEmail})`);
      } else {
        console.log('Admin account already exists in database.');
      }
    }

    await client.end();
    return;
  } catch (err) {
    if (err.code !== 'ERR_MODULE_NOT_FOUND') {
      console.warn('pg connection error, falling back to Neon HTTP API:', err.message);
    }
  }

  // Fallback to Neon HTTP SQL API (built into all Neon databases)
  try {
    const httpEndpoint = `https://${host}/sql`;
    console.log(`Attempting Neon HTTP SQL API: ${httpEndpoint}...`);
    const basicAuth = Buffer.from(`${username}:${password}`).toString('base64');
    const resp = await fetch(httpEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${basicAuth}`,
        'Neon-Connection-String': dbUrl,
      },
      body: JSON.stringify({ query: sql }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Neon HTTP API responded with status ${resp.status}: ${errText}`);
    }

    console.log('✓ PostgreSQL schema and seeds applied successfully via Neon HTTP API!');
  } catch (fetchErr) {
    console.error('Failed to initialize PostgreSQL schema:', fetchErr.message);
    process.exit(1);
  }
}

run();
