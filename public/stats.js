import { h, Lib, api, toast, fmtDay, relDay, money, pct, loc, myTz, statusChip, responsiveFold } from './ui.js';

/* a section that starts closed on a phone (the long day-by-day tables), open on a wide screen */
const foldSection = (title, ...kids) => responsiveFold(h('details', { class: 'fold section keep' }, h('summary', null, h('span', null, title)), h('div', { class: 'fold-body' }, ...kids)));

function tiles(items) {
  return h('div', { class: 'tiles' }, ...items.map(([n, l]) => h('div', { class: 'tile' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l))));
}
function dataTable(heads, rows, opts) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 't' + (opts && opts.cards ? ' cards' : '') },
    h('thead', null, h('tr', null, ...heads.map(([t, r]) => h('th', { class: r ? 'r' : '' }, t)))),
    h('tbody', null, ...rows.map((cells) => h('tr', null, ...cells.map((c, i) => h('td', { class: heads[i][1] ? 'r' : '', 'data-label': heads[i][0] }, c)))))));
}
const barCell = (v, max, alt) => h('span', null, h('span', { class: 'cells-bar' + (alt ? ' alt' : ''), style: 'width:' + Math.round((v / (max || 1)) * 60) + 'px' }), v);

export async function renderStats(view) {
  let s;
  try { s = await api('GET', '/api/stats?days=14&weeks=8'); } catch (e) { view.append(h('div', { class: 'empty' }, e.message)); return; }
  const dmax = Math.max(1, ...s.daily.map((d) => Math.max(d.calls, d.dms)));
  const wmax = Math.max(1, ...s.weekly.map((d) => Math.max(d.calls, d.dms)));
  const wkLabel = (k) => 'Week of ' + fmtDay(k).replace(/^\w+ /, '');
  view.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Stats'), h('p', { class: 'sub' }, 'Days and weeks follow your time zone (' + myTz().split('/').pop().replace('_', ' ') + '). Weeks start on Monday.'))),
    tiles([[s.totals.leads, 'Leads'], [s.totals.contacted, 'Contacted'], [s.totals.replied, 'Responded'], [s.totals.booked, 'Booked'], [s.totals.closed, 'Closed'],
      [s.show_rate == null ? 'n/a' : pct(s.show_rate), 'Show rate'], [s.overdue_followups, 'Overdue follow-ups']]),
    h('p', { class: 'hint' }, s.definitions.responded + ' ' + s.definitions.replies + ' ' + s.definitions.booked),

    foldSection('Last 14 days',
      dataTable([['Day'], ['Calls', true], ['DMs', true], ['Group', true], ['Email', true], ['Text', true], ['Replies', true], ['Booked', true]],
        [...s.daily].reverse().map((d) => [d.day === s.today ? 'Today' : fmtDay(d.day), barCell(d.calls, dmax), barCell(d.dms, dmax, true), d.groups, d.emails, d.texts, d.replies, d.booked]), { cards: true })),

    foldSection('Last 8 weeks',
      dataTable([['Week'], ['Calls', true], ['DMs', true], ['Group', true], ['Email', true], ['Text', true], ['Replies', true], ['Booked', true]],
        [...s.weekly].reverse().map((d) => [wkLabel(d.week), barCell(d.calls, wmax), barCell(d.dms, wmax, true), d.groups, d.emails, d.texts, d.replies, d.booked]), { cards: true })),

    h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', null, 'By channel')),
      dataTable([['Channel'], ['Attempts', true], ['Leads', true], ['Responded', true], ['Response rate', true], ['Booked', true], ['Booked rate', true]],
        s.byChannel.map((c) => [c.label, c.attempts, c.leads, c.responded, pct(c.response_rate), c.booked, pct(c.booked_rate)]), { cards: true }),
      h('p', { class: 'hint', style: 'margin-top:8px' }, 'Rates are out of the leads you tried on that channel. A small sample moves a lot, so wait for a few dozen attempts before you trust a gap.')),

    foldSection('By source',
      dataTable([['Source'], ['Leads', true], ['Contacted', true], ['Responded', true], ['Response rate', true], ['Booked', true], ['Booked rate', true], ['Closed', true]],
        s.bySource.map((c) => [c.label, c.leads, c.contacted, c.replied, pct(c.response_rate), c.booked, pct(c.booked_rate), c.closed]), { cards: true })),

    h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', null, 'Pipeline right now')),
      dataTable([['Status'], ['Leads', true]], s.funnel.map((f) => [statusChip(f.status), f.count]))));
}

export async function renderPipeline(view) {
  let p;
  try { p = await api('GET', '/api/pipeline'); } catch (e) { view.append(h('div', { class: 'empty' }, e.message)); return; }
  const g = p.goal;
  view.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Pipeline'), h('p', { class: 'sub' }, 'Every lead by stage. Booked calls and deals are set on the lead page.')), h('div', { class: 'actions' }, h('a', { class: 'btn ghost', href: '#/settings' }, 'Edit goal'))),
    h('div', { class: 'goal' },
      h('div', null, h('div', { class: 'label', style: 'text-transform:uppercase;letter-spacing:.08em;font-size:12px;font-weight:600;margin-bottom:8px' }, 'Signed toward goal by ' + fmtDay(g.date)),
        h('div', { class: 'amt' }, money(g.signed), h('small', null, ' of ' + money(g.amount))),
        h('div', { class: 'bar' + (g.pct >= 100 ? ' done' : ''), style: 'margin-top:14px', role: 'progressbar', 'aria-label': 'Goal progress', 'aria-valuenow': g.pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: 'width:' + g.pct + '%' }))),
      h('div', { class: 'goal-stats' },
        h('div', null, h('b', null, money(g.deposits)), 'Deposits collected'), h('div', null, h('b', null, money(g.pipeline)), 'Open deals (' + g.pipeline_count + ')'),
        h('div', null, h('b', null, g.days_left), 'Days left'), h('div', null, h('b', null, money(g.needed_per_day)), 'Needed per day'))),
    h('div', { class: 'board' }, ...p.board.map((st) => {
      const list = p.columns[st];
      return h('div', { class: 'col' }, h('h3', null, h('span', null, Lib.STATUS_LABEL[st]), h('span', { class: 'mono muted' }, p.counts[st])),
        st === 'follow_up' && p.counts[st] ? h('div', { class: 'small', style: 'padding:8px 0 0' }, h('a', { href: '#/followups', class: 'linkbtn' }, 'Open the full follow-up list')) : null,
        ...(list.length ? list.slice(0, 60).map((l) => h('a', { class: 'card', href: '#/lead/' + l.id }, h('div', { class: 'nm' }, l.business_name, l.opted_out ? [' ', h('span', { class: 'chip optout flat' }, 'Opted out')] : ''),
          h('div', { class: 'muted small' }, [l.owner_name, l.trade, loc(l)].filter(Boolean).join(' · ')),
          l.deal_value ? h('div', { class: 'small mono' }, money(l.deal_value)) : '', !l.opted_out && l.next_followup ? h('div', { class: 'small ' + (l.next_followup < p.today ? 'err' : 'muted') }, 'Follow-up: ' + relDay(l.next_followup, p.today)) : '')) : [h('div', { class: 'empty muted small' }, 'None')]),
        p.counts[st] > list.length ? h('div', { class: 'small', style: 'padding-top:10px' }, '+ ' + (p.counts[st] - list.length) + ' more. ', h('a', { href: '#/leads?status=' + st }, 'See them in Leads')) : '');
    })),
    h('p', { class: 'hint', style: 'margin-top:28px' }, 'Not on the board: ', h('a', { href: '#/leads?status=new', class: 'linkbtn' }, p.counts.new + ' new leads'), ' and ', h('a', { href: '#/leads?status=not_interested', class: 'linkbtn' }, p.counts.not_interested + ' not interested'), '.'));
}
void toast;
