import { h, Lib, icon, api, toast, fmtDay, pct, debounce } from './ui.js';
import { queueRow, closedRow, noTzRow } from './rows.js';

const PAGE = 40;
const ui = { tab: 'queue', period: 'today', day: null };
const hourLabel = (hr) => ((hr % 12) || 12) + (hr < 12 ? ' AM' : ' PM');

function dialsMeter(value, target) {
  const p = target ? Math.min(100, Math.round((value / target) * 100)) : 0;
  return h('div', { class: 'meter', style: 'max-width:520px' },
    h('div', { class: 'top' }, h('span', { class: 'label' }, 'Dials today'), h('span', null, h('span', { class: 'big' }, value), h('span', { class: 'of' }, ' / ' + target))),
    h('div', { class: 'bar' + (value >= target && target > 0 ? ' done' : ''), role: 'progressbar', 'aria-label': 'Dials today', 'aria-valuenow': value, 'aria-valuemin': 0, 'aria-valuemax': target }, h('i', { style: 'width:' + p + '%' })));
}
const tiles = (items) => h('div', { class: 'tiles' }, ...items.map(([n, l, sub]) => h('div', { class: 'tile' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l), sub ? h('div', { class: 'hint', style: 'margin-top:2px' }, sub) : null)));
const COUNTERS = [
  ['calls', 'Calls made', 'phone', 'Every call you logged on a lead counts here by itself.'],
  ['reached', 'Contacts reached', 'phone', 'Someone picked up and spoke to you, a gatekeeper included. A voicemail does not count.'],
  ['owner', 'Owner conversations', 'chat', 'You talked to the owner or the person who decides.'],
  ['good', 'Good conversations', 'check', 'It went well: they asked for info or booked.'],
];

export async function renderCalls(view) {
  const body = h('div');
  const open = new Set();
  let readyLimit = PAGE;
  let data = null;
  view.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Calls'), h('p', { class: 'sub' }, 'Who to call right now, your daily scoreboard, and how your calling is going.'))), body);

  async function load() {
    try { data = await api('GET', '/api/calls?period=' + ui.period + '&ready_limit=' + readyLimit); } catch (e) { toast(e.message, { error: true }); return; }
    draw();
  }

  function tabs() {
    const t = (id, label) => h('button', { type: 'button', 'aria-pressed': String(ui.tab === id), onclick: () => { ui.tab = id; draw(); } }, label);
    return h('div', { class: 'seg', role: 'group', 'aria-label': 'Calls view', style: 'margin-bottom:28px' }, t('queue', 'Call queue'), t('score', 'Scoreboard'), t('stats', 'Stats'));
  }

  /* ---------- call queue ---------- */
  function queueView() {
    const now = new Date();
    const ctx = { open, today: data.today, onLogged: load };
    const q = data.queue;
    const out = [dialsMeter(data.dials_today, data.target)];
    out.push(h('section', { class: 'section' },
      h('div', { class: 'sec-head' }, h('h2', null, 'OK to call now'), h('span', { class: 'count' }, q.ready_total + ' ready')),
      h('p', { class: 'hint', style: 'margin:8px 0 0' }, 'Only leads inside the calling window (' + hourLabel(data.window.start) + ' to ' + hourLabel(data.window.end) + ', their local time). Calls are manual: tap Call, then tap what happened.'),
      q.ready.length ? h('ul', { class: 'ledger' }, ...q.ready.map((l) => queueRow(l, now, data.window, ctx))) : h('div', { class: 'empty' }, q.later_total || q.no_tz_total ? 'No one is in the calling window right now. The next leads open soon, see below.' : 'No leads with a phone number to call. Add leads or import a CSV.'),
      q.ready_total > q.ready.length ? h('div', { style: 'padding-top:20px' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { readyLimit += PAGE; load(); } }, 'Show ' + Math.min(PAGE, q.ready_total - q.ready.length) + ' more')) : null));
    if (q.later_total) {
      out.push(h('details', { class: 'fold section' }, h('summary', null, h('span', null, 'Outside calling hours'), h('span', { class: 'count mono' }, q.later_total)),
        h('div', { class: 'fold-body' }, h('ul', { class: 'ledger' }, ...q.later.map((l) => closedRow(l, now, data.window))))));
    }
    if (q.no_tz_total) {
      out.push(h('details', { class: 'fold section' }, h('summary', null, h('span', null, 'Need a time zone before they can be called'), h('span', { class: 'count mono' }, q.no_tz_total)),
        h('div', { class: 'fold-body' }, h('ul', { class: 'ledger' }, ...q.no_tz.map(noTzRow)))));
    }
    return out;
  }

  /* ---------- scoreboard: day navigator, four counters, verdict, last 7 days ---------- */
  function scoreView() {
    const holder = h('div', { style: 'max-width:760px' });
    let day = null;
    let saveTimer = null;
    const savedEl = h('div', { class: 'hint', 'aria-live': 'polite', style: 'min-height:20px;margin-top:8px' });
    const flash = () => { savedEl.textContent = 'Saved'; clearTimeout(saveTimer); saveTimer = setTimeout(() => { savedEl.textContent = ''; }, 1200); };

    async function loadDay(key) {
      try {
        day = await api('GET', '/api/calls/day' + (key ? '?day=' + key : ''));
        ui.day = day.day;
        const hist = await api('GET', '/api/calls/history');
        drawDay(hist);
      } catch (e) { toast(e.message, { error: true }); }
    }
    async function setCounter(field, value) {
      try { day = await api('PUT', '/api/calls/day', { day: day.day, field, value }); flash(); refreshCounters(); const hist = await api('GET', '/api/calls/history'); drawHistory(hist); } catch (e) { toast(e.message, { error: true }); }
    }
    const inputs = {};
    function refreshCounters() {
      for (const [key] of COUNTERS) if (document.activeElement !== inputs[key]) inputs[key].value = day.totals[key];
      for (const [key] of COUNTERS) { const note = holder.querySelector('[data-note="' + key + '"]'); if (note) note.textContent = day.auto[key] ? day.auto[key] + ' counted from calls you logged on leads' : ''; }
    }
    const histBox = h('div');
    function drawHistory(hist) {
      if (!hist.days.length) { histBox.replaceChildren(); return; }
      const a = hist.averages;
      histBox.replaceChildren(h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', null, 'Last ' + hist.days.length + ' days')),
        h('div', { class: 'tiles' }, ...[[a.calls.toFixed(0), 'avg calls'], [a.reached.toFixed(0), 'avg contacts'], [a.owner.toFixed(1), 'avg owners'], [a.good.toFixed(1), 'avg good convos']].map(([n, l]) => h('div', { class: 'tile' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l)))),
        h('div', { class: 'table-wrap' }, h('table', { class: 't cards' }, h('thead', null, h('tr', null, h('th', null, 'Day'), h('th', { class: 'r' }, 'Calls'), h('th', { class: 'r' }, 'Contacts'), h('th', { class: 'r' }, 'Owners'), h('th', { class: 'r' }, 'Good'))),
          h('tbody', null, ...hist.days.map((d) => h('tr', { class: 'click', onclick: () => loadDay(d.day) }, h('td', null, d.day === day.today ? 'Today' : fmtDay(d.day)), h('td', { class: 'r', 'data-label': 'Calls' }, d.calls), h('td', { class: 'r', 'data-label': 'Contacts' }, d.reached), h('td', { class: 'r', 'data-label': 'Owners' }, d.owner), h('td', { class: 'r', 'data-label': 'Good' }, d.good))))))));
    }
    function drawDay(hist) {
      const prev = h('button', { class: 'iconbtn dnav', type: 'button', 'aria-label': 'Previous day', onclick: () => loadDay(Lib.addDaysKey(day.day, -1)) }, icon('chevL', 22));
      const next = h('button', { class: 'iconbtn dnav', type: 'button', 'aria-label': 'Next day', disabled: day.is_today, onclick: () => loadDay(Lib.addDaysKey(day.day, 1)) }, icon('chevR', 22));
      const label = day.is_today ? 'Today' : fmtDay(day.day);
      const grid = h('div', { class: 'counter-grid' }, ...COUNTERS.map(([key, name, ic, hint]) => {
        const input = h('input', { class: 'stat-value', type: 'number', min: '0', inputmode: 'numeric', id: 'ct-' + key, 'aria-label': name + ' count', value: day.totals[key] });
        inputs[key] = input;
        const onType = debounce(() => setCounter(key, Math.max(0, parseInt(input.value, 10) || 0)), 450);
        input.addEventListener('input', onType);
        input.addEventListener('blur', () => { input.value = day.totals[key]; });
        const step = (delta) => setCounter(key, Math.max(0, day.totals[key] + delta));
        return h('div', { class: 'stat-card' },
          h('div', { class: 'stat-head' }, icon(ic, 18), h('span', null, name)),
          h('div', { class: 'stat-controls' }, h('button', { class: 'step-btn', type: 'button', 'aria-label': 'Decrease ' + name, onclick: () => step(-1) }, '−'), input, h('button', { class: 'step-btn', type: 'button', 'aria-label': 'Increase ' + name, onclick: () => step(1) }, '+')),
          h('div', { class: 'hint', 'data-note': key, style: 'min-height:18px' }, day.auto[key] ? day.auto[key] + ' counted from calls you logged on leads' : ''),
          h('div', { class: 'hint tip' }, hint));
      }));
      const verdict = h('textarea', { class: 'input', id: 'verdict', rows: 5, placeholder: 'How did today go? What worked, what did not, what will you change tomorrow?' }, day.verdict);
      const saveVerdict = debounce(async () => { try { await api('PUT', '/api/calls/day', { day: day.day, verdict: verdict.value }); flash(); } catch (e) { toast(e.message, { error: true }); } }, 600);
      verdict.addEventListener('input', saveVerdict);
      holder.replaceChildren(
        h('div', { class: 'datebar' }, prev, h('div', { class: 'date-label' }, icon('today', 18), h('span', null, label)), next),
        grid,
        h('section', { class: 'section', style: 'margin-top:36px' }, h('div', { class: 'sec-head' }, h('h2', null, 'Verdict of the day')), h('div', { style: 'padding-top:16px' }, verdict, savedEl)),
        histBox);
      drawHistory(hist);
    }
    loadDay(ui.day);
    return [holder];
  }

  /* ---------- stats ---------- */
  function statsView() {
    const t = data.totals;
    const per = (id, label) => h('button', { type: 'button', 'aria-pressed': String(ui.period === id), onclick: () => { ui.period = id; load(); } }, label);
    const out = [
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Period', style: 'margin-bottom:18px' }, per('today', 'Today'), per('week', 'This week'), per('month', 'Last 30 days')),
      tiles([[t.dials, 'Calls made'], [t.reached, 'Contacts reached'], [t.owner, 'Owner conversations'], [t.good, 'Good conversations'], [t.meetings, 'Meetings booked']]),
      tiles([[pct(t.pickup_rate), 'Pick-up rate', 'contacts reached per call'], [pct(t.owner_rate), 'Owner rate', 'owner conversations per call'], [pct(t.booking_rate), 'Booking rate', 'meetings per owner conversation']]),
      h('p', { class: 'hint' }, data.adjusted_days ? 'Includes your + and − changes on ' + data.adjusted_days + (data.adjusted_days === 1 ? ' day' : ' days') + ' on the Scoreboard.' : 'Counted from the calls you logged on leads.'),
    ];
    const omax = Math.max(1, ...data.outcomes.map((o) => o.count));
    out.push(h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', null, 'What happened on your calls'), h('span', { class: 'count' }, 'calls logged on leads')),
      h('div', { class: 'table-wrap' }, h('table', { class: 't' }, h('tbody', null, ...data.outcomes.map((o) => h('tr', null, h('td', null, o.label), h('td', { class: 'r' }, h('span', { class: 'cells-bar', style: 'width:' + Math.round((o.count / omax) * 160) + 'px' }), o.count))))))));
    out.push(h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', null, 'Last 14 days')),
      h('div', { class: 'table-wrap' }, h('table', { class: 't cards' }, h('thead', null, h('tr', null, h('th', null, 'Day'), h('th', { class: 'r' }, 'Calls'), h('th', { class: 'r' }, 'Contacts'), h('th', { class: 'r' }, 'Owners'), h('th', { class: 'r' }, 'Good'), h('th', { class: 'r' }, 'Meetings'))),
        h('tbody', null, ...[...data.daily].reverse().map((d) => h('tr', null, h('td', null, d.day === data.today ? 'Today' : fmtDay(d.day)), h('td', { class: 'r', 'data-label': 'Calls' }, d.dials), h('td', { class: 'r', 'data-label': 'Contacts' }, d.reached), h('td', { class: 'r', 'data-label': 'Owners' }, d.owner), h('td', { class: 'r', 'data-label': 'Good' }, d.good), h('td', { class: 'r', 'data-label': 'Meetings' }, d.meetings))))))));
    out.push(h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', null, 'When people pick up'), h('span', { class: 'count' }, 'their local time, last 30 days')),
      data.by_hour.length ? h('div', { class: 'table-wrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, h('th', null, 'Hour'), h('th', { class: 'r' }, 'Calls'), h('th', { class: 'r' }, 'Reached'), h('th', { class: 'r' }, 'Pick-up rate'))),
        h('tbody', null, ...data.by_hour.filter((x) => x.hour >= 0).map((x) => h('tr', null, h('td', null, hourLabel(x.hour) + ' to ' + hourLabel(x.hour + 1)), h('td', { class: 'r' }, x.dials), h('td', { class: 'r' }, x.reached), h('td', { class: 'r' }, pct(x.rate)))))))
        : h('div', { class: 'empty' }, 'Log some calls on leads and the best hours show up here.'),
      h('p', { class: 'hint', style: 'margin-top:8px' }, 'A few calls per hour is a small sample. Wait for a few dozen before you change your routine.')));
    const sr = data.show_rate;
    out.push(h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', null, 'Booked calls that showed up')),
      h('p', { style: 'padding-top:14px' }, sr.rate == null ? 'No booked calls marked as showed or no-show yet. Mark the result on the lead page.' : sr.shows + ' of ' + (sr.shows + sr.noshows) + ' showed up (' + pct(sr.rate) + ').')));
    return out;
  }

  function draw() {
    body.replaceChildren(tabs(), ...(ui.tab === 'queue' ? queueView() : ui.tab === 'score' ? scoreView() : statsView()));
  }

  await load();
  const timer = setInterval(() => { if (!document.hidden && ui.tab === 'queue' && !body.querySelector('.inline-log') && !document.querySelector('dialog[open]')) load(); }, 30000);
  void toast;
  return () => clearInterval(timer);
}
