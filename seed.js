'use strict';
/* Adds 10 fake demo leads (clearly tagged Demo) with a little history, so every screen has something to show.
   Run: node --no-warnings seed.js        (add --force to seed again)
   Delete them later in Settings > Demo data. */
const S = require('./server.js');
const Lib = require('./public/lib.js');
const { db } = S;

const existing = db.prepare('SELECT COUNT(*) AS n FROM leads WHERE is_demo = 1').get().n;
if (existing && !process.argv.includes('--force')) { console.log('Demo leads already exist (' + existing + '). Use --force to add again.'); process.exit(0); }

const day = (offsetDays, hour, min) => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + offsetDays); d.setUTCHours(hour, min || 0, 0, 0); return d.toISOString();
};
const LEADS = [
  { business_name: 'Ridgeline Roofing', owner_name: 'Dale Whitaker', phone: '(615) 555-0142', email: 'dale@ridgelineroofing.example', website: 'ridgelineroofing.example', city: 'Nashville', state: 'TN', trade: 'Roofer', source: 'google_maps', source_link: 'https://maps.example/ridgeline', batch: 'Demo roofers', competitor_checked: 'Summit Roof Pros ranks #1 for "roof repair Nashville"', competitor_checked_date: Lib.dayKey(new Date(), 'Africa/Johannesburg'), notes: 'Demo lead. Owner answers his own phone.' },
  { business_name: 'Copperfield Plumbing', owner_name: 'Marisol Reyes', phone: '(303) 555-0118', email: '', website: 'copperfieldplumbing.example', city: 'Denver', state: 'CO', trade: 'Plumber', source: 'facebook_group', source_link: 'https://facebook.example/groups/plumbers/posts/1', batch: 'Demo plumbers' },
  { business_name: 'Sunbelt Air & Heating', owner_name: 'Troy Marsh', phone: '(602) 555-0177', email: 'troy@sunbeltair.example', website: 'sunbeltair.example', city: 'Phoenix', state: 'AZ', trade: 'HVAC', source: 'google_maps', batch: 'Demo HVAC', competitor_checked: 'Desert Cool HVAC', competitor_checked_date: Lib.dayKey(new Date(), 'Africa/Johannesburg') },
  { business_name: 'Bayview HVAC', owner_name: 'Priya Nair', phone: '(619) 555-0104', email: 'priya@bayviewhvac.example', website: 'bayviewhvac.example', city: 'San Diego', state: 'CA', trade: 'HVAC', source: 'instagram', source_link: 'https://instagram.example/bayviewhvac', batch: 'Demo HVAC' },
  { business_name: 'Harbor Light Electric', owner_name: 'Cal Donovan', phone: '(843) 555-0165', website: 'harborlightelectric.example', city: 'Charleston', state: 'SC', trade: 'Electrician', source: 'referral', batch: 'Demo referrals' },
  { business_name: 'Northwind Landscaping', owner_name: 'Ingrid Olsen', phone: '(907) 555-0131', website: 'northwindlandscaping.example', city: 'Anchorage', state: 'AK', trade: 'Landscaper', source: 'google_maps', batch: 'Demo landscapers' },
  { business_name: 'Palm Coast Pressure Washing', owner_name: 'Kai Akana', phone: '(808) 555-0192', website: '', city: 'Honolulu', state: 'HI', trade: 'Cleaner', source: 'instagram', batch: 'Demo landscapers' },
  { business_name: 'Prairie State Roofing', owner_name: 'Hank Jessup', phone: '(217) 555-0126', email: 'hank@prairiestateroofing.example', website: 'prairiestateroofing.example', city: 'Springfield', state: 'IL', trade: 'Roofer', source: 'google_maps', batch: 'Demo roofers' },
  { business_name: 'Lakeshore Gutters', owner_name: '', phone: '(312) 555-0150', website: 'lakeshoregutters.example', city: 'Chicago', state: '', trade: 'Roofer', source: 'other', batch: 'Demo roofers', notes: 'No state on purpose: shows the "needs a time zone" case.' },
  { business_name: 'Granite Peak HVAC', owner_name: 'Wes Lindqvist', phone: '(801) 555-0188', email: 'wes@granitepeakhvac.example', website: 'granitepeakhvac.example', city: 'Salt Lake City', state: 'UT', trade: 'HVAC', source: 'facebook_group', source_link: 'https://facebook.example/groups/hvac/posts/9', batch: 'Demo HVAC' },
];
const ids = {};
for (const l of LEADS) {
  const f = S.normaliseLead({ ...l, is_demo: true }, { status: 'new', source: 'other' });
  ids[l.business_name] = S.insertLead(f);
}
const log = (name, channel, outcome, at, content, extra) => S.addContact(ids[name], { channel, outcome, at, content, ...(extra || {}) });

// Ridgeline: call + IG DM, reply
log('Ridgeline Roofing', 'call', 'gatekeeper', day(-5, 15, 10), 'Asked for Dale, gatekeeper said call back after 3.');
log('Ridgeline Roofing', 'instagram_dm', 'sent', day(-4, 9, 30), 'Roses are red... DM sent.');
log('Ridgeline Roofing', 'instagram_dm', 'replied', day(-3, 12, 5), 'Sure, send it over.');
// Copperfield: FB group comment, FB DM
log('Copperfield Plumbing', 'facebook_group', 'posted', day(-6, 17, 0), 'Answered their question about Google reviews.');
log('Copperfield Plumbing', 'facebook_dm', 'sent', day(-2, 16, 20), 'Sent the opener.');
// Sunbelt: calls, spoke to owner, proposal
log('Sunbelt Air & Heating', 'call', 'no_answer', day(-7, 16, 0));
log('Sunbelt Air & Heating', 'call', 'spoke_to_owner', day(-3, 17, 15), 'Talked about being #4 on Maps, he wants a proposal.');
S.putDeal(ids['Sunbelt Air & Heating'], { proposal_sent_date: Lib.dayKey(new Date(Date.now() - 86400000), 'Africa/Johannesburg'), deal_value: 1000 });
// Bayview: closed
log('Bayview HVAC', 'instagram_dm', 'sent', day(-12, 14, 0));
log('Bayview HVAC', 'instagram_dm', 'replied', day(-11, 10, 0), 'Yes please.');
log('Bayview HVAC', 'call', 'booked', day(-9, 18, 0), 'Booked a Tuesday call.');
S.putDeal(ids['Bayview HVAC'], { call_at: day(-8, 19, 0), call_result: 'show', proposal_sent_date: Lib.dayKey(new Date(Date.now() - 7 * 86400000), 'Africa/Johannesburg'), deposit_paid_date: Lib.dayKey(new Date(Date.now() - 5 * 86400000), 'Africa/Johannesburg'), deposit_amount: 500, signed_date: Lib.dayKey(new Date(Date.now() - 5 * 86400000), 'Africa/Johannesburg'), deal_value: 1000 });
// Harbor Light, Northwind and Lakeshore stay untouched (status New) so the call queue has people in it
// Granite Peak: booked call in the future
log('Granite Peak HVAC', 'facebook_dm', 'replied', day(-2, 11, 0), 'Works for me, call tomorrow.');
log('Granite Peak HVAC', 'call', 'booked', day(-1, 17, 0), 'Booked for the day after tomorrow.');
S.putDeal(ids['Granite Peak HVAC'], { call_at: day(2, 16, 0), call_result: 'pending', deal_value: 1500 });
// Prairie State: opted out
log('Prairie State Roofing', 'email', 'sent', day(-6, 15, 0), 'First email.');
log('Prairie State Roofing', 'email', 'replied', day(-5, 9, 0), 'Please take me off your list.');
S.optOut(ids['Prairie State Roofing'], { channel: 'all', note: 'Replied to the email asking to be removed.', at: day(-5, 9, 5) });
// Palm Coast: a couple of stale attempts so follow-ups are overdue
log('Palm Coast Pressure Washing', 'instagram_dm', 'sent', day(-9, 8, 0), 'Opener sent.');
db.prepare("UPDATE leads SET next_followup = ? WHERE id = ?").run(Lib.addDaysKey(Lib.dayKey(new Date(), 'Africa/Johannesburg'), -3), ids['Palm Coast Pressure Washing']);

const todayKey = Lib.dayKey(new Date(), 'Africa/Johannesburg');
db.prepare('UPDATE leads SET next_followup = ? WHERE id IN (?, ?)').run(todayKey, ids['Copperfield Plumbing'], ids['Sunbelt Air & Heating']);
console.log('Seeded ' + LEADS.length + ' demo leads into ' + S.DATA_DIR);
db.close();
