'use strict';
/* Ranking data from Google Maps scrapes, shared by build-rank-data.js and apply-rank-info.js.

   A Google Maps scrape CSV (Chrome extension) lists the businesses in Google's own result order for ONE search, for example
   "plumber in Norristown PA". Position in the file is the rank for that search. Three things have to be handled:
   - the first rows are empty,
   - a business that shows up again while scrolling counts only at its FIRST position,
   - rows that are not plumbers (supply stores, electricians, HVAC only, inspectors) are skipped, so they take no position.
   Franchises such as Roto-Rooter are plumbers and DO take a position. */
const Lib = require('../public/lib.js');

const SOURCE = 'google-maps-scrape';

/* Same idea as NOT_LEADS in the old local import script (supply stores, hardware, wholesalers, non-businesses), plus the other trades that show up in a plumbing search. */
const SUPPLY_OR_SHOP = /supply|supplies|store|wholesal|hardware|warehouse|showroom|distributor|home improvement|appliance|equipment|manufactur/i;
const PLUMBING_WORDS = /plumb|rooter|drain|sewer|septic|water heater|pipe|leak/i;

/* Is this scrape row a plumbing business that takes a position in the ranking? */
function isPlumbing(name, category) {
  const cat = String(category || '').trim();
  if (SUPPLY_OR_SHOP.test(cat)) return false;
  if (/plumb|drain|sewer|septic|water heater/i.test(cat)) return true;
  return PLUMBING_WORDS.test(String(name || '')); // any other trade (HVAC, electrical, general contractor, inspector) counts only when the business name says plumbing
}

const intOf = (v) => {
  const t = String(v == null ? '' : v).trim().toLowerCase().replace(/[()\s]/g, '');
  if (!t) return null;
  const k = /^([\d.,]+)k$/.exec(t);
  if (k) { const n = Number(k[1].replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 1000) : null; }
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
};
const ratingOf = (v) => {
  const n = Number(String(v == null ? '' : v).trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 && n <= 5 ? n : null;
};
/* host plus path, no www, no query, no trailing slash: "mrrooter.com/central-pa" and "mrrooter.com/west-chester" are different businesses */
function siteKey(v) {
  let t = String(v == null ? '' : v).trim().toLowerCase();
  if (!t) return null;
  t = t.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[?#]/)[0].replace(/\/+$/, '');
  return t || null;
}
const coords = (url) => { const m = /!3d(-?[\d.]+)!4d(-?[\d.]+)/.exec(url || ''); return m ? [Number(m[1]), Number(m[2])] : null; };
function km(a, b) {
  const rad = Math.PI / 180, dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
function placeId(url) {
  const m = /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i.exec(url || '');
  return m ? m[1].toLowerCase() : null;
}

/* Read one raw scrape. Returns every distinct business in Google's order, with a flag for the ones that count as plumbers. */
function parseScrape(csvText) {
  const rows = Lib.parseCSV(csvText);
  const H = rows[0] || [];
  const col = (r, n) => (r[H.indexOf(n)] || '').trim();
  const seen = new Set();
  const items = [];
  let rawRows = 0, repeats = 0;
  for (const r of rows.slice(1)) {
    const name = col(r, 'qBF1Pd');
    if (!name) continue; // the empty rows at the top
    rawRows++;
    const url = col(r, 'hfpxzc href');
    const phone = col(r, 'UsdlK');
    const key = placeId(url) || (Lib.alnum(name) + '|' + (Lib.normPhone(phone) || ''));
    if (seen.has(key)) { repeats++; continue; } // seen again while scrolling: only the first position counts
    seen.add(key);
    const site = col(r, 'lcr4fd href');
    const category = col(r, 'W4Efsd');
    items.push({
      name, category, phone: phone || null, phone_norm: Lib.normPhone(phone) || null,
      site_key: /^https?:\/\/(www\.)?google\./i.test(site) ? null : siteKey(site),
      at: coords(url),
      rating: ratingOf(col(r, 'MW4etd')), reviews: intOf(col(r, 'UY7F9')),
      plumbing: isPlumbing(name, category),
    });
  }
  // rank = position among the plumbing businesses only
  let n = 0;
  for (const it of items) it.rank = it.plumbing ? ++n : null;
  return { items, raw_rows: rawRows, repeats, total: n };
}

/* A list as stored in rank-lists.json: only plumbers, in order, small. */
function toList(parsed, meta) {
  const plumbers = parsed.items.filter((i) => i.plumbing);
  const pts = plumbers.filter((i) => i.at).map((i) => i.at);
  return {
    query: meta.query, checked_at: meta.checked_at, source: meta.source || SOURCE, file: meta.file || null,
    raw_rows: parsed.raw_rows, repeats_removed: parsed.repeats,
    skipped_not_plumbers: parsed.items.filter((i) => !i.plumbing).map((i) => i.name + ' [' + (i.category || 'no category') + ']'),
    total: parsed.total,
    // where the search is centred: the middle of the results (one far-away listing does not move a median)
    center: pts.length ? [median(pts.map((p) => p[0])), median(pts.map((p) => p[1]))] : null,
    entries: plumbers.map((i) => ({ rank: i.rank, name: i.name, rating: i.rating, reviews: i.reviews, phone: i.phone, phone_norm: i.phone_norm, site_key: i.site_key, at: i.at ? i.at.map((x) => Math.round(x * 10000) / 10000) : null })),
  };
}

/* Find the lead in one list: by phone digits first. By website only when the phone cannot decide (the lead or the listing has no
   phone), on the exact page (host plus path, so one franchise's branches never mix), and only when that page is unique in the list. */
function findInList(list, lead) {
  const phone = lead.phone_norm || Lib.normPhone(lead.phone) || null;
  if (phone) { const hit = list.entries.find((e) => e.phone_norm === phone); if (hit) return { entry: hit, by: 'phone' }; }
  const key = siteKey(lead.website);
  if (key) {
    const same = list.entries.filter((e) => e.site_key === key);
    if (same.length === 1 && (!phone || !same[0].phone_norm)) return { entry: same[0], by: 'website' };
  }
  return null;
}

/* rank_info for one lead, or null when the lead is in none of the lists. */
function rankInfoFor(lead, lists) {
  const found = [];
  for (const list of lists) { const m = findInList(list, lead); if (m) found.push({ list, ...m }); }
  if (!found.length) return null;
  // in more than one search: use the one whose town the business sits closest to
  const dist = (f) => (f.entry.at && f.list.center ? km(f.entry.at, f.list.center) : 1e9);
  found.sort((a, b) => dist(a) - dist(b) || a.entry.rank - b.entry.rank);
  const { list, entry, by } = found[0];
  const top3 = list.entries.filter((e) => e !== entry).slice(0, 3).map((e) => ({ rank: e.rank, name: e.name, rating: e.rating, reviews: e.reviews, phone: e.phone }));
  return { query: list.query, my_rank: entry.rank, total: list.total, top3, source: list.source, checked_at: list.checked_at, _by: by };
}
const publicInfo = (info) => { if (!info) return null; const { _by, ...rest } = info; return rest; };

module.exports = { SOURCE, isPlumbing, parseScrape, toList, findInList, rankInfoFor, publicInfo };
