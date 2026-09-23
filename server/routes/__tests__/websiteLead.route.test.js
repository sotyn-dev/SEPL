// Security matrix for POST /api/webhooks/website-lead — run against the real
// route, a real Express server and a real (scratch) SQLite database.
//
//   node --test server/routes/__tests__/websiteLead.route.test.js
//
// Why this exists: from 21 Sep 2026 the website appended the webhook secret to
// the URL in every page's JavaScript, so the credential was readable by anyone
// who opened View Source (found 22 Sep). The fix stops treating a static site as
// something that can hold a secret: the site is admitted by Origin, and the
// secret path is for server-to-server callers only and has no fallback value.
//
// That trades one control for several, so the several are tested here rather
// than asserted in a pull request: origin forgery, a dead leaked credential,
// payload abuse, replay, concurrency, and rate limiting including the usual
// ways round it.
//
// Isolation: the limiter's buckets live in a closure created when routes/
// webhooks.js is required, so every test gets its own server with the module
// cache busted — otherwise one test's requests spend the next test's allowance.
// The database is shared on purpose (one connection, one sequence) and lives in
// a temp directory that is deleted at the end. Nothing here touches the live DB.
//
// Two packages in package.json are not installed on this machine (otpauth,
// qrcode). They are reached only by the TOTP/QR path, which this route never
// touches, so node_modules carries inert stubs that throw if anything actually
// calls them. If you see that error, the stub found a real code path and the
// packages need installing.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const WORKDIR = mkdtempSync(join(tmpdir(), 'erp-weblead-'));
process.env.ERP_DB_PATH = join(WORKDIR, 'scratch.db');
delete process.env.WEBSITE_WEBHOOK_SECRET; // the route must close that path when unset

const express = require('express');
const { initializeDatabase, getDb } = require('../../db/schema');

const ALLOWED = 'https://www.securedengineers.com';
const ROUTE = require.resolve('../webhooks');
const LIMITER = require.resolve('../../lib/rateLimit');

// A server whose rate-limit buckets are empty, so each test starts level.
async function freshServer() {
  delete require.cache[ROUTE];
  delete require.cache[LIMITER];
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/webhooks', require(ROUTE));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => server.close(),
    post: (body, { origin, headers = {}, query = '' } = {}) =>
      fetch(`${base}/api/webhooks/website-lead${query}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(origin ? { Origin: origin } : {}),
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
  };
}

// Run fn against a throwaway server, always closing it.
const withServer = async (fn) => {
  const s = await freshServer();
  try {
    return await fn(s);
  } finally {
    s.close();
  }
};

const leadRows = (refFragment) =>
  getDb()
    .prepare(`SELECT lead_no, client_name, remarks FROM sales_funnel WHERE remarks LIKE ?`)
    .all(`%${refFragment}%`);

const ref = (n) => `SEPL-20260923-TEST${String(n).padStart(4, '0')}`;

// Must match websiteBurstLimit in routes/webhooks.js. Raised from 8 on
// 23 Sep 2026 because a refused request spends the allowance and the address it
// spends belongs to everyone behind that NAT — see the matrix doc, finding A.
const BURST = 20;

// Failure messages that name the status AND the body, so a 500 is diagnosable
// from the test output instead of needing a re-run with logging.
const expectStatus = async (res, want, what) => {
  if (res.status === want) return res;
  let body = '';
  try {
    body = JSON.stringify(await res.json());
  } catch {
    body = '<no json body>';
  }
  assert.fail(`${what}: expected ${want}, got ${res.status} — ${body}`);
};

before(() => {
  initializeDatabase();
  // sales_funnel carries `influencer_id INTEGER REFERENCES influencers(id)`, and
  // the pragma sets foreign_keys = ON — so SQLite refuses every INSERT into
  // sales_funnel until the `influencers` table exists. initializeDatabase() does
  // not create it: routes/influencers.js does, as a side effect of being
  // required. The live server requires every route at boot so both happen, but
  // lead capture does quietly depend on an unrelated module having loaded first.
  // Requiring it here mirrors the real server rather than papering over it.
  require('../influencers');
});

after(() => {
  rmSync(WORKDIR, { recursive: true, force: true });
});

// ── 1. Origin: missing, forged, look-alike ────────────────────────────────────

test('no Origin header and no secret is refused', () =>
  withServer(async ({ post }) => {
    await expectStatus(await post({ name: 'No Origin' }), 401, 'a caller with no identity');
  }));

test('a forged or look-alike Origin is refused', () =>
  withServer(async ({ post }) => {
    const forged = [
      'https://evil-securedengineers.com',
      'https://securedengineers.com.attacker.dev',
      'https://www.securedengineers.com.evil.test',
      'http://www.securedengineers.com', // plain http is a different origin
      'null',
      'https://WWW.SECUREDENGINEERS.COM.evil',
      'https://securedengineers.com:8443',
    ];
    for (const origin of forged) {
      await expectStatus(await post({ name: 'Forged' }, { origin }), 401, `Origin ${origin}`);
    }
  }));

test('our own site is admitted and the lead is recorded', () =>
  withServer(async ({ post }) => {
    for (const origin of [ALLOWED, 'https://securedengineers.com']) {
      const n = origin === ALLOWED ? 1 : 11;
      const r = await expectStatus(
        await post({ name: 'Origin Admitted', phone: '9811111111', lead_id: ref(n) }, { origin }),
        201,
        `Origin ${origin}`,
      );
      const body = await r.json();
      assert.equal(body.success, true);
      assert.match(body.lead_no, /^SEPL\d+$/);
      assert.equal(leadRows(ref(n)).length, 1);
    }
  }));

// ── 2. The leaked credential is dead ──────────────────────────────────────────

test('with no secret configured, NO secret opens the route — the leaked one included', () =>
  withServer(async ({ post }) => {
    // The property under test is that the route has no fallback credential, so
    // there is nothing for a published value to match. That is stronger than
    // checking one string, and it means the value that was exposed on 21 Sep
    // does not have to be written down again here. Set LEAKED_SECRET in the
    // environment to include the real historical value in this run.
    const leaked = process.env.LEAKED_SECRET || 'any-value-that-was-ever-in-the-source';
    const carriers = [
      { headers: { 'x-webhook-secret': leaked } },
      { headers: { 'x-api-key': leaked } },
      { headers: { authorization: `Bearer ${leaked}` } },
      { query: `?secret=${leaked}` },
    ];
    for (const carrier of carriers) {
      await expectStatus(
        await post({ name: 'Leaked secret' }, carrier),
        401,
        `leaked secret via ${JSON.stringify(carrier)}`,
      );
    }
    // And in the body, which is where a copied cURL example would put it.
    await expectStatus(
      await post({ name: 'Leaked secret', secret: leaked, webhook_secret: leaked }),
      401,
      'leaked secret in the body',
    );
  }));

// ── 3. Payload abuse ──────────────────────────────────────────────────────────

test('hostile field content is stored as data, never executed', () =>
  withServer(async ({ post }) => {
    const nasty = "Robert'); DROP TABLE sales_funnel;--";
    await expectStatus(
      await post(
        {
          name: nasty,
          company: '<script>alert(document.cookie)</script>',
          project_details: 'a b',
          lead_id: ref(2),
        },
        { origin: ALLOWED },
      ),
      201,
      'hostile payload',
    );
    // The table still exists and the payload came back verbatim: it was bound as
    // a parameter, not concatenated into SQL.
    const rows = leadRows(ref(2));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].client_name, nasty);
    assert.equal(
      getDb().prepare(`SELECT count(*) c FROM sqlite_master WHERE name='sales_funnel'`).get().c,
      1,
      'sales_funnel was dropped — the statement is not parameterised',
    );
  }));

test('a missing name is rejected before anything is written', () =>
  withServer(async ({ post }) => {
    const before = leadRows('SEPL-20260923-TEST').length;
    await expectStatus(await post({ phone: '9800000000' }, { origin: ALLOWED }), 400, 'nameless lead');
    assert.equal(leadRows('SEPL-20260923-TEST').length, before);
  }));

test('the honeypot answers success and writes nothing', () =>
  withServer(async ({ post }) => {
    const r = await expectStatus(
      await post({ name: 'Bot', website_url: 'http://spam.example', lead_id: ref(3) }, { origin: ALLOWED }),
      200,
      'honeypot',
    );
    assert.equal((await r.json()).success, true, 'a bot must not learn it was caught');
    assert.equal(leadRows(ref(3)).length, 0, 'the honeypot must not create a lead');
  }));

test('a body larger than the parser limit cannot reach the handler', () =>
  withServer(async ({ post }) => {
    const r = await post({ name: 'Huge', project_details: 'x'.repeat(2 * 1024 * 1024) }, { origin: ALLOWED });
    assert.ok(r.status >= 400, `oversized body returned ${r.status}`);
    assert.notEqual(r.status, 201);
  }));

test('a value band is read as its floor, not its ceiling', () =>
  withServer(async ({ post }) => {
    await expectStatus(
      await post({ name: 'Band', project_value: '₹50 lakh – ₹1 crore', lead_id: ref(4) }, { origin: ALLOWED }),
      201,
      'band lead',
    );
    const row = getDb()
      .prepare(`SELECT estimated_value FROM sales_funnel WHERE remarks LIKE ?`)
      .get(`%${ref(4)}%`);
    assert.equal(row.estimated_value, 5000000, 'a ₹50 lakh enquiry must not be filed as ₹1 crore');
  }));

// ── 4. Replay and concurrency ─────────────────────────────────────────────────

test('replaying the same submission returns the first lead instead of making a second', () =>
  withServer(async ({ post }) => {
    const body = { name: 'Replay', phone: '9822222222', lead_id: ref(5) };
    const first = await expectStatus(await post(body, { origin: ALLOWED }), 201, 'first submission');
    const firstNo = (await first.json()).lead_no;

    for (let i = 0; i < 3; i++) {
      const again = await expectStatus(await post(body, { origin: ALLOWED }), 200, `replay ${i + 1}`);
      const j = await again.json();
      assert.equal(j.duplicate, true);
      assert.equal(j.lead_no, firstNo, 'a replay must answer with the lead that already exists');
    }
    assert.equal(leadRows(ref(5)).length, 1, 'a replayed submission must leave exactly one row');
  }));

test('simultaneous copies of one submission leave exactly one lead', () =>
  withServer(async ({ post }) => {
    const body = { name: 'Race', phone: '9833333333', lead_id: ref(6) };
    const replies = await Promise.all([
      post(body, { origin: ALLOWED }),
      post(body, { origin: ALLOWED }),
      post(body, { origin: ALLOWED }),
      post(body, { origin: ALLOWED }),
    ]);
    const codes = replies.map((r) => r.status);
    const rows = leadRows(ref(6));
    assert.equal(
      rows.length,
      1,
      `four concurrent copies produced ${rows.length} leads (statuses ${codes.join(', ')}) — Sales would work one enquiry more than once`,
    );
  }));

// ── 5. Rate limiting, and the usual ways round it ─────────────────────────────

test('a burst from one connection is cut off at the limit', () =>
  withServer(async ({ post }) => {
    const codes = [];
    for (let i = 0; i < BURST + 4; i++) {
      const r = await post({ name: `Burst ${i}`, lead_id: `SEPL-20260923-BRST${i}` }, { origin: ALLOWED });
      codes.push(r.status);
    }
    assert.ok(codes.includes(429), `no request was limited: ${codes.join(', ')}`);
    assert.equal(
      codes.indexOf(429),
      BURST,
      `the limiter cut in at request ${codes.indexOf(429) + 1}, expected number ${BURST + 1}`,
    );
  }));

test('a refused request still spends the allowance — a NAT can be locked out by someone else', () =>
  withServer(async ({ post }) => {
    // Documented, not desired. The limiter sits in front of the handler, so a
    // full window of 401s from one address leaves a genuine visitor on that
    // address with nothing left. Behind a factory's single NAT that is everyone
    // in the building — which is why the window was raised to 20 rather than
    // left at 8. See finding A in the matrix doc.
    for (let i = 0; i < BURST; i++) await post({ name: 'Refused' }); // no Origin → 401
    const genuine = await post({ name: 'Genuine visitor', lead_id: ref(8) }, { origin: ALLOWED });
    assert.equal(genuine.status, 429, 'behaviour changed — re-check the NAT note in the PR');
    assert.equal(leadRows(ref(8)).length, 0);
  }));

test('rotating X-Forwarded-For does not mint a fresh allowance', () =>
  withServer(async ({ post }) => {
    // req.ip derives from X-Forwarded-For when Express trusts a proxy, so a bot
    // rotating the header would get a new bucket per request. clientIp()
    // deliberately does not read it.
    for (let i = 0; i < BURST; i++) {
      await post({ name: `Fill ${i}`, lead_id: `SEPL-20260923-FILL${i}` }, { origin: ALLOWED });
    }
    const codes = [];
    for (let i = 0; i < 4; i++) {
      const r = await post(
        { name: `XFF ${i}`, lead_id: `SEPL-20260923-XFFF${i}` },
        { origin: ALLOWED, headers: { 'X-Forwarded-For': `203.0.113.${i}` } },
      );
      codes.push(r.status);
    }
    assert.ok(
      codes.every((c) => c === 429),
      `a forged X-Forwarded-For reset the limit: ${codes.join(', ')}`,
    );
  }));

test('X-Real-IP is honoured from a local socket, which is what nginx is — and nothing else may be', () =>
  withServer(async ({ post }) => {
    // clientIp() trusts X-Real-IP only when the connection came from loopback,
    // because on the VPS nginx overwrites it. This test connects over loopback,
    // so it stands in for nginx: each X-Real-IP gets its own allowance.
    //
    // The security property this pins is the REQUIREMENT: nothing except nginx
    // may be able to open a loopback connection to the Node port. If the port is
    // ever exposed, or another process on the box can reach it, X-Real-IP
    // becomes a free rate-limit bypass.
    for (let i = 0; i < BURST; i++) {
      await post({ name: `A ${i}`, lead_id: `SEPL-20260923-RIPA${i}` }, { origin: ALLOWED, headers: { 'X-Real-IP': '198.51.100.1' } });
    }
    const exhausted = await post({ name: 'A last' }, { origin: ALLOWED, headers: { 'X-Real-IP': '198.51.100.1' } });
    assert.equal(exhausted.status, 429, 'the first address should be out of allowance');

    const other = await post(
      { name: 'B first', lead_id: ref(9) },
      { origin: ALLOWED, headers: { 'X-Real-IP': '198.51.100.2' } },
    );
    assert.equal(other.status, 201, 'a different X-Real-IP must get its own allowance via nginx');
  }));

// ── 6. The secret path, when a server-to-server caller actually has one ───────

test('a configured secret admits a server-to-server caller and is not rate limited', async () => {
  const secret = 'rotate-me-only-on-the-server';
  process.env.WEBSITE_WEBHOOK_SECRET = secret;
  try {
    await withServer(async ({ post }) => {
      await expectStatus(
        await post({ name: 'Server to server', lead_id: ref(7) }, { headers: { 'x-webhook-secret': secret } }),
        201,
        'a valid secret with no Origin',
      );
      await expectStatus(
        await post({ name: 'Near miss' }, { headers: { 'x-webhook-secret': `${secret}x` } }),
        401,
        'a near-miss secret',
      );
      // Twenty in a row on the secret path: keyFn returns null, so no limiting.
      const codes = [];
      for (let i = 0; i < 20; i++) {
        const r = await post(
          { name: `S2S ${i}`, lead_id: `SEPL-20260923-S2SS${i}` },
          { headers: { 'x-webhook-secret': secret } },
        );
        codes.push(r.status);
      }
      assert.ok(!codes.includes(429), `a trusted caller was rate limited: ${codes.join(', ')}`);
    });
  } finally {
    delete process.env.WEBSITE_WEBHOOK_SECRET;
  }
});
