import { h, Lib, icon, api, toast, fmtDay, fmtDateTime, pct, money, ago, confirmDialog, forgetMailboxes } from './ui.js';

export const CHECKLIST = [
  ['address', 'My postal address is in the footer of every email'],
  ['optout', 'Every email has a line saying how to opt out'],
  ['verify', 'Every email address is verified before I send to it'],
  ['industry', 'Industry is set in Zapwarm'],
  ['test', 'A test email to my own Gmail landed in the inbox'],
  ['score', 'Most mailboxes show a warm-up score of 5 of 5'],
  ['list', 'I know which trade and which states I am emailing first'],
];

const dots = (score, max) => {
  if (score == null) return h('span', { class: 'muted' }, 'No score yet');
  if (max > 10) return h('span', { class: 'scorebar', role: 'img', 'aria-label': 'Warm-up score ' + score + ' of ' + max }, h('span', { class: 'minibar' }, h('i', { style: 'width:' + Math.min(100, Math.round((score / max) * 100)) + '%' })), h('span', { class: 'mono small' }, score + '/' + max));
  return h('span', { class: 'dots', role: 'img', 'aria-label': 'Warm-up score ' + score + ' of ' + max }, ...Array.from({ length: max }, (_, i) => h('i', { class: i < score ? 'on' : '' })), h('span', { class: 'mono small', style: 'margin-left:8px' }, score + '/' + max));
};

/* The Zapmail connection: paste an API key once, then it keeps itself up to date. */
function connectPanel(zs, reload) {
  const err = h('div', { class: 'err', role: 'alert' });
  if (zs.connected) {
    const refresh = h('button', { class: 'btn ghost sm', type: 'button' }, 'Refresh now');
    refresh.addEventListener('click', async () => { refresh.setAttribute('disabled', ''); err.textContent = ''; try { const r = await api('POST', '/api/zapmail/sync'); toast('Updated from Zapmail: ' + r.mailboxes + ' mailboxes'); await reload(); } catch (e) { err.textContent = e.message; refresh.removeAttribute('disabled'); } });
    const off = h('button', { class: 'btn danger sm', type: 'button' }, 'Disconnect');
    off.addEventListener('click', async () => { if (!(await confirmDialog({ title: 'Disconnect Zapmail?', message: 'The saved key is deleted from this tracker. Your Zapmail account is not touched, and the last numbers stay on this page.', confirmLabel: 'Disconnect', danger: true }))) return; await api('DELETE', '/api/zapmail/key'); toast('Disconnected'); await reload(); });
    return h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', null, 'Zapmail connection'), h('span', { class: 'chip flat ok' }, 'Connected')),
      h('p', { style: 'padding-top:14px;max-width:640px' }, 'Connected with the key ending ', h('span', { class: 'mono' }, '\u00b7\u00b7\u00b7\u00b7' + zs.key_hint), '. It refreshes by itself once a day, when you open this page and the numbers are more than 5 minutes old, and every 5 minutes while this page is open. You never have to press Refresh.', zs.last_sync ? ' Last refresh ' + ago(zs.last_sync) + '.' : ''),
      zs.last_error ? h('div', { class: 'banner warn', style: 'margin-top:12px;max-width:640px' }, icon('alert'), h('div', null, zs.last_error)) : null,
      h('div', { class: 'actions', style: 'padding-top:12px' }, refresh, off), err,
      h('p', { class: 'hint', style: 'margin-top:14px;max-width:640px' }, 'This app only ever asks Zapmail for three read-only lists: mailboxes, domains and warm-up scores. It cannot buy, change or delete anything in Zapmail.'));
  }
  const key = h('input', { class: 'input', id: 'zm-key', type: 'password', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go', placeholder: 'Paste your Zapmail API key', style: 'max-width:460px' });
  const go = h('button', { class: 'btn', type: 'button' }, 'Connect');
  go.addEventListener('click', async () => {
    err.textContent = ''; go.setAttribute('disabled', '');
    try { const r = await api('PUT', '/api/zapmail/key', { key: key.value }); key.value = ''; toast('Connected. Read ' + r.mailboxes + ' mailboxes from Zapmail.'); await reload(); } catch (e) { err.textContent = e.message; go.removeAttribute('disabled'); }
  });
  return h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', null, 'Connect Zapmail'), h('span', { class: 'chip flat dup' }, 'Not connected')),
    h('ol', { class: 'steps-list', style: 'padding-top:14px;max-width:660px' },
      h('li', null, 'In Zapmail open ', h('strong', null, 'Developers, then Keys'), ' (some accounts show it under Settings, Integrations, API) and create a key.'),
      h('li', null, 'Copy the key and paste it below. It looks like 1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed.'),
      h('li', null, 'Press Connect. This page fills with live numbers and then refreshes itself.')),
    h('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;align-items:center;padding-top:14px' }, h('label', { for: 'zm-key', class: 'sr-only' }, 'Zapmail API key'), key, go), err,
    h('div', { class: 'banner warn', style: 'margin-top:16px;max-width:660px' }, icon('alert'), h('div', null, h('strong', null, 'Treat the key like a password. '), 'Zapmail keys cannot be limited to read only, so the same key could also buy things in Zapmail. This app only calls three read lists, saves the key encrypted in your database, and never shows it again. If it ever leaks, delete it in Zapmail and make a new one.')),
    h('p', { class: 'hint', style: 'margin-top:12px;max-width:660px' }, 'If Zapmail answers "not enabled", API access is switched off on your account. Ask support@zapmail.ai to enable it. Until then Claude can still fill this page by reading your dashboard: ask "update my Zapmail numbers".'));
}

let lastAutoTry = 0;
let pollTimer = null;

export async function renderEmail(view) {
  let d, zs;
  try { d = await api('GET', '/api/email'); zs = await api('GET', '/api/zapmail/status'); } catch (e) { view.append(h('div', { class: 'empty' }, e.message)); return; }
  const reload = async () => { forgetMailboxes(); view.replaceChildren(); await renderEmail(view); };
  const snap = d.snapshot;
  const body = h('div');
  view.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Email'), h('p', { class: 'sub' }, 'Your Zapmail mailboxes, warm-up, and cold email results.'))), body);

  if (!snap) {
    body.append(h('div', { class: 'banner warn' }, icon('alert'), h('div', null, h('strong', null, 'Zapmail is not connected yet. '), 'Connect it below, or ask Claude: "update my Zapmail numbers".')), connectPanel(zs, reload));
    return;
  }
  const z = snap.zapwarm || {};
  const r = d.readiness;
  const mailboxes = snap.mailboxes || [];
  const warming = mailboxes.filter((m) => /warm/i.test(m.status || '')).length;
  const out = [];

  /* status line */
  const statusTitle = !r ? 'Warm-up status unknown' : r.ready_now ? 'Warm-up window is done. Check the scores, then start small.' : 'Warming up. Day ' + r.day + ' of 21.';
  const statusSub = !r ? '' : r.ready_now ? 'Zapmail says about 21 days for Google mailboxes. Start with a few emails per mailbox and build up.' : 'Earliest safe first send: ' + fmtDay(r.ready_from) + ' (' + r.days_to_ready + ' day' + (r.days_to_ready === 1 ? '' : 's') + ' to go). Safer: ' + fmtDay(r.ready_by) + '.';
  out.push(h('section', { class: 'section', style: 'margin-top:0' },
    h('div', { class: 'meter', style: 'max-width:640px' }, h('div', { class: 'top' }, h('span', { class: 'label' }, 'Warm-up'), h('span', { class: 'mono small muted' }, r ? 'started ' + fmtDay(r.started) : '')),
      h('div', { style: 'font-size:22px;font-weight:600;letter-spacing:-0.01em;margin:6px 0 12px' }, statusTitle),
      r ? h('div', { class: 'bar' + (r.ready_now ? ' done' : ''), role: 'progressbar', 'aria-label': 'Warm-up progress', 'aria-valuenow': r.pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: 'width:' + r.pct + '%' })) : null,
      h('p', { class: 'hint', style: 'margin-top:10px' }, statusSub)),
    h('p', { class: 'hint', style: 'margin-top:18px' }, h('span', { class: 'chip flat ' + (d.stale ? 'dup' : 'ok') }, d.stale ? 'Out of date' : 'Up to date'), ' Last read from Zapmail ' + fmtDateTime(snap.taken_at) + ' (' + ago(snap.taken_at) + '). ',
      d.stale ? (zs.connected ? 'Press Refresh now under Zapmail connection.' : 'Connect Zapmail below, or ask Claude: "update my Zapmail numbers".') : (/API/.test(snap.source || '') ? 'Live from the Zapmail API.' : 'Read from the Zapmail dashboard by Claude.'))));

  /* tiles */
  const noScores = mailboxes.length > 0 && mailboxes.every((m) => m.score == null);
  const score = d.score_now == null ? 'None yet' : d.score_now.toFixed(1) + '/' + (mailboxes[0] ? mailboxes[0].score_max || 5 : 5);
  const trend = d.score_before != null && d.score_now != null ? (d.score_now > d.score_before ? 'up from ' + d.score_before.toFixed(1) : d.score_now < d.score_before ? 'down from ' + d.score_before.toFixed(1) : 'unchanged') : '';
  out.push(h('div', { class: 'tiles' },
    ...[[mailboxes.length, 'Mailboxes'], [warming, 'Warming up'], [score, 'Average score', noScores ? 'Zapmail has not scored them yet' : trend], [z.emails_sent_30d != null ? z.emails_sent_30d : 'n/a', 'Warm-up emails, 30 days'], [z.inbox_rate != null ? pct(z.inbox_rate) : 'n/a', 'Landed in inbox']]
      .map(([n, l, sub]) => h('div', { class: 'tile' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l), sub ? h('div', { class: 'hint' }, sub) : null))));

  /* mailboxes by domain */
  const byDomain = {};
  for (const m of mailboxes) (byDomain[m.domain || (m.email || '').split('@')[1] || 'other'] = byDomain[m.domain || (m.email || '').split('@')[1] || 'other'] || []).push(m);
  const limit = d.per_mailbox_limit;
  out.push(h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', null, 'Mailboxes'), h('span', { class: 'count' }, mailboxes.length)),
    h('div', { class: 'table-wrap' }, h('table', { class: 't cards' },
      h('thead', null, h('tr', null, h('th', null, 'Mailbox'), h('th', null, 'Status'), h('th', null, 'Warm-up score'), h('th', { class: 'r' }, 'Warm-up sent'), h('th', { class: 'r' }, 'Inbox'), h('th', { class: 'r' }, 'Cold sent today'))),
      h('tbody', null, ...Object.entries(byDomain).flatMap(([dom, list]) => [
        h('tr', null, h('td', { colspan: 6, style: 'padding-top:22px;font-weight:600' }, dom, ' ', h('span', { class: 'chip flat ok' }, ((snap.domains || []).find((x) => x.name === dom) || {}).status || 'connected'))),
        ...list.map((m) => h('tr', null,
          h('td', null, m.email, m.admin ? h('span', { class: 'muted small' }, ' (admin)') : '', h('div', { class: 'muted small' }, m.name || '')),
          h('td', { 'data-label': 'Status' }, h('span', { class: 'chip ' + (/warm/i.test(m.status || '') ? 's-follow_up' : 'ok') }, m.status || '')),
          h('td', { 'data-label': 'Score' }, dots(m.score == null ? null : m.score, m.score_max || 5)),
          h('td', { class: 'r', 'data-label': 'Warm-up sent' }, m.sent_30d == null ? '' : m.sent_30d),
          h('td', { class: 'r', 'data-label': 'Inbox' }, m.inbox_rate == null ? '' : pct(m.inbox_rate)),
          h('td', { class: 'r', 'data-label': 'Cold sent today' }, (d.per_mailbox_today[m.email] || 0) + ' / ' + limit)))])))),
    noScores ? h('div', { class: 'banner', style: 'margin-top:12px;max-width:700px' }, icon('alert'), h('div', null, h('strong', null, 'No warm-up score yet. '), 'That is Zapmail, not this page. Warm-up started on ' + fmtDay(r ? r.started : z.started) + ' and Zapmail only gives a score after the first days of warm-up. Until then, the real signs are the Warm-up sent and Inbox columns: every warm-up email so far has landed in the inbox. The score fills in here by itself.')) : null,
    h('p', { class: 'hint', style: 'margin-top:8px' }, 'Warm-up emails go between your mailboxes and Zapmail\'s own network. They are not cold emails and never reach a lead. Cold emails come from the log: pick "Sent from" when you log an email on a lead.')));

  /* sending plan */
  const n = mailboxes.length || 1;
  const start = r ? r.ready_from : null;
  const wk = (i) => (start ? fmtDay(Lib.addDaysKey(start, 7 * i)) : '');
  const planRows = [
    ['Until ' + (start ? fmtDay(start) : 'the warm-up ends'), 'Warm-up only', 0, 0],
    ['Week 1 after that, from ' + wk(0), 'Start small', 3, 5], ['Week 2, from ' + wk(1), 'Build up', 5, 8], ['Week 3, from ' + wk(2), 'Build up', 10, 15], ['Week 4 on, from ' + wk(3), 'Normal volume', 15, 20],
  ];
  const limitInput = h('input', { class: 'input', type: 'number', min: '0', step: '1', id: 'em-limit', value: limit, style: 'width:90px' });
  const saveLimit = h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { try { await api('PUT', '/api/settings', { email_daily_per_mailbox: limitInput.value }); toast('Saved'); await load(); } catch (e) { toast(e.message, { error: true }); } } }, 'Save');
  out.push(h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', null, 'How many to send')),
    h('div', { style: 'display:flex;gap:12px;align-items:end;flex-wrap:wrap;padding:16px 0' }, h('div', { class: 'field' }, h('label', { for: 'em-limit' }, 'Cold emails per mailbox per day (your cap)'), limitInput), saveLimit,
      h('div', { class: 'hint' }, 'That is ' + d.capacity_today + ' a day across ' + mailboxes.length + ' mailboxes. Sent today: ' + d.cold.sent_today + '.')),
    h('div', { class: 'table-wrap' }, h('table', { class: 't cards' }, h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Step'), h('th', { class: 'r' }, 'Per mailbox'), h('th', { class: 'r' }, 'Across all ' + mailboxes.length))),
      h('tbody', null, ...planRows.map(([when, step, lo, hi]) => h('tr', null, h('td', null, when), h('td', { 'data-label': 'Step' }, step), h('td', { class: 'r', 'data-label': 'Per mailbox' }, hi ? lo + ' to ' + hi : '0'), h('td', { class: 'r', 'data-label': 'Across all ' + mailboxes.length }, hi ? lo * n + ' to ' + hi * n : '0')))))),
    h('p', { class: 'hint', style: 'margin-top:8px' }, 'Step up only while bounces stay under about 2% and spam complaints stay at zero. If a step looks bad, hold or go back a step. The ceiling is about 20 to 25 per mailbox a day.')));

  /* cold email results */
  const c = d.cold;
  out.push(h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', null, 'Cold email results'), h('span', { class: 'count' }, 'from emails you log on leads')),
    c.sent_total || c.replied_total ? h('div', { class: 'tiles', style: 'margin-top:14px' }, ...[[c.sent_total, 'Sent', c.sent_7d + ' this week'], [c.replied_total, 'Replies', c.replied_7d + ' this week'], [pct(c.reply_rate), 'Reply rate'], [c.bounced_total, 'Bounced', pct(c.bounce_rate)], [c.booked_total, 'Booked']]
      .map(([nn, l, sub]) => h('div', { class: 'tile' }, h('div', { class: 'n' }, nn), h('div', { class: 'l' }, l), sub ? h('div', { class: 'hint' }, sub) : null)))
      : h('div', { class: 'empty' }, 'No cold emails logged yet. When you send one, log it on the lead (Email, Sent, and the mailbox it came from) and the results build here.'),
    h('p', { class: 'hint', style: 'margin-top:8px' }, 'Replies, bounces and booked calls are logged by hand for now. A later phase can bring them in from your sending tool automatically.')));

  /* checklist */
  const checked = new Set(d.checked);
  const rows = CHECKLIST.map(([id, label]) => {
    const cb = h('input', { type: 'checkbox', id: 'ck-' + id, checked: checked.has(id) });
    cb.addEventListener('change', async () => {
      if (cb.checked) checked.add(id); else checked.delete(id);
      try { await api('PUT', '/api/settings', { email_checklist: JSON.stringify([...checked]) }); } catch (e) { toast(e.message, { error: true }); }
      done.textContent = checked.size + ' of ' + CHECKLIST.length;
    });
    return h('li', null, cb, h('label', { for: 'ck-' + id }, label));
  });
  const done = h('span', { class: 'count' }, checked.size + ' of ' + CHECKLIST.length);
  out.push(h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', null, 'Before the first send'), done), h('ul', { class: 'checklist', style: 'padding-top:12px' }, ...rows)));

  /* account */
  const p = snap.plan || {};
  const kv = (k, v) => [h('dt', null, k), h('dd', null, v)];
  out.push(h('section', { class: 'section' }, h('div', { class: 'sec-head' }, h('h2', null, 'Zapmail account')),
    h('dl', { class: 'kv', style: 'padding-top:14px;max-width:640px' },
      ...kv('Plan', (p.name || 'Starter') + (p.mailboxes_included ? ', ' + p.mailboxes_included + ' mailboxes' : '') + (p.monthly_price ? ', ' + p.monthly_price + ' a month' : '')),
      ...(p.renewal_date ? kv('Renews', fmtDay(p.renewal_date)) : []),
      ...(z.free_trial_ends ? kv('Zapwarm free until', fmtDay(z.free_trial_ends)) : []),
      ...(z.first_charge_date ? kv('Zapwarm first charge', fmtDay(z.first_charge_date) + (z.first_charge_amount != null ? ', ' + money(z.first_charge_amount) + (z.discount ? ' (' + z.discount + ')' : '') : '')) : []),
      ...kv('Warm-up settings', [z.daily_emails != null ? z.daily_emails + ' a day per mailbox' : '', z.slow_warmup ? 'slow ramp' : '', z.weekdays_only ? 'weekdays only' : ''].filter(Boolean).join(', ') || 'unknown'),
      ...kv('Industry', z.industry || h('span', { class: 'err' }, 'Not set in Zapwarm yet')),
      ...kv('Domains', (snap.domains || []).map((x) => x.name + ' (' + (x.status || 'connected') + ')').join(', ') || 'none'))));

  out.push(connectPanel(zs, reload));

  body.replaceChildren(...out);

  /* connected: keep the numbers fresh by themselves. On opening, if they are more than 5 minutes old;
     then every 5 minutes while this page stays open (the timer stops once you leave the page). */
  clearTimeout(pollTimer);
  if (zs.connected) {
    pollTimer = setTimeout(async () => {
      if (!body.isConnected) return;
      try { await api('POST', '/api/zapmail/sync'); } catch (e) { /* the last good numbers stay on screen */ }
      if (body.isConnected) await reload();
    }, 5 * 60000);
    const age = zs.age_minutes == null ? Infinity : zs.age_minutes;
    if (age > 5 && Date.now() - lastAutoTry > 5 * 60000) {
      lastAutoTry = Date.now();
      const note = h('p', { class: 'hint', id: 'zm-refreshing', 'aria-live': 'polite' }, 'Refreshing from Zapmail...');
      body.prepend(note);
      api('POST', '/api/zapmail/sync').then(() => reload()).catch(() => { note.remove(); });
    }
  }

  async function load() { await reload(); }
}
