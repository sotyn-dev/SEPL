import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import { FiUser, FiLock, FiEye, FiEyeOff } from 'react-icons/fi';

// SEPL brand logo — embedded as a base64 data URL so it works without any
// build config changes and survives all deploys. Keep this file in sync if
// the logo ever changes.
const SEPL_LOGO = 'data:image/png;base64,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';

export default function Login() {
  // Prefill the username if "Remember me" was ticked on a previous login.
  const savedIdentifier = typeof window !== 'undefined' ? (localStorage.getItem('sepl_remember_identifier') || '') : '';
  const [form, setForm] = useState({ identifier: savedIdentifier, password: '' });
  const [remember, setRemember] = useState(!!savedIdentifier);
  const [showPassword, setShowPassword] = useState(false);
  const { login } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const data = await login(form.identifier, form.password);
      if (remember) {
        localStorage.setItem('sepl_remember_identifier', form.identifier);
      } else {
        localStorage.removeItem('sepl_remember_identifier');
      }
      toast.success(`Welcome back, ${data.user.name}!`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Something went wrong');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-red-900 via-red-800 to-red-950 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-0 left-0 w-96 h-96 bg-red-500/15 rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2" />
      <div className="absolute bottom-0 right-0 w-96 h-96 bg-white/10 rounded-full blur-3xl translate-x-1/2 translate-y-1/2" />

      <div className="bg-white/95 backdrop-blur-sm rounded-3xl shadow-2xl p-8 w-full max-w-md mx-4 relative z-10">
        {/* Logo — now the actual SEPL brand logo (not a generic shield icon) */}
        <div className="text-center mb-8">
          <div className="w-20 h-20 mx-auto mb-4 rounded-2xl overflow-hidden shadow-lg shadow-red-500/30 bg-white flex items-center justify-center">
            <img src={SEPL_LOGO} alt="SEPL logo" className="w-full h-full object-contain" />
          </div>
          <h1 className="text-2xl font-extrabold text-gray-800 tracking-tight">SEPL ERP</h1>
          <p className="text-gray-400 text-sm mt-1">Secured Engineers Pvt Ltd</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="label">Username or Email</label>
            <div className="relative">
              <FiUser className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
              <input className="input pl-10" type="text" autoComplete="username" value={form.identifier} onChange={e => setForm({...form, identifier: e.target.value})} required placeholder="Enter your username or email id" />
            </div>
          </div>
          <div>
            <label className="label">Password</label>
            <div className="relative">
              <FiLock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
              <input
                className="input pl-10 pr-10"
                type={showPassword ? 'text' : 'password'}
                value={form.password}
                onChange={e => setForm({ ...form, password: e.target.value })}
                required
                placeholder="Enter your password"
              />
              {/* Show / hide toggle — click to reveal the password briefly,
                  useful when mam dictates a password to an employee over
                  phone and wants to verify what she typed. */}
              <button
                type="button"
                onClick={() => setShowPassword(s => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-red-600 p-1"
                title={showPassword ? 'Hide password' : 'Show password'}
                tabIndex={-1}
              >
                {showPassword ? <FiEyeOff size={16} /> : <FiEye size={16} />}
              </button>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
            <input
              type="checkbox"
              className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
              checked={remember}
              onChange={e => setRemember(e.target.checked)}
            />
            <span>Remember me</span>
            <span className="ml-auto text-[10px] text-gray-400">Saves your username on this device</span>
          </label>

          <button type="submit" className="btn btn-primary w-full py-3.5 text-base rounded-xl">Sign In</button>
        </form>

        <p className="mt-6 text-center text-[11px] text-gray-400">Contact your admin for login credentials</p>
      </div>

      {/* Elegant footer: creator + company, centered at bottom */}
      <div className="fixed bottom-5 left-0 right-0 flex justify-center px-4 z-10 pointer-events-none">
        <div className="pointer-events-auto text-center select-none">
          <p className="text-[11px] uppercase tracking-[0.35em] text-white/40 mb-1.5">
            Crafted with <span className="text-pink-400">&hearts;</span> by
          </p>
          <p className="text-base font-bold bg-gradient-to-r from-red-200 via-white to-red-200 bg-clip-text text-transparent drop-shadow-sm">
            Secured Engineers Pvt Ltd
          </p>
          <div className="mt-2 flex items-center justify-center gap-2">
            <span className="h-px w-8 bg-gradient-to-r from-transparent via-white/30 to-transparent" />
            <p className="text-[10px] font-semibold tracking-widest text-white/60 uppercase">
              Monika Devi
            </p>
            <span className="h-px w-8 bg-gradient-to-r from-transparent via-white/30 to-transparent" />
          </div>
          <p className="text-[9px] text-white/30 mt-1">&copy; {new Date().getFullYear()} &middot; All rights reserved</p>
        </div>
      </div>
    </div>
  );
}
