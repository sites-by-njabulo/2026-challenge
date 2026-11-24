'use strict';
/* A pretend Zapmail API for tests. It follows the shapes in Zapmail's published docs and records every call it receives. */
const http = require('node:http');

function startMock(port, validKey) {
  const calls = [];
  const state = { mode: 'ok' }; // ok | not_enabled | rate | bad_key
  const boxes = [
    { id: 'mb-1', username: 'jay', email: 'jay@mock-one.test', firstName: 'Jay', lastName: 'T', password: 'SECRETPW-111', appPassword: 'SECRETAPP-222', secret: 'SECRET2FA-333', status: 'ACTIVE', domain: 'mock-one.test', createdAt: '2026-11-23T08:00:00.000Z', isWarmedUp: false },
    { id: 'mb-2', username: 'hello', email: 'hello@mock-one.test', firstName: 'Jay', lastName: 'T', password: 'SECRETPW-444', appPassword: 'SECRETAPP-555', secret: 'SECRET2FA-666', status: 'ACTIVE', domain: 'mock-one.test', createdAt: '2026-11-23T08:00:00.000Z', isWarmedUp: false },
    { id: 'mb-3', username: 'jay', email: 'jay@mock-two.test', firstName: 'Jay', lastName: 'T', password: 'SECRETPW-777', appPassword: 'SECRETAPP-888', secret: 'SECRET2FA-999', status: 'ACTIVE', domain: 'mock-two.test', createdAt: '2026-11-23T08:00:00.000Z', isWarmedUp: false },
  ];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      calls.push({ method: req.method, path: url.pathname, search: url.search, auth: req.headers['x-auth-zapmail'], body: raw });
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (state.mode === 'rate') return send(429, { error: 'Too many requests' });
      if (state.mode === 'not_enabled') return send(403, { status: 403, message: 'You are not permitted to perform this action, please contact support' });
      if (state.mode === 'bad_key' || req.headers['x-auth-zapmail'] !== validKey) return send(401, { status: 401, message: 'Invalid API key' });
      if (req.method === 'POST' && url.pathname === '/api/v3/mailboxes/list') {
        const byDomain = {};
        for (const b of boxes) (byDomain[b.domain] = byDomain[b.domain] || []).push(b);
        return send(200, { status: 200, message: 'Mailboxes fetched successfully', data: { currentPage: 1, nextPage: null, totalPages: 1, domains: Object.entries(byDomain).map(([domain, list], i) => ({ id: 'd-' + i, domain, status: 'ACTIVE', serviceProvider: 'GOOGLE', mailboxes: list })) } });
      }
      if (req.method === 'POST' && url.pathname === '/api/v3/domains') {
        return send(200, { status: 200, message: 'Domains fetched successfully', data: { currentPage: 1, nextPage: null, totalPages: 1, domains: [
          { id: 'd-0', domain: 'mock-one.test', status: 'ACTIVE', nameServers: ['a.ns', 'b.ns'], expectedNameServers: ['b.ns', 'a.ns'], healthScore: '98', healthLabel: 'Good', isSpamhausBlacklisted: false, assignedMailboxesCount: '2' },
          { id: 'd-1', domain: 'mock-two.test', status: 'ACTIVE', nameServers: ['old.ns'], expectedNameServers: ['a.ns', 'b.ns'], healthScore: '70', healthLabel: 'Fair', isSpamhausBlacklisted: false, assignedMailboxesCount: '1' }] } });
      }
      if (req.method === 'POST' && url.pathname === '/api/v3/zap-warm/scores') {
        const ids = JSON.parse(raw || '{}').mailboxIds || [];
        const data = {};
        for (const id of ids) data[id] = id === 'mb-3' ? null : { warmupScore: id === 'mb-1' ? 60 : 40, sent: id === 'mb-1' ? 12 : 8, landedInInbox: id === 'mb-1' ? 12 : 7, landedInSpam: id === 'mb-1' ? 0 : 1, savedFromSpam: 0, inboxRate: id === 'mb-1' ? 100 : 87.5, warmupStartedOn: '2026-11-23T08:00:00.000Z' };
        return send(200, { status: 200, message: 'ok', data });
      }
      return send(404, { status: 404, message: 'Not found' });
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ calls, state, close: () => srv.close() })));
}
module.exports = { startMock };
