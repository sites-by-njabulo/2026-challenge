'use strict';
/* Lead Tracker API. One request handler (req, res) that works as a Vercel serverless function and under plain node:http.
   Database: Postgres through src/db.js. Everything that touches it is async.
   Nothing is written to disk: sessions, the password hash, settings and the encrypted Zapmail key all live in tables. */
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const Lib = require('../public/lib.js');
const db = require('./db');
const { ensureSchema } = require('./schema');

/* ---------------- settings ---------------- */
const DEFAULTS = {
  daily_call_target: 50,
  daily_dm_target: 30,
  goal_amount: 20000,
  goal_date: '2026-12-31',
  my_timezone: 'Africa/Johannesburg',
  call_window_start: 8,
  call_window_end: 21,
  email_daily_per_mailbox: 5,
  email_checklist: '[]',
  call_script:
    'CALL SCRIPT (replace this with yours)\n\nOpening:\n\nHook (needs the verified competitor claim on this lead):\n\nQuestion:\n\nIf they say no:\n\nBooking line:',
};
const NUMERIC = ['daily_call_target', 'daily_dm_target', 'goal_amount', 'call_window_start', 'call_window_end', 'email_daily_per_mailbox'];
async function getSettings() {
  const c = db.cache();
  if (c && c.settings) return { ...c.settings };
  const out = { ...DEFAULTS };
  for (const r of await db.all("SELECT key, value FROM settings WHERE key NOT IN ('password_hash')")) {
    if (!(r.key in DEFAULTS)) continue;
    out[r.key] = NUMERIC.includes(r.key) ? Number(r.value) : r.value;
  }
  if (c) c.settings = out;
  return { ...out };
}
async function setSetting(key, value) {
  await db.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  const c = db.cache();
  if (c) c.settings = null;
}
const rawSetting = async (k) => { const r = await db.get('SELECT value FROM settings WHERE key = ?', k); return r ? r.value : null; };

/* ---------------- helpers ---------------- */
class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const bad = (m, extra) => new HttpError(400, m, extra);
const nowIso = () => new Date().toISOString();
const clean = (v) => { if (v == null) return null; v = String(v).trim(); return v === '' ? null : v; };
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const tx = (fn) => db.tx(fn);
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

const TEXT_FIELDS = ['business_name', 'owner_name', 'phone', 'email', 'website', 'city', 'state', 'trade', 'source', 'source_link', 'batch', 'timezone', 'notes', 'competitor_checked', 'external_id'];
const LEAD_COLS = [...TEXT_FIELDS, 'phone_norm', 'email_norm', 'website_norm', 'name_city_key', 'status', 'next_followup', 'competitor_checked_date',
  'opted_out', 'opt_out_date', 'opt_out_channel', 'is_demo', 'created_at', 'updated_at'];

function sourceId(v) {
  const k = Lib.alnum(v);
  if (!k) return null;
  for (const s of Lib.SOURCES) if (Lib.alnum(s.id) === k || Lib.alnum(s.label) === k) return s.id;
  return null;
}

/* Take loose input, return a clean, normalised lead object (only keys present in `input` for updates). */
function normaliseLead(input, base) {
  const f = { ...(base || {}) };
  for (const k of TEXT_FIELDS) if (k in input) f[k] = clean(input[k]);
  if ('state' in input && f.state) f.state = Lib.normState(f.state);
  if ('source' in input) f.source = sourceId(f.source) || (f.source ? 'other' : null);
  if ('status' in input && input.status) {
    if (!Lib.STATUSES.includes(input.status)) throw bad('Unknown status: ' + input.status);
    f.status = input.status;
  }
  if ('next_followup' in input) {
    if (input.next_followup && !isDate(input.next_followup)) throw bad('Follow-up must be a date (YYYY-MM-DD).');
    f.next_followup = input.next_followup || null;
  }
  if ('competitor_checked_date' in input) {
    if (input.competitor_checked_date && !isDate(input.competitor_checked_date)) throw bad('Competitor check date must be a date.');
    f.competitor_checked_date = input.competitor_checked_date || null;
  }
  if ('timezone' in input && f.timezone) {
    try { Lib.parts(new Date(), f.timezone); } catch (e) { throw bad('Unknown time zone: ' + f.timezone); }
  }
  if ('is_demo' in input) f.is_demo = input.is_demo ? 1 : 0;
  f.phone_norm = Lib.normPhone(f.phone) || null;
  f.email_norm = Lib.normEmail(f.email) || null;
  f.website_norm = Lib.normWebsite(f.website) || null;
  f.name_city_key = Lib.nameCityKey(f.business_name, f.city) || null;
  return f;
}

function leadView(r) {
  if (!r) return null;
  const tz = Lib.tzForLead(r);
  const channels = r.channels ? String(r.channels).split(',').map((x) => { const [channel, n] = x.split(':'); return { channel, count: Number(n) }; }) : [];
  return { ...r, channels, opted_out: !!r.opted_out, is_demo: !!r.is_demo, tz, tz_source: r.timezone ? 'set' : tz ? 'state' : null };
}
const getLeadRow = (id) => db.get('SELECT * FROM leads WHERE id = ?', id);

/* ---- duplicate checks. They work on a whole list of leads at once (3 queries, not 3 per lead), because the database is a network away. ---- */
const DUP_COLS = 'id, business_name, owner_name, city, state, phone, website, status, opted_out, phone_norm, website_norm, name_city_key';
async function loadDupIndex(list) {
  const uniq = (k) => [...new Set(list.map((f) => f[k]).filter(Boolean))];
  const phones = uniq('phone_norm'), sites = uniq('website_norm'), keys = uniq('name_city_key');
  const idx = { phone: new Map(), site: new Map(), key: new Map() };
  if (!phones.length && !sites.length && !keys.length) return idx;
  const rows = await db.all(`SELECT ${DUP_COLS} FROM leads WHERE phone_norm = ANY(?::text[]) OR website_norm = ANY(?::text[]) OR name_city_key = ANY(?::text[]) ORDER BY id`, phones, sites, keys);
  const put = (m, k, r) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(r); };
  for (const r of rows) { put(idx.phone, r.phone_norm, r); put(idx.site, r.website_norm, r); put(idx.key, r.name_city_key, r); }
  return idx;
}
function dupsFromIndex(f, idx, excludeId) {
  const found = new Map();
  const add = (rows, reason) => {
    for (const r0 of rows) {
      if (excludeId && r0.id === excludeId) continue;
      const r = { id: r0.id, business_name: r0.business_name, owner_name: r0.owner_name, city: r0.city, state: r0.state, phone: r0.phone, website: r0.website, status: r0.status, opted_out: r0.opted_out };
      const e = found.get(r.id) || { lead: r, reasons: [] };
      if (!e.reasons.includes(reason)) e.reasons.push(reason);
      found.set(r.id, e);
    }
  };
  if (f.phone_norm) add(idx.phone.get(f.phone_norm) || [], 'same phone');
  if (f.website_norm) add(idx.site.get(f.website_norm) || [], 'same website');
  if (f.name_city_key) add(idx.key.get(f.name_city_key) || [], 'same name and city');
  return [...found.values()].map((e) => ({ ...e, lead: { ...e.lead, opted_out: !!e.lead.opted_out } }));
}
async function findDuplicates(f, excludeId) { return dupsFromIndex(f, await loadDupIndex([f]), excludeId); }

async function loadOptOutRows(list) {
  const uniq = (k) => [...new Set(list.map((f) => f[k]).filter(Boolean))];
  const a = uniq('phone_norm'), b = uniq('email_norm'), c = uniq('website_norm'), d = uniq('name_city_key');
  if (!a.length && !b.length && !c.length && !d.length) return [];
  return db.all(`SELECT id, lead_id, business_name, "at", channel, phone_norm, email_norm, website_norm, name_city_key FROM opt_outs
    WHERE removed_at IS NULL AND (phone_norm = ANY(?::text[]) OR email_norm = ANY(?::text[]) OR website_norm = ANY(?::text[]) OR name_city_key = ANY(?::text[])) ORDER BY id`, a, b, c, d);
}
function optOutsFor(f, rows) {
  return rows.filter((o) => (f.phone_norm && o.phone_norm === f.phone_norm) || (f.email_norm && o.email_norm === f.email_norm)
    || (f.website_norm && o.website_norm === f.website_norm) || (f.name_city_key && o.name_city_key === f.name_city_key))
    .map((o) => ({ id: o.id, lead_id: o.lead_id, business_name: o.business_name, at: o.at, channel: o.channel }));
}
async function findOptOutMatches(f) { return optOutsFor(f, await loadOptOutRows([f])); }

/* Insert one or many leads, in order, and return the new ids. Many go in as a few big statements. */
async function insertLeads(list) {
  const t = nowIso();
  const rows = list.map((f) => {
    const row = { status: 'new', source: 'other', opted_out: 0, is_demo: 0, ...f, created_at: f.created_at || t, updated_at: t };
    if (!row.business_name) throw bad('Business name is required.');
    return row;
  });
  const ids = [];
  const CHUNK = 250;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const marks = part.map(() => '(' + LEAD_COLS.map(() => '?').join(',') + ')').join(',');
    const args = [];
    for (const row of part) for (const c of LEAD_COLS) args.push(row[c] === undefined ? null : row[c]);
    const res = await db.run(`INSERT INTO leads(${LEAD_COLS.join(',')}) VALUES ${marks} RETURNING id`, ...args);
    for (const r of res.rows) ids.push(Number(r.id));
  }
  return ids;
}
const insertLead = async (f) => (await insertLeads([f]))[0];
async function writeLead(id, f) {
  const row = { ...f, updated_at: nowIso() };
  const cols = LEAD_COLS.filter((c) => c !== 'created_at');
  await db.run(`UPDATE leads SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = ?`, ...cols.map((c) => (row[c] === undefined ? null : row[c])), id);
}

/* ---------------- status + follow-up rules ---------------- */
function nextStatus(cur, outcome) {
  if (cur === 'closed') return cur;
  if (outcome === 'not_interested') return 'not_interested';
  const target = outcome === 'booked' ? 'call_booked'
    : ['replied', 'spoke_to_owner', 'send_info'].includes(outcome) ? 'replied' : 'follow_up';
  if (cur === 'not_interested') return ['replied', 'call_booked'].includes(target) ? target : cur;
  return Lib.STATUS_RANK[target] > Lib.STATUS_RANK[cur] ? target : cur;
}
const todayKey = async (now) => Lib.dayKey(now || new Date(), (await getSettings()).my_timezone);

async function addContact(leadId, b, now) {
  const lead = await getLeadRow(leadId);
  if (!lead) throw new HttpError(404, 'Lead not found');
  if (lead.opted_out) throw new HttpError(409, 'This lead is opted out. No contact can be logged.');
  if (!Lib.OUTCOMES[b.channel]) throw bad('Unknown channel.');
  if (!Lib.OUTCOMES[b.channel].includes(b.outcome)) throw bad('Outcome "' + b.outcome + '" is not valid for ' + b.channel + '.');
  let at = nowIso();
  if (b.at) { const d = new Date(b.at); if (isNaN(d)) throw bad('Bad date/time.'); at = d.toISOString(); }
  const status = nextStatus(lead.status, b.outcome);
  let followup;
  if (b.followup !== undefined) {
    if (b.followup && !isDate(b.followup)) throw bad('Follow-up must be a date.');
    followup = b.followup || null;
  } else {
    const days = Lib.FOLLOWUP_DAYS[b.outcome];
    followup = days == null || ['closed', 'not_interested', 'call_booked', 'proposal_sent'].includes(status) && days == null
      ? null : Lib.addBizDays(await todayKey(now), days);
  }
  if (status === 'closed' || status === 'not_interested') followup = null;
  const direction = ['replied'].includes(b.outcome) ? 'in' : 'out';
  return tx(async () => {
    const res = await db.run('INSERT INTO contacts(lead_id, channel, outcome, direction, content, note, "at", external_id, mailbox, created_at) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id',
      leadId, b.channel, b.outcome, direction, clean(b.content), clean(b.note), at, clean(b.external_id), b.channel === 'email' ? clean(b.mailbox) : null, nowIso());
    await db.run('UPDATE leads SET status = ?, next_followup = ?, updated_at = ? WHERE id = ?', status, followup, nowIso(), leadId);
    const contact = await db.get('SELECT * FROM contacts WHERE id = ?', Number(res.rows[0].id));
    return { contact, lead: leadView(await getLeadRow(leadId)), followup };
  });
}

/* ---------------- listing + detail ---------------- */
const LEAD_LIST_SQL = `SELECT l.*,
  (SELECT "at" FROM contacts c WHERE c.lead_id = l.id ORDER BY "at" DESC, c.id DESC LIMIT 1) AS last_at,
  (SELECT channel FROM contacts c WHERE c.lead_id = l.id ORDER BY "at" DESC, c.id DESC LIMIT 1) AS last_channel,
  (SELECT outcome FROM contacts c WHERE c.lead_id = l.id ORDER BY "at" DESC, c.id DESC LIMIT 1) AS last_outcome,
  (SELECT COUNT(*) FROM contacts c WHERE c.lead_id = l.id) AS contact_count,
  (SELECT string_agg(g.channel || ':' || g.n, ',' ORDER BY g.channel) FROM (SELECT channel, COUNT(*) AS n FROM contacts c2 WHERE c2.lead_id = l.id GROUP BY channel) g) AS channels
  FROM leads l`;

async function listLeads(q) {
  const where = [], args = [];
  if (q.q) {
    const like = '%' + String(q.q).toLowerCase() + '%';
    const dig = Lib.normPhone(q.q) || String(q.q).replace(/\D/g, '');
    const parts = ['lower(l.business_name) LIKE ?', 'lower(l.owner_name) LIKE ?', 'lower(l.email) LIKE ?', 'lower(l.website) LIKE ?', 'lower(l.city) LIKE ?'];
    args.push(like, like, like, like, like);
    if (dig.length >= 3) { parts.push('l.phone_norm LIKE ?'); args.push('%' + dig + '%'); }
    where.push('(' + parts.join(' OR ') + ')');
  }
  for (const k of ['status', 'trade', 'source', 'batch', 'state']) if (q[k]) { where.push(`l.${k} = ?`); args.push(q[k]); }
  if (q.channel === 'none') where.push('NOT EXISTS (SELECT 1 FROM contacts cc WHERE cc.lead_id = l.id)');
  else if (q.channel) { where.push('EXISTS (SELECT 1 FROM contacts cc WHERE cc.lead_id = l.id AND cc.channel = ?)'); args.push(q.channel); }
  if (q.opted === '1') where.push('l.opted_out = 1');
  if (q.opted === '0') where.push('l.opted_out = 0');
  if (q.demo === '1') where.push('l.is_demo = 1');
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = (await db.get('SELECT COUNT(*) AS n FROM leads l' + w, ...args)).n;
  const sort = {
    name: 'lower(l.business_name) ASC, l.id ASC',
    recent: 'l.created_at DESC, l.id DESC',
    followup: '(l.next_followup IS NULL), l.next_followup ASC, l.id ASC',
    touched: 'last_at DESC NULLS LAST, l.id DESC',
  }[q.sort] || 'l.created_at DESC, l.id DESC';
  const limit = Math.min(Number(q.limit) || 200, 1000), offset = Number(q.offset) || 0;
  const rows = await db.all(LEAD_LIST_SQL + w + ' ORDER BY ' + sort + ' LIMIT ? OFFSET ?', ...args, limit, offset);
  return { total, rows: rows.map(leadView) };
}

async function leadDetail(id) {
  const r = await getLeadRow(id);
  if (!r) throw new HttpError(404, 'Lead not found');
  return {
    lead: leadView(r),
    contacts: await db.all('SELECT * FROM contacts WHERE lead_id = ? ORDER BY "at" DESC, id DESC', id),
    deal: (await db.get('SELECT * FROM deals WHERE lead_id = ?', id)) || null,
    optouts: await db.all('SELECT * FROM opt_outs WHERE lead_id = ? ORDER BY "at" DESC, id DESC', id),
  };
}

/* ---------------- opt out ---------------- */
async function optOut(id, b) {
  const lead = await getLeadRow(id);
  if (!lead) throw new HttpError(404, 'Lead not found');
  if (lead.opted_out) throw new HttpError(409, 'Already opted out.');
  const ch = b.channel === 'all' || !b.channel ? 'all' : b.channel;
  if (ch !== 'all' && !Lib.CHANNEL_LABEL[ch]) throw bad('Unknown channel.');
  let at = nowIso();
  if (b.at) { const d = new Date(b.at); if (isNaN(d)) throw bad('Bad date/time.'); at = d.toISOString(); }
  return tx(async () => {
    await db.run('INSERT INTO opt_outs(lead_id, business_name, phone_norm, email_norm, website_norm, name_city_key, "at", channel, note) VALUES(?,?,?,?,?,?,?,?,?)',
      id, lead.business_name, lead.phone_norm, lead.email_norm, lead.website_norm, lead.name_city_key, at, ch, clean(b.note));
    await db.run('UPDATE leads SET opted_out = 1, opt_out_date = ?, opt_out_channel = ?, next_followup = NULL, updated_at = ? WHERE id = ?', at, ch, nowIso(), id);
    return leadDetail(id);
  });
}
async function removeOptOut(id, b) {
  const lead = await getLeadRow(id);
  if (!lead) throw new HttpError(404, 'Lead not found');
  if (!lead.opted_out) throw new HttpError(409, 'This lead is not opted out.');
  if (b.confirm !== 'REMOVE') throw bad('Type REMOVE to confirm. This lead will become contactable again.');
  return tx(async () => {
    await db.run('UPDATE opt_outs SET removed_at = ?, removed_note = ? WHERE lead_id = ? AND removed_at IS NULL', nowIso(), clean(b.note), id);
    await db.run('UPDATE leads SET opted_out = 0, opt_out_date = NULL, opt_out_channel = NULL, updated_at = ? WHERE id = ?', nowIso(), id);
    return leadDetail(id);
  });
}

/* ---------------- deals ---------------- */
async function putDeal(id, b) {
  const lead = await getLeadRow(id);
  if (!lead) throw new HttpError(404, 'Lead not found');
  const s = await getSettings();
  const cur = (await db.get('SELECT * FROM deals WHERE lead_id = ?', id)) || {};
  const d = { ...cur };
  if ('call_at_local' in b) d.call_at = b.call_at_local ? Lib.zonedToUtc(b.call_at_local, s.my_timezone) : null;
  if ('call_at' in b) d.call_at = b.call_at ? new Date(b.call_at).toISOString() : null;
  if ('call_result' in b) {
    if (b.call_result && !['pending', 'show', 'no_show'].includes(b.call_result)) throw bad('Call result must be pending, show or no_show.');
    d.call_result = b.call_result || null;
  }
  for (const k of ['proposal_sent_date', 'deposit_paid_date', 'signed_date']) {
    if (k in b) { if (b[k] && !isDate(b[k])) throw bad(k + ' must be a date.'); d[k] = b[k] || null; }
  }
  for (const k of ['deposit_amount', 'deal_value']) if (k in b) d[k] = num(b[k]);
  return tx(async () => {
    await db.run(`INSERT INTO deals(lead_id, call_at, call_result, proposal_sent_date, deposit_paid_date, deposit_amount, signed_date, deal_value, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(lead_id) DO UPDATE SET call_at=excluded.call_at, call_result=excluded.call_result,
      proposal_sent_date=excluded.proposal_sent_date, deposit_paid_date=excluded.deposit_paid_date, deposit_amount=excluded.deposit_amount,
      signed_date=excluded.signed_date, deal_value=excluded.deal_value, updated_at=excluded.updated_at`,
    id, d.call_at ?? null, d.call_result ?? null, d.proposal_sent_date ?? null, d.deposit_paid_date ?? null, d.deposit_amount ?? null, d.signed_date ?? null, d.deal_value ?? null, nowIso());
    let status = lead.status, followup = lead.next_followup;
    if (d.signed_date) { status = 'closed'; followup = null; }
    else {
      if (lead.status === 'closed') status = d.proposal_sent_date ? 'proposal_sent' : d.call_at ? 'call_booked' : 'replied';
      if (d.proposal_sent_date && Lib.STATUS_RANK[status] < Lib.STATUS_RANK.proposal_sent && status !== 'not_interested') status = 'proposal_sent';
      else if (d.call_at && Lib.STATUS_RANK[status] < Lib.STATUS_RANK.call_booked && status !== 'not_interested') status = 'call_booked';
    }
    await db.run('UPDATE leads SET status = ?, next_followup = ?, updated_at = ? WHERE id = ?', status, followup, nowIso(), id);
    return leadDetail(id);
  });
}

/* ---------------- today / queue ---------------- */
function leadLite(r, now, s) {
  const tz = Lib.tzForLead(r);
  const w = Lib.okToCall(now, tz, s.call_window_start, s.call_window_end);
  return {
    id: r.id, business_name: r.business_name, owner_name: r.owner_name, phone: r.phone, city: r.city, state: r.state, trade: r.trade,
    status: r.status, next_followup: r.next_followup, tz, competitor_checked: r.competitor_checked, competitor_checked_date: r.competitor_checked_date,
    last_at: r.last_at, last_channel: r.last_channel, last_outcome: r.last_outcome, contact_count: r.contact_count,
    window: w,
  };
}
const ACTIVE = "l.opted_out = 0 AND l.status NOT IN ('closed','not_interested')";
const CALL_ELIGIBLE = "l.opted_out = 0 AND l.status IN ('new','follow_up','replied') AND l.phone_norm IS NOT NULL";
const intOr0 = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, 100000) : 0; };

async function todayData(now, followLimit) {
  const s = await getSettings();
  const today = Lib.dayKey(now, s.my_timezone);
  const progress = {
    today,
    calls: 0, calls_target: s.daily_call_target, dms: 0, dms_target: s.daily_dm_target,
  };
  const outreach = await outreachDay(today, now);
  progress.calls = outreach.items.find((i) => i.key === 'call').total;
  progress.dms = outreach.items.filter((i) => ['instagram_dm', 'facebook_dm'].includes(i.key)).reduce((n, i) => n + i.total, 0);
  const dueWhere = `${ACTIVE} AND l.next_followup IS NOT NULL AND l.next_followup <= ?`;
  const total = (await db.get(`SELECT COUNT(*) AS n FROM leads l WHERE ${dueWhere}`, today)).n;
  const overdue = (await db.get(`SELECT COUNT(*) AS n FROM leads l WHERE ${dueWhere} AND l.next_followup < ?`, today, today)).n;
  const rows = (await db.all(LEAD_LIST_SQL + ` WHERE ${dueWhere} ORDER BY l.next_followup ASC, l.id ASC LIMIT ?`, today, Math.min(Number(followLimit) || 8, 200)))
    .map((r) => ({ ...leadLite(r, now, s), overdue: r.next_followup < today, email: r.email }));
  const dueRows = await db.all(LEAD_LIST_SQL + ` WHERE ${dueWhere}`, today);
  const followups_by = {};
  for (const g of Object.keys(Lib.CHANNEL_GROUPS)) followups_by[g] = dueRows.filter((r) => Lib.CHANNEL_GROUPS[g].includes(r.last_channel)).length;
  const booked = (await db.all(`SELECT d.*, l.business_name, l.owner_name, l.phone, l.city, l.state, l.timezone, l.id AS lid FROM deals d JOIN leads l ON l.id = d.lead_id
    WHERE l.opted_out = 0 AND d.call_at IS NOT NULL AND d.call_at >= ? AND d.call_at <= ? AND (d.call_result IS NULL OR d.call_result = 'pending')
    ORDER BY d.call_at ASC`, new Date(now.getTime() - 3 * 3600000).toISOString(), new Date(now.getTime() + 72 * 3600000).toISOString()))
    .map((d) => ({ lead_id: d.lid, business_name: d.business_name, owner_name: d.owner_name, phone: d.phone, city: d.city, state: d.state,
      tz: Lib.tzForLead(d), call_at: d.call_at, hours_away: Math.round(((new Date(d.call_at) - now) / 3600000) * 10) / 10 }));
  return { now: now.toISOString(), progress, outreach, followups_total: total, followups_overdue: overdue, followups_by, followups: rows, booked, goal: await goalData(now), window: { start: s.call_window_start, end: s.call_window_end }, my_timezone: s.my_timezone };
}

/* Follow-ups page: everything due (or coming up), filterable by the channel of the last contact. */
async function followupsData(now, q) {
  const s = await getSettings();
  const today = Lib.dayKey(now, s.my_timezone);
  const soon = q.scope === 'soon';
  const cond = soon ? 'l.next_followup > ? AND l.next_followup <= ?' : 'l.next_followup <= ?';
  const args = soon ? [today, Lib.addDaysKey(today, 7)] : [today];
  const all = await db.all(LEAD_LIST_SQL + ` WHERE ${ACTIVE} AND l.next_followup IS NOT NULL AND ${cond} ORDER BY l.next_followup ASC, l.id ASC`, ...args);
  const inGroup = (r, g) => Lib.CHANNEL_GROUPS[g].includes(r.last_channel);
  const counts = { all: all.length };
  for (const g of Object.keys(Lib.CHANNEL_GROUPS)) counts[g] = all.filter((r) => inGroup(r, g)).length;
  const filtered = Lib.CHANNEL_GROUPS[q.channel] ? all.filter((r) => inGroup(r, q.channel)) : all;
  const limit = Math.min(Number(q.limit) || 50, 200), offset = Number(q.offset) || 0;
  return { today, scope: soon ? 'soon' : 'due', total: filtered.length, overdue_count: all.filter((r) => r.next_followup < today).length, counts,
    rows: filtered.slice(offset, offset + limit).map((r) => ({ ...leadLite(r, now, s), overdue: r.next_followup < today, email: r.email })) };
}

/* ---------- Calls: scoreboard (your Cold Call Tracker model) ---------- */
const COUNT_FIELDS = { calls: 'calls_adj', reached: 'reached_adj', owner: 'owner_adj', good: 'good_adj' };
const autoCounts = (calls) => ({
  calls: calls.length,
  reached: calls.filter((c) => Lib.REACHED_OUTCOMES.includes(c.outcome)).length,
  owner: calls.filter((c) => Lib.CONVERSATION_OUTCOMES.includes(c.outcome)).length,
  good: calls.filter((c) => Lib.GOOD_OUTCOMES.includes(c.outcome)).length,
});
const ZERO_ADJ = { calls_adj: 0, reached_adj: 0, owner_adj: 0, good_adj: 0, verdict: null };
const dayRow = async (day) => (await db.get('SELECT * FROM call_day WHERE day = ?', day)) || { day, ...ZERO_ADJ };
const withAdj = (auto, row) => ({
  calls: Math.max(0, auto.calls + row.calls_adj), reached: Math.max(0, auto.reached + row.reached_adj),
  owner: Math.max(0, auto.owner + row.owner_adj), good: Math.max(0, auto.good + row.good_adj),
});
async function callsOnDay(day, tz) {
  const mid = Date.parse(day + 'T00:00:00Z');
  const lo = new Date(mid - 36 * 3600000).toISOString(), hi = new Date(mid + 60 * 3600000).toISOString();
  return (await db.all("SELECT outcome, \"at\" FROM contacts WHERE channel = 'call' AND \"at\" >= ? AND \"at\" <= ?", lo, hi)).filter((c) => Lib.dayKey(c.at, tz) === day);
}
async function dayData(day, now) {
  const s = await getSettings();
  if (!isDate(day)) throw bad('Day must be a date.');
  const auto = autoCounts(await callsOnDay(day, s.my_timezone));
  const row = await dayRow(day);
  const today = Lib.dayKey(now, s.my_timezone);
  return { day, today, is_today: day === today, auto, adj: { calls: row.calls_adj, reached: row.reached_adj, owner: row.owner_adj, good: row.good_adj },
    totals: withAdj(auto, row), verdict: row.verdict || '' };
}
async function setDay(b, now) {
  const s = await getSettings();
  const day = b.day;
  if (!isDate(day)) throw bad('Day must be a date.');
  if (day > Lib.dayKey(now, s.my_timezone)) throw bad('You cannot log a day that has not happened yet.');
  const auto = autoCounts(await callsOnDay(day, s.my_timezone));
  const row = { ...(await dayRow(day)) };
  if (b.field) {
    if (!COUNT_FIELDS[b.field]) throw bad('Unknown counter.');
    const value = intOr0(b.value);
    row[COUNT_FIELDS[b.field]] = value - auto[b.field]; // the counter shows what you set; the difference from your logged calls is kept as the adjustment
  }
  if ('verdict' in b) row.verdict = String(b.verdict || '').slice(0, 5000) || null;
  await db.run(`INSERT INTO call_day(day, calls_adj, reached_adj, owner_adj, good_adj, verdict, updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(day) DO UPDATE SET calls_adj = excluded.calls_adj, reached_adj = excluded.reached_adj, owner_adj = excluded.owner_adj, good_adj = excluded.good_adj, verdict = excluded.verdict, updated_at = excluded.updated_at`,
  day, row.calls_adj, row.reached_adj, row.owner_adj, row.good_adj, row.verdict, nowIso());
  return dayData(day, now);
}
/* the 7 most recent days with anything on them, newest first, with averages (like the Cold Call Tracker's "Last 7 Days") */
async function dayHistory(now) {
  const s = await getSettings();
  const tz = s.my_timezone;
  const calls = (await db.all("SELECT outcome, \"at\" FROM contacts WHERE channel = 'call' AND \"at\" >= ?", new Date(now.getTime() - 120 * 86400000).toISOString())).map((c) => ({ ...c, day: Lib.dayKey(c.at, tz) }));
  const days = new Set(calls.map((c) => c.day));
  const adjRows = await db.all('SELECT * FROM call_day');
  const adjBy = Object.fromEntries(adjRows.map((r) => [r.day, r]));
  for (const r of adjRows) if (r.calls_adj || r.reached_adj || r.owner_adj || r.good_adj || r.verdict) days.add(r.day);
  const list = [...days].sort().reverse().slice(0, 7).map((day) => {
    const t = withAdj(autoCounts(calls.filter((c) => c.day === day)), adjBy[day] || ZERO_ADJ);
    return { day, ...t, has_verdict: !!(adjBy[day] && adjBy[day].verdict) };
  });
  const n = list.length || 1;
  const avg = (k) => list.reduce((a, d) => a + d[k], 0) / n;
  return { days: list, averages: list.length ? { calls: avg('calls'), reached: avg('reached'), owner: avg('owner'), good: avg('good') } : null };
}

/* ---------- Reached out today: calls, Instagram DMs, Facebook DMs, emails (auto-counted from the log, adjustable with + and -) ---------- */
const OUTREACH = [
  { key: 'call', label: 'Calls', channel: 'call' },
  { key: 'instagram_dm', label: 'Instagram DMs', channel: 'instagram_dm' },
  { key: 'facebook_dm', label: 'Facebook DMs', channel: 'facebook_dm' },
  { key: 'email', label: 'Emails', channel: 'email' },
];
async function outreachDay(day, now) {
  const s = await getSettings();
  const tz = s.my_timezone;
  const mid = Date.parse(day + 'T00:00:00Z');
  const lo = new Date(mid - 36 * 3600000).toISOString(), hi = new Date(mid + 60 * 3600000).toISOString();
  const rows = (await db.all("SELECT channel, outcome, \"at\" FROM contacts WHERE \"at\" >= ? AND \"at\" <= ? AND channel IN ('call','instagram_dm','facebook_dm','email')", lo, hi)).filter((c) => Lib.dayKey(c.at, tz) === day);
  const adjRows = Object.fromEntries((await db.all('SELECT key, adj FROM outreach_adj WHERE day = ?', day)).map((r) => [r.key, r.adj]));
  const callRow = await dayRow(day);
  const items = OUTREACH.map((o) => {
    // a call is any call you logged; a DM or an email counts when you logged it as Sent
    const auto = rows.filter((c) => c.channel === o.channel && (o.channel === 'call' || c.outcome === 'sent')).length;
    const adj = o.key === 'call' ? callRow.calls_adj : adjRows[o.key] || 0;
    return { key: o.key, label: o.label, auto, adj, total: Math.max(0, auto + adj) };
  });
  const today = Lib.dayKey(now, tz);
  return { day, today, is_today: day === today, items, total: items.reduce((n, i) => n + i.total, 0) };
}
async function setOutreach(b, now) {
  const s = await getSettings();
  const o = OUTREACH.find((x) => x.key === b.key);
  if (!o) throw bad('Unknown counter.');
  if (!isDate(b.day)) throw bad('Day must be a date.');
  if (b.day > Lib.dayKey(now, s.my_timezone)) throw bad('You cannot log a day that has not happened yet.');
  if (o.key === 'call') { await setDay({ day: b.day, field: 'calls', value: b.value }, now); return outreachDay(b.day, now); }
  const cur = (await outreachDay(b.day, now)).items.find((i) => i.key === o.key);
  const value = intOr0(b.value);
  await db.run('INSERT INTO outreach_adj(day, key, adj) VALUES(?,?,?) ON CONFLICT(day, key) DO UPDATE SET adj = excluded.adj', b.day, o.key, value - cur.auto);
  return outreachDay(b.day, now);
}

/* Calls page: the call queue and the numbers that matter for calling. */
async function callsData(now, period, readyLimit) {
  const s = await getSettings();
  const tz = s.my_timezone;
  const today = Lib.dayKey(now, tz);
  const cands = (await db.all(LEAD_LIST_SQL + ` WHERE ${CALL_ELIGIBLE} AND (l.next_followup IS NULL OR l.next_followup <= ?)`, today)).map((r) => leadLite(r, now, s));
  const ready = cands.filter((l) => l.window.ok).sort((a, b) => a.window.minsLeft - b.window.minsLeft || a.id - b.id);
  const later = cands.filter((l) => !l.window.ok && !l.window.unknown).sort((a, b) => a.window.minsUntilOpen - b.window.minsUntilOpen || a.id - b.id);
  const noTz = cands.filter((l) => l.window.unknown);

  const per = ['today', 'week', 'month'].includes(period) ? period : 'today';
  const start = per === 'today' ? today : per === 'week' ? Lib.mondayOf(today) : Lib.addDaysKey(today, -29);
  const fromIso = new Date(now.getTime() - 40 * 86400000).toISOString();
  const calls = (await db.all("SELECT c.outcome, c.\"at\", l.state, l.timezone FROM contacts c JOIN leads l ON l.id = c.lead_id WHERE c.channel = 'call' AND c.\"at\" >= ?", fromIso))
    .map((c) => ({ ...c, day: Lib.dayKey(c.at, tz) }));
  const adjBy = Object.fromEntries((await db.all('SELECT * FROM call_day WHERE day >= ?', Lib.addDaysKey(today, -40))).map((r) => [r.day, r]));
  const dayTot = (d) => {
    const lc = calls.filter((c) => c.day === d);
    return { ...withAdj(autoCounts(lc), adjBy[d] || ZERO_ADJ), meetings: lc.filter((c) => c.outcome === 'booked').length };
  };
  const totals = { dials: 0, reached: 0, owner: 0, good: 0, meetings: 0 };
  let adjustedDays = 0;
  for (let d = start; d <= today; d = Lib.addDaysKey(d, 1)) {
    const t = dayTot(d);
    totals.dials += t.calls; totals.reached += t.reached; totals.owner += t.owner; totals.good += t.good; totals.meetings += t.meetings;
    const a = adjBy[d]; if (a && (a.calls_adj || a.reached_adj || a.owner_adj || a.good_adj)) adjustedDays++;
  }
  totals.pickup_rate = totals.dials ? totals.reached / totals.dials : null;
  totals.owner_rate = totals.dials ? totals.owner / totals.dials : null;
  totals.booking_rate = totals.owner ? totals.meetings / totals.owner : null;
  const loggedP = calls.filter((c) => c.day >= start && c.day <= today);
  const outcomes = Lib.OUTCOMES.call.map((o) => ({ outcome: o, label: Lib.OUTCOME_LABEL[o], count: loggedP.filter((c) => c.outcome === o).length }));
  const daily = [];
  for (let i = 13; i >= 0; i--) { const d = Lib.addDaysKey(today, -i); const t = dayTot(d); daily.push({ day: d, dials: t.calls, reached: t.reached, owner: t.owner, good: t.good, meetings: t.meetings }); }
  // by the lead's own local hour, last 30 days of logged calls
  const hours = {};
  for (const c of calls) {
    const z = Lib.tzForLead(c);
    if (!z) continue;
    const hr = Lib.parts(new Date(c.at), z).hour;
    const key = hr >= 8 && hr < 21 ? hr : -1;
    const o = hours[key] || (hours[key] = { hour: key, dials: 0, reached: 0 });
    o.dials++; if (Lib.REACHED_OUTCOMES.includes(c.outcome)) o.reached++;
  }
  const by_hour = Object.values(hours).sort((a, b) => a.hour - b.hour).map((h) => ({ ...h, rate: h.dials ? h.reached / h.dials : null }));
  const ds = await db.get("SELECT COUNT(*) FILTER (WHERE call_result = 'show') AS shows, COUNT(*) FILTER (WHERE call_result = 'no_show') AS noshows FROM deals");
  const shows = ds.shows || 0, noshows = ds.noshows || 0;
  const rl = Math.min(Number(readyLimit) || 40, 400);
  return {
    now: now.toISOString(), today, period: per, window: { start: s.call_window_start, end: s.call_window_end },
    dials_today: dayTot(today).calls, target: s.daily_call_target, totals, adjusted_days: adjustedDays, outcomes, daily, by_hour,
    show_rate: { shows, noshows, rate: shows + noshows ? shows / (shows + noshows) : null },
    queue: { ready_total: ready.length, ready: ready.slice(0, rl), later_total: later.length, later: later.slice(0, 30), no_tz_total: noTz.length, no_tz: noTz.slice(0, 30) },
  };
}

async function goalData(now) {
  const s = await getSettings();
  const signed = await db.get('SELECT COALESCE(SUM(d.deal_value),0) AS v, COUNT(*) AS n FROM deals d WHERE d.signed_date IS NOT NULL');
  const dep = await db.get('SELECT COALESCE(SUM(deposit_amount),0) AS v FROM deals WHERE deposit_paid_date IS NOT NULL');
  const pipe = await db.get("SELECT COALESCE(SUM(d.deal_value),0) AS v, COUNT(*) AS n FROM deals d JOIN leads l ON l.id=d.lead_id WHERE d.signed_date IS NULL AND l.status IN ('call_booked','proposal_sent') AND l.opted_out=0");
  const today = Lib.dayKey(now, s.my_timezone);
  const daysLeft = Math.max(0, Lib.daysBetween(today, s.goal_date));
  const remaining = Math.max(0, s.goal_amount - signed.v);
  return { amount: s.goal_amount, date: s.goal_date, signed: signed.v, signed_count: signed.n, deposits: dep.v, pipeline: pipe.v, pipeline_count: pipe.n,
    days_left: daysLeft, remaining, needed_per_day: daysLeft > 0 ? Math.round((remaining / daysLeft) * 100) / 100 : remaining, pct: s.goal_amount ? Math.min(100, Math.round((signed.v / s.goal_amount) * 1000) / 10) : 0 };
}

/* ---------------- stats ---------------- */
async function statsData(now, days, weeks) {
  const s = await getSettings();
  const tz = s.my_timezone;
  const today = Lib.dayKey(now, tz);
  const startDay = Lib.addDaysKey(today, -(days - 1));
  const startWeek = Lib.addDaysKey(Lib.mondayOf(today), -7 * (weeks - 1));
  const fromIso = new Date(now.getTime() - (Math.max(days, weeks * 7) + 9) * 86400000).toISOString();
  const rows = (await db.all('SELECT c.id, c.lead_id, c.channel, c.outcome, c."at", l.source FROM contacts c JOIN leads l ON l.id = c.lead_id WHERE c."at" >= ?', fromIso))
    .map((c) => ({ ...c, day: Lib.dayKey(c.at, tz) }));
  const blank = () => ({ calls: 0, dms: 0, groups: 0, emails: 0, texts: 0, replies: 0, booked: 0 });
  const bump = (o, c) => {
    if (c.channel === 'call') o.calls++;
    else if (c.channel === 'instagram_dm' || c.channel === 'facebook_dm') o.dms++;
    else if (c.channel === 'facebook_group') o.groups++;
    else if (c.channel === 'email') o.emails++;
    else if (c.channel === 'text') o.texts++;
    if (['replied', 'spoke_to_owner'].includes(c.outcome)) o.replies++;
    if (c.outcome === 'booked') o.booked++;
  };
  const daily = [];
  for (let i = 0; i < days; i++) daily.push({ day: Lib.addDaysKey(startDay, i), ...blank() });
  const weekly = [];
  for (let i = 0; i < weeks; i++) weekly.push({ week: Lib.addDaysKey(startWeek, 7 * i), ...blank() });
  const dIdx = Object.fromEntries(daily.map((d, i) => [d.day, i]));
  const wIdx = Object.fromEntries(weekly.map((w, i) => [w.week, i]));
  for (const c of rows) {
    if (c.day in dIdx) bump(daily[dIdx[c.day]], c);
    const wk = Lib.mondayOf(c.day);
    if (wk in wIdx) bump(weekly[wIdx[wk]], c);
  }
  // all-time conversion tables
  const all = await db.all('SELECT c.lead_id, c.channel, c.outcome, l.source FROM contacts c JOIN leads l ON l.id = c.lead_id');
  const RESP = Lib.RESPONSE_OUTCOMES;
  const byChannel = Lib.CHANNELS.map((ch) => {
    const mine = all.filter((c) => c.channel === ch.id);
    const leads = new Set(mine.map((c) => c.lead_id));
    const resp = new Set(mine.filter((c) => RESP.includes(c.outcome)).map((c) => c.lead_id));
    const book = new Set(mine.filter((c) => c.outcome === 'booked').map((c) => c.lead_id));
    return { channel: ch.id, label: ch.label, attempts: mine.length, leads: leads.size, responded: resp.size, booked: book.size,
      response_rate: leads.size ? resp.size / leads.size : null, booked_rate: leads.size ? book.size / leads.size : null };
  });
  const leadRows = await db.all('SELECT id, source, status FROM leads');
  const touched = new Set(all.map((c) => c.lead_id));
  const respAny = new Set(all.filter((c) => RESP.includes(c.outcome)).map((c) => c.lead_id));
  const bookAny = new Set(all.filter((c) => c.outcome === 'booked').map((c) => c.lead_id));
  const dealBooked = new Set((await db.all('SELECT lead_id FROM deals WHERE call_at IS NOT NULL')).map((r) => r.lead_id));
  const bySource = Lib.SOURCES.map((src) => {
    const ls = leadRows.filter((l) => l.source === src.id);
    const contacted = ls.filter((l) => touched.has(l.id));
    const replied = contacted.filter((l) => respAny.has(l.id));
    const booked = contacted.filter((l) => bookAny.has(l.id) || dealBooked.has(l.id));
    const closed = ls.filter((l) => l.status === 'closed');
    const n = contacted.length;
    return { source: src.id, label: src.label, leads: ls.length, contacted: n, replied: replied.length, booked: booked.length, closed: closed.length,
      response_rate: n ? replied.length / n : null, booked_rate: n ? booked.length / n : null, close_rate: n ? closed.length / n : null };
  });
  const funnel = Lib.STATUSES.map((st) => ({ status: st, label: Lib.STATUS_LABEL[st], count: leadRows.filter((l) => l.status === st).length }));
  const dealStats = await db.get("SELECT COUNT(*) FILTER (WHERE call_result = 'show') AS shows, COUNT(*) FILTER (WHERE call_result = 'no_show') AS noshows FROM deals");
  const shows = dealStats.shows || 0, noshows = dealStats.noshows || 0;
  const overdue = (await db.get("SELECT COUNT(*) AS n FROM leads WHERE opted_out = 0 AND status NOT IN ('closed','not_interested') AND next_followup IS NOT NULL AND next_followup < ?", today)).n;
  return { today, daily, weekly, byChannel, bySource, funnel, show_rate: shows + noshows ? shows / (shows + noshows) : null, shows, noshows, overdue_followups: overdue,
    totals: { leads: leadRows.length, contacted: touched.size, replied: respAny.size, booked: new Set([...bookAny, ...dealBooked]).size, closed: leadRows.filter((l) => l.status === 'closed').length },
    definitions: {
      replies: 'Replies counts a message reply or a conversation with the owner on a call.',
      responded: 'Responded means someone on their side engaged: replied, spoke to owner, asked for info, or booked.',
      booked: 'Booked is any lead with a booked outcome or a booked call date.',
    } };
}

/* ---------- cold email: Zapmail snapshots + what the log says about email ---------- */
async function saveSnapshot(b) {
  if (!b || !Array.isArray(b.mailboxes)) throw bad('A snapshot needs a mailboxes list.');
  const taken = b.taken_at ? new Date(b.taken_at) : new Date();
  if (isNaN(taken)) throw bad('Bad taken_at.');
  const payload = { ...b, taken_at: taken.toISOString() };
  await db.run('INSERT INTO email_snapshots(taken_at, payload) VALUES(?, ?)', taken.toISOString(), JSON.stringify(payload));
  await db.run('DELETE FROM email_snapshots WHERE id NOT IN (SELECT id FROM email_snapshots ORDER BY id DESC LIMIT 60)');
  return { ok: true, taken_at: payload.taken_at };
}
async function emailData(now) {
  const s = await getSettings();
  const tz = s.my_timezone;
  const today = Lib.dayKey(now, tz);
  const rows = await db.all('SELECT id, taken_at, payload FROM email_snapshots ORDER BY id DESC LIMIT 2');
  const snap = rows[0] ? { ...JSON.parse(rows[0].payload), id: rows[0].id, taken_at: rows[0].taken_at } : null;
  const prev = rows[1] ? JSON.parse(rows[1].payload) : null;
  const avg = (p) => (p && p.mailboxes && p.mailboxes.length ? p.mailboxes.reduce((n, m) => n + (m.score || 0), 0) / p.mailboxes.length : null);
  const fromIso = new Date(now.getTime() - 40 * 86400000).toISOString();
  const em = (await db.all("SELECT outcome, \"at\", mailbox FROM contacts WHERE channel = 'email' AND \"at\" >= ?", fromIso)).map((c) => ({ ...c, day: Lib.dayKey(c.at, tz) }));
  const totals = Object.fromEntries((await db.all("SELECT outcome, COUNT(*) AS n FROM contacts WHERE channel = 'email' GROUP BY outcome")).map((r) => [r.outcome, r.n]));
  const weekStart = Lib.addDaysKey(today, -6);
  const wk = em.filter((c) => c.day >= weekStart);
  const n7 = (o) => wk.filter((c) => c.outcome === o).length;
  const sentTotal = totals.sent || 0;
  const cold = {
    sent_total: sentTotal, replied_total: totals.replied || 0, bounced_total: totals.bounced || 0, booked_total: totals.booked || 0,
    sent_7d: n7('sent'), replied_7d: n7('replied'), bounced_7d: n7('bounced'), booked_7d: n7('booked'),
    sent_today: em.filter((c) => c.day === today && c.outcome === 'sent').length,
    reply_rate: sentTotal ? (totals.replied || 0) / sentTotal : null, bounce_rate: sentTotal ? (totals.bounced || 0) / sentTotal : null,
  };
  const perMailbox = {};
  for (const c of em) if (c.mailbox && c.day === today && c.outcome === 'sent') perMailbox[c.mailbox] = (perMailbox[c.mailbox] || 0) + 1;
  const nBoxes = snap ? snap.mailboxes.length : 0;
  let readiness = null;
  if (snap && snap.zapwarm && snap.zapwarm.started) {
    const started = snap.zapwarm.started;
    const day = Lib.daysBetween(started, today) + 1;
    const readyFrom = Lib.addDaysKey(started, 21);
    readiness = { started, day, ready_from: readyFrom, ready_by: Lib.addDaysKey(started, 28), days_to_ready: Math.max(0, Lib.daysBetween(today, readyFrom)), pct: Math.max(0, Math.min(100, Math.round((day / 21) * 100))), ready_now: today >= readyFrom };
  }
  const hoursAgo = snap ? Math.round(((now - new Date(snap.taken_at)) / 3600000) * 10) / 10 : null;
  let checked = [];
  try { checked = JSON.parse(s.email_checklist || '[]'); } catch (e) { checked = []; }
  return {
    today, snapshot: snap, score_before: avg(prev), score_now: avg(snap), synced_hours_ago: hoursAgo, stale: hoursAgo != null && hoursAgo > 24,
    cold, per_mailbox_today: perMailbox, per_mailbox_limit: s.email_daily_per_mailbox, capacity_today: nBoxes * s.email_daily_per_mailbox, readiness, checked,
  };
}

/* ---------- Zapmail API connection (read only by design) ---------- */
/* Zapmail keys have no scopes: the same key can also buy things. So this app can only ever call the three READ endpoints below,
   it never logs or returns the key, it strips mailbox passwords and 2FA secrets before saving anything, and the key is
   encrypted (AES-256-GCM) with a key made from the APP_SECRET environment variable. The secret lives in Vercel, the database
   only holds the encrypted text, so a copy of the database alone does not expose the key. */
const ZM_BASE = process.env.ZAPMAIL_BASE || 'https://api.zapmail.ai/api/v3';
const ZM_ALLOWED = new Set(['POST /mailboxes/list', 'POST /domains', 'POST /zap-warm/scores']);
let keyMemo = null;
function secretKey() {
  const s = process.env.APP_SECRET || '';
  if (s.length < 16) throw new HttpError(503, 'APP_SECRET is not set on the server (it must be at least 16 characters). Add it in the Vercel environment variables and redeploy.');
  if (!keyMemo || keyMemo.s !== s) keyMemo = { s, k: crypto.scryptSync(s, 'lead-tracker-zapmail-key-v1', 32) };
  return keyMemo.k;
}
function encryptText(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decryptText(b64) {
  const b = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
const zmErr = (msg, code) => { const e = new HttpError(code === 'bad_key' ? 400 : 502, msg); e.zm = code || 'error'; return e; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function zmCall(key, method, route, body) {
  const base = route.split('?')[0];
  if (!ZM_ALLOWED.has(method + ' ' + base)) throw new Error('Blocked: this app only makes the three read calls to Zapmail.');
  let res;
  try {
    res = await fetch(ZM_BASE + route, { method, headers: { 'x-auth-zapmail': key, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(20000) });
  } catch (e) { throw zmErr('Could not reach Zapmail. Check your internet and try again.', 'network'); }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  if (res.status === 401) throw zmErr('Zapmail rejected the key. Check it was copied in full, or make a new one.', 'bad_key');
  if (res.status === 403) throw zmErr('Zapmail says API access is not switched on for your account. Ask support@zapmail.ai to enable it, then press Refresh.', 'not_enabled');
  if (res.status === 429) throw zmErr('Zapmail is limiting how fast we ask. It will try again later.', 'rate');
  if (!res.ok) throw zmErr('Zapmail answered with an error (' + res.status + '). Try again in a few minutes.', 'error');
  return json;
}

async function zapmailSync() {
  const enc = await rawSetting('zapmail_key_enc');
  if (!enc) throw new HttpError(409, 'Zapmail is not connected.');
  let key;
  try { key = decryptText(enc); } catch (e) {
    if (e instanceof HttpError) throw e;
    const m = 'The saved Zapmail key cannot be read, most likely because APP_SECRET was changed. Disconnect and paste the key again.';
    await setSetting('zapmail_last_error', m);
    throw new HttpError(409, m);
  }
  try {
    const boxes = [];
    for (let page = 1; page <= 20; page++) {
      const j = await zmCall(key, 'POST', `/mailboxes/list?page=${page}&limit=50`);
      const d = j && j.data;
      if (!d || !Array.isArray(d.domains)) throw zmErr('Zapmail sent something unexpected for the mailbox list.');
      for (const dom of d.domains) for (const m of dom.mailboxes || []) {
        // only these fields are kept: passwords, app passwords and 2FA secrets are dropped on purpose
        boxes.push({ id: m.id, email: m.email, firstName: m.firstName, lastName: m.lastName, status: m.status, domain: m.domain || dom.domain, createdAt: m.createdAt, isWarmedUp: !!m.isWarmedUp });
      }
      if (!d.nextPage || d.nextPage === page) break;
      await sleep(250);
    }
    const doms = [];
    for (let page = 1; page <= 10; page++) {
      await sleep(250);
      const j = await zmCall(key, 'POST', `/domains?page=${page}&limit=100`);
      const d = j && j.data;
      if (!d || !Array.isArray(d.domains)) break;
      for (const x of d.domains) doms.push({ name: x.domain, status: x.status, nameServers: x.nameServers, expectedNameServers: x.expectedNameServers, healthScore: x.healthScore, healthLabel: x.healthLabel, blacklisted: !!x.isSpamhausBlacklisted, mailboxes: x.assignedMailboxesCount });
      if (!d.nextPage || d.nextPage === page) break;
    }
    const scores = {};
    for (let i = 0; i < boxes.length; i += 200) {
      await sleep(250);
      const ids = boxes.slice(i, i + 200).map((b) => b.id);
      const j = await zmCall(key, 'POST', '/zap-warm/scores', { mailboxIds: ids });
      Object.assign(scores, (j && j.data) || {});
    }
    const prev = await db.get('SELECT payload FROM email_snapshots ORDER BY id DESC LIMIT 1');
    const old = prev ? JSON.parse(prev.payload) : {};
    const today = new Date();
    const myTz = (await getSettings()).my_timezone;
    const mailboxes = boxes.map((b) => {
      const sc = scores[b.id] || null;
      const startedDay = sc && sc.warmupStartedOn ? String(sc.warmupStartedOn).slice(0, 10) : null;
      const age = startedDay ? Lib.daysBetween(startedDay, Lib.dayKey(today, myTz)) : null;
      const status = sc ? (age != null && age >= 21 ? 'Warmed up' : 'Warming up') : b.status === 'ACTIVE' ? 'Active' : String(b.status || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
      return { id: b.id, email: b.email, name: [b.firstName, b.lastName].filter(Boolean).join(' '), domain: b.domain, status, score: sc ? sc.warmupScore : null, score_max: 100,
        sent_30d: sc ? sc.sent : null, inbox_rate: sc && sc.inboxRate != null ? sc.inboxRate / 100 : null, warmup_started: startedDay };
    });
    const started = mailboxes.map((m) => m.warmup_started).filter(Boolean).sort()[0] || (old.zapwarm && old.zapwarm.started) || null;
    const sentSum = mailboxes.reduce((n, m) => n + (m.sent_30d || 0), 0);
    const inboxSum = Object.values(scores).reduce((n, s) => n + ((s && s.landedInInbox) || 0), 0);
    const scored = mailboxes.filter((m) => m.score != null);
    const snapshot = {
      taken_at: new Date().toISOString(), source: 'Zapmail API (read only)',
      plan: old.plan || null,
      zapwarm: { ...(old.zapwarm || {}), started, score: scored.length ? Math.round(scored.reduce((n, m) => n + m.score, 0) / scored.length) : null,
        emails_sent_30d: sentSum, inbox_rate: sentSum ? inboxSum / sentSum : null },
      domains: doms.map((x) => ({ name: x.name, status: x.expectedNameServers && x.nameServers && JSON.stringify([...x.nameServers].sort()) === JSON.stringify([...x.expectedNameServers].sort()) ? 'connected' : String(x.status || 'unknown').toLowerCase(), health: x.healthLabel || null, health_score: x.healthScore != null ? Number(x.healthScore) : null, blacklisted: x.blacklisted })),
      mailboxes,
    };
    await saveSnapshot(snapshot);
    await setSetting('zapmail_last_sync', nowIso());
    await setSetting('zapmail_last_error', '');
    return { mailboxes: mailboxes.length };
  } catch (e) {
    await setSetting('zapmail_last_error', e.message);
    throw e;
  }
}
async function zapmailStatus() {
  const enc = await rawSetting('zapmail_key_enc');
  const last = (await rawSetting('zapmail_last_sync')) || null;
  // age is worked out here, by the server's own clock, so the page never has to guess
  return { connected: !!enc, key_hint: enc ? await rawSetting('zapmail_key_hint') : null, last_sync: last, age_minutes: last ? Math.round((Date.now() - new Date(last).getTime()) / 60000) : null, last_error: (await rawSetting('zapmail_last_error')) || null };
}

/* ---------------- import ---------------- */
const IMPORT_FIELDS = ['business_name', 'owner_name', 'phone', 'email', 'website', 'city', 'state', 'trade', 'source', 'source_link', 'batch', 'timezone', 'notes', 'external_id'];
async function importPrepare(rows, defaults) {
  const seen = { phone: new Map(), site: new Map(), key: new Map() };
  const out = [];
  const normed = [];
  rows.forEach((raw, i) => {
    const input = {};
    for (const k of IMPORT_FIELDS) if (raw[k] != null && String(raw[k]).trim() !== '') input[k] = raw[k];
    if (!input.source) input.source = defaults.source || 'other';
    if (!input.source_link && defaults.source_link) input.source_link = defaults.source_link;
    if (!input.batch && defaults.batch) input.batch = defaults.batch;
    let f;
    try { f = normaliseLead(input, {}); } catch (e) { normed.push({ i, invalid: e.message, input }); return; }
    if (!f.business_name) { normed.push({ i, invalid: 'No business name', input }); return; }
    normed.push({ i, f });
  });
  const good = normed.filter((n) => n.f).map((n) => n.f);
  const dupIdx = await loadDupIndex(good);
  const optRows = await loadOptOutRows(good);
  for (const n of normed) {
    const { i } = n;
    if (n.invalid) { out.push({ i, status: 'invalid', reason: n.invalid, lead: n.input, matches: [] }); continue; }
    const f = n.f;
    const matches = dupsFromIndex(f, dupIdx);
    const optouts = optOutsFor(f, optRows);
    let status = 'new';
    let fileDup = null;
    for (const [map, key] of [[seen.phone, f.phone_norm], [seen.site, f.website_norm], [seen.key, f.name_city_key]]) {
      if (key && map.has(key)) fileDup = map.get(key);
    }
    if (optouts.length) status = 'optout';
    else if (matches.length) status = 'dup';
    else if (fileDup != null) status = 'dup_in_file';
    if (status === 'new' || status === 'dup' || status === 'dup_in_file') {
      if (f.phone_norm && !seen.phone.has(f.phone_norm)) seen.phone.set(f.phone_norm, i);
      if (f.website_norm && !seen.site.has(f.website_norm)) seen.site.set(f.website_norm, i);
      if (f.name_city_key && !seen.key.has(f.name_city_key)) seen.key.set(f.name_city_key, i);
    }
    out.push({ i, status, lead: f, matches, optouts, file_dup_of: fileDup });
  }
  return out;
}
async function importPreview(b) {
  const rows = await importPrepare(Array.isArray(b.rows) ? b.rows : [], b.defaults || {});
  const counts = { new: 0, dup: 0, dup_in_file: 0, optout: 0, invalid: 0 };
  rows.forEach((r) => counts[r.status]++);
  return {
    counts,
    rows: rows.map((r) => ({ i: r.i, status: r.status, reason: r.reason || null, file_dup_of: r.file_dup_of,
      lead: { business_name: r.lead.business_name, owner_name: r.lead.owner_name, phone: r.lead.phone, email: r.lead.email, website: r.lead.website, city: r.lead.city, state: r.lead.state, trade: r.lead.trade, source: r.lead.source },
      matches: (r.matches || []).map((m) => ({ id: m.lead.id, business_name: m.lead.business_name, city: m.lead.city, reasons: m.reasons })),
      optouts: (r.optouts || []).map((o) => ({ business_name: o.business_name, at: o.at })) })),
  };
}
async function importCommit(b) {
  const mode = ['skip', 'update', 'add'].includes(b.mode) ? b.mode : 'skip';
  const prepared = await importPrepare(Array.isArray(b.rows) ? b.rows : [], b.defaults || {});
  const res = { added: 0, skipped_duplicates: 0, updated: 0, blocked_optout: 0, invalid: 0, added_ids: [] };
  const batchName = clean((b.defaults || {}).batch);
  await tx(async () => {
    const toInsert = [];
    for (const r of prepared) {
      if (r.status === 'invalid') { res.invalid++; continue; }
      if (r.status === 'optout') { res.blocked_optout++; continue; }
      if (r.status === 'new') { toInsert.push({ ...r.lead, is_demo: 0 }); res.added++; continue; }
      if (r.status === 'dup_in_file') {
        if (mode === 'add') { toInsert.push(r.lead); res.added++; } else res.skipped_duplicates++;
        continue;
      }
      if (r.status === 'dup') {
        if (mode === 'add') { toInsert.push(r.lead); res.added++; }
        else if (mode === 'update') {
          const target = await getLeadRow(r.matches[0].lead.id);
          const patch = {};
          for (const k of TEXT_FIELDS) if (!target[k] && r.lead[k]) patch[k] = r.lead[k];
          const merged = normaliseLead(patch, target);
          if (Object.keys(patch).length) { await writeLead(target.id, merged); res.updated++; } else res.skipped_duplicates++;
        } else res.skipped_duplicates++;
      }
    }
    if (toInsert.length) res.added_ids = await insertLeads(toInsert);
  });
  res.batch = batchName;
  return res;
}

/* ---------------- export ---------------- */
const BOM = '﻿';
async function csvLeads() {
  const cols = ['id', 'business_name', 'owner_name', 'phone', 'email', 'website', 'city', 'state', 'trade', 'source', 'source_link', 'batch', 'timezone', 'notes', 'status', 'next_followup', 'competitor_checked', 'competitor_checked_date', 'opted_out', 'opt_out_date', 'opt_out_channel', 'external_id', 'is_demo', 'created_at', 'updated_at'];
  const rows = await db.all('SELECT * FROM leads ORDER BY id');
  return Lib.toCSV([cols, ...rows.map((r) => cols.map((c) => r[c]))]);
}
async function csvContacts() {
  const cols = ['id', 'lead_id', 'business_name', 'channel', 'outcome', 'direction', 'at', 'content', 'note', 'external_id', 'mailbox'];
  const rows = await db.all('SELECT c.*, l.business_name FROM contacts c JOIN leads l ON l.id = c.lead_id ORDER BY c."at", c.id');
  return Lib.toCSV([cols, ...rows.map((r) => cols.map((c) => r[c]))]);
}
async function csvDeals() {
  const cols = ['lead_id', 'business_name', 'call_at', 'call_result', 'proposal_sent_date', 'deposit_paid_date', 'deposit_amount', 'signed_date', 'deal_value'];
  const rows = await db.all('SELECT d.*, l.business_name FROM deals d JOIN leads l ON l.id = d.lead_id ORDER BY d.lead_id');
  return Lib.toCSV([cols, ...rows.map((r) => cols.map((c) => r[c]))]);
}
async function csvOptOuts() {
  const cols = ['id', 'lead_id', 'business_name', 'at', 'channel', 'note', 'removed_at', 'removed_note', 'phone_norm', 'email_norm', 'website_norm'];
  const rows = await db.all('SELECT * FROM opt_outs ORDER BY id');
  return Lib.toCSV([cols, ...rows.map((r) => cols.map((c) => r[c]))]);
}
function zipFiles(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
    c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/* ---------------- auth ---------------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, h] = stored.split(':');
  const c = crypto.scryptSync(pw, salt, 64);
  const hb = Buffer.from(h, 'hex');
  return hb.length === c.length && crypto.timingSafeEqual(hb, c);
}
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const isHttps = (req) => !!process.env.VERCEL || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || !!(req.socket && req.socket.encrypted);
const cookieFlags = (req) => 'HttpOnly; SameSite=Strict; Path=/' + (isHttps(req) ? '; Secure' : '');
async function newSession(req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  const t = Date.now();
  await db.run('INSERT INTO sessions(token_hash, created_at, expires_at) VALUES(?,?,?)', sha(token), new Date(t).toISOString(), new Date(t + 30 * 86400000).toISOString());
  await db.run('DELETE FROM sessions WHERE expires_at < ?', new Date(t).toISOString());
  res.setHeader('Set-Cookie', `sid=${token}; ${cookieFlags(req)}; Max-Age=${30 * 86400}`);
}
function cookies(req) {
  const o = {};
  for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return o;
}
async function authed(req) {
  const t = cookies(req).sid;
  if (!t) return false;
  const r = await db.get('SELECT expires_at FROM sessions WHERE token_hash = ?', sha(t));
  return !!r && r.expires_at > nowIso();
}
/* The client address. Behind Vercel the first x-forwarded-for entry is the real visitor. Elsewhere it can be faked, so it is only trusted on Vercel. */
function clientIp(req) {
  if (process.env.VERCEL || process.env.TRUST_PROXY === '1') {
    const x = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (x) return x;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
/* Failed tries are kept in the database (not in memory), so the lock holds across serverless instances. */
const LOCK_WINDOW_MS = 10 * 60000, LOCK_AFTER = 6;
async function throttled(key) {
  const r = await db.get('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at_ms > ?', key, Date.now() - LOCK_WINDOW_MS);
  return r.n >= LOCK_AFTER;
}
async function noteFailure(key) {
  await db.run('INSERT INTO login_attempts(ip, at_ms) VALUES(?, ?)', key, Date.now());
  await db.run('DELETE FROM login_attempts WHERE at_ms < ?', Date.now() - 24 * 3600000);
}

/* ---------------- http plumbing ---------------- */
const MAX_BODY = 4.4 * 1024 * 1024; // Vercel refuses request bodies over 4.5 MB before they reach the function
function send(res, status, body, headers) {
  const h = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(headers || {}) };
  if (typeof body === 'object' && !Buffer.isBuffer(body)) { h['Content-Type'] = 'application/json; charset=utf-8'; body = JSON.stringify(body); }
  res.writeHead(status, h);
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new HttpError(413, 'That file is too big to send in one go. Split it into smaller files (about 5,000 rows each).')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(bad('Body is not valid JSON.')); }
    });
    req.on('error', reject);
  });
}
const routes = [];
const route = (method, pattern, handler, opts) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, open: !!(opts && opts.open) });

const nowFrom = (q) => (q.now && !isNaN(new Date(q.now)) ? new Date(q.now) : new Date());

/* auth routes */
route('GET', '/api/me', async (c) => ({ setup_needed: !(await rawSetting('password_hash')), setup_needs_code: true, authenticated: await authed(c.req) }), { open: true });
route('POST', '/api/setup', async (c) => {
  if (await rawSetting('password_hash')) throw new HttpError(409, 'A password is already set.');
  const expected = process.env.SETUP_TOKEN || '';
  if (expected.length < 8) throw new HttpError(503, 'SETUP_TOKEN is not set on the server (it must be at least 8 characters). Add it in the Vercel environment variables, redeploy, then try again.');
  const key = 'setup|' + clientIp(c.req);
  if (await throttled(key)) throw new HttpError(429, 'Too many tries. Wait 10 minutes.');
  if (!safeEqual(String(c.body.setup_token || '').trim(), expected)) { await noteFailure(key); throw new HttpError(403, 'That setup code is not right.'); }
  const pw = String(c.body.password || '');
  if (pw.length < 8) throw bad('Use at least 8 characters.');
  // the insert only lands if no password exists yet, so two people racing cannot both set one
  const r = await db.run("INSERT INTO settings(key, value) VALUES('password_hash', ?) ON CONFLICT(key) DO NOTHING", hashPassword(pw));
  if (!r.changes) throw new HttpError(409, 'A password is already set.');
  await newSession(c.req, c.res);
  return { ok: true };
}, { open: true });
route('POST', '/api/login', async (c) => {
  const ip = clientIp(c.req);
  if (await throttled(ip)) throw new HttpError(429, 'Too many tries. Wait 10 minutes.');
  if (!verifyPassword(String(c.body.password || ''), await rawSetting('password_hash'))) {
    await noteFailure(ip);
    throw new HttpError(401, 'Wrong password.');
  }
  await newSession(c.req, c.res);
  return { ok: true };
}, { open: true });
route('POST', '/api/logout', async (c) => {
  const t = cookies(c.req).sid;
  if (t) await db.run('DELETE FROM sessions WHERE token_hash = ?', sha(t));
  c.res.setHeader('Set-Cookie', `sid=; ${cookieFlags(c.req)}; Max-Age=0`);
  return { ok: true };
}, { open: true });
route('POST', '/api/password', async (c) => {
  if (!verifyPassword(String(c.body.old || ''), await rawSetting('password_hash'))) throw new HttpError(401, 'Current password is wrong.');
  const pw = String(c.body.new || '');
  if (pw.length < 8) throw bad('Use at least 8 characters.');
  await setSetting('password_hash', hashPassword(pw));
  await db.run('DELETE FROM sessions');
  await newSession(c.req, c.res);
  return { ok: true };
});

/* settings */
route('GET', '/api/settings', () => getSettings());
route('PUT', '/api/settings', async (c) => {
  for (const [k, v] of Object.entries(c.body)) {
    if (!(k in DEFAULTS)) continue;
    if (NUMERIC.includes(k)) { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw bad(k + ' must be a number.'); await setSetting(k, n); }
    else if (k === 'goal_date') { if (!isDate(v)) throw bad('Goal date must be a date.'); await setSetting(k, v); }
    else if (k === 'my_timezone') { try { Lib.parts(new Date(), v); } catch (e) { throw bad('Unknown time zone.'); } await setSetting(k, v); }
    else if (k === 'email_checklist') { let a; try { a = JSON.parse(v); if (!Array.isArray(a)) throw new Error('x'); } catch (e) { throw bad('The checklist must be a list.'); } await setSetting(k, JSON.stringify(a)); }
    else await setSetting(k, v);
  }
  return getSettings();
});

/* leads */
route('GET', '/api/leads', (c) => listLeads(c.query));
route('GET', '/api/facets', async () => ({
  trades: (await db.all('SELECT DISTINCT trade FROM leads WHERE trade IS NOT NULL ORDER BY trade')).map((r) => r.trade),
  batches: (await db.all('SELECT DISTINCT batch FROM leads WHERE batch IS NOT NULL ORDER BY batch')).map((r) => r.batch),
  states: (await db.all('SELECT DISTINCT state FROM leads WHERE state IS NOT NULL ORDER BY state')).map((r) => r.state),
}));
route('POST', '/api/leads/check', async (c) => {
  const f = normaliseLead(c.body, {});
  return { duplicates: await findDuplicates(f, Number(c.body.exclude_id) || 0), optouts: await findOptOutMatches(f) };
});
route('POST', '/api/leads', async (c) => {
  const f = normaliseLead(c.body, { source: 'other', status: 'new' });
  if (!f.business_name) throw bad('Business name is required.');
  if (!f.source) f.source = 'other';
  const dups = await findDuplicates(f);
  const opts = await findOptOutMatches(f);
  if ((dups.length || opts.length) && !c.body.force) throw new HttpError(409, 'Possible duplicate', { duplicates: dups, optouts: opts });
  if (opts.length) { f.opted_out = 1; f.opt_out_date = nowIso(); f.opt_out_channel = 'all'; }
  const id = await tx(async () => {
    const newId = await insertLead(f);
    if (opts.length) await db.run('INSERT INTO opt_outs(lead_id, business_name, phone_norm, email_norm, website_norm, name_city_key, "at", channel, note) VALUES(?,?,?,?,?,?,?,?,?)',
      newId, f.business_name, f.phone_norm, f.email_norm, f.website_norm, f.name_city_key, nowIso(), 'all', 'Matched an earlier opt-out when added');
    return newId;
  });
  return { ...(await leadDetail(id)), flagged_optout: opts.length > 0 };
});
route('GET', '/api/leads/:id', (c) => leadDetail(Number(c.params.id)));
route('PATCH', '/api/leads/:id', async (c) => {
  const id = Number(c.params.id);
  const cur = await getLeadRow(id);
  if (!cur) throw new HttpError(404, 'Lead not found');
  const body = { ...c.body };
  delete body.opted_out; delete body.opt_out_date; delete body.opt_out_channel; // only via the opt-out endpoints
  if (cur.opted_out) delete body.next_followup;
  const f = normaliseLead(body, cur);
  if (!f.business_name) throw bad('Business name is required.');
  if (!f.source) f.source = 'other';
  await writeLead(id, f);
  return leadDetail(id);
});
route('DELETE', '/api/leads/:id', async (c) => {
  const id = Number(c.params.id);
  const cur = await getLeadRow(id);
  if (!cur) throw new HttpError(404, 'Lead not found');
  if (cur.opted_out && c.query.confirm !== cur.business_name) throw bad('This lead is opted out. Type the business name to delete it. The opt-out record is kept.');
  if (!cur.opted_out && c.query.confirm !== '1' && c.query.confirm !== cur.business_name) throw bad('Confirm the delete.');
  await db.run('DELETE FROM leads WHERE id = ?', id);
  return { ok: true };
});
route('POST', '/api/leads/:id/contacts', async (c) => addContact(Number(c.params.id), c.body, nowFrom(c.query)));
route('PATCH', '/api/contacts/:id', async (c) => {
  const cur = await db.get('SELECT * FROM contacts WHERE id = ?', Number(c.params.id));
  if (!cur) throw new HttpError(404, 'Entry not found');
  const content = 'content' in c.body ? clean(c.body.content) : cur.content;
  const note = 'note' in c.body ? clean(c.body.note) : cur.note;
  let at = cur.at;
  if (c.body.at) { const d = new Date(c.body.at); if (isNaN(d)) throw bad('Bad date/time.'); at = d.toISOString(); }
  const outcome = c.body.outcome || cur.outcome;
  if (!Lib.OUTCOMES[cur.channel].includes(outcome)) throw bad('Outcome not valid for this channel.');
  await db.run('UPDATE contacts SET content = ?, note = ?, "at" = ?, outcome = ? WHERE id = ?', content, note, at, outcome, cur.id);
  return leadDetail(cur.lead_id);
});
route('DELETE', '/api/contacts/:id', async (c) => {
  const cur = await db.get('SELECT * FROM contacts WHERE id = ?', Number(c.params.id));
  if (!cur) throw new HttpError(404, 'Entry not found');
  await db.run('DELETE FROM contacts WHERE id = ?', cur.id);
  return leadDetail(cur.lead_id);
});
route('POST', '/api/leads/:id/optout', (c) => optOut(Number(c.params.id), c.body));
route('POST', '/api/leads/:id/optout/remove', (c) => removeOptOut(Number(c.params.id), c.body));
route('PUT', '/api/leads/:id/deal', (c) => putDeal(Number(c.params.id), c.body));

/* views */
route('GET', '/api/today', (c) => todayData(nowFrom(c.query), c.query.follow_limit));
route('GET', '/api/followups', (c) => followupsData(nowFrom(c.query), c.query));
route('GET', '/api/calls', (c) => callsData(nowFrom(c.query), c.query.period, c.query.ready_limit));
route('GET', '/api/outreach/day', async (c) => outreachDay(c.query.day || Lib.dayKey(nowFrom(c.query), (await getSettings()).my_timezone), nowFrom(c.query)));
route('PUT', '/api/outreach/day', (c) => setOutreach(c.body, nowFrom(c.query)));
route('GET', '/api/calls/day', async (c) => dayData(c.query.day || Lib.dayKey(nowFrom(c.query), (await getSettings()).my_timezone), nowFrom(c.query)));
route('PUT', '/api/calls/day', (c) => setDay(c.body, nowFrom(c.query)));
route('GET', '/api/calls/history', (c) => dayHistory(nowFrom(c.query)));
route('GET', '/api/stats', (c) => statsData(nowFrom(c.query), Math.min(Number(c.query.days) || 14, 90), Math.min(Number(c.query.weeks) || 8, 26)));
route('GET', '/api/pipeline', async (c) => {
  const now = nowFrom(c.query);
  const rows = await db.all(`SELECT l.id, l.business_name, l.owner_name, l.city, l.state, l.trade, l.status, l.next_followup, l.opted_out, d.deal_value, d.call_at, d.signed_date
    FROM leads l LEFT JOIN deals d ON d.lead_id = l.id ORDER BY (l.next_followup IS NULL), l.next_followup, l.id`);
  const columns = Object.fromEntries(Lib.BOARD.map((st) => [st, []]));
  const counts = Object.fromEntries(Lib.STATUSES.map((st) => [st, 0]));
  for (const r of rows) {
    counts[r.status]++;
    if (columns[r.status] && columns[r.status].length < 80) columns[r.status].push({ ...r, opted_out: !!r.opted_out });
  }
  return { board: Lib.BOARD, columns, counts, goal: await goalData(now), today: Lib.dayKey(now, (await getSettings()).my_timezone) };
});

route('GET', '/api/email', (c) => emailData(nowFrom(c.query)));
route('POST', '/api/email/snapshot', (c) => saveSnapshot(c.body));
route('GET', '/api/zapmail/status', () => zapmailStatus());
route('PUT', '/api/zapmail/key', async (c) => {
  const key = String(c.body.key || '').trim();
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(key)) throw bad('That does not look like a Zapmail key. It is 36 characters with dashes, like 1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed.');
  await setSetting('zapmail_key_enc', encryptText(key));
  await setSetting('zapmail_key_hint', key.slice(-4));
  try { const r = await zapmailSync(); return { ...(await zapmailStatus()), synced: true, mailboxes: r.mailboxes }; } catch (e) {
    if (e.zm === 'bad_key') { await setSetting('zapmail_key_enc', ''); await setSetting('zapmail_key_hint', ''); }
    throw e;
  }
});
route('DELETE', '/api/zapmail/key', async () => { await setSetting('zapmail_key_enc', ''); await setSetting('zapmail_key_hint', ''); await setSetting('zapmail_last_error', ''); return zapmailStatus(); });
route('POST', '/api/zapmail/sync', async () => { const r = await zapmailSync(); return { ...(await zapmailStatus()), synced: true, mailboxes: r.mailboxes }; });

/* The once-a-day refresh. Vercel Cron calls this with "Authorization: Bearer <CRON_SECRET>". It has no login, so the secret is the only way in. */
route('GET', '/api/cron/zapmail', async (c) => {
  const secret = process.env.CRON_SECRET || '';
  if (secret.length < 16) throw new HttpError(503, 'CRON_SECRET is not set on the server (at least 16 characters).');
  const m = /^Bearer (.+)$/.exec(String(c.req.headers.authorization || ''));
  if (!m || !safeEqual(m[1], secret)) throw new HttpError(401, 'Not allowed');
  await db.run('DELETE FROM sessions WHERE expires_at < ?', nowIso());
  await db.run('DELETE FROM login_attempts WHERE at_ms < ?', Date.now() - 24 * 3600000);
  if (!(await rawSetting('zapmail_key_enc'))) return { ok: true, synced: false, reason: 'Zapmail is not connected' };
  const r = await zapmailSync();
  return { ok: true, synced: true, mailboxes: r.mailboxes };
}, { open: true });

/* import / export */
route('POST', '/api/import/preview', (c) => importPreview(c.body));
route('POST', '/api/import/commit', (c) => importCommit(c.body));
route('GET', '/api/export/:name', async (c, req, res) => {
  const n = c.params.name;
  const map = { 'leads.csv': csvLeads, 'contacts.csv': csvContacts, 'deals.csv': csvDeals, 'opt_outs.csv': csvOptOuts };
  if (n === 'all.zip') {
    const files = [];
    for (const [name, fn] of Object.entries(map)) files.push({ name, data: Buffer.from(BOM + (await fn()), 'utf8') });
    send(res, 200, zipFiles(files), { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="lead-tracker-export.zip"' });
    return null;
  }
  if (!map[n]) throw new HttpError(404, 'Unknown export');
  send(res, 200, Buffer.from(BOM + (await map[n]()), 'utf8'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${n}"` });
  return null;
});
route('POST', '/api/demo/clear', async (c) => {
  if (c.body.confirm !== 'DELETE DEMO') throw bad('Type DELETE DEMO to confirm.');
  const r = await db.run('DELETE FROM leads WHERE is_demo = 1');
  return { deleted: r.changes };
});
route('GET', '/api/health', async (c) => {
  if (c.query.db === '1') await db.get('SELECT 1 AS ok');
  return { ok: true, time: nowIso() };
}, { open: true });

/* ---------------- request handler ---------------- */
async function handleApi(req, res, url) {
  const q = Object.fromEntries(url.searchParams);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    if (!r.open && !(await authed(req))) return send(res, 401, { error: 'Not signed in' });
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin) { let host = ''; try { host = new URL(origin).host; } catch (e) { /* ignore */ } if (host !== req.headers.host) return send(res, 403, { error: 'Bad origin' }); }
    }
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
    const out = await r.handler({ req, res, params: { ...(m.groups || {}) }, query: q, body }, req, res);
    if (out === null) return undefined;
    return send(res, 200, out === undefined ? { ok: true } : out);
  }
  return send(res, 404, { error: 'Not found' });
}

const DB_DOWN = /^(ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|28P01|28000|3D000|08|57P|53300)/;
function describeError(e) {
  if (e instanceof HttpError) return { status: e.status, body: { error: e.message, ...(e.extra || {}) } };
  if (e instanceof db.DbConfigError) return { status: 503, body: { error: e.message } };
  if (e && (DB_DOWN.test(String(e.code || '')) || /timeout exceeded when trying to connect|Connection terminated|password authentication failed/i.test(String(e.message)))) {
    console.error('database connection problem:', e.code || '', e.message);
    return { status: 503, body: { error: 'Cannot reach the database. Check DATABASE_URL in the Vercel settings (Transaction pooler string, with the right password).' } };
  }
  console.error(e);
  return { status: 500, body: { error: 'Something went wrong on the server. Try again.' } };
}

/* (req, res) handler for everything under /api/ */
function handler(req, res) {
  return db.withRequest(async () => {
    try {
      const url = new URL(req.url, 'http://x');
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
      await db.ensureAlive();
      await ensureSchema();
      await handleApi(req, res, url);
    } catch (e) {
      const { status, body } = describeError(e);
      if (!res.headersSent) send(res, status, body);
    }
    return undefined;
  });
}

/* Make sure the tables exist. Scripts and tests call this; the handler calls it by itself. */
const init = () => ensureSchema();

module.exports = {
  handler, init, db, Lib, HttpError,
  importPreview, importCommit, saveSnapshot, normaliseLead, insertLead, insertLeads, addContact, optOut, putDeal, getSettings, setSetting, zapmailSync,
  send,
};
