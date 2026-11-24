/* Contact logging: channel + outcome buttons. Used on the Today rows and on the lead page. */
import { h, Lib, icon, api, toast, fmtDay, CHANNEL_ICON, myTz, myDay, getMailboxes } from './ui.js';

const POSITIVE = ['booked', 'spoke_to_owner', 'replied', 'send_info'];
const LS_CHANNEL = 'lt.channel';
function lastChannel(def) {
  try { const c = localStorage.getItem(LS_CHANNEL); if (c && Lib.OUTCOMES[c]) return c; } catch (e) { /* ignore */ }
  return def || 'call';
}
function rememberChannel(c) { try { localStorage.setItem(LS_CHANNEL, c); } catch (e) { /* ignore */ } }

function followupDate(choice, customDate) {
  const today = myDay();
  if (choice === 'auto') return undefined;
  if (choice === 'none') return null;
  if (choice === 'date') return customDate || null;
  const n = Number(choice.replace('+', ''));
  return Lib.addBizDays(today, n);
}

/* lead: lead object (needs id, opted_out, status, next_followup). opts: compact, defaultChannel, onLogged(result). */
export function logPanel(lead, opts) {
  opts = opts || {};
  const compact = !!opts.compact;
  const st = { channel: lastChannel(opts.defaultChannel), followup: 'auto' };
  const root = h('div', { class: 'logpanel' });
  if (lead.opted_out) {
    root.append(h('div', { class: 'banner danger' }, icon('ban'), h('div', null, h('strong', null, 'Opted out. '), 'Logging is switched off on every channel for this lead.')));
    return root;
  }

  const seg = h('div', { class: 'seg channels' + (compact ? ' c' : ''), role: 'group', 'aria-label': 'Channel' });
  const outcomes = h('div', { class: 'outcomes', role: 'group', 'aria-label': 'Outcome' });
  const content = h('textarea', { class: 'input', id: 'lg-content-' + lead.id, rows: 3, placeholder: '' });
  const note = h('input', { class: 'input', id: 'lg-note-' + lead.id, placeholder: 'Anything to remember' });
  const when = h('input', { class: 'input', type: 'datetime-local', id: 'lg-at-' + lead.id });
  const fu = h('select', { class: 'input', id: 'lg-fu-' + lead.id, 'aria-label': 'Next follow-up' },
    h('option', { value: 'auto' }, 'Follow-up: automatic'), h('option', { value: '+1' }, 'Tomorrow'), h('option', { value: '+3' }, 'In 3 working days'),
    h('option', { value: '+7' }, 'In 7 working days'), h('option', { value: 'none' }, 'No follow-up'), h('option', { value: 'date' }, 'Pick a date'));
  const mailbox = h('select', { class: 'input', id: 'lg-mb-' + lead.id, 'aria-label': 'Sent from mailbox' }, h('option', { value: '' }, 'Sent from: pick the mailbox'));
  const mailboxField = h('div', { class: 'field', hidden: true }, h('label', { for: mailbox.id }, 'Sent from'), mailbox);
  getMailboxes().then((list) => { if (!list.length) return; for (const m of list) mailbox.append(h('option', { value: m }, m)); drawOutcomes(); try { const last = localStorage.getItem('lt.mailbox'); if (last && list.includes(last)) mailbox.value = last; } catch (e) { /* ignore */ } });
  mailbox.addEventListener('change', () => { try { localStorage.setItem('lt.mailbox', mailbox.value); } catch (e) { /* ignore */ } });
  const fuDate = h('input', { class: 'input', type: 'date', hidden: true, 'aria-label': 'Follow-up date' });
  fu.addEventListener('change', () => { st.followup = fu.value; fuDate.hidden = fu.value !== 'date'; });

  function drawChannels() {
    seg.replaceChildren(...Lib.CHANNELS.map((c) => h('button', { type: 'button', 'aria-pressed': String(st.channel === c.id), onclick: () => { st.channel = c.id; rememberChannel(c.id); drawChannels(); drawOutcomes(); } },
      icon(CHANNEL_ICON[c.id], 18), compact ? c.label.replace(' DM', '').replace('Facebook ', 'FB ') : c.label)));
  }
  let saving = false;
  async function save(outcome, btn) {
    if (saving) return;
    saving = true;
    outcomes.querySelectorAll('button').forEach((b) => b.setAttribute('disabled', ''));
    const prev = { status: lead.status, next_followup: lead.next_followup || null };
    try {
      const body = { channel: st.channel, outcome, content: content.value, note: note.value };
      if (st.channel === 'email' && mailbox.value) body.mailbox = mailbox.value;
      body.at = when.value ? Lib.zonedToUtc(when.value, myTz()) : new Date().toISOString(); // this browser's clock, same one the screens use
      const fd = followupDate(st.followup, fuDate.value);
      if (fd !== undefined) body.followup = fd;
      const res = await api('POST', '/api/leads/' + lead.id + '/contacts', body);
      const label = Lib.OUTCOME_LABEL[outcome];
      const fuText = res.followup ? ' · follow-up ' + fmtDay(res.followup) : '';
      toast('Logged: ' + Lib.CHANNEL_LABEL[st.channel] + ', ' + label + fuText, {
        action: { label: 'Undo', run: async () => {
          try {
            await api('DELETE', '/api/contacts/' + res.contact.id);
            await api('PATCH', '/api/leads/' + lead.id, { status: prev.status, next_followup: prev.next_followup });
            toast('Undone');
            if (opts.onLogged) opts.onLogged(null, { undone: true });
          } catch (e) { toast(e.message, { error: true }); }
        } },
      });
      content.value = ''; note.value = ''; when.value = '';
      if (opts.onLogged) opts.onLogged(res, { outcome });
    } catch (e) {
      toast(e.message, { error: true });
    } finally {
      saving = false;
      outcomes.querySelectorAll('button').forEach((b) => b.removeAttribute('disabled'));
    }
    void btn;
  }
  function drawOutcomes() {
    mailboxField.hidden = st.channel !== 'email' || mailbox.options.length < 2;
    content.placeholder = st.channel === 'call' ? 'What I said (optional)' : st.channel === 'email' ? 'Subject and what I sent (optional)' : 'What I sent (optional)';
    outcomes.replaceChildren(...Lib.OUTCOMES[st.channel].map((o) => h('button', { type: 'button', class: POSITIVE.includes(o) ? 'pos' : '', onclick: (e) => save(o, e.currentTarget) }, Lib.OUTCOME_LABEL[o])));
  }
  drawChannels(); drawOutcomes();

  root.append(h('div', { class: 'field' }, h('span', { class: 'label' }, 'Channel'), seg),
    mailboxField,
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Outcome (tap to save)'), outcomes));
  if (!compact) {
    root.append(h('div', { class: 'field' }, h('label', { for: content.id }, 'What I said or sent'), content),
      h('details', { class: 'fold' }, h('summary', null, 'More options'),
        h('div', { class: 'fold-body' },
          h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', { for: note.id }, 'Note'), note), h('div', { class: 'field' }, h('label', { for: when.id }, 'Time (blank = now)'), when)),
          h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', { for: fu.id }, 'Next follow-up'), fu), h('div', { class: 'field' }, h('span', { class: 'label' }, ' '), fuDate)))));
  } else {
    root.append(h('div', { class: 'grid2' }, h('div', { class: 'field' }, fu), h('div', { class: 'field' }, fuDate)));
  }
  return root;
}
