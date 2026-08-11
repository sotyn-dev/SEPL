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

function DeployDocsHtml() {
  return (
    <DocCard
      title="Deploy & image cleanup"
      blurb={
        <>
          Host <code className="bg-slate-50 px-1 rounded">data/</code> is never deleted by deploy, rollback, delete, or prune.
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
          <li>Multi-VPS: pick another worker host in the dropdown — prune/delete never fans out to all hosts.</li>
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
          <li>Enter a username (optional email for your records — email send is later).</li>
          <li>Click <strong className="font-medium text-ink">Create invite</strong>.</li>
          <li>
            Copy the one-time invite URL (<code className="text-xs bg-slate-50 px-1 rounded">/invite/:token</code>) and send it to the person.
            Token is shown once.
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
            Copy the one-time reset URL (<code className="text-xs bg-slate-50 px-1 rounded">/reset/:token</code>) and give it to them.
            Expires in 24 hours by default.
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

      <Section title="What is not day-1">
        <ul className="list-disc pl-5 space-y-1.5 text-slate-600">
          <li>Self-service “forgot password” email — later, same token model when SMTP exists.</li>
          <li>Extra roles (e.g. operator without user mgmt) — day‑1 is <code className="text-xs bg-slate-50 px-1 rounded">platform_admin</code> only.</li>
          <li>
            Set <code className="text-xs bg-slate-50 px-1 rounded">PLATFORM_PUBLIC_URL</code> in production so invite/reset links use the real UI host
            (default local: <code className="text-xs bg-slate-50 px-1 rounded">http://127.0.0.1:7101</code>).
          </li>
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
          <li>Tenant ERP databases — use each org’s ERP backups, not this page.</li>
        </ul>
      </Section>
    </DocCard>
  );
}

const TABS = [
  { id: 'deploy', label: 'Deploy' },
  { id: 'operators', label: 'Operators' },
  { id: 'backups', label: 'Backups' },
];

export default function DocsPage() {
  const [params, setParams] = useSearchParams();
  const tab = useMemo(() => {
    const t = params.get('tab') || 'deploy';
    return TABS.some((x) => x.id === t) ? t : 'deploy';
  }, [params]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl font-semibold text-ink">Docs</h1>
        <p className="text-slate-600 mt-1 text-sm max-w-2xl">
          Operator how‑tos for the platform control plane. Same content for local and VPS.
        </p>
      </div>

      <div className="border-b border-slate-200 flex gap-1" role="tablist" aria-label="Documentation sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setParams(t.id === 'deploy' ? {} : { tab: t.id })}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? 'border-blue-800 text-blue-900'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'deploy' && <DeployDocsHtml />}
      {tab === 'operators' && <OperatorsDocsHtml />}
      {tab === 'backups' && <BackupsDocsHtml />}
    </div>
  );
}
