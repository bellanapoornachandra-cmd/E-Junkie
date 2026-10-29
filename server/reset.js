// Deletes the local database so the next `npm run setup` / `npm start` begins from a clean install.
// Stop the server first. This permanently removes all bookings, users and wallet records.
import { rmSync } from 'node:fs';
import { DB_PATH } from './db.js';

try {
  for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
} catch (e) {
  if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
  console.error('The database is in use. Stop the E-Junkie server (Ctrl+C) and run "npm run reset" again.');
  process.exit(1);
}
console.log(`Deleted ${DB_PATH}. Run "npm run setup" to initialise a fresh database.`);
