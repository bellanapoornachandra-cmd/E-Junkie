// E-Junkie API. Every permission and booking rule is enforced here, never only in the browser.
import { randomBytes, createHash } from 'node:crypto';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from './db.js';
import { SETTINGS, todayIST, addDays, slotStart, nowISO, round2, valuate, describeRule, normalisePhone } from './util.js';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

export const STATUSES = ['Booked', 'Collector assigned', 'On the way', 'Arrived', 'Collected', 'Received by recycler', 'Unable to collect', 'Cancelled'];
const OPEN_FOR_CUSTOMER = ['Booked', 'Collector assigned'];
const CLOSED = ['Collected', 'Received by recycler', 'Cancelled'];
const COLLECTABLE = ['Collector assigned', 'On the way', 'Arrived'];
const SESSION_DAYS = 14;
// Routes a signed-in user may still call while a password change is required (public routes are always open).
const PASSWORD_GATE_OPEN = new Set(['POST /api/auth/change-password']);

export function createApi(db) {
  const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  const all = (sql, ...p) => db.prepare(sql).all(...p.map(norm));
  const get = (sql, ...p) => db.prepare(sql).get(...p.map(norm));
  const run = (sql, ...p) => db.prepare(sql).run(...p.map(norm));
  const insert = (table, row) => {
    const keys = Object.keys(row);
    return Number(run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => row[k])).lastInsertRowid);
  };
  function tx(fn) {
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
  const audit = (entity, entity_id, action, actor, details) =>
    insert('audit_log', { entity, entity_id, action, actor_id: actor ? actor.id : null, at: nowISO(), details: details ? JSON.stringify(details) : null });

  // ---------------------------------------------------------------- settings
  function settings() {
    const out = {};
    for (const r of all('SELECT key, value FROM settings')) {
      const def = SETTINGS[r.key];
      if (!def) continue;
      out[r.key] = def.type === 'number' ? Number(r.value) : def.type === 'bool' ? r.value === '1' : r.value;
    }
    return out;
  }
  const redemptionAvailable = (s) => s.redemption_enabled && s.redemption_method.trim() !== '';

  // ---------------------------------------------------------------- validation helpers
  const str = (v, label, { required = false, max = 500 } = {}) => {
    const s = v == null ? '' : String(v).trim();
    if (required && !s) fail(400, `${label} is required.`);
    if (s.length > max) fail(400, `${label} is too long (max ${max} characters).`);
    return s || null;
  };
  const int = (v, label, { min = 0, max = 100000, required = true } = {}) => {
    if ((v === '' || v == null) && !required) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) fail(400, `${label} must be a whole number between ${min} and ${max}.`);
    return n;
  };
  const num = (v, label, { min = 0, max = 100000, required = true } = {}) => {
    if ((v === '' || v == null) && !required) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) fail(400, `${label} must be a number between ${min} and ${max}.`);
    return n;
  };
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !Number.isNaN(Date.parse(v));
  const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v || '');
  const phone = (v, label = 'Phone number') => normalisePhone(v) || fail(400, `${label} must be a valid 10-digit Indian mobile number.`);
  const pin = (v) => (/^\d{6}$/.test(String(v || '').trim()) ? String(v).trim() : fail(400, 'PIN code must be 6 digits.'));

  // ---------------------------------------------------------------- lookups
  const areaForPin = (p, activeOnly = true) =>
    get(
      `SELECT * FROM service_areas WHERE (',' || replace(pincodes, ' ', '') || ',') LIKE '%,' || ? || ',%' ${activeOnly ? 'AND active = 1' : ''} ORDER BY active DESC LIMIT 1`,
      p,
    );

  function availableSlots(areaId) {
    const s = settings();
    const today = todayIST();
    const earliest = Date.now() + s.min_lead_hours * 3600e3;
    return all(
      `SELECT id, date, start_time, end_time, capacity, booked FROM pickup_slots
       WHERE area_id = ? AND active = 1 AND date BETWEEN ? AND ? AND booked < capacity ORDER BY date, start_time`,
      areaId, today, addDays(today, s.booking_window_days),
    )
      .filter((r) => slotStart(r.date, r.start_time).getTime() >= earliest)
      .map((r) => ({ ...r, remaining: r.capacity - r.booked }));
  }

  // Throws unless the slot is active, in an active area, inside the booking window and has capacity.
  function assertSlotBookable(slotId, areaId) {
    const slot = get('SELECT s.*, a.active AS area_active FROM pickup_slots s JOIN service_areas a ON a.id = s.area_id WHERE s.id = ?', slotId);
    if (!slot) fail(400, 'Please choose a pickup slot.');
    if (slot.area_id !== areaId) fail(400, 'That slot is for a different service area.');
    if (!slot.area_active) fail(409, 'We are not collecting in this area right now.');
    if (!availableSlots(areaId).some((s) => s.id === slot.id)) fail(409, 'That slot is no longer available. Please pick another one.');
    return slot;
  }

  function takeSlot(slotId) {
    const r = run('UPDATE pickup_slots SET booked = booked + 1 WHERE id = ? AND active = 1 AND booked < capacity', slotId);
    if (r.changes !== 1) fail(409, 'That slot has just filled up. Please pick another one.');
  }
  const releaseSlot = (slotId) => run('UPDATE pickup_slots SET booked = booked - 1 WHERE id = ? AND booked > 0', slotId);

  const cutoffFor = (slot) => new Date(slotStart(slot.date, slot.start_time).getTime() - settings().cancellation_cutoff_hours * 3600e3).toISOString();

  function newBookingCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const day = todayIST().slice(2).replace(/-/g, '');
    for (;;) {
      const tail = Array.from(randomBytes(4), (b) => alphabet[b % alphabet.length]).join('');
      const code = `EJ-${day}-${tail}`;
      if (!get('SELECT 1 FROM bookings WHERE booking_code = ?', code)) return code;
    }
  }

  const addHistory = (bookingId, status, user, note) =>
    insert('status_history', { booking_id: bookingId, status, at: nowISO(), by_user_id: user ? user.id : null, note: note || null });

  function normalizeAreaName(name) {
    if (!name) return '';
    return String(name)
      .trim()
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ');
  }

  function areaNamesMatch(name1, name2) {
    if (!name1 || !name2) return false;
    const s1 = String(name1).trim().toLowerCase();
    const s2 = String(name2).trim().toLowerCase();
    if (s1 === s2) return true;
    const n1 = normalizeAreaName(name1);
    const n2 = normalizeAreaName(name2);
    return Boolean(n1 && n2 && n1 === n2);
  }

  function collectorServesArea(collectorId, areaId, areaName) {
    let bookingArea = null;
    if (areaId) bookingArea = get('SELECT * FROM service_areas WHERE id = ?', areaId);
    if (!bookingArea && areaName) {
      bookingArea = get('SELECT * FROM service_areas WHERE lower(trim(name)) = lower(trim(?))', areaName);
    }
    if (bookingArea && !bookingArea.active) return false;

    const bId = bookingArea ? bookingArea.id : (areaId || null);
    const bName = bookingArea ? bookingArea.name : (areaName || '');

    const assigned = all(
      'SELECT a.id, a.name, a.active FROM collector_areas ca JOIN service_areas a ON a.id = ca.area_id WHERE ca.collector_id = ?',
      collectorId,
    );
    if (!assigned.length) {
      return bookingArea ? Boolean(bookingArea.active) : true;
    }

    return assigned.some((a) => {
      if (!a.active) return false;
      if (bId && Number(a.id) === Number(bId)) return true;
      if (bName && areaNamesMatch(a.name, bName)) return true;
      return false;
    });
  }

  const BOOKING_SELECT = `
    SELECT b.*, a.name AS area_name, c.name AS customer_name, c.email AS customer_email, col.name AS collector_name,
      (SELECT group_concat(ic.name || ' × ' || bi.est_qty, ', ') FROM booking_items bi JOIN item_categories ic ON ic.id = bi.category_id WHERE bi.booking_id = b.id) AS items_summary
    FROM bookings b
    LEFT JOIN service_areas a ON a.id = b.area_id
    JOIN users c ON c.id = b.customer_id
    LEFT JOIN users col ON col.id = b.collector_id`;

  function canModify(b, user) {
    if (user.role === 'admin') return !CLOSED.includes(b.status);
    if (user.role === 'customer') return b.customer_id === user.id && OPEN_FOR_CUSTOMER.includes(b.status) && Date.now() < Date.parse(b.cancellation_cutoff);
    return false;
  }

  // Shape a booking row for the viewer: customers never see other people's data, collectors only see what they need.
  function present(b, user) {
    const out = { ...b, can_modify: canModify(b, user) };
    if (user.role === 'customer') {
      delete out.customer_email;
      out.collector_name = b.collector_name ? b.collector_name.split(' ')[0] : null;
    }
    if (user.role === 'collector') delete out.customer_email;
    return out;
  }

  function loadBooking(user, ref) {
    const b = get(`${BOOKING_SELECT} WHERE b.booking_code = ? OR b.id = ?`, String(ref), Number(ref) || -1);
    const visible =
      b && (user.role === 'admin' || (user.role === 'customer' && b.customer_id === user.id) || (user.role === 'collector' && b.collector_id === user.id));
    if (!visible) fail(404, 'Booking not found.');
    return b;
  }

  // ---------------------------------------------------------------- wallet helpers
  const findRule = (categoryId, date, preferredMethod) => {
    if (preferredMethod) {
      const match = get(
        'SELECT * FROM eco_rules WHERE category_id = ? AND valuation_method = ? AND active = 1 AND effective_date <= ? ORDER BY effective_date DESC, id DESC LIMIT 1',
        categoryId, preferredMethod, date,
      );
      if (match) return match;
    }
    return get(
      'SELECT * FROM eco_rules WHERE category_id = ? AND active = 1 AND effective_date <= ? ORDER BY effective_date DESC, id DESC LIMIT 1',
      categoryId, date,
    );
  };

  function walletBalance(customerId) {
    const r = get(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'Approved' AND redemption_id IS NULL THEN points END), 0) AS available,
         COALESCE(SUM(CASE WHEN status = 'Pending' THEN points END), 0) AS pending,
         COALESCE(SUM(CASE WHEN status = 'Approved' AND redemption_id IS NOT NULL THEN points END), 0) AS in_redemption,
         COALESCE(SUM(CASE WHEN status = 'Redeemed' THEN points END), 0) AS redeemed,
         COUNT(CASE WHEN status = 'Pending' THEN 1 END) AS pending_count
       FROM wallet_txns WHERE customer_id = ?`,
      customerId,
    );
    const s = settings();
    return { ...r, available_rupees: round2(r.available * s.rupees_per_point), rupees_per_point: s.rupees_per_point, point_value_is_sample: s.point_value_is_sample };
  }

  const WALLET_SELECT = `
    SELECT w.*, ic.name AS category_name, b.booking_code, b.requested_date, u.name AS customer_name, r.name AS reviewed_by_name,
      ci.quantity AS collected_qty, ci.weight_kg AS collected_weight_kg
    FROM wallet_txns w
    JOIN item_categories ic ON ic.id = w.category_id
    JOIN bookings b ON b.id = w.booking_id
    JOIN users u ON u.id = w.customer_id
    LEFT JOIN users r ON r.id = w.reviewed_by
    LEFT JOIN collected_items ci ON ci.id = w.collected_item_id`;

  function presentTxn(t, user) {
    if (user.role === 'admin') return t;
    // Customers see who reviewed only as "E-Junkie team"; the audit trail with names stays with admins.
    const { reviewed_by, reviewed_by_name, customer_name, ...rest } = t;
    return { ...rest, reviewed: Boolean(reviewed_by) };
  }

  // ---------------------------------------------------------------- auth
  const tokenHash = (t) => createHash('sha256').update(t).digest('hex');
  const publicUser = (u) => u && { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, must_change_password: Boolean(u.must_change_password) };

  function userFromRequest(req) {
    const token = parseCookies(req.headers.cookie).ej_session;
    if (!token) return null;
    return get(
      'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1',
      tokenHash(token), nowISO(),
    ) || null;
  }

  function startSession(userId) {
    const token = randomBytes(32).toString('base64url');
    run('DELETE FROM sessions WHERE expires_at < ?', nowISO());
    insert('sessions', { token_hash: tokenHash(token), user_id: userId, expires_at: new Date(Date.now() + SESSION_DAYS * 864e5).toISOString() });
    return { cookie: `ej_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}` };
  }

  // ---------------------------------------------------------------- routes
  const routes = [];
  const route = (method, pattern, roles, handler) =>
    routes.push({ method, roles, handler, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`) });

  // Public ------------------------------------------------------------------
  route('GET', '/api/public/config', null, () => {
    const s = settings();
    const recyclers = all('SELECT name, certification_claim FROM recyclers WHERE active = 1 AND verified = 1 AND show_certified = 1 AND certification_claim IS NOT NULL');
    return {
      categories: all('SELECT id, name, description, accepted, handling_notes FROM item_categories ORDER BY accepted DESC, sort_order, name'),
      areas: all('SELECT name, pincodes, active FROM service_areas ORDER BY active DESC, name'),
      fee: { rupees: s.pickup_fee_rupees, note: s.fee_note },
      cancellation_cutoff_hours: s.cancellation_cutoff_hours,
      booking_window_days: s.booking_window_days,
      certified_recyclers: recyclers,
      support: { phone: s.support_phone, email: s.support_email },
    };
  });

  route('GET', '/api/public/pincode/:pin', null, ({ params }) => {
    const p = pin(params.pin);
    const area = areaForPin(p, false);
    if (!area) return { serviceable: false, message: 'We do not collect in this PIN code yet.' };
    if (!area.active) return { serviceable: false, area: area.name, message: `${area.name} is not open for pickups yet.` };
    return { serviceable: true, area: area.name, city: area.city };
  });

  route('POST', '/api/auth/login', null, ({ body }) => {
    const u = get('SELECT * FROM users WHERE email = ?', String(body.email || '').trim());
    if (!u || !verifyPassword(String(body.password || ''), u.password_hash)) fail(401, 'Email or password is incorrect.');
    if (!u.active) fail(403, 'This account is inactive. Please contact support.');
    const { cookie } = startSession(u.id);
    return { $cookie: cookie, user: publicUser(u) };
  });

  route('POST', '/api/auth/signup', null, ({ body }) => {
    const name = str(body.name, 'Name', { required: true, max: 80 });
    const email = str(body.email, 'Email', { required: true, max: 120 });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'Please enter a valid email address.');
    const ph = phone(body.phone);
    if (String(body.password || '').length < MIN_PASSWORD_LENGTH) fail(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    if (get('SELECT 1 FROM users WHERE email = ?', email)) fail(409, 'An account with this email already exists. Please log in.');
    const id = insert('users', { name, email, phone: ph, role: 'customer', active: 1, password_hash: hashPassword(body.password), created_at: nowISO() });
    const { cookie } = startSession(id);
    return { $cookie: cookie, user: publicUser(get('SELECT * FROM users WHERE id = ?', id)) };
  });

  route('POST', '/api/auth/logout', null, ({ req }) => {
    const token = parseCookies(req.headers.cookie).ej_session;
    if (token) run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
    return { $cookie: 'ej_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0', ok: true };
  });

  route('GET', '/api/me', null, ({ user }) => ({ user: publicUser(user) }));

  route('POST', '/api/auth/change-password', 'any', ({ user, body }) => {
    if (!verifyPassword(String(body.current_password || ''), user.password_hash)) fail(400, 'Your current password is incorrect.');
    const next = String(body.new_password || '');
    if (next.length < MIN_PASSWORD_LENGTH) fail(400, `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    if (next === String(body.current_password)) fail(400, 'Choose a new password that is different from the current one.');
    // Sign out every other session; this browser gets a fresh one.
    const session = tx(() => {
      run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', hashPassword(next), user.id);
      run('DELETE FROM sessions WHERE user_id = ?', user.id);
      audit('user', user.id, 'change_password', user, null);
      return startSession(user.id);
    });
    return { $cookie: session.cookie, user: publicUser(get('SELECT * FROM users WHERE id = ?', user.id)) };
  });

  // Account (any signed-in user) -------------------------------------------
  route('PUT', '/api/account', 'any', ({ user, body }) => {
    const name = str(body.name, 'Name', { required: true, max: 80 });
    const ph = phone(body.phone);
    run('UPDATE users SET name = ?, phone = ? WHERE id = ?', name, ph, user.id);
    audit('user', user.id, 'update_own_profile', user, { name, phone: ph });
    return { user: publicUser(get('SELECT * FROM users WHERE id = ?', user.id)) };
  });

  function readAddress(body) {
    const p = pin(body.pincode);
    const area = areaForPin(p);
    if (!area) fail(400, 'We do not collect in this PIN code yet.');
    return {
      label: str(body.label, 'Label', { max: 40 }),
      address_line: str(body.address_line, 'Address', { required: true, max: 200 }),
      unit: str(body.unit, 'Flat / house number', { max: 100 }),
      area: area.name,
      city: area.city,
      pincode: p,
      access_instructions: str(body.access_instructions, 'Access instructions', { max: 300 }),
    };
  }

  route('GET', '/api/addresses', ['customer'], ({ user }) => all('SELECT * FROM addresses WHERE customer_id = ? AND archived = 0 ORDER BY id', user.id));
  route('POST', '/api/addresses', ['customer'], ({ user, body }) => {
    const id = insert('addresses', { ...readAddress(body), customer_id: user.id, created_at: nowISO() });
    return get('SELECT * FROM addresses WHERE id = ?', id);
  });
  route('PUT', '/api/addresses/:id', ['customer'], ({ user, params, body }) => {
    if (!get('SELECT 1 FROM addresses WHERE id = ? AND customer_id = ? AND archived = 0', params.id, user.id)) fail(404, 'Address not found.');
    const a = readAddress(body);
    run('UPDATE addresses SET label=?, address_line=?, unit=?, area=?, city=?, pincode=?, access_instructions=? WHERE id=?',
      a.label, a.address_line, a.unit, a.area, a.city, a.pincode, a.access_instructions, params.id);
    return get('SELECT * FROM addresses WHERE id = ?', params.id);
  });
  route('DELETE', '/api/addresses/:id', ['customer'], ({ user, params }) => {
    // Bookings keep their own copy of the address, so archiving is safe.
    const r = run('UPDATE addresses SET archived = 1 WHERE id = ? AND customer_id = ?', params.id, user.id);
    if (!r.changes) fail(404, 'Address not found.');
    return { ok: true };
  });

  // Slots ------------------------------------------------------------------
  route('GET', '/api/slots', 'any', ({ query }) => {
    const p = pin(query.pin);
    const area = areaForPin(p);
    if (!area) fail(400, 'We do not collect in this PIN code yet.');
    return { area: area.name, slots: availableSlots(area.id) };
  });

  // Bookings ----------------------------------------------------------------
  route('GET', '/api/bookings', 'any', ({ user }) => {
    let rows;
    if (user.role === 'customer') rows = all(`${BOOKING_SELECT} WHERE b.customer_id = ? ORDER BY b.requested_date DESC, b.time_window DESC`, user.id);
    else if (user.role === 'collector') rows = all(`${BOOKING_SELECT} WHERE b.collector_id = ? ORDER BY b.requested_date, b.time_window, COALESCE(b.route_order, 999)`, user.id);
    else rows = all(`${BOOKING_SELECT} ORDER BY b.requested_date DESC, b.time_window, COALESCE(b.route_order, 999) LIMIT 2000`);
    return rows.map((b) => present(b, user));
  });

  route('GET', '/api/bookings/:ref', 'any', ({ user, params }) => {
    const b = loadBooking(user, params.ref);
    const history = all(
      `SELECT h.status, h.at, h.note, u.name AS by_name, u.role AS by_role FROM status_history h LEFT JOIN users u ON u.id = h.by_user_id
       WHERE h.booking_id = ? ORDER BY h.at, h.id`, b.id,
    ).map((h) => (user.role === 'admin' ? h : { ...h, by_name: h.by_role === 'customer' ? 'You' : h.by_role === 'collector' ? 'Collector' : 'E-Junkie team' }));
    const items = all('SELECT bi.category_id, bi.est_qty, ic.name, ic.handling_notes FROM booking_items bi JOIN item_categories ic ON ic.id = bi.category_id WHERE bi.booking_id = ?', b.id);
    const collected = all('SELECT ci.id, ci.category_id, ci.quantity, ci.weight_kg, ic.name FROM collected_items ci JOIN item_categories ic ON ic.id = ci.category_id WHERE ci.booking_id = ?', b.id);
    const handoff = get(
      `SELECT h.reference, h.handoff_date, h.receipt_ref, r.name AS recycler_name,
         CASE WHEN r.verified = 1 AND r.show_certified = 1 THEN r.certification_claim END AS certification_claim
       FROM handoff_bookings hb JOIN recycler_handoffs h ON h.id = hb.handoff_id JOIN recyclers r ON r.id = h.recycler_id WHERE hb.booking_id = ?`, b.id,
    );
    const collectedBy = b.collected_by ? get('SELECT name FROM users WHERE id = ?', b.collected_by) : null;
    const out = { booking: present(b, user), history, items, collected, handoff: handoff || null, collected_by_name: collectedBy ? collectedBy.name.split(' ')[0] : null };
    if (user.role !== 'collector') {
      out.wallet = all(`${WALLET_SELECT} WHERE w.booking_id = ? ORDER BY w.id`, b.id).map((t) => presentTxn(t, user));
    }
    return out;
  });

  route('POST', '/api/bookings', ['customer'], ({ user, body }) => {
    const s = settings();
    // Items
    if (!Array.isArray(body.items) || body.items.length === 0) fail(400, 'Please choose at least one item category.');
    const seen = new Set();
    const items = body.items.map((it) => {
      const c = get('SELECT * FROM item_categories WHERE id = ?', it.category_id);
      if (!c || !c.accepted) fail(400, 'One of the chosen categories is not accepted.');
      if (seen.has(c.id)) fail(400, `${c.name} is listed twice.`);
      seen.add(c.id);
      return { category_id: c.id, est_qty: int(it.est_qty, `Quantity for ${c.name}`, { min: 1, max: 99 }) };
    });
    // Address
    let address;
    if (body.address_id) {
      address = get('SELECT * FROM addresses WHERE id = ? AND customer_id = ? AND archived = 0', body.address_id, user.id) || fail(400, 'Please choose one of your saved addresses.');
    } else {
      const a = readAddress(body.address || {});
      address = get('SELECT * FROM addresses WHERE id = ?', insert('addresses', { ...a, customer_id: user.id, created_at: nowISO() }));
    }
    const area = areaForPin(address.pincode) || fail(400, 'We do not collect in this PIN code yet.');
    const contact_name = str(body.contact_name, 'Contact name', { required: true, max: 80 });
    const contact_phone = phone(body.contact_phone, 'Contact phone');
    const customer_notes = str(body.customer_notes, 'Notes', { max: 500 });
    if (!body.data_wipe_ack) fail(400, 'Please confirm you will back up and erase personal data from your devices.');
    if (Number(body.accepted_fee) !== s.pickup_fee_rupees) fail(409, `The pickup fee has changed to ₹${s.pickup_fee_rupees}. Please review and confirm again.`);

    return tx(() => {
      const slot = assertSlotBookable(Number(body.slot_id), area.id);
      takeSlot(slot.id);
      const code = newBookingCode();
      const id = insert('bookings', {
        booking_code: code, customer_id: user.id, address_id: address.id,
        address_text: [address.unit, address.address_line, address.area, `${address.city} ${address.pincode}`].filter(Boolean).join(', '),
        access_instructions: address.access_instructions, area_id: area.id, slot_id: slot.id, requested_date: slot.date,
        time_window: `${slot.start_time}-${slot.end_time}`, contact_name, contact_phone, customer_notes, status: 'Booked',
        fee_rupees: s.pickup_fee_rupees, data_wipe_ack: 1, cancellation_cutoff: cutoffFor(slot), created_at: nowISO(),
      });
      for (const it of items) insert('booking_items', { booking_id: id, ...it });
      addHistory(id, 'Booked', user);
      return { booking_code: code };
    });
  });

  route('GET', '/api/bookings/:ref/slots', ['customer', 'admin'], ({ user, params }) => {
    const b = loadBooking(user, params.ref);
    return { area: b.area_name, slots: availableSlots(b.area_id).filter((s) => s.id !== b.slot_id) };
  });

  route('POST', '/api/bookings/:ref/cancel', ['customer', 'admin'], ({ user, params, body }) => {
    const b = loadBooking(user, params.ref);
    if (!canModify(b, user)) fail(409, user.role === 'customer' ? 'This pickup can no longer be cancelled online. Please contact support.' : 'This booking is already closed.');
    const note = str(body.reason, 'Reason', { max: 300 });
    tx(() => {
      run("UPDATE bookings SET status = 'Cancelled' WHERE id = ?", b.id);
      releaseSlot(b.slot_id);
      addHistory(b.id, 'Cancelled', user, note || (user.role === 'customer' ? 'Cancelled by customer' : 'Cancelled by admin'));
      if (user.role === 'admin') audit('booking', b.id, 'cancel', user, { booking: b.booking_code, note });
    });
    return { ok: true };
  });

  route('POST', '/api/bookings/:ref/reschedule', ['customer', 'admin'], ({ user, params, body }) => {
    const b = loadBooking(user, params.ref);
    if (!canModify(b, user)) fail(409, user.role === 'customer' ? 'This pickup can no longer be rescheduled online. Please contact support.' : 'This booking is already closed.');
    if (Number(body.slot_id) === b.slot_id) fail(400, 'Please choose a different slot.');
    tx(() => {
      const slot = assertSlotBookable(Number(body.slot_id), b.area_id);
      releaseSlot(b.slot_id);
      takeSlot(slot.id);
      // A new date means the collector's route changes, so the booking goes back to the assignment queue.
      run(
        "UPDATE bookings SET slot_id = ?, requested_date = ?, time_window = ?, cancellation_cutoff = ?, status = 'Booked', collector_id = NULL, route_order = NULL WHERE id = ?",
        slot.id, slot.date, `${slot.start_time}-${slot.end_time}`, cutoffFor(slot), b.id,
      );
      const note = `Rescheduled from ${b.requested_date} ${b.time_window} to ${slot.date} ${slot.start_time}-${slot.end_time}`;
      addHistory(b.id, 'Booked', user, note);
      if (user.role === 'admin') audit('booking', b.id, 'reschedule', user, { booking: b.booking_code, note });
    });
    return { ok: true };
  });

  route('POST', '/api/bookings/:ref/assign', ['admin'], ({ user, params, body }) => {
    const b = loadBooking(user, params.ref);
    if (CLOSED.includes(b.status)) fail(409, 'This booking is already closed.');
    if (!body.collector_id) fail(400, 'Please choose an active collector.');
    const collector = get("SELECT * FROM users WHERE id = ? AND role = 'collector' AND active = 1", body.collector_id) || fail(400, 'Please choose an active collector.');
    if (!collectorServesArea(collector.id, b.area_id, b.area_name)) {
      fail(400, `${collector.name} does not serve the ${b.area_name || 'booking'} service area.`);
    }
    const route_order = int(body.route_order, 'Route order', { min: 1, max: 99, required: false });
    tx(() => {
      const changedCollector = b.collector_id !== collector.id;
      const prevCollectorName = b.collector_name;
      const status = 'Collector assigned';
      run('UPDATE bookings SET collector_id = ?, route_order = ?, status = ? WHERE id = ?', collector.id, route_order, status, b.id);
      const historyNote = changedCollector && prevCollectorName
        ? `Reassigned from ${prevCollectorName} to ${collector.name}`
        : `Assigned to ${collector.name}`;
      addHistory(b.id, 'Collector assigned', user, historyNote);
      audit('booking', b.id, 'assign', user, { booking: b.booking_code, collector: collector.name, route_order });
    });
    return { ok: true, status: 'Collector assigned', collector: { id: collector.id, name: collector.name }, route_order };
  });

  const COLLECTOR_TRANSITIONS = {
    'On the way': ['Collector assigned'],
    Arrived: ['Collector assigned', 'On the way'],
    'Unable to collect': COLLECTABLE,
  };
  route('POST', '/api/bookings/:ref/status', ['collector', 'admin'], ({ user, params, body }) => {
    const b = loadBooking(user, params.ref);
    const next = body.status;
    if (!COLLECTOR_TRANSITIONS[next]) fail(400, 'Unknown status.');
    if (!COLLECTOR_TRANSITIONS[next].includes(b.status)) fail(409, `Cannot move from “${b.status}” to “${next}”.`);
    const note = str(body.note, 'Note', { required: next === 'Unable to collect', max: 500 });
    tx(() => {
      run('UPDATE bookings SET status = ?, exception_note = COALESCE(?, exception_note) WHERE id = ?', next, next === 'Unable to collect' ? note : null, b.id);
      addHistory(b.id, next, user, note);
    });
    return { ok: true };
  });

  // Recording the collection is the only way into "Collected", and it creates the pending Eco Wallet entries.
  route('POST', '/api/bookings/:ref/collect', ['collector', 'admin'], ({ user, params, body }) => {
    const b = loadBooking(user, params.ref);
    const allowed = user.role === 'admin' ? [...COLLECTABLE, 'Booked', 'Unable to collect'] : COLLECTABLE;
    if (!allowed.includes(b.status)) fail(409, `A pickup that is “${b.status}” cannot be marked collected.`);
    if (!Array.isArray(body.items) || body.items.length === 0) fail(400, 'Enter at least one collected item category and quantity.');
    const rows = body.items.map((it) => {
      const c = get('SELECT id, name FROM item_categories WHERE id = ?', it.category_id) || fail(400, 'Unknown item category.');
      const quantity = int(it.quantity, `Count for ${c.name}`, { min: 0, max: 999, required: false });
      const weight_kg = num(it.weight_kg, `Weight for ${c.name}`, { min: 0, max: 2000, required: false });
      if (!quantity && !weight_kg) fail(400, `Enter a count or weight for ${c.name}.`);
      return { category_id: c.id, name: c.name, quantity: quantity ?? 0, weight_kg };
    });
    const exception = str(body.exception_note, 'Exception note', { max: 500 });
    const s = settings();
    tx(() => {
      run("UPDATE bookings SET status = 'Collected', collected_at = ?, collected_by = ?, exception_note = COALESCE(?, exception_note) WHERE id = ?", nowISO(), user.id, exception, b.id);
      addHistory(b.id, 'Collected', user, exception);
      const date = todayIST();
      for (const r of rows) {
        const ciId = insert('collected_items', { booking_id: b.id, category_id: r.category_id, quantity: r.quantity, weight_kg: r.weight_kg });
        let rule = null;
        if (r.weight_kg > 0 && !r.quantity) {
          rule = findRule(r.category_id, date, 'per_kg');
        } else if (r.quantity > 0 && !r.weight_kg) {
          rule = findRule(r.category_id, date, 'per_item');
        } else {
          rule = findRule(r.category_id, date, 'per_item') || findRule(r.category_id, date, 'per_kg') || findRule(r.category_id, date);
        }
        const v = valuate(rule, r.quantity, r.weight_kg, s.rupees_per_point);
        insert('wallet_txns', {
          customer_id: b.customer_id, booking_id: b.id, category_id: r.category_id, collected_item_id: ciId,
          verified_qty: r.quantity, verified_weight_kg: r.weight_kg, rule_id: rule ? rule.id : null, rule_used: describeRule(rule, r.name),
          points: v.points, rupee_value: v.rupee_value, status: 'Pending', created_at: nowISO(), admin_note: v.ok ? null : v.reason,
        });
      }
      audit('booking', b.id, 'record_collection', user, { booking: b.booking_code, items: rows, exception });
    });
    return { ok: true };
  });

  // Eco Wallet (customer) --------------------------------------------------
  route('GET', '/api/wallet', ['customer'], ({ user }) => {
    const s = settings();
    const today = todayIST();
    const rules = all(
      `SELECT r.*, ic.name AS category_name FROM eco_rules r JOIN item_categories ic ON ic.id = r.category_id
       WHERE r.active = 1 AND r.effective_date <= ? AND ic.accepted = 1
         AND r.id = (SELECT r2.id FROM eco_rules r2 WHERE r2.category_id = r.category_id AND r2.valuation_method = r.valuation_method AND r2.active = 1 AND r2.effective_date <= ? ORDER BY r2.effective_date DESC, r2.id DESC LIMIT 1)
       ORDER BY ic.sort_order, r.valuation_method`, today, today,
    ).map((r) => ({ category_name: r.category_name, valuation_method: r.valuation_method, rate_type: r.rate_type, rate: r.rate, is_sample: r.is_sample }));
    return {
      balance: walletBalance(user.id),
      transactions: all(`${WALLET_SELECT} WHERE w.customer_id = ? ORDER BY w.created_at DESC, w.id DESC`, user.id).map((t) => presentTxn(t, user)),
      redemptions: all('SELECT id, points, rupee_value, method, status, created_at, reviewed_at, reference FROM redemptions WHERE customer_id = ? ORDER BY id DESC', user.id),
      redemption: { available: redemptionAvailable(s), method: s.redemption_method, min_points: s.redemption_min_points },
      rules,
    };
  });

  route('POST', '/api/wallet/redeem', ['customer'], ({ user }) => {
    const s = settings();
    if (!redemptionAvailable(s)) fail(409, 'Redemption is not available yet.');
    return tx(() => {
      const bal = walletBalance(user.id);
      if (bal.available < s.redemption_min_points) fail(409, `You need at least ${s.redemption_min_points} available points to redeem.`);
      const id = insert('redemptions', {
        customer_id: user.id, points: bal.available, rupee_value: bal.available_rupees, method: s.redemption_method, status: 'Requested', created_at: nowISO(),
      });
      run("UPDATE wallet_txns SET redemption_id = ? WHERE customer_id = ? AND status = 'Approved' AND redemption_id IS NULL", id, user.id);
      audit('redemption', id, 'request', user, { points: bal.available });
      return { ok: true, points: bal.available };
    });
  });

  // Admin ------------------------------------------------------------------
  route('GET', '/api/admin/summary', ['admin'], () => {
    const today = todayIST();
    return {
      counts: all('SELECT status, COUNT(*) AS n FROM bookings GROUP BY status'),
      today: all(`${BOOKING_SELECT} WHERE b.requested_date = ? AND b.status != 'Cancelled' ORDER BY b.time_window, COALESCE(b.route_order, 999)`, today),
      unassigned: all(`${BOOKING_SELECT} WHERE b.status = 'Booked' AND b.requested_date >= ? ORDER BY b.requested_date, b.time_window`, today),
      exceptions: all(
        `${BOOKING_SELECT} WHERE (b.status = 'Unable to collect' OR (b.exception_note IS NOT NULL AND b.status = 'Collected')) AND b.requested_date >= ? ORDER BY b.requested_date DESC`,
        addDays(today, -30),
      ),
      pending_wallet: get("SELECT COUNT(*) AS n FROM wallet_txns WHERE status = 'Pending'").n,
      pending_redemptions: get("SELECT COUNT(*) AS n FROM redemptions WHERE status = 'Requested'").n,
      awaiting_handoff: get("SELECT COUNT(*) AS n FROM bookings WHERE status = 'Collected'").n,
    };
  });

  route('GET', '/api/admin/users', ['admin'], ({ query }) => {
    const role = ['customer', 'collector', 'admin'].includes(query.role) ? query.role : 'customer';
    const areaId = query.area_id ? Number(query.area_id) : null;
    const areaName = query.area_name ? String(query.area_name).trim() : null;
    const rows = all(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.active, u.availability, u.exception_notes, u.created_at,
         (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = u.id) AS bookings,
         (SELECT COUNT(*) FROM bookings b WHERE b.collector_id = u.id AND b.status NOT IN ('Cancelled','Collected','Received by recycler')) AS open_assignments,
         (SELECT COALESCE(SUM(points), 0) FROM wallet_txns w WHERE w.customer_id = u.id AND w.status = 'Approved' AND w.redemption_id IS NULL) AS available_points
       FROM users u WHERE u.role = ? ORDER BY u.active DESC, u.name`, role,
    );
    if (role === 'collector') {
      const allActiveAreas = all('SELECT id, name FROM service_areas WHERE active = 1');
      return rows
        .map((u) => {
          const assigned = all('SELECT a.id, a.name FROM collector_areas ca JOIN service_areas a ON a.id = ca.area_id WHERE ca.collector_id = ? AND a.active = 1', u.id);
          const effective = assigned.length ? assigned : allActiveAreas;
          return {
            ...u,
            has_custom_areas: assigned.length > 0,
            area_ids: effective.map((a) => a.id),
            area_names: effective.map((a) => a.name),
            assigned_area_ids: assigned.map((a) => a.id),
          };
        })
        .filter((u) => {
          if (areaId || areaName) {
            const matchesId = areaId && u.area_ids.some((id) => Number(id) === areaId);
            const matchesName = areaName && u.area_names.some((name) => areaNamesMatch(name, areaName));
            return Boolean(matchesId || matchesName);
          }
          return true;
        });
    }
    return rows;
  });

  route('GET', '/api/admin/users/:id', ['admin'], ({ params }) => {
    const u = get('SELECT id, name, email, phone, role, active, availability, exception_notes, created_at FROM users WHERE id = ?', params.id) || fail(404, 'User not found.');
    if (u.role === 'collector') {
      const assigned = all('SELECT a.id, a.name FROM collector_areas ca JOIN service_areas a ON a.id = ca.area_id WHERE ca.collector_id = ? AND a.active = 1', u.id);
      const allActiveAreas = all('SELECT id, name FROM service_areas WHERE active = 1');
      const effective = assigned.length ? assigned : allActiveAreas;
      return {
        ...u,
        has_custom_areas: assigned.length > 0,
        area_ids: effective.map((a) => a.id),
        area_names: effective.map((a) => a.name),
        assigned_area_ids: assigned.map((a) => a.id),
      };
    }
    return u;
  });

  route('POST', '/api/admin/users', ['admin'], ({ user, body }) => {
    const role = ['customer', 'collector', 'admin'].includes(body.role) ? body.role : fail(400, 'Choose a role.');
    const name = str(body.name, 'Name', { required: true, max: 80 });
    const email = str(body.email, 'Email', { required: true, max: 120 });
    if (get('SELECT 1 FROM users WHERE email = ?', email)) fail(409, 'That email is already registered.');
    if (String(body.password || '').length < MIN_PASSWORD_LENGTH) fail(400, `Temporary password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    const id = insert('users', {
      name,
      email,
      phone: phone(body.phone),
      role,
      active: 1,
      password_hash: hashPassword(body.password),
      must_change_password: 1,
      availability: body.availability ? str(body.availability, 'Availability', { max: 200 }) : null,
      exception_notes: body.exception_notes ? str(body.exception_notes, 'Exception notes', { max: 1000 }) : null,
      created_at: nowISO(),
    });
    if (role === 'collector') {
      const areaIds = new Set();
      if (Array.isArray(body.area_ids)) body.area_ids.forEach((aid) => areaIds.add(Number(aid)));
      if (body.area_id) areaIds.add(Number(body.area_id));
      if (body.area_names || body.area_name) {
        const names = Array.isArray(body.area_names) ? body.area_names : [body.area_name];
        const allAreas = all('SELECT id, name FROM service_areas');
        for (const aname of names) {
          const match = allAreas.find((a) => areaNamesMatch(a.name, aname));
          if (match) areaIds.add(match.id);
        }
      }
      for (const aid of areaIds) {
        if (get('SELECT 1 FROM service_areas WHERE id = ?', aid)) {
          insert('collector_areas', { collector_id: id, area_id: aid });
        }
      }
    }
    audit('user', id, 'create', user, { name, email, role, area_ids: body.area_ids || (body.area_id ? [body.area_id] : null) });
    return { id };
  });

  route('PUT', '/api/admin/users/:id', ['admin'], ({ user, params, body }) => {
    const target = get('SELECT * FROM users WHERE id = ?', params.id) || fail(404, 'User not found.');
    const changes = {};
    if (body.name !== undefined) changes.name = str(body.name, 'Name', { required: true, max: 80 });
    if (body.email !== undefined) {
      const email = str(body.email, 'Email', { required: true, max: 120 });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'A valid email address is required.');
      const dup = get('SELECT id FROM users WHERE email = ? AND id != ?', email, target.id);
      if (dup) fail(409, 'That email is already registered.');
      changes.email = email;
    }
    if (body.phone !== undefined) {
      if (target.role === 'collector' && !body.phone) fail(400, 'Mobile number is required.');
      changes.phone = body.phone ? phone(body.phone) : null;
    }
    if (body.active !== undefined) {
      if (target.id === user.id && !body.active) fail(400, 'You cannot deactivate your own account.');
      changes.active = body.active ? 1 : 0;
    }
    if (body.availability !== undefined) {
      changes.availability = str(body.availability, 'Availability', { max: 200 });
    }
    if (body.exception_notes !== undefined) {
      changes.exception_notes = str(body.exception_notes, 'Exception notes', { max: 1000 });
    }
    const hasAreaChanges = target.role === 'collector' && (body.area_ids !== undefined || body.area_id !== undefined || body.area_names !== undefined || body.area_name !== undefined);
    if (!Object.keys(changes).length && !hasAreaChanges) return { ok: true };
    tx(() => {
      if (Object.keys(changes).length) {
        run(`UPDATE users SET ${Object.keys(changes).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(changes), target.id);
        if (changes.active === 0) run('DELETE FROM sessions WHERE user_id = ?', target.id);
      }
      if (hasAreaChanges) {
        const areaIds = new Set();
        if (Array.isArray(body.area_ids)) body.area_ids.forEach((aid) => areaIds.add(Number(aid)));
        if (body.area_id) areaIds.add(Number(body.area_id));
        if (body.area_names || body.area_name) {
          const names = Array.isArray(body.area_names) ? body.area_names : [body.area_name];
          const allAreas = all('SELECT id, name FROM service_areas');
          for (const aname of names) {
            const match = allAreas.find((a) => areaNamesMatch(a.name, aname));
            if (match) areaIds.add(match.id);
          }
        }
        run('DELETE FROM collector_areas WHERE collector_id = ?', target.id);
        for (const aid of areaIds) {
          if (get('SELECT 1 FROM service_areas WHERE id = ?', aid)) {
            run('INSERT OR IGNORE INTO collector_areas (collector_id, area_id) VALUES (?, ?)', target.id, aid);
          }
        }
        changes.area_ids = [...areaIds];
      }
      audit('user', target.id, 'update', user, changes);
    });
    return { ok: true };
  });

  const handleTempPassword = ({ user, params, body }) => {
    const target = get('SELECT * FROM users WHERE id = ?', params.id) || fail(404, 'User not found.');
    const pw = String(body.password || '');
    if (pw.length < MIN_PASSWORD_LENGTH) {
      fail(400, `Temporary password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    tx(() => {
      run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', hashPassword(pw), target.id);
      run('DELETE FROM sessions WHERE user_id = ?', target.id);
      audit('user', target.id, 'set_temporary_password', user, { email: target.email, role: target.role });
    });
    return { ok: true, message: 'Temporary password set successfully.' };
  };

  route('POST', '/api/admin/users/:id/temporary-password', ['admin'], handleTempPassword);
  route('POST', '/api/admin/users/:id/password', ['admin'], handleTempPassword);

  // Simple editable tables. Each field: type, required flag.
  const ENTITIES = {
    areas: { table: 'service_areas', order: 'active DESC, name', fields: { name: 'text!', city: 'text!', pincodes: 'pins!', active: 'bool', notes: 'text' } },
    categories: { table: 'item_categories', order: 'sort_order, name', fields: { name: 'text!', description: 'text', accepted: 'bool', handling_notes: 'text', sort_order: 'int' } },
    recyclers: {
      table: 'recyclers', order: 'active DESC, name',
      fields: { name: 'text!', contact_name: 'text', phone: 'text', address: 'text', verified: 'bool', certification_claim: 'text', show_certified: 'bool', active: 'bool', notes: 'text' },
    },
    rules: {
      table: 'eco_rules', order: 'category_id, effective_date DESC',
      fields: { category_id: 'ref!', valuation_method: 'enum!:per_item,per_kg', rate_type: 'enum!:points,rupees', rate: 'num!', effective_date: 'date!', active: 'bool', is_sample: 'bool', admin_notes: 'text' },
    },
  };

  function coerce(spec, body, creating) {
    const out = {};
    for (const [field, typeSpec] of Object.entries(spec.fields)) {
      if (body[field] === undefined && !creating) continue;
      const [typeRaw, enumList] = typeSpec.split(':');
      const required = typeRaw.endsWith('!');
      const type = typeRaw.replace('!', '');
      const v = body[field];
      const label = field.replace(/_/g, ' ');
      if (type === 'bool') out[field] = v === true || v === 1 || v === '1' || v === 'on' ? 1 : 0;
      else if (type === 'int') out[field] = int(v, label, { required: false, min: 0, max: 9999 }) ?? 0;
      else if (type === 'num') out[field] = num(v, label, { required, min: 0, max: 100000 });
      else if (type === 'ref') out[field] = int(v, label, { required, min: 1, max: 1e9 });
      else if (type === 'date') {
        if (!isDate(v)) fail(400, `${label} must be a date.`);
        out[field] = v;
      } else if (type === 'enum') {
        if (!enumList.split(',').includes(v)) fail(400, `Choose a valid ${label}.`);
        out[field] = v;
      } else if (type === 'pins') {
        const pins = String(v || '').split(/[,\s]+/).filter(Boolean);
        if (!pins.length || pins.some((p) => !/^\d{6}$/.test(p))) fail(400, 'PIN codes must be 6 digits, separated by commas.');
        out[field] = pins.join(', ');
      } else out[field] = str(v, label, { required, max: 500 });
    }
    return out;
  }

  route('GET', '/api/admin/entity/:name', ['admin'], ({ params }) => {
    const spec = ENTITIES[params.name] || fail(404, 'Unknown table.');
    return all(`SELECT * FROM ${spec.table} ORDER BY ${spec.order}`);
  });
  route('POST', '/api/admin/entity/:name', ['admin'], ({ user, params, body }) => {
    const spec = ENTITIES[params.name] || fail(404, 'Unknown table.');
    const row = coerce(spec, body, true);
    if (params.name === 'rules') Object.assign(row, { updated_by: user.id, updated_at: nowISO() });
    const id = insert(spec.table, row);
    audit(params.name, id, 'create', user, row);
    return { id };
  });
  route('PUT', '/api/admin/entity/:name/:id', ['admin'], ({ user, params, body }) => {
    const spec = ENTITIES[params.name] || fail(404, 'Unknown table.');
    const before = get(`SELECT * FROM ${spec.table} WHERE id = ?`, params.id) || fail(404, 'Record not found.');
    const row = coerce(spec, body, false);
    if (params.name === 'rules') Object.assign(row, { updated_by: user.id, updated_at: nowISO() });
    if (!Object.keys(row).length) return { ok: true };
    run(`UPDATE ${spec.table} SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), params.id);
    audit(params.name, Number(params.id), 'update', user, { before, after: row });
    return { ok: true };
  });

  // Slots
  route('GET', '/api/admin/slots', ['admin'], ({ query }) => {
    const from = isDate(query.from) ? query.from : todayIST();
    const to = isDate(query.to) ? query.to : addDays(from, 6);
    const areaFilter = query.area_id ? 'AND s.area_id = ?' : '';
    const params = [from, to, ...(query.area_id ? [Number(query.area_id)] : [])];
    return all(
      `SELECT s.*, s.capacity - s.booked AS remaining, a.name AS area_name FROM pickup_slots s JOIN service_areas a ON a.id = s.area_id
       WHERE s.date BETWEEN ? AND ? ${areaFilter} ORDER BY s.date, s.start_time, a.name`, ...params,
    );
  });
  route('PUT', '/api/admin/slots/:id', ['admin'], ({ user, params, body }) => {
    const slot = get('SELECT * FROM pickup_slots WHERE id = ?', params.id) || fail(404, 'Slot not found.');
    const capacity = body.capacity === undefined ? slot.capacity : int(body.capacity, 'Capacity', { min: 0, max: 200 });
    if (capacity < slot.booked) fail(400, `Capacity cannot be lower than the ${slot.booked} bookings already in this slot.`);
    const active = body.active === undefined ? slot.active : body.active ? 1 : 0;
    run('UPDATE pickup_slots SET capacity = ?, active = ? WHERE id = ?', capacity, active, slot.id);
    audit('slot', slot.id, 'update', user, { before: { capacity: slot.capacity, active: slot.active }, after: { capacity, active } });
    return { ok: true };
  });
  route('POST', '/api/admin/slots/generate', ['admin'], ({ user, body }) => {
    if (!isDate(body.from) || !isDate(body.to) || body.from > body.to) fail(400, 'Choose a valid date range.');
    if (Date.parse(body.to) - Date.parse(body.from) > 62 * 864e5) fail(400, 'Generate at most two months at a time.');
    const areaIds = (Array.isArray(body.area_ids) ? body.area_ids : []).map(Number).filter(Boolean);
    if (!areaIds.length) fail(400, 'Choose at least one service area.');
    const windows = (Array.isArray(body.windows) ? body.windows : []).filter((w) => isTime(w.start) && isTime(w.end) && w.start < w.end);
    if (!windows.length) fail(400, 'Add at least one valid time window.');
    const capacity = int(body.capacity, 'Capacity', { min: 1, max: 200 });
    let created = 0;
    tx(() => {
      for (let d = body.from; d <= body.to; d = addDays(d, 1)) {
        if (body.skip_sundays && new Date(`${d}T00:00:00Z`).getUTCDay() === 0) continue;
        for (const areaId of areaIds) {
          for (const w of windows) {
            created += run('INSERT OR IGNORE INTO pickup_slots (date, start_time, end_time, area_id, capacity, booked, active) VALUES (?, ?, ?, ?, ?, 0, 1)', d, w.start, w.end, areaId, capacity).changes;
          }
        }
      }
      audit('slot', null, 'generate', user, { from: body.from, to: body.to, areaIds, windows, capacity, created });
    });
    return { created };
  });

  route('GET', '/api/admin/settings', ['admin'], () => ({ schema: SETTINGS, values: settings() }));
  route('PUT', '/api/admin/settings', ['admin'], ({ user, body }) => {
    const before = settings();
    const changed = {};
    tx(() => {
      for (const [key, def] of Object.entries(SETTINGS)) {
        if (body[key] === undefined) continue;
        let v;
        if (def.type === 'number') v = String(num(body[key], def.label, { min: def.min ?? 0, max: 100000 }));
        else if (def.type === 'bool') v = body[key] === true || body[key] === '1' || body[key] === 'on' ? '1' : '0';
        else v = str(body[key], def.label, { max: 300 }) || '';
        run('UPDATE settings SET value = ?, updated_by = ?, updated_at = ? WHERE key = ?', v, user.id, nowISO(), key);
        if (String(before[key] === true ? '1' : before[key] === false ? '0' : before[key]) !== v) changed[key] = { from: before[key], to: v };
      }
      if (Object.keys(changed).length) audit('settings', null, 'update', user, changed);
    });
    return { ok: true, changed: Object.keys(changed) };
  });

  // Eco Wallet review
  route('GET', '/api/admin/wallet', ['admin'], ({ query }) => {
    const status = ['Pending', 'Approved', 'Rejected', 'Redeemed'].includes(query.status) ? query.status : null;
    return {
      transactions: all(`${WALLET_SELECT} ${status ? 'WHERE w.status = ?' : ''} ORDER BY w.created_at DESC, w.id DESC LIMIT 1000`, ...(status ? [status] : [])),
      rules: all('SELECT r.*, ic.name AS category_name FROM eco_rules r JOIN item_categories ic ON ic.id = r.category_id ORDER BY ic.sort_order, r.effective_date DESC'),
      categories: all('SELECT id, name FROM item_categories ORDER BY sort_order, name'),
      rupees_per_point: settings().rupees_per_point,
    };
  });

  route('GET', '/api/admin/wallet/:id', ['admin'], ({ params }) => {
    const t = get(`${WALLET_SELECT} WHERE w.id = ?`, params.id) || fail(404, 'Transaction not found.');
    return t;
  });

  const handleWalletTxnEdit = ({ user, params, body }) => {
    const t = get('SELECT * FROM wallet_txns WHERE id = ?', params.id) || fail(404, 'Transaction not found.');
    if (t.status === 'Redeemed' || t.redemption_id) {
      fail(409, 'Transactions that are redeemed or in redemption cannot be edited.');
    }
    if (!['Pending', 'Approved'].includes(t.status)) {
      fail(409, `Transactions with status “${t.status}” cannot be edited.`);
    }

    const auditNote = str(body.audit_note || body.reason, 'Audit note', { required: t.status === 'Approved', max: 500 });
    const categoryId = body.category_id !== undefined ? int(body.category_id, 'Item category', { min: 1 }) : t.category_id;
    const cat = get('SELECT id, name FROM item_categories WHERE id = ?', categoryId) || fail(400, 'Unknown item category.');

    const qty = body.verified_qty !== undefined ? int(body.verified_qty, 'Count', { min: 0, max: 999, required: false }) : t.verified_qty;
    const weight = body.verified_weight_kg !== undefined ? num(body.verified_weight_kg, 'Weight', { min: 0, max: 2000, required: false }) : t.verified_weight_kg;
    if (!qty && !weight) fail(400, `Enter a count or weight for ${cat.name}.`);

    const ruleId = body.rule_id || t.rule_id;
    if (!ruleId) fail(400, 'Please choose a points rule.');
    const rule = get('SELECT * FROM eco_rules WHERE id = ? AND category_id = ?', ruleId, cat.id) || fail(400, 'That points rule is not for this category.');
    if (!rule.active) fail(400, 'That points rule is inactive.');

    const s = settings();
    const v = valuate(rule, qty, weight, s.rupees_per_point);
    if (!v.ok) fail(400, v.reason);

    const newPoints = v.points;
    const newRupee = v.rupee_value;
    const reviewNote = body.admin_note !== undefined ? str(body.admin_note, 'Review note', { max: 500 }) : t.admin_note;

    const pointDiff = newPoints - t.points;
    if (t.status === 'Approved' && pointDiff < 0) {
      const bal = walletBalance(t.customer_id);
      if (bal.available + pointDiff < 0) {
        fail(409, `Cannot reduce points by ${-pointDiff}: customer available balance is only ${bal.available} pts.`);
      }
    }

    tx(() => {
      const r = run(
        `UPDATE wallet_txns SET
           category_id = ?, verified_qty = ?, verified_weight_kg = ?,
           rule_id = ?, rule_used = ?, points = ?, rupee_value = ?,
           admin_note = ?
         WHERE id = ? AND status = ? AND points = ?`,
        cat.id, qty ?? 0, weight, rule.id, describeRule(rule, cat.name), newPoints, newRupee,
        reviewNote, t.id, t.status, t.points
      );
      if (r.changes !== 1) fail(409, 'This transaction was modified by someone else.');

      if (t.collected_item_id) {
        run('UPDATE collected_items SET category_id = ?, quantity = ?, weight_kg = ? WHERE id = ?', cat.id, qty ?? 0, weight, t.collected_item_id);
      }

      audit('wallet_txn', t.id, 'edit', user, {
        before: {
          category_id: t.category_id,
          verified_qty: t.verified_qty,
          verified_weight_kg: t.verified_weight_kg,
          rule_id: t.rule_id,
          rule_used: t.rule_used,
          points: t.points,
          rupee_value: t.rupee_value,
          admin_note: t.admin_note,
          status: t.status,
        },
        after: {
          category_id: cat.id,
          category_name: cat.name,
          verified_qty: qty,
          verified_weight_kg: weight,
          rule_id: rule.id,
          rule_used: describeRule(rule, cat.name),
          points: newPoints,
          rupee_value: newRupee,
          admin_note: reviewNote,
          status: t.status,
        },
        audit_note: auditNote || null,
        balance_impact: t.status === 'Approved' ? pointDiff : 0,
      });
    });

    return {
      ok: true,
      transaction: {
        id: t.id,
        category_id: cat.id,
        category_name: cat.name,
        verified_qty: qty,
        verified_weight_kg: weight,
        rule_id: rule.id,
        points: newPoints,
        rupee_value: newRupee,
        status: t.status,
        admin_note: reviewNote,
      },
      balance_impact: t.status === 'Approved' ? pointDiff : 0,
    };
  };

  route('PUT', '/api/admin/wallet/:id', ['admin'], handleWalletTxnEdit);
  route('POST', '/api/admin/wallet/:id/edit', ['admin'], handleWalletTxnEdit);

  route('GET', '/api/admin/rules', ['admin'], () =>
    all('SELECT r.*, ic.name AS category_name FROM eco_rules r JOIN item_categories ic ON ic.id = r.category_id ORDER BY ic.sort_order, r.effective_date DESC')
  );

  route('GET', '/api/admin/rules/:id', ['admin'], ({ params }) => {
    const r = get('SELECT r.*, ic.name AS category_name FROM eco_rules r JOIN item_categories ic ON ic.id = r.category_id WHERE r.id = ?', params.id) || fail(404, 'Rule not found.');
    return r;
  });

  route('POST', '/api/admin/rules', ['admin'], ({ user, body }) => {
    const spec = ENTITIES.rules;
    const row = coerce(spec, body, true);
    Object.assign(row, { updated_by: user.id, updated_at: nowISO() });
    const id = insert(spec.table, row);
    audit('rules', id, 'create', user, row);
    return { id, ok: true };
  });

  route('PUT', '/api/admin/rules/:id', ['admin'], ({ user, params, body }) => {
    const spec = ENTITIES.rules;
    const before = get('SELECT * FROM eco_rules WHERE id = ?', params.id) || fail(404, 'Rule not found.');
    const row = coerce(spec, body, false);
    Object.assign(row, { updated_by: user.id, updated_at: nowISO() });
    if (!Object.keys(row).length) return { ok: true };
    run(`UPDATE eco_rules SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), params.id);
    audit('rules', Number(params.id), 'update', user, { before, after: row });
    return { ok: true };
  });

  route('POST', '/api/admin/wallet/:id/review', ['admin'], ({ user, params, body }) => {
    const t = get('SELECT * FROM wallet_txns WHERE id = ?', params.id) || fail(404, 'Transaction not found.');
    if (t.status !== 'Pending') fail(409, `This transaction is already ${t.status.toLowerCase()}.`);
    const decision = body.decision;
    if (!['approve', 'reject'].includes(decision)) fail(400, 'Choose approve or reject.');
    const note = str(body.admin_note, 'Admin note', { required: decision === 'reject', max: 500 });
    const qty = body.verified_qty !== undefined ? int(body.verified_qty, 'Verified count', { min: 0, max: 999, required: false }) : t.verified_qty;
    const weight = body.verified_weight_kg !== undefined ? num(body.verified_weight_kg, 'Verified weight', { min: 0, max: 2000, required: false }) : t.verified_weight_kg;
    const ruleId = body.rule_id || t.rule_id;
    const rule = ruleId ? get('SELECT * FROM eco_rules WHERE id = ? AND category_id = ?', ruleId, t.category_id) || fail(400, 'That rule is not for this category.') : null;
    const catName = get('SELECT name FROM item_categories WHERE id = ?', t.category_id).name;
    let points = 0;
    let rupee = 0;
    if (decision === 'approve') {
      if (!rule) fail(400, 'Choose the points rule to apply.');
      if (!rule.active) fail(400, 'That points rule is inactive.');
      const v = valuate(rule, qty, weight, settings().rupees_per_point);
      if (!v.ok) fail(400, v.reason);
      points = v.points;
      rupee = v.rupee_value;
    }
    tx(() => {
      // Guarded update: a second reviewer acting at the same moment cannot double-approve.
      const r = run(
        `UPDATE wallet_txns SET status = ?, verified_qty = ?, verified_weight_kg = ?, rule_id = ?, rule_used = ?, points = ?, rupee_value = ?,
           reviewed_by = ?, reviewed_at = ?, admin_note = ? WHERE id = ? AND status = 'Pending'`,
        decision === 'approve' ? 'Approved' : 'Rejected', qty, weight, rule ? rule.id : t.rule_id, rule ? describeRule(rule, catName) : t.rule_used,
        points, rupee, user.id, nowISO(), note, t.id,
      );
      if (r.changes !== 1) fail(409, 'This transaction was reviewed by someone else just now.');
      audit('wallet_txn', t.id, decision, user, {
        before: { status: t.status, verified_qty: t.verified_qty, verified_weight_kg: t.verified_weight_kg, points: t.points, rule_id: t.rule_id },
        after: { verified_qty: qty, verified_weight_kg: weight, points, rupee_value: rupee, rule_id: rule ? rule.id : t.rule_id },
        note,
      });
    });
    return { ok: true, status: decision === 'approve' ? 'Approved' : 'Rejected', points, rupee_value: rupee };
  });

  // Correction path for mistakes: an approved entry that is not tied up in a redemption can be reversed with a reason.
  route('POST', '/api/admin/wallet/:id/reverse', ['admin'], ({ user, params, body }) => {
    const t = get('SELECT * FROM wallet_txns WHERE id = ?', params.id) || fail(404, 'Transaction not found.');
    if (t.status !== 'Approved' || t.redemption_id) fail(409, 'Only approved points that are not part of a redemption can be reversed.');
    const note = str(body.admin_note, 'Reason', { required: true, max: 500 });
    tx(() => {
      run("UPDATE wallet_txns SET status = 'Rejected', reviewed_by = ?, reviewed_at = ?, admin_note = ? WHERE id = ? AND status = 'Approved' AND redemption_id IS NULL", user.id, nowISO(), note, t.id);
      audit('wallet_txn', t.id, 'reverse', user, { points: t.points, previous_note: t.admin_note, note });
    });
    return { ok: true };
  });

  route('GET', '/api/admin/redemptions', ['admin'], () =>
    all('SELECT r.*, u.name AS customer_name, u.phone AS customer_phone, rv.name AS reviewed_by_name FROM redemptions r JOIN users u ON u.id = r.customer_id LEFT JOIN users rv ON rv.id = r.reviewed_by ORDER BY r.id DESC'));

  route('POST', '/api/admin/redemptions/:id/:action', ['admin'], ({ user, params, body }) => {
    const r = get('SELECT * FROM redemptions WHERE id = ?', params.id) || fail(404, 'Redemption not found.');
    if (r.status !== 'Requested') fail(409, 'This redemption has already been processed.');
    if (!['fulfil', 'reject'].includes(params.action)) fail(404, 'Unknown action.');
    const note = str(body.admin_note, 'Note', { required: params.action === 'reject', max: 500 });
    const reference = str(body.reference, 'Payment / voucher reference', { required: params.action === 'fulfil', max: 120 });
    tx(() => {
      if (params.action === 'fulfil') {
        run("UPDATE wallet_txns SET status = 'Redeemed' WHERE redemption_id = ? AND status = 'Approved'", r.id);
        run("UPDATE redemptions SET status = 'Fulfilled', reviewed_by = ?, reviewed_at = ?, reference = ?, admin_note = ? WHERE id = ?", user.id, nowISO(), reference, note, r.id);
      } else {
        run('UPDATE wallet_txns SET redemption_id = NULL WHERE redemption_id = ?', r.id);
        run("UPDATE redemptions SET status = 'Rejected', reviewed_by = ?, reviewed_at = ?, admin_note = ? WHERE id = ?", user.id, nowISO(), note, r.id);
      }
      audit('redemption', r.id, params.action, user, { reference, note, points: r.points });
    });
    return { ok: true };
  });

  // Recycler handoffs
  route('GET', '/api/admin/handoffs', ['admin'], () => ({
    handoffs: all(
      `SELECT h.*, r.name AS recycler_name, u.name AS created_by_name,
         (SELECT group_concat(b.booking_code, ', ') FROM handoff_bookings hb JOIN bookings b ON b.id = hb.booking_id WHERE hb.handoff_id = h.id) AS bookings,
         (SELECT group_concat(ic.name || ' × ' || hi.quantity || CASE WHEN hi.weight_kg IS NOT NULL THEN ' (' || hi.weight_kg || ' kg)' ELSE '' END, ', ')
            FROM handoff_items hi JOIN item_categories ic ON ic.id = hi.category_id WHERE hi.handoff_id = h.id) AS items
       FROM recycler_handoffs h JOIN recyclers r ON r.id = h.recycler_id LEFT JOIN users u ON u.id = h.created_by ORDER BY h.handoff_date DESC, h.id DESC`,
    ),
    eligible: all(`${BOOKING_SELECT} WHERE b.status = 'Collected' ORDER BY b.collected_at`).map((b) => ({
      ...b,
      collected_summary: all('SELECT ic.name, ci.quantity, ci.weight_kg FROM collected_items ci JOIN item_categories ic ON ic.id = ci.category_id WHERE ci.booking_id = ?', b.id)
        .map((c) => `${c.name} × ${c.quantity}${c.weight_kg != null ? ` (${c.weight_kg} kg)` : ''}`).join(', '),
    })),
  }));

  route('POST', '/api/admin/handoffs', ['admin'], ({ user, body }) => {
    const recycler = get('SELECT * FROM recyclers WHERE id = ? AND active = 1', body.recycler_id) || fail(400, 'Choose an active recycler.');
    if (!isDate(body.handoff_date)) fail(400, 'Enter the handoff date.');
    const ids = (Array.isArray(body.booking_ids) ? body.booking_ids : []).map(Number);
    if (!ids.length) fail(400, 'Select at least one collected booking.');
    const receipt_ref = str(body.receipt_ref, 'Receipt / reference number', { max: 120 });
    const notes = str(body.notes, 'Notes', { max: 500 });
    return tx(() => {
      const bookings = ids.map((id) => {
        const b = get('SELECT * FROM bookings WHERE id = ?', id) || fail(400, 'Unknown booking.');
        if (b.status !== 'Collected') fail(409, `${b.booking_code} is not in “Collected” status.`);
        return b;
      });
      const base = `HO-${body.handoff_date.slice(2).replace(/-/g, '')}`;
      const n = get('SELECT COUNT(*) AS n FROM recycler_handoffs WHERE reference LIKE ?', `${base}-%`).n + 1;
      const reference = str(body.reference, 'Batch reference', { max: 60 }) || `${base}-${String(n).padStart(2, '0')}`;
      if (get('SELECT 1 FROM recycler_handoffs WHERE reference = ?', reference)) fail(409, 'That batch reference is already used.');
      const hid = insert('recycler_handoffs', { reference, recycler_id: recycler.id, handoff_date: body.handoff_date, receipt_ref, notes, created_by: user.id, created_at: nowISO() });
      const totals = all(
        `SELECT category_id, SUM(quantity) AS quantity, SUM(weight_kg) AS weight_kg FROM collected_items WHERE booking_id IN (${ids.map(() => '?').join(',')}) GROUP BY category_id`, ...ids,
      );
      for (const t of totals) insert('handoff_items', { handoff_id: hid, category_id: t.category_id, quantity: t.quantity, weight_kg: t.weight_kg == null ? null : round2(t.weight_kg) });
      for (const b of bookings) {
        insert('handoff_bookings', { handoff_id: hid, booking_id: b.id });
        run("UPDATE bookings SET status = 'Received by recycler' WHERE id = ?", b.id);
        addHistory(b.id, 'Received by recycler', user, `Handed to ${recycler.name} (${reference})`);
      }
      audit('handoff', hid, 'create', user, { reference, recycler: recycler.name, bookings: bookings.map((b) => b.booking_code), receipt_ref });
      return { id: hid, reference };
    });
  });

  route('GET', '/api/admin/audit', ['admin'], () =>
    all('SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 500'));

  // ---------------------------------------------------------------- dispatcher
  return async function handle(req, url, body) {
    const user = userFromRequest(req);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      if (r.roles && !user) fail(401, 'Please log in to continue.');
      if (user && user.must_change_password && r.roles && !PASSWORD_GATE_OPEN.has(`${r.method} ${url.pathname}`)) {
        throw new HttpError(403, 'Please set a new password before continuing.', 'password_change_required');
      }
      if (Array.isArray(r.roles) && !r.roles.includes(user.role)) fail(403, 'You do not have access to this.');
      const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      return r.handler({ req, user, params, query: Object.fromEntries(url.searchParams), body: body || {} });
    }
    fail(404, 'Not found.');
  };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
