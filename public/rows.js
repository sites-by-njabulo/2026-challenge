/* Row builders shared by Today, Follow-ups and Calls. */
import { h, Lib, icon, loc, statusChip, relDay, ago, telLink, windowMarker, timesLine, fmtDay, CHANNEL_ICON } from './ui.js';
import { logPanel } from './log.js';

/* Inline "Log" panel that opens under a row. ctx.open is a Set of lead ids with the panel open; ctx.onLogged runs after saving. */
export function inlineLog(l, defaultChannel, ctx) {
  const holder = h('div', { class: 'inline-log' });
  holder.append(logPanel({ id: l.id, opted_out: false, status: l.status, next_followup: l.next_followup }, {
    compact: true, defaultChannel,
    onLogged: () => { ctx.open.delete(l.id); ctx.onLogged(); },
  }));
  holder.append(h('div', { style: 'margin-top:10px' }, h('a', { href: '#/lead/' + l.id, class: 'small' }, 'More options on the lead page')));
  return holder;
}
export function toggleLog(l, li, defaultChannel, ctx) {
  const existing = li.querySelector('.inline-log');
  if (existing) { existing.remove(); ctx.open.delete(l.id); return; }
  ctx.open.add(l.id);
  li.append(inlineLog(l, defaultChannel, ctx));
}

/* One follow-up: who, when it is due, Log and Open. Kept to two short lines. */
export function followupRow(l, ctx) {
  const li = h('li', { class: 'row nolamp' + (l.overdue ? ' overdue' : '') });
  const last = l.last_at ? 'Last: ' + Lib.CHANNEL_LABEL[l.last_channel] + ', ' + Lib.OUTCOME_LABEL[l.last_outcome] + ' · ' + ago(l.last_at) : 'Not contacted yet';
  li.append(
    h('div', { class: 'who' }, h('a', { href: '#/lead/' + l.id }, l.business_name), ' ', statusChip(l.status),
      h('div', { class: 'meta' }, [l.owner_name, loc(l)].filter(Boolean).join(' · ')),
      h('div', { class: 'meta' }, l.last_at ? [icon(CHANNEL_ICON[l.last_channel], 14), ' ' + last] : last)),
    h('div', { class: 'when' }, h('div', { class: 'due' }, relDay(l.next_followup, ctx.today))),
    h('div', { class: 'act' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => toggleLog(l, li, l.last_channel || 'call', ctx) }, 'Log'), h('a', { class: 'btn ghost sm', href: '#/lead/' + l.id }, 'Open')));
  if (ctx.open.has(l.id)) li.append(inlineLog(l, l.last_channel || 'call', ctx));
  return li;
}

/* One call-queue row: the lamp, who, their time and mine, Call and Log call. */
export function queueRow(l, now, win, ctx) {
  const w = Lib.okToCall(now, l.tz, win.start, win.end);
  const li = h('li', { class: 'row' });
  const callBtn = w.ok && l.phone
    ? h('a', { class: 'btn lampbtn sm', href: 'tel:+1' + Lib.normPhone(l.phone), 'aria-label': 'Call ' + l.business_name }, icon('phone', 16), 'Call')
    : h('span', { class: 'btn sm', 'aria-disabled': 'true', title: w.ok ? 'No phone number' : 'Outside calling hours' }, icon('phone', 16), 'Call');
  li.append(
    h('span', { class: 'lamp ' + (w.ok ? 'on' : w.unknown ? 'warn' : '') }),
    h('div', { class: 'who' }, h('a', { href: '#/lead/' + l.id }, l.business_name),
      h('div', { class: 'meta' }, [l.owner_name, l.trade, loc(l)].filter(Boolean).join(' · ')),
      h('div', { class: 'meta' }, telLink(l.phone), l.competitor_checked_date ? ' · competitor checked ' + fmtDay(l.competitor_checked_date) : h('span', { class: 'err', style: 'font-weight:400' }, ' · no competitor check yet'))),
    h('div', { class: 'when' }, windowMarker(w), h('div', null, timesLine(l.tz, now, w))),
    h('div', { class: 'act' }, callBtn, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => toggleLog(l, li, 'call', ctx) }, 'Log call')));
  if (ctx.open.has(l.id)) li.append(inlineLog(l, 'call', ctx));
  return li;
}

export function closedRow(l, now, win) {
  const w = Lib.okToCall(now, l.tz, win.start, win.end);
  return h('li', { class: 'row' }, h('span', { class: 'lamp' }),
    h('div', { class: 'who' }, h('a', { href: '#/lead/' + l.id }, l.business_name), h('div', { class: 'meta' }, [l.trade, loc(l)].filter(Boolean).join(' · '))),
    h('div', { class: 'when' }, windowMarker(w), h('div', null, timesLine(l.tz, now, w))), h('div', { class: 'act' }, h('a', { class: 'btn ghost sm', href: '#/lead/' + l.id }, 'Open')));
}
export function noTzRow(l) {
  return h('li', { class: 'row nolamp' },
    h('div', { class: 'who' }, h('a', { href: '#/lead/' + l.id }, l.business_name), h('div', { class: 'meta' }, 'Add a state or pick a time zone on the lead')),
    h('div', { class: 'when' }, h('span', { class: 'window unknown' }, icon('alert', 16), 'Set a time zone')), h('div', { class: 'act' }, h('a', { class: 'btn ghost sm', href: '#/lead/' + l.id }, 'Fix')));
}
void statusChip;
