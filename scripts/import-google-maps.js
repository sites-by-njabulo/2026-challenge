/* Imports a Google Maps scrape (Chrome extension CSV) into the Lead Tracker.
   Usage:  node scripts/import-google-maps.js "<file.csv>" "<batch name>"            (preview only, writes nothing)
           node scripts/import-google-maps.js "<file.csv>" "<batch name>" --commit   (really adds the leads)
           add --state=PA to set the state on every lead of a one-state scrape
   Needs DATABASE_URL in the environment (the same Supabase string the site uses).
   Duplicates (same phone, website or name+city) and opted-out businesses are skipped by the tracker's own import rules.
   Things that are not businesses to sell to (apartments, offices, non-profits, real estate, brokers) are left out and listed. */
const fs = require('fs');
const path = require('path');
const Lib = require('../public/lib.js');
const app = require('../src/app');

const [file, batchName] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const commit = process.argv.includes('--commit');
if (!file) { console.log('Give the CSV path.'); process.exit(1); }

const rows = Lib.parseCSV(fs.readFileSync(file, 'utf8'));
const H = rows[0];
const col = (r, n) => (r[H.indexOf(n)] || '').trim();

const NOT_LEADS = /^(apartment|apartment complex|condominium complex|vacation home rental|vacation rental|corporate office|non-profit organization|business broker|real estate agent|real estate consultant|real estate developer|real estate agency)$/i;
const TRADES = [
  [/roof/i, 'Roofing'], [/air conditioning|hvac|heating/i, 'HVAC'], [/landscap|lawn/i, 'Landscaping'], [/water damage|restoration/i, 'Restoration'],
  [/handy/i, 'Handyman'], [/asphalt|paving/i, 'Paving'], [/demolition/i, 'Demolition'], [/floor/i, 'Flooring'], [/bathroom|remodel/i, 'Remodeling'],
  [/foundation|waterproof/i, 'Foundation repair'], [/insulation/i, 'Insulation'], [/masonry/i, 'Masonry'],
];
const trade = (cat) => { for (const [re, t] of TRADES) if (re.test(cat)) return t; return 'General contracting'; };

/* Optional: --state=PA sets that state on every lead (use it for a scrape of one state). Without it, the
   state and city are only guessed for the New Orleans area from the map position. */
const forcedState = (process.argv.find((a) => a.startsWith('--state=')) || '').slice(8).toUpperCase();
function location(url) {
  if (forcedState) return { state: forcedState };
  const m = /!3d(-?[\d.]+)!4d(-?[\d.]+)/.exec(url);
  if (!m) return {};
  const lat = Number(m[1]), lon = Number(m[2]);
  const out = {};
  if (lat >= 28.9 && lat <= 31.1 && lon >= -94.1 && lon <= -88.8) out.state = 'LA';
  if (lat >= 29.88 && lat <= 30.08 && lon >= -90.2 && lon <= -89.85) out.city = 'New Orleans';
  return out;
}
const cleanSite = (u) => {
  if (!u || /^https?:\/\/(www\.)?google\./i.test(u)) return '';
  return u.replace(/\?.*$/, '');
};

const leads = [];
const left = [];
const seenFileRows = new Set();
for (const r of rows.slice(1)) {
  const name = col(r, 'qBF1Pd');
  if (!name) continue;
  const category = col(r, 'W4Efsd');
  if (NOT_LEADS.test(category)) { left.push({ name, category }); continue; }
  const url = col(r, 'hfpxzc href');
  const loc = location(url);
  const addr = ['W4Efsd 2', 'W4Efsd 3', 'W4Efsd 4', 'W4Efsd 5', 'W4Efsd 6'].map((c) => col(r, c)).filter((v) => v && !/^(·|open|· ?closes|closes)/i.test(v) && !/sleeps/i.test(v));
  const rating = col(r, 'MW4etd');
  const reviews = col(r, 'UY7F9').replace(/[()]/g, '');
  const notes = [addr[0] ? 'Address: ' + addr[0] : '', rating ? 'Google rating ' + rating + (reviews ? ' (' + reviews + ' reviews)' : '') : '', category ? 'Google category: ' + category : ''].filter(Boolean).join('. ');
  leads.push({
    business_name: name, phone: col(r, 'UsdlK'), website: cleanSite(col(r, 'lcr4fd href')), city: loc.city || '', state: loc.state || '',
    trade: trade(category), source: 'google_maps', source_link: url.split('?')[0], notes,
  });
}

(async () => {
  const batch = batchName || 'Google Maps scrape ' + new Date().toISOString().slice(0, 10);
  const body = { rows: leads, defaults: { source: 'google_maps', batch }, mode: 'skip' };
  await app.init();
  const pv = await app.importPreview(body);
  console.log('Rows with a business name in the file:', leads.length + left.length);
  console.log('Left out because they are not businesses to sell to (' + left.length + '):');
  left.forEach((l) => console.log('   ' + l.name + '  [' + l.category + ']'));
  console.log('Preview of the rest:', JSON.stringify(pv.counts));
  const dups = pv.rows.filter((x) => x.status !== 'new');
  dups.forEach((x) => console.log('   ' + x.status + ': ' + x.lead.business_name + (x.matches[0] ? ' (already in tracker: ' + x.matches[0].business_name + ')' : '')));
  if (!commit) { console.log('\nPreview only. Nothing was written. Add --commit to import.'); return; }
  const res = await app.importCommit(body);
  console.log('\nImported:', JSON.stringify({ added: res.added, skipped_duplicates: res.skipped_duplicates, blocked_optout: res.blocked_optout, invalid: res.invalid }), 'batch:', res.batch);
})().then(() => app.db.close()).catch(async (e) => { console.error(e.message); await app.db.close(); process.exit(1); });
