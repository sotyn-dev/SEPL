import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { api } from '../lib/api.js';

function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-slate-600">{label}</p>
      <div className="flex gap-2">
        <input
          readOnly
          value={value}
          className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono bg-slate-50"
        />
        <button
          type="button"
          className="text-xs px-3 py-2 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 shrink-0"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* ignore */
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export default function OperatorsPage() {
  const [users, setUsers] = useState([]);
  const [smtpConfigured, setSmtpConfigured] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ username: '', email: '' });
  const [linkBanner, setLinkBanner] = useState(null);
  const [setPwUser, setSetPwUser] = useState(null);
  const [setPwForm, setSetPwForm] = useState({ password: '', confirm: '' });
  const [setPwBusy, setSetPwBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(() => {
    api('/api/users')
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Failed to list users');
        setUsers(d.users || []);
        setSmtpConfigured(!!d.smtpConfigured);
      })
      .catch((e) => setError(String(e.message || e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const invite = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setLinkBanner(null);
    setBusy(true);
    try {
      const r = await api('/api/users/invite', {
        method: 'POST',
        body: JSON.stringify({
          username: form.username.trim(),
          email: form.email.trim() || undefined,
          role: 'platform_admin',
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Invite failed');
      setForm({ username: '', email: '' });
      setLinkBanner({
        title: `Invite for ${d.user.username}`,
        path: d.invitePath,
        url: d.inviteUrl,
        expiresAt: d.expiresAt,
        note: d.note,
        emailSent: d.emailSent,
      });
      setNotice(
        d.emailSent
          ? `Invite emailed to ${d.user.email}. Link also shown once below.`
          : 'Invite created — copy the link now (token shown once).'
      );
      load();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  };

  const runResetPassword = async (u) => {
    setError('');
    setNotice('');
    setLinkBanner(null);
    setSetPwUser(null);
    try {
      const r = await api(`/api/users/${encodeURIComponent(u.id)}/reset-password`, {
        method: 'POST',
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Reset failed');
      setLinkBanner({
        title: `Password reset for ${d.username}`,
        path: d.resetPath,
        url: d.resetUrl,
        expiresAt: d.expiresAt,
        note: d.note,
        emailSent: d.emailSent,
      });
      setNotice(
        d.emailSent
          ? 'Reset emailed — old password invalidated.'
          : 'Reset link ready — old password invalidated.'
      );
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  const resetPassword = (u) => {
    setConfirm({
      title: `Reset password for ${u.username}?`,
      message: u.email
        ? `Their current password will stop working immediately. A reset link will be emailed to ${u.email} if SMTP is configured (and still shown once here).`
        : 'Their current password will stop working immediately. No email on file — you must copy the new reset link.',
      confirmLabel: 'Reset & show link',
      tone: 'danger',
      onConfirm: () => runResetPassword(u),
    });
  };

  const openSetPassword = (u) => {
    setError('');
    setNotice('');
    setLinkBanner(null);
    setSetPwUser(u);
    setSetPwForm({ password: '', confirm: '' });
  };

  const submitSetPassword = async (e) => {
    e.preventDefault();
    if (!setPwUser) return;
    setError('');
    setNotice('');
    if (setPwForm.password !== setPwForm.confirm) {
      setError('Passwords do not match');
      return;
    }
    if (setPwForm.password.length < 10) {
      setError('Password must be at least 10 characters');
      return;
    }
    setSetPwBusy(true);
    try {
      const r = await api(`/api/users/${encodeURIComponent(setPwUser.id)}/set-password`, {
        method: 'POST',
        body: JSON.stringify({ password: setPwForm.password }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Set password failed');
      setNotice(`Password set for ${d.username}. Tell them out of band — it is not shown again.`);
      setSetPwUser(null);
      setSetPwForm({ password: '', confirm: '' });
      load();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setSetPwBusy(false);
    }
  };

  const runToggleActive = async (u) => {
    const action = u.active ? 'deactivate' : 'activate';
    setError('');
    try {
      const r = await api(`/api/users/${encodeURIComponent(u.id)}/${action}`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `${action} failed`);
      setNotice(`${u.username} ${u.active ? 'deactivated' : 'activated'}.`);
      load();
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  const toggleActive = (u) => {
    if (!u.active) {
      runToggleActive(u);
      return;
    }
    setConfirm({
      title: `Deactivate ${u.username}?`,
      message: 'They will not be able to sign in until activated again.',
      confirmLabel: 'Deactivate',
      tone: 'warning',
      onConfirm: () => runToggleActive(u),
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-semibold text-ink">Operators</h1>
          <p className="text-slate-600 mt-1 text-sm max-w-2xl">
            Platform control-plane users (not tenant ERP logins). Invite with a one-time link
            {smtpConfigured ? ' — emailed when an address is provided.' : ' (SMTP not configured — copy links manually).'}
          </p>
        </div>
        <Link
          to="/docs?tab=operators"
          className="text-xs font-medium text-blue-800 hover:underline shrink-0 sm:mt-2"
        >
          Operators how‑to →
        </Link>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-800 text-sm px-3 py-2">{error}</div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-900 text-sm px-3 py-2">{notice}</div>
      )}

      {linkBanner && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 sm:p-5 space-y-3 max-w-2xl">
          <h2 className="text-sm font-semibold text-ink">{linkBanner.title}</h2>
          <p className="text-xs text-amber-900/80">{linkBanner.note}</p>
          <CopyField label="Full URL" value={linkBanner.url} />
          <CopyField label="Path (if UI is already open)" value={linkBanner.path} />
          {linkBanner.expiresAt && (
            <p className="text-xs text-slate-500">Expires {new Date(linkBanner.expiresAt).toLocaleString()}</p>
          )}
        </div>
      )}

      {setPwUser && (
        <form
          onSubmit={submitSetPassword}
          className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm space-y-3 max-w-xl"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-ink">Set password for {setPwUser.username}</h2>
              <p className="text-xs text-slate-500 mt-1">
                Takes effect immediately. Share the new password yourself (not stored in plain text after save).
              </p>
            </div>
            <button
              type="button"
              className="text-xs text-slate-500 hover:text-slate-800"
              onClick={() => setSetPwUser(null)}
            >
              Cancel
            </button>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1" htmlFor="set-pw">New password</label>
            <input
              id="set-pw"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={setPwForm.password}
              onChange={(e) => setSetPwForm((f) => ({ ...f, password: e.target.value }))}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              disabled={setPwBusy}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1" htmlFor="set-pw2">Confirm</label>
            <input
              id="set-pw2"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={setPwForm.confirm}
              onChange={(e) => setSetPwForm((f) => ({ ...f, confirm: e.target.value }))}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              disabled={setPwBusy}
            />
          </div>
          <button type="submit" disabled={setPwBusy} className="btn btn-primary">
            {setPwBusy ? 'Saving…' : 'Save password'}
          </button>
        </form>
      )}

      <form
        onSubmit={invite}
        className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm space-y-4 max-w-xl"
      >
        <h2 className="text-sm font-semibold text-ink">Invite operator</h2>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1" htmlFor="op-user">Username</label>
          <input
            id="op-user"
            required
            value={form.username}
            onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            placeholder="jane"
            disabled={busy}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1" htmlFor="op-email">Email (for invite mail)</label>
          <input
            id="op-email"
            type="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            placeholder={smtpConfigured ? 'operator@example.com' : 'optional — SMTP not configured'}
            disabled={busy}
          />
        </div>
        <p className="text-xs text-slate-500">Role: platform_admin (full access). More roles later.</p>
        <button type="submit" disabled={busy} className="btn btn-primary">
          {busy ? 'Creating…' : 'Create invite'}
        </button>
      </form>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-ink">All operators</h2>
        </div>
        {users.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">No users yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[520px]">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Username</th>
                  <th className="px-4 py-2 font-medium">Role</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="px-4 py-2">
                      <span className="font-medium text-ink">{u.username}</span>
                      {u.email && <span className="block text-xs text-slate-500">{u.email}</span>}
                    </td>
                    <td className="px-4 py-2 text-xs font-mono text-slate-600">{u.role}</td>
                    <td className="px-4 py-2 text-xs">
                      {!u.active && <span className="text-slate-400">Inactive</span>}
                      {u.active && u.pendingInvite && <span className="text-amber-700">Pending invite</span>}
                      {u.active && !u.pendingInvite && <span className="text-emerald-700">Active</span>}
                    </td>
                    <td className="px-4 py-2 text-right space-x-3 whitespace-nowrap">
                      {u.active && (
                        <>
                          <button
                            type="button"
                            className="text-xs text-blue-800 hover:underline"
                            onClick={() => openSetPassword(u)}
                          >
                            Set password
                          </button>
                          <button
                            type="button"
                            className="text-xs text-blue-800 hover:underline"
                            onClick={() => resetPassword(u)}
                          >
                            Reset link
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="text-xs text-slate-600 hover:underline"
                        onClick={() => toggleActive(u)}
                      >
                        {u.active ? 'Deactivate' : 'Activate'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title}
        message={confirm?.message}
        note={confirm?.note}
        confirmLabel={confirm?.confirmLabel}
        tone={confirm?.tone || 'danger'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const action = confirm?.onConfirm;
          setConfirm(null);
          action?.();
        }}
      />
    </div>
  );
}
