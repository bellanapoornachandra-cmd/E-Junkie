import { html, api, toast, loading, errorBox, onSubmit, formFields, supportText } from './ui.js';
import * as customer from './customer.js';
import * as ops from './ops.js';
import * as admin from './admin.js';

export const state = { user: null, config: null };

const NAV = {
  guest: [['#/', 'Home'], ['#/book', 'Book a pickup'], ['#/login', 'Log in']],
  customer: [['#/', 'Home'], ['#/book', 'Book a pickup'], ['#/pickups', 'My pickups'], ['#/wallet', 'Eco Wallet'], ['#/account', 'Account']],
  collector: [['#/collector', 'My pickups'], ['#/account', 'Account']],
  admin: [['#/admin', 'Dashboard'], ['#/admin/bookings', 'Bookings'], ['#/admin/wallet', 'Eco Wallet'], ['#/admin/handoffs', 'Recycler handoffs'], ['#/admin/slots', 'Slots'], ['#/admin/settings', 'Setup']],
};

// [pattern, view, roles]. roles: null = anyone.
const ROUTES = [
  [/^\/$/, customer.home, null],
  [/^\/login$/, login, null],
  [/^\/signup$/, signup, null],
  [/^\/change-password$/, changePassword, ['customer', 'collector', 'admin']],
  [/^\/book$/, customer.book, null],
  [/^\/pickups$/, customer.pickups, ['customer']],
  [/^\/pickups\/([\w-]+)$/, ops.pickupDetail, ['customer', 'collector', 'admin']],
  [/^\/receipt\/([\w-]+)$/, customer.receipt, ['customer', 'admin']],
  [/^\/wallet$/, customer.wallet, ['customer']],
  [/^\/account$/, customer.account, ['customer', 'collector', 'admin']],
  [/^\/collector$/, ops.collectorHome, ['collector']],
  [/^\/admin$/, admin.dashboard, ['admin']],
  [/^\/admin\/(\w+)$/, admin.section, ['admin']],
];

const homeFor = (u) => (!u ? '#/' : u.role === 'collector' ? '#/collector' : u.role === 'admin' ? '#/admin' : '#/pickups');

function renderChrome(path) {
  const role = state.user ? state.user.role : 'guest';
  const items = NAV[role];
  const active = items.filter(([href]) => `#${path}` === href || (href !== '#/' && href !== '#/admin' && `#${path}`.startsWith(href))).pop();
  document.getElementById('nav').innerHTML = html`${items.map(
    ([href, label]) => html`<li><a href="${href}" ${active && active[0] === href ? html`aria-current="page"` : ''}>${label}</a></li>`,
  )}`;
  const u = document.getElementById('header-user');
  u.innerHTML = state.user
    ? html`<span class="header__role">${state.user.role}</span><span class="hide-sm">${state.user.name.split(' ')[0]}</span><button class="btn btn--ghost btn--sm" id="logout">Log out</button>`
    : html`<a class="btn btn--accent btn--sm" href="#/signup">Sign up</a>`;
  const out = document.getElementById('logout');
  if (out) {
    out.onclick = async () => {
      await api('/auth/logout', { method: 'POST' });
      state.user = null;
      location.hash = '#/';
      toast('You have been logged out.');
    };
  }
  if (state.config) {
    const help = supportText(state.config);
    document.getElementById('footer').textContent = `E-Junkie · Doorstep e-waste pickup · Visakhapatnam${help ? ` · Help: ${help}` : ''}`;
  }
}

let renderSeq = 0;
export async function router() {
  const path = (location.hash.replace(/^#/, '') || '/').split('?')[0];
  const main = document.getElementById('main');
  renderChrome(path);
  const match = ROUTES.map(([re, view, roles]) => ({ m: path.match(re), view, roles })).find((r) => r.m);
  if (!match) {
    main.innerHTML = html`<h1>Page not found</h1><p><a href="${homeFor(state.user)}">Go to the start</a></p>`;
    return;
  }
  if (state.user && state.user.must_change_password && path !== '/change-password') {
    location.hash = '#/change-password';
    return;
  }
  if (match.roles && (!state.user || !match.roles.includes(state.user.role))) {
    if (!state.user) {
      sessionStorage.setItem('ej_after_login', location.hash);
      location.hash = '#/login';
    } else location.hash = homeFor(state.user);
    return;
  }
  const seq = ++renderSeq;
  main.className = '';
  main.innerHTML = String(loading());
  try {
    const ctx = { params: match.m.slice(1), query: new URLSearchParams(location.hash.split('?')[1] || ''), state, refresh: router, isCurrent: () => seq === renderSeq };
    await match.view(main, ctx);
  } catch (err) {
    if (seq !== renderSeq) return;
    if (err.code === 'password_change_required') {
      state.user.must_change_password = true;
      location.hash = '#/change-password';
      return;
    }
    if (err.status === 401) {
      state.user = null;
      location.hash = '#/login';
      return;
    }
    main.innerHTML = String(errorBox(err));
  }
  if (seq === renderSeq && !document.activeElement?.closest('main')) window.scrollTo(0, 0);
}

function afterLogin() {
  if (state.user.must_change_password) {
    location.hash = '#/change-password';
    return;
  }
  const next = sessionStorage.getItem('ej_after_login');
  sessionStorage.removeItem('ej_after_login');
  location.hash = next && !next.includes('login') ? next : homeFor(state.user);
}

async function login(main) {
  if (state.user) {
    location.hash = homeFor(state.user);
    return;
  }
  main.className = 'narrow';
  main.innerHTML = html`<div class="auth card">
    <h1>Log in</h1>
    <form id="login-form" class="form-grid">
      ${formFields([
        { name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'email' },
        { name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'current-password' },
      ])}
      <button class="btn btn--lg btn--block" type="submit">Log in</button>
    </form>
    <p class="muted">New here? <a href="#/signup">Create a customer account</a></p>
  </div>`;
  onSubmit(main.querySelector('#login-form'), async (v) => {
    const r = await api('/auth/login', { method: 'POST', body: v });
    state.user = r.user;
    toast(`Welcome back, ${r.user.name.split(' ')[0]}.`);
    afterLogin();
  });
}

async function signup(main) {
  main.className = 'narrow';
  main.innerHTML = html`<div class="auth card">
    <h1>Create your account</h1>
    <p class="muted">You need an account to book and track pickups.</p>
    <form id="signup-form" class="form-grid">
      ${formFields([
        { name: 'name', label: 'Full name', required: true, autocomplete: 'name' },
        { name: 'phone', label: 'Mobile number', type: 'tel', required: true, inputmode: 'tel', autocomplete: 'tel-national', help: '10-digit Indian mobile number' },
        { name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'email' },
        { name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'new-password', help: 'At least 10 characters' },
      ])}
      <button class="btn btn--lg btn--block" type="submit">Create account</button>
    </form>
    <p class="muted">Already registered? <a href="#/login">Log in</a></p>
  </div>`;
  onSubmit(main.querySelector('#signup-form'), async (v) => {
    const r = await api('/auth/signup', { method: 'POST', body: v });
    state.user = r.user;
    toast('Account created.');
    afterLogin();
  });
}

async function changePassword(main) {
  const forced = state.user.must_change_password;
  main.className = 'narrow';
  main.innerHTML = html`<div class="auth card">
    <h1>${forced ? 'Set a new password' : 'Change password'}</h1>
    ${forced ? html`<p class="callout">You signed in with a temporary password. Choose your own password before continuing.</p>` : ''}
    <form id="pw-form" class="form-grid">
      ${formFields([
        { name: 'current_password', label: forced ? 'Temporary password' : 'Current password', type: 'password', required: true, autocomplete: 'current-password' },
        { name: 'new_password', label: 'New password', type: 'password', required: true, autocomplete: 'new-password', help: 'At least 10 characters' },
        { name: 'confirm', label: 'Confirm new password', type: 'password', required: true, autocomplete: 'new-password' },
      ])}
      <button class="btn btn--lg btn--block" type="submit">Save new password</button>
    </form>
  </div>`;
  onSubmit(main.querySelector('#pw-form'), async (v) => {
    if (v.new_password !== v.confirm) throw new Error('The new passwords do not match.');
    const r = await api('/auth/change-password', { method: 'POST', body: { current_password: v.current_password, new_password: v.new_password } });
    state.user = r.user;
    toast('Password updated.');
    location.hash = homeFor(state.user);
  });
}

async function start() {
  const [me, config] = await Promise.all([api('/me'), api('/public/config')]);
  state.user = me.user;
  state.config = config;
  window.addEventListener('hashchange', router);
  router();
}

start().catch((err) => {
  document.getElementById('main').innerHTML = String(errorBox(err));
});
