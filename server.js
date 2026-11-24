'use strict';
/* Lead Tracker server. Node built-ins only (http, node:sqlite, crypto, zlib). No npm packages. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const Lib = require('./public/lib.js');

const PORT = Number(process.env.PORT) || 4310;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'tracker.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

/* ---------------- schema ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_name TEXT NOT NULL,
  owner_name TEXT, phone TEXT, phone_norm TEXT, email TEXT, email_norm TEXT,
  website TEXT, website_norm TEXT, city TEXT, state TEXT, trade TEXT,
  source TEXT NOT NULL DEFAULT 'other', source_link TEXT, batch TEXT, timezone TEXT, notes TEXT,
  status TEXT NOT NULL DEFAULT 'new', next_followup TEXT,
  competitor_checked TEXT, competitor_checked_date TEXT,
  opted_out INTEGER NOT NULL DEFAULT 0, opt_out_date TEXT, opt_out_channel TEXT,
  external_id TEXT, is_demo INTEGER NOT NULL DEFAULT 0, name_city_key TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone_norm);
CREATE INDEX IF NOT EXISTS idx_leads_site ON leads(website_norm);
CREATE INDEX IF NOT EXISTS idx_leads_key ON leads(name_city_key);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, outcome TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'out',
  content TEXT, note TEXT, at TEXT NOT NULL, external_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_lead ON contacts(lead_id, at);
CREATE INDEX IF NOT EXISTS idx_contacts_at ON contacts(at);
CREATE TABLE IF NOT EXISTS deals (
  lead_id INTEGER PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  call_at TEXT, call_result TEXT, proposal_sent_date TEXT, deposit_paid_date TEXT,
  deposit_amount REAL, signed_date TEXT, deal_value REAL, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS opt_outs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER, business_name TEXT, phone_norm TEXT, email_norm TEXT, website_norm TEXT, name_city_key TEXT,
  at TEXT NOT NULL, channel TEXT NOT NULL, note TEXT, removed_at TEXT, removed_note TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS call_tally (
  id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, dials INTEGER NOT NULL DEFAULT 0,
  conversations INTEGER NOT NULL DEFAULT 0, meetings INTEGER NOT NULL DEFAULT 0, note TEXT, created_at TEXT NOT NULL
);
`);
db.exec('CREATE TABLE IF NOT EXISTS call_day (day TEXT PRIMARY KEY, calls_adj INTEGER NOT NULL DEFAULT 0, reached_adj INTEGER NOT NULL DEFAULT 0, owner_adj INTEGER NOT NULL DEFAULT 0, good_adj INTEGER NOT NULL DEFAULT 0, verdict TEXT, updated_at TEXT)');
db.exec('CREATE TABLE IF NOT EXISTS outreach_adj (day TEXT NOT NULL, key TEXT NOT NULL, adj INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, key))');
db.exec('CREATE TABLE IF NOT EXISTS email_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, taken_at TEXT NOT NULL, payload TEXT NOT NULL)');
if (!db.prepare('PRAGMA table_info(contacts)').all().some((c) => c.name === 'mailbox')) db.exec('ALTER TABLE contacts ADD COLUMN mailbox TEXT');
// the old "Contacted" stage was replaced by "Follow up" (2026-11-24)
db.exec("UPDATE leads SET status = 'follow_up' WHERE status = 'contacted'");

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
function getSettings() {
  const out = { ...DEFAULTS };
  for (const r of db.prepare("SELECT key, value FROM settings WHERE key NOT IN ('password_hash')").all()) {
    if (!(r.key in DEFAULTS)) continue;
    out[r.key] = NUMERIC.includes(r.key) ? Number(r.value) : r.value;
  }
  return out;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
const rawSetting = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : null; };

/* ---------------- helpers ---------------- */
class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const bad = (m, extra) => new HttpError(400, m, extra);
const nowIso = () => new Date().toISOString();
const clean = (v) => { if (v == null) return null; v = String(v).trim(); return v === '' ? null : v; };
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ } throw e; }
}

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
const getLeadRow = (id) => db.prepare('SELECT * FROM leads WHERE id = ?').get(id);

function findDuplicates(f, excludeId) {
  const found = new Map();
  const add = (rows, reason) => {
    for (const r of rows) {
      if (excludeId && r.id === excludeId) continue;
      const e = found.get(r.id) || { lead: r, reasons: [] };
      if (!e.reasons.includes(reason)) e.reasons.push(reason);
      found.set(r.id, e);
    }
  };
  const cols = 'id, business_name, owner_name, city, state, phone, website, status, opted_out';
  if (f.phone_norm) add(db.prepare(`SELECT ${cols} FROM leads WHERE phone_norm = ?`).all(f.phone_norm), 'same phone');
  if (f.website_norm) add(db.prepare(`SELECT ${cols} FROM leads WHERE website_norm = ?`).all(f.website_norm), 'same website');
  if (f.name_city_key) add(db.prepare(`SELECT ${cols} FROM leads WHERE name_city_key = ?`).all(f.name_city_key), 'same name and city');
  return [...found.values()].map((e) => ({ ...e, lead: { ...e.lead, opted_out: !!e.lead.opted_out } }));
}
function findOptOutMatches(f) {
  const conds = [], args = [];
  if (f.phone_norm) { conds.push('phone_norm = ?'); args.push(f.phone_norm); }
  if (f.email_norm) { conds.push('email_norm = ?'); args.push(f.email_norm); }
  if (f.website_norm) { conds.push('website_norm = ?'); args.push(f.website_norm); }
  if (f.name_city_key) { conds.push('name_city_key = ?'); args.push(f.name_city_key); }
  if (!conds.length) return [];
  return db.prepare(`SELECT id, lead_id, business_name, at, channel FROM opt_outs WHERE removed_at IS NULL AND (${conds.join(' OR ')})`).all(...args);
}

function insertLead(f) {
  const t = nowIso();
  const row = { status: 'new', source: 'other', opted_out: 0, is_demo: 0, ...f, created_at: f.created_at || t, updated_at: t };
  if (!row.business_name) throw bad('Business name is required.');
  const res = db.prepare(`INSERT INTO leads(${LEAD_COLS.join(',')}) VALUES(${LEAD_COLS.map(() => '?').join(',')})`).run(...LEAD_COLS.map((c) => (row[c] === undefined ? null : row[c])));
  return Number(res.lastInsertRowid);
}
function writeLead(id, f) {
  const row = { ...f, updated_at: nowIso() };
  const cols = LEAD_COLS.filter((c) => c !== 'created_at');
  db.prepare(`UPDATE leads SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = ?`).run(...cols.map((c) => (row[c] === undefined ? null : row[c])), id);
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
const todayKey = (now) => Lib.dayKey(now || new Date(), getSettings().my_timezone);

function addContact(leadId, b, now) {
  const lead = getLeadRow(leadId);
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
      ? null : Lib.addBizDays(todayKey(now), days);
  }
  if (status === 'closed' || status === 'not_interested') followup = null;
  const direction = ['replied'].includes(b.outcome) ? 'in' : 'out';
  return tx(() => {
    const res = db.prepare('INSERT INTO contacts(lead_id, channel, outcome, direction, content, note, at, external_id, mailbox, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(leadId, b.channel, b.outcome, direction, clean(b.content), clean(b.note), at, clean(b.external_id), b.channel === 'email' ? clean(b.mailbox) : null, nowIso());
    db.prepare('UPDATE leads SET status = ?, next_followup = ?, updated_at = ? WHERE id = ?').run(status, followup, nowIso(), leadId);
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(res.lastInsertRowid));
    return { contact, lead: leadView(getLeadRow(leadId)), followup };
  });
}

/* ---------------- listing + detail ---------------- */
const LEAD_LIST_SQL = `SELECT l.*,
  (SELECT at FROM contacts c WHERE c.lead_id = l.id ORDER BY at DESC LIMIT 1) AS last_at,
  (SELECT channel FROM contacts c WHERE c.lead_id = l.id ORDER BY at DESC LIMIT 1) AS last_channel,
  (SELECT outcome FROM contacts c WHERE c.lead_id = l.id ORDER BY at DESC LIMIT 1) AS last_outcome,
  (SELECT COUNT(*) FROM contacts c WHERE c.lead_id = l.id) AS contact_count,
  (SELECT GROUP_CONCAT(channel || ':' || n) FROM (SELECT channel, COUNT(*) AS n FROM contacts c2 WHERE c2.lead_id = l.id GROUP BY channel)) AS channels
  FROM leads l`;

function listLeads(q) {
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
  const total = db.prepare('SELECT COUNT(*) AS n FROM leads l' + w).get(...args).n;
  const sort = { name: 'l.business_name COLLATE NOCASE ASC', recent: 'l.created_at DESC', followup: "(l.next_followup IS NULL), l.next_followup ASC", touched: 'l.last_touch DESC' }[q.sort] || 'l.created_at DESC, l.id DESC';
  const limit = Math.min(Number(q.limit) || 200, 1000), offset = Number(q.offset) || 0;
  const rows = db.prepare(LEAD_LIST_SQL.replace('FROM leads l', 'FROM leads l') + w + ' ORDER BY ' + sort.replace('l.last_touch DESC', 'last_at DESC') + ' LIMIT ? OFFSET ?').all(...args, limit, offset);
  return { total, rows: rows.map(leadView) };
}

function leadDetail(id) {
  const r = getLeadRow(id);
  if (!r) throw new HttpError(404, 'Lead not found');
  return {
    lead: leadView(r),
    contacts: db.prepare('SELECT * FROM contacts WHERE lead_id = ? ORDER BY at DESC, id DESC').all(id),
    deal: db.prepare('SELECT * FROM deals WHERE lead_id = ?').get(id) || null,
    optouts: db.prepare('SELECT * FROM opt_outs WHERE lead_id = ? ORDER BY at DESC, id DESC').all(id),
  };
}

/* ---------------- opt out ---------------- */
function optOut(id, b) {
  const lead = getLeadRow(id);
  if (!lead) throw new HttpError(404, 'Lead not found');
  if (lead.opted_out) throw new HttpError(409, 'Already opted out.');
  const ch = b.channel === 'all' || !b.channel ? 'all' : b.channel;
  if (ch !== 'all' && !Lib.CHANNEL_LABEL[ch]) throw bad('Unknown channel.');
  let at = nowIso();
  if (b.at) { const d = new Date(b.at); if (isNaN(d)) throw bad('Bad date/time.'); at = d.toISOString(); }
  return tx(() => {
    db.prepare('INSERT INTO opt_outs(lead_id, business_name, phone_norm, email_norm, website_norm, name_city_key, at, channel, note) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, lead.business_name, lead.phone_norm, lead.email_norm, lead.website_norm, lead.name_city_key, at, ch, clean(b.note));
    db.prepare('UPDATE leads SET opted_out = 1, opt_out_date = ?, opt_out_channel = ?, next_followup = NULL, updated_at = ? WHERE id = ?').run(at, ch, nowIso(), id);
    return leadDetail(id);
  });
}
function removeOptOut(id, b) {
  const lead = getLeadRow(id);
  if (!lead) throw new HttpError(404, 'Lead not found');
  if (!lead.opted_out) throw new HttpError(409, 'This lead is not opted out.');
  if (b.confirm !== 'REMOVE') throw bad('Type REMOVE to confirm. This lead will become contactable again.');
  return tx(() => {
    db.prepare('UPDATE opt_outs SET removed_at = ?, removed_note = ? WHERE lead_id = ? AND removed_at IS NULL').run(nowIso(), clean(b.note), id);
    db.prepare('UPDATE leads SET opted_out = 0, opt_out_date = NULL, opt_out_channel = NULL, updated_at = ? WHERE id = ?').run(nowIso(), id);
    return leadDetail(id);
  });
}

/* ---------------- deals ---------------- */
function putDeal(id, b) {
  const lead = getLeadRow(id);
  if (!lead) throw new HttpError(404, 'Lead not found');
  const s = getSettings();
  const cur = db.prepare('SELECT * FROM deals WHERE lead_id = ?').get(id) || {};
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
  return tx(() => {
    db.prepare(`INSERT INTO deals(lead_id, call_at, call_result, proposal_sent_date, deposit_paid_date, deposit_amount, signed_date, deal_value, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(lead_id) DO UPDATE SET call_at=excluded.call_at, call_result=excluded.call_result,
      proposal_sent_date=excluded.proposal_sent_date, deposit_paid_date=excluded.deposit_paid_date, deposit_amount=excluded.deposit_amount,
      signed_date=excluded.signed_date, deal_value=excluded.deal_value, updated_at=excluded.updated_at`)
      .run(id, d.call_at ?? null, d.call_result ?? null, d.proposal_sent_date ?? null, d.deposit_paid_date ?? null, d.deposit_amount ?? null, d.signed_date ?? null, d.deal_value ?? null, nowIso());
    let status = lead.status, followup = lead.next_followup;
    if (d.signed_date) { status = 'closed'; followup = null; }
    else {
      if (lead.status === 'closed') status = d.proposal_sent_date ? 'proposal_sent' : d.call_at ? 'call_booked' : 'replied';
      if (d.proposal_sent_date && Lib.STATUS_RANK[status] < Lib.STATUS_RANK.proposal_sent && status !== 'not_interested') status = 'proposal_sent';
      else if (d.call_at && Lib.STATUS_RANK[status] < Lib.STATUS_RANK.call_booked && status !== 'not_interested') status = 'call_booked';
    }
    db.prepare('UPDATE leads SET status = ?, next_followup = ?, updated_at = ? WHERE id = ?').run(status, followup, nowIso(), id);
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

function todayData(now, followLimit) {
  const s = getSettings();
  const today = Lib.dayKey(now, s.my_timezone);
  const since = new Date(now.getTime() - 3 * 86400000).toISOString();
  const todays = db.prepare('SELECT channel, outcome, at FROM contacts WHERE at >= ?').all(since).filter((c) => Lib.dayKey(c.at, s.my_timezone) === today);
  const progress = {
    today,
    calls: 0, calls_target: s.daily_call_target, dms: 0, dms_target: s.daily_dm_target,
  };
  const outreach = outreachDay(today, now);
  progress.calls = outreach.items.find((i) => i.key === 'call').total;
  progress.dms = outreach.items.filter((i) => ['instagram_dm', 'facebook_dm'].includes(i.key)).reduce((n, i) => n + i.total, 0);
  const dueWhere = `${ACTIVE} AND l.next_followup IS NOT NULL AND l.next_followup <= ?`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM leads l WHERE ${dueWhere}`).get(today).n;
  const overdue = db.prepare(`SELECT COUNT(*) AS n FROM leads l WHERE ${dueWhere} AND l.next_followup < ?`).get(today, today).n;
  const rows = db.prepare(LEAD_LIST_SQL + ` WHERE ${dueWhere} ORDER BY l.next_followup ASC, l.id ASC LIMIT ?`).all(today, Math.min(Number(followLimit) || 8, 200))
    .map((r) => ({ ...leadLite(r, now, s), overdue: r.next_followup < today, email: r.email }));
  const booked = db.prepare(`SELECT d.*, l.business_name, l.owner_name, l.phone, l.city, l.state, l.timezone, l.id AS lid FROM deals d JOIN leads l ON l.id = d.lead_id
    WHERE l.opted_out = 0 AND d.call_at IS NOT NULL AND d.call_at >= ? AND d.call_at <= ? AND (d.call_result IS NULL OR d.call_result = 'pending')
    ORDER BY d.call_at ASC`).all(new Date(now.getTime() - 3 * 3600000).toISOString(), new Date(now.getTime() + 72 * 3600000).toISOString())
    .map((d) => ({ lead_id: d.lid, business_name: d.business_name, owner_name: d.owner_name, phone: d.phone, city: d.city, state: d.state,
      tz: Lib.tzForLead(d), call_at: d.call_at, hours_away: Math.round(((new Date(d.call_at) - now) / 3600000) * 10) / 10 }));
  return { now: now.toISOString(), progress, outreach, followups_total: total, followups_overdue: overdue, followups: rows, booked, goal: goalData(now), window: { start: s.call_window_start, end: s.call_window_end }, my_timezone: s.my_timezone };
}

/* Follow-ups page: everything due (or coming up), filterable by the channel of the last contact. */
function followupsData(now, q) {
  const s = getSettings();
  const today = Lib.dayKey(now, s.my_timezone);
  const soon = q.scope === 'soon';
  const cond = soon ? 'l.next_followup > ? AND l.next_followup <= ?' : 'l.next_followup <= ?';
  const args = soon ? [today, Lib.addDaysKey(today, 7)] : [today];
  const all = db.prepare(LEAD_LIST_SQL + ` WHERE ${ACTIVE} AND l.next_followup IS NOT NULL AND ${cond} ORDER BY l.next_followup ASC, l.id ASC`).all(...args);
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
const dayRow = (day) => db.prepare('SELECT * FROM call_day WHERE day = ?').get(day) || { day, ...ZERO_ADJ };
const withAdj = (auto, row) => ({
  calls: Math.max(0, auto.calls + row.calls_adj), reached: Math.max(0, auto.reached + row.reached_adj),
  owner: Math.max(0, auto.owner + row.owner_adj), good: Math.max(0, auto.good + row.good_adj),
});
function callsOnDay(day, tz) {
  const mid = Date.parse(day + 'T00:00:00Z');
  const lo = new Date(mid - 36 * 3600000).toISOString(), hi = new Date(mid + 60 * 3600000).toISOString();
  return db.prepare("SELECT outcome, at FROM contacts WHERE channel = 'call' AND at >= ? AND at <= ?").all(lo, hi).filter((c) => Lib.dayKey(c.at, tz) === day);
}
function dayData(day, now) {
  const s = getSettings();
  if (!isDate(day)) throw bad('Day must be a date.');
  const auto = autoCounts(callsOnDay(day, s.my_timezone));
  const row = dayRow(day);
  const today = Lib.dayKey(now, s.my_timezone);
  return { day, today, is_today: day === today, auto, adj: { calls: row.calls_adj, reached: row.reached_adj, owner: row.owner_adj, good: row.good_adj },
    totals: withAdj(auto, row), verdict: row.verdict || '' };
}
function setDay(b, now) {
  const s = getSettings();
  const day = b.day;
  if (!isDate(day)) throw bad('Day must be a date.');
  if (day > Lib.dayKey(now, s.my_timezone)) throw bad('You cannot log a day that has not happened yet.');
  const auto = autoCounts(callsOnDay(day, s.my_timezone));
  const row = { ...dayRow(day) };
  if (b.field) {
    if (!COUNT_FIELDS[b.field]) throw bad('Unknown counter.');
    const value = intOr0(b.value);
    row[COUNT_FIELDS[b.field]] = value - auto[b.field]; // the counter shows what you set; the difference from your logged calls is kept as the adjustment
  }
  if ('verdict' in b) row.verdict = String(b.verdict || '').slice(0, 5000) || null;
  db.prepare(`INSERT INTO call_day(day, calls_adj, reached_adj, owner_adj, good_adj, verdict, updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(day) DO UPDATE SET calls_adj = excluded.calls_adj, reached_adj = excluded.reached_adj, owner_adj = excluded.owner_adj, good_adj = excluded.good_adj, verdict = excluded.verdict, updated_at = excluded.updated_at`)
    .run(day, row.calls_adj, row.reached_adj, row.owner_adj, row.good_adj, row.verdict, nowIso());
  return dayData(day, now);
}
/* the 7 most recent days with anything on them, newest first, with averages (like the Cold Call Tracker's "Last 7 Days") */
function dayHistory(now) {
  const s = getSettings();
  const tz = s.my_timezone;
  const calls = db.prepare("SELECT outcome, at FROM contacts WHERE channel = 'call' AND at >= ?").all(new Date(now.getTime() - 120 * 86400000).toISOString()).map((c) => ({ ...c, day: Lib.dayKey(c.at, tz) }));
  const days = new Set(calls.map((c) => c.day));
  const adjRows = db.prepare('SELECT * FROM call_day').all();
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
function outreachDay(day, now) {
  const s = getSettings();
  const tz = s.my_timezone;
  const mid = Date.parse(day + 'T00:00:00Z');
  const lo = new Date(mid - 36 * 3600000).toISOString(), hi = new Date(mid + 60 * 3600000).toISOString();
  const rows = db.prepare("SELECT channel, outcome, at FROM contacts WHERE at >= ? AND at <= ? AND channel IN ('call','instagram_dm','facebook_dm','email')").all(lo, hi).filter((c) => Lib.dayKey(c.at, tz) === day);
  const adjRows = Object.fromEntries(db.prepare('SELECT key, adj FROM outreach_adj WHERE day = ?').all(day).map((r) => [r.key, r.adj]));
  const callRow = dayRow(day);
  const items = OUTREACH.map((o) => {
    // a call is any call you logged; a DM or an email counts when you logged it as Sent
    const auto = rows.filter((c) => c.channel === o.channel && (o.channel === 'call' || c.outcome === 'sent')).length;
    const adj = o.key === 'call' ? callRow.calls_adj : adjRows[o.key] || 0;
    return { key: o.key, label: o.label, auto, adj, total: Math.max(0, auto + adj) };
  });
  const today = Lib.dayKey(now, tz);
  return { day, today, is_today: day === today, items, total: items.reduce((n, i) => n + i.total, 0) };
}
function setOutreach(b, now) {
  const s = getSettings();
  const o = OUTREACH.find((x) => x.key === b.key);
  if (!o) throw bad('Unknown counter.');
  if (!isDate(b.day)) throw bad('Day must be a date.');
  if (b.day > Lib.dayKey(now, s.my_timezone)) throw bad('You cannot log a day that has not happened yet.');
  if (o.key === 'call') { setDay({ day: b.day, field: 'calls', value: b.value }, now); return outreachDay(b.day, now); }
  const cur = outreachDay(b.day, now).items.find((i) => i.key === o.key);
  const value = intOr0(b.value);
  db.prepare('INSERT INTO outreach_adj(day, key, adj) VALUES(?,?,?) ON CONFLICT(day, key) DO UPDATE SET adj = excluded.adj').run(b.day, o.key, value - cur.auto);
  return outreachDay(b.day, now);
}

/* Calls page: the call queue and the numbers that matter for calling. */
function callsData(now, period, readyLimit) {
  const s = getSettings();
  const tz = s.my_timezone;
  const today = Lib.dayKey(now, tz);
  const cands = db.prepare(LEAD_LIST_SQL + ` WHERE ${CALL_ELIGIBLE} AND (l.next_followup IS NULL OR l.next_followup <= ?)`).all(today).map((r) => leadLite(r, now, s));
  const ready = cands.filter((l) => l.window.ok).sort((a, b) => a.window.minsLeft - b.window.minsLeft || a.id - b.id);
  const later = cands.filter((l) => !l.window.ok && !l.window.unknown).sort((a, b) => a.window.minsUntilOpen - b.window.minsUntilOpen || a.id - b.id);
  const noTz = cands.filter((l) => l.window.unknown);

  const per = ['today', 'week', 'month'].includes(period) ? period : 'today';
  const start = per === 'today' ? today : per === 'week' ? Lib.mondayOf(today) : Lib.addDaysKey(today, -29);
  const fromIso = new Date(now.getTime() - 40 * 86400000).toISOString();
  const calls = db.prepare("SELECT c.outcome, c.at, l.state, l.timezone FROM contacts c JOIN leads l ON l.id = c.lead_id WHERE c.channel = 'call' AND c.at >= ?").all(fromIso)
    .map((c) => ({ ...c, day: Lib.dayKey(c.at, tz) }));
  const adjBy = Object.fromEntries(db.prepare('SELECT * FROM call_day WHERE day >= ?').all(Lib.addDaysKey(today, -40)).map((r) => [r.day, r]));
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
  const ds = db.prepare("SELECT SUM(call_result='show') AS shows, SUM(call_result='no_show') AS noshows FROM deals").get();
  const shows = ds.shows || 0, noshows = ds.noshows || 0;
  const rl = Math.min(Number(readyLimit) || 40, 400);
  return {
    now: now.toISOString(), today, period: per, window: { start: s.call_window_start, end: s.call_window_end },
    dials_today: dayTot(today).calls, target: s.daily_call_target, totals, adjusted_days: adjustedDays, outcomes, daily, by_hour,
    show_rate: { shows, noshows, rate: shows + noshows ? shows / (shows + noshows) : null },
    queue: { ready_total: ready.length, ready: ready.slice(0, rl), later_total: later.length, later: later.slice(0, 30), no_tz_total: noTz.length, no_tz: noTz.slice(0, 30) },
  };
}

function goalData(now) {
  const s = getSettings();
  const signed = db.prepare('SELECT COALESCE(SUM(d.deal_value),0) AS v, COUNT(*) AS n FROM deals d WHERE d.signed_date IS NOT NULL').get();
  const dep = db.prepare('SELECT COALESCE(SUM(deposit_amount),0) AS v FROM deals WHERE deposit_paid_date IS NOT NULL').get();
  const pipe = db.prepare("SELECT COALESCE(SUM(d.deal_value),0) AS v, COUNT(*) AS n FROM deals d JOIN leads l ON l.id=d.lead_id WHERE d.signed_date IS NULL AND l.status IN ('call_booked','proposal_sent') AND l.opted_out=0").get();
  const today = Lib.dayKey(now, s.my_timezone);
  const daysLeft = Math.max(0, Lib.daysBetween(today, s.goal_date));
  const remaining = Math.max(0, s.goal_amount - signed.v);
  return { amount: s.goal_amount, date: s.goal_date, signed: signed.v, signed_count: signed.n, deposits: dep.v, pipeline: pipe.v, pipeline_count: pipe.n,
    days_left: daysLeft, remaining, needed_per_day: daysLeft > 0 ? Math.round((remaining / daysLeft) * 100) / 100 : remaining, pct: s.goal_amount ? Math.min(100, Math.round((signed.v / s.goal_amount) * 1000) / 10) : 0 };
}

/* ---------------- stats ---------------- */
function statsData(now, days, weeks) {
  const s = getSettings();
  const tz = s.my_timezone;
  const today = Lib.dayKey(now, tz);
  const startDay = Lib.addDaysKey(today, -(days - 1));
  const startWeek = Lib.addDaysKey(Lib.mondayOf(today), -7 * (weeks - 1));
  const fromIso = new Date(now.getTime() - (Math.max(days, weeks * 7) + 9) * 86400000).toISOString();
  const rows = db.prepare('SELECT c.id, c.lead_id, c.channel, c.outcome, c.at, l.source FROM contacts c JOIN leads l ON l.id = c.lead_id WHERE c.at >= ?').all(fromIso)
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
  const all = db.prepare('SELECT c.lead_id, c.channel, c.outcome, l.source FROM contacts c JOIN leads l ON l.id = c.lead_id').all();
  const RESP = Lib.RESPONSE_OUTCOMES;
  const byChannel = Lib.CHANNELS.map((ch) => {
    const mine = all.filter((c) => c.channel === ch.id);
    const leads = new Set(mine.map((c) => c.lead_id));
    const resp = new Set(mine.filter((c) => RESP.includes(c.outcome)).map((c) => c.lead_id));
    const book = new Set(mine.filter((c) => c.outcome === 'booked').map((c) => c.lead_id));
    return { channel: ch.id, label: ch.label, attempts: mine.length, leads: leads.size, responded: resp.size, booked: book.size,
      response_rate: leads.size ? resp.size / leads.size : null, booked_rate: leads.size ? book.size / leads.size : null };
  });
  const leadRows = db.prepare('SELECT id, source, status FROM leads WHERE opted_out = 0 OR 1').all();
  const touched = new Set(all.map((c) => c.lead_id));
  const respAny = new Set(all.filter((c) => RESP.includes(c.outcome)).map((c) => c.lead_id));
  const bookAny = new Set(all.filter((c) => c.outcome === 'booked').map((c) => c.lead_id));
  const dealBooked = new Set(db.prepare('SELECT lead_id FROM deals WHERE call_at IS NOT NULL').all().map((r) => r.lead_id));
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
  const dealStats = db.prepare("SELECT SUM(call_result='show') AS shows, SUM(call_result='no_show') AS noshows FROM deals").get();
  const shows = dealStats.shows || 0, noshows = dealStats.noshows || 0;
  const overdue = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE opted_out = 0 AND status NOT IN ('closed','not_interested') AND next_followup IS NOT NULL AND next_followup < ?").get(today).n;
  return { today, daily, weekly, byChannel, bySource, funnel, show_rate: shows + noshows ? shows / (shows + noshows) : null, shows, noshows, overdue_followups: overdue,
    totals: { leads: leadRows.length, contacted: touched.size, replied: respAny.size, booked: new Set([...bookAny, ...dealBooked]).size, closed: leadRows.filter((l) => l.status === 'closed').length },
    definitions: {
      replies: 'Replies counts a message reply or a conversation with the owner on a call.',
      responded: 'Responded means someone on their side engaged: replied, spoke to owner, asked for info, or booked.',
      booked: 'Booked is any lead with a booked outcome or a booked call date.',
    } };
}

/* ---------- cold email: Zapmail snapshots + what the log says about email ---------- */
function saveSnapshot(b) {
  if (!b || !Array.isArray(b.mailboxes)) throw bad('A snapshot needs a mailboxes list.');
  const taken = b.taken_at ? new Date(b.taken_at) : new Date();
  if (isNaN(taken)) throw bad('Bad taken_at.');
  const payload = { ...b, taken_at: taken.toISOString() };
  db.prepare('INSERT INTO email_snapshots(taken_at, payload) VALUES(?, ?)').run(taken.toISOString(), JSON.stringify(payload));
  db.prepare('DELETE FROM email_snapshots WHERE id NOT IN (SELECT id FROM email_snapshots ORDER BY id DESC LIMIT 60)').run();
  return { ok: true, taken_at: payload.taken_at };
}
function emailData(now) {
  const s = getSettings();
  const tz = s.my_timezone;
  const today = Lib.dayKey(now, tz);
  const rows = db.prepare('SELECT id, taken_at, payload FROM email_snapshots ORDER BY id DESC LIMIT 2').all();
  const snap = rows[0] ? { ...JSON.parse(rows[0].payload), id: rows[0].id, taken_at: rows[0].taken_at } : null;
  const prev = rows[1] ? JSON.parse(rows[1].payload) : null;
  const avg = (p) => (p && p.mailboxes && p.mailboxes.length ? p.mailboxes.reduce((n, m) => n + (m.score || 0), 0) / p.mailboxes.length : null);
  const fromIso = new Date(now.getTime() - 40 * 86400000).toISOString();
  const em = db.prepare("SELECT outcome, at, mailbox FROM contacts WHERE channel = 'email' AND at >= ?").all(fromIso).map((c) => ({ ...c, day: Lib.dayKey(c.at, tz) }));
  const totals = Object.fromEntries(db.prepare("SELECT outcome, COUNT(*) AS n FROM contacts WHERE channel = 'email' GROUP BY outcome").all().map((r) => [r.outcome, r.n]));
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
   encrypted on disk with a secret that lives in a separate file, so a copied database or backup alone does not expose it. */
const ZM_BASE = process.env.ZAPMAIL_BASE || 'https://api.zapmail.ai/api/v3';
const ZM_ALLOWED = new Set(['POST /mailboxes/list', 'POST /domains', 'POST /zap-warm/scores']);
const SECRET_FILE = path.join(DATA_DIR, '.secret');
function secretKey() {
  if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32), { mode: 0o600 });
  return fs.readFileSync(SECRET_FILE);
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
  const enc = rawSetting('zapmail_key_enc');
  if (!enc) throw new HttpError(409, 'Zapmail is not connected.');
  const key = decryptText(enc);
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
    const prev = db.prepare('SELECT payload FROM email_snapshots ORDER BY id DESC LIMIT 1').get();
    const old = prev ? JSON.parse(prev.payload) : {};
    const today = new Date();
    const mailboxes = boxes.map((b) => {
      const sc = scores[b.id] || null;
      const startedDay = sc && sc.warmupStartedOn ? String(sc.warmupStartedOn).slice(0, 10) : null;
      const age = startedDay ? Lib.daysBetween(startedDay, Lib.dayKey(today, getSettings().my_timezone)) : null;
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
    saveSnapshot(snapshot);
    setSetting('zapmail_last_sync', nowIso());
    setSetting('zapmail_last_error', '');
    return { mailboxes: mailboxes.length };
  } catch (e) {
    setSetting('zapmail_last_error', e.message);
    throw e;
  }
}
function zapmailStatus() {
  const enc = rawSetting('zapmail_key_enc');
  return { connected: !!enc, key_hint: enc ? rawSetting('zapmail_key_hint') : null, last_sync: rawSetting('zapmail_last_sync') || null, last_error: rawSetting('zapmail_last_error') || null };
}

/* ---------------- import ---------------- */
const IMPORT_FIELDS = ['business_name', 'owner_name', 'phone', 'email', 'website', 'city', 'state', 'trade', 'source', 'source_link', 'batch', 'timezone', 'notes', 'external_id'];
function importPrepare(rows, defaults) {
  const seen = { phone: new Map(), site: new Map(), key: new Map() };
  const out = [];
  rows.forEach((raw, i) => {
    const input = {};
    for (const k of IMPORT_FIELDS) if (raw[k] != null && String(raw[k]).trim() !== '') input[k] = raw[k];
    if (!input.source) input.source = defaults.source || 'other';
    if (!input.source_link && defaults.source_link) input.source_link = defaults.source_link;
    if (!input.batch && defaults.batch) input.batch = defaults.batch;
    let f;
    try { f = normaliseLead(input, {}); } catch (e) { out.push({ i, status: 'invalid', reason: e.message, lead: input, matches: [] }); return; }
    if (!f.business_name) { out.push({ i, status: 'invalid', reason: 'No business name', lead: input, matches: [] }); return; }
    const matches = findDuplicates(f);
    const optouts = findOptOutMatches(f);
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
  });
  return out;
}
function importPreview(b) {
  const rows = importPrepare(Array.isArray(b.rows) ? b.rows : [], b.defaults || {});
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
function importCommit(b) {
  const mode = ['skip', 'update', 'add'].includes(b.mode) ? b.mode : 'skip';
  const prepared = importPrepare(Array.isArray(b.rows) ? b.rows : [], b.defaults || {});
  const res = { added: 0, skipped_duplicates: 0, updated: 0, blocked_optout: 0, invalid: 0, added_ids: [] };
  const batchName = clean((b.defaults || {}).batch);
  tx(() => {
    for (const r of prepared) {
      if (r.status === 'invalid') { res.invalid++; continue; }
      if (r.status === 'optout') { res.blocked_optout++; continue; }
      if (r.status === 'new') { res.added_ids.push(insertLead({ ...r.lead, is_demo: 0 })); res.added++; continue; }
      if (r.status === 'dup_in_file') {
        if (mode === 'add') { res.added_ids.push(insertLead(r.lead)); res.added++; } else res.skipped_duplicates++;
        continue;
      }
      if (r.status === 'dup') {
        if (mode === 'add') { res.added_ids.push(insertLead(r.lead)); res.added++; }
        else if (mode === 'update') {
          const target = getLeadRow(r.matches[0].lead.id);
          const patch = {};
          for (const k of TEXT_FIELDS) if (!target[k] && r.lead[k]) patch[k] = r.lead[k];
          const merged = normaliseLead(patch, target);
          if (Object.keys(patch).length) { writeLead(target.id, merged); res.updated++; } else res.skipped_duplicates++;
        } else res.skipped_duplicates++;
      }
    }
  });
  if (res.added) runBackup('import');
  res.batch = batchName;
  return res;
}

/* ---------------- export ---------------- */
function csvLeads() {
  const cols = ['id', 'business_name', 'owner_name', 'phone', 'email', 'website', 'city', 'state', 'trade', 'source', 'source_link', 'batch', 'timezone', 'notes', 'status', 'next_followup', 'competitor_checked', 'competitor_checked_date', 'opted_out', 'opt_out_date', 'opt_out_channel', 'external_id', 'is_demo', 'created_at', 'updated_at'];
  const rows = db.prepare('SELECT * FROM leads ORDER BY id').all();
  return Lib.toCSV([cols, ...rows.map((r) => cols.map((c) => r[c]))]);
}
function csvContacts() {
  const cols = ['id', 'lead_id', 'business_name', 'channel', 'outcome', 'direction', 'at', 'content', 'note', 'external_id', 'mailbox'];
  const rows = db.prepare('SELECT c.*, l.business_name FROM contacts c JOIN leads l ON l.id = c.lead_id ORDER BY c.at').all();
  return Lib.toCSV([cols, ...rows.map((r) => cols.map((c) => r[c]))]);
}
function csvDeals() {
  const cols = ['lead_id', 'business_name', 'call_at', 'call_result', 'proposal_sent_date', 'deposit_paid_date', 'deposit_amount', 'signed_date', 'deal_value'];
  const rows = db.prepare('SELECT d.*, l.business_name FROM deals d JOIN leads l ON l.id = d.lead_id ORDER BY d.lead_id').all();
  return Lib.toCSV([cols, ...rows.map((r) => cols.map((c) => r[c]))]);
}
function csvOptOuts() {
  const cols = ['id', 'lead_id', 'business_name', 'at', 'channel', 'note', 'removed_at', 'removed_note', 'phone_norm', 'email_norm', 'website_norm'];
  const rows = db.prepare('SELECT * FROM opt_outs ORDER BY id').all();
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

/* ---------------- backups ---------------- */
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
function listBackups() {
  return fs.readdirSync(BACKUP_DIR).filter((f) => /^tracker-.*\.db$/.test(f)).sort().reverse()
    .map((f) => ({ name: f, bytes: fs.statSync(path.join(BACKUP_DIR, f)).size, at: fs.statSync(path.join(BACKUP_DIR, f)).mtime.toISOString() }));
}
function runBackup(reason) {
  let file = path.join(BACKUP_DIR, 'tracker-' + stamp() + '.db');
  let n = 1;
  while (fs.existsSync(file)) file = path.join(BACKUP_DIR, 'tracker-' + stamp() + '-' + n++ + '.db');
  db.exec("VACUUM INTO '" + file.replace(/'/g, "''") + "'");
  const all = listBackups();
  for (const old of all.slice(60)) { try { fs.unlinkSync(path.join(BACKUP_DIR, old.name)); } catch (e) { /* ignore */ } }
  void reason;
  return path.basename(file);
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
function newSession(res) {
  const token = crypto.randomBytes(32).toString('hex');
  const t = Date.now();
  db.prepare('INSERT INTO sessions(token_hash, created_at, expires_at) VALUES(?,?,?)').run(sha(token), new Date(t).toISOString(), new Date(t + 30 * 86400000).toISOString());
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}`);
}
function cookies(req) {
  const o = {};
  for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return o;
}
function authed(req) {
  const t = cookies(req).sid;
  if (!t) return false;
  const r = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(sha(t));
  return !!r && r.expires_at > nowIso();
}
const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60000);
  attempts.set(ip, a);
  return a.length >= 6;
}

/* ---------------- http plumbing ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function send(res, status, body, headers) {
  const h = { 'Cache-Control': 'no-store', ...(headers || {}) };
  if (typeof body === 'object' && !Buffer.isBuffer(body)) { h['Content-Type'] = 'application/json; charset=utf-8'; body = JSON.stringify(body); }
  res.writeHead(status, h);
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 12 * 1024 * 1024) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
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
route('GET', '/api/me', (c) => ({ setup_needed: !rawSetting('password_hash'), authenticated: authed(c.req) }), { open: true });
route('POST', '/api/setup', (c) => {
  if (rawSetting('password_hash')) throw new HttpError(409, 'A password is already set.');
  const pw = String(c.body.password || '');
  if (pw.length < 8) throw bad('Use at least 8 characters.');
  setSetting('password_hash', hashPassword(pw));
  newSession(c.res);
  return { ok: true };
}, { open: true });
route('POST', '/api/login', (c) => {
  const ip = c.req.socket.remoteAddress || '';
  if (throttled(ip)) throw new HttpError(429, 'Too many tries. Wait 10 minutes.');
  if (!verifyPassword(String(c.body.password || ''), rawSetting('password_hash'))) {
    attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]);
    throw new HttpError(401, 'Wrong password.');
  }
  newSession(c.res);
  return { ok: true };
}, { open: true });
route('POST', '/api/logout', (c) => {
  const t = cookies(c.req).sid;
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
  c.res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  return { ok: true };
}, { open: true });
route('POST', '/api/password', (c) => {
  if (!verifyPassword(String(c.body.old || ''), rawSetting('password_hash'))) throw new HttpError(401, 'Current password is wrong.');
  const pw = String(c.body.new || '');
  if (pw.length < 8) throw bad('Use at least 8 characters.');
  setSetting('password_hash', hashPassword(pw));
  db.prepare('DELETE FROM sessions').run();
  newSession(c.res);
  return { ok: true };
});

/* settings */
route('GET', '/api/settings', () => getSettings());
route('PUT', '/api/settings', (c) => {
  for (const [k, v] of Object.entries(c.body)) {
    if (!(k in DEFAULTS)) continue;
    if (NUMERIC.includes(k)) { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw bad(k + ' must be a number.'); setSetting(k, n); }
    else if (k === 'goal_date') { if (!isDate(v)) throw bad('Goal date must be a date.'); setSetting(k, v); }
    else if (k === 'my_timezone') { try { Lib.parts(new Date(), v); } catch (e) { throw bad('Unknown time zone.'); } setSetting(k, v); }
    else if (k === 'email_checklist') { try { const a = JSON.parse(v); if (!Array.isArray(a)) throw new Error('x'); setSetting(k, JSON.stringify(a)); } catch (e) { throw bad('The checklist must be a list.'); } }
    else setSetting(k, v);
  }
  return getSettings();
});

/* leads */
route('GET', '/api/leads', (c) => listLeads(c.query));
route('GET', '/api/facets', () => ({
  trades: db.prepare("SELECT DISTINCT trade FROM leads WHERE trade IS NOT NULL ORDER BY trade").all().map((r) => r.trade),
  batches: db.prepare("SELECT DISTINCT batch FROM leads WHERE batch IS NOT NULL ORDER BY batch").all().map((r) => r.batch),
  states: db.prepare("SELECT DISTINCT state FROM leads WHERE state IS NOT NULL ORDER BY state").all().map((r) => r.state),
}));
route('POST', '/api/leads/check', (c) => {
  const f = normaliseLead(c.body, {});
  return { duplicates: findDuplicates(f, Number(c.body.exclude_id) || 0), optouts: findOptOutMatches(f) };
});
route('POST', '/api/leads', (c) => {
  const f = normaliseLead(c.body, { source: 'other', status: 'new' });
  if (!f.business_name) throw bad('Business name is required.');
  if (!f.source) f.source = 'other';
  const dups = findDuplicates(f);
  const opts = findOptOutMatches(f);
  if ((dups.length || opts.length) && !c.body.force) throw new HttpError(409, 'Possible duplicate', { duplicates: dups, optouts: opts });
  if (opts.length) { f.opted_out = 1; f.opt_out_date = nowIso(); f.opt_out_channel = 'all'; }
  const id = tx(() => {
    const newId = insertLead(f);
    if (opts.length) db.prepare('INSERT INTO opt_outs(lead_id, business_name, phone_norm, email_norm, website_norm, name_city_key, at, channel, note) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(newId, f.business_name, f.phone_norm, f.email_norm, f.website_norm, f.name_city_key, nowIso(), 'all', 'Matched an earlier opt-out when added');
    return newId;
  });
  return { ...leadDetail(id), flagged_optout: opts.length > 0 };
});
route('GET', '/api/leads/:id', (c) => leadDetail(Number(c.params.id)));
route('PATCH', '/api/leads/:id', (c) => {
  const id = Number(c.params.id);
  const cur = getLeadRow(id);
  if (!cur) throw new HttpError(404, 'Lead not found');
  const body = { ...c.body };
  delete body.opted_out; delete body.opt_out_date; delete body.opt_out_channel; // only via the opt-out endpoints
  if (cur.opted_out) delete body.next_followup;
  const f = normaliseLead(body, cur);
  if (!f.business_name) throw bad('Business name is required.');
  if (!f.source) f.source = 'other';
  writeLead(id, f);
  return leadDetail(id);
});
route('DELETE', '/api/leads/:id', (c) => {
  const id = Number(c.params.id);
  const cur = getLeadRow(id);
  if (!cur) throw new HttpError(404, 'Lead not found');
  if (cur.opted_out && c.query.confirm !== cur.business_name) throw bad('This lead is opted out. Type the business name to delete it. The opt-out record is kept.');
  if (!cur.opted_out && c.query.confirm !== '1' && c.query.confirm !== cur.business_name) throw bad('Confirm the delete.');
  db.prepare('DELETE FROM leads WHERE id = ?').run(id);
  return { ok: true };
});
route('POST', '/api/leads/:id/contacts', (c) => addContact(Number(c.params.id), c.body, nowFrom(c.query)));
route('PATCH', '/api/contacts/:id', (c) => {
  const cur = db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(c.params.id));
  if (!cur) throw new HttpError(404, 'Entry not found');
  const content = 'content' in c.body ? clean(c.body.content) : cur.content;
  const note = 'note' in c.body ? clean(c.body.note) : cur.note;
  let at = cur.at;
  if (c.body.at) { const d = new Date(c.body.at); if (isNaN(d)) throw bad('Bad date/time.'); at = d.toISOString(); }
  const outcome = c.body.outcome || cur.outcome;
  if (!Lib.OUTCOMES[cur.channel].includes(outcome)) throw bad('Outcome not valid for this channel.');
  db.prepare('UPDATE contacts SET content=?, note=?, at=?, outcome=? WHERE id=?').run(content, note, at, outcome, cur.id);
  return leadDetail(cur.lead_id);
});
route('DELETE', '/api/contacts/:id', (c) => {
  const cur = db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(c.params.id));
  if (!cur) throw new HttpError(404, 'Entry not found');
  db.prepare('DELETE FROM contacts WHERE id = ?').run(cur.id);
  return leadDetail(cur.lead_id);
});
route('POST', '/api/leads/:id/optout', (c) => optOut(Number(c.params.id), c.body));
route('POST', '/api/leads/:id/optout/remove', (c) => removeOptOut(Number(c.params.id), c.body));
route('PUT', '/api/leads/:id/deal', (c) => putDeal(Number(c.params.id), c.body));

/* views */
route('GET', '/api/today', (c) => todayData(nowFrom(c.query), c.query.follow_limit));
route('GET', '/api/followups', (c) => followupsData(nowFrom(c.query), c.query));
route('GET', '/api/calls', (c) => callsData(nowFrom(c.query), c.query.period, c.query.ready_limit));
route('GET', '/api/outreach/day', (c) => outreachDay(c.query.day || Lib.dayKey(nowFrom(c.query), getSettings().my_timezone), nowFrom(c.query)));
route('PUT', '/api/outreach/day', (c) => setOutreach(c.body, nowFrom(c.query)));
route('GET', '/api/calls/day', (c) => dayData(c.query.day || Lib.dayKey(nowFrom(c.query), getSettings().my_timezone), nowFrom(c.query)));
route('PUT', '/api/calls/day', (c) => setDay(c.body, nowFrom(c.query)));
route('GET', '/api/calls/history', (c) => dayHistory(nowFrom(c.query)));
route('GET', '/api/stats', (c) => statsData(nowFrom(c.query), Math.min(Number(c.query.days) || 14, 90), Math.min(Number(c.query.weeks) || 8, 26)));
route('GET', '/api/pipeline', (c) => {
  const now = nowFrom(c.query);
  const rows = db.prepare(`SELECT l.id, l.business_name, l.owner_name, l.city, l.state, l.trade, l.status, l.next_followup, l.opted_out, d.deal_value, d.call_at, d.signed_date
    FROM leads l LEFT JOIN deals d ON d.lead_id = l.id ORDER BY (l.next_followup IS NULL), l.next_followup, l.id`).all();
  const columns = Object.fromEntries(Lib.BOARD.map((st) => [st, []]));
  const counts = Object.fromEntries(Lib.STATUSES.map((st) => [st, 0]));
  for (const r of rows) {
    counts[r.status]++;
    if (columns[r.status] && columns[r.status].length < 80) columns[r.status].push({ ...r, opted_out: !!r.opted_out });
  }
  return { board: Lib.BOARD, columns, counts, goal: goalData(now), today: Lib.dayKey(now, getSettings().my_timezone) };
});

route('GET', '/api/email', (c) => emailData(nowFrom(c.query)));
route('POST', '/api/email/snapshot', (c) => saveSnapshot(c.body));
route('GET', '/api/zapmail/status', () => zapmailStatus());
route('PUT', '/api/zapmail/key', async (c) => {
  const key = String(c.body.key || '').trim();
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(key)) throw bad('That does not look like a Zapmail key. It is 36 characters with dashes, like 1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed.');
  setSetting('zapmail_key_enc', encryptText(key));
  setSetting('zapmail_key_hint', key.slice(-4));
  try { const r = await zapmailSync(); return { ...zapmailStatus(), synced: true, mailboxes: r.mailboxes }; } catch (e) {
    if (e.zm === 'bad_key') { setSetting('zapmail_key_enc', ''); setSetting('zapmail_key_hint', ''); }
    throw e;
  }
});
route('DELETE', '/api/zapmail/key', () => { setSetting('zapmail_key_enc', ''); setSetting('zapmail_key_hint', ''); setSetting('zapmail_last_error', ''); return zapmailStatus(); });
route('POST', '/api/zapmail/sync', async () => { const r = await zapmailSync(); return { ...zapmailStatus(), synced: true, mailboxes: r.mailboxes }; });

/* import / export / backups */
route('POST', '/api/import/preview', (c) => importPreview(c.body));
route('POST', '/api/import/commit', (c) => importCommit(c.body));
route('GET', '/api/export/:name', (c, req, res) => {
  const n = c.params.name;
  const map = { 'leads.csv': csvLeads, 'contacts.csv': csvContacts, 'deals.csv': csvDeals, 'opt_outs.csv': csvOptOuts };
  if (n === 'all.zip') {
    const files = Object.entries(map).map(([name, fn]) => ({ name, data: Buffer.from('﻿' + fn(), 'utf8') }));
    send(res, 200, zipFiles(files), { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="lead-tracker-export.zip"' });
    return null;
  }
  if (!map[n]) throw new HttpError(404, 'Unknown export');
  send(res, 200, Buffer.from('﻿' + map[n](), 'utf8'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${n}"` });
  return null;
});
route('GET', '/api/backups', () => ({ backups: listBackups() }));
route('POST', '/api/backups/run', () => ({ name: runBackup('manual'), backups: listBackups() }));
route('POST', '/api/demo/clear', (c) => {
  if (c.body.confirm !== 'DELETE DEMO') throw bad('Type DELETE DEMO to confirm.');
  const r = db.prepare('DELETE FROM leads WHERE is_demo = 1').run();
  db.prepare('DELETE FROM opt_outs WHERE lead_id NOT IN (SELECT id FROM leads) AND business_name IN (SELECT business_name FROM opt_outs WHERE 0)').run();
  return { deleted: Number(r.changes) };
});
route('GET', '/api/health', () => ({ ok: true, time: nowIso() }), { open: true });

/* ---------------- server ---------------- */
async function handleApi(req, res, url) {
  const q = Object.fromEntries(url.searchParams);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    if (!r.open && !authed(req)) return send(res, 401, { error: 'Not signed in' });
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
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return undefined;
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e.message || 'Server error', ...(e.extra || {}) });
  }
});

function start() {
  const last = listBackups()[0];
  if (!last || Date.now() - new Date(last.at).getTime() > 3600000) { try { runBackup('start'); } catch (e) { console.error('backup failed', e.message); } }
  const t = setInterval(() => { try { runBackup('auto'); } catch (e) { console.error('backup failed', e.message); } }, 3 * 3600000);
  t.unref();
  const zt = setInterval(() => { if (rawSetting('zapmail_key_enc')) zapmailSync().catch(() => { /* the error is saved and shown on the Email page */ }); }, 3 * 3600000);
  zt.unref();
  if (rawSetting('zapmail_key_enc')) zapmailSync().catch(() => { /* shown on the Email page */ });
  server.listen(PORT, HOST, () => console.log(`Lead Tracker running at http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}  (data: ${DATA_DIR})`));
}
if (require.main === module) start();
module.exports = { server, db, start, runBackup, saveSnapshot, normaliseLead, insertLead, addContact, optOut, putDeal, getSettings, setSetting, PORT, HOST, DATA_DIR };
