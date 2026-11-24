import { h, api, toast } from './ui.js';
import { followupRow } from './rows.js';

const PAGE = 50;
const state = { scope: 'due', channel: '' };

export async function renderFollowups(view) {
  const open = new Set();
  let data = null;
  let limit = PAGE;
  const head = h('div');
  const list = h('div');
  view.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Follow-ups'), h('p', { class: 'sub' }, 'Everyone you need to get back to, oldest first.'))),
    head, list);

  async function load() {
    const params = new URLSearchParams({ scope: state.scope, limit: String(limit) });
    if (state.channel) params.set('channel', state.channel);
    try { data = await api('GET', '/api/followups?' + params); } catch (e) { toast(e.message, { error: true }); return; }
    draw();
  }

  function draw() {
    const c = data.counts;
    const scopeBtn = (id, label) => h('button', { type: 'button', 'aria-pressed': String(state.scope === id), onclick: () => { state.scope = id; limit = PAGE; load(); } }, label);
    const chBtn = (id, label, n) => h('button', { type: 'button', 'aria-pressed': String(state.channel === id), onclick: () => { state.channel = id; limit = PAGE; load(); } }, label, ' ', h('span', { class: 'mono muted' }, n));
    head.replaceChildren(
      h('div', { class: 'seg', role: 'group', 'aria-label': 'When', style: 'margin-bottom:14px' }, scopeBtn('due', 'Due now'), scopeBtn('soon', 'Coming up, next 7 days')),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Channel' }, chBtn('', 'All', c.all), chBtn('call', 'Calls', c.call), chBtn('dm', 'DMs', c.dm), chBtn('email', 'Email', c.email), chBtn('text', 'Text', c.text)));
    const ctx = { open, today: data.today, onLogged: load };
    list.replaceChildren(
      h('div', { class: 'sec-head', style: 'margin-top:28px' }, h('h2', null, state.scope === 'due' ? 'Due now' : 'Coming up'),
        h('span', { class: 'count' }, data.total + (state.scope === 'due' && data.overdue_count ? ' · ' + data.overdue_count + ' overdue' : ''))),
      data.rows.length ? h('ul', { class: 'ledger' }, ...data.rows.map((l) => followupRow(l, ctx))) : h('div', { class: 'empty' }, state.scope === 'due' ? 'Nothing due here.' : 'Nothing coming up in the next 7 days.'),
      data.total > data.rows.length ? h('div', { style: 'padding-top:20px' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => { limit += PAGE; load(); } }, 'Show ' + Math.min(PAGE, data.total - data.rows.length) + ' more')) : null);
  }
  await load();
}
