/* Shared helpers: used by the server (require) and the browser (window.Lib).
   Pure functions only. No DOM, no network. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Lib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- constants ---------- */
  const CHANNELS = [
    { id: 'call', label: 'Call' },
    { id: 'instagram_dm', label: 'Instagram DM' },
    { id: 'facebook_dm', label: 'Facebook DM' },
    { id: 'facebook_group', label: 'Facebook group' },
    { id: 'email', label: 'Email' },
    { id: 'text', label: 'Text' },
  ];
  const CHANNEL_LABEL = Object.fromEntries(CHANNELS.map((c) => [c.id, c.label]));

  const OUTCOME_LABEL = {
    no_answer: 'No answer', voicemail: 'Voicemail', gatekeeper: 'Gatekeeper',
    spoke_to_owner: 'Spoke to owner', not_interested: 'Not interested',
    send_info: 'Send info', booked: 'Booked', sent: 'Sent', posted: 'Posted',
    replied: 'Replied', bounced: 'Bounced',
  };
  const OUTCOMES = {
    call: ['no_answer', 'voicemail', 'gatekeeper', 'spoke_to_owner', 'not_interested', 'send_info', 'booked'],
    instagram_dm: ['sent', 'replied', 'not_interested', 'booked'],
    facebook_dm: ['sent', 'replied', 'not_interested', 'booked'],
    facebook_group: ['posted', 'replied', 'not_interested', 'booked'],
    email: ['sent', 'replied', 'bounced', 'not_interested', 'booked'],
    text: ['sent', 'replied', 'not_interested', 'booked'],
  };
  // an outcome that means a person on their side engaged with us
  const RESPONSE_OUTCOMES = ['replied', 'spoke_to_owner', 'send_info', 'booked'];

  // a call where a person at the business actually talked to us
  const CONVERSATION_OUTCOMES = ['spoke_to_owner', 'send_info', 'booked', 'not_interested'];
  // someone at the business picked up and spoke (a gatekeeper counts, a voicemail does not)
  const REACHED_OUTCOMES = ['gatekeeper', 'spoke_to_owner', 'send_info', 'booked', 'not_interested'];
  // the call went well: they asked for info or booked
  const GOOD_OUTCOMES = ['send_info', 'booked'];
  // filter groups for follow-ups, by the channel of the last contact
  const CHANNEL_GROUPS = { call: ['call'], dm: ['instagram_dm', 'facebook_dm', 'facebook_group'], email: ['email'], text: ['text'] };
  const STATUSES = ['new', 'follow_up', 'replied', 'call_booked', 'proposal_sent', 'closed', 'not_interested'];
  // the stages shown on the Pipeline board (New and Not interested stay off it)
  const BOARD = ['replied', 'call_booked', 'follow_up', 'proposal_sent', 'closed'];
  const STATUS_LABEL = {
    new: 'New', follow_up: 'Follow up', replied: 'Replied', call_booked: 'Call booked',
    proposal_sent: 'Proposal sent', closed: 'Closed', not_interested: 'Not interested',
  };
  const STATUS_RANK = { new: 0, follow_up: 1, replied: 2, call_booked: 3, proposal_sent: 4, closed: 5 };

  const SOURCES = [
    { id: 'google_maps', label: 'Google Maps' },
    { id: 'facebook_group', label: 'Facebook group' },
    { id: 'instagram', label: 'Instagram' },
    { id: 'referral', label: 'Referral' },
    { id: 'other', label: 'Other' },
  ];
  const SOURCE_LABEL = Object.fromEntries(SOURCES.map((s) => [s.id, s.label]));

  // days until the next follow-up after an outcome (business days). null = none
  const FOLLOWUP_DAYS = {
    no_answer: 2, voicemail: 3, gatekeeper: 1, spoke_to_owner: 3, send_info: 2,
    sent: 3, posted: 3, replied: 1, bounced: null, booked: null, not_interested: null,
  };

  const STATE_TZ = {
    AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago',
    CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York',
    DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu',
    ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis', IA: 'America/Chicago',
    KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
    MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago',
    MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago',
    NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver',
    NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York',
    OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
    SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago',
    UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles',
    WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver',
  };
  const STATE_NAMES = {
    alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
    connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
    hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
    louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
    mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
    'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
    ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
    'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
    virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  };
  const TZ_CHOICES = [
    { id: 'America/New_York', label: 'Eastern' },
    { id: 'America/Chicago', label: 'Central' },
    { id: 'America/Denver', label: 'Mountain' },
    { id: 'America/Phoenix', label: 'Arizona (no DST)' },
    { id: 'America/Los_Angeles', label: 'Pacific' },
    { id: 'America/Anchorage', label: 'Alaska' },
    { id: 'Pacific/Honolulu', label: 'Hawaii' },
  ];

  /* ---------- normalising (used for duplicate detection) ---------- */
  const digits = (s) => String(s == null ? '' : s).replace(/\D+/g, '');
  function normPhone(s) {
    let d = digits(s);
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (d.length > 10) d = d.slice(-10);
    return d.length >= 7 ? d : '';
  }
  function formatPhone(s) {
    const d = normPhone(s);
    if (d.length === 10) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
    return String(s || '');
  }
  function normWebsite(s) {
    let v = String(s || '').trim().toLowerCase();
    if (!v) return '';
    v = v.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '');
    v = v.split(/[/?#]/)[0];
    return v.replace(/\.$/, '');
  }
  function normEmail(s) { return String(s || '').trim().toLowerCase(); }
  function alnum(s) { return String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ''); }
  function normName(s) {
    let v = String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ');
    v = v.split(/\s+/).filter((w) => w && !['llc', 'inc', 'incorporated', 'co', 'corp', 'corporation', 'ltd', 'the'].includes(w)).join('');
    return v;
  }
  function nameCityKey(name, city) {
    const n = normName(name), c = alnum(city);
    return n && c ? n + '|' + c : '';
  }
  function normState(s) {
    const v = String(s || '').trim();
    if (!v) return '';
    if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
    return STATE_NAMES[v.toLowerCase()] || v.toUpperCase().slice(0, 2);
  }
  function tzForLead(lead) {
    if (lead.timezone) return lead.timezone;
    const st = normState(lead.state);
    return STATE_TZ[st] || null;
  }

  /* ---------- time ---------- */
  const dtfCache = {};
  function getDTF(tz) {
    if (!dtfCache[tz]) {
      dtfCache[tz] = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
      });
    }
    return dtfCache[tz];
  }
  function parts(date, tz) {
    const o = {};
    for (const p of getDTF(tz).formatToParts(date)) o[p.type] = p.value;
    return { year: +o.year, month: +o.month, day: +o.day, hour: +o.hour % 24, minute: +o.minute, second: +o.second, weekday: o.weekday };
  }
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  function dayKey(date, tz) {
    const p = parts(date instanceof Date ? date : new Date(date), tz);
    return pad(p.year, 4) + '-' + pad(p.month) + '-' + pad(p.day);
  }
  function tzOffsetMs(utcMs, tz) {
    const p = parts(new Date(utcMs), tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
  }
  // 'YYYY-MM-DDTHH:mm' written in tz -> ISO UTC string
  function zonedToUtc(naive, tz) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(naive || ''));
    if (!m) return null;
    const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    const off = tzOffsetMs(guess, tz);
    let utc = guess - off;
    const off2 = tzOffsetMs(utc, tz);
    if (off2 !== off) utc = guess - off2;
    return new Date(utc).toISOString();
  }
  function utcToZonedInput(iso, tz) {
    const p = parts(new Date(iso), tz);
    return pad(p.year, 4) + '-' + pad(p.month) + '-' + pad(p.day) + 'T' + pad(p.hour) + ':' + pad(p.minute);
  }
  const TZ_NAME = { 'Africa/Johannesburg': 'SAST' };
  function tzAbbr(date, tz) {
    if (TZ_NAME[tz]) return TZ_NAME[tz];
    try {
      const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' });
      const part = f.formatToParts(date).find((p) => p.type === 'timeZoneName');
      return part ? part.value : tz;
    } catch (e) { return tz; }
  }
  function fmtClock(date, tz) {
    const p = parts(date, tz);
    const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
    return h12 + ':' + pad(p.minute) + ' ' + (p.hour < 12 ? 'AM' : 'PM');
  }
  const addDaysKey = (key, n) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]) + n * 86400000;
    const d = new Date(t);
    return pad(d.getUTCFullYear(), 4) + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  };
  const weekdayOfKey = (key) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay(); // 0 Sun
  };
  function addBizDays(key, n) {
    let k = addDaysKey(key, n);
    while (weekdayOfKey(k) === 0 || weekdayOfKey(k) === 6) k = addDaysKey(k, 1);
    return k;
  }
  function mondayOf(key) {
    const wd = weekdayOfKey(key);
    return addDaysKey(key, wd === 0 ? -6 : 1 - wd);
  }
  function daysBetween(a, b) { // b - a in days
    const pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a), pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
    return Math.round((Date.UTC(+pb[1], +pb[2] - 1, +pb[3]) - Date.UTC(+pa[1], +pa[2] - 1, +pa[3])) / 86400000);
  }

  /* Legal calling window: from startHour (inclusive) to endHour (exclusive), lead local time. */
  function okToCall(now, tz, startHour, endHour) {
    startHour = startHour == null ? 8 : startHour;
    endHour = endHour == null ? 21 : endHour;
    if (!tz) return { ok: false, unknown: true, reason: 'Set a time zone' };
    const p = parts(now, tz);
    const mins = p.hour * 60 + p.minute;
    const open = startHour * 60, close = endHour * 60;
    const local = fmtClock(now, tz) + ' ' + tzAbbr(now, tz);
    if (mins >= open && mins < close) {
      return { ok: true, local, hour: p.hour, minsLeft: close - mins, reason: 'OK to call now' };
    }
    const until = mins < open ? open - mins : 24 * 60 - mins + open;
    return { ok: false, local, hour: p.hour, minsUntilOpen: until, reason: 'Opens in ' + fmtDur(until) };
  }
  function fmtDur(mins) {
    const h = Math.floor(mins / 60), m = mins % 60;
    if (h && m) return h + 'h ' + m + 'm';
    if (h) return h + 'h';
    return m + 'm';
  }

  /* ---------- CSV ---------- */
  function detectDelimiter(text) {
    const first = text.replace(/^﻿/, '').split(/\r?\n/)[0] || '';
    let best = ',', bestN = 0;
    for (const d of [',', ';', '\t']) {
      let n = 0, q = false;
      for (const ch of first) { if (ch === '"') q = !q; else if (!q && ch === d) n++; }
      if (n > bestN) { best = d; bestN = n; }
    }
    return best;
  }
  function parseCSV(text, delim) {
    text = String(text || '').replace(/^﻿/, '');
    delim = delim || detectDelimiter(text);
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = ''; rows.push(row); row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
  }
  function toCSV(rows) {
    const esc = (v) => {
      if (v == null) return '';
      const s = String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
  }

  return {
    CHANNELS, CHANNEL_LABEL, OUTCOMES, OUTCOME_LABEL, RESPONSE_OUTCOMES, CONVERSATION_OUTCOMES, REACHED_OUTCOMES, GOOD_OUTCOMES, STATUSES, BOARD, STATUS_LABEL, STATUS_RANK, CHANNEL_GROUPS,
    SOURCES, SOURCE_LABEL, FOLLOWUP_DAYS, STATE_TZ, TZ_CHOICES,
    normPhone, formatPhone, normWebsite, normEmail, normName, nameCityKey, alnum, normState, tzForLead,
    parts, dayKey, zonedToUtc, utcToZonedInput, tzAbbr, fmtClock, addDaysKey, addBizDays, mondayOf, daysBetween,
    weekdayOfKey, okToCall, fmtDur, parseCSV, toCSV, detectDelimiter, pad,
  };
});
