/* The "Open" quick look on the Calls page: a light panel with only what you need for the call. No script, no log, no notes,
   no status controls. It is a dialog, so Esc closes it, focus stays inside while it is open and goes back to the Open button. */
import { h, Lib, icon, dialog, head, loc, oddsChip, telLink, fmtDay } from './ui.js';

/* A website link that can only ever be http or https. */
export function safeUrl(site) {
  const t = String(site || '').trim();
  if (!t) return null;
  const url = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : 'https://' + t;
  try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null; } catch (e) { return null; }
}
const n = (v) => Number(v).toLocaleString('en-US');

function rankBlock(l) {
  const r = l.rank_info;
  if (!r || !r.my_rank) return h('p', { class: 'peek-none' }, 'No ranking data for this one yet.');
  const where = r.total ? ' of ' + r.total : '';
  const seen = r.checked_at ? ' (' + fmtDay(r.checked_at) + ')' : '';
  const comps = (r.top3 || []).slice(0, 3);
  return h('div', { class: 'peek-rank' },
    h('p', { class: 'peek-rankline' }, 'Ranks #' + r.my_rank + where + ' on Google Maps for ‘' + r.query + '’'),
    comps.length ? h('div', null,
      h('h3', { class: 'peek-sub' }, 'Top ' + comps.length + (comps.length === 1 ? ' competitor' : ' competitors')),
      h('ol', { class: 'peek-comps' }, ...comps.map((c) => h('li', null,
        h('span', { class: 'pos mono' }, c.rank ? '#' + c.rank : ''),
        h('div', { class: 'who' }, h('div', { class: 'cname' }, c.name),
          h('div', { class: 'meta' }, c.rating ? c.rating + ' stars' + (c.reviews != null ? ', ' + n(c.reviews) + ' reviews' : '') : (c.reviews != null ? n(c.reviews) + ' reviews' : 'No rating shown')),
          c.phone ? h('div', { class: 'meta' }, telLink(c.phone)) : null))))) : null,
    h('p', { class: 'hint' }, 'Seen on the day the list was scraped' + seen + '. Rankings move and shift by where the searcher is, so re-check before you say it on a call.'));
}

/* l is a row from the call queue (it carries website and rank_info). opener is the Open button that was tapped. */
export function openPeek(l, now, win, opener) {
  const w = Lib.okToCall(now, l.tz, win.start, win.end);
  const site = safeUrl(l.website);
  const place = loc(l);
  const call = w.ok && l.phone
    ? h('a', { class: 'btn lampbtn sm', href: 'tel:+1' + Lib.normPhone(l.phone), 'aria-label': 'Call ' + l.business_name }, icon('phone', 16), 'Call')
    : null;
  const p = dialog((root, close) => {
    root.append(
      head(l.business_name, close),
      h('dl', { class: 'peek-list' },
        h('div', { class: 'peek-row' }, h('dt', null, 'Owner'), h('dd', null, l.owner_name ? l.owner_name : h('span', { class: 'muted' }, 'Not known'), l.owner_odds ? [' ', oddsChip(l)] : null)),
        h('div', { class: 'peek-row' }, h('dt', null, 'Phone'), h('dd', { class: 'peek-phone' }, telLink(l.phone), call)),
        h('div', { class: 'peek-row' }, h('dt', null, 'Location'), h('dd', null, place || h('span', { class: 'muted' }, 'Not known'))),
        h('div', { class: 'peek-row' }, h('dt', null, 'Website'), h('dd', null, site
          ? h('a', { class: 'peek-site', href: site, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Website of ' + l.business_name + ' (opens in a new tab)' }, Lib.normWebsite(l.website) || site)
          : h('span', { class: 'muted' }, 'None listed')))),
      h('section', { class: 'peek-maps', 'aria-label': 'Google Maps ranking' }, h('h3', { class: 'peek-sub' }, 'Where they rank on Google Maps'), rankBlock(l)),
      h('div', { class: 'dlg-foot' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => close('') }, 'Close')));
  }, { noFocus: true, className: 'peek' });
  p.then(() => { if (opener && opener.isConnected) opener.focus(); });
  return p;
}
