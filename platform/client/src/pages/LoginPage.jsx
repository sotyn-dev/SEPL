import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, getToken, setToken } from '../lib/api.js';

export default function LoginPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (getToken()) {
    return <Navigate to="/" replace />;
  }

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Sign-in failed');
        return;
      }
      setToken(data.token);
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
            <img
              src="/sotyn-logo.png"
              alt="sotyn.ai"
              className="h-14 sm:h-16 w-auto object-contain"
            />
          </div>

          <form
            onSubmit={submit}
            className="rounded-2xl border border-white/10 bg-zinc-950/80 p-5 sm:p-7 shadow-2xl shadow-blue-950/40 space-y-4"
          >
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Platform sign-in</h1>
              <p className="text-sm text-zinc-400 mt-1">Operator access only — no public register.</p>
            </div>

            {error && (
              <p className="text-sm text-red-300 bg-red-950/50 border border-red-900/60 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 space-y-1.5">
              Username
              <input
                className="w-full rounded-xl bg-black border border-white/15 px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-[#0059cf]"
                autoComplete="username"
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                required
              />
            </label>

            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 space-y-1.5">
              Password
              <input
                type="password"
                className="w-full rounded-xl bg-black border border-white/15 px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-[#0059cf]"
                autoComplete="current-password"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                required
              />
            </label>

            <button
              type="submit"
              disabled={busy}
              className="btn btn-primary w-full mt-2 py-3 disabled:opacity-60"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="text-center text-[11px] text-zinc-500 mt-6">
            Control plane · not a tenant ERP login.
            Invites and password resets use a one-time link from an existing admin.
          </p>
        </div>
      </div>
    </div>
  );
}
