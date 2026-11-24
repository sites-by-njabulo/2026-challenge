'use strict';
/* The only door to the database. The rest of the app calls these few functions and never knows which engine is behind them.

   Production: Postgres through the `pg` package, connection string from DATABASE_URL (Supabase pooler, transaction mode, port 6543).
     - one connection per serverless instance (pool max 1), no named prepared statements (the pooler cannot keep them).
   Tests and local tries: when DATABASE_URL is not set and TEST_PGLITE=1, an in-process Postgres (PGlite, WASM) is used instead.
     It is real Postgres code, so the same SQL runs on both. It is never used in production: without DATABASE_URL and without
     TEST_PGLITE the app refuses to start.

   SQL in this app is written with ? placeholders. They are turned into $1, $2 ... here. */
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage(); // holds { client, cache } for the current request or transaction
let engine = null;

const sqlCache = new Map();
function toPg(sql) {
  let hit = sqlCache.get(sql);
  if (hit) return hit;
  let out = '', n = 0, inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") inStr = !inStr;
    if (ch === '?' && !inStr) out += '$' + ++n; else out += ch;
  }
  hit = { text: out, n };
  if (sqlCache.size < 500) sqlCache.set(sql, hit);
  return hit;
}

class DbConfigError extends Error {}

function makeEngine() {
  const url = process.env.DATABASE_URL;
  if (url) return makePg(url);
  if (process.env.TEST_PGLITE === '1') return makePglite();
  throw new DbConfigError('DATABASE_URL is not set. Add it in the Vercel project settings (Supabase, Connection string, Transaction pooler).');
}

/* ---- Postgres (production) ---- */
function makePg(rawUrl) {
  const pg = require('pg');
  pg.types.setTypeParser(20, (v) => Number(v));   // bigint (COUNT, SUM of integers) -> number
  pg.types.setTypeParser(1700, (v) => Number(v)); // numeric -> number
  // Take the ssl choice out of the URL so that our own setting below is the one that counts.
  let conn = rawUrl;
  try { const u = new URL(rawUrl); u.searchParams.delete('sslmode'); u.searchParams.delete('ssl'); conn = u.toString(); } catch (e) { /* leave as is, pg will complain clearly */ }
  const sslOff = /^(off|false|0|disable)$/i.test(process.env.DATABASE_SSL || '');
  const pool = new pg.Pool({
    connectionString: conn,
    max: 1,                              // serverless: one connection per instance, the pooler does the sharing
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    ssl: sslOff ? false : { rejectUnauthorized: false }, // Supabase's pooler certificate is not in Node's trust store
  });
  pool.on('error', () => { /* an idle connection dropped: the pool opens a new one on the next query */ });
  const norm = (r) => ({ rows: r.rows || [], rowCount: r.rowCount || 0 });
  let lastUsed = 0;
  return {
    kind: 'pg',
    async query(text, params, client) { const r = norm(await (client || pool).query(text, params)); lastUsed = Date.now(); return r; },
    /* A serverless instance can be frozen for minutes, and the connection it held may be dead when it wakes up. If it has been
       idle for a few seconds, test it first (a dead one is dropped by the pool, the second try opens a new one). */
    async ensureAlive() {
      if (Date.now() - lastUsed < 4000) return;
      for (let i = 0; i < 3; i++) {
        try { await pool.query('SELECT 1'); lastUsed = Date.now(); return; } catch (e) {
          if (i === 2 || !/terminated|ECONNRESET|EPIPE|ETIMEDOUT|ended|closed/i.test(String(e.code || '') + ' ' + String(e.message))) throw e;
        }
      }
    },
    async exec(text, client) { await (client || pool).query(text); },
    async transaction(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn(c);
        await c.query('COMMIT');
        return r;
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch (e2) { /* the connection is gone, release will drop it */ }
        throw e;
      } finally { c.release(); }
    },
    async close() { await pool.end(); },
  };
}

/* ---- PGlite (tests, local tries) ---- */
function makePglite() {
  const name = '@electric-sql/pglite'; // a variable, so the Vercel bundler does not pull this big dev package into the function
  const { PGlite } = require(name);
  const dir = process.env.PGLITE_DIR || undefined; // unset = in memory
  const lite = new PGlite(dir, { parsers: { 20: (v) => Number(v), 1700: (v) => Number(v) } });
  const norm = (r) => ({ rows: r.rows || [], rowCount: r.affectedRows != null ? r.affectedRows : (r.rows || []).length });
  return {
    kind: 'pglite',
    lite,
    async query(text, params, client) { return norm(await (client || lite).query(text, params)); },
    async exec(text, client) { await (client || lite).exec(text); },
    async transaction(fn) { return lite.transaction((t) => fn(t)); },
    async close() { await lite.close(); },
  };
}

function eng() { if (!engine) engine = makeEngine(); return engine; }

const store = () => als.getStore() || null;
const clientNow = () => { const s = store(); return s ? s.client : undefined; };

async function query(sql, params) {
  const { text } = toPg(sql);
  return eng().query(text, params && params.length ? params : undefined, clientNow());
}
const all = async (sql, ...params) => (await query(sql, params)).rows;
const get = async (sql, ...params) => (await query(sql, params)).rows[0];
const run = async (sql, ...params) => { const r = await query(sql, params); return { changes: r.rowCount, rows: r.rows }; };
const exec = (sql) => eng().exec(sql, clientNow());

/* Everything inside fn runs on one connection in one transaction. Nested calls join the outer one. */
async function tx(fn) {
  const s = store();
  if (s && s.client) return fn();
  return eng().transaction((client) => als.run({ client, cache: s ? s.cache : {} }, fn));
}

/* One request = one cache (settings are read many times per request). */
function withRequest(fn) { return als.run({ client: undefined, cache: {} }, fn); }
const cache = () => { const s = store(); return s ? s.cache : null; };

async function close() { if (engine) { const e = engine; engine = null; await e.close(); } }
const kind = () => eng().kind;
const ensureAlive = () => { const e = eng(); return e.ensureAlive ? e.ensureAlive() : undefined; };

module.exports = { all, get, run, exec, tx, withRequest, cache, close, kind, ensureAlive, DbConfigError, raw: eng };
