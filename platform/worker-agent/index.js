'use strict';

/**
 * Worker agent stub — day-1 verbs live here later.
 * Platform always talks to the agent; local default is this process on :7200.
 */
const http = require('http');

const PORT = Number(process.env.AGENT_PORT || 7200);
const TOKEN = process.env.AGENT_TOKEN || 'dev-agent-token';

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function authorized(req) {
  const h = req.headers.authorization || '';
  return h === `Bearer ${TOKEN}`;
}

const server = http.createServer((req, res) => {
  if (req.url === '/v1/health' && req.method === 'GET') {
    return json(res, 200, { ok: true, service: 'sotyn-worker-agent', mode: 'stub' });
  }
  if (!authorized(req)) {
    return json(res, 401, { error: 'Unauthorized' });
  }
  if (req.url === '/v1/host' && req.method === 'GET') {
    return json(res, 200, {
      hostId: process.env.HOST_ID || 'host_local',
      mode: 'stub',
      note: 'Docker / local drivers not implemented yet',
    });
  }
  if (req.url === '/v1/tenants' && req.method === 'GET') {
    return json(res, 200, { tenants: [], note: 'stub' });
  }
  json(res, 501, { error: 'Not implemented in stub', path: req.url });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[worker-agent] stub http://127.0.0.1:${PORT}/v1 (Bearer ${TOKEN})`);
});
