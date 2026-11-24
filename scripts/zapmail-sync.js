'use strict';
/* Saves a Zapmail snapshot (a JSON file) into the tracker's database.
   Claude reads the Zapmail dashboard (read only) and writes the file, then runs:
     node --no-warnings scripts/zapmail-sync.js path/to/snapshot.json
   The Email page shows the newest snapshot. No Zapmail password or key is ever stored. */
const fs = require('node:fs');
const S = require('../server.js');

const file = process.argv[2];
if (!file) { console.error('Usage: node --no-warnings scripts/zapmail-sync.js snapshot.json'); process.exit(1); }
const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
const res = S.saveSnapshot(snap);
console.log('Saved Zapmail snapshot taken at ' + res.taken_at + ' with ' + snap.mailboxes.length + ' mailboxes into ' + S.DATA_DIR);
S.db.close();
