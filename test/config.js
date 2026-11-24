'use strict';
/* Checks how the app behaves when it is set up wrongly, each case in a fresh process (so no state leaks between them).
   Run: node --no-warnings test/config.js */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const results = [];
const check = (name, cond, extra) => { results.push({ name, ok: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  <-- ' + JSON.stringify(extra))); };

/* The child makes one fake request to the handler and prints { status, body, kind }. */
const CHILD = `
const app = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'app.js'))});
const { PassThrough } = require('node:stream');
const req = new PassThrough(); req.method = 'GET'; req.url = '/api/me'; req.headers = { host: 'x' }; req.socket = { remoteAddress: '1.2.3.4' }; req.end();
let status = 0; const chunks = [];
const res = { headersSent: false, setHeader() {}, writeHead(s) { status = s; this.headersSent = true; }, end(b) { chunks.push(String(b || '')); } };
const done = (async () => { await app.handler(req, res); let kind = null; try { kind = app.db.kind(); } catch (e) { kind = 'none'; } console.log(JSON.stringify({ status, body: chunks.join(''), kind })); await app.db.close().catch(() => {}); process.exit(0); })();
setTimeout(() => { console.log(JSON.stringify({ status: -1, body: 'timeout' })); process.exit(0); }, 25000);
`;
function run(env) {
  const clean = { ...process.env };
  for (const k of ['DATABASE_URL', 'TEST_PGLITE', 'DATABASE_SSL', 'VERCEL']) delete clean[k];
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', CHILD], { env: { ...clean, ...env }, encoding: 'utf8', timeout: 40000 });
  const line = (r.stdout || '').trim().split('\n').pop();
  try { return JSON.parse(line); } catch (e) { return { status: -2, body: r.stdout + r.stderr }; }
}

let r = run({});
check('no DATABASE_URL and no test switch: a clear 503 that names DATABASE_URL', r.status === 503 && /DATABASE_URL is not set/.test(r.body), r);
r = run({ TEST_PGLITE: '0' });
check('the test database is never picked unless TEST_PGLITE=1 is set on purpose', r.status === 503 && /DATABASE_URL is not set/.test(r.body), r);
r = run({ DATABASE_URL: 'postgresql://postgres.abcd:SuperSecretPw%40123@127.0.0.1:1/postgres', DATABASE_SSL: 'off' });
check('a database that cannot be reached gives a plain 503 and never prints the password', r.status === 503 && /Cannot reach the database/.test(r.body) && !/SuperSecretPw/.test(r.body), r);
check('with a DATABASE_URL the production engine (pg) is used', r.kind === 'pg', r.kind);
r = run({ DATABASE_URL: 'postgresql://postgres.abcd:SuperSecretPw%40123@127.0.0.1:1/postgres?sslmode=require', TEST_PGLITE: '1' });
check('DATABASE_URL always wins over the test switch, and a sslmode in the string is accepted', r.kind === 'pg' && r.status === 503, r);
r = run({ TEST_PGLITE: '1' });
check('with TEST_PGLITE=1 and no DATABASE_URL the in-process test database answers', r.status === 200 && r.kind === 'pglite', r);

const bad = results.filter((x) => !x.ok);
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed.`);
process.exit(bad.length ? 1 : 0);
