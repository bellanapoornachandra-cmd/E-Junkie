// Small rendering toolkit: auto-escaping templates, formatting, and shared widgets.

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
export const raw = (s) => new Raw(String(s));

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function render(v) {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

// Tagged template: interpolated values are escaped unless wrapped in raw() or produced by html``.
export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += render(values[i]);
  });
  return new Raw(out);
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { status: res.status, code: data.code });
  return data;
}

// ---------------------------------------------------------------- formatting (en-IN, IST)
const TZ = 'Asia/Kolkata';
export const fmtDate = (d) =>
  d ? new Date(`${d}T00:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ }) : '';
export const fmtDay = (d) => new Date(`${d}T00:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
export const fmtDateTime = (iso) =>
  iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ }) : '';
function fmtClock(t) {
  const [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${suffix}`;
}
export const fmtWindow = (w) => {
  if (!w) return '';
  const [a, b] = w.split('-');
  return `${fmtClock(a)} – ${fmtClock(b)}`;
};
export const fmtINR = (n) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: n % 1 ? 2 : 0 }).format(n || 0);
export const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN');
export const fmtPhone = (p) => (p && /^\d{10}$/.test(p) ? `+91 ${p.slice(0, 5)} ${p.slice(5)}` : p || '');
// Support contact as configured by the admin; empty string when none is set.
export const supportText = (cfg) => [cfg.support.phone, cfg.support.email].filter(Boolean).join(' · ');

export const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

export function normalizeAreaName(name) {
  if (!name) return '';
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ');
}

export function areaNamesMatch(name1, name2) {
  if (!name1 || !name2) return false;
  const s1 = String(name1).trim().toLowerCase();
  const s2 = String(name2).trim().toLowerCase();
  if (s1 === s2) return true;
  const n1 = normalizeAreaName(name1);
  const n2 = normalizeAreaName(name2);
  return Boolean(n1 && n2 && n1 === n2);
}

export function collectorServesBooking(collector, booking) {
  if (!collector || (!collector.active && collector.active !== undefined && collector.active !== 1)) {
    return false;
  }
  if (!booking) return false;

  const areaIds = (collector.area_ids || []).map(Number).filter(Boolean);
  const areaNames = collector.area_names || [];

  if (areaIds.length === 0 && areaNames.length === 0) {
    return true;
  }

  const targetId = Number(booking.area_id);
  const targetName = booking.area_name || '';

  if (targetId && areaIds.some((id) => Number(id) === targetId)) {
    return true;
  }

  if (targetName && areaNames.some((name) => areaNamesMatch(name, targetName))) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------- widgets
const STATUS_TONE = {
  Booked: 'neutral',
  'Collector assigned': 'info',
  'On the way': 'info',
  Arrived: 'info',
  Collected: 'good',
  'Received by recycler': 'done',
  'Unable to collect': 'warn',
  Cancelled: 'muted',
  Pending: 'warn',
  Approved: 'good',
  Rejected: 'bad',
  Redeemed: 'done',
  Requested: 'warn',
  Fulfilled: 'good',
};
export const badge = (status) => html`<span class="badge badge--${STATUS_TONE[status] || 'neutral'}">${status}</span>`;

export const TIMELINE = ['Booked', 'Collector assigned', 'On the way', 'Collected', 'Received by recycler'];
const STEP_OF = { Booked: 0, 'Collector assigned': 1, 'On the way': 2, Arrived: 2, Collected: 3, 'Received by recycler': 4 };

export function timeline(booking, history) {
  const reachedAt = {};
  let furthest = 0;
  for (const h of history) {
    const step = STEP_OF[h.status];
    if (step === undefined) continue;
    // A reschedule sends the booking back to "Booked"; only count progress after the latest reset.
    if (step === 0) {
      for (const k of Object.keys(reachedAt)) delete reachedAt[k];
      furthest = 0;
    }
    if (!(step in reachedAt)) reachedAt[step] = h.at;
    furthest = Math.max(furthest, step);
  }
  const stopped = ['Cancelled', 'Unable to collect'].includes(booking.status);
  const current = stopped ? furthest : STEP_OF[booking.status] ?? furthest;
  const arrived = booking.status === 'Arrived' || history.some((h) => h.status === 'Arrived');
  return html`<ol class="timeline timeline--h ${stopped ? 'timeline--stopped' : ''}" aria-label="Pickup progress">
    ${TIMELINE.map((label, i) => {
      const state = i < current || (i === current && stopped) ? 'done' : i === current ? 'current' : 'todo';
      return html`<li class="timeline__step timeline__step--${state}">
        <span class="timeline__dot" aria-hidden="true"></span>
        <span class="timeline__label">${label}${i === 2 && arrived ? html` <small>· arrived</small>` : ''}</span>
        ${reachedAt[i] ? html`<span class="timeline__time">${fmtDateTime(reachedAt[i])}</span>` : ''}
        <span class="visually-hidden">${state === 'done' ? 'completed' : state === 'current' ? 'current step' : 'not yet'}</span>
      </li>`;
    })}
  </ol>
  ${stopped ? html`<p class="callout callout--${booking.status === 'Cancelled' ? 'muted' : 'warn'}"><strong>${booking.status}.</strong> ${booking.exception_note || ''}</p>` : ''}`;
}

export function toast(message, tone = 'good') {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast toast--${tone}`;
  el.textContent = message;
  host.append(el);
  setTimeout(() => el.remove(), 4200);
}

export const empty = (text, action) => html`<div class="empty"><p>${text}</p>${action || ''}</div>`;

export const loading = () => html`<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span> Loading…</div>`;

export function errorBox(err) {
  return html`<div class="callout callout--bad" role="alert">${err.message || String(err)}</div>`;
}

// Generic form builder for admin records. fields: [{name,label,type,options,required,help,step}]
export function formFields(fields, values = {}) {
  return fields.map((f) => {
    const v = values[f.name] ?? f.default ?? '';
    const id = `f-${f.name}`;
    const req = f.required ? raw(' required') : '';
    const help = f.help ? html`<span class="field__help">${f.help}</span>` : '';
    if (f.type === 'checkbox') {
      return html`<label class="check"><input type="checkbox" name="${f.name}" ${v === 1 || v === true || v === '1' ? raw('checked') : ''}> <span>${f.label}</span></label>${help}`;
    }
    let control;
    if (f.type === 'select') {
      control = html`<select id="${id}" name="${f.name}"${req}>${f.placeholder ? html`<option value="">${f.placeholder}</option>` : ''}${f.options.map(
        (o) => html`<option value="${o.value}" ${String(o.value) === String(v) ? raw('selected') : ''}>${o.label}</option>`,
      )}</select>`;
    } else if (f.type === 'textarea') {
      control = html`<textarea id="${id}" name="${f.name}" rows="${f.rows || 3}"${req}>${v}</textarea>`;
    } else {
      control = html`<input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${v}"${req}${f.step ? raw(` step="${f.step}"`) : ''}${f.min != null ? raw(` min="${f.min}"`) : ''}${f.inputmode ? raw(` inputmode="${f.inputmode}"`) : ''}${f.autocomplete ? raw(` autocomplete="${f.autocomplete}"`) : ''}${f.pattern ? raw(` pattern="${f.pattern}"`) : ''}>`;
    }
    return html`<div class="field ${f.wide ? 'field--wide' : ''}"><label for="${id}">${f.label}${f.required ? '' : html` <span class="optional">(optional)</span>`}</label>${control}${help}</div>`;
  });
}

export function readForm(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') {
      if (el.checked) out[el.name] = el.value;
    } else out[el.name] = el.value;
  }
  return out;
}

// Wraps a submit handler with busy state and error toasts.
export function onSubmit(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || form.querySelector('[type=submit]');
    if (btn) btn.disabled = true;
    try {
      await handler(readForm(form), e.submitter);
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  });
}

export function table(columns, rows, { emptyText = 'Nothing to show.' } = {}) {
  if (!rows.length) return empty(emptyText);
  return html`<div class="table-wrap"><table class="table">
    <thead><tr>${columns.map((c) => html`<th scope="col">${c.label}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => html`<tr>${columns.map((c) => html`<td data-label="${c.label}">${c.render(r)}</td>`)}</tr>`)}</tbody>
  </table></div>`;
}

export const itemsList = (items, key = 'est_qty') =>
  html`<ul class="items">${items.map((i) => html`<li><span>${i.name}</span><strong>× ${i[key]}${i.weight_kg != null && key === 'quantity' ? html` · ${i.weight_kg} kg` : ''}</strong></li>`)}</ul>`;
