import { h, icon, api, toast, state, setUnauthorizedHandler, clear, $ } from './ui.js';
import { renderToday } from './today.js';
import { renderLeads, openLeadForm } from './leads.js';
import { renderLead } from './lead.js';
import { renderCalls } from './calls.js';
import { renderFollowups } from './followups.js';
import { renderEmail } from './email.js';
import { renderStats, renderPipeline } from './stats.js';
import { renderSettings } from './settings.js';
import { renderImport } from './import.js';

const root = $('#root');
let cleanup = null;
let booted = false;

const NAV = [['today', 'Today', 'today'], ['calls', 'Calls', 'phone'], ['leads', 'Leads', 'leads'], ['pipeline', 'Pipeline', 'pipeline'], ['email', 'Email', 'mail'], ['stats', 'Stats', 'stats']];

function brand() { return h('div', { class: 'brand' }, h('span', { class: 'lamp on' }), 'Lead Tracker'); }

/* ---------- auth ---------- */
function renderAuth(me) {
  booted = false;
  if (cleanup) { cleanup(); cleanup = null; }
  const setup = me.setup_needed;
  const pw = h('input', { class: 'input', id: 'pw', type: 'password', autocomplete: setup ? 'new-password' : 'current-password', required: true, autofocus: true });
  const err = h('div', { class: 'err', role: 'alert' });
  const btn = h('button', { class: 'btn', type: 'submit' }, setup ? 'Set password' : 'Sign in');
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; btn.setAttribute('disabled', '');
    try { await api('POST', setup ? '/api/setup' : '/api/login', { password: pw.value }); await boot(); } catch (ex) { err.textContent = ex.message; btn.removeAttribute('disabled'); pw.select(); }
  } }, brand(),
  h('h1', { style: 'font-size:22px' }, setup ? 'Set a password' : 'Sign in'),
  setup ? h('p', { class: 'muted' }, 'First time here. Choose a password of 8 or more characters. Your leads stay on this computer.') : null,
  h('div', { class: 'field' }, h('label', { for: 'pw' }, 'Password'), pw), err, btn);
  root.replaceChildren(h('div', { class: 'auth' }, form));
}

async function logout() {
  try { await api('POST', '/api/logout'); } catch (e) { /* ignore */ }
  await boot();
}

/* ---------- shell ---------- */
function renderShell() {
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' }, ...NAV.map(([id, label, ic]) => h('a', { href: '#/' + id, dataset: { nav: id } }, icon(ic, 20), label)));
  const rail = h('aside', { class: 'rail' }, brand(), nav, h('div', { class: 'spacer' }),
    h('div', { class: 'rail-foot' }, h('a', { class: 'footlink', href: '#/settings', dataset: { nav: 'settings' } }, icon('settings', 18), 'Settings'), h('button', { class: 'btn', type: 'button', onclick: () => addLead() }, icon('plus', 18), 'Add lead'),
      h('button', { class: 'btn ghost sm', type: 'button', onclick: logout }, icon('out', 16), 'Sign out')));
  const main = h('main', { id: 'view', tabindex: '-1' },
    h('div', { class: 'topbar' }, brand(), h('div', { class: 'actions' }, h('a', { class: 'iconbtn', href: '#/settings', 'aria-label': 'Settings' }, icon('gear', 22)), h('button', { class: 'btn sm', type: 'button', onclick: () => addLead() }, icon('plus', 16), 'Add lead'))),
    h('div', { id: 'page' }));
  root.replaceChildren(h('div', { id: 'app' }, rail, main));
}
function addLead() { openLeadForm({ onSaved: (r) => { location.hash = '#/lead/' + r.lead.id; } }); }

/* ---------- router ---------- */
async function route() {
  if (!booted) return;
  if (cleanup) { try { cleanup(); } catch (e) { /* ignore */ } cleanup = null; }
  const [, name = 'today', arg] = location.hash.split('?')[0].split('/');
  const page = $('#page');
  if (!page) return;
  clear(page);
  const current = name === 'lead' || name === 'import' ? 'leads' : name === 'followups' ? 'today' : name;
  document.querySelectorAll('.nav a').forEach((a) => { if (a.dataset.nav === current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  document.title = ({ today: 'Today', calls: 'Calls', email: 'Email', followups: 'Follow-ups', leads: 'Leads', lead: 'Lead', pipeline: 'Pipeline', stats: 'Stats', settings: 'Settings', import: 'Import' }[name] || 'Lead Tracker') + ' · Lead Tracker';
  const ctx = { logout };
  try {
    let c;
    if (name === 'today') c = await renderToday(page);
    else if (name === 'calls') c = await renderCalls(page);
    else if (name === 'email') c = await renderEmail(page);
    else if (name === 'followups') c = await renderFollowups(page);
    else if (name === 'leads') c = await renderLeads(page);
    else if (name === 'lead') c = await renderLead(page, Number(arg));
    else if (name === 'pipeline') c = await renderPipeline(page);
    else if (name === 'stats') c = await renderStats(page);
    else if (name === 'settings') c = await renderSettings(page, ctx);
    else if (name === 'import') c = await renderImport(page);
    else { location.hash = '#/today'; return; }
    cleanup = typeof c === 'function' ? c : null;
  } catch (e) {
    console.error(e);
    page.append(h('div', { class: 'banner danger' }, icon('alert'), h('div', null, 'Something went wrong loading this page. ' + e.message)));
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

async function boot() {
  const me = await api('GET', '/api/me');
  if (me.setup_needed || !me.authenticated) { renderAuth(me); return; }
  state.settings = await api('GET', '/api/settings');
  renderShell();
  booted = true;
  if (!location.hash || location.hash === '#') location.hash = '#/today';
  else await route();
}
setUnauthorizedHandler(() => { if (booted) { toast('Signed out. Sign in again.', { error: true }); boot(); } });
boot().catch((e) => { root.replaceChildren(h('div', { class: 'auth' }, h('div', null, h('h1', null, 'Cannot reach the server'), h('p', { class: 'muted' }, e.message)))); });
