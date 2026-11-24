import { h, Lib, icon, api, toast, loc } from './ui.js';

const FIELDS = [
  ['business_name', 'Business name', true, ['business', 'businessname', 'company', 'companyname', 'name', 'title']],
  ['owner_name', 'Owner name', false, ['owner', 'ownername', 'contact', 'contactname', 'fullname']],
  ['phone', 'Phone', false, ['phone', 'phonenumber', 'tel', 'telephone', 'mobile', 'cell']],
  ['email', 'Email', false, ['email', 'emailaddress', 'mail']],
  ['website', 'Website', false, ['website', 'site', 'url', 'web', 'domain']],
  ['city', 'City', false, ['city', 'town']],
  ['state', 'State', false, ['state', 'st', 'region', 'province']],
  ['trade', 'Trade', false, ['trade', 'category', 'type', 'industry', 'service']],
  ['source', 'Source', false, ['source']],
  ['source_link', 'Source link', false, ['sourcelink', 'sourceurl', 'link', 'googlemapsurl', 'mapsurl', 'profile']],
  ['batch', 'Batch or list name', false, ['batch', 'list', 'listname']],
  ['timezone', 'Time zone', false, ['timezone', 'tz']],
  ['notes', 'Notes', false, ['notes', 'note', 'comments', 'comment']],
  ['external_id', 'External ID', false, ['externalid', 'id']],
];
const STATUS_TEXT = { new: 'New', dup: 'Duplicate', dup_in_file: 'Repeat in file', optout: 'Opted out', invalid: 'Invalid' };

export async function renderImport(view) {
  const st = { step: 1, headers: [], rows: [], fileName: '', map: {}, defaults: { source: 'other', source_link: '', batch: '' }, preview: null, mode: 'skip' };
  const body = h('div');
  view.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Import CSV'), h('p', { class: 'sub' }, 'Match your columns, see the duplicates, then import. Nothing is added until you confirm.')), h('a', { class: 'btn ghost', href: '#/leads' }, 'Back to leads')), body);

  const stepBar = () => h('div', { class: 'steps' }, ...['1 Choose file', '2 Match columns', '3 Check duplicates', '4 Done'].map((t, i) => h('span', { class: st.step === i + 1 ? 'on' : '' }, t.slice(0, 1), ' ', h('em', null, t.slice(2)))));

  function guess() {
    const norm = (s) => Lib.alnum(s);
    st.map = {};
    for (const [key, , , names] of FIELDS) {
      const idx = st.headers.findIndex((hd) => names.includes(norm(hd)));
      st.map[key] = idx >= 0 && !Object.values(st.map).includes(String(idx)) ? String(idx) : '';
    }
  }
  function mappedRows() {
    return st.rows.map((r) => {
      const o = {};
      for (const [key] of FIELDS) { const i = st.map[key]; if (i !== '' && i != null) o[key] = r[Number(i)]; }
      return o;
    });
  }

  function stepFile() {
    st.step = 1;
    const file = h('input', { type: 'file', accept: '.csv,.txt,text/csv', id: 'imp-file', class: 'input' });
    const paste = h('textarea', { class: 'input', rows: 6, id: 'imp-paste', placeholder: 'Or paste CSV text here, first row = column names', 'aria-label': 'Paste CSV text', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false' });
    const err = h('div', { class: 'err', role: 'alert' });
    const go = (text, name) => {
      const rows = Lib.parseCSV(text);
      if (rows.length < 2) { err.textContent = 'Found no data rows. The first row must be column names.'; return; }
      st.headers = rows[0].map((x) => String(x).trim());
      st.rows = rows.slice(1);
      st.fileName = name || 'pasted list';
      st.defaults.batch = st.defaults.batch || name.replace(/\.[^.]+$/, '');
      guess(); stepMap();
    };
    file.addEventListener('change', async () => { if (file.files[0]) go(await file.files[0].text(), file.files[0].name); });
    body.replaceChildren(stepBar(), h('div', { style: 'display:grid;gap:16px;max-width:640px' },
      h('div', { class: 'field' }, h('label', { for: 'imp-file' }, 'CSV file'), file), paste,
      h('div', null, h('button', { class: 'btn', type: 'button', onclick: () => { if (!paste.value.trim()) { err.textContent = 'Choose a file or paste some CSV.'; return; } go(paste.value, 'pasted list'); } }, 'Use pasted text')), err,
      h('p', { class: 'hint' }, 'Tip: export your Google Maps list to CSV from your own tool, then bring it here. Leads are never scraped from Google by this app.')));
  }

  function stepMap() {
    st.step = 2;
    const sample = (i) => (i === '' ? '' : String((st.rows[0] || [])[Number(i)] || ''));
    const sels = {};
    const rowsEl = FIELDS.map(([key, label, req]) => {
      const sel = h('select', { class: 'input', id: 'map-' + key, 'aria-label': label }, h('option', { value: '' }, '(skip)'), ...st.headers.map((hd, i) => h('option', { value: String(i) }, hd || 'Column ' + (i + 1))));
      sel.value = st.map[key] ?? '';
      const sm = h('span', { class: 'muted small mono' }, sample(sel.value));
      sel.addEventListener('change', () => { st.map[key] = sel.value; sm.textContent = sample(sel.value); });
      sels[key] = sel;
      return h('div', { class: 'map-row' }, h('label', { for: 'map-' + key }, label + (req ? ' *' : '')), sel, sm);
    });
    const src = h('select', { class: 'input', id: 'imp-src' }, ...Lib.SOURCES.map((s) => h('option', { value: s.id }, s.label)));
    src.value = st.defaults.source;
    const link = h('input', { class: 'input', id: 'imp-link', placeholder: 'Where this list came from (URL or note)', value: st.defaults.source_link });
    const batch = h('input', { class: 'input', id: 'imp-batch', value: st.defaults.batch });
    const err = h('div', { class: 'err', role: 'alert' });
    body.replaceChildren(stepBar(), h('p', { class: 'muted', style: 'margin-bottom:6px' }, st.rows.length + ' rows in ' + st.fileName + '.'),
      h('div', null, ...rowsEl),
      h('div', { style: 'display:grid;gap:14px;max-width:640px;margin-top:22px' },
        h('h3', null, 'Recorded on every imported lead'),
        h('div', { class: 'field' }, h('label', { for: 'imp-src' }, 'Source * (used when the file has no source column)'), src),
        h('div', { class: 'field' }, h('label', { for: 'imp-link' }, 'Source link or note'), link),
        h('div', { class: 'field' }, h('label', { for: 'imp-batch' }, 'Batch name'), batch), err,
        h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: stepFile }, 'Back'),
          h('button', { class: 'btn', type: 'button', onclick: async () => {
            if (st.map.business_name === '' || st.map.business_name == null) { err.textContent = 'Match the Business name column first.'; return; }
            st.defaults = { source: src.value, source_link: link.value, batch: batch.value };
            err.textContent = '';
            try { st.preview = await api('POST', '/api/import/preview', { rows: mappedRows(), defaults: st.defaults }); stepPreview(); } catch (e) { err.textContent = e.message; }
          } }, 'Check duplicates'))));
  }

  function stepPreview() {
    st.step = 3;
    const p = st.preview, c = p.counts;
    const mode = h('select', { class: 'input', id: 'imp-mode', style: 'width:auto' }, h('option', { value: 'skip' }, 'Skip duplicates (safest)'), h('option', { value: 'update' }, 'Fill blank fields on the existing lead'), h('option', { value: 'add' }, 'Add duplicates as new leads anyway'));
    mode.value = st.mode;
    mode.addEventListener('change', () => { st.mode = mode.value; btn.textContent = importLabel(); });
    const importLabel = () => {
      const adding = c.new + (st.mode === 'add' ? c.dup + c.dup_in_file : 0);
      return st.mode === 'update' && c.dup ? 'Import ' + adding + ' new, update ' + c.dup : 'Import ' + adding + ' leads';
    };
    const btn = h('button', { class: 'btn', type: 'button', onclick: async () => {
      btn.setAttribute('disabled', '');
      try { const r = await api('POST', '/api/import/commit', { rows: mappedRows(), defaults: st.defaults, mode: st.mode }); stepDone(r); } catch (e) { toast(e.message, { error: true }); btn.removeAttribute('disabled'); }
    } }, importLabel());
    const shown = p.rows.slice(0, 250);
    body.replaceChildren(stepBar(),
      h('div', { class: 'tiles' }, ...[[c.new, 'New'], [c.dup, 'Duplicates'], [c.dup_in_file, 'Repeats in file'], [c.optout, 'Blocked (opted out)'], [c.invalid, 'Invalid']].map(([n, l]) => h('div', { class: 'tile' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l)))),
      h('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:16px 0' }, h('label', { for: 'imp-mode', class: 'label' }, 'Duplicates:'), mode, btn, h('button', { class: 'btn ghost', type: 'button', onclick: stepMap }, 'Back')),
      h('p', { class: 'hint' }, 'A duplicate is the same phone, the same website, or the same business name in the same city. Businesses that asked to opt out are never imported.'),
      h('div', { class: 'table-wrap', style: 'margin-top:12px' }, h('table', { class: 't wide' },
        h('thead', null, h('tr', null, ...['Row', 'Business', 'Where', 'Phone', 'Result'].map((t) => h('th', null, t)))),
        h('tbody', null, ...shown.map((r) => h('tr', null, h('td', { class: 'mono' }, r.i + 2), h('td', null, r.lead.business_name || h('span', { class: 'muted' }, '(none)')), h('td', null, loc(r.lead)), h('td', { class: 'mono' }, r.lead.phone || ''),
          h('td', null, h('span', { class: 'chip flat ' + (r.status === 'new' ? 'ok' : r.status === 'invalid' || r.status === 'optout' ? 'optout' : 'dup') }, STATUS_TEXT[r.status]),
            r.matches && r.matches[0] ? h('div', { class: 'small muted' }, 'matches ', h('a', { href: '#/lead/' + r.matches[0].id }, r.matches[0].business_name), ' (' + r.matches[0].reasons.join(', ') + ')') : '',
            r.status === 'dup_in_file' ? h('div', { class: 'small muted' }, 'same as row ' + (r.file_dup_of + 2)) : '', r.reason ? h('div', { class: 'small muted' }, r.reason) : ''))))),
        p.rows.length > shown.length ? h('p', { class: 'hint', style: 'padding-top:8px' }, 'Showing the first ' + shown.length + ' of ' + p.rows.length + ' rows.') : ''));
  }

  function stepDone(r) {
    st.step = 4;
    body.replaceChildren(stepBar(), h('div', { style: 'display:grid;gap:14px;max-width:560px' },
      h('h2', null, 'Import finished'),
      h('dl', { class: 'kv' }, h('dt', null, 'Added'), h('dd', null, r.added), h('dt', null, 'Updated'), h('dd', null, r.updated), h('dt', null, 'Skipped (duplicates)'), h('dd', null, r.skipped_duplicates),
        h('dt', null, 'Blocked (opt-out)'), h('dd', null, r.blocked_optout), h('dt', null, 'Invalid rows'), h('dd', null, r.invalid)),
      h('p', { class: 'hint' }, 'Your leads are saved in your database. You can download a copy any time in Settings, Export.'),
      h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/leads' }, 'See the leads'), h('button', { class: 'btn ghost', type: 'button', onclick: () => { st.rows = []; stepFile(); } }, icon('upload', 18), 'Import another file'))));
  }

  stepFile();
}
