import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, setToken } from '../lib/api.js';

/**
 * Shared set-password screen for invite (/invite/:token) and reset (/reset/:token).
 */
export default function SetPasswordPage({ purpose: purposeProp }) {
  const { token } = useParams();
  const navigate = useNavigate();
  const [meta, setMeta] = useState(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api(`/api/auth/password-token/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Link invalid or expired');
        if (!cancelled) setMeta(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e.message || e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [token]);

  const purpose = purposeProp || meta?.purpose || 'invite';
  const title = purpose === 'reset' ? 'Reset password' : 'Accept invite';
  const blurb = purpose === 'reset'
    ? 'Choose a new password for your platform operator account.'
    : 'Set a password to activate your platform operator account.';

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 10) {
      setError('Password must be at least 10 characters');
      return;
    }
    setBusy(true);
    try {
      const r = await api(`/api/auth/password-token/${encodeURIComponent(token)}`, {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not set password');
      setToken(d.token);
      navigate('/', { replace: true });
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      <div
        className="absolute inset-0 pointer-events-none opacity-40"
        style={{
          background:
            'radial-gradient(800px 400px at 20% 0%, rgba(0,89,207,0.35), transparent 60%), radial-gradient(600px 400px at 90% 80%, rgba(255,255,255,0.06), transparent 50%)',
        }}
      />
      <div className="relative z-10 flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <div className="mb-10 flex justify-center">
            <img src="/sotyn-logo.png" alt="sotyn.ai" className="h-14 sm:h-16 w-auto object-contain" />
          </div>

          <form
            onSubmit={submit}
            className="rounded-2xl border border-white/10 bg-zinc-950/80 p-5 sm:p-7 shadow-2xl shadow-blue-950/40 space-y-4"
          >
            <div>
              <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
              <p className="text-sm text-zinc-400 mt-1">{blurb}</p>
              {meta?.username && (
                <p className="text-sm text-zinc-300 mt-2">
                  Account: <span className="font-mono text-white">{meta.username}</span>
                </p>
              )}
            </div>

            {loading && <p className="text-sm text-zinc-400">Checking link…</p>}

            {error && (
              <p className="text-sm text-red-300 bg-red-950/50 border border-red-900/60 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            {!loading && !error && meta && (
              <>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 space-y-1.5">
                  New password
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={10}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-xl bg-black border border-white/15 px-3 py-2.5 text-sm text-white outline-none focus:border-[#0059cf]"
                  />
                </label>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 space-y-1.5">
                  Confirm password
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={10}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="w-full rounded-xl bg-black border border-white/15 px-3 py-2.5 text-sm text-white outline-none focus:border-[#0059cf]"
                  />
                </label>
                <p className="text-[11px] text-zinc-500">At least 10 characters.</p>
                <button type="submit" disabled={busy} className="btn btn-primary w-full mt-2 py-3 disabled:opacity-60">
                  {busy ? 'Saving…' : purpose === 'reset' ? 'Set new password' : 'Activate account'}
                </button>
              </>
            )}

            {!loading && error && (
              <Link to="/login" className="block text-center text-sm text-[#7eb6ff] hover:underline">
                Back to sign-in
              </Link>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
