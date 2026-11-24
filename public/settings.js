import { h, Lib, icon, api, toast, confirmDialog, state } from './ui.js';

const TZ_OPTIONS = ['Africa/Johannesburg', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'UTC'];

export async function renderSettings(view, ctx) {
  const s = state.settings;
  const fld = (id, label, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, label), el, hint ? h('p', { class: 'hint' }, hint) : null);
  const num = (id, v) => h('input', { class: 'input', id, type: 'number', min: '0', step: '1', value: v });
  const calls = num('s-calls', s.daily_call_target), dms = num('s-dms', s.daily_dm_target);
  const goalAmt = num('s-goal', s.goal_amount);
  const goalDate = h('input', { class: 'input', id: 's-gdate', type: 'date', value: s.goal_date });
  const tz = h('select', { class: 'input', id: 's-tz' }, ...[...new Set([s.my_timezone, ...TZ_OPTIONS])].map((z) => h('option', { value: z }, z.replace(/_/g, ' '))));
  tz.value = s.my_timezone;
  const w0 = num('s-w0', s.call_window_start), w1 = num('s-w1', s.call_window_end);
  const script = h('textarea', { class: 'input', id: 's-script', rows: 12 }, s.call_script);

  async function save(keys, msg) {
    const body = {};
    for (const [k, el] of Object.entries(keys)) body[k] = el.value;
    try { state.settings = await api('PUT', '/api/settings', body); toast(msg || 'Saved'); } catch (e) { toast(e.message, { error: true }); }
  }

  const sec = (title, ...kids) => h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', null, title)), h('div', { style: 'display:grid;gap:14px;padding-top:16px;max-width:620px' }, ...kids));
  view.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Settings'))),
    sec('Daily targets', h('div', { class: 'grid2' }, fld('s-calls', 'Calls per day', calls), fld('s-dms', 'DMs per day (Instagram and Facebook)', dms)),
      h('div', null, h('button', { class: 'btn', type: 'button', onclick: () => save({ daily_call_target: calls, daily_dm_target: dms }, 'Targets saved') }, 'Save targets'))),
    sec('Goal', h('div', { class: 'grid2' }, fld('s-goal', 'Goal amount (USD)', goalAmt, 'Counts deals marked signed.'), fld('s-gdate', 'Goal date', goalDate)),
      h('div', null, h('button', { class: 'btn', type: 'button', onclick: () => save({ goal_amount: goalAmt, goal_date: goalDate }, 'Goal saved') }, 'Save goal'))),
    sec('Time and calling window', fld('s-tz', 'My time zone', tz, 'Days, weeks and "today" use this zone.'),
      h('div', { class: 'grid2' }, fld('s-w0', 'Calling opens (hour, 0 to 23)', w0), fld('s-w1', 'Calling closes (hour, 0 to 23)', w1)),
      h('p', { class: 'hint' }, 'Set to 8 and 21, which is 8 AM to 9 PM in the lead\'s local time. Some states set tighter hours, so check the rules for the states you call and narrow this if needed.'),
      h('div', null, h('button', { class: 'btn', type: 'button', onclick: () => save({ my_timezone: tz, call_window_start: w0, call_window_end: w1 }, 'Saved') }, 'Save'))),
    sec('Call script', fld('s-script', 'Shown next to every lead', script, 'Keep your hook, the question, and what to say if they say no.'),
      h('div', null, h('button', { class: 'btn', type: 'button', onclick: () => save({ call_script: script }, 'Script saved') }, 'Save script'))),
    sec('Export', h('p', { class: 'hint' }, 'Your data lives in your Supabase database. Export anytime.'),
      h('div', { class: 'actions' }, h('a', { class: 'btn', href: '/api/export/all.zip', download: '' }, icon('download', 18), 'Everything (zip of CSVs)'),
        ...['leads', 'contacts', 'deals', 'opt_outs'].map((n) => h('a', { class: 'btn ghost sm', href: '/api/export/' + n + '.csv', download: '' }, n.replace('_', '-') + '.csv')))),
    sec('Backups', h('p', { class: 'hint' }, 'Nothing is saved on a computer any more. Your leads live in your Supabase database, and Supabase keeps its own backups (how many days depends on your Supabase plan, see Project Settings, Database, Backups). The export above is your own copy: download the zip now and then and keep it somewhere safe.'),
      h('div', null, h('a', { class: 'btn ghost', href: '/api/export/all.zip', download: '' }, icon('download', 18), 'Download a copy now'))),
    sec('Password', passwordForm()),
    sec('Demo data', h('p', { class: 'hint' }, 'Demo leads are marked with a Demo tag. Delete them all before you start with real leads.'),
      h('div', null, h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (!(await confirmDialog({ title: 'Delete all demo leads?', message: 'Removes every lead tagged Demo with their timelines and deals. Real leads are not touched.', confirmLabel: 'Delete demo leads', danger: true, typed: 'DELETE DEMO', typedLabel: 'Type DELETE DEMO to confirm' }))) return;
        try { const r = await api('POST', '/api/demo/clear', { confirm: 'DELETE DEMO' }); toast(r.deleted + ' demo leads deleted'); } catch (e) { toast(e.message, { error: true }); }
      } }, 'Delete demo leads'))),
    sec('Session', h('div', null, h('button', { class: 'btn ghost', type: 'button', onclick: () => ctx.logout() }, icon('out', 18), 'Sign out'))));
}

function passwordForm() {
  const o = h('input', { class: 'input', id: 'pw-old', type: 'password', autocomplete: 'current-password' });
  const n = h('input', { class: 'input', id: 'pw-new', type: 'password', autocomplete: 'new-password' });
  const err = h('div', { class: 'err', role: 'alert' });
  return h('form', { style: 'display:grid;gap:14px', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try { await api('POST', '/api/password', { old: o.value, new: n.value }); toast('Password changed'); o.value = ''; n.value = ''; } catch (ex) { err.textContent = ex.message; }
  } }, h('div', { class: 'field' }, h('label', { for: 'pw-old' }, 'Current password'), o), h('div', { class: 'field' }, h('label', { for: 'pw-new' }, 'New password (8 or more characters)'), n), err,
    h('div', null, h('button', { class: 'btn', type: 'submit' }, 'Change password')));
}
void Lib;
