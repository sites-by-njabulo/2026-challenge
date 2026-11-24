'use strict';
/* Runs a test suite through the production database path (the pg package over a Postgres connection).
   Usage: node --no-warnings test/via-pg.js flow     or     node --no-warnings test/via-pg.js ui */
const which = process.argv[2];
if (!['flow', 'ui'].includes(which)) { console.error('Usage: node test/via-pg.js flow|ui'); process.exit(1); }
process.env.TEST_VIA_PG = '1';
require('./' + which + '.js');
