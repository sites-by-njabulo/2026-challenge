import { h, Lib, icon, api, toast, dialog, head, confirmDialog, loc, statusChip, oddsChip, ODDS_CHOICES, relDay, fmtDateTime, fmtDay, money, myTz, telLink, windowMarker, timesLine, tzLabel, state, CHANNEL_ICON, channelChips } from './ui.js';
import { logPanel } from './log.js';
import { openLeadForm } from './leads.js';

const PREP = ['Their Google Business Profile is open', 'Their Maps ranking for the main service is checked', 'Website skimmed', 'Competitor above them noted below', 'One specific thing to mention is written down'];

export async function renderLead(view, id) {
  let data;
  try { data = await api('GET', '/api/leads/' + id); } catch (e) { view.append(h('div', { class: 'empty' }, e.message, ' ', h('a', { href: '#/leads', class: 'linkbtn' }, 'Back to leads'))); return undefined; }
  const root = h('div');
  view.append(root);
  let focusDeal = false;
  let showAll = false;
  const TL_SHOW = 8;
  const timers = [];

  async function reload(opts) {
    try { data = await api('GET', '/api/leads/' + id); } catch (e) { toast(e.message, { error: true }); return; }
    focusDeal = !!(opts && opts.focusDeal);
    draw();
  }
  const patch = async (body, okMsg) => {
    try { data = await api('PATCH', '/api/leads/' + id, body); draw(); if (okMsg) toast(okMsg); } catch (e) { toast(e.message, { error: true }); }
  };

  const viaList = () => Object.entries(data.contacts.reduce((a, c) => { a[c.channel] = (a[c.channel] || 0) + 1; return a; }, {})).map(([channel, count]) => ({ channel, count }));

  function draw() {
    const l = data.lead, now = new Date(), s = state.settings;
    const today = Lib.dayKey(now, myTz());
    const w = l.tz ? Lib.okToCall(now, l.tz, s.call_window_start, s.call_window_end) : null;

    /* header */
    const statusSel = h('select', { class: 'input', style: 'width:auto', 'aria-label': 'Status' }, ...Lib.STATUSES.map((st) => h('option', { value: st }, Lib.STATUS_LABEL[st])));
    statusSel.value = l.status;
    statusSel.addEventListener('change', () => patch({ status: statusSel.value }, 'Status updated'));
    const header = h('div', { class: 'page-head' },
      h('div', null, h('a', { href: '#/leads', class: 'small muted linkbtn' }, 'All leads'), h('h1', { style: 'margin-top:6px' }, l.business_name),
        h('p', { class: 'sub' }, [l.owner_name, l.trade, loc(l)].filter(Boolean).join(' · ') || 'No details yet'),
        h('div', { class: 'actions', style: 'margin-top:10px' }, statusChip(l.status), oddsChip(l), l.opted_out ? h('span', { class: 'chip optout flat' }, 'Opted out') : null, l.is_demo ? h('span', { class: 'chip demo' }, 'Demo lead') : null),
        h('div', { class: 'actions', style: 'margin-top:10px' }, h('span', { class: 'muted small' }, 'Contacted via'), channelChips(viaList())),
        w && !l.opted_out ? h('div', { style: 'margin-top:10px' }, windowMarker(w)) : null),
      h('div', { class: 'actions' },
        l.phone && !l.opted_out ? h('a', { class: 'btn ' + (w && !w.ok ? 'ghost' : 'lampbtn'), href: 'tel:+1' + Lib.normPhone(l.phone), 'aria-label': 'Call ' + l.business_name }, icon('phone', 18), 'Call') : null,
        h('button', { class: 'btn ghost', type: 'button', onclick: () => openLeadForm({ lead: l, onSaved: () => reload() }) }, icon('edit', 18), 'Edit'),
        h('button', { class: 'btn danger', type: 'button', onclick: () => deleteLead() }, icon('trash', 18), 'Delete')));

    const banners = [];
    if (l.opted_out) {
      banners.push(h('div', { class: 'banner danger' }, icon('ban'), h('div', null, h('strong', null, 'Opted out ' + fmtDateTime(l.opt_out_date) + '. '),
        l.opt_out_channel === 'all' ? 'Do not contact on any channel.' : 'Opted out on ' + (Lib.CHANNEL_LABEL[l.opt_out_channel] || l.opt_out_channel) + '. Treat every channel as blocked.',
        ' They are removed from every queue and follow-up list.')));
    }

    /* pipeline row */
    const fuInput = h('input', { class: 'input', type: 'date', value: l.next_followup || '', 'aria-label': 'Next follow-up date', disabled: l.opted_out });
    fuInput.addEventListener('change', () => patch({ next_followup: fuInput.value || null }, 'Follow-up saved'));
    const chip = (label, days) => h('button', { class: 'btn ghost sm', type: 'button', disabled: l.opted_out, onclick: () => patch({ next_followup: days == null ? null : Lib.addBizDays(today, days) }, days == null ? 'Follow-up cleared' : 'Follow-up set') }, label);
    const pipeline = h('section', { class: 'section s-pipeline' }, h('div', { class: 'sec-head' }, h('h2', null, 'Pipeline')),
      h('div', { class: 'grid2', style: 'padding-top:14px' },
        h('div', { class: 'field' }, h('label', null, 'Status'), statusSel),
        h('div', { class: 'field' }, h('label', null, 'Next follow-up'), fuInput)),
      h('div', { class: 'actions', style: 'padding-top:10px' }, chip('Tomorrow', 1), chip('In 3 days', 3), chip('Next week', 7), chip('Clear', null),
        l.next_followup && !l.opted_out ? h('span', { class: 'muted small' }, relDay(l.next_followup, today)) : null));

    /* log + timeline */
    const logSec = h('section', { class: 'section s-log' }, h('div', { class: 'sec-head' }, h('h2', null, 'Log a contact')),
      h('div', { style: 'padding-top:14px' }, logPanel(l, { onLogged: (res, info) => reload({ focusDeal: info && info.outcome === 'booked' }) })));

    const events = [
      ...data.contacts.map((c) => ({ kind: 'c', at: c.at, c })),
      ...data.optouts.flatMap((o) => [{ kind: 'o', at: o.at, o }, ...(o.removed_at ? [{ kind: 'r', at: o.removed_at, o }] : [])]),
    ].sort((a, b) => (a.at < b.at ? 1 : -1));
    const shown = showAll ? events : events.slice(0, TL_SHOW);
    const tl = events.length ? h('ol', { class: 'timeline' }, ...shown.map(eventNode)) : h('div', { class: 'empty' }, 'Nothing logged yet. Tap an outcome above after your first attempt.');
    const timeline = h('section', { class: 'section s-timeline' }, h('div', { class: 'sec-head' }, h('h2', null, 'Timeline'), h('span', { class: 'count' }, data.contacts.length + ' contact' + (data.contacts.length === 1 ? '' : 's'))), h('div', { style: 'padding-top:16px' }, tl,
      events.length > shown.length ? h('button', { class: 'btn ghost', type: 'button', onclick: () => { showAll = true; draw(); } }, 'Show ' + (events.length - shown.length) + ' older') : null));

    /* right column */
    const oddsSel = h('select', { class: 'input', style: 'width:auto', id: 'owner-odds', 'aria-label': 'Owner odds' }, h('option', { value: '' }, 'Not set'), ...ODDS_CHOICES.map(([v, t]) => h('option', { value: v }, t)));
    oddsSel.value = l.owner_odds || '';
    oddsSel.addEventListener('change', () => patch({ owner_odds: oddsSel.value || null }, 'Owner odds saved'));
    const info = h('section', { class: 's-info' }, h('div', { class: 'sec-head' }, h('h2', null, 'Contact')),
      h('dl', { class: 'kv', style: 'padding-top:14px' },
        h('dt', null, 'Phone'), h('dd', null, telLink(l.phone)),
        h('dt', null, 'Owner odds'), h('dd', null, oddsSel, l.owner_odds && l.owner_odds_score != null ? h('div', { class: 'muted small', style: 'padding-top:4px' }, 'Score ' + l.owner_odds_score + ' of 100') : null),
        h('dt', null, 'Email'), h('dd', null, l.email ? h('a', { href: 'mailto:' + l.email }, l.email) : h('span', { class: 'muted' }, 'None')),
        h('dt', null, 'Website'), h('dd', null, l.website ? h('a', { href: /^https?:/.test(l.website) ? l.website : 'https://' + l.website, target: '_blank', rel: 'noopener' }, l.website) : h('span', { class: 'muted' }, 'None')),
        h('dt', null, 'Source'), h('dd', null, Lib.SOURCE_LABEL[l.source] || l.source, l.source_link ? [' · ', h('a', { href: /^https?:/.test(l.source_link) ? l.source_link : 'https://' + l.source_link, target: '_blank', rel: 'noopener' }, 'link')] : ''),
        h('dt', null, 'Batch'), h('dd', null, l.batch || h('span', { class: 'muted' }, 'None')),
        h('dt', null, 'Time zone'), h('dd', null, l.tz ? tzLabel(l.tz) + (l.tz_source === 'state' ? ' (from state)' : '') : h('span', { class: 'err' }, 'Not set. Add a state or choose one in Edit.')),
        h('dt', null, 'Their time'), h('dd', null, w ? h('div', null, windowMarker(w), h('div', { class: 'mt' }, timesLine(l.tz, now, w))) : h('span', { class: 'muted' }, 'Unknown')),
        l.notes ? [h('dt', null, 'Notes'), h('dd', { style: 'white-space:pre-wrap' }, l.notes)] : null,
        l.external_id ? [h('dt', null, 'External ID'), h('dd', { class: 'mono small' }, l.external_id)] : null));

    const compDate = h('input', { class: 'input', type: 'date', value: l.competitor_checked_date || '', 'aria-label': 'Date checked' });
    const compName = h('input', { class: 'input', value: l.competitor_checked || '', placeholder: 'Who ranks above them, and for what search', 'aria-label': 'Competitor checked' });
    const saveComp = () => patch({ competitor_checked: compName.value, competitor_checked_date: compDate.value || null }, 'Saved');
    const helper = h('section', { class: 's-helper' }, h('div', { class: 'sec-head' }, h('h2', null, 'Call helper')),
      h('div', { style: 'display:grid;gap:12px;padding-top:14px' },
        h('div', { class: 'field' }, h('label', null, 'Competitor I checked'), compName),
        h('div', { class: 'field' }, h('label', null, 'Date I checked it'), compDate),
        h('div', { class: 'actions' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { compDate.value = today; saveComp(); } }, 'Verified today'), h('button', { class: 'btn sm', type: 'button', onclick: saveComp }, 'Save')),
        l.competitor_checked_date ? h('p', { class: 'hint' }, 'Checked ' + fmtDay(l.competitor_checked_date) + (l.competitor_checked_date < today ? '. Rankings move, so re-check before you quote it.' : '.')) : h('p', { class: 'err' }, 'Check the claim before you say it on the call.'),
        prepList()));

    const scriptBox = h('div', { class: 'script' }, s.call_script);
    const scriptEdit = h('textarea', { class: 'input', rows: 10, hidden: true }, s.call_script);
    const scriptBtn = h('button', { class: 'btn ghost sm', type: 'button' }, 'Edit script');
    scriptBtn.addEventListener('click', async () => {
      if (scriptEdit.hidden) { scriptEdit.hidden = false; scriptBox.hidden = true; scriptBtn.textContent = 'Save script'; scriptEdit.value = state.settings.call_script; scriptEdit.focus(); }
      else {
        try { state.settings = await api('PUT', '/api/settings', { call_script: scriptEdit.value }); toast('Script saved'); draw(); } catch (e) { toast(e.message, { error: true }); }
      }
    });
    const script = h('section', { class: 's-script' }, h('div', { class: 'sec-head' }, h('h2', null, 'Call script'), scriptBtn), h('div', { style: 'padding-top:14px' }, scriptBox, scriptEdit));

    const dealSec = dealSection(l);
    const optSec = optSection(l);
    const right = h('div', { class: 'sticky' }, script, helper, info, dealSec, optSec);
    const left = h('div', null, pipeline, logSec, timeline);

    root.replaceChildren(header, ...banners, h('div', { class: 'lead-grid' }, left, right));
    if (focusDeal) { const d = root.querySelector('details.deal'); if (d) { d.open = true; d.scrollIntoView({ block: 'center' }); const i = d.querySelector('input[type=datetime-local]'); if (i) i.focus(); } focusDeal = false; }
  }

  function prepList() {
    const key = 'lt.prep.' + id;
    let done = [];
    try { done = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { done = []; }
    return h('details', { class: 'fold' }, h('summary', null, 'Five minutes of prep'),
      h('ul', { class: 'checklist', style: 'padding-top:10px' }, ...PREP.map((p, i) => {
        const cb = h('input', { type: 'checkbox', id: 'prep-' + i, checked: done.includes(i) });
        cb.addEventListener('change', () => {
          const set = new Set(done); if (cb.checked) set.add(i); else set.delete(i); done = [...set];
          try { localStorage.setItem(key, JSON.stringify(done)); } catch (e) { /* ignore */ }
        });
        return h('li', null, cb, h('label', { for: 'prep-' + i }, p));
      })));
  }

  function eventNode(ev) {
    if (ev.kind === 'o') {
      return h('li', { class: 'tl opt' }, h('div', { class: 'head' }, h('strong', null, 'Opted out'), h('span', { class: 'chip flat' }, ev.o.channel === 'all' ? 'All channels' : Lib.CHANNEL_LABEL[ev.o.channel]), h('span', { class: 't' }, fmtDateTime(ev.at))), ev.o.note ? h('div', { class: 'note' }, ev.o.note) : null);
    }
    if (ev.kind === 'r') {
      return h('li', { class: 'tl opt' }, h('div', { class: 'head' }, h('strong', null, 'Opt-out removed'), h('span', { class: 't' }, fmtDateTime(ev.at))), ev.o.removed_note ? h('div', { class: 'note' }, ev.o.removed_note) : null);
    }
    const c = ev.c;
    return h('li', { class: 'tl' + (c.direction === 'in' ? ' in' : '') },
      h('div', { class: 'head' }, icon(CHANNEL_ICON[c.channel], 16), h('strong', null, Lib.CHANNEL_LABEL[c.channel]), h('span', { class: 'chip flat' + (['booked', 'replied', 'spoke_to_owner'].includes(c.outcome) ? ' ok' : '') }, Lib.OUTCOME_LABEL[c.outcome]), h('span', { class: 't' }, fmtDateTime(c.at)),
        h('span', { class: 'tools' }, h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Edit entry', onclick: () => editContact(c) }, icon('edit', 16)), h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Delete entry', onclick: () => delContact(c) }, icon('trash', 16)))),
      c.content ? h('div', { class: 'body' }, c.content) : null, c.mailbox ? h('div', { class: 'note' }, 'Sent from ' + c.mailbox) : null, c.note ? h('div', { class: 'note' }, c.note) : null);
  }

  function editContact(c) {
    dialog((r, close) => {
      const out = h('select', { class: 'input', id: 'ec-out' }, ...Lib.OUTCOMES[c.channel].map((o) => h('option', { value: o }, Lib.OUTCOME_LABEL[o])));
      out.value = c.outcome;
      const at = h('input', { class: 'input', type: 'datetime-local', id: 'ec-at', value: Lib.utcToZonedInput(c.at, myTz()) });
      const content = h('textarea', { class: 'input', id: 'ec-c', rows: 4 }, c.content || '');
      const note = h('input', { class: 'input', id: 'ec-n', value: c.note || '' });
      r.append(head('Edit ' + Lib.CHANNEL_LABEL[c.channel] + ' entry', close),
        h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', { for: 'ec-out' }, 'Outcome'), out), h('div', { class: 'field' }, h('label', { for: 'ec-at' }, 'Time (' + Lib.tzAbbr(new Date(), myTz()) + ')'), at)),
        h('div', { class: 'field' }, h('label', { for: 'ec-c' }, 'What I said or sent'), content), h('div', { class: 'field' }, h('label', { for: 'ec-n' }, 'Note'), note),
        h('div', { class: 'dlg-foot' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => close('') }, 'Cancel'),
          h('button', { class: 'btn', type: 'button', onclick: async () => {
            try { data = await api('PATCH', '/api/contacts/' + c.id, { outcome: out.value, at: Lib.zonedToUtc(at.value, myTz()), content: content.value, note: note.value }); close('ok'); draw(); toast('Entry updated'); } catch (e) { toast(e.message, { error: true }); }
          } }, 'Save')));
    });
  }
  async function delContact(c) {
    if (!(await confirmDialog({ title: 'Delete this entry?', message: 'It will be removed from the timeline and from your stats. The lead status and follow-up date stay as they are.', confirmLabel: 'Delete entry', danger: true }))) return;
    try { data = await api('DELETE', '/api/contacts/' + c.id); draw(); toast('Entry deleted'); } catch (e) { toast(e.message, { error: true }); }
  }
  async function deleteLead() {
    const l = data.lead;
    const typed = l.opted_out ? l.business_name : null;
    const ok = await confirmDialog({ title: 'Delete ' + l.business_name + '?', message: l.opted_out ? 'This lead is opted out. Deleting it removes the lead and its timeline, but the opt-out record is kept so a re-import is still blocked. Type the business name to continue.' : 'This deletes the lead, its timeline and its deal. This cannot be undone.', confirmLabel: 'Delete lead', danger: true, typed, typedLabel: 'Business name' });
    if (!ok) return;
    try { await api('DELETE', '/api/leads/' + id + '?confirm=' + encodeURIComponent(l.opted_out ? l.business_name : '1')); toast('Lead deleted'); location.hash = '#/leads'; } catch (e) { toast(e.message, { error: true }); }
  }

  function dealSection(l) {
    const d = data.deal || {};
    const call = h('input', { class: 'input', type: 'datetime-local', id: 'd-call', value: d.call_at ? Lib.utcToZonedInput(d.call_at, myTz()) : '' });
    const result = h('select', { class: 'input', id: 'd-res' }, ...[['', 'Not set'], ['pending', 'Pending'], ['show', 'Showed up'], ['no_show', 'No-show']].map(([v, t]) => h('option', { value: v }, t)));
    result.value = d.call_result || '';
    const proposal = h('input', { class: 'input', type: 'date', id: 'd-prop', value: d.proposal_sent_date || '' });
    const depDate = h('input', { class: 'input', type: 'date', id: 'd-depd', value: d.deposit_paid_date || '' });
    const depAmt = h('input', { class: 'input', type: 'number', min: '0', step: '1', id: 'd-depa', value: d.deposit_amount == null ? '' : d.deposit_amount, placeholder: 'USD' });
    const signed = h('input', { class: 'input', type: 'date', id: 'd-sign', value: d.signed_date || '' });
    const value = h('input', { class: 'input', type: 'number', min: '0', step: '1', id: 'd-val', value: d.deal_value == null ? '' : d.deal_value, placeholder: 'USD' });
    const f = (label, el, id) => h('div', { class: 'field' }, h('label', { for: id }, label), el);
    const save = h('button', { class: 'btn', type: 'button' }, 'Save deal');
    save.addEventListener('click', async () => {
      try {
        data = await api('PUT', '/api/leads/' + id + '/deal', { call_at_local: call.value || null, call_result: result.value || null, proposal_sent_date: proposal.value || null, deposit_paid_date: depDate.value || null, deposit_amount: depAmt.value, signed_date: signed.value || null, deal_value: value.value });
        draw(); toast('Deal saved');
      } catch (e) { toast(e.message, { error: true }); }
    });
    const summary = d.signed_date ? 'Signed ' + money(d.deal_value) : d.deal_value ? 'Value ' + money(d.deal_value) : d.call_at ? 'Call booked' : 'Not started';
    return h('details', { class: 'fold deal s-deal', open: !!(data.deal) }, h('summary', null, h('span', null, 'Booked call and deal'), h('span', { class: 'muted', style: 'text-transform:none;letter-spacing:0;font-weight:400' }, summary)),
      h('div', { class: 'fold-body' }, f('Booked call (your time, ' + Lib.tzAbbr(new Date(), myTz()) + ')', call, 'd-call'), f('Call result', result, 'd-res'), f('Proposal sent', proposal, 'd-prop'),
        h('div', { class: 'grid2' }, f('Deposit paid on', depDate, 'd-depd'), f('Deposit amount (USD)', depAmt, 'd-depa')),
        h('div', { class: 'grid2' }, f('Client signed on', signed, 'd-sign'), f('Deal value (USD)', value, 'd-val')), save));
  }

  function optSection(l) {
    if (l.opted_out) {
      return h('details', { class: 'fold s-opt' }, h('summary', null, 'Opt-out'),
        h('div', { class: 'fold-body' }, h('p', null, 'Opted out on ' + fmtDateTime(l.opt_out_date) + (l.opt_out_channel === 'all' ? ' (all channels).' : ' via ' + Lib.CHANNEL_LABEL[l.opt_out_channel] + '.')),
          h('p', { class: 'hint' }, 'Removing an opt-out makes this business contactable again. Only do it if they asked to be contacted. The history stays on the timeline.'),
          h('button', { class: 'btn danger', type: 'button', onclick: removeOpt }, 'Remove opt-out')));
    }
    const ch = h('select', { class: 'input', id: 'oo-ch' }, h('option', { value: 'all' }, 'All channels'), ...Lib.CHANNELS.map((c) => h('option', { value: c.id }, 'Asked on: ' + c.label)));
    const note = h('input', { class: 'input', id: 'oo-note', placeholder: 'What they said (optional)' });
    return h('details', { class: 'fold s-opt' }, h('summary', null, 'Opt-out'),
      h('div', { class: 'fold-body' }, h('p', { class: 'hint' }, 'If they ask not to be contacted, mark it here. This blocks every channel at once and removes them from every queue. Source and date are recorded.'),
        h('div', { class: 'field' }, h('label', { for: 'oo-ch' }, 'Channel they said it on'), ch), h('div', { class: 'field' }, h('label', { for: 'oo-note' }, 'Note'), note),
        h('button', { class: 'btn danger', type: 'button', onclick: async () => {
          if (!(await confirmDialog({ title: 'Mark as opted out?', message: l.business_name + ' will be blocked on every channel and removed from all queues.', confirmLabel: 'Mark opted out', danger: true }))) return;
          try { data = await api('POST', '/api/leads/' + id + '/optout', { channel: ch.value, note: note.value }); draw(); toast('Marked as opted out'); } catch (e) { toast(e.message, { error: true }); }
        } }, icon('ban', 18), 'Mark opted out')));
  }
  async function removeOpt() {
    const ok = await confirmDialog({ title: 'Remove this opt-out?', message: 'This business will become contactable again and will return to your queues. Only continue if they asked to hear from you.', confirmLabel: 'Remove opt-out', danger: true, typed: 'REMOVE', typedLabel: 'Type REMOVE to confirm' });
    if (!ok) return;
    try { data = await api('POST', '/api/leads/' + id + '/optout/remove', { confirm: 'REMOVE' }); draw(); toast('Opt-out removed'); } catch (e) { toast(e.message, { error: true }); }
  }

  draw();
  return () => timers.forEach(clearInterval);
}
