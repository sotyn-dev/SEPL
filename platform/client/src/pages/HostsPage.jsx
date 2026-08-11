import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { api } from '../lib/api.js';

const emptyForm = {
  id: '',
  label: '',
  agentUrl: 'http://127.0.0.1:7200',
  agentToken: '',
};

export default function HostsPage() {
  const [hosts, setHosts] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [healthBusy, setHealthBusy] = useState('');
  const [editId, setEditId] = useState('');
  const [editForm, setEditForm] = useState({ label: '', agentUrl: '', agentToken: '' });
  const [confirm, setConfirm] = useState(null);
  const [healthDetail, setHealthDetail] = useState(null);

  const load = useCallback(() => {
    api('/api/hosts')
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Failed to list hosts');
        setHosts(d.hosts || []);
      })
      .catch((e) => setError(String(e.message || e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const body = {
        id: form.id.trim(),
        label: form.label.trim(),
        agentUrl: form.agentUrl.trim(),
      };
      if (form.agentToken.trim()) body.agentToken = form.agentToken.trim();
      const r = await api('/api/hosts', { method: 'POST', body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Create failed');
      setNotice(d.note || `Host ${d.host.id} registered.`);
      setForm(emptyForm);
      load();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (h) => {
    setEditId(h.id);
    setEditForm({ label: h.label, agentUrl: h.agentUrl, agentToken: '' });
    setError('');
    setNotice('');
  };

  const saveEdit = async (e) => {
    e.preventDefault();
    if (!editId) return;
    setBusy(true);
    setError('');
    try {
      const body = {
        label: editForm.label.trim(),
        agentUrl: editForm.agentUrl.trim(),
      };
      if (editForm.agentToken.trim()) body.agentToken = editForm.agentToken.trim();
      const r = await api(`/api/hosts/${encodeURIComponent(editId)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Update failed');
      setNotice(`Updated ${d.host.id}.`);
      setEditId('');
      load();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  };

  const runDelete = async (id) => {
    setError('');
    try {
      const r = await api(`/api/hosts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Delete failed');
      setNotice(`Removed host ${id}.`);
      load();
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  const askDelete = (h) => {
    setConfirm({
      title: `Remove host ${h.id}?`,
      message: `Unregister ${h.label}. Does not stop the remote agent or delete tenant data.`,
      confirmLabel: 'Remove host',
      tone: 'danger',
      onConfirm: () => runDelete(h.id),
    });
  };

  const checkHealth = async (id) => {
    setHealthBusy(id);
    setError('');
    setHealthDetail(null);
    try {
      const r = await api(`/api/hosts/${encodeURIComponent(id)}/health`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Health check failed');
      setNotice(`${id}: agent reachable${d.health?.docker === false ? ' (Docker degraded)' : ''}.`);
      setHealthDetail(d);
      load();
    } catch (err) {
      setError(String(err.message || err));
      load();
    } finally {
      setHealthBusy('');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-semibold text-ink">Worker hosts</h1>
          <p className="text-slate-600 mt-1 text-sm max-w-2xl">
            Register each VPS agent here. Deploy and provision target a host by id.
            Agent must stay off the public internet (private network / tunnel).
          </p>
        </div>
        <Link
          to="/docs?tab=multivps"
          className="text-xs font-medium text-blue-800 hover:underline shrink-0 sm:mt-2"
        >
          Multi‑VPS how‑to →
        </Link>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-800 text-sm px-3 py-2">{error}</div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-900 text-sm px-3 py-2">{notice}</div>
      )}

      <form
        onSubmit={create}
        className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm space-y-3 max-w-2xl"
      >
        <h2 className="text-sm font-semibold text-ink">Register host</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-semibold text-slate-600 space-y-1 block">
            Host id
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
              value={form.id}
              onChange={(e) => setForm((f) => ({
                ...f,
                id: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''),
              }))}
              placeholder="host_vps2"
              required
            />
          </label>
          <label className="text-xs font-semibold text-slate-600 space-y-1 block">
            Label
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="Hostinger VPS-2"
              required
            />
          </label>
        </div>
        <label className="text-xs font-semibold text-slate-600 space-y-1 block">
          Agent URL
          <input
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
            value={form.agentUrl}
            onChange={(e) => setForm((f) => ({ ...f, agentUrl: e.target.value }))}
            placeholder="http://10.0.0.2:7200"
            required
          />
        </label>
        <label className="text-xs font-semibold text-slate-600 space-y-1 block">
          Agent token (optional — else platform AGENT_TOKEN)
          <input
            type="password"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
            value={form.agentToken}
            onChange={(e) => setForm((f) => ({ ...f, agentToken: e.target.value }))}
            placeholder="paste agent Bearer token"
            autoComplete="new-password"
          />
        </label>
        <button type="submit" disabled={busy} className="btn btn-primary">
          {busy ? 'Saving…' : 'Add host'}
        </button>
      </form>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-ink">Registered hosts</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-semibold">Host</th>
                <th className="px-4 py-2 font-semibold">Agent URL</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {hosts.map((h) => (
                <tr key={h.id}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-ink">{h.label}</p>
                    <p className="font-mono text-[11px] text-slate-500">{h.id}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      {h.hasToken ? 'Token set' : 'Uses env AGENT_TOKEN'}
                    </p>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600 break-all max-w-[14rem]">
                    {h.agentUrl}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <span className="inline-flex px-2 py-0.5 rounded-full bg-slate-50 border border-slate-200 text-slate-700">
                      {h.status || 'unknown'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right space-x-3 whitespace-nowrap">
                    <button
                      type="button"
                      className="text-xs text-blue-800 hover:underline"
                      disabled={!!healthBusy}
                      onClick={() => checkHealth(h.id)}
                    >
                      {healthBusy === h.id ? 'Checking…' : 'Health'}
                    </button>
                    <button
                      type="button"
                      className="text-xs text-blue-800 hover:underline"
                      onClick={() => startEdit(h)}
                    >
                      Edit
                    </button>
                    {h.id !== 'host_local' && (
                      <button
                        type="button"
                        className="text-xs text-red-700 hover:underline"
                        onClick={() => askDelete(h)}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!hosts.length && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-slate-500 text-sm">
                    No hosts — restart platform so host_local can seed.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editId && (
        <form
          onSubmit={saveEdit}
          className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm space-y-3 max-w-2xl"
        >
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">Edit {editId}</h2>
            <button type="button" className="text-xs text-slate-500" onClick={() => setEditId('')}>
              Cancel
            </button>
          </div>
          <label className="text-xs font-semibold text-slate-600 space-y-1 block">
            Label
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={editForm.label}
              onChange={(e) => setEditForm((f) => ({ ...f, label: e.target.value }))}
              required
            />
          </label>
          <label className="text-xs font-semibold text-slate-600 space-y-1 block">
            Agent URL
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
              value={editForm.agentUrl}
              onChange={(e) => setEditForm((f) => ({ ...f, agentUrl: e.target.value }))}
              required
            />
          </label>
          <label className="text-xs font-semibold text-slate-600 space-y-1 block">
            New agent token (leave blank to keep)
            <input
              type="password"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
              value={editForm.agentToken}
              onChange={(e) => setEditForm((f) => ({ ...f, agentToken: e.target.value }))}
              autoComplete="new-password"
            />
          </label>
          <button type="submit" disabled={busy} className="btn btn-primary">
            Save
          </button>
        </form>
      )}

      {healthDetail && (
        <pre className="text-[11px] bg-slate-50 border border-slate-200 rounded-lg p-3 overflow-x-auto max-w-3xl">
          {JSON.stringify(healthDetail, null, 2)}
        </pre>
      )}

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title}
        message={confirm?.message}
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
