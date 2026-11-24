'use strict';
/* Saves a Zapmail snapshot (a JSON file) into the tracker's database.
   Claude reads the Zapmail dashboard (read only) and writes the file, then runs:
     node --no-warnings scripts/zapmail-sync.js path/to/snapshot.json
   Needs DATABASE_URL in the environment (the same Supabase string the site uses).
   The Email page shows the newest snapshot. No Zapmail password or key is ever stored. */
const fs = require('node:fs');
const S = require('../src/app');

const file = process.argv[2];
if (!file) { console.error('Usage: node --no-warnings scripts/zapmail-sync.js snapshot.json'); process.exit(1); }
const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
S.init().then(() => S.saveSnapshot(snap)).then(async (res) => {
  console.log('Saved Zapmail snapshot taken at ' + res.taken_at + ' with ' + snap.mailboxes.length + ' mailboxes.');
  await S.db.close();
}).catch(async (e) => { console.error(e.message); await S.db.close(); process.exit(1); });
