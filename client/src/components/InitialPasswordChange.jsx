import { useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext';

export default function InitialPasswordChange() {
  const { user, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async event => {
    event.preventDefault(); setError('');
    if (password !== confirmation) { setError('New passwords do not match'); return; }
    setSaving(true);
    try { await api.post('/auth/change-password', { current_password: current, new_password: password }); window.location.reload(); }
    catch (err) { setError(err.response?.data?.error || 'Could not change password'); setSaving(false); }
  };
  return <main className="min-h-screen bg-slate-50 flex items-center justify-center p-5"><form onSubmit={save} className="bg-white border border-slate-200 shadow-sm rounded-xl p-7 w-full max-w-md space-y-5">
    <div><h1 className="text-xl font-semibold">Set your own password</h1><p className="text-sm text-slate-600 mt-2">Welcome, {user.name}. Replace your initial password before using the ERP.</p></div>
    <div><label className="label" htmlFor="initial-password">Current password</label><input id="initial-password" className="input" type="password" autoComplete="current-password" required value={current} onChange={e => setCurrent(e.target.value)} /></div>
    <div><label className="label" htmlFor="new-password">New password</label><input id="new-password" className="input" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={e => setPassword(e.target.value)} /><p className="text-xs text-slate-500 mt-1">At least 8 characters; different from the initial password.</p></div>
    <div><label className="label" htmlFor="confirm-password">Confirm new password</label><input id="confirm-password" className="input" type="password" autoComplete="new-password" required minLength={8} value={confirmation} onChange={e => setConfirmation(e.target.value)} /></div>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <button type="submit" className="btn btn-primary w-full" disabled={saving}>{saving ? 'Saving…' : 'Save password and continue'}</button><button type="button" className="btn btn-secondary w-full" onClick={logout} disabled={saving}>Sign out</button>
  </form></main>;
}
