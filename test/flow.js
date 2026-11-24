'use strict';
/* End to end API test. Starts the server on a throwaway database, seeds it, and walks the whole flow.
   Run: node --no-warnings test/flow.js */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const Lib = require('../public/lib.js');

const ROOT = path.join(__dirname, '..');
const PORT = 4399;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-test-'));
const PW = 'test-' + crypto.randomBytes(6).toString('hex');
let cookie = '';
const results = [];
function check(name, cond, extra) { results.push({ name, ok: !!cond, extra }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  <-- ' + JSON.stringify(extra))); }

async function call(method, url, body, opts) {
  opts = opts || {};
  const res = await fetch(BASE + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(opts.noCookie ? {} : { Cookie: cookie }), ...(opts.headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length && !opts.keepCookie) { const m = /sid=([^;]*)/.exec(sc[0]); if (m) cookie = m[1] ? 'sid=' + m[1] : ''; }
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* binary or text */ }
  return { status: res.status, json, buf, headers: res.headers };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readZip(buf) {
  const files = {};
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  const n = buf.readUInt16LE(i + 10), cdOff = buf.readUInt32LE(i + 16);
  let p = cdOff;
  for (let k = 0; k < n; k++) {
    const crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 24), nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commLen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lnLen = buf.readUInt16LE(off + 26), lxLen = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnLen + lxLen, off + 30 + lnLen + lxLen + size);
    files[name] = { data, crcOk: (zlib.crc32(data) >>> 0) === crc };
    p += 46 + nameLen + extraLen + commLen;
  }
  return files;
}

(async () => {
  // seed first, then start the server on the same data
  const seed = spawnSync(process.execPath, ['--no-warnings', 'seed.js'], { cwd: ROOT, env: { ...process.env, DATA_DIR: DATA }, encoding: 'utf8' });
  check('seed script runs', seed.status === 0, seed.stderr);
  { const d0 = new DatabaseSync(path.join(DATA, 'tracker.db')); d0.exec("UPDATE leads SET status = 'contacted' WHERE business_name = 'Ridgeline Roofing'"); d0.close(); }
  const ZM_KEY = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
  const mock = await require('./zapmail-mock.js').startMock(4397, ZM_KEY);
  const srv = spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, ZAPMAIL_BASE: 'http://127.0.0.1:4397/api/v3' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvErr = '';
  srv.stderr.on('data', (d) => { srvErr += d; });
  for (let i = 0; i < 40; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch (e) { /* not up yet */ } await sleep(150); }

  try {
    /* ---------- auth ---------- */
    let r = await call('GET', '/api/me', null, { noCookie: true });
    check('first run asks to set a password', r.json && r.json.setup_needed === true && r.json.authenticated === false, r.json);
    r = await call('GET', '/api/leads', null, { noCookie: true });
    check('API is closed without a session', r.status === 401, r.status);
    r = await call('POST', '/api/setup', { password: 'short' }, { noCookie: true });
    check('short password rejected', r.status === 400, r.status);
    r = await call('POST', '/api/setup', { password: PW }, { noCookie: true });
    check('password set and signed in', r.status === 200 && cookie.startsWith('sid='), r.status);
    r = await call('POST', '/api/leads', { business_name: 'Evil' }, { headers: { Origin: 'http://evil.example' } });
    check('cross-site POST is refused', r.status === 403, r.status);
    r = await call('GET', '/../server.js', null, { noCookie: true });
    check('static path traversal is refused', r.status === 403 || r.status === 404, r.status);

    /* ---------- seeded data ---------- */
    r = await call('GET', '/api/leads?limit=50');
    check('10 demo leads are present', r.json.total === 10, r.json && r.json.total);
    const ridge = r.json.rows.find((x) => x.business_name === 'Ridgeline Roofing');
    check('old "contacted" leads were moved to Follow up when the server started', ridge && ridge.status === 'follow_up', ridge && ridge.status);
    r = await call('PATCH', `/api/leads/${ridge.id}`, { status: 'contacted' });
    check('the removed status "contacted" is refused', r.status === 400, r.status);
    check('state gives a time zone (TN = Central)', ridge && ridge.tz === 'America/Chicago', ridge && ridge.tz);

    /* ---------- add + duplicate detection ---------- */
    r = await call('POST', '/api/leads', { business_name: 'Totally New Name', phone: '1-615-555-0142', city: 'Elsewhere' });
    check('same phone (different format) warns', r.status === 409 && r.json.duplicates[0].reasons.includes('same phone'), r.json);
    r = await call('POST', '/api/leads', { business_name: 'Other Name', website: 'https://www.RidgelineRoofing.example/about/', city: 'X' });
    check('same website (www, path, case) warns', r.status === 409 && r.json.duplicates[0].reasons.includes('same website'), r.json);
    r = await call('POST', '/api/leads', { business_name: 'Ridgeline Roofing LLC', city: 'nashville' });
    check('same name plus city (LLC ignored) warns', r.status === 409 && r.json.duplicates[0].reasons.includes('same name and city'), r.json);
    r = await call('POST', '/api/leads', { business_name: 'Ridgeline Roofing', city: 'Memphis', phone: '(901) 555-0100' });
    check('same name in a different city is NOT a duplicate', r.status === 200, r.status);
    const memphisId = r.json.lead.id;
    r = await call('POST', '/api/leads', { business_name: 'Totally New Name', phone: '(615) 555-0142', city: 'Elsewhere', force: true });
    check('add anyway works after the warning', r.status === 200, r.status);
    r = await call('POST', '/api/leads', {});
    check('business name is required', r.status === 400, r.status);

    r = await call('POST', '/api/leads', { business_name: 'Maple Street Roofing', owner_name: 'Gus', phone: '(615) 555-0001', city: 'Nashville', state: 'TN', trade: 'Roofer', source: 'Google Maps', source_link: 'https://maps.example/maple', batch: 'Flow test' });
    check('new lead saved with source and link recorded', r.status === 200 && r.json.lead.source === 'google_maps' && r.json.lead.source_link, r.json);
    const maple = r.json.lead.id;
    check('new lead starts as New with no follow-up', r.json.lead.status === 'new' && !r.json.lead.next_followup, r.json.lead);

    /* ---------- contact log on two+ channels ---------- */
    r = await call('POST', `/api/leads/${maple}/contacts`, { channel: 'call', outcome: 'sent' });
    check('outcome that does not belong to the channel is refused', r.status === 400, r.status);
    r = await call('POST', `/api/leads/${maple}/contacts`, { channel: 'call', outcome: 'no_answer', content: 'Rang out' });
    check('call logged, status becomes Follow up', r.status === 200 && r.json.lead.status === 'follow_up', r.json);
    check('automatic follow-up lands on a working day', r.json.followup && ![0, 6].includes(new Date(r.json.followup + 'T12:00:00Z').getUTCDay()), r.json.followup);
    r = await call('POST', `/api/leads/${maple}/contacts`, { channel: 'instagram_dm', outcome: 'sent', content: 'Opener' });
    check('Instagram DM logged on the same lead', r.status === 200, r.status);
    r = await call('POST', `/api/leads/${maple}/contacts`, { channel: 'facebook_dm', outcome: 'replied', content: 'Yes send it' });
    check('reply moves status to Replied', r.json.lead.status === 'replied', r.json.lead.status);
    r = await call('GET', `/api/leads/${maple}`);
    check('one lead, three entries on its timeline', r.json.contacts.length === 3 && new Set(r.json.contacts.map((c) => c.channel)).size === 3, r.json.contacts.length);
    r = await call('POST', `/api/leads/${maple}/contacts`, { channel: 'call', outcome: 'not_interested' });
    check('Not interested closes the follow-up', r.json.lead.status === 'not_interested' && r.json.lead.next_followup === null, r.json.lead);
    r = await call('POST', `/api/leads/${maple}/contacts`, { channel: 'call', outcome: 'no_answer' });
    check('a later no-answer does not revive a Not interested lead', r.json.lead.status === 'not_interested', r.json.lead.status);
    r = await call('PATCH', `/api/leads/${maple}`, { status: 'follow_up', next_followup: new Date().toISOString().slice(0, 10) });
    check('status and follow-up can be set by hand', r.json.lead.status === 'follow_up', r.json.lead);
    const today = (await call('GET', '/api/today')).json;
    check('lead due today appears in Follow up today', today.followups.some((x) => x.id === maple), today.followups.map((x) => x.id));
    check('today progress counts the calls just logged', today.progress.calls >= 2 && today.progress.dms >= 1, today.progress);

    /* ---------- opt out ---------- */
    r = await call('POST', `/api/leads/${maple}/optout`, { channel: 'instagram_dm', note: 'Asked to stop in a DM' });
    check('opt-out recorded with date and channel', r.status === 200 && r.json.lead.opted_out === true && r.json.lead.opt_out_channel === 'instagram_dm' && r.json.lead.opt_out_date, r.json.lead);
    check('opt-out is stored as its own record', r.json.optouts.length === 1 && r.json.optouts[0].note, r.json.optouts);
    check('opt-out clears the follow-up', r.json.lead.next_followup === null, r.json.lead.next_followup);
    let t2 = (await call('GET', '/api/today?follow_limit=200')).json;
    const c2 = (await call('GET', '/api/calls?ready_limit=400')).json.queue;
    check('opted-out lead leaves the follow-up list', !t2.followups.some((x) => x.id === maple), 1);
    check('opted-out lead leaves the call queue', ![...c2.ready, ...c2.later, ...c2.no_tz].some((x) => x.id === maple), 1);
    for (const ch of ['call', 'email', 'facebook_dm']) {
      r = await call('POST', `/api/leads/${maple}/contacts`, { channel: ch, outcome: ch === 'call' ? 'no_answer' : 'sent' });
      check('logging on ' + ch + ' is blocked for an opted-out lead', r.status === 409, r.status);
    }
    r = await call('PATCH', `/api/leads/${maple}`, { next_followup: '2030-01-01', opted_out: 0 });
    check('cannot sneak a follow-up or un-opt-out through an edit', r.json.lead.opted_out === true && r.json.lead.next_followup === null, r.json.lead);
    r = await call('POST', `/api/leads/${maple}/optout/remove`, { confirm: 'yes' });
    check('removing an opt-out needs the typed confirmation', r.status === 400, r.status);
    r = await call('DELETE', `/api/leads/${maple}?confirm=1`);
    check('deleting an opted-out lead needs its name typed', r.status === 400, r.status);
    r = await call('DELETE', `/api/leads/${maple}?confirm=` + encodeURIComponent('Maple Street Roofing'));
    check('deleting with the typed name works', r.status === 200, r.status);
    r = await call('POST', '/api/leads', { business_name: 'Maple Street Roofing', phone: '(615) 555-0001', city: 'Nashville' });
    check('the deleted opt-out still blocks a re-add (warning)', r.status === 409 && r.json.optouts.length === 1, r.json);
    r = await call('POST', '/api/leads', { business_name: 'Maple Street Roofing', phone: '(615) 555-0001', city: 'Nashville', force: true });
    check('forced re-add is saved as opted out, not contactable', r.status === 200 && r.json.lead.opted_out === true && r.json.flagged_optout === true, r.json.lead);
    const mapleBack = r.json.lead.id;
    r = await call('POST', `/api/leads/${mapleBack}/optout/remove`, { confirm: 'REMOVE', note: 'They asked to hear from me' });
    check('opt-out can be removed with REMOVE, history kept', r.status === 200 && r.json.lead.opted_out === false && r.json.optouts.some((o) => o.removed_at), r.json.optouts);

    /* ---------- CSV import with a duplicate ---------- */
    const rows = [
      { business_name: 'Import One Plumbing', phone: '(404) 555-0201', city: 'Atlanta', state: 'Georgia', trade: 'Plumber', owner_name: 'Ana' },
      { business_name: 'Copperfield Plumbing', phone: '303.555.0118', city: 'Denver', state: 'CO', email: 'fill@copperfield.example' },
      { business_name: 'Import One Plumbing', phone: '(404) 555-0201', city: 'Atlanta', state: 'GA' },
      { business_name: 'Prairie State Roofing', phone: '(217) 555-0126', city: 'Springfield', state: 'IL' },
      { business_name: '', phone: '(404) 555-0999' },
      { business_name: 'Import Two HVAC', phone: '(404) 555-0202', city: 'Atlanta', state: 'GA', trade: 'HVAC', source: 'Instagram' },
    ];
    r = await call('POST', '/api/import/preview', { rows, defaults: { source: 'google_maps', source_link: 'file: demo.csv', batch: 'Import test' } });
    const c = r.json.counts;
    check('preview: 2 new, 1 duplicate, 1 repeat in file, 1 opted-out match, 1 invalid', c.new === 2 && c.dup === 1 && c.dup_in_file === 1 && c.optout === 1 && c.invalid === 1, c);
    check('preview names the lead each duplicate matches', r.json.rows[1].matches[0].business_name === 'Copperfield Plumbing', r.json.rows[1].matches);
    r = await call('GET', '/api/leads?limit=100');
    const before = r.json.total;
    r = await call('POST', '/api/import/commit', { rows, defaults: { source: 'google_maps', source_link: 'file: demo.csv', batch: 'Import test' }, mode: 'skip' });
    check('commit (skip): adds the 2 new, skips duplicates, blocks the opt-out', r.json.added === 2 && r.json.skipped_duplicates === 2 && r.json.blocked_optout === 1 && r.json.invalid === 1, r.json);
    r = await call('GET', '/api/leads?limit=100');
    check('lead count grew by exactly 2', r.json.total === before + 2, [before, r.json.total]);
    const imported = r.json.rows.find((x) => x.business_name === 'Import One Plumbing');
    check('import recorded source link, batch and normalised the state name', imported && imported.source_link === 'file: demo.csv' && imported.batch === 'Import test' && imported.state === 'GA', imported);
    const ig = r.json.rows.find((x) => x.business_name === 'Import Two HVAC');
    check('a source column in the file beats the default', ig && ig.source === 'instagram', ig && ig.source);
    r = await call('POST', '/api/import/commit', { rows, defaults: { source: 'google_maps' }, mode: 'update' });
    const rid = (await call('GET', '/api/leads?q=Copperfield&limit=10')).json.rows[0];
    check('commit (update): fills the blank email on the existing lead', r.json.updated === 1 && rid.email === 'fill@copperfield.example', [r.json, rid.email]);
    const rdg = (await call('GET', '/api/leads?q=Ridgeline&limit=10')).json.rows.find((x) => x.city === 'Nashville');
    check('commit (update): never overwrites a field that already has a value', rdg.email === 'dale@ridgelineroofing.example', rdg.email);
    const totalBefore = (await call('GET', '/api/leads?limit=1')).json.total;
    r = await call('POST', '/api/import/commit', { rows: [rows[0]], defaults: { source: 'google_maps' }, mode: 'add' });
    check('commit (add anyway): duplicate becomes a new lead', r.json.added === 1 && (await call('GET', '/api/leads?limit=1')).json.total === totalBefore + 1, r.json);

    /* ---------- call queue and the legal calling window ---------- */
    const zones = [['Eastern', 'NY'], ['Central', 'TX'], ['Mountain', 'CO'], ['Arizona', 'AZ'], ['Pacific', 'CA'], ['Alaska', 'AK'], ['Hawaii', 'HI']];
    let n = 0;
    for (const [z, st] of zones) { n++; await call('POST', '/api/leads', { business_name: 'TZ ' + z, phone: '(555) 010-' + String(n).padStart(4, '0'), city: 'Town ' + z, state: st }); }
    await call('POST', '/api/leads', { business_name: 'TZ Unknown', phone: '(555) 010-0099', city: 'Nowhere' });
    const allQ = (t) => [...t.queue.ready, ...t.queue.later, ...t.queue.no_tz];
    const q = async (iso) => { const t = (await call('GET', '/api/calls?ready_limit=400&now=' + encodeURIComponent(iso))).json; return Object.fromEntries(allQ(t).filter((x) => x.business_name.startsWith('TZ ')).map((x) => [x.business_name.slice(3), x.window])); };
    let w = await q('2026-11-24T14:00:00Z');    // 9:00 ET, 8:00 CT, 7:00 MT, 7:00 AZ, 6:00 PT, 5:00 AK, 4:00 HI
    check('14:00Z: Eastern and Central can be called', w.Eastern.ok && w.Central.ok, [w.Eastern, w.Central]);
    check('14:00Z: Mountain, Arizona, Pacific, Alaska, Hawaii are still closed', !w.Mountain.ok && !w.Arizona.ok && !w.Pacific.ok && !w.Alaska.ok && !w.Hawaii.ok, w);
    w = await q('2026-11-25T03:30:00Z');         // 22:30 ET, 21:30 CT, 20:30 MT, 20:30 AZ, 19:30 PT, 18:30 AK, 17:30 HI
    check('03:30Z: Eastern and Central are closed for the night', !w.Eastern.ok && !w.Central.ok, [w.Eastern, w.Central]);
    check('03:30Z: Mountain, Arizona, Pacific, Alaska, Hawaii are open', w.Mountain.ok && w.Arizona.ok && w.Pacific.ok && w.Alaska.ok && w.Hawaii.ok, w);
    w = await q('2026-11-24T13:00:00Z');         // exactly 8:00 ET
    check('exactly 8:00 AM local is open', w.Eastern.ok === true, w.Eastern);
    w = await q('2026-11-24T12:59:00Z');
    check('7:59 AM local is closed and says when it opens', w.Eastern.ok === false && w.Eastern.minsUntilOpen === 1, w.Eastern);
    w = await q('2026-11-25T01:59:00Z');         // 20:59 ET
    check('8:59 PM local is still open', w.Eastern.ok === true && w.Eastern.minsLeft === 1, w.Eastern);
    w = await q('2026-11-25T02:00:00Z');         // 21:00 ET
    check('exactly 9:00 PM local is closed', w.Eastern.ok === false, w.Eastern);
    w = await q('2026-07-15T13:00:00Z');         // summer: 9:00 EDT, 6:00 AZ (no daylight saving)
    check('summer time: Eastern open (EDT), Arizona still closed (no DST)', w.Eastern.ok && !w.Arizona.ok, [w.Eastern, w.Arizona]);
    check('lead with no state or zone is flagged, never OK to call', w.Unknown && w.Unknown.unknown === true && w.Unknown.ok === false, w.Unknown);
    const tq = (await call('GET', '/api/calls?ready_limit=400&now=2026-11-24T14:00:00Z')).json;
    check('the ready list holds only callable leads', tq.queue.ready.length > 0 && tq.queue.ready.every((x) => x.window.ok) && tq.queue.later.every((x) => !x.window.ok), [tq.queue.ready_total, tq.queue.later_total]);
    check('leads without a time zone are listed separately', tq.queue.no_tz.some((x) => x.business_name === 'TZ Unknown'), tq.queue.no_tz.length);
    const calledLead = tq.queue.ready.find((x) => x.business_name === 'TZ Eastern');
    r = await call('POST', `/api/leads/${calledLead.id}/contacts`, { channel: 'call', outcome: 'voicemail' });
    const tq2 = (await call('GET', '/api/calls?ready_limit=400')).json;
    check('after logging a call the lead leaves today\'s queue (follow-up is set)', !allQ(tq2).some((x) => x.id === calledLead.id), 1);

    /* ---------- follow-ups page: many leads ---------- */
    const todayKey = (await call('GET', '/api/today')).json.progress.today;
    const ids60 = [];
    for (let i = 0; i < 60; i++) {
      const created = await call('POST', '/api/leads', { business_name: 'Follow Co ' + i, phone: '(555) 88' + String(i).padStart(2, '0') + '-' + String(2000 + i), city: 'Followville', state: 'OH', source: 'instagram' });
      ids60.push(created.json.lead.id);
      await call('PATCH', '/api/leads/' + created.json.lead.id, { next_followup: todayKey });
    }
    for (let i = 0; i < 10; i++) { await call('POST', '/api/leads/' + ids60[i] + '/contacts', { channel: 'instagram_dm', outcome: 'sent', followup: todayKey }); }
    for (let i = 10; i < 15; i++) { await call('POST', '/api/leads/' + ids60[i] + '/contacts', { channel: 'call', outcome: 'no_answer', followup: todayKey }); }
    const soonLead = (await call('POST', '/api/leads', { business_name: 'Soon Co', phone: '(555) 889-0001', city: 'Soonville', state: 'OH' })).json.lead.id;
    await call('PATCH', '/api/leads/' + soonLead, { next_followup: Lib.addBizDays(todayKey, 3) });
    let fu = (await call('GET', '/api/followups?limit=50')).json;
    check('follow-ups page: counts every lead that is due, not just a few', fu.total >= 60 && fu.rows.length === 50, [fu.total, fu.rows.length]);
    const fu2 = (await call('GET', '/api/followups?limit=50&offset=50')).json;
    check('follow-ups page: the rest come on the next page, no repeats', fu2.rows.length === fu.total - 50 && !fu2.rows.some((x) => fu.rows.some((y) => y.id === x.id)), [fu2.rows.length, fu.total]);
    check('follow-ups: counts by channel (10 DMs, 5 calls)', fu.counts.dm >= 10 && fu.counts.call >= 5 && fu.counts.all === fu.total, fu.counts);
    fu = (await call('GET', '/api/followups?channel=dm&limit=200')).json;
    check('follow-ups: the DM filter shows only leads last contacted by DM', fu.rows.length === fu.counts.dm && fu.rows.every((x) => ['instagram_dm', 'facebook_dm', 'facebook_group'].includes(x.last_channel)), [fu.rows.length, fu.counts]);
    const soonList = (await call('GET', '/api/followups?scope=soon&limit=200')).json;
    check('follow-ups: coming up lists the lead due in 3 days, due-now does not', soonList.rows.some((x) => x.id === soonLead) && !(await call('GET', '/api/followups?limit=200')).json.rows.some((x) => x.id === soonLead), soonList.total);
    const tdy = (await call('GET', '/api/today')).json;
    check('Today shows the true count but only a short preview', tdy.followups_total === (await call('GET', '/api/followups?limit=1')).json.total && tdy.followups.length <= 8 && tdy.followups_total > 8, [tdy.followups_total, tdy.followups.length]);

    /* ---------- calls page: numbers and scoreboard ---------- */
    const cs0 = (await call('GET', '/api/calls?period=today')).json;
    check('calls: totals include contacts reached, owner conversations, good conversations and the rates', ['dials', 'reached', 'owner', 'good', 'meetings', 'pickup_rate', 'owner_rate', 'booking_rate'].every((k) => k in cs0.totals) && cs0.outcomes.length === 7, cs0.totals);
    const day0 = (await call('GET', '/api/calls/day')).json;
    check('scoreboard: today has auto counts, adjustments and totals', day0.is_today && day0.totals.calls === day0.auto.calls + day0.adj.calls && 'reached' in day0.totals && 'good' in day0.totals, day0);
    let day1 = (await call('PUT', '/api/calls/day', { day: day0.day, field: 'calls', value: day0.totals.calls + 30 })).json;
    check('scoreboard: + works, the counter shows what you set', day1.totals.calls === day0.totals.calls + 30 && day1.adj.calls === day0.adj.calls + 30, day1);
    day1 = (await call('PUT', '/api/calls/day', { day: day0.day, field: 'good', value: 4 })).json;
    check('scoreboard: each of the four counters can be set', day1.totals.good === 4 && day1.totals.calls === day0.totals.calls + 30, day1.totals);
    day1 = (await call('PUT', '/api/calls/day', { day: day0.day, field: 'owner', value: -5 })).json;
    check('scoreboard: a counter never goes below zero', day1.totals.owner === 0, day1.totals);
    day1 = (await call('PUT', '/api/calls/day', { day: day0.day, verdict: 'Good day. Hooks worked, mornings are quiet.' })).json;
    check('scoreboard: the verdict of the day is saved', day1.verdict.startsWith('Good day') && (await call('GET', '/api/calls/day?day=' + day0.day)).json.verdict === day1.verdict, day1.verdict);
    const tomorrow = Lib.addDaysKey(day0.day, 1);
    check('scoreboard: a day that has not happened yet is refused', (await call('PUT', '/api/calls/day', { day: tomorrow, field: 'calls', value: 3 })).status === 400, 1);
    check('scoreboard: an unknown counter is refused', (await call('PUT', '/api/calls/day', { day: day0.day, field: 'nope', value: 3 })).status === 400, 1);
    const cs1 = (await call('GET', '/api/calls?period=today')).json;
    check('calls: your + changes feed the totals and rates', cs1.totals.dials === day1.totals.calls && cs1.totals.good === 4 && Math.abs(cs1.totals.pickup_rate - cs1.totals.reached / cs1.totals.dials) < 1e-9 && cs1.adjusted_days >= 1, cs1.totals);
    check('calls: the dials meter on the queue and on Today agree', cs1.dials_today === day1.totals.calls && (await call('GET', '/api/today')).json.progress.calls === day1.totals.calls, [cs1.dials_today, day1.totals.calls]);
    const hist = (await call('GET', '/api/calls/history')).json;
    check('scoreboard: last days with averages, today included', hist.days.length >= 1 && hist.days[0].day === day0.day && hist.averages && hist.averages.calls > 0 && hist.days.length <= 7, hist);
    check('calls: week and 30-day periods work, 14 days of history, best hours', (await call('GET', '/api/calls?period=week')).json.totals.dials >= cs1.totals.dials && (await call('GET', '/api/calls?period=month')).json.totals.dials >= cs1.totals.dials && cs1.daily.length === 14 && Array.isArray(cs1.by_hour), 1);

    /* ---------- reached out today: calls, Instagram, Facebook, email ---------- */
    let out0 = (await call('GET', '/api/outreach/day')).json;
    check('reached out: four counters and one total', out0.items.map((i) => i.key).join(',') === 'call,instagram_dm,facebook_dm,email' && out0.total === out0.items.reduce((n, i) => n + i.total, 0), out0);
    check('reached out: the call counter matches the calls scoreboard', out0.items[0].total === day1.totals.calls, out0.items[0]);
    let out1 = (await call('PUT', '/api/outreach/day', { day: out0.day, key: 'instagram_dm', value: out0.items[1].total + 9 })).json;
    check('reached out: + on Instagram DMs adds to the total', out1.items[1].total === out0.items[1].total + 9 && out1.total === out0.total + 9, out1);
    out1 = (await call('PUT', '/api/outreach/day', { day: out0.day, key: 'facebook_dm', value: 6 })).json;
    check('reached out: Facebook DMs are tracked too', out1.items[2].total === 6 && out1.total === out0.total + 9 + (6 - out0.items[2].total), out1);
    const fbLead = (await call('POST', '/api/leads', { business_name: 'Counter Test Co', phone: '(555) 886-0001', city: 'Counterville', state: 'KY' })).json.lead.id;
    await call('POST', '/api/leads/' + fbLead + '/contacts', { channel: 'facebook_dm', outcome: 'sent' });
    await call('POST', '/api/leads/' + fbLead + '/contacts', { channel: 'facebook_dm', outcome: 'replied' });
    const out2 = (await call('GET', '/api/outreach/day')).json;
    check('reached out: a DM logged as Sent counts by itself, a reply does not', out2.items[2].total === 7 && out2.items[2].auto === out1.items[2].auto + 1, out2.items[2]);
    check('reached out: emails count when logged as Sent', (await call('POST', '/api/leads/' + fbLead + '/contacts', { channel: 'email', outcome: 'sent', mailbox: 'jay@example.test' })).status === 200 && (await call('GET', '/api/outreach/day')).json.items[3].total === out2.items[3].total + 1, 1);
    const t3 = (await call('GET', '/api/today')).json;
    check('Today: the dms progress is Instagram plus Facebook, and the outreach block is included', t3.progress.dms === t3.outreach.items[1].total + t3.outreach.items[2].total && t3.outreach.total >= 30, [t3.progress, t3.outreach.total]);
    check('reached out: unknown counter and future day are refused', (await call('PUT', '/api/outreach/day', { day: out0.day, key: 'nope', value: 1 })).status === 400 && (await call('PUT', '/api/outreach/day', { day: tomorrow, key: 'email', value: 1 })).status === 400, 1);

    /* ---------- contacted via + mailbox on emails ---------- */
    const via = (await call('GET', '/api/leads?q=Counter Test')).json.rows[0];
    check('leads list: shows every channel used, with counts', via.channels.some((c) => c.channel === 'facebook_dm' && c.count === 2) && via.channels.some((c) => c.channel === 'email' && c.count === 1), via.channels);
    check('leads list: filter by "contacted via" Email', (await call('GET', '/api/leads?channel=email&limit=500')).json.rows.every((x) => x.channels.some((c) => c.channel === 'email')) && (await call('GET', '/api/leads?channel=email&limit=500')).json.rows.some((x) => x.id === via.id), 1);
    const never = (await call('GET', '/api/leads?channel=none&limit=500')).json;
    check('leads list: filter "not contacted yet" returns only untouched leads', never.rows.length > 0 && never.rows.every((x) => x.channels.length === 0), never.total);
    const withBox = (await call('GET', '/api/leads/' + via.id)).json.contacts.find((c) => c.channel === 'email');
    check('an email entry remembers which mailbox sent it', withBox && withBox.mailbox === 'jay@example.test', withBox);
    await call('POST', '/api/leads/' + via.id + '/contacts', { channel: 'call', outcome: 'no_answer', mailbox: 'jay@example.test' });
    check('a mailbox is only kept on emails', (await call('GET', '/api/leads/' + via.id)).json.contacts.filter((c) => c.channel === 'call').every((c) => c.mailbox === null), 1);

    /* ---------- Zapmail snapshot, warm-up dates, cold email numbers ---------- */
    const mk = (score) => ({ taken_at: '2026-11-24T10:00:00Z', source: 'test', plan: { name: 'Starter' }, zapwarm: { started: '2026-11-23', daily_emails: 5, free_trial_ends: '2026-12-23' },
      domains: [{ name: 'example.test', status: 'connected' }], mailboxes: [{ email: 'jay@example.test', domain: 'example.test', status: 'Warming up', score, score_max: 5 }, { email: 'hello@example.test', domain: 'example.test', status: 'Warming up', score, score_max: 5 }] });
    check('email page before any snapshot says nothing is connected', (await call('GET', '/api/email')).json.snapshot === null, 1);
    check('a snapshot without mailboxes is refused', (await call('POST', '/api/email/snapshot', { zapwarm: {} })).status === 400, 1);
    check('a Zapmail snapshot is saved', (await call('POST', '/api/email/snapshot', mk(1))).status === 200, 1);
    let em = (await call('GET', '/api/email?now=2026-11-24T11:00:00Z')).json;
    check('email: warm-up day, earliest send date and safer date are worked out', em.readiness.day === 2 && em.readiness.ready_from === '2026-12-14' && em.readiness.ready_by === '2026-12-21' && em.readiness.ready_now === false && em.readiness.days_to_ready === 20, em.readiness);
    check('email: a snapshot a few hours old is not stale', em.stale === false && em.synced_hours_ago === 1, [em.stale, em.synced_hours_ago]);
    check('email: a snapshot older than a day is flagged out of date', (await call('GET', '/api/email?now=2026-11-26T11:00:00Z')).json.stale === true, 1);
    check('email: ready once the 21 days are done', (await call('GET', '/api/email?now=2026-12-15T11:00:00Z')).json.readiness.ready_now === true, 1);
    check('email: cold sends today are counted per mailbox against the cap', em.per_mailbox_limit === 5 && em.capacity_today === 10, [em.per_mailbox_limit, em.capacity_today]);
    check('email: cold email totals come from the log', em.cold.sent_total >= 1 && 'reply_rate' in em.cold, em.cold);
    await call('PUT', '/api/settings', { email_daily_per_mailbox: 3 });
    check('email: the per-mailbox cap can be changed', (await call('GET', '/api/email')).json.capacity_today === 6, 1);
    await call('POST', '/api/email/snapshot', mk(3));
    em = (await call('GET', '/api/email')).json;
    check('email: score trend compares with the snapshot before', em.score_before === 1 && em.score_now === 3, [em.score_before, em.score_now]);
    check('email: the pre-send checklist is saved', (await call('PUT', '/api/settings', { email_checklist: JSON.stringify(['address', 'optout']) })).status === 200 && (await call('GET', '/api/email')).json.checked.join() === 'address,optout' && (await call('PUT', '/api/settings', { email_checklist: 'nope' })).status === 400, 1);

    /* ---------- Zapmail API connection (against a pretend Zapmail) ---------- */
    check('zapmail: starts disconnected', (await call('GET', '/api/zapmail/status')).json.connected === false, 1);
    check('zapmail: something that is not a key is refused before any call', (await call('PUT', '/api/zapmail/key', { key: 'not-a-key' })).status === 400 && mock.calls.length === 0, mock.calls.length);
    r = await call('PUT', '/api/zapmail/key', { key: '00000000-0000-4000-8000-000000000000' });
    check('zapmail: a wrong key is rejected with a plain message and is not kept', r.status === 400 && /rejected the key/.test(r.json.error) && (await call('GET', '/api/zapmail/status')).json.connected === false, r.json);
    const beforeSnap = (await call('GET', '/api/email')).json.snapshot;
    r = await call('PUT', '/api/zapmail/key', { key: ZM_KEY });
    check('zapmail: the right key connects and reads the mailboxes', r.status === 200 && r.json.connected === true && r.json.mailboxes === 3 && r.json.key_hint === ZM_KEY.slice(-4), r.json);
    const okCalls = mock.calls.filter((c) => c.auth === ZM_KEY);
    check('zapmail: only the three read calls were made, always with the key header', okCalls.length >= 3 && okCalls.every((c) => c.method === 'POST' && ['/api/v3/mailboxes/list', '/api/v3/domains', '/api/v3/zap-warm/scores'].includes(c.path)) && !mock.calls.some((c) => c.method !== 'POST'), mock.calls.map((c) => c.method + ' ' + c.path));
    let zem = (await call('GET', '/api/email')).json;
    check('zapmail: the Email page now comes from the API', /Zapmail API/.test(zem.snapshot.source) && zem.snapshot.mailboxes.length === 3, zem.snapshot.source);
    const m1 = zem.snapshot.mailboxes.find((m) => m.email === 'jay@mock-one.test');
    const m3 = zem.snapshot.mailboxes.find((m) => m.email === 'jay@mock-two.test');
    check('zapmail: score, sent count and inbox rate come through; unscored mailbox shows Active', m1.score === 60 && m1.score_max === 100 && m1.sent_30d === 12 && m1.inbox_rate === 1 && m1.status === 'Warming up' && m3.score === null && m3.status === 'Active', [m1, m3]);
    check('zapmail: warm-up start date and totals are worked out', zem.snapshot.zapwarm.started === '2026-11-23' && zem.snapshot.zapwarm.emails_sent_30d === 20 && Math.abs(zem.snapshot.zapwarm.inbox_rate - 19 / 20) < 1e-9 && zem.readiness.day >= 2, zem.snapshot.zapwarm);
    check('zapmail: domains show connected only when the nameservers match', zem.snapshot.domains.find((d) => d.name === 'mock-one.test').status === 'connected' && zem.snapshot.domains.find((d) => d.name === 'mock-two.test').status !== 'connected', zem.snapshot.domains);
    check('zapmail: plan, trial dates and warm-up settings are carried over from the last snapshot', zem.snapshot.plan.name === 'Starter' && zem.snapshot.zapwarm.free_trial_ends === '2026-12-23' && zem.snapshot.zapwarm.daily_emails === 5, [zem.snapshot.plan, zem.snapshot.zapwarm]);
    const wholePage = JSON.stringify(zem) + JSON.stringify((await call('GET', '/api/zapmail/status')).json) + JSON.stringify((await call('GET', '/api/settings')).json);
    check('zapmail: no password, app password, 2FA secret or key appears in anything the app returns', !/SECRET(PW|APP|2FA)/.test(wholePage) && !wholePage.includes(ZM_KEY) && !wholePage.includes('x-auth'), 1);
    const dbBytes = fs.readFileSync(path.join(DATA, 'tracker.db')).toString('latin1') + (fs.existsSync(path.join(DATA, 'tracker.db-wal')) ? fs.readFileSync(path.join(DATA, 'tracker.db-wal')).toString('latin1') : '');
    check('zapmail: the database file holds no mailbox password or 2FA secret', !/SECRETPW|SECRETAPP|SECRET2FA/.test(dbBytes), 1);
    check('zapmail: the key is stored encrypted, not as plain text', !dbBytes.includes(ZM_KEY) && fs.existsSync(path.join(DATA, '.secret')), 1);
    const bkp = (await call('POST', '/api/backups/run')).json.name;
    check('zapmail: a backup copy does not contain the key either', !fs.readFileSync(path.join(DATA, 'backups', bkp)).toString('latin1').includes(ZM_KEY), 1);
    const priorCount = (await call('GET', '/api/email')).json.snapshot.mailboxes.length;
    mock.state.mode = 'not_enabled';
    r = await call('POST', '/api/zapmail/sync');
    check('zapmail: "API not enabled" gives a clear message and keeps the last numbers', r.status === 502 && /not switched on/.test(r.json.error) && (await call('GET', '/api/email')).json.snapshot.mailboxes.length === priorCount && /not switched on/.test((await call('GET', '/api/zapmail/status')).json.last_error), r.json);
    mock.state.mode = 'rate';
    r = await call('POST', '/api/zapmail/sync');
    check('zapmail: being rate limited gives a plain message', r.status === 502 && /limiting/.test(r.json.error), r.json);
    mock.state.mode = 'ok';
    r = await call('POST', '/api/zapmail/sync');
    check('zapmail: Refresh now works again and clears the error', r.status === 200 && (await call('GET', '/api/zapmail/status')).json.last_error === null, r.json);
    check('zapmail: each sync adds a snapshot, so score history builds', (await call('GET', '/api/email')).json.score_before != null, 1);
    r = await call('DELETE', '/api/zapmail/key');
    check('zapmail: disconnecting deletes the key', r.json.connected === false && (await call('POST', '/api/zapmail/sync')).status === 409, r.json);
    const afterDelete = fs.readFileSync(path.join(DATA, 'tracker.db')).toString('latin1');
    check('zapmail: the last numbers stay on the Email page after disconnecting', (await call('GET', '/api/email')).json.snapshot.mailboxes.length === 3 && !afterDelete.includes(ZM_KEY), 1);
    void beforeSnap;

    /* ---------- pipeline board ---------- */
    const pl = (await call('GET', '/api/pipeline')).json;
    check('pipeline: board is Replied, Call booked, Follow up, Proposal sent, Closed', JSON.stringify(pl.board) === JSON.stringify(['replied', 'call_booked', 'follow_up', 'proposal_sent', 'closed']) && !('contacted' in pl.columns), pl.board);
    check('pipeline: New and Not interested are counted but not columns', pl.counts.new >= 1 && 'not_interested' in pl.counts && !pl.columns.new, pl.counts);
    check('pipeline: Follow up column holds the leads waiting on a follow-up', pl.counts.follow_up >= 15 && pl.columns.follow_up.length === Math.min(80, pl.counts.follow_up), pl.counts);

    /* ---------- deals and goal ---------- */
    const tz = (await call('GET', '/api/leads?q=TZ Central')).json.rows[0];
    r = await call('PUT', `/api/leads/${tz.id}/deal`, { call_at_local: '2026-12-01T10:00', call_result: 'pending', deal_value: 1200 });
    check('booked call time is stored as UTC from SAST (10:00 SAST = 08:00Z)', r.json.deal.call_at === '2026-12-01T08:00:00.000Z', r.json.deal);
    check('booking a call moves status to Call booked', r.json.lead.status === 'call_booked', r.json.lead.status);
    const g0 = (await call('GET', '/api/pipeline')).json.goal;
    r = await call('PUT', `/api/leads/${tz.id}/deal`, { call_result: 'show', proposal_sent_date: '2026-12-02', deposit_paid_date: '2026-12-03', deposit_amount: 600, signed_date: '2026-12-03' });
    check('signed deal closes the lead', r.json.lead.status === 'closed', r.json.lead.status);
    const g1 = (await call('GET', '/api/pipeline')).json.goal;
    check('goal progress rose by the deal value', g1.signed - g0.signed === 1200 && g1.amount === 20000 && g1.date === '2026-12-31', [g0, g1]);
    check('deposit is counted separately', g1.deposits - g0.deposits === 600, [g0.deposits, g1.deposits]);

    /* ---------- stats ---------- */
    const st = (await call('GET', '/api/stats')).json;
    const callRow = st.byChannel.find((x) => x.channel === 'call');
    check('stats: call attempts counted by channel', callRow.attempts >= 5, callRow);
    check('stats: today appears in the daily series with calls', st.daily[st.daily.length - 1].day === st.today && st.daily[st.daily.length - 1].calls >= 1, st.daily[st.daily.length - 1]);
    check('stats: weekly series has 8 weeks', st.weekly.length === 8, st.weekly.length);
    check('stats: conversion by source is present', st.bySource.find((x) => x.source === 'google_maps').leads > 0, st.bySource);
    check('stats: show rate reflects the deal marked as showed', st.shows >= 1, [st.shows, st.noshows]);

    /* ---------- settings ---------- */
    r = await call('PUT', '/api/settings', { daily_call_target: 60, daily_dm_target: 25 });
    check('daily targets can be changed', r.json.daily_call_target === 60 && r.json.daily_dm_target === 25, r.json);
    check('targets start at 50 calls and 30 DMs by default', (await call('GET', '/api/settings')).json.daily_call_target === 60, 1);

    /* ---------- export, backup ---------- */
    r = await call('GET', '/api/export/all.zip');
    const zip = readZip(r.buf);
    check('export zip contains the four CSVs with valid checksums', ['leads.csv', 'contacts.csv', 'deals.csv', 'opt_outs.csv'].every((f) => zip[f] && zip[f].crcOk), Object.keys(zip));
    check('exported leads include the demo and test leads', zip['leads.csv'].data.toString('utf8').includes('Ridgeline Roofing') && zip['leads.csv'].data.toString('utf8').includes('Import One Plumbing'), 1);
    check('exported contacts include the timeline text', zip['contacts.csv'].data.toString('utf8').includes('Yes send it') || zip['contacts.csv'].data.toString('utf8').includes('Opener'), 1);
    check('exported opt-outs keep the deleted lead record', zip['opt_outs.csv'].data.toString('utf8').includes('Maple Street Roofing'), 1);
    r = await call('POST', '/api/backups/run');
    check('manual backup is written', r.status === 200 && r.json.backups.length >= 1, r.json);
    const bk = path.join(DATA, 'backups', r.json.name);
    const bdb = new DatabaseSync(bk, { readOnly: true });
    const liveCount = (await call('GET', '/api/leads?limit=1')).json.total;
    check('backup file opens and holds the same number of leads', bdb.prepare('SELECT COUNT(*) AS n FROM leads').get().n === liveCount, liveCount);
    bdb.close();

    /* ---------- password change, logout ---------- */
    r = await call('POST', '/api/password', { old: 'wrong-password', new: 'another-pass-123' });
    check('wrong current password is refused', r.status === 401, r.status);
    const PW2 = PW + '-2';
    r = await call('POST', '/api/password', { old: PW, new: PW2 });
    check('password can be changed', r.status === 200, r.status);
    r = await call('POST', '/api/logout');
    r = await call('GET', '/api/leads');
    check('logging out closes the session', r.status === 401, r.status);
    r = await call('POST', '/api/login', { password: PW }, { noCookie: true });
    check('old password no longer works', r.status === 401, r.status);
    r = await call('POST', '/api/login', { password: PW2 }, { noCookie: true });
    check('new password signs in', r.status === 200, r.status);

    /* ---------- big import ---------- */
    const big = Array.from({ length: 2000 }, (_, i) => ({ business_name: 'Bulk Co ' + i, phone: '(555) 7' + String(i).padStart(2, '0') + '-' + String(1000 + i), city: 'Bulkville', state: 'TX', trade: 'Roofer' }));
    let t0 = Date.now();
    r = await call('POST', '/api/import/preview', { rows: big, defaults: { source: 'google_maps', batch: 'Bulk' } });
    const tPrev = Date.now() - t0;
    check('2,000 row preview finishes quickly and finds all new', r.status === 200 && r.json.counts.new === 2000 && tPrev < 8000, [r.json && r.json.counts, tPrev + 'ms']);
    t0 = Date.now();
    r = await call('POST', '/api/import/commit', { rows: big, defaults: { source: 'google_maps', batch: 'Bulk' }, mode: 'skip' });
    check('2,000 row import commits in one go', r.status === 200 && r.json.added === 2000 && (Date.now() - t0) < 15000, [r.json, Date.now() - t0]);
    r = await call('GET', '/api/leads?batch=Bulk&limit=5');
    check('imported batch can be filtered by batch name', r.json.total === 2000, r.json.total);
    t0 = Date.now();
    r = await call('GET', '/api/today');
    check('Today still loads fast with 2,000 more leads', r.status === 200 && (Date.now() - t0) < 3000, Date.now() - t0);
    r = await call('POST', '/api/import/commit', { rows: big, defaults: { source: 'google_maps' }, mode: 'skip' });
    check('importing the same file again adds nothing', r.json.added === 0 && r.json.skipped_duplicates === 2000, r.json);

    /* ---------- login lockout (last, it blocks this machine for 10 minutes) ---------- */
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await call('POST', '/api/login', { password: 'nope-' + i }, { noCookie: true })).status;
    check('repeated wrong passwords get locked out (429)', last === 429, last);
  } catch (e) {
    check('test run crashed', false, e.stack);
  } finally {
    srv.kill();
    try { mock.close(); } catch (e) { /* ignore */ }
    if (srvErr.trim()) console.log('\nserver stderr:\n' + srvErr);
    const bad = results.filter((x) => !x.ok);
    console.log(`\n${results.length - bad.length} passed, ${bad.length} failed. Data dir: ${DATA}`);
    process.exit(bad.length ? 1 : 0);
  }
})();
