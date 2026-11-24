import { h, Lib, icon, api, toast, loc, fmtDateTime, fmtDay, money, myTz, telLink, debounce, autoRefresh } from './ui.js';

/* the lead form and the follow-ups screen are only fetched when you tap for them, so Today opens faster */
const openLeadForm = async (opts) => { (await import('./leads.js')).openLeadForm(opts); };
const openFollowups = async (channel) => { (await import('./followups.js')).openFollowups(channel); };

const PREVIEW = 1;
const OUT_ICON = { call: 'phone', instagram_dm: 'chat', facebook_dm: 'chat', email: 'mail' };

export async function renderToday(view) {
  let data = null;
  const open = new Set();
  const body = h('div');
  const clock = h('span', { class: 'mono' });
  view.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Today'), h('p', { class: 'sub' }, clock)),
      h('div', { class: 'actions' }, h('button', { class: 'btn desk-only', type: 'button', onclick: () => openLeadForm({ onSaved: (r) => { location.hash = '#/lead/' + r.lead.id; } }) }, icon('plus', 18), 'Add lead'))),
    body);

  const tickClock = () => {
    const now = new Date();
    clock.textContent = fmtDay(Lib.dayKey(now, myTz())) + ' · ' + Lib.fmtClock(now, myTz()) + ' ' + Lib.tzAbbr(now, myTz());
  };
  tickClock();
  const clockTimer = setInterval(tickClock, 15000);

  async function load() {
    try { data = await api('GET', '/api/today?follow_limit=' + PREVIEW); } catch (e) { toast(e.message, { error: true }); return; }
    draw();
  }

  /* ---------- reached out today: one total, four counters ---------- */
  const inputs = {};
  let outreach = null;
  const totalEl = h('span', { class: 'big' });
  const targetsEl = h('div', { class: 'hint', style: 'margin-top:16px' });
  const savedEl = h('span', { class: 'hint', 'aria-live': 'polite' });
  let savedTimer = null;
  function paintOutreach(o, progress) {
    outreach = o;
    totalEl.textContent = o.total;
    for (const it of o.items) {
      if (inputs[it.key] && document.activeElement !== inputs[it.key]) inputs[it.key].value = it.total;
      const note = document.querySelector('[data-onote="' + it.key + '"]');
      if (note) note.textContent = it.auto ? it.auto + ' counted from logged contacts' : '';
    }
    if (progress) targetsEl.textContent = 'Calls ' + progress.calls + ' of ' + progress.calls_target + ' · DMs ' + progress.dms + ' of ' + progress.dms_target;
  }
  async function setCounter(key, value) {
    try {
      const o = await api('PUT', '/api/outreach/day', { day: outreach.day, key, value });
      const calls = o.items.find((i) => i.key === 'call').total;
      const dms = o.items.filter((i) => ['instagram_dm', 'facebook_dm'].includes(i.key)).reduce((n, i) => n + i.total, 0);
      paintOutreach(o, { calls, dms, calls_target: data.progress.calls_target, dms_target: data.progress.dms_target });
      savedEl.textContent = 'Saved'; clearTimeout(savedTimer); savedTimer = setTimeout(() => { savedEl.textContent = ''; }, 1200);
    } catch (e) { toast(e.message, { error: true }); }
  }
  function outreachSection() {
    const grid = h('div', { class: 'counter-grid four' }, ...data.outreach.items.map((it) => {
      const input = h('input', { class: 'stat-value', type: 'number', min: '0', inputmode: 'numeric', id: 'oc-' + it.key, 'aria-label': it.label + ' count', value: it.total });
      inputs[it.key] = input;
      input.addEventListener('input', debounce(() => setCounter(it.key, Math.max(0, parseInt(input.value, 10) || 0)), 450));
      input.addEventListener('blur', () => { const cur = outreach.items.find((i) => i.key === it.key); input.value = cur.total; });
      const step = (d) => setCounter(it.key, Math.max(0, outreach.items.find((i) => i.key === it.key).total + d));
      return h('div', { class: 'stat-card' },
        h('div', { class: 'stat-head' }, icon(OUT_ICON[it.key], 18), h('span', null, it.label)),
        h('div', { class: 'stat-controls' }, h('button', { class: 'step-btn', type: 'button', 'aria-label': 'One less ' + it.label, onclick: () => step(-1) }, '−'), input, h('button', { class: 'step-btn', type: 'button', 'aria-label': 'One more ' + it.label, onclick: () => step(1) }, '+')),
        h('div', { class: 'hint', 'data-onote': it.key, style: 'min-height:18px' }, it.auto ? it.auto + ' counted from logged contacts' : ''));
    }));
    const sec = h('section', { class: 'section' },
      h('div', { class: 'sec-head' }, h('h2', null, 'Reached out today'), h('span', null, totalEl, ' ', savedEl)),
      grid, targetsEl,
      h('p', { class: 'hint', style: 'margin-top:6px' }, 'Tap + each time you send one, or log it on the lead and it counts by itself. Facebook DMs are here too.'));
    paintOutreach(data.outreach, data.progress);
    return sec;
  }

  function goalSection() {
    const g = data.goal;
    return h('section', { class: 'section', style: 'margin-top:0' },
      h('div', { class: 'meter' },
        h('div', { class: 'top' }, h('span', { class: 'label' }, 'Made so far, goal by ' + fmtDay(g.date)), h('span', null, h('span', { class: 'big' }, money(g.signed)), h('span', { class: 'of' }, ' / ' + money(g.amount)))),
        h('div', { class: 'bar' + (g.pct >= 100 ? ' done' : ''), role: 'progressbar', 'aria-label': 'Goal progress', 'aria-valuenow': g.pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: 'width:' + Math.max(g.pct, g.signed > 0 ? 1.5 : 0) + '%' })),
        h('div', { class: 'hint', style: 'margin-top:8px' }, g.days_left + ' days left · needs ' + money(g.needed_per_day) + ' a day' + (g.deposits ? ' · ' + money(g.deposits) + ' in deposits' : ''))));
  }

  function bookedRow(b) {
    const hrs = b.hours_away;
    const hint = hrs > 24 ? 'Reminder due: the night before, naming one thing you looked at on their profile' : hrs > 3 ? 'Send the morning-of reminder' : hrs > 0 ? 'Send the 1 hour reminder now' : 'Call time has started';
    const when = new Date(b.call_at);
    return h('li', { class: 'row nolamp' },
      h('div', { class: 'who' }, h('a', { href: '#/lead/' + b.lead_id }, b.business_name), h('div', { class: 'meta' }, [b.owner_name, loc(b)].filter(Boolean).join(' · ')), h('div', { class: 'meta' }, telLink(b.phone))),
      h('div', { class: 'when' }, h('div', { class: 'mono' }, b.tz ? Lib.fmtClock(when, b.tz) + ' ' + Lib.tzAbbr(when, b.tz) + ' · you ' + fmtDateTime(b.call_at) : fmtDateTime(b.call_at)), h('div', { class: 'muted small' }, hint)),
      h('div', { class: 'act' }, h('span', { class: 'chip ' + (hrs <= 3 ? 'dup' : 'flat') }, hrs > 0 ? 'in ' + (hrs < 1 ? Math.round(hrs * 60) + 'm' : Math.round(hrs) + 'h') : 'now'), h('a', { class: 'btn ghost sm', href: '#/lead/' + b.lead_id }, 'Open')));
  }

  /* One count and one button, because a follow-up day can be 30 people, not 3. */
  function followupSummary(d, total) {
    const labels = { dm: 'DMs', email: 'Email', call: 'Calls', text: 'Texts' };
    const by = d.followups_by || {};
    const chips = Object.keys(labels).filter((k) => by[k] > 0).map((k) => h('button', { class: 'btn ghost sm', type: 'button', onclick: () => openFollowups(k) }, labels[k] + ' ', h('span', { class: 'mono' }, by[k])));
    return h('div', { style: 'padding-top:18px' },
      h('div', { style: 'font-size:22px;font-weight:600;letter-spacing:-0.01em' }, total + (total === 1 ? ' person to follow up with' : ' people to follow up with')),
      chips.length ? h('div', { class: 'actions', style: 'padding-top:12px;display:flex;gap:8px;flex-wrap:wrap' }, ...chips) : null,
      h('div', { style: 'padding-top:16px' }, h('button', { class: 'btn', type: 'button', onclick: () => openFollowups('') }, 'Start follow-ups')));
  }

  function draw() {
    const p = data.progress;
    const ctx = { open, today: p.today, onLogged: load };
    const sections = [goalSection(), outreachSection()];

    if (data.booked.length) {
      sections.push(h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', null, 'Booked calls'), h('span', { class: 'count' }, data.booked.length)), h('ul', { class: 'ledger' }, ...data.booked.map(bookedRow))));
    }

    const total = data.followups_total;
    sections.push(h('section', { class: 'section' },
      h('div', { class: 'sec-head' }, h('h2', null, 'Follow up'), h('span', { class: 'count' }, total ? total + ' due' + (data.followups_overdue ? ' · ' + data.followups_overdue + ' overdue' : '') : '')),
      total ? followupSummary(data, total) : h('div', { class: 'empty' }, 'No follow-ups due. Log a contact and its next follow-up date shows up here.')));
    body.replaceChildren(...sections);
  }

  await load();
  const stopRefresh = autoRefresh(load, 60000, () => view.querySelector('.inline-log') || document.querySelector('dialog[open]') || (document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('stat-value')));
  return () => { clearInterval(clockTimer); stopRefresh(); };
}
