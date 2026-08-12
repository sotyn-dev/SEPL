import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

function DocCard({ title, blurb, children }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden max-w-3xl">
      <div className="px-4 sm:px-5 py-4 border-b border-slate-100">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {blurb && <p className="text-xs text-slate-500 mt-1">{blurb}</p>}
      </div>
      <div className="divide-y divide-slate-100 text-sm text-slate-700">{children}</div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="px-4 sm:px-5 py-4 space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {children}
    </section>
  );
}

function CodeBlock({ children }) {
  return (
    <pre className="text-xs bg-slate-50 border border-slate-100 rounded-lg px-3 py-2 overflow-x-auto whitespace-pre-wrap font-mono text-slate-800">
      {children}
    </pre>
  );
}

function EnvDocsHtml() {
  return (
    <DocCard
      title="Platform & agent env"
      blurb={
        <>
          Two files on the VPS — not the same. Day‑1 Hostinger box runs both.
          Markdown twin: <code className="bg-slate-50 px-1 rounded">docs/PLATFORM-VPS-deploy.md</code>.
        </>
      }
    >
      <Section title="Create the files">
        <CodeBlock>{`cp platform/.env.example platform/.env
cp platform/agent.env.example platform/agent.env

openssl rand -hex 32   # → PLATFORM_JWT_SECRET
openssl rand -hex 32   # → AGENT_TOKEN (same value in BOTH files on day‑1)`}</CodeBlock>
      </Section>

      <Section title="A) platform/.env — control plane only">
        <p className="text-slate-600 text-xs">
          Read by <code className="bg-slate-50 px-1 rounded">sotyn-platform</code> (PM2). After edit:{' '}
          <code className="bg-slate-50 px-1 rounded">pm2 restart sotyn-platform</code>.
        </p>
        <CodeBlock>{`PLATFORM_PORT=7100
PLATFORM_DATA_DIR=/var/lib/sotyn/platform
PLATFORM_ADMIN_USER=admin
PLATFORM_ADMIN_PASSWORD='strong-password-first-boot-only'
PLATFORM_ADMIN_EMAIL=sotyn.soft@gmail.com
PLATFORM_JWT_SECRET='paste-first-openssl-rand-hex-32'
PLATFORM_PUBLIC_URL=https://platform.sotyn.com

# Optional SMTP for invite / forgot-password
# PLATFORM_SMTP_HOST=smtp.gmail.com
# PLATFORM_SMTP_PORT=587
# PLATFORM_SMTP_USER=sotyn.soft@gmail.com
# PLATFORM_SMTP_PASS='app-password'
# PLATFORM_EMAIL_FROM='Sotyn Platform <sotyn.soft@gmail.com>'

AGENT_URL=http://127.0.0.1:7200
AGENT_TOKEN='paste-second-openssl-rand-hex-32'`}</CodeBlock>
        <ul className="list-disc pl-5 space-y-1.5 text-slate-600 mt-2">
          <li>
            <code className="text-xs bg-slate-50 px-1 rounded">AGENT_TOKEN</code> here is the default for{' '}
            <code className="text-xs bg-slate-50 px-1 rounded">host_local</code> / hosts with no stored token.
          </li>
          <li>
            Admin password seeds only on first boot (empty users table). Then use{' '}
            <Link to="/operators" className="text-blue-800 hover:underline">Operators → Set password</Link>.
          </li>
          <li>
            Not the ERP <code className="text-xs bg-slate-50 px-1 rounded">JWT_SECRET</code> in{' '}
            <code className="text-xs bg-slate-50 px-1 rounded">/root/erp/.env</code>.
          </li>
        </ul>
      </Section>

      <Section title="B) platform/agent.env — worker agent only">
        <p className="text-slate-600 text-xs">
          Read by <code className="bg-slate-50 px-1 rounded">sotyn-agent</code>. Uncommented lines required.
          Leave <code className="bg-slate-50 px-1 rounded">LEGACY_*</code> commented until cutover. After edit:{' '}
          <code className="bg-slate-50 px-1 rounded">pm2 restart sotyn-agent</code>.
        </p>
        <CodeBlock>{`AGENT_TOKEN='paste-second-openssl-rand-hex-32'
HOST_ID=host_local
TENANTS_ROOT=/var/lib/sotyn/tenants
ERP_ENV_FILE=/root/erp/.env

# One-shot cutover only — leave commented for normal provision
# LEGACY_IMPORT_SLUG=sepl
# LEGACY_DATA_DIR=/root/erp/data
# LEGACY_BACKUP_DIR=/root/erp-backups`}</CodeBlock>
        <ul className="list-disc pl-5 space-y-1.5 text-slate-600 mt-2">
          <li>
            Day‑1: <code className="text-xs bg-slate-50 px-1 rounded">AGENT_TOKEN</code> must match{' '}
            <code className="text-xs bg-slate-50 px-1 rounded">platform/.env</code>.
          </li>
          <li>
            <code className="text-xs bg-slate-50 px-1 rounded">ERP_ENV_FILE</code> is the tenant ERP secrets file
            (JWT/SMTP/S3) passed into Docker — not platform secrets, and not legacy data paths.
          </li>
          <li>
            <code className="text-xs bg-slate-50 px-1 rounded">sotyn-agent</code> is only the PM2 nickname (
            <code className="text-xs bg-slate-50 px-1 rounded">--name</code>), not a host id.
          </li>
        </ul>
      </Section>

      <Section title="Which file is which">
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left min-w-[28rem]">
            <thead>
              <tr className="text-slate-500 border-b border-slate-100">
                <th className="py-1.5 pr-3 font-semibold">File</th>
                <th className="py-1.5 pr-3 font-semibold">Who reads it</th>
                <th className="py-1.5 font-semibold">Purpose</th>
              </tr>
            </thead>
            <tbody className="text-slate-700">
              <tr className="border-b border-slate-50">
                <td className="py-1.5 pr-3 font-mono">platform/.env</td>
                <td className="py-1.5 pr-3">Platform API</td>
                <td className="py-1.5">Login, JWT, SMTP, DB path, default agent URL/token</td>
              </tr>
              <tr className="border-b border-slate-50">
                <td className="py-1.5 pr-3 font-mono">platform/agent.env</td>
                <td className="py-1.5 pr-3">Worker agent</td>
                <td className="py-1.5">Token check, tenants disk, ERP env-file, optional legacy rsync</td>
              </tr>
              <tr>
                <td className="py-1.5 pr-3 font-mono">/root/erp/.env</td>
                <td className="py-1.5 pr-3">ERP containers</td>
                <td className="py-1.5">Tenant app secrets via ERP_ENV_FILE</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Start (PM2)">
        <CodeBlock>{`cd /root/erp
pm2 start platform/server/index.js --name sotyn-platform
pm2 start platform/worker-agent/index.js --name sotyn-agent
pm2 save

curl -s http://127.0.0.1:7100/api/health
curl -s http://127.0.0.1:7200/v1/health`}</CodeBlock>
      </Section>

      <Section title="Multi-VPS tokens (clear example)">
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left min-w-[32rem]">
            <thead>
              <tr className="text-slate-500 border-b border-slate-100">
                <th className="py-1.5 pr-3 font-semibold">Location</th>
                <th className="py-1.5 pr-3 font-semibold">File / UI</th>
                <th className="py-1.5 font-semibold">Example</th>
              </tr>
            </thead>
            <tbody className="text-slate-700">
              <tr className="border-b border-slate-50">
                <td className="py-1.5 pr-3">VPS‑A platform</td>
                <td className="py-1.5 pr-3 font-mono">platform/.env</td>
                <td className="py-1.5 font-mono">AGENT_TOKEN=token-a</td>
              </tr>
              <tr className="border-b border-slate-50">
                <td className="py-1.5 pr-3">VPS‑A agent</td>
                <td className="py-1.5 pr-3 font-mono">platform/agent.env</td>
                <td className="py-1.5 font-mono">AGENT_TOKEN=token-a · HOST_ID=host_local</td>
              </tr>
              <tr className="border-b border-slate-50">
                <td className="py-1.5 pr-3">VPS‑B agent</td>
                <td className="py-1.5 pr-3 font-mono">platform/agent.env</td>
                <td className="py-1.5 font-mono">AGENT_TOKEN=token-b · HOST_ID=host_vps_b</td>
              </tr>
              <tr>
                <td className="py-1.5 pr-3">Platform UI</td>
                <td className="py-1.5 pr-3">
                  <Link to="/hosts" className="text-blue-800 hover:underline">Hosts</Link>
                </td>
                <td className="py-1.5">Register B with URL + token-b (see Multi‑VPS tab)</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-slate-600 text-xs mt-2">
          No <code className="bg-slate-50 px-1 rounded">platform/.env</code> on B/C — agent only. Details:{' '}
          <Link to="/docs?tab=multivps" className="text-blue-800 hover:underline">Docs → Multi‑VPS</Link>.
        </p>
      </Section>

      <Section title="sepl / orphan one-shot (optional)">
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>
            In <code className="text-xs bg-slate-50 px-1 rounded">agent.env</code> uncomment:
            <CodeBlock>{`LEGACY_IMPORT_SLUG=sepl
LEGACY_DATA_DIR=/root/erp/data
LEGACY_BACKUP_DIR=/root/erp-backups`}</CodeBlock>
          </li>
          <li><code className="text-xs bg-slate-50 px-1 rounded">pm2 restart sotyn-agent</code></li>
          <li>Stop old PM2 ERP (downtime).</li>
          <li>
            <Link to="/orgs" className="text-blue-800 hover:underline">Companies</Link> → draft matching that slug →{' '}
            <strong className="font-medium text-ink">Rsync from legacy &amp; provision</strong>.
          </li>
          <li>Comment out <code className="text-xs bg-slate-50 px-1 rounded">LEGACY_IMPORT_SLUG</code> → restart agent again.</li>
        </ol>
        <p className="text-slate-600 text-xs mt-2">
          Those paths are the old PM2 folders (defaults when <code className="bg-slate-50 px-1 rounded">ERP_BACKUP_DIR</code>{' '}
          was unset). They are not read from ERP <code className="bg-slate-50 px-1 rounded">.env</code>.
        </p>
      </Section>
    </DocCard>
  );
}

function DeployDocsHtml() {
  return (
    <DocCard
      title="Deploy & image cleanup"
      blurb={
        <>
          Host <code className="bg-slate-50 px-1 rounded">data/</code> and{' '}
          <code className="bg-slate-50 px-1 rounded">backups/</code> are never deleted by deploy, rollback, delete, or prune.
          {' '}Open the live UI: <Link to="/deploy" className="text-blue-800 hover:underline">Deploy</Link>.
        </>
      }
    >
      <Section title="Deploy (new build)">
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>
            On the VPS / host: <code className="text-xs bg-slate-50 px-1 rounded">git pull origin main</code>
            {' '}(this UI never runs git).
          </li>
          <li>Open <strong className="font-medium text-ink">Deploy</strong> and pick the worker host.</li>
          <li>Enter an image tag (e.g. <code className="text-xs bg-slate-50 px-1 rounded">11-08-2026-v1</code>).</li>
          <li>Leave <strong className="font-medium text-ink">Build from current checkout</strong> on.</li>
          <li>
            Set <strong className="font-medium text-ink">Keep N unused</strong> (default 4) — after a successful deploy,
            unused older tags on this host are auto-pruned beyond that keep set.
          </li>
          <li>Click <strong className="font-medium text-ink">Build &amp; deploy</strong>.</li>
          <li>
            Wait for the job to reach <code className="text-xs bg-slate-50 px-1 rounded">ok</code> — agent builds{' '}
            <code className="text-xs bg-slate-50 px-1 rounded">sotyn-erp:&lt;tag&gt;</code> (+{' '}
            <code className="text-xs bg-slate-50 px-1 rounded">:latest</code>), recreates tenant containers, then auto-prunes.
          </li>
        </ol>
      </Section>

      <Section title="Rollback">
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Click <strong className="font-medium text-ink">Use for rollback</strong> on an older tag (or type it).</li>
          <li>Turn <strong className="font-medium text-ink">Build</strong> off.</li>
          <li>
            Click <strong className="font-medium text-ink">Rollback / redeploy</strong> — containers switch to that image; no build.
            Auto keep‑N prune still runs after success.
          </li>
        </ol>
      </Section>

      <Section title="Manual delete">
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>In <strong className="font-medium text-ink">Images on this host</strong>, find a row marked Unused.</li>
          <li>Click <strong className="font-medium text-ink">Delete</strong> and confirm.</li>
          <li>That tag is removed on the selected host only. In-use tags have no Delete action.</li>
        </ol>
      </Section>

      <Section title="Manual prune (optional)">
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Use the same <strong className="font-medium text-ink">Keep N unused</strong> value.</li>
          <li>Click <strong className="font-medium text-ink">Prune unused</strong> without deploying — cleans this host now.</li>
          <li>
            Always keeps in-use tags and <code className="text-xs bg-slate-50 px-1 rounded">:latest</code>. Host-scoped only.
          </li>
        </ol>
      </Section>

      <Section title="Notes">
        <ul className="list-disc pl-5 space-y-1.5 text-slate-600">
          <li><strong className="font-medium text-ink">Refresh</strong> reloads the image list for the selected host.</li>
          <li>Auto-prune runs only after a successful deploy/rollback on that host.</li>
          <li>
            Multi-VPS: pick another worker host in the dropdown — prune/delete never fans out to all hosts.
            See <Link to="/docs?tab=multivps" className="text-blue-800 hover:underline">Multi‑VPS</Link>.
          </li>
        </ul>
      </Section>
    </DocCard>
  );
}

function MultiVpsDocsHtml() {
  return (
    <DocCard
      title="Multi-VPS (worker hosts)"
      blurb={
        <>
          Platform stays on VPS‑A. Extra boxes run <strong className="font-medium text-ink">agent + Docker tenants only</strong>.
          Env files / tokens: <Link to="/docs?tab=env" className="text-blue-800 hover:underline">Docs → Env</Link>.
          Operations are always host-scoped.
        </>
      }
    >
      <Section title="What runs where">
        <ul className="list-disc pl-5 space-y-1.5 text-slate-600">
          <li>
            <strong className="font-medium text-ink">VPS‑A:</strong> platform API/UI + local agent + usually sepl/secured
            (+ a few orgs).
          </li>
          <li>
            <strong className="font-medium text-ink">VPS‑B+:</strong> worker agent + tenant containers + that host’s{' '}
            <code className="text-xs bg-slate-50 px-1 rounded">data/</code> and{' '}
            <code className="text-xs bg-slate-50 px-1 rounded">backups/</code> — no second platform.
          </li>
          <li>Platform never talks to Docker directly; it always calls a worker agent.</li>
        </ul>
      </Section>

      <Section title="Hosts UI — what to fill for VPS‑B">
        <p className="text-slate-600 text-xs mb-2">
          Open <Link to="/hosts" className="text-blue-800 hover:underline">Hosts</Link> → Register host.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left min-w-[28rem]">
            <thead>
              <tr className="text-slate-500 border-b border-slate-100">
                <th className="py-1.5 pr-3 font-semibold">Field</th>
                <th className="py-1.5 font-semibold">Example</th>
              </tr>
            </thead>
            <tbody className="text-slate-700">
              <tr className="border-b border-slate-50">
                <td className="py-1.5 pr-3">Host id</td>
                <td className="py-1.5 font-mono">host_vps_b</td>
              </tr>
              <tr className="border-b border-slate-50">
                <td className="py-1.5 pr-3">Label</td>
                <td className="py-1.5">VPS B</td>
              </tr>
              <tr className="border-b border-slate-50">
                <td className="py-1.5 pr-3">Agent URL</td>
                <td className="py-1.5 font-mono">http://VPS_B_PRIVATE_IP:7200</td>
              </tr>
              <tr>
                <td className="py-1.5 pr-3">Agent token</td>
                <td className="py-1.5 font-mono">token-b</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-slate-600 text-xs mt-2">
          Agent token must match B’s <code className="bg-slate-50 px-1 rounded">agent.env</code>. Use{' '}
          <code className="bg-slate-50 px-1 rounded">http://</code> (not https). Same-VPS agent uses{' '}
          <code className="bg-slate-50 px-1 rounded">http://127.0.0.1:7200</code>.
          Agent currently listens on localhost only — remote IP needs private reachability first.
        </p>
      </Section>

      <Section title="One-time: stand up a new worker VPS">
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Install Docker; clone the monorepo (build context for <code className="text-xs bg-slate-50 px-1 rounded">sotyn-erp</code> images).</li>
          <li>
            <code className="text-xs bg-slate-50 px-1 rounded">cp platform/agent.env.example platform/agent.env</code>
            {' '}→ set token / <code className="text-xs bg-slate-50 px-1 rounded">HOST_ID</code> / paths → PM2 start agent
            (see <Link to="/docs?tab=env" className="text-blue-800 hover:underline">Env</Link>).
          </li>
          <li>
            Register that host in platform <Link to="/hosts" className="text-blue-800 hover:underline">Hosts</Link>
            {' '}(table above) so Deploy / provision can reach it.
          </li>
          <li>Nginx / edge: route <code className="text-xs bg-slate-50 px-1 rounded">{'{slug}'}-erp…</code> → that box’s container ports.</li>
          <li>Provision orgs onto that host via platform → agent → Docker + bind mounts.</li>
        </ol>
      </Section>

      <Section title="Everyday code deploy (each VPS)">
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>
            On <strong className="font-medium text-ink">that</strong> VPS:{' '}
            <code className="text-xs bg-slate-50 px-1 rounded">git pull origin main</code> (platform never runs git).
          </li>
          <li>
            Platform → <Link to="/deploy" className="text-blue-800 hover:underline">Deploy</Link> → pick{' '}
            <strong className="font-medium text-ink">that host</strong>.
          </li>
          <li>Agent on that host builds <code className="text-xs bg-slate-50 px-1 rounded">sotyn-erp:$TAG</code> and recreates only its tenant containers.</li>
        </ol>
        <p className="text-slate-600 text-xs mt-2">
          Image prune/delete is also per host. Host <code className="bg-slate-50 px-1 rounded">data/</code> and{' '}
          <code className="bg-slate-50 px-1 rounded">backups/</code> are never deleted.
        </p>
      </Section>

      <Section title="Built already?">
        <ul className="list-disc pl-5 space-y-1.5 text-slate-600">
          <li>
            <strong className="font-medium text-emerald-800">Ready:</strong>{' '}
            <Link to="/hosts" className="text-blue-800 hover:underline">Hosts</Link> registry (add / edit / remove /
            health), per-host agent token, Deploy host picker, create company with host + optional provision,
            <code className="text-xs bg-slate-50 px-1 rounded"> POST /api/tenants/:slug/provision</code>.
          </li>
          <li>
            <strong className="font-medium text-amber-800">Still later:</strong> auto fan-out Deploy to all VPS,
            tenant move between hosts. Platform exclusive access uses Cloudflare Access — see{' '}
            <Link to="/docs?tab=access" className="text-blue-800 hover:underline">Docs → Access</Link>.
          </li>
          <li>
            When VPS‑B exists: register it under <Link to="/hosts" className="text-blue-800 hover:underline">Hosts</Link>,
            Health-check, then create/provision orgs onto that host id.
          </li>
        </ul>
      </Section>
    </DocCard>
  );
}

function OperatorsDocsHtml() {
  return (
    <DocCard
      title="Operators — invite &amp; password reset"
      blurb={
        <>
          Control-plane users only (not tenant ERP logins). Live UI:{' '}
          <Link to="/operators" className="text-blue-800 hover:underline">Operators</Link>.
          Seed admin is bootstrap; invite real operators and change the default password.
        </>
      }
    >
      <Section title="Invite an operator">
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Open <strong className="font-medium text-ink">Operators</strong> (must be <code className="text-xs bg-slate-50 px-1 rounded">platform_admin</code>).</li>
          <li>Enter a username and email (email enables automatic invite mail when SMTP is configured).</li>
          <li>Click <strong className="font-medium text-ink">Create invite</strong>.</li>
          <li>
            If SMTP is on, the invite is emailed; the one-time URL (
            <code className="text-xs bg-slate-50 px-1 rounded">/invite/:token</code>) is still shown once for copy/paste.
          </li>
          <li>They open the link, set a password (≥10 characters), and are signed in. Invite expires in 7 days by default.</li>
        </ol>
      </Section>

      <Section title="Password reset (admin-issued link)">
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>On the operator row, click <strong className="font-medium text-ink">Reset link</strong> and confirm.</li>
          <li>
            Their <strong className="font-medium text-ink">current password stops working immediately</strong>
            {' '}(hash replaced with an unusable value).
          </li>
          <li>
            If they have an email and SMTP is configured, the reset link is emailed; otherwise copy the one-time URL (
            <code className="text-xs bg-slate-50 px-1 rounded">/reset/:token</code>). Expires in 24 hours by default.
          </li>
          <li>They open the link, set a new password, and are signed in.</li>
        </ol>
      </Section>

      <Section title="Admin sets password directly">
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>On the operator row, click <strong className="font-medium text-ink">Set password</strong>.</li>
          <li>Enter and confirm a new password (≥10 characters), then <strong className="font-medium text-ink">Save password</strong>.</li>
          <li>Takes effect immediately. Tell them the password yourself — it is not emailed and not shown again.</li>
          <li>Any open invite/reset links for that user are invalidated.</li>
        </ol>
      </Section>

      <Section title="Deactivate / activate">
        <ol className="list-decimal pl-5 space-y-1.5">
          <li><strong className="font-medium text-ink">Deactivate</strong> blocks sign-in (JWT checks fail). You cannot deactivate yourself or the last active admin.</li>
          <li><strong className="font-medium text-ink">Activate</strong> restores access; they still need a known password (or a new reset link).</li>
        </ol>
      </Section>

      <Section title="Forgot password (self-service)">
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>On the login page, click <strong className="font-medium text-ink">Forgot password?</strong></li>
          <li>Enter username or email. If the account has email on file and SMTP is configured, a reset link is sent.</li>
          <li>Unlike admin reset, the current password keeps working until the link is used.</li>
        </ol>
      </Section>

      <Section title="SMTP &amp; notes">
        <ul className="list-disc pl-5 space-y-1.5 text-slate-600">
          <li>
            Same nodemailer pattern as ERP. Set <code className="text-xs bg-slate-50 px-1 rounded">PLATFORM_SMTP_HOST</code>,{' '}
            <code className="text-xs bg-slate-50 px-1 rounded">PLATFORM_SMTP_USER</code>,{' '}
            <code className="text-xs bg-slate-50 px-1 rounded">PLATFORM_SMTP_PASS</code> in{' '}
            <code className="text-xs bg-slate-50 px-1 rounded">platform/.env</code>.
          </li>
          <li>
            Seed admin email defaults to <code className="text-xs bg-slate-50 px-1 rounded">sotyn.soft@gmail.com</code>
            {' '}(<code className="text-xs bg-slate-50 px-1 rounded">PLATFORM_ADMIN_EMAIL</code>).
          </li>
          <li>
            Set <code className="text-xs bg-slate-50 px-1 rounded">PLATFORM_PUBLIC_URL</code> in production so invite/reset links use the real UI host
            (default local: <code className="text-xs bg-slate-50 px-1 rounded">http://127.0.0.1:7101</code>).
          </li>
          <li>Extra roles (e.g. operator without user mgmt) — day‑1 is <code className="text-xs bg-slate-50 px-1 rounded">platform_admin</code> only.</li>
        </ul>
      </Section>
    </DocCard>
  );
}

function BackupsDocsHtml() {
  return (
    <DocCard
      title="Platform database backups"
      blurb={
        <>
          Zip-only snapshots of <code className="bg-slate-50 px-1 rounded">platform.db</code> (orgs, operators, branding metadata, hosts).
          Live UI: <Link to="/backups" className="text-blue-800 hover:underline">Backups</Link>.
          Same idea as the ERP admin backups page — not tenant ERP data.
        </>
      }
    >
      <Section title="Backup Now">
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Open <strong className="font-medium text-ink">Backups</strong>.</li>
          <li>Click <strong className="font-medium text-ink">Backup Now</strong> — creates{' '}
            <code className="text-xs bg-slate-50 px-1 rounded">platform-backup-YYYY-MM-DD_HH-mm-ss.zip</code> containing{' '}
            <code className="text-xs bg-slate-50 px-1 rounded">platform.db</code>.</li>
          <li>Nightly job also runs at 2:00 AM; last 30 zips are kept (configurable).</li>
        </ol>
      </Section>

      <Section title="Download">
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Click <strong className="font-medium text-ink">Download</strong> on a row — browser streams the zip (query token; not loaded into memory).</li>
          <li>Save a copy weekly to a laptop / Drive folder.</li>
        </ol>
      </Section>

      <Section title="Restore">
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Stop the platform process (PM2 / local server).</li>
          <li>Unzip the archive → you get <code className="text-xs bg-slate-50 px-1 rounded">platform.db</code>.</li>
          <li>Replace the live file under <code className="text-xs bg-slate-50 px-1 rounded">PLATFORM_DATA_DIR</code> (or <code className="text-xs bg-slate-50 px-1 rounded">platform/data/</code> locally).</li>
          <li>Start platform again.</li>
        </ol>
      </Section>

      <Section title="Not included">
        <ul className="list-disc pl-5 space-y-1.5 text-slate-600">
          <li>Uploaded branding assets under <code className="text-xs bg-slate-50 px-1 rounded">data/tenants/…/assets/</code> — back those up separately if needed.</li>
          <li>Tenant ERP databases — use each org’s ERP Settings → Backups (zips on that tenant’s host <code className="text-xs bg-slate-50 px-1 rounded">backups/</code> mount), not this page.</li>
        </ul>
      </Section>
    </DocCard>
  );
}

function AccessDocsHtml() {
  return (
    <DocCard
      title="Cloudflare Access — exclusive platform access"
      blurb={
        <>
          Primary gate for the control plane. Browser only (Mac/Windows) — no VPN app.
          Full runbook: <code className="bg-slate-50 px-1 rounded">docs/PLATFORM-Cloudflare-Access.md</code>.
          Do <strong className="font-medium text-ink">not</strong> remove platform login — keep JWT / Operators / Audit.
        </>
      }
    >
      <Section title="Why two layers">
        <ul className="list-disc pl-5 space-y-1.5 text-slate-600">
          <li>
            <strong className="font-medium text-ink">Cloudflare Access</strong> — who can reach the site at all
            (email OTP / IdP allow list).
          </li>
          <li>
            <strong className="font-medium text-ink">Platform login</strong> — which operator is signed in, invites,
            deactivate, audit. Already built; leave it on.
          </li>
          <li>Tenant ERP URLs stay public. Agent stays on localhost only. Nothing to install in platform npm packages.</li>
        </ul>
      </Section>

      <Section title="Prerequisites (once)">
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Domain on Cloudflare DNS; <code className="text-xs bg-slate-50 px-1 rounded">platform.sotyn.com</code> proxied (orange cloud).</li>
          <li>Platform nginx + TLS on the VPS (see VPS deploy docs).</li>
          <li>Cloudflare Zero Trust org (free tier OK for ≤50 seats).</li>
        </ol>
      </Section>

      <Section title="Cloudflare dashboard">
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Zero Trust → Authentication → enable <strong className="font-medium text-ink">One-time PIN</strong> (simplest).</li>
          <li>Access → Applications → Add → <strong className="font-medium text-ink">Self-hosted</strong> for <code className="text-xs bg-slate-50 px-1 rounded">platform.sotyn.com</code>.</li>
          <li>
            Policy <strong className="font-medium text-ink">Allow</strong> → Include → Emails → your 2–3 operator addresses.
          </li>
          <li>Save. Optional later: lock origin firewall to Cloudflare IPs only.</li>
        </ol>
      </Section>

      <Section title="Operator day-to-day">
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Open <code className="text-xs bg-slate-50 px-1 rounded">https://platform.sotyn.com</code> in a normal browser.</li>
          <li>Cloudflare Access: enter email → OTP (or IdP).</li>
          <li>Then platform <code className="text-xs bg-slate-50 px-1 rounded">/login</code> with username + password.</li>
        </ol>
      </Section>

      <Section title="Add / remove an operator">
        <ul className="list-disc pl-5 space-y-1.5 text-slate-600">
          <li>
            <strong className="font-medium text-ink">Add:</strong> put their email on the Access allow list, then invite under{' '}
            <Link to="/operators" className="text-blue-800 hover:underline">Operators</Link>.
          </li>
          <li>
            <strong className="font-medium text-ink">Remove:</strong> remove email from Access (revoke sessions if needed) +{' '}
            Operators → Deactivate.
          </li>
        </ul>
      </Section>

      <Section title="Smoke test">
        <ul className="list-disc pl-5 space-y-1.5 text-slate-600">
          <li>Email not on allow list → cannot pass Access.</li>
          <li>Allow-listed → OTP → platform login works; wrong platform password still fails.</li>
          <li>
            Set <code className="text-xs bg-slate-50 px-1 rounded">PLATFORM_PUBLIC_URL=https://platform.sotyn.com</code> for invite/reset links.
          </li>
        </ul>
      </Section>
    </DocCard>
  );
}

function AuditDocsHtml() {
  return (
    <DocCard
      title="Platform audit log"
      blurb={
        <>
          Who did what on the control plane. Same shape as ERP Admin → Audit Log, stored in{' '}
          <code className="bg-slate-50 px-1 rounded">platform_audit</code> inside{' '}
          <code className="bg-slate-50 px-1 rounded">platform.db</code>.
          Live UI: <Link to="/audit" className="text-blue-800 hover:underline">Audit</Link>.
        </>
      }
    >
      <Section title="What is recorded">
        <ul className="list-disc pl-5 space-y-1.5 text-slate-600">
          <li>Every mutating API call after sign-in (POST / PUT / PATCH / DELETE) — create org, brand save, deploy, hosts, invite, backup run, etc.</li>
          <li>Login success and failure (manual events; passwords never stored).</li>
          <li>Invite accept, password reset via link, change-password (success / fail).</li>
          <li>Body fields named password / token / secret / agent_token are redacted to <code className="text-xs bg-slate-50 px-1 rounded">[REDACTED]</code>.</li>
        </ul>
      </Section>

      <Section title="Using the page">
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Open <strong className="font-medium text-ink">Audit</strong>.</li>
          <li>Filter by operator, module, action, date range, or free-text search.</li>
          <li>Click a row for path, redacted body, and optional before/after snapshots.</li>
        </ol>
      </Section>

      <Section title="Not this log">
        <ul className="list-disc pl-5 space-y-1.5 text-slate-600">
          <li>Tenant ERP user activity — that stays in each org’s ERP Admin → Audit Log.</li>
          <li>Reading the audit page itself is not logged (avoids noise).</li>
        </ul>
      </Section>
    </DocCard>
  );
}

const TABS = [
  { id: 'env', label: 'Env' },
  { id: 'deploy', label: 'Deploy' },
  { id: 'multivps', label: 'Multi‑VPS' },
  { id: 'access', label: 'Access' },
  { id: 'operators', label: 'Operators' },
  { id: 'backups', label: 'Backups' },
  { id: 'audit', label: 'Audit' },
];

export default function DocsPage() {
  const [params, setParams] = useSearchParams();
  const tab = useMemo(() => {
    const t = params.get('tab') || 'env';
    return TABS.some((x) => x.id === t) ? t : 'env';
  }, [params]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl font-semibold text-ink">Docs</h1>
        <p className="text-slate-600 mt-1 text-sm max-w-2xl">
          Operator how‑tos for the platform control plane. Same content for local and VPS.
        </p>
      </div>

      <div className="border-b border-slate-200 flex gap-1 overflow-x-auto" role="tablist" aria-label="Documentation sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setParams(t.id === 'env' ? {} : { tab: t.id })}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              tab === t.id
                ? 'border-blue-800 text-blue-900'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'env' && <EnvDocsHtml />}
      {tab === 'deploy' && <DeployDocsHtml />}
      {tab === 'multivps' && <MultiVpsDocsHtml />}
      {tab === 'access' && <AccessDocsHtml />}
      {tab === 'operators' && <OperatorsDocsHtml />}
      {tab === 'backups' && <BackupsDocsHtml />}
      {tab === 'audit' && <AuditDocsHtml />}
    </div>
  );
}
