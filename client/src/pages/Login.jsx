import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import { FiUser, FiLock, FiEye, FiEyeOff } from 'react-icons/fi';

// SEPL brand logo — inline SVG, no network dependency. Renders the SEPL
// shield with "SEPL" letters in white on the brand red. Works offline, no
// third-party hosting, no hotlinking issues. To swap in the real PNG logo
// later, save it to client/src/assets/sepl-logo.png and import it instead.
const SEPL_LOGO = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#dc2626"/>
        <stop offset="100%" stop-color="#991b1b"/>
      </linearGradient>
    </defs>
    <path d="M50 8 L85 20 v26 c0 20-14 34-35 42 C29 80 15 66 15 46 V20 L50 8 z"
          fill="url(#g)" stroke="#7f1d1d" stroke-width="1.5"/>
    <text x="50" y="56" text-anchor="middle" font-family="Arial, Helvetica, sans-serif"
          font-weight="bold" font-size="22" fill="white" letter-spacing="1">SEPL</text>
  </svg>`
);

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
          <div className="w-20 h-20 mx-auto mb-4 rounded-2xl overflow-hidden shadow-lg shadow-red-500/30 flex items-center justify-center">
            <img
              src={SEPL_LOGO}
              alt="SEPL logo"
              className="w-full h-full object-contain"
            />
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
