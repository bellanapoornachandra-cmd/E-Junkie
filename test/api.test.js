import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, SetupError } from '../server/db.js';
import { createApi } from '../server/app.js';

// Test-only credentials, generated per run; nothing here is stored in the app or its seed.
const ADMIN = { email: 'owner@test.invalid', password: `init-${Math.random().toString(36).slice(2)}-pw` };
const NEW_ADMIN_PW = 'changed-admin-password';
const PIN = '530017';

// Drives the API handler directly with a fake request, keeping a cookie per "browser".
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

async function setup() {
  const db = openDb(':memory:', { admin: ADMIN });
  const handle = createApi(db);
  const fresh = () => client(handle);

  const admin = fresh();
  assert.equal((await admin.post('/api/auth/login', ADMIN)).status, 200);
  assert.equal((await admin.post('/api/auth/change-password', { current_password: ADMIN.password, new_password: NEW_ADMIN_PW })).status, 200);

  let n = 0;
  async function customer() {
    const c = fresh();
    n += 1;
    const r = await c.post('/api/auth/signup', { name: `Customer ${n}`, email: `c${n}@test.invalid`, phone: `98765${String(n).padStart(5, '0')}`, password: 'customer-pass-1' });
    assert.equal(r.status, 200, r.body.error);
    const a = await c.post('/api/addresses', { address_line: `Test street ${n}`, pincode: PIN });
    assert.equal(a.status, 200, a.body.error);
    c.addressId = a.body.id;
    c.userId = r.body.user.id;
    return c;
  }
  async function collector() {
    n += 1;
    const email = `k${n}@test.invalid`;
    const created = await admin.post('/api/admin/users', { role: 'collector', name: `Collector ${n}`, email, phone: `99887${String(n).padStart(5, '0')}`, password: 'temporary-pass-1' });
    assert.equal(created.status, 200, created.body.error);
    const c = fresh();
    const login = await c.post('/api/auth/login', { email, password: 'temporary-pass-1' });
    assert.equal(login.body.user.must_change_password, true);
    assert.equal((await c.post('/api/auth/change-password', { current_password: 'temporary-pass-1', new_password: 'collector-pass-1' })).status, 200);
    c.userId = created.body.id;
    return c;
  }
  async function book(c, { later = false, items = [{ category_id: 1, est_qty: 2 }] } = {}) {
    const { slots } = (await c.get(`/api/slots?pin=${PIN}`)).body;
    const slot = later ? slots.find((s) => Date.parse(`${s.date}T${s.start_time}:00+05:30`) > Date.now() + 2 * 864e5) : slots[0];
    const r = await c.post('/api/bookings', {
      items, address_id: c.addressId, slot_id: slot.id, contact_name: 'Test Contact', contact_phone: '98765 00001', data_wipe_ack: true, accepted_fee: 0,
    });
    assert.equal(r.status, 200, r.body.error);
    return r.body.booking_code;
  }
  async function assign(code, col) {
    assert.equal((await admin.post(`/api/bookings/${code}/assign`, { collector_id: col.userId, route_order: 1 })).status, 200);
  }
  async function rule(category_id, valuation_method, rate) {
    const r = await admin.post('/api/admin/entity/rules', { category_id, valuation_method, rate_type: 'points', rate, effective_date: '2026-01-01', active: true });
    assert.equal(r.status, 200, r.body.error);
    return r.body.id;
  }
  return { db, admin, fresh, customer, collector, book, assign, rule };
}

test('fresh setup has exactly one admin, no bookings, no people data and no recyclers', async () => {
  const db = openDb(':memory:', { admin: ADMIN });
  const count = (sql) => db.prepare(sql).get().n;
  assert.equal(count('SELECT COUNT(*) AS n FROM users'), 1);
  assert.equal(count("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"), 1);
  for (const table of ['bookings', 'addresses', 'status_history', 'recyclers', 'recycler_handoffs', 'wallet_txns', 'redemptions', 'eco_rules']) {
    assert.equal(count(`SELECT COUNT(*) AS n FROM ${table}`), 0, table);
  }
  assert.equal(db.prepare('SELECT name FROM service_areas').get().name, 'Visakhapatnam');
  assert.ok(count('SELECT COUNT(*) AS n FROM item_categories') > 0);
  assert.ok(count('SELECT COUNT(*) AS n FROM pickup_slots') > 0);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'pickup_fee_rupees'").get().value, '0');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'support_phone'").get().value, '');

  const c = client(createApi(db));
  const cfg = (await c.get('/api/public/config')).body;
  assert.deepEqual(cfg.certified_recyclers, []);
  assert.equal(cfg.fee.rupees, 0);
});

test('admin password is argon2id-hashed and setup never duplicates or resets the admin', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ej-'));
  const file = path.join(dir, 'db.sqlite');
  try {
    const db1 = openDb(file, { admin: ADMIN });
    const before = db1.prepare('SELECT * FROM users').all();
    assert.match(before[0].password_hash, /^\$argon2id\$/);
    assert.ok(!before[0].password_hash.includes(ADMIN.password));
    db1.close();
    const db2 = openDb(file, { admin: { email: 'someone-else@test.invalid', password: 'another-password-123' } });
    const after = db2.prepare('SELECT * FROM users').all();
    assert.equal(after.length, 1);
    assert.equal(after[0].email, ADMIN.email);
    assert.equal(after[0].password_hash, before[0].password_hash);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => openDb(':memory:', {}), SetupError);
  assert.throws(() => openDb(':memory:', { admin: { email: ADMIN.email, password: 'short' } }), SetupError);
});

test('admin must change the password at first login before using anything else', async () => {
  const db = openDb(':memory:', { admin: ADMIN });
  const c = client(createApi(db));
  const login = await c.post('/api/auth/login', ADMIN);
  assert.equal(login.body.user.must_change_password, true);
  const blocked = await c.get('/api/admin/summary');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'password_change_required');
  assert.equal((await c.post('/api/auth/change-password', { current_password: 'wrong', new_password: NEW_ADMIN_PW })).status, 400);
  assert.equal((await c.post('/api/auth/change-password', { current_password: ADMIN.password, new_password: 'short' })).status, 400);
  const ok = await c.post('/api/auth/change-password', { current_password: ADMIN.password, new_password: NEW_ADMIN_PW });
  assert.equal(ok.body.user.must_change_password, false);
  assert.equal((await c.get('/api/admin/summary')).status, 200);
  assert.equal((await client(createApi(db)).post('/api/auth/login', ADMIN)).status, 401, 'old password no longer works');
});

test('booking takes slot capacity and cancelling restores it', async () => {
  const { db, customer, book } = await setup();
  const c = await customer();
  const code = await book(c, { later: true });
  assert.match(code, /^EJ-\d{6}-[A-Z2-9]{4}$/);
  const b = db.prepare('SELECT * FROM bookings WHERE booking_code = ?').get(code);
  assert.equal(db.prepare('SELECT booked FROM pickup_slots WHERE id = ?').get(b.slot_id).booked, 1);
  assert.equal((await c.post(`/api/bookings/${code}/cancel`, {})).status, 200);
  assert.equal(db.prepare('SELECT booked FROM pickup_slots WHERE id = ?').get(b.slot_id).booked, 0);
});

test('full slots, unaccepted categories, fee changes, missing consent and unserved PINs are refused', async () => {
  const { db, customer } = await setup();
  const c = await customer();
  const { slots } = (await c.get(`/api/slots?pin=${PIN}`)).body;
  const base = { items: [{ category_id: 1, est_qty: 1 }], address_id: c.addressId, slot_id: slots[0].id, contact_name: 'X', contact_phone: '9876500001', data_wipe_ack: true, accepted_fee: 0 };
  const notAccepted = db.prepare('SELECT id FROM item_categories WHERE accepted = 0').get().id;
  db.prepare('UPDATE pickup_slots SET booked = capacity WHERE id = ?').run(slots[0].id);
  assert.equal((await c.post('/api/bookings', base)).status, 409);
  const open = { ...base, slot_id: slots[1].id };
  assert.equal((await c.post('/api/bookings', { ...open, items: [{ category_id: notAccepted, est_qty: 1 }] })).status, 400);
  assert.equal((await c.post('/api/bookings', { ...open, accepted_fee: 50 })).status, 409);
  assert.equal((await c.post('/api/bookings', { ...open, data_wipe_ack: false })).status, 400);
  assert.equal((await c.post('/api/bookings', { ...open, address_id: undefined, address: { address_line: 'x', pincode: '110001' } })).status, 400);
});

test('customers and collectors only see their own bookings', async () => {
  const { customer, collector, book, assign, admin } = await setup();
  const a = await customer();
  const b = await customer();
  const k1 = await collector();
  const k2 = await collector();
  const codeA = await book(a, { later: true });
  const codeB = await book(b, { later: true });
  await assign(codeA, k1);
  await assign(codeB, k2);
  assert.deepEqual((await a.get('/api/bookings')).body.map((x) => x.booking_code), [codeA]);
  assert.equal((await a.get(`/api/bookings/${codeB}`)).status, 404);
  assert.deepEqual((await k1.get('/api/bookings')).body.map((x) => x.booking_code), [codeA]);
  assert.equal((await k1.get(`/api/bookings/${codeB}`)).status, 404);
  assert.equal((await a.get('/api/admin/summary')).status, 403);
  assert.equal((await k1.get('/api/admin/users?role=customer')).status, 403);
  assert.equal((await admin.get('/api/bookings')).body.length, 2);
});

test('collection creates pending points; approval needs a rule and makes points available exactly once', async () => {
  const { customer, collector, book, assign, admin, rule } = await setup();
  const c = await customer();
  const k = await collector();
  const code = await book(c, { later: true });
  await assign(code, k);
  assert.equal((await k.post(`/api/bookings/${code}/collect`, { items: [] })).status, 400);
  assert.equal((await k.post(`/api/bookings/${code}/collect`, { items: [{ category_id: 1, quantity: 2 }] })).status, 200);

  let wallet = (await c.get('/api/wallet')).body;
  assert.equal(wallet.balance.available, 0);
  const txn = wallet.transactions[0];
  assert.equal(txn.status, 'Pending');
  assert.equal((await admin.post(`/api/admin/wallet/${txn.id}/review`, { decision: 'approve', verified_qty: 2 })).status, 400, 'no rule yet');

  const ruleId = await rule(1, 'per_item', 50);
  assert.equal((await admin.post(`/api/admin/wallet/${txn.id}/review`, { decision: 'approve', verified_qty: 2, rule_id: ruleId })).status, 200);
  assert.equal((await admin.post(`/api/admin/wallet/${txn.id}/review`, { decision: 'approve', verified_qty: 2, rule_id: ruleId })).status, 409);
  wallet = (await c.get('/api/wallet')).body;
  assert.equal(wallet.balance.available, 100);
  assert.equal(wallet.balance.pending, 0);
  const audit = (await admin.get('/api/admin/audit')).body;
  assert.ok(audit.some((x) => x.entity === 'wallet_txn' && x.entity_id === txn.id && x.action === 'approve' && x.actor_name === 'Administrator'));
});

test('rejection needs a note and is never counted; redemption stays off until configured', async () => {
  const { customer, collector, book, assign, admin, rule } = await setup();
  const c = await customer();
  const k = await collector();
  const ruleId = await rule(1, 'per_item', 50);
  const code = await book(c, { later: true, items: [{ category_id: 1, est_qty: 2 }, { category_id: 2, est_qty: 1 }] });
  await assign(code, k);
  await k.post(`/api/bookings/${code}/collect`, { items: [{ category_id: 1, quantity: 12 }, { category_id: 2, quantity: 1 }] });
  const [phones, laptop] = (await admin.get('/api/admin/wallet?status=Pending')).body.transactions.sort((x, y) => x.category_id - y.category_id);
  assert.equal((await admin.post(`/api/admin/wallet/${laptop.id}/review`, { decision: 'reject' })).status, 400);
  assert.equal((await admin.post(`/api/admin/wallet/${laptop.id}/review`, { decision: 'reject', admin_note: 'Not eligible' })).status, 200);
  await admin.post(`/api/admin/wallet/${phones.id}/review`, { decision: 'approve', verified_qty: 12, rule_id: ruleId });

  assert.equal((await c.post('/api/wallet/redeem')).status, 409);
  await admin.put('/api/admin/settings', { redemption_enabled: true, redemption_method: 'UPI transfer', redemption_min_points: 100, rupees_per_point: 0.1 });
  assert.equal((await c.get('/api/wallet')).body.balance.available, 600);
  const r = await c.post('/api/wallet/redeem');
  assert.equal(r.status, 200, r.body.error);
  assert.equal((await c.get('/api/wallet')).body.balance.available, 0);
  const red = (await admin.get('/api/admin/redemptions')).body[0];
  assert.equal((await admin.post(`/api/admin/redemptions/${red.id}/fulfil`, { reference: 'UPI-123' })).status, 200);
  const after = (await c.get('/api/wallet')).body.balance;
  assert.equal(after.redeemed, 600);
  assert.equal(after.available, 0);
});

test('only collectors/admins record collection, and only handoffs move bookings to the recycler', async () => {
  const { customer, collector, book, assign, admin } = await setup();
  const c = await customer();
  const k = await collector();
  const other = await collector();
  const code = await book(c, { later: true });
  await assign(code, k);
  assert.equal((await c.post(`/api/bookings/${code}/collect`, { items: [{ category_id: 1, quantity: 1 }] })).status, 403);
  assert.equal((await other.post(`/api/bookings/${code}/status`, { status: 'Unable to collect', note: 'x' })).status, 404);
  assert.equal((await k.post(`/api/bookings/${code}/collect`, { items: [{ category_id: 1, quantity: 1 }] })).status, 200);

  const { eligible } = (await admin.get('/api/admin/handoffs')).body;
  assert.equal((await admin.post('/api/admin/handoffs', { recycler_id: 1, handoff_date: '2026-10-29', booking_ids: [eligible[0].id] })).status, 400, 'no recycler yet');
  const rec = await admin.post('/api/admin/entity/recyclers', { name: 'Test Recycler', active: true });
  assert.equal((await client(createApi(openDb(':memory:', { admin: ADMIN }))).get('/api/public/config')).body.certified_recyclers.length, 0);
  const res = await admin.post('/api/admin/handoffs', { recycler_id: rec.body.id, handoff_date: '2026-10-29', booking_ids: [eligible[0].id], receipt_ref: 'R-1' });
  assert.equal(res.status, 200, res.body.error);
  const detail = (await admin.get(`/api/bookings/${code}`)).body;
  assert.equal(detail.booking.status, 'Received by recycler');
  assert.equal(detail.handoff.receipt_ref, 'R-1');
  assert.equal(detail.handoff.certification_claim, null, 'no claim until the admin verifies and enables it');
});

test('reschedule moves capacity between slots and returns to the assignment queue', async () => {
  const { db, customer, collector, book, assign } = await setup();
  const c = await customer();
  const k = await collector();
  const code = await book(c, { later: true });
  await assign(code, k);
  const b = db.prepare('SELECT * FROM bookings WHERE booking_code = ?').get(code);
  const { slots } = (await c.get(`/api/bookings/${code}/slots`)).body;
  const target = slots[slots.length - 1];
  assert.equal((await c.post(`/api/bookings/${code}/reschedule`, { slot_id: target.id })).status, 200);
  assert.equal(db.prepare('SELECT booked FROM pickup_slots WHERE id = ?').get(b.slot_id).booked, 0);
  assert.equal(db.prepare('SELECT booked FROM pickup_slots WHERE id = ?').get(target.id).booked, 1);
  const after = (await c.get(`/api/bookings/${code}`)).body.booking;
  assert.equal(after.status, 'Booked');
  assert.equal(after.collector_id, null);
});

test('past-cutoff bookings cannot be changed by the customer', async () => {
  const { db, customer, book } = await setup();
  const c = await customer();
  const code = await book(c, { later: true });
  db.prepare('UPDATE bookings SET cancellation_cutoff = ? WHERE booking_code = ?').run(new Date(Date.now() - 1000).toISOString(), code);
  assert.equal((await c.post(`/api/bookings/${code}/cancel`)).status, 409);
});

test('staff created by the admin must change their temporary password', async () => {
  const { admin, fresh } = await setup();
  await admin.post('/api/admin/users', { role: 'collector', name: 'New Staff', email: 'staff@test.invalid', phone: '9988700099', password: 'temporary-pass-1' });
  const k = fresh();
  await k.post('/api/auth/login', { email: 'staff@test.invalid', password: 'temporary-pass-1' });
  assert.equal((await k.get('/api/bookings')).body.code, 'password_change_required');
});

test('admin assigns and changes collectors with area validation, auditable history, and role restrictions', async () => {
  const { db, admin, customer, collector, book, fresh } = await setup();
  const c = await customer();
  const k1 = await collector();
  const k2 = await collector();

  const area1 = db.prepare("SELECT id, name FROM service_areas WHERE name = 'Visakhapatnam'").get();
  // Create a second service area
  const area2Res = await admin.post('/api/admin/entity/areas', {
    name: 'Anakapalle',
    city: 'Anakapalle',
    pincodes: '531001, 531002',
    active: true,
  });
  assert.equal(area2Res.status, 200, area2Res.body.error);
  const area2Id = area2Res.body.id;

  // Restrict k1 to Area 1, k2 to Area 2
  await admin.put(`/api/admin/users/${k1.userId}`, { area_ids: [area1.id] });
  await admin.put(`/api/admin/users/${k2.userId}`, { area_ids: [area2Id] });

  // Area query on admin users endpoint
  const colArea1 = (await admin.get(`/api/admin/users?role=collector&area_id=${area1.id}`)).body;
  assert.ok(colArea1.some((u) => u.id === k1.userId));
  assert.ok(!colArea1.some((u) => u.id === k2.userId));

  const colArea2 = (await admin.get(`/api/admin/users?role=collector&area_id=${area2Id}`)).body;
  assert.ok(colArea2.some((u) => u.id === k2.userId));
  assert.ok(!colArea2.some((u) => u.id === k1.userId));

  // Book in Area 1
  const code = await book(c, { later: true });

  // Validation: Missing collector_id
  const emptyRes = await admin.post(`/api/bookings/${code}/assign`, {});
  assert.equal(emptyRes.status, 400);

  // Validation: Collector does not serve booking's area
  const wrongAreaRes = await admin.post(`/api/bookings/${code}/assign`, { collector_id: k2.userId });
  assert.equal(wrongAreaRes.status, 400);
  assert.match(wrongAreaRes.body.error, /does not serve/i);

  // Validation: Non-admin cannot assign
  assert.equal((await c.post(`/api/bookings/${code}/assign`, { collector_id: k1.userId })).status, 403);
  assert.equal((await k1.post(`/api/bookings/${code}/assign`, { collector_id: k1.userId })).status, 403);
  const anon = fresh();
  assert.equal((await anon.post(`/api/bookings/${code}/assign`, { collector_id: k1.userId })).status, 401);

  // Successful assignment by admin
  const assignRes = await admin.post(`/api/bookings/${code}/assign`, { collector_id: k1.userId, route_order: 2 });
  assert.equal(assignRes.status, 200, assignRes.body.error);
  assert.equal(assignRes.body.status, 'Collector assigned');

  // Verify booking status and collector in DB
  const b = db.prepare('SELECT * FROM bookings WHERE booking_code = ?').get(code);
  assert.equal(b.status, 'Collector assigned');
  assert.equal(b.collector_id, k1.userId);
  assert.equal(b.route_order, 2);

  // Verify auditable status history entry with admin and timestamp
  const history = (await admin.get(`/api/bookings/${code}`)).body.history;
  const assignHistory = history.find((h) => h.status === 'Collector assigned');
  assert.ok(assignHistory, 'status history must have Collector assigned entry');
  assert.equal(assignHistory.by_name, 'Administrator');
  assert.ok(assignHistory.at);
  assert.match(assignHistory.note, /Assigned to/);

  // Verify audit log
  const auditLogs = (await admin.get('/api/admin/audit')).body;
  const assignAudit = auditLogs.find((a) => a.entity === 'booking' && a.entity_id === b.id && a.action === 'assign');
  assert.ok(assignAudit, 'audit log must have assign entry');
  assert.equal(assignAudit.actor_name, 'Administrator');

  // Customer sees assigned collector (first name) and status
  const customerBooking = (await c.get(`/api/bookings/${code}`)).body.booking;
  assert.equal(customerBooking.status, 'Collector assigned');
  assert.ok(customerBooking.collector_name);

  const customerList = (await c.get('/api/bookings')).body;
  assert.equal(customerList[0].collector_name, customerBooking.collector_name);

  // Assigned collector sees the booking
  const k1Bookings = (await k1.get('/api/bookings')).body;
  assert.ok(k1Bookings.some((x) => x.booking_code === code));
  assert.equal((await k1.get(`/api/bookings/${code}`)).status, 200);

  // Other collector cannot see this booking
  assert.equal((await k2.get(`/api/bookings/${code}`)).status, 404);

  // Reassignment: Add Area 1 to k2's served areas and reassign to k2
  await admin.put(`/api/admin/users/${k2.userId}`, { area_ids: [area1.id, area2Id] });
  const reassignRes = await admin.post(`/api/bookings/${code}/assign`, { collector_id: k2.userId, route_order: 1 });
  assert.equal(reassignRes.status, 200);

  const afterReassign = db.prepare('SELECT * FROM bookings WHERE booking_code = ?').get(code);
  assert.equal(afterReassign.collector_id, k2.userId);
  assert.equal(afterReassign.route_order, 1);
  assert.equal(afterReassign.status, 'Collector assigned');

  // Verify new status history entry for reassignment
  const updatedHistory = (await admin.get(`/api/bookings/${code}`)).body.history;
  const reassignHistory = updatedHistory[updatedHistory.length - 1];
  assert.equal(reassignHistory.status, 'Collector assigned');
  assert.match(reassignHistory.note, /Reassigned from/);

  // Now k2 sees the booking, k1 gets 404
  assert.equal((await k2.get(`/api/bookings/${code}`)).status, 200);
  assert.equal((await k1.get(`/api/bookings/${code}`)).status, 404);

  // Deactivated collector cannot be assigned
  await admin.put(`/api/admin/users/${k2.userId}`, { active: false });
  const deactRes = await admin.post(`/api/bookings/${code}/assign`, { collector_id: k2.userId });
  assert.equal(deactRes.status, 400);
  assert.match(deactRes.body.error, /active collector/i);

  // Area-name formatting differences: spaces, casing, punctuation match reliably
  const k3 = await collector();
  await admin.put(`/api/admin/users/${k3.userId}`, { area_names: ['  visakhapatnam  '] });
  const k3Info = (await admin.get(`/api/admin/users?role=collector&area_id=${area1.id}`)).body;
  assert.ok(k3Info.some((u) => u.id === k3.userId), 'collector with formatted area name should match area id');

  const code2 = await book(c, { later: true });
  const k3AssignRes = await admin.post(`/api/bookings/${code2}/assign`, { collector_id: k3.userId, route_order: 5 });
  assert.equal(k3AssignRes.status, 200, k3AssignRes.body.error);
  assert.equal(k3AssignRes.body.status, 'Collector assigned');
  const b2 = db.prepare('SELECT * FROM bookings WHERE booking_code = ?').get(code2);
  assert.equal(b2.collector_id, k3.userId);
  assert.equal(b2.status, 'Collector assigned');

  // Closed booking cannot be assigned
  await admin.put(`/api/admin/users/${k1.userId}`, { active: true });
  await admin.post(`/api/bookings/${code}/cancel`, { reason: 'Test cancel' });
  const closedRes = await admin.post(`/api/bookings/${code}/assign`, { collector_id: k1.userId });
  assert.equal(closedRes.status, 409);
});

test('admin secure collector editing, duplicate email check, unauthorized access, and forced password-change flow', async () => {
  const { db, admin, customer, collector, fresh } = await setup();

  const c = await customer();
  const k = await collector();

  // 1. Unauthorized access checks
  const unauth = fresh();
  assert.equal((await unauth.put(`/api/admin/users/${k.userId}`, { name: 'Hacked' })).status, 401);
  assert.equal((await unauth.post(`/api/admin/users/${k.userId}/temporary-password`, { password: 'hack-pass-12345' })).status, 401);

  assert.equal((await c.put(`/api/admin/users/${k.userId}`, { name: 'Customer Edit' })).status, 403);
  assert.equal((await c.post(`/api/admin/users/${k.userId}/temporary-password`, { password: 'hack-pass-12345' })).status, 403);

  assert.equal((await k.put(`/api/admin/users/${k.userId}`, { name: 'Collector Edit Self' })).status, 403);
  assert.equal((await k.post(`/api/admin/users/${k.userId}/temporary-password`, { password: 'hack-pass-12345' })).status, 403);

  // 2. Profile updates (name, phone, email, active status, availability, service areas, exception notes)
  const allAreas = db.prepare('SELECT id FROM service_areas').all();
  const updateRes = await admin.put(`/api/admin/users/${k.userId}`, {
    name: 'Updated Collector Name',
    phone: '9876543210',
    email: 'collector.updated@test.invalid',
    active: true,
    availability: 'Mon-Fri 08:00 - 16:00',
    exception_notes: 'Prefers morning routes; heavy vehicles capable.',
    area_ids: [allAreas[0].id],
  });
  assert.equal(updateRes.status, 200, updateRes.body.error);

  // Verify updated profile via admin API
  const colUser = (await admin.get(`/api/admin/users/${k.userId}`)).body;
  assert.equal(colUser.name, 'Updated Collector Name');
  assert.equal(colUser.phone, '9876543210');
  assert.equal(colUser.email, 'collector.updated@test.invalid');
  assert.equal(colUser.active, 1);
  assert.equal(colUser.availability, 'Mon-Fri 08:00 - 16:00');
  assert.equal(colUser.exception_notes, 'Prefers morning routes; heavy vehicles capable.');
  assert.deepEqual(colUser.area_ids, [allAreas[0].id]);

  // Verify audit log for profile update does not reveal any password
  const auditLogs = db.prepare("SELECT * FROM audit_log WHERE entity = 'user' AND entity_id = ? AND action = 'update' ORDER BY id DESC").all(k.userId);
  assert.ok(auditLogs.length > 0);
  const latestUpdateAudit = JSON.parse(auditLogs[0].details);
  assert.equal(latestUpdateAudit.name, 'Updated Collector Name');
  assert.equal(latestUpdateAudit.email, 'collector.updated@test.invalid');
  assert.equal(latestUpdateAudit.availability, 'Mon-Fri 08:00 - 16:00');
  assert.equal(latestUpdateAudit.password, undefined);
  assert.equal(latestUpdateAudit.password_hash, undefined);

  // 3. Duplicate email validation
  // Cannot update to an existing user's email
  const dupUpdate = await admin.put(`/api/admin/users/${k.userId}`, { email: 'c1@test.invalid' });
  assert.equal(dupUpdate.status, 409);
  assert.match(dupUpdate.body.error, /already registered/i);

  // Required field validations
  const emptyName = await admin.put(`/api/admin/users/${k.userId}`, { name: '   ' });
  assert.equal(emptyName.status, 400);

  const invalidEmail = await admin.put(`/api/admin/users/${k.userId}`, { email: 'notanemail' });
  assert.equal(invalidEmail.status, 400);

  const invalidPhone = await admin.put(`/api/admin/users/${k.userId}`, { phone: '12345' });
  assert.equal(invalidPhone.status, 400);

  // 4. Temporary password reset
  // Short password rejected
  const shortPw = await admin.post(`/api/admin/users/${k.userId}/temporary-password`, { password: 'short' });
  assert.equal(shortPw.status, 400);
  assert.match(shortPw.body.error, /at least 10 characters/i);

  // Successful temporary password reset
  const tempPwRes = await admin.post(`/api/admin/users/${k.userId}/temporary-password`, { password: 'temporary-reset-pw-123' });
  assert.equal(tempPwRes.status, 200, tempPwRes.body.error);
  assert.ok(tempPwRes.body.ok);

  // Verify audit log for password reset does not log the plaintext password
  const pwAudit = db.prepare("SELECT * FROM audit_log WHERE entity = 'user' AND entity_id = ? AND action = 'set_temporary_password' ORDER BY id DESC").get(k.userId);
  assert.ok(pwAudit);
  assert.ok(!pwAudit.details.includes('temporary-reset-pw-123'));

  // Existing session of k must be terminated
  const oldSessionCheck = await k.get('/api/bookings');
  assert.equal(oldSessionCheck.status, 401);

  // Login with old password fails
  const loginOld = await fresh().post('/api/auth/login', { email: 'collector.updated@test.invalid', password: 'collector-pass-1' });
  assert.equal(loginOld.status, 401);

  // Login with new temporary password succeeds, but must_change_password is true
  const kNewSession = fresh();
  const loginTemp = await kNewSession.post('/api/auth/login', { email: 'collector.updated@test.invalid', password: 'temporary-reset-pw-123' });
  assert.equal(loginTemp.status, 200);
  assert.equal(loginTemp.body.user.must_change_password, true);

  // Protected routes are gated
  const gatedRes = await kNewSession.get('/api/bookings');
  assert.equal(gatedRes.status, 403);
  assert.equal(gatedRes.body.code, 'password_change_required');

  // Forced password-change flow: collector sets permanent password
  const changeRes = await kNewSession.post('/api/auth/change-password', {
    current_password: 'temporary-reset-pw-123',
    new_password: 'permanent-final-pw-999',
  });
  assert.equal(changeRes.status, 200, changeRes.body.error);

  // Now protected routes are open
  const openRes = await kNewSession.get('/api/bookings');
  assert.equal(openRes.status, 200);

  // Account deactivation terminates sessions and blocks login
  await admin.put(`/api/admin/users/${k.userId}`, { active: false });
  assert.equal((await kNewSession.get('/api/bookings')).status, 401);

  const loginDeact = await fresh().post('/api/auth/login', { email: 'collector.updated@test.invalid', password: 'permanent-final-pw-999' });
  assert.equal(loginDeact.status, 403);
  assert.match(loginDeact.body.error, /inactive/i);
});

test('configurable points rules, collector pending calculation, admin approval/rejection, balance calculations, and unauthorized access', async () => {
  const { db, admin, customer, collector, book, assign, fresh } = await setup();
  const c = await customer();
  const k = await collector();

  // 1. Unauthorized access checks
  const unauth = fresh();
  assert.equal((await unauth.get('/api/admin/rules')).status, 401);
  assert.equal((await unauth.post('/api/admin/rules', { category_id: 1, valuation_method: 'per_item', rate_type: 'points', rate: 10, effective_date: '2026-01-01', active: true })).status, 401);
  assert.equal((await unauth.post('/api/admin/wallet/1/review', { decision: 'approve' })).status, 401);

  assert.equal((await c.get('/api/admin/rules')).status, 403);
  assert.equal((await c.post('/api/admin/rules', { category_id: 1, valuation_method: 'per_item', rate_type: 'points', rate: 10, effective_date: '2026-01-01', active: true })).status, 403);
  assert.equal((await c.post('/api/admin/wallet/1/review', { decision: 'approve' })).status, 403);

  assert.equal((await k.get('/api/admin/rules')).status, 403);
  assert.equal((await k.post('/api/admin/rules', { category_id: 1, valuation_method: 'per_item', rate_type: 'points', rate: 10, effective_date: '2026-01-01', active: true })).status, 403);
  assert.equal((await k.post('/api/admin/wallet/1/review', { decision: 'approve' })).status, 403);

  // 2. Admin creates and edits points rules (per item and per kg)
  // Validation checks on rules creation
  const badMethod = await admin.post('/api/admin/rules', { category_id: 1, valuation_method: 'invalid_method', rate_type: 'points', rate: 10, effective_date: '2026-01-01' });
  assert.equal(badMethod.status, 400);

  const badRate = await admin.post('/api/admin/rules', { category_id: 1, valuation_method: 'per_item', rate_type: 'points', rate: -5, effective_date: '2026-01-01' });
  assert.equal(badRate.status, 400);

  // Create per_item rule for category 1 (Mobile phones)
  const ruleItemRes = await admin.post('/api/admin/rules', {
    category_id: 1,
    valuation_method: 'per_item',
    rate_type: 'points',
    rate: 40,
    effective_date: '2026-01-01',
    active: true,
    admin_notes: '40 points per phone',
  });
  assert.equal(ruleItemRes.status, 200, ruleItemRes.body.error);
  const ruleItemId = ruleItemRes.body.id;

  // Create per_kg rule for category 2 (Laptops)
  const ruleKgRes = await admin.post('/api/admin/rules', {
    category_id: 2,
    valuation_method: 'per_kg',
    rate_type: 'points',
    rate: 25,
    effective_date: '2026-01-01',
    active: true,
    admin_notes: 'Initial 25 pts/kg',
  });
  assert.equal(ruleKgRes.status, 200, ruleKgRes.body.error);
  const ruleKgId = ruleKgRes.body.id;

  // Rule update: Update per_kg rule rate from 25 to 30
  const updateRuleRes = await admin.put(`/api/admin/rules/${ruleKgId}`, {
    rate: 30,
    admin_notes: 'Updated to 30 pts/kg',
  });
  assert.equal(updateRuleRes.status, 200, updateRuleRes.body.error);

  const updatedRule = (await admin.get(`/api/admin/rules/${ruleKgId}`)).body;
  assert.equal(updatedRule.rate, 30);
  assert.equal(updatedRule.valuation_method, 'per_kg');

  // Verify customer sees published rules for both methods
  const custWalletBefore = (await c.get('/api/wallet')).body;
  assert.ok(custWalletBefore.rules.some((r) => r.category_name === 'Mobile phones & tablets' && r.valuation_method === 'per_item' && r.rate === 40));
  assert.ok(custWalletBefore.rules.some((r) => r.category_name === 'Laptops & computers' && r.valuation_method === 'per_kg' && r.rate === 30));

  // 3. Collector records pickup: creates pending wallet transactions with quantities/weights & rule used
  const code = await book(c, { later: true, items: [{ category_id: 1, est_qty: 3 }, { category_id: 2, est_qty: 1 }] });
  await assign(code, k);
  const collectRes = await k.post(`/api/bookings/${code}/collect`, {
    items: [
      { category_id: 1, quantity: 3 }, // 3 items * 40 pts = 120 pts
      { category_id: 2, weight_kg: 5.5 }, // 5.5 kg * 30 pts = 165 pts
    ],
  });
  assert.equal(collectRes.status, 200, collectRes.body.error);

  // Check pending transactions in admin view
  const pendingTxns = (await admin.get('/api/admin/wallet?status=Pending')).body.transactions;
  const phoneTxn = pendingTxns.find((t) => t.booking_code === code && t.category_id === 1);
  const laptopTxn = pendingTxns.find((t) => t.booking_code === code && t.category_id === 2);
  assert.ok(phoneTxn);
  assert.ok(laptopTxn);

  assert.equal(phoneTxn.status, 'Pending');
  assert.equal(phoneTxn.verified_qty, 3);
  assert.equal(phoneTxn.points, 120);
  assert.match(phoneTxn.rule_used, /40 points per item/);

  assert.equal(laptopTxn.status, 'Pending');
  assert.equal(laptopTxn.verified_weight_kg, 5.5);
  assert.equal(laptopTxn.points, 165);
  assert.match(laptopTxn.rule_used, /30 points per kg/);

  // Customer wallet balance shows pending points, but available balance is 0
  const custWalletAfterCollect = (await c.get('/api/wallet')).body;
  assert.equal(custWalletAfterCollect.balance.available, 0, 'Available balance must remain 0 while pending');
  assert.equal(custWalletAfterCollect.balance.pending, 120 + 165, 'Pending balance must sum all pending points');
  assert.equal(custWalletAfterCollect.transactions.length, 2);
  assert.equal(custWalletAfterCollect.transactions[0].status, 'Pending');

  // 4. Admin review: approval
  const approveRes = await admin.post(`/api/admin/wallet/${phoneTxn.id}/review`, {
    decision: 'approve',
    admin_note: 'Verified count matches intact phones',
  });
  assert.equal(approveRes.status, 200, approveRes.body.error);

  // Prevent duplicate approval
  const dupApproveRes = await admin.post(`/api/admin/wallet/${phoneTxn.id}/review`, { decision: 'approve' });
  assert.equal(dupApproveRes.status, 409);
  assert.match(dupApproveRes.body.error, /already approved/i);

  // Audit trail verification
  const auditLogs = db.prepare("SELECT * FROM audit_log WHERE entity = 'wallet_txn' AND entity_id = ? ORDER BY id DESC").all(phoneTxn.id);
  assert.ok(auditLogs.length > 0);
  assert.equal(auditLogs[0].action, 'approve');

  // Balance calculation verification after approval:
  // Approved transaction increases available balance; pending decreases accordingly
  const custWalletAfterApprove = (await c.get('/api/wallet')).body;
  assert.equal(custWalletAfterApprove.balance.available, 120, 'Available balance must increase by approved points');
  assert.equal(custWalletAfterApprove.balance.pending, 165, 'Pending balance must only include remaining pending transactions');

  // 5. Admin review: rejection
  const rejectRes = await admin.post(`/api/admin/wallet/${laptopTxn.id}/review`, {
    decision: 'reject',
    admin_note: 'Battery leaking and hazardous, cannot process for points',
  });
  assert.equal(rejectRes.status, 200, rejectRes.body.error);

  // Prevent duplicate review on rejected transaction
  const dupRejectRes = await admin.post(`/api/admin/wallet/${laptopTxn.id}/review`, { decision: 'reject', admin_note: 'Try again' });
  assert.equal(dupRejectRes.status, 409);
  assert.match(dupRejectRes.body.error, /already rejected/i);

  // Final balance calculation: available remains 120, pending drops to 0
  const custWalletFinal = (await c.get('/api/wallet')).body;
  assert.equal(custWalletFinal.balance.available, 120);
  assert.equal(custWalletFinal.balance.pending, 0);

  // Customer sees rejection note in transaction list
  const custRejectedTxn = custWalletFinal.transactions.find((t) => t.id === laptopTxn.id);
  assert.equal(custRejectedTxn.status, 'Rejected');
  assert.match(custRejectedTxn.admin_note, /hazardous/);
});

test('admin editing for Eco Wallet transactions, pending & approved corrections, balance changes, audit history, and unauthorized access', async () => {
  const { db, admin, customer, collector, book, assign, fresh } = await setup();
  const c = await customer();
  const k = await collector();

  // Rules setup: Category 1 (Phones, 40 pts/item), Category 2 (Laptops, 25 pts/kg)
  const r1 = await admin.post('/api/admin/rules', {
    category_id: 1, valuation_method: 'per_item', rate_type: 'points', rate: 40, effective_date: '2026-01-01', active: true,
  });
  const r2 = await admin.post('/api/admin/rules', {
    category_id: 2, valuation_method: 'per_kg', rate_type: 'points', rate: 25, effective_date: '2026-01-01', active: true,
  });

  const code = await book(c, { later: true, items: [{ category_id: 1, est_qty: 2 }] });
  await assign(code, k);
  await k.post(`/api/bookings/${code}/collect`, {
    items: [{ category_id: 1, quantity: 2 }], // 2 * 40 = 80 pts pending
  });

  const txns = (await admin.get('/api/admin/wallet?status=Pending')).body.transactions;
  const txn = txns.find((t) => t.booking_code === code);
  assert.ok(txn);
  assert.equal(txn.points, 80);
  assert.equal(txn.status, 'Pending');

  // 1. Unauthorized access checks
  const unauth = fresh();
  assert.equal((await unauth.put(`/api/admin/wallet/${txn.id}`, { verified_qty: 3 })).status, 401);
  assert.equal((await c.put(`/api/admin/wallet/${txn.id}`, { verified_qty: 3 })).status, 403);
  assert.equal((await k.put(`/api/admin/wallet/${txn.id}`, { verified_qty: 3 })).status, 403);

  // 2. Edit Pending transaction:
  // Admin changes category to Laptops (Category 2), weight to 6.0 kg (25 pts/kg -> 150 pts)
  const editPendingRes = await admin.put(`/api/admin/wallet/${txn.id}`, {
    category_id: 2,
    verified_qty: null,
    verified_weight_kg: 6.0,
    rule_id: r2.body.id,
    admin_note: 'Corrected category from phones to laptops per box label',
  });
  assert.equal(editPendingRes.status, 200, editPendingRes.body.error);
  assert.equal(editPendingRes.body.transaction.points, 150);
  assert.equal(editPendingRes.body.balance_impact, 0, 'Pending edits do not impact available balance directly');

  // Check pending transaction in DB / admin API
  const updatedPending = (await admin.get(`/api/admin/wallet/${txn.id}`)).body;
  assert.equal(updatedPending.category_id, 2);
  assert.equal(updatedPending.verified_weight_kg, 6.0);
  assert.equal(updatedPending.points, 150);
  assert.equal(updatedPending.status, 'Pending');

  // Customer wallet balance reflects updated pending points, available remains 0
  const custWalletPending = (await c.get('/api/wallet')).body;
  assert.equal(custWalletPending.balance.available, 0);
  assert.equal(custWalletPending.balance.pending, 150);

  // Verify audit log for pending edit
  const pendingAudit = db.prepare("SELECT * FROM audit_log WHERE entity = 'wallet_txn' AND entity_id = ? AND action = 'edit' ORDER BY id DESC").get(txn.id);
  assert.ok(pendingAudit);
  const pendingAuditDetails = JSON.parse(pendingAudit.details);
  assert.equal(pendingAuditDetails.before.category_id, 1);
  assert.equal(pendingAuditDetails.before.points, 80);
  assert.equal(pendingAuditDetails.after.category_id, 2);
  assert.equal(pendingAuditDetails.after.points, 150);

  // 3. Approve transaction
  const approveRes = await admin.post(`/api/admin/wallet/${txn.id}/review`, { decision: 'approve' });
  assert.equal(approveRes.status, 200);

  const custWalletApproved = (await c.get('/api/wallet')).body;
  assert.equal(custWalletApproved.balance.available, 150);
  assert.equal(custWalletApproved.balance.pending, 0);

  // 4. Edit Approved transaction:
  // Requires audit note
  const noNoteRes = await admin.put(`/api/admin/wallet/${txn.id}`, {
    verified_weight_kg: 8.0,
    rule_id: r2.body.id,
  });
  assert.equal(noNoteRes.status, 400);
  assert.match(noNoteRes.body.error, /audit note is required/i);

  // Successful correction to approved transaction with audit note
  // Weight 8.0 kg * 25 pts/kg = 200 pts (+50 balance impact)
  const editApprovedRes = await admin.put(`/api/admin/wallet/${txn.id}`, {
    category_id: 2,
    verified_weight_kg: 8.0,
    rule_id: r2.body.id,
    audit_note: 'Recalibrated scale showed extra 2kg adapter included',
    admin_note: 'Adapter included with laptop unit',
  });
  assert.equal(editApprovedRes.status, 200, editApprovedRes.body.error);
  assert.equal(editApprovedRes.body.transaction.points, 200);
  assert.equal(editApprovedRes.body.balance_impact, 50);

  // Customer available balance increases from 150 to 200 pts
  const custWalletAdjusted = (await c.get('/api/wallet')).body;
  assert.equal(custWalletAdjusted.balance.available, 200);
  assert.equal(custWalletAdjusted.balance.pending, 0);

  // Audit trail verification for approved correction
  const approvedAudit = db.prepare("SELECT * FROM audit_log WHERE entity = 'wallet_txn' AND entity_id = ? AND action = 'edit' ORDER BY id DESC").get(txn.id);
  assert.ok(approvedAudit);
  const approvedAuditDetails = JSON.parse(approvedAudit.details);
  assert.equal(approvedAuditDetails.before.points, 150);
  assert.equal(approvedAuditDetails.after.points, 200);
  assert.equal(approvedAuditDetails.balance_impact, 50);
  assert.equal(approvedAuditDetails.audit_note, 'Recalibrated scale showed extra 2kg adapter included');

  // 5. Safe balance reduction & status restrictions:
  // Set up redemption settings and customer redeems available points (locks txn in redemption)
  await admin.put('/api/admin/settings', { redemption_enabled: true, redemption_method: 'UPI transfer', redemption_min_points: 100, rupees_per_point: 0.1 });
  const redeemRes = await c.post('/api/wallet/redeem');
  assert.equal(redeemRes.status, 200);

  // Customer has 0 available points remaining
  assert.equal((await c.get('/api/wallet')).body.balance.available, 0);

  // Attempting to edit txn while locked in redemption is rejected with 409
  const editLockedRes = await admin.put(`/api/admin/wallet/${txn.id}`, {
    category_id: 2,
    verified_weight_kg: 9.0,
    rule_id: r2.body.id,
    audit_note: 'Attempted edit while in redemption',
  });
  assert.equal(editLockedRes.status, 409);
  assert.match(editLockedRes.body.error, /redemption/i);

  // Complete redemption so status becomes Redeemed
  const redemptionId = (await admin.get('/api/admin/redemptions')).body[0].id;
  await admin.post(`/api/admin/redemptions/${redemptionId}/fulfil`, { reference: 'UPI-REF-001' });

  // Attempting to edit a fulfilled/redeemed transaction is also rejected with 409
  const editRedeemedRes = await admin.put(`/api/admin/wallet/${txn.id}`, {
    category_id: 2,
    verified_weight_kg: 9.0,
    rule_id: r2.body.id,
    audit_note: 'Attempted edit after redemption fulfilled',
  });
  assert.equal(editRedeemedRes.status, 409);
  assert.match(editRedeemedRes.body.error, /redeemed/i);

  // Customer creates a new booking & transaction (40 pts)
  const code2 = await book(c, { later: true, items: [{ category_id: 1, est_qty: 1 }] });
  await assign(code2, k);
  await k.post(`/api/bookings/${code2}/collect`, { items: [{ category_id: 1, quantity: 1 }] });
  const txn2 = (await admin.get('/api/admin/wallet?status=Pending')).body.transactions.find((t) => t.booking_code === code2);
  await admin.post(`/api/admin/wallet/${txn2.id}/review`, { decision: 'approve' });

  assert.equal((await c.get('/api/wallet')).body.balance.available, 40);

  // Admin safely reduces approved points on txn2 using a lower rate rule (40 -> 10 pts)
  const rLow = await admin.post('/api/admin/rules', {
    category_id: 1, valuation_method: 'per_item', rate_type: 'points', rate: 10, effective_date: '2026-01-01', active: true,
  });
  const safeReduction = await admin.put(`/api/admin/wallet/${txn2.id}`, {
    category_id: 1,
    verified_qty: 1,
    rule_id: rLow.body.id,
    audit_note: 'Adjusted to lower tier rate rule',
  });
  assert.equal(safeReduction.status, 200, safeReduction.body.error);
  assert.equal(safeReduction.body.transaction.points, 10);
  assert.equal(safeReduction.body.balance_impact, -30);
  assert.equal((await c.get('/api/wallet')).body.balance.available, 10);

  // Verify that an attempted reduction exceeding available balance is safely rejected with 409
  // Create txn3 for 50 pts, approve it (available becomes 10 + 50 = 60 pts)
  const code3 = await book(c, { later: true, items: [{ category_id: 2, est_qty: 1 }] });
  await assign(code3, k);
  await k.post(`/api/bookings/${code3}/collect`, { items: [{ category_id: 2, weight_kg: 2.0 }] });
  const txn3 = (await admin.get('/api/admin/wallet?status=Pending')).body.transactions.find((t) => t.booking_code === code3);
  await admin.post(`/api/admin/wallet/${txn3.id}/review`, { decision: 'approve' });
  assert.equal((await c.get('/api/wallet')).body.balance.available, 60);

  // Customer redeems with lower minimum threshold
  await admin.put('/api/admin/settings', { redemption_min_points: 10 });
  const rRedeem3 = await c.post('/api/wallet/redeem');
  assert.equal(rRedeem3.status, 200);
  assert.equal((await c.get('/api/wallet')).body.balance.available, 0);

  // Now customer has 0 available points and txn3 is in redemption
  // Release txn3 from redemption for testing the negative balance check
  db.prepare("UPDATE wallet_txns SET redemption_id = NULL WHERE id = ?").run(txn3.id);
  // Now customer has 50 available points (from txn3)
  assert.equal((await c.get('/api/wallet')).body.balance.available, 50);

  // Artificially simulate a deduction or lower balance (e.g. 5 available points)
  db.prepare("INSERT INTO wallet_txns (customer_id, booking_id, category_id, verified_qty, rule_id, rule_used, points, rupee_value, status, created_at) VALUES (?, 1, 1, 1, 1, 'Adjustment', -45, 0, 'Approved', datetime('now'))").run(c.userId);
  assert.equal((await c.get('/api/wallet')).body.balance.available, 5);

  // Admin tries to reduce txn3 from 50 pts to 25 pts (diff = -25 pts)
  // Available balance is only 5 pts, 5 - 25 = -20 < 0 -> rejected with 409!
  const blockNegativeBal = await admin.put(`/api/admin/wallet/${txn3.id}`, {
    category_id: 2,
    verified_weight_kg: 1.0, // 1kg * 25 = 25 pts (diff -25)
    rule_id: r2.body.id,
    audit_note: 'Must be blocked because available balance is only 5',
  });
  assert.equal(blockNegativeBal.status, 409);
  assert.match(blockNegativeBal.body.error, /cannot reduce points/i);
});
