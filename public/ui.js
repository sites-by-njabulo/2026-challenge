/* Small UI toolkit: element builder, icons, toasts, dialogs, API, formatting. */
import './lib.js';
export const Lib = window.Lib;

/* ---------- element builder ---------- */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'disabled' || k === 'required' || k === 'open' || k === 'selected' || k === 'hidden') { if (v) el.setAttribute(k, ''); }
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}
export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return el;
}
export const $ = (sel, root) => (root || document).querySelector(sel);
export const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

/* ---------- icons (24px grid, 1.8 stroke) ---------- */
const ICONS = {
  today: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  leads: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  pipeline: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="13" rx="1"/>',
  stats: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  group: '<circle cx="9" cy="9" r="3"/><circle cx="17" cy="10" r="2.4"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5M15 15c3 0 6 1.5 6 4"/>',
  text: '<path d="M4 5h16v12H8l-4 3z"/><path d="M8 10h8M8 13h5"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4-4"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  alert: '<path d="M12 4 2 20h20z"/><path d="M12 10v5M12 18v.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  out: '<path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M16 8l4 4-4 4M20 12H9"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/>',
  undo: '<path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/>',
  chevL: '<path d="M15 18l-6-6 6-6"/>',
  chevR: '<path d="M9 18l6-6-6-6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  mailbox: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
};
export function icon(name, size) {
  const s = size || 20;
  const span = document.createElement('span');
  span.style.display = 'inline-flex';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}
export const CHANNEL_ICON = { call: 'phone', instagram_dm: 'chat', facebook_dm: 'chat', facebook_group: 'group', email: 'mail', text: 'text' };

/* ---------- toasts ---------- */
export function toast(message, opts) {
  opts = opts || {};
  const box = $('#toasts');
  const el = h('div', { class: 'toast' + (opts.error ? ' error' : '') }, h('span', null, message));
  if (opts.action) el.append(h('button', { type: 'button', onclick: () => { opts.action.run(); el.remove(); } }, opts.action.label));
  box.append(el);
  setTimeout(() => el.remove(), opts.error ? 6500 : opts.action ? 7000 : 3200);
}

/* ---------- dialogs ---------- */
export function dialog(build, opts) {
  opts = opts || {};
  const dlg = h('dialog', { class: opts.wide ? 'wide' : '' });
  const close = (v) => { dlg.close(v); };
  const inner = h('div', { class: 'dlg' });
  dlg.append(inner);
  build(inner, close);
  document.body.append(dlg);
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => { dlg.remove(); resolve(dlg.returnValue || null); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(''); });
    dlg.addEventListener('focusin', (e) => {
      const t = e.target;
      if (t && t.matches && t.matches('input, textarea, select')) setTimeout(() => { try { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (err) { /* ignore */ } }, 320);
    });
    dlg.showModal();
    const first = dlg.querySelector('[autofocus], input:not([type=hidden]), textarea, select');
    if (first && !opts.noFocus) first.focus();
  });
}
export function head(title, close) {
  return h('div', { class: 'dlg-head' }, h('h2', null, title), h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Close', onclick: () => close('') }, icon('x')));
}
export function confirmDialog({ title, message, confirmLabel, danger, typed, typedLabel }) {
  return dialog((root, close) => {
    const input = typed ? h('input', { class: 'input', 'aria-label': typedLabel || 'Type to confirm', autocomplete: 'off', autofocus: true }) : null;
    const ok = h('button', { class: 'btn' + (danger ? ' danger' : ''), type: 'button', disabled: !!typed, onclick: () => close('yes') }, confirmLabel || 'Confirm');
    if (input) input.addEventListener('input', () => { if (input.value === typed) ok.removeAttribute('disabled'); else ok.setAttribute('disabled', ''); });
    append(root, [head(title, close), h('p', null, message), input && h('div', { class: 'field' }, h('label', null, typedLabel || 'Type ' + typed + ' to confirm'), input),
      h('div', { class: 'dlg-foot' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => close('') }, 'Cancel'), ok)]);
  }).then((v) => v === 'yes');
}

/* ---------- API ---------- */
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }
export async function api(method, path, body) {
  // reads that depend on "now" use this browser's clock, so what you see always matches your own screen
  if ((/^\/api\/(today|calls|followups|pipeline|stats|outreach|email)(\/|\?|$)/.test(path) || /^\/api\/leads\/\d+\/contacts/.test(path)) && !/[?&]now=/.test(path)) path += (path.includes('?') ? '&' : '?') + 'now=' + encodeURIComponent(new Date().toISOString());
  let res;
  try { res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' }); } catch (e) {
    const err = new Error('No connection. Check your signal and try again.'); err.offline = true; throw err;
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* not json */ }
  if (res.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/password')) onUnauthorized();
  if (!res.ok) { const err = new Error((data && data.error) || res.statusText); err.status = res.status; err.data = data; throw err; }
  return data;
}

/* ---------- formatting ---------- */
export const state = { settings: null };
export const myTz = () => (state.settings && state.settings.my_timezone) || 'Africa/Johannesburg';
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDay(key) {
  if (!key) return '';
  const wd = WD[Lib.weekdayOfKey(key)];
  const [y, m, d] = key.split('-').map(Number);
  return `${wd} ${d} ${MON[m - 1]}${y !== new Date().getFullYear() ? ' ' + y : ''}`;
}
export function fmtDateTime(iso, tz) {
  if (!iso) return '';
  const d = new Date(iso);
  tz = tz || myTz();
  const key = Lib.dayKey(d, tz);
  return `${fmtDay(key)}, ${Lib.fmtClock(d, tz)}`;
}
export function relDay(key, today) {
  if (!key) return '';
  const diff = Lib.daysBetween(today, key);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff < 0) return Math.abs(diff) + ' days overdue';
  if (diff < 7) return 'In ' + diff + ' days';
  return fmtDay(key);
}
export const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
export const pct = (v) => (v == null ? 'n/a' : (Math.round(v * 1000) / 10) + '%');
export function ago(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  if (mins < 1440) return Math.round(mins / 60) + 'h ago';
  const d = Math.round(mins / 1440);
  return d + (d === 1 ? ' day ago' : ' days ago');
}
export function statusChip(status) { return h('span', { class: 'chip s-' + status }, Lib.STATUS_LABEL[status] || status); }
/* Owner odds: a quiet chip, a dot that fills up with the odds (empty ring = Low, half = Medium, full = High) plus the word. Not a status colour on purpose. */
const ODDS_WORD = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };
export const ODDS_CHOICES = [['HIGH', 'High'], ['MEDIUM', 'Medium'], ['LOW', 'Low']];
export function oddsChip(l) {
  const o = l && l.owner_odds;
  if (!ODDS_WORD[o]) return null;
  return h('span', { class: 'chip odds odds-' + o.toLowerCase(), role: 'img', 'aria-label': 'Owner odds: ' + ODDS_WORD[o] }, ODDS_WORD[o] + ' odds');
}
export function loc(l) { return [l.city, l.state].filter(Boolean).join(', '); }
export function ownerLine(l) { return [l.owner_name, l.trade].filter(Boolean).join(' · '); }
export function telLink(phone) {
  if (!phone) return h('span', { class: 'muted' }, 'No phone');
  const digits = Lib.normPhone(phone);
  return h('a', { href: 'tel:+1' + digits, class: 'mono' }, Lib.formatPhone(phone));
}
export function tzLabel(tz) {
  if (!tz) return '';
  const hit = Lib.TZ_CHOICES.find((c) => c.id === tz);
  return hit ? hit.label : tz.split('/').pop().replace(/_/g, ' ');
}
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* Window marker with the lead's local time and mine (SAST). `win` comes from Lib.okToCall. */
export function windowMarker(win) {
  if (win.unknown) return h('span', { class: 'window unknown' }, icon('alert', 16), 'Set a time zone to call');
  if (win.ok) return h('span', { class: 'window ok' }, h('span', { class: 'lamp on' }), 'OK to call now', h('span', { class: 'muted', style: 'font-weight:400' }, '· closes in ' + Lib.fmtDur(win.minsLeft)));
  return h('span', { class: 'window closed' }, icon('clock', 16), 'Not yet · ' + win.reason.toLowerCase());
}
export function timesLine(tz, now, win) {
  if (!tz) return '';
  const mine = Lib.fmtClock(now, myTz()) + ' ' + Lib.tzAbbr(now, myTz());
  return h('span', { class: 'mono small' }, win.local + '  ·  you ' + mine);
}

/* "Contacted via" chips: every channel used on a lead, with a count when more than once. channels = [{channel, count}] */
const CH_SHORT = { call: 'Call', instagram_dm: 'Instagram', facebook_dm: 'Facebook', facebook_group: 'Group', email: 'Email', text: 'Text' };
export function channelChips(channels) {
  if (!channels || !channels.length) return h('span', { class: 'muted' }, 'Not yet');
  return h('span', { class: 'via' }, ...channels.map((c) => h('span', { class: 'chip flat via-chip', title: Lib.CHANNEL_LABEL[c.channel] + ' x' + c.count }, icon(CHANNEL_ICON[c.channel], 14), CH_SHORT[c.channel] || c.channel, c.count > 1 ? h('span', { class: 'mono muted' }, ' \u00d7' + c.count) : null)));
}
/* The sending mailboxes from the latest Zapmail snapshot (cached for the session). */
let mailboxCache = null;
export function getMailboxes() {
  if (!mailboxCache) mailboxCache = api('GET', '/api/email').then((d) => (d.snapshot ? d.snapshot.mailboxes.map((m) => m.email) : [])).catch(() => []);
  return mailboxCache;
}
export function forgetMailboxes() { mailboxCache = null; }

/* A <details> that is open on a wide screen and starts closed on a phone (unless force is true). Its summary is hidden on wide screens by CSS. */
export function responsiveFold(details, force) {
  const mq = window.matchMedia('(max-width: 860px)');
  const apply = () => { if (!mq.matches) details.open = true; };
  details.open = !mq.matches || !!force;
  details.classList.add('rfold');
  if (mq.addEventListener) mq.addEventListener('change', apply);
  return details;
}

/* Runs fn every ms while the page is visible, and once when you come back to the app after being away longer than ms. */
export function autoRefresh(fn, ms, skip) {
  let last = Date.now();
  const run = () => { last = Date.now(); fn(); };
  const timer = setInterval(() => { if (!document.hidden && !(skip && skip())) run(); }, ms);
  const onVis = () => { if (!document.hidden && Date.now() - last > ms && !(skip && skip())) run(); };
  document.addEventListener('visibilitychange', onVis);
  return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVis); };
}

/* Phone keyboard and toolbar handling. Sets --kb (how much of the bottom is covered) and a "typing" class so the bottom tabs
   get out of the way while a field is focused. Same visualViewport idea as the iOS fixed-bar fix. */
export function initViewport() {
  const root = document.documentElement;
  const vv = window.visualViewport;
  const measure = () => {
    if (!vv) return;
    const covered = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    root.style.setProperty('--kb', covered + 'px');
    root.style.setProperty('--vvh', Math.round(vv.height) + 'px');
  };
  if (vv) { vv.addEventListener('resize', measure); vv.addEventListener('scroll', measure); window.addEventListener('pageshow', measure); measure(); }
  const editable = (e) => e && e.matches && e.matches('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=button]):not([type=submit]), textarea, select');
  let off = null;
  document.addEventListener('focusin', (e) => { clearTimeout(off); if (editable(e.target)) root.classList.add('typing'); });
  document.addEventListener('focusout', () => { clearTimeout(off); off = setTimeout(() => { if (!editable(document.activeElement)) root.classList.remove('typing'); }, 120); });
}
