import { h, Lib, icon, api, toast, dialog, head, loc, statusChip, oddsChip, ODDS_CHOICES, relDay, ago, debounce, state, myTz, myDay, CHANNEL_ICON, tzLabel, channelChips, responsiveFold } from './ui.js';

const FIELD_IDS = ['business_name', 'owner_name', 'phone', 'email', 'website', 'city', 'state', 'trade', 'source', 'source_link', 'batch', 'timezone', 'notes', 'owner_odds'];

/* Shows possible duplicates and opt-out matches. */
export function dupBox(duplicates, optouts, onAddAnyway) {
  if (!duplicates.length && !optouts.length) return null;
  const box = h('div', { class: 'dupbox', role: 'alert' });
  if (optouts.length) {
    box.append(h('div', null, h('strong', null, 'Matches an opt-out. '), 'This business asked not to be contacted (' + optouts.map((o) => o.business_name).join(', ') + '). If you add it anyway it will be saved as opted out.'));
  }
  if (duplicates.length) {
    box.append(h('div', null, h('strong', null, duplicates.length === 1 ? 'Possible duplicate' : duplicates.length + ' possible duplicates')));
    for (const d of duplicates) {
      box.append(h('div', { class: 'small' }, h('a', { href: '#/lead/' + d.lead.id, target: '_blank', rel: 'noopener' }, d.lead.business_name),
        ' ' + [loc(d.lead), d.lead.phone].filter(Boolean).join(' · ') + ' · ', h('span', { class: 'muted' }, d.reasons.join(', ')), d.lead.opted_out ? ' · opted out' : ''));
    }
  }
  if (onAddAnyway) box.append(h('div', null, h('button', { class: 'btn ghost sm', type: 'button', onclick: onAddAnyway }, 'Add anyway')));
  return box;
}

export function openLeadForm(opts) {
  opts = opts || {};
  const editing = opts.lead || null;
  return dialog((root, close) => {
    const f = {};
    const mk = (id, label, extra, tag) => {
      const el = h(tag || 'input', { class: 'input', id: 'lf-' + id, autocomplete: 'off', ...(extra || {}) });
      f[id] = el;
      return h('div', { class: 'field' }, h('label', { for: 'lf-' + id }, label), el);
    };
    const sourceSel = h('select', { class: 'input', id: 'lf-source' }, ...Lib.SOURCES.map((s) => h('option', { value: s.id }, s.label)));
    f.source = sourceSel;
    const tzSel = h('select', { class: 'input', id: 'lf-timezone' }, h('option', { value: '' }, 'Automatic from state'), ...Lib.TZ_CHOICES.map((t) => h('option', { value: t.id }, t.label)));
    f.timezone = tzSel;
    const oddsSel = h('select', { class: 'input', id: 'lf-owner_odds' }, h('option', { value: '' }, 'Not set'), ...ODDS_CHOICES.map(([v, t]) => h('option', { value: v }, t)));
    f.owner_odds = oddsSel;
    const trades = h('datalist', { id: 'dl-trades' }, ...['Plumber', 'Roofer', 'HVAC', 'Electrician', 'Landscaper', 'Painter', 'Pest control', 'Cleaner'].map((t) => h('option', { value: t })));
    const err = h('div', { class: 'err', role: 'alert' });
    const live = h('div');
    const submit = h('button', { class: 'btn', type: 'submit' }, editing ? 'Save changes' : 'Add lead');
    /* the less used fields sit under one fold on a phone (open when editing a lead that already has them) */
    const hasMore = !!editing && ['email', 'website', 'trade', 'owner_odds', 'source_link', 'batch', 'timezone', 'notes'].some((k) => editing[k]);
    const more = responsiveFold(h('details', { class: 'fold more-fields' }, h('summary', null, h('span', null, 'More details'), h('span', { class: 'muted', style: 'text-transform:none;letter-spacing:0;font-weight:400' }, 'Email, website, trade, source, notes')),
      h('div', { class: 'fold-body' },
        h('div', { class: 'grid2' }, mk('email', 'Email', { type: 'email', inputmode: 'email', autocapitalize: 'none', autocorrect: 'off', enterkeyhint: 'next' }), mk('website', 'Website', { type: 'url', inputmode: 'url', autocapitalize: 'none', autocorrect: 'off', enterkeyhint: 'next' })),
        h('div', { class: 'grid2' }, mk('trade', 'Trade', { list: 'dl-trades', autocapitalize: 'words', enterkeyhint: 'next' }), h('div', { class: 'field' }, h('label', { for: 'lf-owner_odds' }, 'Owner odds'), oddsSel)),
        h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', { for: 'lf-source' }, 'Source *'), sourceSel), mk('source_link', 'Source link', { autocapitalize: 'none', autocorrect: 'off', enterkeyhint: 'next' })),
        h('div', { class: 'grid2' }, mk('batch', 'Batch or list name', { enterkeyhint: 'next' }), h('div', { class: 'field' }, h('label', { for: 'lf-timezone' }, 'Time zone'), tzSel)),
        mk('notes', 'Notes', { rows: 3 }, 'textarea'))), hasMore);

    root.append(head(editing ? 'Edit lead' : 'Add lead', close));
    const form = h('form', { class: 'logpanel', novalidate: true },
      mk('business_name', 'Business name *', { required: true, autofocus: true, autocapitalize: 'words', enterkeyhint: 'next' }),
      h('div', { class: 'grid2' }, mk('owner_name', 'Owner name', { autocapitalize: 'words', enterkeyhint: 'next' }), mk('phone', 'Phone', { type: 'tel', inputmode: 'tel', enterkeyhint: 'next' })),
      h('div', { class: 'pair' }, mk('city', 'City', { autocapitalize: 'words', enterkeyhint: 'next' }), mk('state', 'State', { maxlength: 2, placeholder: 'TX', autocapitalize: 'characters', enterkeyhint: 'next' })),
      more,
      trades, live, err,
      h('div', { class: 'dlg-foot' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => close('') }, 'Cancel'), submit));
    root.append(form);

    if (editing) {
      for (const id of FIELD_IDS) f[id].value = editing[id] || '';
      f.source.value = editing.source || 'other';
    } else {
      f.source.value = 'other';
      if (opts.defaults) for (const [k, v] of Object.entries(opts.defaults)) if (f[k]) f[k].value = v;
    }

    const values = () => Object.fromEntries(FIELD_IDS.map((id) => [id, f[id].value]));
    const check = debounce(async () => {
      const v = values();
      if (!v.business_name && !v.phone && !v.website) { live.replaceChildren(); return; }
      try {
        const r = await api('POST', '/api/leads/check', { ...v, exclude_id: editing ? editing.id : undefined });
        const box = dupBox(r.duplicates, r.optouts, null);
        live.replaceChildren(...(box ? [box] : []));
      } catch (e) { /* ignore live check errors */ }
    }, 450);
    for (const id of ['business_name', 'phone', 'website', 'city']) f[id].addEventListener('input', check);
    if (editing) check();

    let force = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (!f.business_name.value.trim()) { f.business_name.classList.add('invalid'); err.textContent = 'Business name is required.'; f.business_name.focus(); return; }
      f.business_name.classList.remove('invalid');
      submit.setAttribute('disabled', '');
      try {
        const body = { ...values(), ...(force ? { force: true } : {}) };
        const res = editing ? await api('PATCH', '/api/leads/' + editing.id, body) : await api('POST', '/api/leads', body);
        toast(editing ? 'Saved' : (res.flagged_optout ? 'Added as opted out' : 'Lead added'));
        close('saved');
        if (opts.onSaved) opts.onSaved(res);
      } catch (ex) {
        if (ex.status === 409 && ex.data && ex.data.duplicates) {
          const box = dupBox(ex.data.duplicates, ex.data.optouts || [], () => { force = true; form.requestSubmit(); });
          live.replaceChildren(...(box ? [box] : []));
          err.textContent = 'Check the possible duplicate above before adding.';
          box && box.scrollIntoView({ block: 'nearest' });
        } else err.textContent = ex.message;
      } finally { submit.removeAttribute('disabled'); }
    });
  }, { noFocus: false });
}

/* ---------------- list page ---------------- */
const q = { q: '', status: '', trade: '', source: '', batch: '', channel: '', opted: '', owner_odds: '', sort: 'recent' };
const PAGE = 50;
const pg = { limit: PAGE };

export async function renderLeads(view) {
  const hashQuery = new URLSearchParams(location.hash.split('?')[1] || '');
  if (hashQuery.get('status') && Lib.STATUSES.includes(hashQuery.get('status'))) q.status = hashQuery.get('status');
  if (hashQuery.get('channel')) q.channel = hashQuery.get('channel');
  const facets = await api('GET', '/api/facets');
  const list = h('div');
  const count = h('span', { class: 'count' });
  const search = h('input', { class: 'input grow', type: 'search', placeholder: 'Search name, owner, phone, email, city', 'aria-label': 'Search leads', value: q.q, enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false' });
  const sel = (key, label, options) => {
    const el = h('select', { class: 'input', 'aria-label': label }, h('option', { value: '' }, label), ...options.map(([v, l]) => h('option', { value: v }, l)));
    el.value = q[key];
    el.addEventListener('change', () => { q[key] = el.value; pg.limit = PAGE; paintBadge(); load(); });
    return el;
  };
  const sort = h('select', { class: 'input', 'aria-label': 'Sort' }, ...[['recent', 'Newest first'], ['name', 'Name A to Z'], ['followup', 'Follow-up soonest'], ['touched', 'Last touched'], ['odds', 'Best odds first']].map(([v, l]) => h('option', { value: v }, l)));
  sort.value = q.sort;
  sort.addEventListener('change', () => { q.sort = sort.value; pg.limit = PAGE; load(); });
  search.addEventListener('input', debounce(() => { q.q = search.value; pg.limit = PAGE; load(); }, 250));
  const badge = h('span', { class: 'pill-count', hidden: true });
  const FILTER_KEYS = ['status', 'trade', 'source', 'batch', 'channel', 'opted', 'owner_odds'];
  const paintBadge = () => { const n = FILTER_KEYS.filter((k) => q[k]).length; badge.textContent = n; badge.hidden = !n; };

  view.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Leads'), h('p', { class: 'sub' }, 'One record per business. Every call, DM and email lives on its timeline.')),
      h('div', { class: 'actions' }, h('a', { class: 'btn ghost', href: '#/import' }, icon('upload', 18), 'Import CSV'), h('button', { class: 'btn', type: 'button', onclick: () => openLeadForm({ onSaved: (r) => { location.hash = '#/lead/' + r.lead.id; } }) }, icon('plus', 18), 'Add lead'))),
    h('div', { class: 'filterbar' }, search,
      responsiveFold(h('details', { class: 'filters' }, h('summary', { class: 'btn ghost' }, icon('leads', 18), 'Filters and sort', badge),
        h('div', { class: 'fgrid' },
          sel('status', 'All statuses', Lib.STATUSES.map((s) => [s, Lib.STATUS_LABEL[s]])),
          sel('trade', 'All trades', facets.trades.map((t) => [t, t])),
          sel('source', 'All sources', Lib.SOURCES.map((s) => [s.id, s.label])),
          sel('batch', 'All batches', facets.batches.map((b) => [b, b])),
          sel('channel', 'Contacted via: any', [...Lib.CHANNELS.map((c) => [c.id, c.label]), ['none', 'Not contacted yet']]),
          sel('owner_odds', 'Owner odds: any', [...ODDS_CHOICES, ['none', 'Not set']]),
          sel('opted', 'Opt-out: any', [['0', 'Not opted out'], ['1', 'Opted out']]), sort)), FILTER_KEYS.some((k) => q[k]))),
    h('div', { class: 'sec-head' }, h('h2', null, 'Results'), count), list);

  async function load() {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) params.set(k, v);
    params.set('limit', String(pg.limit));
    let data;
    try { data = await api('GET', '/api/leads?' + params); } catch (e) { toast(e.message, { error: true }); return; }
    count.textContent = data.total + (data.total > data.rows.length ? ' (showing ' + data.rows.length + ')' : '');
    list.replaceChildren(data.rows.length ? table(data.rows) : h('div', { class: 'empty' }, q.q || q.status || q.trade || q.source || q.batch || q.opted || q.owner_odds ? 'No leads match those filters.' : 'No leads yet. Add one or import a CSV.'),
      data.total > data.rows.length ? h('div', { style: 'padding-top:20px' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => { pg.limit += PAGE; load(); } }, 'Show ' + Math.min(PAGE, data.total - data.rows.length) + ' more')) : '');
  }
  paintBadge();
  await load();
}

function table(rows) {
  const today = myDay();
  return h('div', { class: 'table-wrap' }, h('table', { class: 't cards' },
    h('thead', null, h('tr', null, ...['Business', 'Where', 'Status', 'Follow-up', 'Contacted via'].map((t) => h('th', null, t)))),
    h('tbody', null, ...rows.map((l) => h('tr', { class: 'click', tabindex: '0', onclick: (e) => { if (!e.target.closest('a')) location.hash = '#/lead/' + l.id; }, onkeydown: (e) => { if (e.key === 'Enter') location.hash = '#/lead/' + l.id; } },
      h('td', null, h('a', { href: '#/lead/' + l.id, style: 'font-weight:600' }, l.business_name), l.owner_odds ? [' ', oddsChip(l)] : '', l.opted_out ? [' ', h('span', { class: 'chip optout flat' }, 'Opted out')] : '', l.is_demo ? [' ', h('span', { class: 'chip demo' }, 'Demo')] : '',
        [l.owner_name, l.trade].filter(Boolean).length ? h('div', { class: 'muted small' }, [l.owner_name, l.trade].filter(Boolean).join(' \u00b7 ')) : ''),
      h('td', { 'data-label': 'Where', class: loc(l) || l.tz ? 'where' : 'na' }, loc(l), l.tz ? h('div', { class: 'muted small' }, tzLabel(l.tz)) : ''),
      h('td', null, statusChip(l.status)),
      h('td', { 'data-label': 'Follow-up', class: !l.opted_out && l.next_followup ? '' : 'na' }, l.opted_out ? h('span', { class: 'muted' }, 'None') : l.next_followup ? h('span', { class: l.next_followup < today ? 'err' : '' }, relDay(l.next_followup, today)) : h('span', { class: 'muted' }, 'None')),
      h('td', { 'data-label': 'Contacted via', class: l.channels && l.channels.length ? '' : 'na' }, channelChips(l.channels)))))));
}
