'use strict';
/* A real Postgres wire-protocol server backed by PGlite, on a local port. With it the tests can run the PRODUCTION path
   (the `pg` package, DATABASE_URL, pool of one connection) without a Supabase account.
   Used when the tests are started with TEST_VIA_PG=1. */
async function startPgServer(port) {
  const { PGlite } = require('@electric-sql/pglite');
  const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
  const lite = await PGlite.create();
  const server = new PGLiteSocketServer({ db: lite, port, host: '127.0.0.1' });
  await server.start();
  return {
    lite,
    url: 'postgresql://postgres:test%40pass@127.0.0.1:' + port + '/postgres', // %40 on purpose: a password with a special character, URL-encoded
    async stop() { try { await server.stop(); } catch (e) { /* ignore */ } try { await lite.close(); } catch (e) { /* ignore */ } },
  };
}
module.exports = { startPgServer };
