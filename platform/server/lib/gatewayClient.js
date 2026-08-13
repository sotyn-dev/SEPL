'use strict';

/**
 * Primary gateway agent client (optional).
 * When GATEWAY_URL is unset, all calls no-op — worker provision still works.
 */
const GATEWAY_URL = (process.env.GATEWAY_URL || '').replace(/\/$/, '');
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || 'dev-gateway-token';
const UPSTREAM_HOST = process.env.GATEWAY_UPSTREAM_HOST || '127.0.0.1';

function enabled() {
  return !!GATEWAY_URL;
}

async function gatewayFetch(path, { method = 'GET', body } = {}) {
  if (!GATEWAY_URL) {
    return { skipped: true, reason: 'GATEWAY_URL unset' };
  }
  const url = `${GATEWAY_URL}${path}`;
  const headers = {
    Authorization: `Bearer ${GATEWAY_TOKEN}`,
    Accept: 'application/json',
  };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload });
  } catch (e) {
    const err = new Error(`Gateway unreachable: ${e.message || e}`);
    err.status = 502;
    throw err;
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(data.error || `Gateway HTTP ${res.status}`);
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}

function buildUpstream(port, host = UPSTREAM_HOST) {
  const p = Number(port);
  if (!p || p < 1) {
    const err = new Error('upstream port required');
    err.status = 400;
    throw err;
  }
  return `${host}:${p}`;
}

/**
 * After worker provision: route + HTTP-01 cert (best-effort unless throwOnError).
 */
async function syncTenantEdge(tenantRow, { port, throwOnError = false } = {}) {
  if (!GATEWAY_URL) return { skipped: true, reason: 'GATEWAY_URL unset' };
  const hostname = tenantRow.hostname || `${tenantRow.slug}.sotyn.ai`;
  const upstream = buildUpstream(port);
  try {
    const route = await gatewayFetch('/v1/routes/sync', {
      method: 'POST',
      body: { hostname, upstream, action: 'upsert' },
    });
    const cert = await gatewayFetch('/v1/certs/ensure', {
      method: 'POST',
      body: { hostname },
    });
    return { ok: true, hostname, upstream, route, cert };
  } catch (e) {
    if (throwOnError) throw e;
    return {
      ok: false,
      hostname,
      upstream,
      error: e.message || String(e),
      detail: e.detail,
    };
  }
}

async function removeTenantEdge(tenantRow, { throwOnError = false } = {}) {
  if (!GATEWAY_URL) return { skipped: true, reason: 'GATEWAY_URL unset' };
  const hostname = tenantRow.hostname || `${tenantRow.slug}.sotyn.ai`;
  try {
    const route = await gatewayFetch('/v1/routes/sync', {
      method: 'POST',
      body: { hostname, action: 'delete' },
    });
    return { ok: true, hostname, route };
  } catch (e) {
    if (throwOnError) throw e;
    return { ok: false, hostname, error: e.message || String(e), detail: e.detail };
  }
}

module.exports = {
  enabled,
  gatewayFetch,
  buildUpstream,
  syncTenantEdge,
  removeTenantEdge,
  GATEWAY_URL,
  UPSTREAM_HOST,
};
