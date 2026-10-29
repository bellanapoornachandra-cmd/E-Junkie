// Initialises the database: configuration defaults and the first admin (from ADMIN_EMAIL / ADMIN_PASSWORD).
// Safe to re-run: it never duplicates or resets an existing admin and never adds people or bookings.
import { openDb, DB_PATH, SetupError } from './db.js';

try {
  const db = openDb(DB_PATH, { admin: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } });
  const count = (sql) => db.prepare(sql).get().n;
  console.log(`Database ready at ${DB_PATH}`);
  console.log(`  users: ${count('SELECT COUNT(*) AS n FROM users')} (admins: ${count("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")})`);
  console.log(`  bookings: ${count('SELECT COUNT(*) AS n FROM bookings')}`);
  console.log(`  service areas: ${count('SELECT COUNT(*) AS n FROM service_areas')}, item categories: ${count('SELECT COUNT(*) AS n FROM item_categories')}, pickup slots: ${count('SELECT COUNT(*) AS n FROM pickup_slots')}`);
  db.close();
} catch (e) {
  if (!(e instanceof SetupError)) throw e;
  console.error(`Setup error: ${e.message}`);
  process.exit(1);
}
