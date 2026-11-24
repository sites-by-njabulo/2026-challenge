'use strict';
/* Local server. Only for trying the app on your own computer and for the tests: it serves public/ and hands /api/ to the same
   handler that Vercel runs (api/index.js). On Vercel this file is not used at all.
   Needs DATABASE_URL (your Supabase string), or TEST_PGLITE=1 for a throwaway in-process database.
   Run:  node --no-warnings dev-server.js   then open http://127.0.0.1:4310 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const app = require('./src/app');

const PORT = Number(process.env.PORT) || 4310;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function serveStatic(req, res, url) {
  let p;
  try { p = decodeURIComponent(url.pathname); } catch (e) { return app.send(res, 400, 'Bad request', { 'Content-Type': 'text/plain' }); }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) return app.send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return app.send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    app.send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return undefined;
}

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return app.handler(req, res);
    return serveStatic(req, res, url);
  });
}

async function start() {
  await app.init();
  const server = createServer();
  server.listen(PORT, HOST, () => console.log(`Lead Tracker running at http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}  (database: ${app.db.kind() === 'pg' ? 'Postgres from DATABASE_URL' : 'throwaway in-process test database'})`));
  return server;
}

if (require.main === module) start().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { createServer, start, app, PORT, HOST };
