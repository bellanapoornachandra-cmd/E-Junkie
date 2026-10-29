import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.js';
import { createApi } from '../server/app.js';
import { initNeonStorage, syncFromNeon, queryNeonBooking, getNeonPool } from '../server/neon-storage.js';

function client(handle) {
  let cookie = '';
  const call = async (method, p, body) => {
    try {
      const out = await handle({ method, headers: { cookie } }, new URL(p, 'http://localhost'), body);
      if (out && out.$cookie) cookie = out.$cookie.split(';')[0];
      return { status: 200, body: out };
    } catch (e) {
      if (!e.status) throw e;
      return { status: e.status, body: { error: e.message, code: e.code } };
    }
  };
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b = {}) => call('PUT', p, b) };
}

test('NeonTech persistent storage: booking persists to cloud and survives app restart', async () => {
  const pool = getNeonPool();
  if (!pool) {
    console.log('Skipping NeonTech persistence test: DATABASE_URL not set.');
    return;
  }

  // 1. Initialize Neon storage and safe migrations
  const neonInit = await initNeonStorage();
  assert.equal(neonInit.ok, true, `NeonTech connection failed: ${neonInit.error}`);

  // 2. Start initial app instance with local db synced from Neon
  const db1 = openDb(':memory:', { admin: { email: 'admin@test.invalid', password: 'admin-password-123' } });
  await syncFromNeon(db1);
  const handle1 = createApi(db1);
  const c1 = client(handle1);

  // 3. Register a test customer
  const randomSuffix = Date.now();
  const customerEmail = `customer_${randomSuffix}@test.invalid`;
  const signupRes = await c1.post('/api/auth/signup', {
    name: 'Persistent Tester',
    email: customerEmail,
    phone: '9876543210',
    password: 'secure-customer-pw-1',
  });
  assert.equal(signupRes.status, 200, signupRes.body.error);

  // 4. Create a test booking
  const cfg = (await c1.get('/api/public/config')).body;
  const slotsRes = await c1.get('/api/slots?pin=530013');
  assert.equal(slotsRes.status, 200);
  assert.ok(slotsRes.body.slots.length > 0, 'Slots available');
  const slot = slotsRes.body.slots[0];

  const bookRes = await c1.post('/api/bookings', {
    items: [{ category_id: 1, est_qty: 2 }],
    address: {
      address_line: '123 Beach Road, Pandurangapuram',
      unit: 'Flat 4B',
      pincode: '530013',
    },
    slot_id: slot.id,
    contact_name: 'Persistent Tester',
    contact_phone: '9876543210',
    data_wipe_ack: true,
    accepted_fee: cfg.fee.rupees,
  });
  assert.equal(bookRes.status, 200, bookRes.body.error);
  const bookingCode = bookRes.body.booking_code;
  assert.ok(bookingCode, 'Booking code returned');
  console.log(`✓ Test booking created: ${bookingCode}`);

  // 5. Verify the booking was directly persisted to the NeonTech PostgreSQL database
  const neonBooking = await queryNeonBooking(bookingCode);
  assert.ok(neonBooking, 'Booking exists directly in NeonTech PostgreSQL database');
  assert.equal(neonBooking.booking_code, bookingCode);
  assert.equal(neonBooking.status, 'Booked');
  console.log('✓ Verified booking exists in NeonTech cloud PostgreSQL.');

  // 6. SIMULATE APP RESTART:
  // Discard the old in-memory db instance and start a fresh app instance from scratch
  console.log('Simulating app restart with clean database...');
  const db2 = openDb(':memory:', { admin: { email: 'admin@test.invalid', password: 'admin-password-123' } });
  // Resynchronize from NeonTech (Source of Truth)
  const syncRes = await syncFromNeon(db2);
  assert.equal(syncRes.synced, true);

  const handle2 = createApi(db2);
  const c2 = client(handle2);

  // 7. Verify the booking remains after restarting the app
  // Log in as customer in the restarted app instance
  const loginRes = await c2.post('/api/auth/login', {
    email: customerEmail,
    password: 'secure-customer-pw-1',
  });
  assert.equal(loginRes.status, 200, 'Customer can log in after restart');

  // Load the booking in the restarted app
  const getBookingRes = await c2.get(`/api/bookings/${bookingCode}`);
  assert.equal(getBookingRes.status, 200, 'Booking is retrieved from restarted app');
  assert.equal(getBookingRes.body.booking.booking_code, bookingCode);
  assert.equal(getBookingRes.body.booking.status, 'Booked');
  assert.equal(getBookingRes.body.booking.contact_name, 'Persistent Tester');
  console.log('✓ Verified booking remains completely intact in the app after restart!');

  // 8. Test update: Cancel the booking in the restarted app
  const cancelRes = await c2.post(`/api/bookings/${bookingCode}/cancel`, { reason: 'Test complete' });
  assert.equal(cancelRes.status, 200, cancelRes.body.error);

  // Verify the updated status persisted to NeonTech
  const updatedNeonBooking = await queryNeonBooking(bookingCode);
  assert.equal(updatedNeonBooking.status, 'Cancelled');
  console.log('✓ Verified booking update persisted to NeonTech cloud database.');

  await pool.end();
});
