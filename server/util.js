// Shared helpers: India time, settings schema and Eco Points valuation.

const IST_OFFSET_MS = 330 * 60 * 1000;

export const todayIST = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Slot times are stored as IST wall-clock values (India has no DST).
export const slotStart = (date, time) => new Date(`${date}T${time}:00+05:30`);

export const nowISO = () => new Date().toISOString();

export const round2 = (n) => Math.round(n * 100) / 100;

// Editable by admins on the Settings page. Nothing here is a business promise:
// fees default to ₹0, the point value is flagged as a sample, and redemption is off.
export const SETTINGS = {
  pickup_fee_rupees: { type: 'number', label: 'Pickup fee (₹)', min: 0, default: '0' },
  fee_note: { type: 'text', label: 'Fee note shown to customers', default: '' },
  cancellation_cutoff_hours: { type: 'number', label: 'Reschedule / cancel cutoff (hours before slot starts)', min: 0, default: '12' },
  min_lead_hours: { type: 'number', label: 'Minimum notice for a new booking (hours)', min: 0, default: '3' },
  booking_window_days: { type: 'number', label: 'How many days ahead customers can book', min: 1, default: '14' },
  rupees_per_point: { type: 'number', label: '₹ value of 1 Eco Point (0 = not set; no ₹ value shown)', min: 0, default: '0' },
  point_value_is_sample: { type: 'bool', label: 'Point value is a sample rate (not yet approved for customers)', default: '1' },
  redemption_enabled: { type: 'bool', label: 'Allow customers to redeem points', default: '0' },
  redemption_method: { type: 'text', label: 'Redemption method (e.g. UPI transfer, partner voucher)', default: '' },
  redemption_min_points: { type: 'number', label: 'Minimum points per redemption', min: 1, default: '500' },
  support_phone: { type: 'text', label: 'Support phone', default: '' },
  support_email: { type: 'text', label: 'Support email', default: '' },
};

export function describeRule(rule, categoryName) {
  if (!rule) return 'No active points rule';
  const unit = rule.valuation_method === 'per_kg' ? 'kg' : 'item';
  const rate = rule.rate_type === 'points' ? `${rule.rate} points per ${unit}` : `₹${rule.rate} per ${unit}`;
  return `${categoryName ? categoryName + ': ' : ''}${rate} (effective ${rule.effective_date}${rule.is_sample ? ', sample rate' : ''})`;
}

// Returns { ok, points, rupee_value, reason }. Count is used for per-item rules, weight for per-kg rules.
export function valuate(rule, quantity, weightKg, rupeesPerPoint) {
  if (!rule) return { ok: false, points: 0, rupee_value: 0, reason: 'No active points rule for this category' };
  const perKg = rule.valuation_method === 'per_kg';
  const basis = perKg ? weightKg : quantity;
  if (basis == null || !(basis > 0)) {
    return { ok: false, points: 0, rupee_value: 0, reason: perKg ? 'Verified weight (kg) is needed' : 'Verified item count is needed' };
  }
  let points;
  let rupee;
  if (rule.rate_type === 'points') {
    points = Math.floor(basis * rule.rate);
    rupee = round2(points * rupeesPerPoint);
  } else {
    rupee = round2(basis * rule.rate);
    points = rupeesPerPoint > 0 ? Math.floor(rupee / rupeesPerPoint) : 0;
  }
  return { ok: points > 0, points, rupee_value: rupee, reason: points > 0 ? '' : 'Valuation comes to 0 points' };
}

export function normalisePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}
