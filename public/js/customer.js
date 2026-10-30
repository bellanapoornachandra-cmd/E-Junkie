import {
  html, raw, api, toast, empty, onSubmit, formFields, readForm, badge, itemsList,
  fmtDate, fmtDay, fmtDateTime, fmtWindow, fmtINR, fmtNum, fmtPhone, supportText,
} from './ui.js';

const UPCOMING = ['Booked', 'Collector assigned', 'On the way', 'Arrived'];

export const DATA_WIPE_TEXT =
  'Back up your photos, contacts and files, sign out of all accounts, remove SIM and memory cards, and factory-reset phones, tablets and computers before the pickup. E-Junkie cannot recover or protect data left on devices.';

// ======================================================================= Home
export async function home(main, { state, query }) {
  const cfg = state.config;
  const accepted = cfg.categories.filter((c) => c.accepted);
  const notAccepted = cfg.categories.filter((c) => !c.accepted);
  const areas = cfg.areas.filter((a) => a.active);
  main.innerHTML = html`
    <section class="hero">
      <div>
        <h1>Old electronics? We collect them <span class="hero__accent">from your doorstep.</span></h1>
        <p>Book a free pickup for phones, laptops, TVs, appliances, batteries and cables in Visakhapatnam. We record what we collect and every handoff to our recycling partner.</p>
      </div>
      <div class="card">
        <h2>Check pickup availability</h2>
        <form id="pin-form" class="pin-form" novalidate>
          <label class="visually-hidden" for="pin">Pickup PIN code</label>
          <input id="pin" name="pin" type="text" inputmode="numeric" maxlength="6" placeholder="6-digit PIN code" autocomplete="postal-code" value="${query.get('pin') || ''}">
          <button class="btn btn--secondary" type="submit">Check</button>
        </form>
        <p class="pin-result" id="pin-result" aria-live="polite"></p>
        <a class="btn btn--lg btn--block" id="book-cta" href="#/book">Book a pickup</a>
        <p class="muted">Pickup fee: <strong>${fmtINR(cfg.fee.rupees)}</strong>${cfg.fee.note ? ` · ${cfg.fee.note}` : ''}</p>
      </div>
    </section>

    <section class="section">
      <h2>How it works</h2>
      <ol class="steps">
        <li><strong>Book in two minutes.</strong><br>Choose your items, address and a time slot.</li>
        <li><strong>We come to you.</strong><br>A collector picks up at your door and records what was collected.</li>
        <li><strong>Get a receipt.</strong><br>See your collection receipt and Eco Points once the items are verified.</li>
      </ol>
    </section>

    <section class="section">
      <div class="callout callout--warn">
        <p><strong>Before your pickup: protect your data.</strong> ${DATA_WIPE_TEXT}</p>
      </div>
    </section>

    <section class="section">
      <h2>What we accept</h2>
      <div class="cat-grid">
        ${accepted.map((c) => html`<div class="cat"><h3>${c.name}</h3><p>${c.description}</p>${c.handling_notes ? html`<p class="muted"><small>${c.handling_notes}</small></p>` : ''}</div>`)}
      </div>
      ${notAccepted.length ? html`<h3 class="section">Not accepted right now</h3><div class="cat-grid">${notAccepted.map((c) => html`<div class="cat cat--no"><h3>${c.name}</h3><p>${c.handling_notes || c.description}</p></div>`)}</div>` : ''}
    </section>

    <section class="section grid grid--2">
      <div class="card">
        <h2>Where we collect</h2>
        <p>${areas.map((a) => (a.name === a.city ? a.name : `${a.name}, ${a.city}`)).join(' · ')}</p>
        <p class="muted">More areas are being added. Check your PIN code above.</p>
      </div>
      <div class="card">
        <h2>Where your e-waste goes</h2>
        ${cfg.certified_recyclers.length
          ? cfg.certified_recyclers.map((r) => html`<p><strong>${r.name}</strong> — ${r.certification_claim}</p>`)
          : html`<p>Collected items are handed to our recycling partner. We record each handoff with a date and reference number, and you can see it in your pickup details.</p>`}
      </div>
    </section>`;

  const form = main.querySelector('#pin-form');
  const out = main.querySelector('#pin-result');
  const cta = main.querySelector('#book-cta');
  async function check() {
    const pin = form.pin.value.trim();
    out.className = 'pin-result';
    if (!/^\d{6}$/.test(pin)) {
      out.textContent = 'Please enter a 6-digit PIN code.';
      out.classList.add('pin-result--no');
      return;
    }
    const r = await api(`/public/pincode/${pin}`);
    out.textContent = r.serviceable ? `Yes, we pick up in ${r.area}.` : r.message;
    out.classList.add(r.serviceable ? 'pin-result--ok' : 'pin-result--no');
    cta.href = r.serviceable ? `#/book?pin=${pin}` : '#/book';
    sessionStorage.setItem('ej_pin', r.serviceable ? pin : '');
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    check().catch((err) => toast(err.message, 'bad'));
  });
  if (query.get('pin')) check().catch(() => {});
}

// ======================================================================= Booking flow
const STEPS = ['Items', 'Address', 'Slot', 'Review'];

function loadDraft() {
  try {
    return JSON.parse(sessionStorage.getItem('ej_draft')) || null;
  } catch {
    return null;
  }
}
const saveDraft = (d) => sessionStorage.setItem('ej_draft', JSON.stringify(d));

export async function book(main, ctx) {
  const { state, query } = ctx;
  main.className = 'narrow';
  if (!state.user) {
    sessionStorage.setItem('ej_after_login', location.hash);
    main.innerHTML = html`<div class="card"><h1>Book a pickup</h1>
      <p>Please log in or create a free account so you can track your pickup and receipt.</p>
      <div class="actions"><a class="btn btn--lg" href="#/signup">Create account</a><a class="btn btn--lg btn--secondary" href="#/login">Log in</a></div></div>`;
    return;
  }
  if (state.user.role !== 'customer') {
    main.innerHTML = html`<div class="callout">Bookings are made from customer accounts.</div>`;
    return;
  }
  const pin = query.get('pin') || sessionStorage.getItem('ej_pin') || '';
  let draft = loadDraft() || {
    step: 0, items: {}, notes: '', address_id: null, new_address: { pincode: pin }, contact_name: state.user.name, contact_phone: state.user.phone || '', slot: null,
  };
  if (pin && !draft.address_id && !draft.new_address.pincode) draft.new_address.pincode = pin;
  const addresses = await api('/addresses');
  if (draft.address_id && !addresses.some((a) => a.id === draft.address_id)) draft.address_id = null;
  if (draft.address_id == null && addresses.length && !draft.new_address.address_line) {
    // Prefer a saved address in the PIN code the customer just checked; fall back to their first one.
    const match = pin ? addresses.find((a) => a.pincode === pin) : addresses[0];
    if (match) draft.address_id = match.id;
  }

  const cats = state.config.categories.filter((c) => c.accepted);
  const go = (step) => {
    draft.step = step;
    saveDraft(draft);
    renderStep();
  };
  const addressPin = () => (draft.address_id ? addresses.find((a) => a.id === draft.address_id).pincode : draft.new_address.pincode);

  function shell(body) {
    main.innerHTML = html`
      <div class="page-head"><div><h1>Book a pickup</h1><p>Step ${draft.step + 1} of ${STEPS.length}: ${STEPS[draft.step]}</p></div></div>
      <ol class="stepper" aria-hidden="true">${STEPS.map((s, i) => html`<li class="${i < draft.step ? 'is-done' : i === draft.step ? 'is-current' : ''}">${s}</li>`)}</ol>
      ${body}`;
    main.querySelector('[data-back]')?.addEventListener('click', () => go(draft.step - 1));
  }

  function renderStep() {
    [stepItems, stepAddress, stepSlot, stepReview][draft.step]();
  }

  // ---- Step 1
  function stepItems() {
    shell(html`<form id="f" class="stack">
      <fieldset class="card">
        <legend class="label">What should we collect? <span class="optional">Choose one or more</span></legend>
        <div class="pick-list">
          ${cats.map((c) => {
            const qty = draft.items[c.id] || 0;
            return html`<div class="pick" data-cat="${c.id}">
              <input type="checkbox" id="cat-${c.id}" ${qty ? raw('checked') : ''} aria-describedby="cat-${c.id}-d">
              <label class="pick__body" for="cat-${c.id}"><span class="pick__title">${c.name}</span><span class="pick__sub" id="cat-${c.id}-d">${c.description}</span></label>
              <div class="qty" ${qty ? '' : raw('hidden')} role="group" aria-label="Estimated quantity of ${c.name}">
                <button type="button" data-d="-1" aria-label="Fewer">−</button><output>${qty || 1}</output><button type="button" data-d="1" aria-label="More">+</button>
              </div>
            </div>`;
          })}
        </div>
      </fieldset>
      <div class="card field">
        <label for="notes">Notes for the collector <span class="optional">(optional)</span></label>
        <textarea id="notes" name="notes" rows="3" maxlength="500" placeholder="E.g. the TV is on the second floor; please call before arriving.">${draft.notes}</textarea>
        <span class="field__help">Quantities are estimates — the collector records the actual items at pickup.</span>
      </div>
      <div class="sticky-actions"><button class="btn btn--lg" type="submit">Continue</button></div>
    </form>`);
    main.querySelectorAll('.pick').forEach((row) => {
      const id = Number(row.dataset.cat);
      const box = row.querySelector('input');
      const qty = row.querySelector('.qty');
      const out = row.querySelector('output');
      box.addEventListener('change', () => {
        qty.hidden = !box.checked;
        if (box.checked) draft.items[id] = Number(out.value || out.textContent) || 1;
        else delete draft.items[id];
      });
      qty.addEventListener('click', (e) => {
        const d = Number(e.target.dataset.d || 0);
        if (!d) return;
        const n = Math.min(99, Math.max(1, (draft.items[id] || 1) + d));
        draft.items[id] = n;
        out.textContent = n;
      });
      row.addEventListener('click', (e) => {
        if (e.target === row) box.click();
      });
    });
    main.querySelector('#f').addEventListener('submit', (e) => {
      e.preventDefault();
      draft.notes = main.querySelector('#notes').value;
      if (!Object.keys(draft.items).length) return toast('Please choose at least one item category.', 'bad');
      go(1);
    });
  }

  // ---- Step 2
  function stepAddress() {
    const a = draft.new_address;
    const useNew = draft.address_id == null;
    shell(html`<form id="f" class="stack" novalidate>
      <fieldset class="card">
        <legend class="label">Pickup address</legend>
        <div class="pick-list">
          ${addresses.map((ad) => html`<label class="pick"><input type="radio" name="addr" value="${ad.id}" ${draft.address_id === ad.id ? raw('checked') : ''}>
            <span class="pick__body"><span class="pick__title">${ad.label || 'Saved address'}</span><span class="pick__sub">${[ad.unit, ad.address_line, ad.area, ad.pincode].filter(Boolean).join(', ')}</span></span></label>`)}
          <label class="pick"><input type="radio" name="addr" value="new" ${useNew ? raw('checked') : ''}><span class="pick__body"><span class="pick__title">Use a new address</span><span class="pick__sub">It will be saved to your account</span></span></label>
        </div>
        <div id="new-addr" class="form-grid form-grid--2 section" ${useNew ? '' : raw('hidden')}>
          ${formFields([
            { name: 'pincode', label: 'PIN code', required: true, inputmode: 'numeric', autocomplete: 'postal-code', help: html`<span id="pin-area"></span>` },
            { name: 'label', label: 'Label', help: 'E.g. Home, Office' },
            { name: 'unit', label: 'Flat / house number', autocomplete: 'address-line2' },
            { name: 'address_line', label: 'Street, colony and landmark', required: true, autocomplete: 'address-line1', wide: true },
            { name: 'access_instructions', label: 'Access instructions', type: 'textarea', rows: 2, wide: true, help: 'Gate code, floor, lift, who to ask for' },
          ], a)}
        </div>
      </fieldset>
      <fieldset class="card form-grid form-grid--2">
        <legend class="label">Contact on the day</legend>
        ${formFields([
          { name: 'contact_name', label: 'Name', required: true, autocomplete: 'name' },
          { name: 'contact_phone', label: 'Mobile number', type: 'tel', required: true, inputmode: 'tel', autocomplete: 'tel-national' },
        ], { contact_name: draft.contact_name, contact_phone: draft.contact_phone })}
      </fieldset>
      <div class="sticky-actions"><button class="btn btn--lg btn--secondary" type="button" data-back>Back</button><button class="btn btn--lg" type="submit">Continue</button></div>
    </form>`);
    const form = main.querySelector('#f');
    const newBox = main.querySelector('#new-addr');
    const pinArea = main.querySelector('#pin-area');
    form.querySelectorAll('[name=addr]').forEach((r) => r.addEventListener('change', () => (newBox.hidden = r.value !== 'new' || !r.checked)));
    async function checkPin() {
      const p = form.pincode.value.trim();
      if (!/^\d{6}$/.test(p)) return false;
      const r = await api(`/public/pincode/${p}`);
      pinArea.textContent = r.serviceable ? `✓ ${r.area}, ${r.city}` : r.message;
      return r.serviceable;
    }
    form.pincode.addEventListener('change', () => checkPin().catch(() => {}));
    if (form.pincode.value) checkPin().catch(() => {});
    onSubmit(form, async (v) => {
      draft.contact_name = v.contact_name;
      draft.contact_phone = v.contact_phone;
      if (!v.contact_name.trim() || !/^(\+?91[\s-]?)?[6-9]\d{4}\s?\d{5}$/.test(v.contact_phone.trim())) throw new Error('Please enter a contact name and a valid 10-digit mobile number.');
      if (v.addr === 'new') {
        draft.address_id = null;
        draft.new_address = { pincode: v.pincode, label: v.label, unit: v.unit, address_line: v.address_line, access_instructions: v.access_instructions };
        if (!v.address_line.trim()) throw new Error('Please enter the street and colony.');
        if (!(await checkPin())) throw new Error('We do not collect in that PIN code yet.');
      } else {
        draft.address_id = Number(v.addr);
      }
      if (draft.slot && draft.slot.pin !== addressPin()) draft.slot = null;
      go(2);
    });
  }

  // ---- Step 3
  async function stepSlot() {
    shell(html`<div class="card" id="slots">Loading slots…</div>
      <div class="sticky-actions"><button class="btn btn--lg btn--secondary" type="button" data-back>Back</button><button class="btn btn--lg" type="button" id="next" disabled>Continue</button></div>`);
    const p = addressPin();
    const box = main.querySelector('#slots');
    let res;
    try {
      res = await api(`/slots?pin=${p}`);
    } catch (err) {
      box.innerHTML = html`<p class="callout callout--bad">${err.message}</p>`;
      return;
    }
    const byDate = {};
    for (const s of res.slots) (byDate[s.date] ||= []).push(s);
    const dates = Object.keys(byDate);
    if (!dates.length) {
      box.innerHTML = String(empty(`No pickup slots are open in ${res.area} right now. Please check again tomorrow or contact support.`));
      return;
    }
    let date = draft.slot && byDate[draft.slot.date] ? draft.slot.date : dates[0];
    const next = main.querySelector('#next');
    function draw() {
      box.innerHTML = html`<h2>Choose a date and time</h2><p class="muted">Service area: ${res.area}</p>
        <div class="date-chips" role="group" aria-label="Dates">${dates.map((d) => html`<button type="button" class="chip" data-date="${d}" aria-pressed="${d === date}">${fmtDay(d)}</button>`)}</div>
        <fieldset><legend class="visually-hidden">Time slots on ${fmtDate(date)}</legend><div class="slot-grid">
        ${byDate[date].map((s) => html`<label class="pick"><input type="radio" name="slot" value="${s.id}" ${draft.slot && draft.slot.id === s.id ? raw('checked') : ''}>
          <span class="pick__body"><span class="pick__title">${fmtWindow(`${s.start_time}-${s.end_time}`)}</span><span class="pick__sub">${s.remaining} ${s.remaining === 1 ? 'spot' : 'spots'} left</span></span></label>`)}
        </div></fieldset>`;
      box.querySelectorAll('[data-date]').forEach((b) => b.addEventListener('click', () => {
        date = b.dataset.date;
        draw();
      }));
      box.querySelectorAll('[name=slot]').forEach((r) => r.addEventListener('change', () => {
        const s = res.slots.find((x) => x.id === Number(r.value));
        draft.slot = { ...s, pin: p };
        saveDraft(draft);
        next.disabled = false;
      }));
      next.disabled = !(draft.slot && res.slots.some((x) => x.id === draft.slot.id));
    }
    draw();
    next.addEventListener('click', () => go(3));
  }

  // ---- Step 4
  function stepReview() {
    const cfg = state.config;
    const items = Object.entries(draft.items).map(([id, q]) => ({ ...cats.find((c) => c.id === Number(id)), est_qty: q })).filter((i) => i.name);
    const ad = draft.address_id ? addresses.find((a) => a.id === draft.address_id) : draft.new_address;
    const start = new Date(`${draft.slot.date}T${draft.slot.start_time}:00+05:30`);
    const cutoff = new Date(start.getTime() - cfg.cancellation_cutoff_hours * 3600e3);
    const notes = items.filter((i) => i.handling_notes);
    shell(html`<form id="f" class="stack">
      <div class="card">
        <h2>Check your booking</h2>
        <dl class="review">
          <dt>Items (estimated)</dt><dd>${itemsList(items)}</dd>
          ${draft.notes ? html`<dt>Notes</dt><dd>${draft.notes}</dd>` : ''}
          <dt>Pickup address</dt><dd>${[ad.unit, ad.address_line, ad.area, ad.pincode].filter(Boolean).join(', ')}${ad.access_instructions ? html`<br><small>${ad.access_instructions}</small>` : ''}</dd>
          <dt>Date and time</dt><dd>${fmtDate(draft.slot.date)}, ${fmtWindow(`${draft.slot.start_time}-${draft.slot.end_time}`)}</dd>
          <dt>Contact</dt><dd>${draft.contact_name}, ${fmtPhone(draft.contact_phone.replace(/\D/g, '').slice(-10))}</dd>
        </dl>
        <div class="fee-line"><span>Pickup fee</span><strong>${fmtINR(cfg.fee.rupees)}</strong></div>
        ${cfg.fee.note ? html`<p class="muted">${cfg.fee.note}</p>` : ''}
        <p class="muted">${cutoff > new Date()
          ? `You can reschedule or cancel online until ${fmtDateTime(cutoff.toISOString())}.`
          : 'This slot is inside the change window, so it cannot be rescheduled or cancelled online. Contact support if plans change.'}</p>
        <div class="actions"><button type="button" class="link-btn" data-edit="0">Edit items</button><button type="button" class="link-btn" data-edit="1">Edit address</button><button type="button" class="link-btn" data-edit="2">Change slot</button></div>
      </div>
      ${notes.length ? html`<div class="callout"><strong>Handling tips</strong><ul>${notes.map((n) => html`<li><strong>${n.name}:</strong> ${n.handling_notes}</li>`)}</ul></div>` : ''}
      <div class="callout callout--warn">
        <label class="check"><input type="checkbox" name="data_wipe_ack" required>
        <span><strong>I will back up and erase my personal data before the pickup.</strong> ${DATA_WIPE_TEXT}</span></label>
      </div>
      <div class="sticky-actions"><button class="btn btn--lg btn--secondary" type="button" data-back>Back</button><button class="btn btn--lg" type="submit">Confirm booking</button></div>
    </form>`);
    main.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.edit))));
    onSubmit(main.querySelector('#f'), async (v) => {
      if (!v.data_wipe_ack) throw new Error('Please confirm you will back up and erase your data.');
      const body = {
        items: items.map((i) => ({ category_id: i.id, est_qty: i.est_qty })),
        customer_notes: draft.notes, slot_id: draft.slot.id, contact_name: draft.contact_name, contact_phone: draft.contact_phone,
        data_wipe_ack: true, accepted_fee: cfg.fee.rupees,
        ...(draft.address_id ? { address_id: draft.address_id } : { address: draft.new_address }),
      };
      try {
        const r = await api('/bookings', { method: 'POST', body });
        sessionStorage.removeItem('ej_draft');
        success(r.booking_code);
      } catch (err) {
        if (err.status === 409 && /fee/.test(err.message)) state.config = await api('/public/config');
        if (err.status === 409 && /slot/i.test(err.message)) {
          draft.slot = null;
          toast(err.message, 'bad');
          return go(2);
        }
        throw err;
      }
    });
  }

  function success(code) {
    main.innerHTML = html`<div class="card">
      <p class="badge badge--good">Booking confirmed</p>
      <h1>Your pickup is booked</h1>
      <p>Booking ID</p>
      <p class="pickup__code"><strong>${code}</strong></p>
      <p>${fmtDate(draft.slot.date)}, ${fmtWindow(`${draft.slot.start_time}-${draft.slot.end_time}`)}. We will assign a collector before the day and you can follow progress in My pickups.</p>
      <p class="callout callout--warn">Reminder: back up and erase personal data from your devices before we arrive.</p>
      <div class="actions"><a class="btn btn--lg" href="#/pickups/${code}">View pickup</a><a class="btn btn--lg btn--secondary" href="#/pickups">My pickups</a></div>
    </div>`;
  }

  renderStep();
}

// ======================================================================= My pickups
export function walletMini(balance) {
  return html`<a class="wallet-mini" href="#/wallet">
    <div><span>Eco Wallet · available</span><br><strong>${fmtNum(balance.available)} pts</strong>
    ${balance.pending ? html`<br><span>${fmtNum(balance.pending)} pts pending verification</span>` : ''}</div>
    <span class="wallet-mini__go">Open wallet →</span></a>`;
}

function pickupCard(b) {
  return html`<a class="pickup" href="#/pickups/${b.booking_code}"><div class="card">
    <div class="pickup__top"><span class="pickup__code">${b.booking_code}</span>${badge(b.status)}</div>
    <p class="pickup__when">${fmtDate(b.requested_date)} · ${fmtWindow(b.time_window)}</p>
    <p class="pickup__items">${b.items_summary}</p>
    ${b.collector_name ? html`<p class="muted"><small>Collector: ${b.collector_name}</small></p>` : ''}
    ${b.can_modify ? html`<p class="muted"><small>Can be changed until ${fmtDateTime(b.cancellation_cutoff)}</small></p>` : ''}
  </div></a>`;
}

export async function pickups(main, { query }) {
  const [list, wallet] = await Promise.all([api('/bookings'), api('/wallet')]);
  const tab = query.get('tab') === 'past' ? 'past' : 'upcoming';
  const upcoming = list.filter((b) => UPCOMING.includes(b.status)).reverse();
  const past = list.filter((b) => !UPCOMING.includes(b.status));
  const shown = tab === 'past' ? past : upcoming;
  main.className = 'narrow';
  main.innerHTML = html`
    <div class="page-head"><div><h1>My pickups</h1></div><a class="btn" href="#/book">Book a pickup</a></div>
    ${walletMini(wallet.balance)}
    <div class="tabs section" role="tablist">
      <a class="btn btn--sm ${tab === 'upcoming' ? '' : 'btn--ghost'}" href="#/pickups" role="tab" aria-selected="${tab === 'upcoming'}">Upcoming (${upcoming.length})</a>
      <a class="btn btn--sm ${tab === 'past' ? '' : 'btn--ghost'}" href="#/pickups?tab=past" role="tab" aria-selected="${tab === 'past'}">Past (${past.length})</a>
    </div>
    <div class="stack">${shown.length ? shown.map(pickupCard) : empty(tab === 'past' ? 'No past pickups yet.' : (past.length ? html`No upcoming pickups. <a href="#/pickups?tab=past">View past or completed pickups (${past.length}) &rarr;</a>` : 'No upcoming pickups.'), html`<a class="btn" href="#/book">Book a pickup</a>`)}</div>`;
}

// ======================================================================= Receipt
export async function receipt(main, { params, state }) {
  const d = await api(`/bookings/${params[0]}`);
  const b = d.booking;
  main.className = 'narrow';
  if (!['Collected', 'Received by recycler'].includes(b.status)) {
    main.innerHTML = html`<div class="callout">A collection receipt is available once the items have been collected. <a href="#/pickups/${b.booking_code}">Back to pickup</a></div>`;
    return;
  }
  const w = d.wallet || [];
  const sum = (st) => w.filter((t) => st.includes(t.status)).reduce((a, t) => a + t.points, 0);
  main.innerHTML = html`<article class="card receipt">
    <div class="receipt__head">
      <div><h1>Collection receipt</h1><p class="pickup__code">${b.booking_code}</p></div>
      <div class="muted">E-Junkie<br>Visakhapatnam</div>
    </div>
    <dl class="kv">
      <dt>Customer</dt><dd>${b.contact_name}</dd>
      <dt>Address</dt><dd>${b.address_text}</dd>
      <dt>Collected on</dt><dd>${fmtDateTime(b.collected_at)}</dd>
      <dt>Collected by</dt><dd>${d.collected_by_name || 'E-Junkie collector'}</dd>
      <dt>Fee charged</dt><dd>${fmtINR(b.fee_rupees)}</dd>
    </dl>
    <h2 class="section">Items collected</h2>
    ${itemsList(d.collected, 'quantity')}
    ${b.exception_note ? html`<p class="callout callout--warn"><strong>Note:</strong> ${b.exception_note}</p>` : ''}
    <h2 class="section">Eco Points</h2>
    ${w.length
      ? html`<dl class="kv"><dt>Approved</dt><dd><strong>${fmtNum(sum(['Approved', 'Redeemed']))} pts</strong></dd><dt>Pending verification</dt><dd>${fmtNum(sum(['Pending']))} pts</dd></dl>`
      : html`<p class="muted">No Eco Points entries for this pickup.</p>`}
    ${d.handoff ? html`<h2 class="section">Recycler handoff</h2><dl class="kv"><dt>Recycler</dt><dd>${d.handoff.recycler_name}${d.handoff.certification_claim ? html` — ${d.handoff.certification_claim}` : ''}</dd><dt>Handed over</dt><dd>${fmtDate(d.handoff.handoff_date)}</dd><dt>Reference</dt><dd>${d.handoff.reference}${d.handoff.receipt_ref ? ` · ${d.handoff.receipt_ref}` : ''}</dd></dl>` : ''}
    <hr class="divider">
    <p class="muted"><small>This receipt confirms the items E-Junkie collected. Eco Points are added to your wallet only after our team verifies the items. ${supportText(state.config) ? `Questions: ${supportText(state.config)}` : ''}</small></p>
    <div class="actions no-print"><button class="btn" type="button" id="print">Print or save as PDF</button><a class="btn btn--secondary" href="#/pickups/${b.booking_code}">Back to pickup</a></div>
  </article>`;
  main.querySelector('#print').addEventListener('click', () => window.print());
}

// ======================================================================= Eco Wallet
function ruleText(r) {
  const unit = r.valuation_method === 'per_kg' ? 'kg' : 'item';
  return r.rate_type === 'points' ? `${fmtNum(r.rate)} pts per ${unit}` : `₹${r.rate} worth per ${unit}`;
}

function txnRow(t) {
  const counted = t.status === 'Approved' || t.status === 'Redeemed';
  const measure = [t.verified_qty ? `${t.verified_qty} ${t.verified_qty === 1 ? 'item' : 'items'}` : null, t.verified_weight_kg != null ? `${t.verified_weight_kg} kg` : null].filter(Boolean).join(' · ');
  return html`<li class="txn">
    <span class="txn__title">${t.category_name}</span>
    <span class="txn__points ${t.status === 'Rejected' ? 'txn__points--muted' : ''}">${counted || t.status === 'Pending' ? '+' : ''}${fmtNum(t.points)} pts</span>
    <span class="txn__meta">${fmtDate(t.requested_date)} · <a href="#/pickups/${t.booking_code}">${t.booking_code}</a>${measure ? ` · ${measure}` : ''}</span>
    <span class="txn__status">${t.redemption_id && t.status === 'Approved' ? badge('Requested') : badge(t.status)}</span>
    ${t.status === 'Rejected' && t.admin_note ? html`<span class="txn__note">Reason: ${t.admin_note}</span>` : ''}
    ${t.status === 'Pending' ? html`<span class="txn__note">Waiting for our team to verify the items and valuation.</span>` : ''}
  </li>`;
}

export async function wallet(main, ctx) {
  const w = await api('/wallet');
  const b = w.balance;
  const anySample = w.rules.some((r) => r.is_sample);
  main.className = 'narrow';
  main.innerHTML = html`
    <div class="page-head"><div><h1>Eco Wallet</h1><p>Points for e-waste you hand over, added after verification.</p></div></div>
    <section class="wallet-hero" aria-labelledby="bal">
      <p class="wallet-hero__label" id="bal">Available Eco Points</p>
      <p class="wallet-hero__points">${fmtNum(b.available)} <small>pts</small></p>
      <p class="wallet-hero__value">${!b.rupees_per_point
        ? 'A ₹ value for points has not been set yet.'
        : b.point_value_is_sample
        ? html`Indicative value <strong>${fmtINR(b.available_rupees)}</strong> at a sample rate of ${fmtINR(b.rupees_per_point)} per point — not a cash offer.`
        : html`Worth <strong>${fmtINR(b.available_rupees)}</strong> (${fmtINR(b.rupees_per_point)} per point)`}</p>
      <div class="wallet-split">
        <div><span>Pending verification</span><strong style="color: var(--gold-600);">${fmtNum(b.pending)} pts</strong></div>
        ${b.in_redemption ? html`<div><span>In redemption</span><strong>${fmtNum(b.in_redemption)} pts</strong></div>` : ''}
        <div><span>Redeemed to date</span><strong>${fmtNum(b.redeemed)} pts</strong></div>
      </div>
      ${b.pending > 0 ? html`<p class="muted" style="margin-top: 8px; font-size: 0.9rem;">You have <strong>${fmtNum(b.pending)} pending points</strong> awaiting admin review. Only approved points increase your available balance.</p>` : ''}
      <div class="actions">
        ${w.redemption.available
          ? html`<button class="btn btn--accent" id="redeem" ${b.available < w.redemption.min_points ? raw('disabled') : ''}>Redeem points</button>
                 <span class="wallet-hero__value">${b.available < w.redemption.min_points ? `You need ${fmtNum(w.redemption.min_points)} points to redeem. ` : ''}Via ${w.redemption.method}.</span>`
          : html`<button class="btn btn--accent" disabled aria-disabled="true">Redeem points</button><span class="wallet-hero__value">Redemption coming soon.</span>`}
      </div>
    </section>

    <section class="card section">
      <h2>Transaction history</h2>
      ${w.transactions.length ? html`<ul class="txns">${w.transactions.map(txnRow)}</ul>` : empty('No Eco Points yet. Book a pickup to start earning.', html`<a class="btn" href="#/book">Book a pickup</a>`)}
    </section>

    ${w.redemptions.length ? html`<section class="card section"><h2>Redemption requests</h2><ul class="txns">${w.redemptions.map((r) => html`<li class="txn">
      <span class="txn__title">${r.method}</span><span class="txn__points">${fmtNum(r.points)} pts</span>
      <span class="txn__meta">Requested ${fmtDateTime(r.created_at)}${r.reference ? ` · Ref ${r.reference}` : ''}</span><span class="txn__status">${badge(r.status)}</span></li>`)}</ul></section>` : ''}

    <section class="card section">
      <h2>How you earn points</h2>
      <ol>
        <li>Book a pickup and hand over your e-waste.</li>
        <li>The collector records the actual items, counts and weights. Points show as <strong>pending</strong>.</li>
        <li>Our team checks the items against the current points rules and approves them. Approved points become <strong>available</strong>.</li>
      </ol>
      <p class="muted">Items that are damaged in ways that make them hazardous, or that are not e-waste, may not earn points. You will see the reason in your history.</p>
      ${!w.rules.length ? html`<p class="muted">Points rates have not been published yet. Pickups still record your items, and points are added once rates are approved.</p>` : ''}
      ${w.rules.length ? html`<h3>Current rates ${anySample ? html`<span class="tag">Sample rates</span>` : ''}</h3>
        <ul class="items">${w.rules.map((r) => html`<li><span>${r.category_name}</span><strong>${ruleText(r)}</strong></li>`)}</ul>
        ${anySample ? html`<p class="muted"><small>Sample rates are shown for demonstration and can change before launch.</small></p>` : ''}` : ''}
    </section>`;
  main.querySelector('#redeem')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/wallet/redeem', { method: 'POST' });
      toast(`Redemption requested for ${fmtNum(r.points)} points. Our team will process it.`);
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'bad');
      e.target.disabled = false;
    }
  });
}

// ======================================================================= Account
export async function account(main, ctx) {
  const { state } = ctx;
  const isCustomer = state.user.role === 'customer';
  const addresses = isCustomer ? await api('/addresses') : [];
  main.className = 'narrow';
  const addrFields = [
    { name: 'label', label: 'Label' },
    { name: 'pincode', label: 'PIN code', required: true, inputmode: 'numeric' },
    { name: 'unit', label: 'Flat / house number' },
    { name: 'address_line', label: 'Street, colony and landmark', required: true, wide: true },
    { name: 'access_instructions', label: 'Access instructions', type: 'textarea', rows: 2, wide: true },
  ];
  main.innerHTML = html`
    <h1>Account</h1>
    <form class="card form-grid" id="profile">
      <h2>Your details</h2>
      ${formFields([
        { name: 'name', label: 'Name', required: true, autocomplete: 'name' },
        { name: 'phone', label: 'Mobile number', type: 'tel', required: true, inputmode: 'tel', autocomplete: 'tel-national' },
      ], state.user)}
      <p class="muted">Email: ${state.user.email} · <a href="#/change-password">Change password</a></p>
      <div><button class="btn" type="submit">Save details</button></div>
    </form>
    ${isCustomer ? html`<section class="card section">
      <h2>Saved addresses</h2>
      ${addresses.length ? addresses.map((a) => html`<details class="panel"><summary>${a.label || 'Address'} — ${a.area}, ${a.pincode}</summary><div>
        <form class="form-grid form-grid--2" data-addr="${a.id}">${formFields(addrFields, a)}
          <div class="actions field--wide"><button class="btn btn--sm" type="submit">Save</button><button class="btn btn--sm btn--danger" type="button" data-del="${a.id}">Remove</button></div></form></div></details>`)
        : html`<p class="muted">No saved addresses yet.</p>`}
      <details class="panel"><summary>Add an address</summary><div><form class="form-grid form-grid--2" id="new-addr">${formFields(addrFields)}<div class="field--wide"><button class="btn btn--sm" type="submit">Add address</button></div></form></div></details>
    </section>` : ''}`;
  onSubmit(main.querySelector('#profile'), async (v) => {
    const r = await api('/account', { method: 'PUT', body: v });
    state.user = r.user;
    toast('Details saved.');
    ctx.refresh();
  });
  main.querySelectorAll('[data-addr]').forEach((f) => onSubmit(f, async (v) => {
    await api(`/addresses/${f.dataset.addr}`, { method: 'PUT', body: v });
    toast('Address saved.');
    ctx.refresh();
  }));
  main.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/addresses/${b.dataset.del}`, { method: 'DELETE' });
      toast('Address removed.');
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }));
  const add = main.querySelector('#new-addr');
  if (add) onSubmit(add, async (v) => {
    await api('/addresses', { method: 'POST', body: v });
    toast('Address added.');
    ctx.refresh();
  });
}

