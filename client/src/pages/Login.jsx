import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import { FiUser, FiLock, FiEye, FiEyeOff, FiArrowRight } from 'react-icons/fi';

// SEPL brand logo. The real artwork lives at client/public/sepl-logo.webp
// and is served at /sepl-logo.webp in production. If the file is missing
// for any reason, we fall back to the inline SVG shield via the onError
// handler so the page never shows a broken image.
const SEPL_LOGO_PATH = '/sepl-logo.webp';
const SEPL_LOGO_FALLBACK = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#ef4444"/>
        <stop offset="100%" stop-color="#7f1d1d"/>
      </linearGradient>
    </defs>
    <path d="M50 8 L85 20 v26 c0 20-14 34-35 42 C29 80 15 66 15 46 V20 L50 8 z"
          fill="url(#g)" stroke="#7f1d1d" stroke-width="1.5"/>
    <text x="50" y="56" text-anchor="middle" font-family="Arial, Helvetica, sans-serif"
          font-weight="bold" font-size="22" fill="white" letter-spacing="1">SEPL</text>
  </svg>`
);

export default function Login() {
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
    <div className="min-h-screen bg-gradient-to-br from-rose-50 via-white to-red-100 flex flex-col">
      {/* Subtle ambient red blooms over the white-pink background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] bg-red-300/40 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-[600px] h-[600px] bg-rose-300/30 rounded-full blur-3xl" />
      </div>

      <div className="flex-1 flex items-center justify-center px-4 py-6 relative z-10">
        <div className="grid lg:grid-cols-2 gap-0 w-full max-w-6xl rounded-3xl overflow-hidden shadow-2xl shadow-red-200/60 ring-1 ring-red-100">

          {/* ─── LEFT — Sign-in form (white card) ─────────────────── */}
          <div className="bg-white p-10 sm:p-14 flex flex-col justify-center">
            {/* Logo + brand */}
            <div className="flex items-center gap-3 mb-12">
              <div className="w-14 h-14 rounded-xl overflow-hidden shadow-md shadow-red-200 ring-1 ring-red-100 flex items-center justify-center bg-white">
                <img src={SEPL_LOGO_PATH}
                onError={(e) => { if (e.target.src !== SEPL_LOGO_FALLBACK) e.target.src = SEPL_LOGO_FALLBACK; }} alt="SEPL" className="w-full h-full object-contain p-1" />
              </div>
              <div>
                <p className="text-red-700 font-extrabold text-lg leading-tight tracking-tight">SEPL ERP</p>
                <p className="text-[11px] text-gray-500 tracking-wide">Secured Engineers Pvt Ltd</p>
              </div>
            </div>

            {/* Heading */}
            <h1 className="text-3xl sm:text-4xl font-extrabold text-gray-900 tracking-tight">
              Welcome back <span className="inline-block animate-wave">👋</span>
            </h1>
            <p className="text-gray-500 text-sm mt-2 mb-8">Sign in to SEPL ERP</p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="text-[11px] uppercase tracking-wider font-bold text-gray-500 block mb-1.5">Email / Username</label>
                <div className="relative">
                  <FiUser className="absolute left-3.5 top-1/2 -translate-y-1/2 text-red-400" size={16} />
                  <input
                    className="w-full bg-rose-50/60 border border-red-100 focus:border-red-500 focus:ring-2 focus:ring-red-200 text-gray-900 placeholder-gray-400 rounded-xl pl-10 pr-4 py-3 outline-none transition-colors"
                    type="text"
                    autoComplete="username"
                    value={form.identifier}
                    onChange={e => setForm({ ...form, identifier: e.target.value })}
                    required
                    placeholder="name@securedengineers.com"
                  />
                </div>
              </div>

              <div>
                <label className="text-[11px] uppercase tracking-wider font-bold text-gray-500 block mb-1.5">Password</label>
                <div className="relative">
                  <FiLock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-red-400" size={16} />
                  <input
                    className="w-full bg-rose-50/60 border border-red-100 focus:border-red-500 focus:ring-2 focus:ring-red-200 text-gray-900 placeholder-gray-400 rounded-xl pl-10 pr-10 py-3 outline-none transition-colors"
                    type={showPassword ? 'text' : 'password'}
                    value={form.password}
                    onChange={e => setForm({ ...form, password: e.target.value })}
                    required
                    placeholder="••••••••"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(s => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-red-400 hover:text-red-600 p-1"
                    title={showPassword ? 'Hide password' : 'Show password'}
                    tabIndex={-1}
                  >
                    {showPassword ? <FiEyeOff size={16} /> : <FiEye size={16} />}
                  </button>
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none pt-1">
                <input
                  type="checkbox"
                  className="w-4 h-4 rounded border-red-300 text-red-600 focus:ring-red-500"
                  checked={remember}
                  onChange={e => setRemember(e.target.checked)}
                />
                <span>Remember me</span>
                <span className="ml-auto text-[10px] text-gray-400">Saves username on this device</span>
              </label>

              <button
                type="submit"
                className="w-full mt-2 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-500 hover:to-red-600 active:from-red-700 active:to-red-800 text-white font-semibold py-3.5 px-4 rounded-xl shadow-lg shadow-red-300 transition-all flex items-center justify-center gap-2 group"
              >
                Sign in
                <FiArrowRight className="group-hover:translate-x-0.5 transition-transform" size={16} />
              </button>
            </form>

            <p className="mt-6 text-center text-[11px] text-gray-400">
              Contact your admin for login credentials
            </p>
          </div>

          {/* ─── RIGHT — Animated brand panel (red gradient) ──────── */}
          <div className="hidden lg:flex relative bg-gradient-to-br from-red-500 via-red-600 to-rose-700 items-center justify-center p-12 overflow-hidden">
            {/* Concentric white rings — pure CSS pulse animation */}
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="absolute w-[200px] h-[200px] rounded-full border border-white/40 animate-ping-slow" />
              <div className="absolute w-[320px] h-[320px] rounded-full border border-white/30 animate-ping-slow" style={{ animationDelay: '1s' }} />
              <div className="absolute w-[440px] h-[440px] rounded-full border border-white/25 animate-ping-slow" style={{ animationDelay: '2s' }} />
              <div className="absolute w-[560px] h-[560px] rounded-full border border-white/20" />
              <div className="absolute w-[680px] h-[680px] rounded-full border border-white/15" />
              <div className="absolute w-[800px] h-[800px] rounded-full border border-white/10" />
            </div>

            {/* Centered logo + tagline over the rings */}
            <div className="relative z-10 text-center">
              <div className="w-36 h-36 mx-auto mb-6 rounded-2xl overflow-hidden shadow-2xl shadow-red-900/40 ring-2 ring-white/40 flex items-center justify-center bg-white/95 backdrop-blur-sm p-3">
                <img src={SEPL_LOGO_PATH}
                onError={(e) => { if (e.target.src !== SEPL_LOGO_FALLBACK) e.target.src = SEPL_LOGO_FALLBACK; }} alt="SEPL" className="w-full h-full object-contain" />
              </div>
              <h2 className="text-4xl font-extrabold text-white mb-3 tracking-tight drop-shadow-md">
                Build secure. <br />
                <span className="bg-gradient-to-r from-white via-rose-100 to-white bg-clip-text text-transparent">
                  Track smart.
                </span>
              </h2>
              <p className="text-white/90 text-sm max-w-xs mx-auto">
                Every site, every order, every rupee — visible end-to-end.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="relative z-10 py-5 px-4 text-center select-none">
        <p className="text-[10px] uppercase tracking-[0.35em] text-red-700/60 mb-1">
          Crafted with <span className="text-red-500">&hearts;</span> by
        </p>
        <p className="text-sm font-bold bg-gradient-to-r from-red-700 via-red-600 to-red-700 bg-clip-text text-transparent">
          Secured Engineers Pvt Ltd
        </p>
        <div className="mt-1 flex items-center justify-center gap-2">
          <span className="h-px w-8 bg-gradient-to-r from-transparent via-red-300 to-transparent" />
          <p className="text-[10px] font-semibold tracking-widest text-red-700/70 uppercase">Monika Devi</p>
          <span className="h-px w-8 bg-gradient-to-r from-transparent via-red-300 to-transparent" />
        </div>
        <p className="text-[9px] text-red-700/40 mt-0.5">&copy; {new Date().getFullYear()} · All rights reserved</p>
      </footer>

      {/* Custom CSS keyframes — wave hand + slow ping rings.
          Tailwind doesn't ship a slow-ping by default. */}
      <style>{`
        @keyframes wave {
          0%, 60%, 100% { transform: rotate(0deg); }
          10% { transform: rotate(14deg); }
          20% { transform: rotate(-8deg); }
          30% { transform: rotate(14deg); }
          40% { transform: rotate(-4deg); }
          50% { transform: rotate(10deg); }
        }
        .animate-wave {
          animation: wave 2.5s ease-in-out infinite;
          transform-origin: 70% 70%;
          display: inline-block;
        }
        @keyframes ping-slow {
          0% { transform: scale(0.95); opacity: 0.6; }
          80% { transform: scale(1.15); opacity: 0; }
          100% { transform: scale(1.15); opacity: 0; }
        }
        .animate-ping-slow {
          animation: ping-slow 4s cubic-bezier(0, 0, 0.2, 1) infinite;
        }
      `}</style>
    </div>
  );
}
