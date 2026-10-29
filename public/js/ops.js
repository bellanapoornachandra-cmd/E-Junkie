// Pickup details (shared by all roles, with role-specific actions) and the collector dashboard.
import {
  html, raw, api, toast, empty, onSubmit, badge, timeline, itemsList,
  fmtDate, fmtDay, fmtDateTime, fmtWindow, fmtINR, fmtNum, fmtPhone, todayIST, supportText,
  collectorServesBooking,
} from './ui.js';
import { DATA_WIPE_TEXT } from './customer.js';

const OPEN = ['Booked', 'Collector assigned', 'On the way', 'Arrived'];
const COLLECTABLE = ['Collector assigned', 'On the way', 'Arrived'];

async function post(path, body) {
  return api(path, { method: 'POST', body });
}

// ======================================================================= Pickup details
export async function pickupDetail(main, ctx) {
  const { state, params, query } = ctx;
  const role = state.user.role;
  const d = await api(`/bookings/${params[0]}`);
  const b = d.booking;
  const collected = ['Collected', 'Received by recycler'].includes(b.status);
  const points = (d.wallet || []).reduce((acc, t) => {
    acc[t.status] = (acc[t.status] || 0) + t.points;
    return acc;
  }, {});
  const back = role === 'collector' ? '#/collector' : role === 'admin' ? '#/admin/bookings' : '#/pickups';

  main.innerHTML = html`
    <p class="no-print"><a href="${back}">← Back</a></p>
    <div class="page-head">
      <div><p class="pickup__code">${b.booking_code}</p><h1>${fmtDate(b.requested_date)} · ${fmtWindow(b.time_window)}</h1><p>${b.area_name}${b.collector_name ? ` · Collector: ${b.collector_name}` : ''}${b.route_order ? ` · Stop #${b.route_order}` : ''}</p></div>
      ${badge(b.status)}
    </div>
    <div class="card"><h2 class="visually-hidden">Progress</h2>${timeline(b, d.history)}</div>
    <div class="grid grid--side section">
      <div class="stack">
        <section class="card">
          <h2>Pickup address</h2>
          <p>${b.address_text}</p>
          ${b.access_instructions ? html`<p class="muted"><strong>Access:</strong> ${b.access_instructions}</p>` : ''}
          <dl class="kv"><dt>Contact</dt><dd>${b.contact_name} · ${role === 'customer' ? fmtPhone(b.contact_phone) : html`<a href="tel:+91${b.contact_phone}">${fmtPhone(b.contact_phone)}</a>`}</dd>
          ${role === 'admin' ? html`<dt>Account</dt><dd>${b.customer_name} (${b.customer_email})</dd>` : ''}
          <dt>Fee</dt><dd>${fmtINR(b.fee_rupees)}</dd></dl>
        </section>
        <section class="card">
          <h2>Items ${collected ? 'booked (estimated)' : '(estimated)'}</h2>
          ${itemsList(d.items)}
          ${b.customer_notes ? html`<p class="callout section"><strong>Customer notes:</strong> ${b.customer_notes}</p>` : ''}
          ${OPEN.includes(b.status) && role !== 'customer' && d.items.some((i) => i.handling_notes)
            ? html`<ul class="muted">${d.items.filter((i) => i.handling_notes).map((i) => html`<li><strong>${i.name}:</strong> ${i.handling_notes}</li>`)}</ul>` : ''}
        </section>
        ${d.collected.length ? html`<section class="card">
          <div class="card__head"><h2>Collected items</h2>${role !== 'collector' ? html`<a class="btn btn--sm btn--secondary" href="#/receipt/${b.booking_code}">Collection receipt</a>` : ''}</div>
          ${itemsList(d.collected, 'quantity')}
          <p class="muted"><small>Recorded ${fmtDateTime(b.collected_at)}${d.collected_by_name ? ` by ${d.collected_by_name}` : ''}</small></p>
        </section>` : ''}
        ${b.exception_note ? html`<p class="callout callout--warn"><strong>Exception note:</strong> ${b.exception_note}</p>` : ''}
        ${d.wallet && d.wallet.length ? html`<section class="card">
          <h2>Eco Points for this pickup</h2>
          <dl class="kv">
            ${points.Approved || points.Redeemed ? html`<dt>Earned</dt><dd><strong>${fmtNum((points.Approved || 0) + (points.Redeemed || 0))} pts</strong></dd>` : ''}
            ${points.Pending ? html`<dt>Pending verification</dt><dd>${fmtNum(points.Pending)} pts</dd>` : ''}
            ${points.Rejected ? html`<dt>Not eligible</dt><dd>${fmtNum(points.Rejected)} pts</dd>` : ''}
          </dl>
          ${role === 'customer' ? html`<p><a href="#/wallet">Open Eco Wallet</a></p>` : html`<p><a href="#/admin/wallet">Review in Eco Wallet</a></p>`}
        </section>` : ''}
        ${d.handoff ? html`<section class="card"><h2>Received by recycler</h2><dl class="kv">
          <dt>Recycler</dt><dd>${d.handoff.recycler_name}${d.handoff.certification_claim ? html`<br><small>${d.handoff.certification_claim}</small>` : ''}</dd>
          <dt>Date</dt><dd>${fmtDate(d.handoff.handoff_date)}</dd><dt>Reference</dt><dd>${d.handoff.reference}${d.handoff.receipt_ref ? ` · ${d.handoff.receipt_ref}` : ''}</dd></dl></section>` : ''}
      </div>
      <aside class="stack" id="actions"></aside>
    </div>
    <section class="card section">
      <h2>Status history</h2>
      <ul class="txns">${d.history.map((h) => html`<li class="txn"><span class="txn__title">${h.status}</span><span class="txn__status"><small>${fmtDateTime(h.at)}</small></span>
        <span class="txn__meta">${h.by_name || 'System'}${h.note ? ` — ${h.note}` : ''}</span></li>`)}</ul>
    </section>`;

  const aside = main.querySelector('#actions');
  if (role === 'customer') customerActions(aside, b, ctx);
  if (role === 'collector') collectorPanel(aside, b, d, ctx, query.get('collect') === '1');
  if (role === 'admin') await adminActions(aside, b, d, ctx);
  if (query.get('collect') === '1') main.querySelector('#collect-form')?.scrollIntoView({ block: 'start' });
}

function customerActions(aside, b, ctx) {
  if (b.can_modify) {
    aside.innerHTML = html`<section class="card"><h2>Need to change plans?</h2>
      <p class="muted">You can reschedule or cancel until ${fmtDateTime(b.cancellation_cutoff)}.</p>
      <div class="actions"><button class="btn btn--block" data-act="reschedule">Reschedule</button><button class="btn btn--danger btn--block" data-act="cancel">Cancel pickup</button></div>
      <div id="act-panel"></div></section>
      <p class="callout callout--warn">${DATA_WIPE_TEXT}</p>`;
    wireChangeButtons(aside, b, ctx);
  } else if (OPEN.includes(b.status)) {
    aside.innerHTML = html`<section class="card"><h2>Changes closed</h2><p>Online changes closed at ${fmtDateTime(b.cancellation_cutoff)}. To change this pickup, please contact support${supportText(ctx.state.config) ? `: ${supportText(ctx.state.config)}` : ''}.</p></section>
      <p class="callout callout--warn">${DATA_WIPE_TEXT}</p>`;
  }
}

function wireChangeButtons(aside, b, ctx) {
  const panel = aside.querySelector('#act-panel');
  aside.querySelector('[data-act=cancel]').addEventListener('click', () => {
    panel.innerHTML = html`<form class="form-grid section" id="cancel-form">
      <div class="field"><label for="reason">Reason <span class="optional">(optional)</span></label><input id="reason" name="reason" maxlength="300"></div>
      <button class="btn btn--danger" type="submit">Yes, cancel this pickup</button></form>`;
    onSubmit(panel.querySelector('#cancel-form'), async (v) => {
      await post(`/bookings/${b.booking_code}/cancel`, v);
      toast('Pickup cancelled.');
      ctx.refresh();
    });
  });
  aside.querySelector('[data-act=reschedule]').addEventListener('click', async () => {
    panel.innerHTML = '<p class="muted section">Loading slots…</p>';
    const res = await api(`/bookings/${b.booking_code}/slots`);
    if (!res.slots.length) {
      panel.innerHTML = String(html`<p class="callout section">No other slots are open in ${res.area} right now.</p>`);
      return;
    }
    const byDate = {};
    for (const s of res.slots) (byDate[s.date] ||= []).push(s);
    panel.innerHTML = html`<form class="form-grid section" id="resched-form">
      <div class="field"><label for="slot">New date and time</label><select id="slot" name="slot_id" required>
        ${Object.entries(byDate).map(([date, slots]) => html`<optgroup label="${fmtDay(date)}">${slots.map((s) => html`<option value="${s.id}">${fmtDay(date)}, ${fmtWindow(`${s.start_time}-${s.end_time}`)} (${s.remaining} left)</option>`)}</optgroup>`)}
      </select></div>
      ${ctx.state.user.role === 'customer' ? html`<p class="muted"><small>${b.collector_id ? 'Your collector will be reassigned for the new date. ' : ''}Slots starting within ${ctx.state.config.cancellation_cutoff_hours} hours cannot be changed again online.</small></p>` : ''}
      <button class="btn" type="submit">Confirm new slot</button></form>`;
    onSubmit(panel.querySelector('#resched-form'), async (v) => {
      await post(`/bookings/${b.booking_code}/reschedule`, { slot_id: Number(v.slot_id) });
      toast('Pickup rescheduled.');
      ctx.refresh();
    });
  });
}

// ----------------------------------------------------------------------- collector actions
function statusButtons(b) {
  const can = (s) => ({ 'On the way': ['Collector assigned'], Arrived: ['Collector assigned', 'On the way'] })[s].includes(b.status);
  return html`<div class="job__actions">
    ${can('On the way') ? html`<button class="btn btn--secondary" data-status="On the way">On the way</button>` : ''}
    ${can('Arrived') ? html`<button class="btn btn--secondary" data-status="Arrived">Arrived</button>` : ''}
    <a class="btn" href="#/pickups/${b.booking_code}?collect=1">Collected</a>
    <button class="btn btn--danger" data-unable>Unable to collect</button>
  </div>
  <form class="form-grid section" data-unable-form hidden>
    <div class="field"><label>What happened? <textarea name="note" rows="2" required maxlength="500" placeholder="E.g. customer not reachable, gate locked, item too heavy"></textarea></label></div>
    <button class="btn btn--danger" type="submit">Mark unable to collect</button>
  </form>`;
}

function wireStatusButtons(root, b, ctx) {
  root.querySelectorAll('[data-status]').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await post(`/bookings/${b.booking_code}/status`, { status: btn.dataset.status });
      toast(`Marked “${btn.dataset.status}”.`);
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'bad');
      btn.disabled = false;
    }
  }));
  const form = root.querySelector('[data-unable-form]');
  root.querySelector('[data-unable]')?.addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) form.note.focus();
  });
  if (form) onSubmit(form, async (v) => {
    await post(`/bookings/${b.booking_code}/status`, { status: 'Unable to collect', note: v.note });
    toast('Marked unable to collect.');
    ctx.refresh();
  });
}

function collectForm(b, d, categories) {
  const rows = d.items.map((i) => ({ category_id: i.category_id, quantity: i.est_qty, weight_kg: '' }));
  const options = (sel) => categories.map((c) => html`<option value="${c.id}" ${c.id === sel ? raw('selected') : ''}>${c.name}${c.accepted ? '' : ' (not normally accepted)'}</option>`);
  const row = (r) => html`<div class="collect-row">
    <div class="field"><label>Category<select name="category_id">${options(r.category_id)}</select></label></div>
    <div class="field"><label>Count<input type="number" name="quantity" min="0" max="999" step="1" inputmode="numeric" value="${r.quantity}"></label></div>
    <div class="field"><label>Weight (kg) <span class="optional">(optional)</span><input type="number" name="weight_kg" min="0" step="0.1" inputmode="decimal" value="${r.weight_kg}"></label></div>
    <button type="button" class="btn btn--ghost btn--sm" data-remove aria-label="Remove this row">Remove</button>
  </div>`;
  return {
    markup: html`<form class="card" id="collect-form">
      <h2>Record collection</h2>
      <p class="muted">Enter what you actually collected. Prefilled with the customer's estimate — correct it to match. Weigh items sold by weight if you can.</p>
      <div id="rows">${rows.map(row)}</div>
      <button type="button" class="btn btn--ghost btn--sm" id="add-row">+ Add another category</button>
      <div class="field section"><label for="exception_note">Exception note <span class="optional">(optional)</span></label>
        <textarea id="exception_note" name="exception_note" rows="2" maxlength="500" placeholder="E.g. one laptop missing its battery; customer kept the hard disk"></textarea></div>
      <div class="actions"><button class="btn btn--lg btn--block" type="submit">Confirm collected</button></div>
    </form>`,
    wire(root, onDone) {
      const form = root.querySelector('#collect-form');
      const host = form.querySelector('#rows');
      host.addEventListener('click', (e) => {
        if (e.target.matches('[data-remove]')) e.target.closest('.collect-row').remove();
      });
      form.querySelector('#add-row').addEventListener('click', () => {
        host.insertAdjacentHTML('beforeend', String(row({ category_id: categories[0].id, quantity: 1, weight_kg: '' })));
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const items = [...host.querySelectorAll('.collect-row')].map((r) => ({
          category_id: Number(r.querySelector('[name=category_id]').value),
          quantity: Number(r.querySelector('[name=quantity]').value || 0),
          weight_kg: r.querySelector('[name=weight_kg]').value === '' ? null : Number(r.querySelector('[name=weight_kg]').value),
        }));
        const btn = form.querySelector('[type=submit]');
        btn.disabled = true;
        try {
          if (!items.length) throw new Error('Add at least one collected item.');
          await post(`/bookings/${b.booking_code}/collect`, { items, exception_note: form.exception_note.value });
          toast('Collection recorded.');
          onDone();
        } catch (err) {
          toast(err.message, 'bad');
          btn.disabled = false;
        }
      });
    },
  };
}

function collectorPanel(aside, b, d, ctx, showCollect) {
  if (!COLLECTABLE.includes(b.status)) {
    aside.innerHTML = String(html`<section class="card"><h2>${b.status}</h2><p class="muted">No actions needed.</p></section>`);
    return;
  }
  const cf = collectForm(b, d, ctx.state.config.categories);
  aside.innerHTML = html`<section class="card"><h2>Update status</h2>${statusButtons(b)}</section>${showCollect ? cf.markup : html`<a class="btn btn--block" href="#/pickups/${b.booking_code}?collect=1">Record collection</a>`}`;
  wireStatusButtons(aside, b, ctx);
  if (showCollect) cf.wire(aside, () => (location.hash = `#/pickups/${b.booking_code}`));
}

// ----------------------------------------------------------------------- admin actions
async function adminActions(aside, b, d, ctx) {
  const allCollectors = await api('/admin/users?role=collector');
  const collectors = allCollectors.filter((c) => collectorServesBooking(c, b));
  const parts = [];
  if (b.can_modify) {
    const noCollectorMsg = `No active collector serves ${b.area_name || 'this area'}`;
    parts.push(html`<form class="card form-grid" id="assign-form">
      <h2>${b.collector_id ? 'Change collector' : 'Assign collector'}</h2>
      <div class="field"><label for="collector_id">Collector</label>
        <select id="collector_id" name="collector_id" required ${collectors.length ? '' : raw('disabled')}>
          <option value="">${collectors.length ? (b.collector_id ? 'Change collector…' : 'Choose active collector…') : noCollectorMsg}</option>
          ${b.collector_id && !collectors.some((c) => c.id === b.collector_id) && b.collector_name
            ? html`<option value="${b.collector_id}" selected>${b.collector_name} (Current assignment)</option>`
            : ''}
          ${collectors.map((c) => html`<option value="${c.id}" ${c.id === b.collector_id ? raw('selected') : ''}>${c.name} (${c.open_assignments} open)</option>`)}
        </select>
        ${collectors.length ? '' : html`<span class="field__help">${noCollectorMsg}. Assign collectors to this area in <a href="#/admin/collectors">Admin → Collectors</a>.</span>`}
      </div>
      <div class="field"><label for="route_order">Route order <span class="optional">(optional)</span></label><input id="route_order" name="route_order" type="number" min="1" max="99" value="${b.route_order ?? ''}" placeholder="e.g. 1" ${collectors.length ? '' : raw('disabled')}></div>
      <button class="btn" type="submit" ${collectors.length ? '' : raw('disabled')}>${b.collector_id ? 'Update assignment' : 'Assign'}</button>
    </form>
    <section class="card"><h2>Reschedule or cancel</h2>
      <div class="actions"><button class="btn btn--secondary btn--block" data-act="reschedule">Reschedule</button><button class="btn btn--danger btn--block" data-act="cancel">Cancel booking</button></div>
      <div id="act-panel"></div></section>`);
  }
  const canCollect = [...COLLECTABLE, 'Booked', 'Unable to collect'].includes(b.status);
  if (COLLECTABLE.includes(b.status)) parts.push(html`<section class="card"><h2>Status</h2>${statusButtons(b)}</section>`);
  const cf = canCollect ? collectForm(b, d, ctx.state.config.categories) : null;
  if (cf) parts.push(html`<details class="panel" ${ctx.query.get('collect') === '1' ? raw('open') : ''}><summary>Record collection on the collector's behalf</summary><div>${cf.markup}</div></details>`);
  if (b.status === 'Collected') parts.push(html`<section class="card"><h2>Next step</h2><p>Record the recycler handoff when these items leave the warehouse.</p><a class="btn btn--block" href="#/admin/handoffs">Record handoff</a></section>`);
  aside.innerHTML = html`${parts}`;

  const assign = aside.querySelector('#assign-form');
  if (assign) onSubmit(assign, async (v) => {
    if (!v.collector_id) throw new Error('Please choose an active collector.');
    await post(`/bookings/${b.booking_code}/assign`, { collector_id: Number(v.collector_id), route_order: v.route_order });
    toast(b.collector_id ? 'Collector assignment updated.' : 'Collector assigned.');
    ctx.refresh();
  });
  if (b.can_modify) wireChangeButtons(aside, b, ctx);
  if (COLLECTABLE.includes(b.status)) wireStatusButtons(aside, b, ctx);
  if (cf) cf.wire(aside, () => ctx.refresh());
}

// ======================================================================= Collector dashboard
function jobCard(b) {
  return html`<article class="card job">
    <div class="spread">
      <div class="row">${b.route_order ? html`<span class="job__route" title="Route order">${b.route_order}</span>` : ''}<div><strong>${fmtWindow(b.time_window)}</strong><br><small class="muted">${fmtDay(b.requested_date)} · ${b.area_name}</small></div></div>
      ${badge(b.status)}
    </div>
    <p class="job__addr"><strong>${b.contact_name}</strong> · <a href="tel:+91${b.contact_phone}">${fmtPhone(b.contact_phone)}</a><br>${b.address_text}</p>
    ${b.access_instructions ? html`<p class="muted"><small><strong>Access:</strong> ${b.access_instructions}</small></p>` : ''}
    <p><strong>Items:</strong> ${b.items_summary}</p>
    ${b.customer_notes ? html`<p class="muted"><small><strong>Notes:</strong> ${b.customer_notes}</small></p>` : ''}
    ${COLLECTABLE.includes(b.status) ? html`<div data-job="${b.booking_code}">${statusButtons(b)}</div>` : ''}
    <p><a href="#/pickups/${b.booking_code}">Full details</a></p>
  </article>`;
}

export async function collectorHome(main, ctx) {
  const list = await api('/bookings');
  const today = todayIST();
  const tab = ctx.query.get('tab') || 'today';
  const open = list.filter((b) => OPEN.includes(b.status));
  const groups = {
    today: open.filter((b) => b.requested_date === today),
    upcoming: open.filter((b) => b.requested_date > today),
    overdue: open.filter((b) => b.requested_date < today),
    done: list.filter((b) => !OPEN.includes(b.status)).sort((a, c) => (a.requested_date < c.requested_date ? 1 : -1)).slice(0, 30),
  };
  const labels = { today: 'Today', upcoming: 'Upcoming', overdue: 'Overdue', done: 'Done' };
  main.className = 'narrow';
  main.innerHTML = html`
    <div class="page-head"><div><h1>My pickups</h1><p>${fmtDate(today)} · sorted by date, time and route order</p></div></div>
    <div class="tabs">${Object.keys(labels).filter((k) => k !== 'overdue' || groups.overdue.length).map((k) => html`<a class="btn btn--sm ${k === tab ? '' : 'btn--ghost'}" href="#/collector?tab=${k}">${labels[k]} (${groups[k].length})</a>`)}</div>
    <div class="stack">${(groups[tab] || []).length ? groups[tab].map(jobCard) : empty(tab === 'today' ? 'No pickups assigned for today.' : 'Nothing here.')}</div>`;
  main.querySelectorAll('[data-job]').forEach((el) => {
    const b = list.find((x) => x.booking_code === el.dataset.job);
    wireStatusButtons(el, b, ctx);
  });
}
