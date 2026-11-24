import { h, icon, api, toast, state, setUnauthorizedHandler, clear, $, initViewport } from './ui.js';
import { renderToday } from './today.js';

const root = $('#root');
let cleanup = null;
let booted = false;
initViewport();

/* Only Today is loaded up front. The other screens are fetched the first time you open them. */
const PAGES = {
  calls: () => import('./calls.js').then((m) => m.renderCalls),
  email: () => import('./email.js').then((m) => m.renderEmail),
  followups: () => import('./followups.js').then((m) => m.renderFollowups),
  leads: () => import('./leads.js').then((m) => m.renderLeads),
  lead: () => import('./lead.js').then((m) => m.renderLead),
  pipeline: () => import('./stats.js').then((m) => m.renderPipeline),
  stats: () => import('./stats.js').then((m) => m.renderStats),
  settings: () => import('./settings.js').then((m) => m.renderSettings),
  import: () => import('./import.js').then((m) => m.renderImport),
};

/* a deep link or a pinned screen starts fetching its code right away, in parallel with the login check */
{ const first = location.hash.split('?')[0].split('/')[1]; if (PAGES[first]) PAGES[first]().catch(() => {}); }

const NAV = [['today', 'Today', 'today'], ['calls', 'Calls', 'phone'], ['leads', 'Leads', 'leads'], ['pipeline', 'Pipeline', 'pipeline'], ['email', 'Email', 'mail'], ['stats', 'Stats', 'stats']];

function brand() { return h('div', { class: 'brand' }, h('span', { class: 'lamp on' }), 'Lead Tracker'); }

/* ---------- auth ---------- */
function renderAuth(me) {
  booted = false;
  if (cleanup) { cleanup(); cleanup = null; }
  const setup = me.setup_needed;
  const pw = h('input', { class: 'input', id: 'pw', name: 'password', type: 'password', autocomplete: setup ? 'new-password' : 'current-password', enterkeyhint: setup ? 'next' : 'go', required: true, autofocus: !setup });
  const code = setup ? h('input', { class: 'input', id: 'setup-code', name: 'setup-code', type: 'password', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'next', required: true, autofocus: true }) : null;
  const err = h('div', { class: 'err', role: 'alert' });
  const btn = h('button', { class: 'btn', type: 'submit' }, setup ? 'Set password' : 'Sign in');
  const show = setup ? h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { pw.type = e.target.checked ? 'text' : 'password'; } }), 'Show password') : null;
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; btn.setAttribute('disabled', '');
    try { await api('POST', setup ? '/api/setup' : '/api/login', setup ? { password: pw.value, setup_token: code.value } : { password: pw.value }); await boot(); } catch (ex) { err.textContent = ex.message; btn.removeAttribute('disabled'); pw.select(); }
  } }, brand(),
  h('h1', { style: 'font-size:22px' }, setup ? 'Set a password' : 'Sign in'),
  setup ? h('p', { class: 'muted' }, 'First time here. Choose a password of 8 or more characters. Your leads are saved in your own database. Type the setup code you added in Vercel (SETUP_TOKEN) so only you can do this step.') : null,
  /* a hidden user name lets phone password managers save and fill the password for this site */
  h('input', { class: 'sr-only', type: 'text', name: 'username', autocomplete: 'username', value: 'lead-tracker', tabindex: '-1', 'aria-hidden': 'true' }),
  setup ? h('div', { class: 'field' }, h('label', { for: 'setup-code' }, 'Setup code'), code) : null,
  h('div', { class: 'field' }, h('label', { for: 'pw' }, 'Password'), pw), show, err, btn);
  root.replaceChildren(h('div', { class: 'auth' }, form));
}

async function logout() {
  try { await api('POST', '/api/logout'); } catch (e) { /* ignore */ }
  await boot();
}

/* ---------- shell ---------- */
async function addLead() {
  const { openLeadForm } = await import('./leads.js');
  openLeadForm({ onSaved: (r) => { location.hash = '#/lead/' + r.lead.id; } });
}
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

/* ---------- router ---------- */
let curName = null;
const scrollMemo = {};
async function route() {
  if (!booted) return;
  if (cleanup) { try { cleanup(); } catch (e) { /* ignore */ } cleanup = null; }
  const [, name = 'today', arg] = location.hash.split('?')[0].split('/');
  const page = $('#page');
  if (!page) return;
  /* opening a lead remembers where you were on the list, so Back puts you in the same spot */
  if (name === 'lead' && curName && curName !== 'lead') scrollMemo[curName] = window.scrollY;
  const restore = curName === 'lead' && name !== 'lead' && scrollMemo[name] != null ? scrollMemo[name] : 0;
  curName = name;
  clear(page);
  page.classList.add('loading');
  const current = name === 'lead' || name === 'import' ? 'leads' : name === 'followups' ? 'today' : name;
  document.querySelectorAll('.nav a').forEach((a) => { if (a.dataset.nav === current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  document.title = ({ today: 'Today', calls: 'Calls', email: 'Email', followups: 'Follow-ups', leads: 'Leads', lead: 'Lead', pipeline: 'Pipeline', stats: 'Stats', settings: 'Settings', import: 'Import' }[name] || 'Lead Tracker') + ' · Lead Tracker';
  const ctx = { logout };
  try {
    let c;
    if (name === 'today') c = await renderToday(page);
    else if (PAGES[name]) {
      const fn = await PAGES[name]();
      c = await fn(page, name === 'lead' ? Number(arg) : name === 'settings' ? ctx : undefined);
    } else { location.hash = '#/today'; return; }
    cleanup = typeof c === 'function' ? c : null;
  } catch (e) {
    console.error(e);
    page.append(h('div', { class: 'banner danger' }, icon('alert'), h('div', null, 'Something went wrong loading this page. ' + e.message, h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => route() }, 'Try again')))));
  } finally { page.classList.remove('loading'); }
  window.scrollTo(0, restore);
}
window.addEventListener('hashchange', route);

async function boot() {
  const [me, settings] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/settings').catch(() => null)]);
  if (me.setup_needed || !me.authenticated) { renderAuth(me); return; }
  state.settings = settings || await api('GET', '/api/settings');
  renderShell();
  booted = true;
  if (!location.hash || location.hash === '#') location.hash = '#/today';
  else await route();
  warmUp();
}
/* After the first screen is up, quietly fetch the screens you are most likely to open next. */
let warmed = false;
function warmUp() {
  if (warmed || (navigator.connection && navigator.connection.saveData)) return;
  warmed = true;
  const go = () => ['calls', 'leads', 'followups', 'lead'].forEach((n) => { PAGES[n]().catch(() => {}); });
  if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 4000 }); else setTimeout(go, 2000);
}
setUnauthorizedHandler(() => { if (booted) { toast('Signed out. Sign in again.', { error: true }); boot(); } });
boot().catch((e) => { root.replaceChildren(h('div', { class: 'auth' }, h('div', { style: 'display:grid;gap:14px' }, h('h1', null, 'Cannot reach the server'), h('p', { class: 'muted' }, e.message), h('div', null, h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Try again'))))); });
