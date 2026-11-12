import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  FiCompass, FiHome, FiArrowLeft, FiSearch, FiFilter,
  FiTrendingDown, FiFileText, FiSend, FiPackage, FiUsers, FiMessageSquare
} from 'react-icons/fi';

const POPULAR_PAGES = [
  { path: '/', label: 'Dashboard', desc: 'Real-time overview and company KPIs', icon: FiHome, color: 'text-blue-600 bg-blue-50' },
  { path: '/sales-funnel', label: 'Sales Funnel', desc: 'Leads, funnel pipeline & conversions', icon: FiFilter, color: 'text-emerald-600 bg-emerald-50' },
  { path: '/cash-flow-tracker', label: 'Cash Flow Tracker', desc: 'Rolling weekly cash inflows & outflows', icon: FiTrendingDown, color: 'text-amber-600 bg-amber-50' },
  { path: '/cheques', label: 'Cheque FMS', desc: 'Cheque issue, clear, hold & bounce workflow', icon: FiFileText, color: 'text-indigo-600 bg-indigo-50' },
  { path: '/collections', label: 'Collection Engine', desc: 'Receivables, aging, follow-ups & SOP-16', icon: FiSend, color: 'text-purple-600 bg-purple-50' },
  { path: '/site-chat', label: 'SOTYN Chat', desc: 'Company-wide group and 1-on-1 chats', icon: FiMessageSquare, color: 'text-sky-600 bg-sky-50' },
  { path: '/procurement', label: 'Procurement', desc: 'Indents, purchase orders, bill & dispatch', icon: FiPackage, color: 'text-rose-600 bg-rose-50' },
  { path: '/attendance', label: 'HRMS Attendance', desc: 'Daily punch, biometric & staff management', icon: FiUsers, color: 'text-teal-600 bg-teal-50' },
];

export default function NotFound({ standalone = false }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  const filtered = POPULAR_PAGES.filter(p =>
    p.label.toLowerCase().includes(query.toLowerCase()) ||
    p.desc.toLowerCase().includes(query.toLowerCase()) ||
    p.path.toLowerCase().includes(query.toLowerCase())
  );

  const content = (
    <div className="max-w-4xl mx-auto py-8 px-4 sm:px-6">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200/80 p-6 sm:p-10 text-center">
        {/* Visual Badge & Icon */}
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-50 to-indigo-100 text-blue-600 mb-6 shadow-xs ring-8 ring-blue-50/50">
          <FiCompass size={40} className="animate-pulse" />
        </div>

        <div className="inline-block px-3 py-1 rounded-full text-xs font-bold tracking-wider uppercase bg-amber-100 text-amber-800 mb-3">
          404 · Page Not Found
        </div>

        <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight mb-2">
          Looking for something in SOTYN?
        </h1>

        <p className="text-sm text-slate-500 max-w-lg mx-auto mb-6">
          The requested route <code className="px-2 py-0.5 rounded bg-slate-100 font-mono text-blue-700 text-xs font-semibold">{location.pathname}</code> does not exist, has been moved, or the link may have a typo.
        </p>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center justify-center gap-3 mb-8">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="btn btn-secondary flex items-center gap-2 px-4 py-2 text-xs font-semibold"
          >
            <FiArrowLeft size={14} /> Go Back
          </button>

          <Link
            to="/"
            className="btn btn-primary flex items-center gap-2 px-5 py-2 text-xs font-semibold shadow-sm hover:shadow"
          >
            <FiHome size={14} /> Back to Dashboard
          </Link>
        </div>

        {/* Quick Search */}
        <div className="max-w-md mx-auto mb-8 relative">
          <FiSearch size={16} className="absolute left-3.5 top-3 text-slate-400 pointer-events-none" />
          <input
            type="text"
            className="input w-full pl-9 pr-4 py-2 text-xs"
            placeholder="Search pages or modules (e.g. Sales, Cash, Cheque, Collections)..."
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>

        {/* Popular Destination Cards Grid */}
        <div className="text-left">
          <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 px-1">
            Common Destinations
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {filtered.map(item => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className="group p-3.5 rounded-xl border border-slate-200/90 hover:border-blue-400 bg-white hover:bg-blue-50/40 transition-all shadow-2xs hover:shadow-sm flex flex-col justify-between"
                >
                  <div className="flex items-center gap-2.5 mb-2">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${item.color} group-hover:scale-105 transition-transform`}>
                      <Icon size={16} />
                    </div>
                    <div className="font-semibold text-xs text-slate-900 group-hover:text-blue-700 transition-colors truncate">
                      {item.label}
                    </div>
                  </div>
                  <div className="text-[11px] text-slate-500 line-clamp-2">
                    {item.desc}
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );

  if (standalone) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-12">
        {content}
      </div>
    );
  }

  return content;
}

