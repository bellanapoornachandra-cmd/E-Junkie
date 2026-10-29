import {
  html, raw, api, toast, empty, onSubmit, readForm, formFields, badge, table,
  fmtDate, fmtDay, fmtDateTime, fmtWindow, fmtINR, fmtNum, fmtPhone, todayIST,
  collectorServesBooking, areaNamesMatch,
} from './ui.js';

const STATUSES = ['Booked', 'Collector assigned', 'On the way', 'Arrived', 'Collected', 'Received by recycler', 'Unable to collect', 'Cancelled'];
const SECTIONS = [
  ['', 'Dashboard'], ['bookings', 'Bookings'], ['customers', 'Customers'], ['collectors', 'Collectors'],
  ['wallet', 'Eco Wallet review'], ['redemptions', 'Redemptions'], ['rules', 'Points rules'],
  ['slots', 'Pickup slots'], ['areas', 'Service areas'], ['categories', 'Item categories'],
  ['recyclers', 'Recyclers'], ['handoffs', 'Recycler handoffs'], ['settings', 'Settings'], ['audit', 'Audit log'],
];

const post = (path, body) => api(path, { method: 'POST', body });
const put = (path, body) => api(path, { method: 'PUT', body });
const codeLink = (b) => html`<a class="code" href="#/pickups/${b.booking_code}">${b.booking_code}</a>`;
const yesNo = (v) => (v ? 'Yes' : 'No');

function frame(main, key, title, sub, body) {
  main.innerHTML = html`
    <nav class="subnav" aria-label="Admin">${SECTIONS.map(([k, label]) => html`<a href="#/admin${k ? `/${k}` : ''}" ${k === key ? raw('aria-current="page"') : ''}>${label}</a>`)}</nav>
    <div class="page-head"><div><h1>${title}</h1>${sub ? html`<p>${sub}</p>` : ''}</div></div>
    ${body}`;
}

// Filter rows client-side as the admin types. Admin lists are capped server-side.
function wireFilter(main, rows, renderRows, predicate) {
  const host = main.querySelector('#rows');
  const controls = main.querySelectorAll('[data-filter]');
  const apply = () => {
    const f = Object.fromEntries([...controls].map((c) => [c.dataset.filter, c.value.trim().toLowerCase()]));
    host.innerHTML = String(renderRows(rows.filter((r) => predicate(r, f))));
  };
  controls.forEach((c) => c.addEventListener('input', apply));
  apply();
}

// ======================================================================= Dashboard
export async function dashboard(main, ctx) {
  const [s, collectors] = await Promise.all([api('/admin/summary'), api('/admin/users?role=collector')]);
  const count = Object.fromEntries(s.counts.map((c) => [c.status, c.n]));
  const active = collectors.filter((c) => c.active);
  const assignForm = (b) => {
    const areaCollectors = active.filter((c) => collectorServesBooking(c, b));
    const noCollectorMsg = `No active collector serves ${b.area_name || 'this area'}`;
    return html`<form class="inline-form" data-assign="${b.booking_code}">
      <select name="collector_id" aria-label="Collector for ${b.booking_code}" required ${areaCollectors.length ? '' : raw('disabled')}>
        <option value="">${areaCollectors.length ? 'Collector…' : noCollectorMsg}</option>
        ${areaCollectors.map((c) => html`<option value="${c.id}">${c.name}</option>`)}
      </select>
      <input name="route_order" type="number" min="1" max="99" placeholder="Stop #" aria-label="Route order" class="w-sm" ${areaCollectors.length ? '' : raw('disabled')}>
      <button class="btn btn--sm" type="submit" ${areaCollectors.length ? '' : raw('disabled')}>Assign</button>
    </form>`;
  };
  frame(main, '', 'Operations dashboard', fmtDate(todayIST()), html`
    <div class="stats">
      ${STATUSES.map((st) => html`<a class="stat" href="#/admin/bookings?status=${encodeURIComponent(st)}"><span>${st}</span><strong>${fmtNum(count[st] || 0)}</strong></a>`)}
      <a class="stat ${s.pending_wallet ? 'stat--alert' : ''}" href="#/admin/wallet"><span>Points to review</span><strong>${s.pending_wallet}</strong></a>
      <a class="stat ${s.pending_redemptions ? 'stat--alert' : ''}" href="#/admin/redemptions"><span>Redemption requests</span><strong>${s.pending_redemptions}</strong></a>
    </div>
    <div class="grid grid--2">
      <section class="card"><div class="card__head"><h2>Today's pickups (${s.today.length})</h2></div>
        ${table([
          { label: 'Booking', render: codeLink },
          { label: 'Slot', render: (b) => fmtWindow(b.time_window) },
          { label: 'Area', render: (b) => b.area_name },
          { label: 'Collector', render: (b) => (b.collector_name ? `${b.collector_name}${b.route_order ? ` · #${b.route_order}` : ''}` : html`<span class="badge badge--warn">Unassigned</span>`) },
          { label: 'Status', render: (b) => badge(b.status) },
        ], s.today, { emptyText: 'No pickups today.' })}
      </section>
      <section class="card"><div class="card__head"><h2>Unassigned bookings (${s.unassigned.length})</h2></div>
        ${table([
          { label: 'Booking', render: (b) => html`${codeLink(b)}<br><small>${fmtDay(b.requested_date)}, ${fmtWindow(b.time_window)} · ${b.area_name}</small>` },
          { label: 'Items', render: (b) => b.items_summary },
          { label: 'Assign', render: assignForm },
        ], s.unassigned, { emptyText: 'Every upcoming booking has a collector.' })}
      </section>
    </div>
    <section class="card section"><div class="card__head"><h2>Exceptions, last 30 days (${s.exceptions.length})</h2></div>
      ${table([
        { label: 'Booking', render: codeLink },
        { label: 'Date', render: (b) => fmtDay(b.requested_date) },
        { label: 'Customer', render: (b) => b.customer_name },
        { label: 'Collector', render: (b) => b.collector_name || '—' },
        { label: 'Status', render: (b) => badge(b.status) },
        { label: 'Note', render: (b) => b.exception_note },
      ], s.exceptions, { emptyText: 'No exceptions.' })}
    </section>
    ${s.awaiting_handoff ? html`<p class="callout section">${s.awaiting_handoff} collected ${s.awaiting_handoff === 1 ? 'booking is' : 'bookings are'} waiting to be handed to a recycler. <a href="#/admin/handoffs">Record a handoff</a></p>` : ''}`);
  main.querySelectorAll('[data-assign]').forEach((f) => onSubmit(f, async (v) => {
    if (!v.collector_id) throw new Error('Please choose an active collector.');
    await post(`/bookings/${f.dataset.assign}/assign`, { collector_id: Number(v.collector_id), route_order: v.route_order });
    toast(`${f.dataset.assign} assigned.`);
    ctx.refresh();
  }));
}

// ======================================================================= Sections
export async function section(main, ctx) {
  const key = ctx.params[0];
  const views = { bookings, customers: (m, c) => users(m, c, 'customer'), collectors: (m, c) => users(m, c, 'collector'), wallet, redemptions, rules, slots, areas, categories, recyclers, handoffs, settings, audit };
  if (!views[key]) {
    main.innerHTML = '<p>Unknown section.</p>';
    return;
  }
  await views[key](main, ctx);
}

async function bookings(main, ctx) {
  const [rows, collectors] = await Promise.all([api('/bookings'), api('/admin/users?role=collector')]);
  const activeCollectors = collectors.filter((c) => c.active);
  const areas = [...new Set(rows.map((r) => r.area_name))].sort();
  const status = ctx.query.get('status') || '';
  frame(main, 'bookings', 'Bookings', `${rows.length} bookings`, html`
    <div class="toolbar">
      <input type="search" data-filter="q" placeholder="Search booking ID, customer, phone, address" aria-label="Search bookings">
      <select data-filter="status" aria-label="Status"><option value="">All statuses</option>${STATUSES.map((s) => html`<option ${s === status ? raw('selected') : ''}>${s}</option>`)}</select>
      <select data-filter="area" aria-label="Area"><option value="">All areas</option>${areas.map((a) => html`<option>${a}</option>`)}</select>
      <select data-filter="collector" aria-label="Collector"><option value="">Any collector</option><option value="__none">Unassigned</option>${collectors.map((c) => html`<option>${c.name}</option>`)}</select>
      <input type="date" data-filter="date" aria-label="Date">
    </div>
    <div id="rows"></div>`);

  const assignForm = (b) => {
    const isClosed = ['Collected', 'Received by recycler', 'Cancelled'].includes(b.status);
    if (isClosed) {
      return b.collector_name ? `${b.collector_name}${b.route_order ? ` · #${b.route_order}` : ''}` : '—';
    }
    const eligible = activeCollectors.filter((c) => collectorServesBooking(c, b));
    const noCollectorMsg = `No active collector serves ${b.area_name || 'this area'}`;
    return html`<form class="inline-form" data-assign="${b.booking_code}">
      <select name="collector_id" aria-label="Collector for ${b.booking_code}" required ${eligible.length ? '' : raw('disabled')}>
        <option value="">${eligible.length ? (b.collector_id ? 'Change collector…' : 'Choose collector…') : noCollectorMsg}</option>
        ${b.collector_id && !eligible.some((c) => c.id === b.collector_id) && b.collector_name
          ? html`<option value="${b.collector_id}" selected>${b.collector_name} (Current assignment)</option>`
          : ''}
        ${eligible.map((c) => html`<option value="${c.id}" ${c.id === b.collector_id ? raw('selected') : ''}>${c.name} (${c.open_assignments} open)</option>`)}
      </select>
      <input name="route_order" type="number" min="1" max="99" value="${b.route_order ?? ''}" placeholder="Stop #" aria-label="Route order" class="w-sm" ${eligible.length ? '' : raw('disabled')}>
      <button class="btn btn--sm" type="submit" ${eligible.length ? '' : raw('disabled')}>${b.collector_id ? 'Change' : 'Assign'}</button>
    </form>`;
  };

  wireFilter(main, rows, (list) => table([
    { label: 'Booking', render: codeLink },
    { label: 'Date & slot', render: (b) => html`${fmtDay(b.requested_date)}<br><small>${fmtWindow(b.time_window)}</small>` },
    { label: 'Area', render: (b) => b.area_name },
    { label: 'Customer', render: (b) => html`${b.customer_name}<br><small>${fmtPhone(b.contact_phone)}</small>` },
    { label: 'Items', render: (b) => b.items_summary },
    { label: 'Collector', render: assignForm },
    { label: 'Status', render: (b) => badge(b.status) },
  ], list, { emptyText: rows.length ? 'No bookings match these filters.' : 'No bookings yet. They appear here as customers book pickups.' }), (b, f) =>
    (!f.q || [b.booking_code, b.customer_name, b.contact_name, b.contact_phone, b.address_text].join(' ').toLowerCase().includes(f.q))
    && (!f.status || b.status.toLowerCase() === f.status)
    && (!f.area || areaNamesMatch(b.area_name, f.area))
    && (!f.collector || (f.collector === '__none' ? !b.collector_id : (b.collector_name || '').toLowerCase() === f.collector))
    && (!f.date || b.requested_date === f.date));

  main.addEventListener('submit', async (e) => {
    const f = e.target.closest('[data-assign]');
    if (!f) return;
    e.preventDefault();
    const btn = e.submitter || f.querySelector('[type=submit]');
    if (btn) btn.disabled = true;
    try {
      const v = readForm(f);
      if (!v.collector_id) throw new Error('Please choose an active collector.');
      await post(`/bookings/${f.dataset.assign}/assign`, { collector_id: Number(v.collector_id), route_order: v.route_order });
      toast(`Collector assigned to ${f.dataset.assign}.`);
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  });
}

async function users(main, ctx, role) {
  const [rows, areasList] = await Promise.all([
    api(`/admin/users?role=${role}`),
    role === 'collector' ? api('/admin/entity/areas') : Promise.resolve([]),
  ]);
  const activeAreas = areasList.filter((a) => a.active);
  const title = role === 'customer' ? 'Customers' : 'Collectors';
  frame(main, `${role}s`, title, `${rows.filter((r) => r.active).length} active`, html`
    ${role === 'collector' ? html`<details class="panel"><summary>Add a collector</summary><div>
      <form class="form-grid form-grid--2" id="new-user">${formFields([
        { name: 'name', label: 'Name', required: true }, { name: 'phone', label: 'Mobile number', type: 'tel', required: true },
        { name: 'email', label: 'Email (used to log in)', type: 'email', required: true }, { name: 'password', label: 'Temporary password', type: 'text', required: true, help: 'Share it privately; at least 10 characters. They must change it at first login.' },
        { name: 'availability', label: 'Availability / schedule notes', help: 'e.g. Mon–Fri 9am–5pm' },
        { name: 'exception_notes', label: 'Exception notes / internal remarks' },
      ])}
      <fieldset class="field field--wide"><legend class="label">Service areas served</legend>
        ${activeAreas.map((a) => html`<label class="check"><input type="checkbox" name="area_${a.id}" checked> <span>${a.name}</span></label>`)}
      </fieldset>
      <div class="field--wide"><button class="btn" type="submit">Create collector</button></div></form></div></details>` : ''}
    <div class="toolbar"><input type="search" data-filter="q" placeholder="Search name, email, phone or notes" aria-label="Search"></div>
    <div id="rows"></div>`);

  const columns = role === 'customer'
    ? [
        { label: 'Name', render: (u) => html`<strong>${u.name}</strong>` },
        { label: 'Email', render: (u) => u.email },
        { label: 'Phone', render: (u) => fmtPhone(u.phone) },
        { label: 'Bookings', render: (u) => fmtNum(u.bookings) },
        { label: 'Available points', render: (u) => fmtNum(u.available_points) },
        { label: 'Active', render: (u) => (u.active ? html`<span class="badge badge--good">Active</span>` : html`<span class="badge badge--muted">Inactive</span>`) },
        { label: '', render: (u) => html`<button class="btn btn--sm btn--ghost" data-toggle="${u.id}" data-active="${u.active}">${u.active ? 'Deactivate' : 'Activate'}</button>` },
      ]
    : [
        {
          label: 'Collector',
          render: (u) => html`
            <strong>${u.name}</strong>
            ${u.active ? html`<span class="badge badge--good" style="margin-left: 6px;">Active</span>` : html`<span class="badge badge--muted" style="margin-left: 6px;">Inactive</span>`}
            ${u.availability ? html`<div style="font-size: 0.85rem; color: var(--muted); margin-top: 2px;">🕒 ${u.availability}</div>` : ''}
            ${u.exception_notes ? html`<div style="font-size: 0.85rem; color: var(--muted); margin-top: 2px;">📝 ${u.exception_notes}</div>` : ''}`,
        },
        {
          label: 'Contact',
          render: (u) => html`<div>${u.email}</div><small class="text-muted">${fmtPhone(u.phone)}</small>`,
        },
        {
          label: 'Service areas',
          render: (u) => html`<div>${u.area_names && u.area_names.length ? u.area_names.join(', ') : 'All active areas'}</div>`,
        },
        {
          label: 'Open assignments',
          render: (u) => fmtNum(u.open_assignments),
        },
        {
          label: 'Actions',
          render: (u) => html`
            <div style="display: flex; flex-direction: column; gap: 6px; align-items: flex-start; min-width: 140px;">
              <details class="panel panel--inline" style="width: 100%;">
                <summary><span class="btn btn--sm btn--ghost">Edit profile</span></summary>
                <div style="margin-top: 6px; padding: 12px; background: var(--card); border: 1px solid var(--line); border-radius: var(--radius);">
                  <form class="form-grid form-grid--2" data-edit-collector="${u.id}">
                    <div class="field"><label for="ed-name-${u.id}">Name</label><input id="ed-name-${u.id}" name="name" type="text" value="${u.name}" required maxlength="80"></div>
                    <div class="field"><label for="ed-phone-${u.id}">Mobile number</label><input id="ed-phone-${u.id}" name="phone" type="tel" value="${u.phone || ''}" required></div>
                    <div class="field field--wide"><label for="ed-email-${u.id}">Email</label><input id="ed-email-${u.id}" name="email" type="email" value="${u.email}" required maxlength="120"></div>
                    <div class="field"><label for="ed-avail-${u.id}">Availability <span class="optional">(optional)</span></label><input id="ed-avail-${u.id}" name="availability" type="text" value="${u.availability || ''}" placeholder="e.g. Mon–Fri 9am–5pm"></div>
                    <div class="field" style="display: flex; align-items: center; margin-top: 18px;">
                      <label class="check"><input type="checkbox" name="active" ${u.active ? raw('checked') : ''}> <span>Active collector</span></label>
                    </div>
                    <div class="field field--wide"><label for="ed-notes-${u.id}">Exception notes <span class="optional">(optional)</span></label><textarea id="ed-notes-${u.id}" name="exception_notes" rows="2" placeholder="Internal notes or scheduling restrictions">${u.exception_notes || ''}</textarea></div>
                    <fieldset class="field field--wide"><legend class="label">Service areas served</legend>
                      ${activeAreas.map((a) => {
                        const isChecked = (u.area_ids && u.area_ids.some((id) => Number(id) === a.id)) || (u.area_names && u.area_names.some((name) => areaNamesMatch(name, a.name)));
                        return html`<label class="check"><input type="checkbox" name="area_${a.id}" ${isChecked ? raw('checked') : ''}> <small>${a.name}</small></label>`;
                      })}
                    </fieldset>
                    <div class="field--wide" style="display: flex; justify-content: flex-end; gap: 8px;">
                      <button class="btn btn--sm" type="submit">Save profile</button>
                    </div>
                  </form>
                </div>
              </details>

              <details class="panel panel--inline" style="width: 100%;">
                <summary><span class="btn btn--sm btn--ghost">Set temporary password</span></summary>
                <div style="margin-top: 6px; padding: 12px; background: var(--card); border: 1px solid var(--line); border-radius: var(--radius);">
                  <form class="form-grid" data-temp-pw="${u.id}">
                    <p style="font-size: 0.85rem; color: var(--muted); margin: 0 0 8px 0;">
                      Set a new temporary password. The collector must change it at next login. Existing sessions will be signed out.
                    </p>
                    <div class="field field--wide">
                      <label for="temp-pw-${u.id}">Temporary password</label>
                      <input id="temp-pw-${u.id}" name="password" type="text" autocomplete="new-password" required minlength="10" placeholder="At least 10 characters">
                    </div>
                    <div class="field--wide" style="display: flex; justify-content: flex-end;">
                      <button class="btn btn--sm btn--warn" type="submit">Set temporary password</button>
                    </div>
                  </form>
                </div>
              </details>

              <button class="btn btn--sm btn--ghost" data-toggle="${u.id}" data-active="${u.active}">
                ${u.active ? 'Deactivate' : 'Activate'}
              </button>
            </div>`,
        },
      ];

  const emptyText = rows.length
    ? 'No matches.'
    : role === 'customer' ? 'No customers yet. Customers appear here after they sign up.' : 'No collectors yet. Use “Add a collector” above.';
  wireFilter(main, rows, (list) => table(columns, list, { emptyText }), (u, f) => !f.q || [u.name, u.email, u.phone, u.availability, u.exception_notes].join(' ').toLowerCase().includes(f.q));
  main.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-toggle]');
    if (!b) return;
    try {
      await put(`/admin/users/${b.dataset.toggle}`, { active: b.dataset.active !== '1' });
      toast('Saved.');
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
  main.addEventListener('submit', async (e) => {
    const editForm = e.target.closest('[data-edit-collector]');
    if (editForm) {
      e.preventDefault();
      const btn = editForm.querySelector('[type=submit]');
      if (btn) btn.disabled = true;
      try {
        const v = readForm(editForm);
        const id = editForm.dataset.editCollector;
        const area_ids = Object.keys(v).filter((k) => k.startsWith('area_') && v[k]).map((k) => Number(k.slice(5)));
        await put(`/admin/users/${id}`, {
          name: v.name,
          phone: v.phone,
          email: v.email,
          active: Boolean(v.active),
          availability: v.availability || null,
          exception_notes: v.exception_notes || null,
          area_ids,
        });
        toast('Collector profile updated.');
        ctx.refresh();
      } catch (err) {
        toast(err.message, 'bad');
      } finally {
        if (btn && btn.isConnected) btn.disabled = false;
      }
      return;
    }

    const pwForm = e.target.closest('[data-temp-pw]');
    if (pwForm) {
      e.preventDefault();
      const btn = pwForm.querySelector('[type=submit]');
      if (btn) btn.disabled = true;
      try {
        const v = readForm(pwForm);
        const id = pwForm.dataset.tempPw;
        const res = await post(`/admin/users/${id}/temporary-password`, { password: v.password });
        toast(res.message || 'Temporary password set successfully.');
        pwForm.reset();
        const details = pwForm.closest('details');
        if (details) details.removeAttribute('open');
        ctx.refresh();
      } catch (err) {
        toast(err.message, 'bad');
      } finally {
        if (btn && btn.isConnected) btn.disabled = false;
      }
      return;
    }

    const af = e.target.closest('[data-edit-areas]');
    if (af) {
      e.preventDefault();
      const btn = af.querySelector('[type=submit]');
      if (btn) btn.disabled = true;
      try {
        const v = readForm(af);
        const area_ids = Object.keys(v).filter((k) => k.startsWith('area_') && v[k]).map((k) => Number(k.slice(5)));
        await put(`/admin/users/${af.dataset.editAreas}`, { area_ids });
        toast('Service areas updated.');
        ctx.refresh();
      } catch (err) {
        toast(err.message, 'bad');
      } finally {
        if (btn && btn.isConnected) btn.disabled = false;
      }
      return;
    }
  });
  const nf = main.querySelector('#new-user');
  if (nf) onSubmit(nf, async (v) => {
    const area_ids = Object.keys(v).filter((k) => k.startsWith('area_') && v[k]).map((k) => Number(k.slice(5)));
    await post('/admin/users', { ...v, role, area_ids });
    toast('Collector created.');
    ctx.refresh();
  });
}

// ----------------------------------------------------------------------- Eco Wallet review
function valuate(rule, qty, weight, rpp) {
  if (!rule) return { ok: false, points: 0, rupee: 0, reason: 'Choose a rule' };
  const basis = rule.valuation_method === 'per_kg' ? weight : qty;
  if (!(basis > 0)) return { ok: false, points: 0, rupee: 0, reason: rule.valuation_method === 'per_kg' ? 'Enter the verified weight' : 'Enter the verified count' };
  if (rule.rate_type === 'points') {
    const points = Math.floor(basis * rule.rate);
    return { ok: points > 0, points, rupee: Math.round(points * rpp * 100) / 100 };
  }
  const rupee = Math.round(basis * rule.rate * 100) / 100;
  const points = rpp > 0 ? Math.floor(rupee / rpp) : 0;
  return { ok: points > 0, points, rupee };
}
const ruleLabel = (r) => `${r.rate_type === 'points' ? `${r.rate} pts` : `₹${r.rate}`} per ${r.valuation_method === 'per_kg' ? 'kg' : 'item'} · from ${r.effective_date}${r.is_sample ? ' · sample' : ''}`;

async function wallet(main, ctx) {
  const status = ctx.query.get('status') ?? 'Pending';
  const data = await api(`/admin/wallet${status ? `?status=${status}` : ''}`);
  const rpp = data.rupees_per_point;
  const categories = data.categories || [];
  frame(main, 'wallet', 'Eco Wallet transactions', 'Points become available to customers only after approval here.', html`
    <details class="panel" id="rules-panel" style="margin-bottom: 20px;">
      <summary>Configure Points Rules by Item Category (${data.rules.length} configured)</summary>
      <div>
        <p class="muted" style="margin-bottom: 12px;">
          Create and edit points rules by item category, with editable points per item and per kilogram.
          When collectors record pickups, the matching active rule calculates pending points automatically.
        </p>

        <details class="panel panel--inline" style="margin-bottom: 16px;">
          <summary><span class="btn btn--sm">Add points rule</span></summary>
          <div style="margin-top: 8px; padding: 12px; background: var(--card); border: 1px solid var(--line); border-radius: var(--radius);">
            <form class="form-grid form-grid--2" id="wallet-new-rule">
              <div class="field">
                <label for="w-cat">Item category</label>
                <select id="w-cat" name="category_id" required>
                  <option value="">Select category…</option>
                  ${categories.map((c) => html`<option value="${c.id}">${c.name}</option>`)}
                </select>
              </div>
              <div class="field">
                <label for="w-method">Valuation method</label>
                <select id="w-method" name="valuation_method" required>
                  <option value="per_item">Per item (uses count)</option>
                  <option value="per_kg">Per kg (uses weight)</option>
                </select>
              </div>
              <div class="field">
                <label for="w-type">Rate type</label>
                <select id="w-type" name="rate_type" required>
                  <option value="points">Points per unit</option>
                  <option value="rupees">₹ per unit (converted to points)</option>
                </select>
              </div>
              <div class="field">
                <label for="w-rate">Rate</label>
                <input id="w-rate" name="rate" type="number" step="0.01" min="0" required placeholder="e.g. 50">
              </div>
              <div class="field">
                <label for="w-date">Effective from</label>
                <input id="w-date" name="effective_date" type="date" value="${todayIST()}" required>
              </div>
              <div class="field" style="display: flex; gap: 16px; align-items: center; margin-top: 18px;">
                <label class="check"><input type="checkbox" name="active" checked> <span>Active</span></label>
                <label class="check"><input type="checkbox" name="is_sample"> <span>Sample / Provisional</span></label>
              </div>
              <div class="field field--wide">
                <label for="w-notes">Admin notes <span class="optional">(optional)</span></label>
                <input id="w-notes" name="admin_notes" placeholder="e.g. promotional rate, bulk pricing">
              </div>
              <div class="field--wide" style="display: flex; justify-content: flex-end;">
                <button class="btn btn--sm" type="submit">Create points rule</button>
              </div>
            </form>
          </div>
        </details>

        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Method</th>
                <th>Rate</th>
                <th>Effective from</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${data.rules.length ? data.rules.map((r) => html`
                <tr>
                  <td><strong>${r.category_name}</strong></td>
                  <td>${r.valuation_method === 'per_kg' ? 'Per kilogram' : 'Per item'}</td>
                  <td><strong>${r.rate} ${r.rate_type === 'points' ? 'pts' : '₹'}</strong></td>
                  <td>${fmtDate(r.effective_date)}</td>
                  <td>
                    ${r.active ? html`<span class="badge badge--good">Active</span>` : html`<span class="badge badge--muted">Inactive</span>`}
                    ${r.is_sample ? html`<span class="tag">Sample</span>` : ''}
                  </td>
                  <td>
                    <details class="panel panel--inline">
                      <summary><small>Edit</small></summary>
                      <div style="margin-top: 6px; padding: 10px; background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); min-width: 260px;">
                        <form class="form-grid" data-edit-rule="${r.id}">
                          <div class="field">
                            <label>Method</label>
                            <select name="valuation_method">
                              <option value="per_item" ${r.valuation_method === 'per_item' ? raw('selected') : ''}>Per item</option>
                              <option value="per_kg" ${r.valuation_method === 'per_kg' ? raw('selected') : ''}>Per kg</option>
                            </select>
                          </div>
                          <div class="field">
                            <label>Rate</label>
                            <input name="rate" type="number" step="0.01" min="0" value="${r.rate}" required>
                          </div>
                          <div class="field">
                            <label>Effective from</label>
                            <input name="effective_date" type="date" value="${r.effective_date}" required>
                          </div>
                          <div class="field">
                            <label class="check"><input type="checkbox" name="active" ${r.active ? raw('checked') : ''}> <span>Active</span></label>
                          </div>
                          <div class="field">
                            <label class="check"><input type="checkbox" name="is_sample" ${r.is_sample ? raw('checked') : ''}> <span>Sample</span></label>
                          </div>
                          <div class="field">
                            <button class="btn btn--sm" type="submit">Save</button>
                          </div>
                        </form>
                      </div>
                    </details>
                  </td>
                </tr>
              `) : html`<tr><td colspan="6" class="muted">No points rules configured yet.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </details>

    <div class="tabs">${['Pending', 'Approved', 'Rejected', 'Redeemed', ''].map((s) => html`<a class="btn btn--sm ${s === status ? '' : 'btn--ghost'}" href="#/admin/wallet?status=${s}">${s || 'All'}</a>`)}</div>
    <div class="toolbar"><input type="search" data-filter="q" placeholder="Search customer, booking or category" aria-label="Search"></div>
    <div id="rows"></div>`);
  const editTxnPanel = (t) => {
    if (t.status === 'Redeemed' || t.redemption_id) return '';
    const initialRules = data.rules.filter((r) => r.category_id === t.category_id && (r.active || r.id === t.rule_id));
    return html`
      <details class="panel panel--inline" style="margin-top: 6px;">
        <summary><small>Edit transaction</small></summary>
        <div style="margin-top: 6px; padding: 12px; background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); min-width: 320px; max-width: 440px;">
          <div style="font-size: 0.85rem; margin-bottom: 8px; border-bottom: 1px solid var(--line); padding-bottom: 6px;">
            <div><strong>Customer:</strong> ${t.customer_name}</div>
            <div><strong>Linked Pickup:</strong> ${t.booking_code}</div>
            <div><strong>Current status:</strong> ${badge(t.status)} (${fmtNum(t.points)} pts)</div>
          </div>
          <form class="form-grid" data-edit-txn="${t.id}" data-current-status="${t.status}" data-current-points="${t.points}">
            <div class="field">
              <label>Item category</label>
              <select name="category_id" required data-txn-cat="${t.id}">
                ${categories.map((c) => html`<option value="${c.id}" ${c.id === t.category_id ? raw('selected') : ''}>${c.name}</option>`)}
              </select>
            </div>
            <div class="inline-form">
              <div class="field"><label>Count<input type="number" name="verified_qty" min="0" value="${t.verified_qty ?? ''}"></label></div>
              <div class="field"><label>Weight kg<input type="number" name="verified_weight_kg" min="0" step="0.01" value="${t.verified_weight_kg ?? ''}"></label></div>
            </div>
            <div class="field">
              <label>Points rule</label>
              <select name="rule_id" required data-txn-rule="${t.id}">
                ${initialRules.map((r) => html`<option value="${r.id}" ${r.id === t.rule_id ? raw('selected') : ''}>${ruleLabel(r)}</option>`)}
              </select>
            </div>
            <div class="field">
              <label>Review note <span class="optional">(optional)</span></label>
              <input name="admin_note" value="${t.admin_note || ''}" placeholder="Internal remarks">
            </div>
            ${t.status === 'Approved' ? html`
              <div class="field">
                <label>Audit note <span style="color: var(--danger-600); font-weight: bold;">(required for approved corrections)</span></label>
                <input name="audit_note" required placeholder="Reason for adjusting approved points">
              </div>
            ` : ''}
            <div class="callout" data-impact-preview style="font-size: 0.85rem; margin-top: 4px; padding: 6px 10px;"></div>
            <div style="display: flex; justify-content: flex-end; margin-top: 8px;">
              <button class="btn btn--sm" type="submit">Save correction</button>
            </div>
          </form>
        </div>
      </details>`;
  };

  const reviewCell = (t) => {
    if (t.status === 'Pending') {
      const rules = data.rules.filter((r) => r.category_id === t.category_id && (r.active || r.id === t.rule_id));
      return html`<form class="form-grid" data-review="${t.id}">
        <div class="inline-form">
          <div class="field"><label>Count<input type="number" name="verified_qty" min="0" value="${t.verified_qty ?? ''}"></label></div>
          <div class="field"><label>Weight kg<input type="number" name="verified_weight_kg" min="0" step="0.01" value="${t.verified_weight_kg ?? ''}"></label></div>
        </div>
        <div class="field"><label>Rule<select name="rule_id"><option value="">Choose rule…</option>${rules.map((r) => html`<option value="${r.id}" ${r.id === t.rule_id ? raw('selected') : ''}>${ruleLabel(r)}</option>`)}</select></label></div>
        <p class="muted" data-preview></p>
        <div class="field"><label>Review note <span class="optional">(optional for approval, required to reject)</span><input name="admin_note" value="${t.admin_note || ''}"></label></div>
        <div class="row"><button class="btn btn--sm" name="decision" value="approve" type="submit">Approve</button><button class="btn btn--sm btn--danger" name="decision" value="reject" type="submit">Reject</button></div>
      </form>
      ${editTxnPanel(t)}`;
    }
    return html`${t.reviewed_by_name ? html`${t.reviewed_by_name}<br><small>${fmtDateTime(t.reviewed_at)}</small>` : '—'}${t.admin_note ? html`<br><small>${t.admin_note}</small>` : ''}
      ${t.status === 'Approved' && !t.redemption_id ? html`<form class="inline-form section" data-reverse="${t.id}"><input name="admin_note" placeholder="Reason to reverse" aria-label="Reason to reverse" required><button class="btn btn--sm btn--ghost" type="submit">Reverse</button></form>` : ''}
      ${editTxnPanel(t)}`;
  };
  wireFilter(main, data.transactions, (list) => table([
    { label: 'Created', render: (t) => fmtDateTime(t.created_at) },
    { label: 'Customer', render: (t) => t.customer_name },
    { label: 'Booking', render: (t) => codeLink(t) },
    { label: 'Category', render: (t) => t.category_name },
    { label: 'Collected', render: (t) => `${t.collected_qty ?? '—'} items${t.collected_weight_kg != null ? ` · ${t.collected_weight_kg} kg` : ''}` },
    { label: 'Rule used', render: (t) => html`<small>${t.rule_used || 'None'}</small>` },
    { label: 'Points', render: (t) => html`<strong>${fmtNum(t.points)}</strong><br><small>${fmtINR(t.rupee_value)}</small>` },
    { label: 'Status', render: (t) => html`${badge(t.status)}${t.redemption_id && t.status === 'Approved' ? html`<br><small>in redemption</small>` : ''}` },
    { label: 'Review', render: reviewCell },
  ], list, {
    emptyText: data.transactions.length ? 'No matches.'
      : status ? `No ${status.toLowerCase()} Eco Wallet transactions.` : 'No Eco Wallet transactions yet. When collectors record pickups, they appear here.',
  }), (t, f) => !f.q || [t.customer_name, t.booking_code, t.category_name].join(' ').toLowerCase().includes(f.q));

  const host = main.querySelector('#rows');
  const bind = () => {
    host.querySelectorAll('[data-review]').forEach((f) => {
      if (f.dataset.bound) return;
      f.dataset.bound = '1';
      const preview = () => {
        const rule = data.rules.find((r) => r.id === Number(f.rule_id.value));
        const v = valuate(rule, Number(f.verified_qty.value), Number(f.verified_weight_kg.value), rpp);
        f.querySelector('[data-preview]').textContent = v.ok ? `Will credit ${fmtNum(v.points)} pts (${fmtINR(v.rupee)})` : v.reason || 'Valuation comes to 0 points';
      };
      f.addEventListener('input', preview);
      preview();
      onSubmit(f, async (v, submitter) => {
        const decision = submitter && submitter.value;
        await post(`/admin/wallet/${f.dataset.review}/review`, { ...v, decision, rule_id: v.rule_id ? Number(v.rule_id) : null });
        toast(decision === 'approve' ? 'Approved — points are now available to the customer.' : 'Rejected.');
        ctx.refresh();
      });
    });
    host.querySelectorAll('[data-reverse]').forEach((f) => {
      if (f.dataset.bound) return;
      f.dataset.bound = '1';
      onSubmit(f, async (v) => {
        await post(`/admin/wallet/${f.dataset.reverse}/reverse`, v);
        toast('Reversed.');
        ctx.refresh();
      });
    });
    host.querySelectorAll('[data-edit-txn]').forEach((f) => {
      if (f.dataset.boundEdit) return;
      f.dataset.boundEdit = '1';
      const catSelect = f.querySelector('[data-txn-cat]');
      const ruleSelect = f.querySelector('[data-txn-rule]');
      const impactEl = f.querySelector('[data-impact-preview]');
      const currentPoints = Number(f.dataset.currentPoints || 0);
      const isApproved = f.dataset.currentStatus === 'Approved';

      const updateRulesAndPreview = () => {
        const catId = Number(catSelect.value);
        const catRules = data.rules.filter((r) => r.category_id === catId && (r.active || r.id === Number(ruleSelect.value)));
        const currentRuleId = Number(ruleSelect.value);

        const optionsHtml = catRules.map((r) => `<option value="${r.id}" ${r.id === currentRuleId ? 'selected' : ''}>${ruleLabel(r)}</option>`).join('');
        if (ruleSelect.innerHTML !== optionsHtml) {
          ruleSelect.innerHTML = optionsHtml;
        }

        const selectedRule = data.rules.find((r) => r.id === Number(ruleSelect.value));
        const qty = Number(f.verified_qty.value);
        const weight = Number(f.verified_weight_kg.value);
        const v = valuate(selectedRule, qty, weight, rpp);

        if (!v.ok) {
          impactEl.textContent = v.reason || 'Select rule and enter count or weight';
          impactEl.className = 'callout callout--warn';
        } else {
          const diff = v.points - currentPoints;
          const diffStr = diff >= 0 ? `+${fmtNum(diff)}` : fmtNum(diff);
          if (isApproved) {
            impactEl.innerHTML = `Recalculated: <strong>${fmtNum(v.points)} pts</strong> (${fmtINR(v.rupee)}).<br>Proposed balance impact: <strong>${diffStr} pts</strong> to customer available balance.`;
          } else {
            impactEl.innerHTML = `Recalculated: <strong>${fmtNum(v.points)} pts</strong> (${fmtINR(v.rupee)}).<br>Proposed pending impact: <strong>${diffStr} pts</strong> (available balance unaffected until approval).`;
          }
          impactEl.className = 'callout';
        }
      };

      catSelect.addEventListener('change', () => {
        const catId = Number(catSelect.value);
        const firstRule = data.rules.find((r) => r.category_id === catId && r.active);
        if (firstRule) ruleSelect.value = firstRule.id;
        updateRulesAndPreview();
      });
      f.addEventListener('input', updateRulesAndPreview);
      updateRulesAndPreview();

      onSubmit(f, async (v) => {
        await put(`/admin/wallet/${f.dataset.editTxn}`, {
          category_id: Number(v.category_id),
          verified_qty: v.verified_qty !== '' ? Number(v.verified_qty) : null,
          verified_weight_kg: v.verified_weight_kg !== '' ? Number(v.verified_weight_kg) : null,
          rule_id: Number(v.rule_id),
          admin_note: v.admin_note || null,
          audit_note: v.audit_note || null,
        });
        toast('Transaction corrected.');
        ctx.refresh();
      });
    });
  };
  bind();
  main.querySelector('[data-filter=q]').addEventListener('input', bind);

  const newRuleForm = main.querySelector('#wallet-new-rule');
  if (newRuleForm) {
    onSubmit(newRuleForm, async (v) => {
      await post('/admin/rules', {
        ...v,
        category_id: Number(v.category_id),
        rate: Number(v.rate),
        active: Boolean(v.active),
        is_sample: Boolean(v.is_sample),
      });
      toast('Points rule created.');
      ctx.refresh();
    });
  }

  main.querySelectorAll('[data-edit-rule]').forEach((f) => {
    onSubmit(f, async (v) => {
      await put(`/admin/rules/${f.dataset.editRule}`, {
        valuation_method: v.valuation_method,
        rate: Number(v.rate),
        effective_date: v.effective_date,
        active: Boolean(v.active),
        is_sample: Boolean(v.is_sample),
      });
      toast('Points rule updated.');
      ctx.refresh();
    });
  });
}

async function redemptions(main, ctx) {
  const [rows, s] = await Promise.all([api('/admin/redemptions'), api('/admin/settings')]);
  const enabled = s.values.redemption_enabled && s.values.redemption_method;
  frame(main, 'redemptions', 'Redemptions', enabled ? `Method: ${s.values.redemption_method}` : 'Redemption is switched off — customers see “Redemption coming soon”.', html`
    ${enabled ? '' : html`<p class="callout">Turn on redemption and set a method in <a href="#/admin/settings">Settings</a> once it is approved. Payouts are made outside this app; record the payment or voucher reference here.</p>`}
    ${table([
      { label: 'Requested', render: (r) => fmtDateTime(r.created_at) },
      { label: 'Customer', render: (r) => html`${r.customer_name}<br><small>${fmtPhone(r.customer_phone)}</small>` },
      { label: 'Points', render: (r) => fmtNum(r.points) },
      { label: '₹ value', render: (r) => fmtINR(r.rupee_value) },
      { label: 'Method', render: (r) => r.method },
      { label: 'Status', render: (r) => badge(r.status) },
      { label: 'Action', render: (r) => (r.status === 'Requested'
        ? html`<form class="form-grid" data-red="${r.id}"><input name="reference" placeholder="Payment / voucher ref" aria-label="Reference"><input name="admin_note" placeholder="Note (required to reject)" aria-label="Note">
          <div class="row"><button class="btn btn--sm" name="action" value="fulfil">Mark fulfilled</button><button class="btn btn--sm btn--danger" name="action" value="reject">Reject</button></div></form>`
        : html`${r.reviewed_by_name || ''}<br><small>${fmtDateTime(r.reviewed_at)}${r.reference ? ` · ${r.reference}` : ''}</small>`) },
    ], rows, { emptyText: 'No redemption requests.' })}`);
  main.querySelectorAll('[data-red]').forEach((f) => onSubmit(f, async (v, submitter) => {
    await post(`/admin/redemptions/${f.dataset.red}/${submitter.value}`, v);
    toast('Saved.');
    ctx.refresh();
  }));
}

// ----------------------------------------------------------------------- Simple editable tables
async function entityPage(main, ctx, { key, entity, title, sub, fields, columns, intro }) {
  const rows = await api(`/admin/entity/${entity}`);
  const resolvedFields = typeof fields === 'function' ? await fields() : fields;
  frame(main, key, title, sub, html`
    ${intro || ''}
    <details class="panel"><summary>Add new</summary><div><form class="form-grid form-grid--2" id="new">${formFields(resolvedFields)}<div class="field--wide"><button class="btn" type="submit">Add</button></div></form></div></details>
    ${rows.length ? rows.map((r) => html`<details class="panel"><summary>${columns(r)}</summary><div>
      <form class="form-grid form-grid--2" data-id="${r.id}">${formFields(resolvedFields, r)}<div class="field--wide"><button class="btn btn--sm" type="submit">Save changes</button></div></form></div></details>`) : empty('Nothing here yet.')}`);
  onSubmit(main.querySelector('#new'), async (v) => {
    await post(`/admin/entity/${entity}`, v);
    toast('Added.');
    ctx.state.config = await api('/public/config');
    ctx.refresh();
  });
  main.querySelectorAll('[data-id]').forEach((f) => onSubmit(f, async (v) => {
    await put(`/admin/entity/${entity}/${f.dataset.id}`, v);
    toast('Saved.');
    ctx.state.config = await api('/public/config');
    ctx.refresh();
  }));
}

const areas = (main, ctx) => entityPage(main, ctx, {
  key: 'areas', entity: 'areas', title: 'Service areas', sub: 'Customers can only book in active areas. A PIN code maps to one area.',
  fields: [
    { name: 'name', label: 'Area name', required: true }, { name: 'city', label: 'City', required: true, default: 'Visakhapatnam' },
    { name: 'pincodes', label: 'PIN codes', required: true, help: 'Comma-separated, e.g. 530048, 530041', wide: true },
    { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, wide: true }, { name: 'active', label: 'Active — open for bookings', type: 'checkbox', default: 1 },
  ],
  columns: (r) => html`${r.name} · <span class="code">${r.pincodes}</span> ${r.active ? '' : html`<span class="badge badge--muted">Inactive</span>`}`,
});

const categories = (main, ctx) => entityPage(main, ctx, {
  key: 'categories', entity: 'categories', title: 'Item categories', sub: 'Only accepted categories can be booked. Collectors can still record any category.',
  fields: [
    { name: 'name', label: 'Name', required: true }, { name: 'sort_order', label: 'Display order', type: 'number', min: 0, default: 0 },
    { name: 'description', label: 'Description', type: 'textarea', rows: 2, wide: true }, { name: 'handling_notes', label: 'Handling notes', type: 'textarea', rows: 2, wide: true },
    { name: 'accepted', label: 'Accepted for pickup', type: 'checkbox', default: 1 },
  ],
  columns: (r) => html`${r.name} ${r.accepted ? '' : html`<span class="badge badge--muted">Not accepted</span>`}`,
});

const recyclers = (main, ctx) => entityPage(main, ctx, {
  key: 'recyclers', entity: 'recyclers', title: 'Recyclers',
  sub: 'A certification claim is shown to customers only when the recycler is marked verified AND “show claim” is on.',
  intro: html`<p class="callout callout--warn">Before marking a recycler verified, check their registration and authorisation documents (for example, CPCB/State Pollution Control Board authorisation) and keep copies outside this app.</p>`,
  fields: [
    { name: 'name', label: 'Name', required: true }, { name: 'contact_name', label: 'Contact person' }, { name: 'phone', label: 'Phone' },
    { name: 'address', label: 'Address' }, { name: 'certification_claim', label: 'Certification claim shown to customers', wide: true, help: 'Exact wording, e.g. “Authorised e-waste recycler, APPCB authorisation no. …”' },
    { name: 'notes', label: 'Internal notes', type: 'textarea', rows: 2, wide: true },
    { name: 'verified', label: 'Documents verified by operator', type: 'checkbox' }, { name: 'show_certified', label: 'Show certification claim to customers', type: 'checkbox' },
    { name: 'active', label: 'Active', type: 'checkbox', default: 1 },
  ],
  columns: (r) => html`${r.name} ${r.verified ? html`<span class="badge badge--good">Verified</span>` : html`<span class="badge badge--warn">Not verified</span>`} ${r.active ? '' : html`<span class="badge badge--muted">Inactive</span>`}`,
});

async function rules(main, ctx) {
  const cats = await api('/admin/entity/categories');
  const catName = Object.fromEntries(cats.map((c) => [c.id, c.name]));
  await entityPage(main, ctx, {
    key: 'rules', entity: 'rules', title: 'Eco Points rules',
    sub: 'The latest active rule with an effective date on or before the collection date is applied. Edit freely — nothing is hard-coded.',
    intro: html`<p class="callout">Rates are not hard-coded. Add one active rule per accepted category before approving Eco Points. Tick “Provisional” for rates that are not final; customers see them labelled as sample rates.</p>`,
    fields: [
      { name: 'category_id', label: 'Item category', type: 'select', required: true, options: cats.map((c) => ({ value: c.id, label: c.name })) },
      { name: 'valuation_method', label: 'Valuation method', type: 'select', required: true, options: [{ value: 'per_item', label: 'Per item (uses count)' }, { value: 'per_kg', label: 'Per kg (uses weight)' }] },
      { name: 'rate_type', label: 'Rate type', type: 'select', required: true, options: [{ value: 'points', label: 'Points per unit' }, { value: 'rupees', label: '₹ per unit (converted to points)' }] },
      { name: 'rate', label: 'Rate', type: 'number', step: '0.01', min: 0, required: true },
      { name: 'effective_date', label: 'Effective from', type: 'date', required: true, default: todayIST() },
      { name: 'admin_notes', label: 'Admin notes', type: 'textarea', rows: 2, wide: true },
      { name: 'active', label: 'Active', type: 'checkbox', default: 1 }, { name: 'is_sample', label: 'Provisional (shown to customers as a sample rate)', type: 'checkbox' },
    ],
    columns: (r) => html`${catName[r.category_id]} — ${ruleLabel(r)} ${r.is_sample ? html`<span class="tag">Sample</span>` : ''} ${r.active ? '' : html`<span class="badge badge--muted">Inactive</span>`}`,
  });
}

// ----------------------------------------------------------------------- Slots
async function slots(main, ctx) {
  const from = ctx.query.get('from') || todayIST();
  const areaId = ctx.query.get('area') || '';
  const [rows, areaRows] = await Promise.all([api(`/admin/slots?from=${from}${areaId ? `&area_id=${areaId}` : ''}`), api('/admin/entity/areas')]);
  frame(main, 'slots', 'Pickup slots', 'Remaining capacity drops when a booking is confirmed and is restored on cancellation.', html`
    <details class="panel"><summary>Generate slots for a date range</summary><div>
      <form class="form-grid form-grid--2" id="gen">
        ${formFields([
          { name: 'from', label: 'From', type: 'date', required: true, default: todayIST() },
          { name: 'to', label: 'To', type: 'date', required: true },
          { name: 'windows', label: 'Time windows', required: true, default: '09:00-12:00, 12:00-15:00, 15:00-18:00', help: 'Comma-separated, 24-hour HH:MM-HH:MM' },
          { name: 'capacity', label: 'Capacity per slot', type: 'number', min: 1, required: true, default: 6 },
        ])}
        <fieldset class="field field--wide"><legend class="label">Service areas</legend>${areaRows.filter((a) => a.active).map((a) => html`<label class="check"><input type="checkbox" name="area_${a.id}" checked> <span>${a.name}</span></label>`)}</fieldset>
        <label class="check"><input type="checkbox" name="skip_sundays"> <span>Skip Sundays</span></label>
        <div class="field--wide"><button class="btn" type="submit">Generate</button> <span class="muted">Existing slots are left unchanged.</span></div>
      </form></div></details>
    <form class="toolbar" id="filter">
      <label class="visually-hidden" for="from">From date</label><input type="date" id="from" name="from" value="${from}">
      <select name="area" aria-label="Area"><option value="">All areas</option>${areaRows.map((a) => html`<option value="${a.id}" ${String(a.id) === areaId ? raw('selected') : ''}>${a.name}</option>`)}</select>
      <button class="btn btn--sm btn--secondary" type="submit">Show 7 days</button>
    </form>
    ${table([
      { label: 'Date', render: (s) => fmtDay(s.date) },
      { label: 'Window', render: (s) => fmtWindow(`${s.start_time}-${s.end_time}`) },
      { label: 'Area', render: (s) => s.area_name },
      { label: 'Booked', render: (s) => fmtNum(s.booked) },
      { label: 'Remaining', render: (s) => (s.remaining > 0 ? fmtNum(s.remaining) : html`<span class="badge badge--warn">Full</span>`) },
      { label: 'Capacity / active', render: (s) => html`<form class="inline-form" data-slot="${s.id}"><input type="number" name="capacity" min="${s.booked}" max="200" value="${s.capacity}" aria-label="Capacity" class="w-sm">
        <label class="check"><input type="checkbox" name="active" ${s.active ? raw('checked') : ''}> <span>Active</span></label><button class="btn btn--sm btn--ghost" type="submit">Save</button></form>` },
    ], rows, { emptyText: 'No slots in this range. Generate some above.' })}`);
  main.querySelector('#filter').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    location.hash = `#/admin/slots?from=${f.from.value}${f.area.value ? `&area=${f.area.value}` : ''}`;
  });
  onSubmit(main.querySelector('#gen'), async (v) => {
    const windows = v.windows.split(',').map((w) => w.trim().split('-').map((t) => t.trim())).map(([start, end]) => ({ start, end }));
    const area_ids = Object.keys(v).filter((k) => k.startsWith('area_') && v[k]).map((k) => Number(k.slice(5)));
    const r = await post('/admin/slots/generate', { from: v.from, to: v.to, windows, capacity: Number(v.capacity), area_ids, skip_sundays: v.skip_sundays });
    toast(`${r.created} new slots created.`);
    ctx.refresh();
  });
  main.querySelectorAll('[data-slot]').forEach((f) => onSubmit(f, async (v) => {
    await put(`/admin/slots/${f.dataset.slot}`, { capacity: Number(v.capacity), active: v.active });
    toast('Slot saved.');
    ctx.refresh();
  }));
}

// ----------------------------------------------------------------------- Handoffs
async function handoffs(main, ctx) {
  const [data, recyclerRows] = await Promise.all([api('/admin/handoffs'), api('/admin/entity/recyclers')]);
  const active = recyclerRows.filter((r) => r.active);
  frame(main, 'handoffs', 'Recycler handoffs', 'Recording a handoff moves the selected bookings from “Collected” to “Received by recycler”.', html`
    <section class="card">
      <h2>Record a handoff</h2>
      ${active.length ? '' : html`<p class="callout callout--warn">No recyclers yet. <a href="#/admin/recyclers">Add a recycler</a> before recording a handoff.</p>`}
      ${data.eligible.length ? html`<form class="form-grid" id="handoff">
        <div class="form-grid form-grid--2">${formFields([
          { name: 'recycler_id', label: 'Recycler', type: 'select', required: true, placeholder: 'Choose…', options: active.map((r) => ({ value: r.id, label: `${r.name}${r.verified ? '' : ' (not verified)'}` })) },
          { name: 'handoff_date', label: 'Handoff date', type: 'date', required: true, default: todayIST() },
          { name: 'receipt_ref', label: 'Recycler receipt / reference number' },
          { name: 'reference', label: 'Batch reference', help: 'Leave blank to generate one' },
          { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, wide: true },
        ])}</div>
        <fieldset><legend class="label">Collected bookings in this batch</legend>
          ${table([
            { label: 'Include', render: (b) => html`<label class="check"><input type="checkbox" name="b_${b.id}" checked><span class="visually-hidden">Include ${b.booking_code}</span></label>` },
            { label: 'Booking', render: codeLink },
            { label: 'Collected', render: (b) => fmtDateTime(b.collected_at) },
            { label: 'Area', render: (b) => b.area_name },
            { label: 'Items', render: (b) => b.collected_summary },
          ], data.eligible)}
        </fieldset>
        <div><button class="btn" type="submit">Record handoff</button></div>
      </form>` : empty('No collected bookings are waiting for handoff.')}
    </section>
    <section class="section"><h2>Past handoffs</h2>
      ${table([
        { label: 'Reference', render: (h) => html`<span class="code">${h.reference}</span>` },
        { label: 'Date', render: (h) => fmtDate(h.handoff_date) },
        { label: 'Recycler', render: (h) => h.recycler_name },
        { label: 'Receipt ref', render: (h) => h.receipt_ref || '—' },
        { label: 'Bookings', render: (h) => html`<small class="code">${h.bookings}</small>` },
        { label: 'Items', render: (h) => h.items },
        { label: 'Recorded by', render: (h) => html`${h.created_by_name || ''}<br><small>${fmtDateTime(h.created_at)}</small>` },
      ], data.handoffs, { emptyText: 'No handoffs recorded yet.' })}
    </section>`);
  const form = main.querySelector('#handoff');
  if (form) onSubmit(form, async (v) => {
    const booking_ids = Object.keys(v).filter((k) => k.startsWith('b_') && v[k]).map((k) => Number(k.slice(2)));
    const r = await post('/admin/handoffs', { ...v, recycler_id: Number(v.recycler_id), booking_ids });
    toast(`Handoff ${r.reference} recorded.`);
    ctx.refresh();
  });
}

// ----------------------------------------------------------------------- Settings & audit
async function settings(main, ctx) {
  const { schema, values } = await api('/admin/settings');
  const fields = Object.entries(schema).map(([name, d]) => ({
    name, label: d.label, type: d.type === 'bool' ? 'checkbox' : d.type === 'number' ? 'number' : 'text', step: d.type === 'number' ? 'any' : null, min: d.min, required: d.type === 'number',
  }));
  frame(main, 'settings', 'Settings', 'Fees, cutoffs, Eco Points value and redemption. Every change is written to the audit log.', html`
    <p class="callout callout--warn">Customers see the pickup fee before confirming. Keep “point value is a sample” ticked and redemption off until the value and payout method are approved.</p>
    <form class="card form-grid form-grid--2" id="settings">${formFields(fields, values)}<div class="field--wide"><button class="btn" type="submit">Save settings</button></div></form>`);
  onSubmit(main.querySelector('#settings'), async (v) => {
    const r = await put('/admin/settings', v);
    ctx.state.config = await api('/public/config');
    toast(r.changed.length ? `Saved: ${r.changed.join(', ')}` : 'No changes.');
    ctx.refresh();
  });
}

async function audit(main) {
  const rows = await api('/admin/audit');
  frame(main, 'audit', 'Audit log', 'Latest 500 admin and collection actions. Booking status changes are also kept in each booking’s history.', html`
    <div class="toolbar"><input type="search" data-filter="q" placeholder="Search action, person or details" aria-label="Search"></div><div id="rows"></div>`);
  wireFilter(main, rows, (list) => table([
    { label: 'When', render: (a) => fmtDateTime(a.at) },
    { label: 'Who', render: (a) => a.actor_name || 'System' },
    { label: 'Record', render: (a) => `${a.entity}${a.entity_id ? ` #${a.entity_id}` : ''}` },
    { label: 'Action', render: (a) => a.action },
    { label: 'Details', render: (a) => html`<small class="code">${a.details || ''}</small>` },
  ], list), (a, f) => !f.q || [a.entity, a.action, a.actor_name, a.details].join(' ').toLowerCase().includes(f.q));
}
