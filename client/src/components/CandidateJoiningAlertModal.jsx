import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../api';
import {
  FiAlertCircle, FiCalendar, FiPhone, FiMail, FiUser,
  FiDollarSign, FiClock, FiX, FiCheckCircle, FiChevronRight, FiChevronLeft
} from 'react-icons/fi';
import { FaWhatsapp } from 'react-icons/fa';

// TK-01553: Strictly restricted to these 3 accounts only
const ALLOWED_EMAILS = [
  'info@securedengineers.com',
  'fxbrajwant@gmail.com',
  'hr1executive@gmail.com'
];

export default function CandidateJoiningAlertModal() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [isOpen, setIsOpen] = useState(false);
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  // Normalize user email
  const userEmail = useMemo(() => {
    return (user?.email || '').trim().toLowerCase();
  }, [user]);

  // Strict whitelist check: if user is not in the whitelist, NEVER render or fetch anything
  // On localhost, allow admin logins for testing & review
  const isWhitelisted = useMemo(() => {
  const isLocal = typeof window !== 'undefined' && (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === '::1' ||
    window.location.hostname === ''
  );
  const roleLower = String(user?.role || '').trim().toLowerCase();
  return ALLOWED_EMAILS.includes(userEmail) || (isLocal && (roleLower === 'admin' || userEmail === 'admin@erp.com'));
}, [userEmail, user]);

const todayIST = useMemo(() => {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
}, []);

const storageKey = useMemo(() => {
  return user ? `sepl:candidate-joining-alert-dismissed:${user.id || userEmail}:${todayIST}` : null;
}, [user, userEmail, todayIST]);

const fetchUpcomingJoinings = async (autoOpen = false) => {
  if (!isWhitelisted) return;
  try {
    setLoading(true);
    // Note: axios baseURL is already '/api', so path is '/hr/candidates/upcoming-joinings'
    const res = await api.get('/hr/candidates/upcoming-joinings');
    if (res.data?.allowed && Array.isArray(res.data?.candidates)) {
      setCandidates(res.data.candidates);
      if (autoOpen && res.data.candidates.length > 0) {
        setIsOpen(true);
      }
    }
  } catch (err) {
    console.warn('[CandidateJoiningAlert] fetch error:', err.message);
  } finally {
    setLoading(false);
  }
};

useEffect(() => {
  if (!user || !isWhitelisted) return;

  const isLocal = typeof window !== 'undefined' && (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === '::1' ||
    window.location.hostname === ''
  );

  // In local dev, auto-open unless user dismissed during this session
  // On production, strictly respect daily localStorage dismissal
  const isDismissed = (!isLocal && storageKey)
    ? localStorage.getItem(storageKey) === '1'
    : sessionStorage.getItem('sepl:joining-alert-dismissed-session') === '1';

  fetchUpcomingJoinings(!isDismissed);

  // Allow re-opening manually via custom event
  const handleManualOpen = () => {
    setIsOpen(true);
    fetchUpcomingJoinings(true);
  };

  window.addEventListener('sepl:open-joining-alert', handleManualOpen);
  return () => window.removeEventListener('sepl:open-joining-alert', handleManualOpen);
}, [user, isWhitelisted, storageKey]);

if (!isWhitelisted || !isOpen || candidates.length === 0) {
  return null;
}

const currentCandidate = candidates[activeIndex] || candidates[0];

const handleDismissToday = () => {
  if (storageKey) {
    try {
      localStorage.setItem(storageKey, '1');
    } catch (_) { }
  }
  try {
    sessionStorage.setItem('sepl:joining-alert-dismissed-session', '1');
  } catch (_) { }
  setIsOpen(false);
};

const cleanPhone = (phone) => {
  return String(phone || '').replace(/[^0-9]/g, '').slice(-10);
};

const getUrgencyBadge = (daysLeft) => {
  if (daysLeft < 0) {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-rose-600 text-white shadow-sm animate-pulse">
        <FiAlertCircle className="w-3.5 h-3.5" />
        OVERDUE ({Math.abs(daysLeft)} {Math.abs(daysLeft) === 1 ? 'day' : 'days'} past joining date)
      </span>
    );
  }
  if (daysLeft === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-red-600 text-white shadow-sm animate-pulse">
        <FiAlertCircle className="w-3.5 h-3.5" />
        JOINING TODAY!
      </span>
    );
  }
  if (daysLeft === 1) {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-amber-500 text-white shadow-sm">
        <FiClock className="w-3.5 h-3.5" />
        JOINING TOMORROW!
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-900 border border-amber-300">
      <FiCalendar className="w-3.5 h-3.5 text-amber-600" />
      Joining in {daysLeft} days
    </span>
  );
};

const formatJoiningDate = (dateStr) => {
  if (!dateStr) return 'N/A';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  } catch (_) {
    return dateStr;
  }
};

const phoneDigits = cleanPhone(currentCandidate.phone);
const waText = encodeURIComponent(
  `Hello ${currentCandidate.name}, greetings from Secured Engineers Pvt. Ltd. (SEPL)! We are looking forward to welcoming you on your scheduled joining date (${formatJoiningDate(currentCandidate.joining_date)}) for the role of ${currentCandidate.position}. Please feel free to reach out to HR if you need any assistance.`
);

return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-sm animate-fadeIn">
      <div
        className="relative w-full max-w-xl bg-white rounded-2xl shadow-2xl border border-amber-200 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header Banner */}
        <div className="bg-gradient-to-r from-amber-600 via-amber-700 to-rose-700 text-white px-6 py-4 flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-white/20 backdrop-blur-md flex items-center justify-center text-white shadow-inner">
              <FiCalendar className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-amber-100 font-medium">
                  T-minus 7 Days Notice
                </span>
              </div>
              <h2 className="text-base font-bold text-white mt-0.5">
                Upcoming Candidate Joining
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
            title="Close"
          >
            <FiX className="w-5 h-5" />
          </button>
        </div>

        {/* Carousel indicator if multiple candidates */}
        {candidates.length > 1 && (
          <div className="bg-amber-50/80 px-6 py-2 border-b border-amber-100 flex items-center justify-between text-xs text-amber-900 font-medium">
            <span>
              Candidate <strong>{activeIndex + 1}</strong> of <strong>{candidates.length}</strong> joining within 7 days
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setActiveIndex(prev => (prev > 0 ? prev - 1 : candidates.length - 1))}
                className="p-1 rounded hover:bg-amber-200 text-amber-900 transition-colors"
                title="Previous Candidate"
              >
                <FiChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setActiveIndex(prev => (prev < candidates.length - 1 ? prev + 1 : 0))}
                className="p-1 rounded hover:bg-amber-200 text-amber-900 transition-colors"
                title="Next Candidate"
              >
                <FiChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-6 space-y-5">
          {/* Main Candidate Card */}
          <div className="bg-slate-50 rounded-xl p-4 border border-slate-200">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-200">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-amber-500 text-white font-bold text-lg flex items-center justify-center shadow-sm">
                  {currentCandidate.name?.charAt(0)?.toUpperCase() || 'C'}
                </div>
                <div>
                  <h3 className="text-lg font-bold text-slate-800 leading-tight">
                    {currentCandidate.name}
                  </h3>
                  <p className="text-xs font-semibold text-blue-700 mt-0.5">
                    {currentCandidate.position || 'Offered Position'}
                  </p>
                </div>
              </div>
              <div className="self-start sm:self-center">
                {getUrgencyBadge(currentCandidate.days_left)}
              </div>
            </div>

            {/* Info Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3 text-xs">
              <div className="flex items-center gap-2 text-slate-700 bg-white p-2.5 rounded-lg border border-slate-200">
                <FiCalendar className="w-4 h-4 text-amber-600 shrink-0" />
                <div>
                  <span className="block text-[10px] uppercase font-bold text-slate-400">Date of Joining</span>
                  <span className="font-bold text-slate-800 text-sm">
                    {formatJoiningDate(currentCandidate.joining_date)}
                  </span>
                </div>
              </div>

              {currentCandidate.offered_salary ? (
                <div className="flex items-center gap-2 text-slate-700 bg-white p-2.5 rounded-lg border border-slate-200">
                  <FiDollarSign className="w-4 h-4 text-emerald-600 shrink-0" />
                  <div>
                    <span className="block text-[10px] uppercase font-bold text-slate-400">Offered Salary</span>
                    <span className="font-bold text-emerald-700 text-sm">
                      ₹{Number(currentCandidate.offered_salary).toLocaleString('en-IN')}/mo
                    </span>
                  </div>
                </div>
              ) : null}

              {currentCandidate.reporting_to ? (
                <div className="flex items-center gap-2 text-slate-700 bg-white p-2.5 rounded-lg border border-slate-200">
                  <FiUser className="w-4 h-4 text-blue-600 shrink-0" />
                  <div>
                    <span className="block text-[10px] uppercase font-bold text-slate-400">Reporting Manager</span>
                    <span className="font-semibold text-slate-800">
                      {currentCandidate.reporting_to}
                    </span>
                  </div>
                </div>
              ) : null}

              <div className="flex items-center gap-2 text-slate-700 bg-white p-2.5 rounded-lg border border-slate-200">
                <FiCheckCircle className="w-4 h-4 text-teal-600 shrink-0" />
                <div>
                  <span className="block text-[10px] uppercase font-bold text-slate-400">Offer Status</span>
                  <span className="font-semibold capitalize text-teal-800">
                    {currentCandidate.status || 'Offer Accepted'}
                  </span>
                </div>
              </div>
            </div>

            {/* Contact Details Bar */}
            <div className="mt-3 pt-3 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-3 text-slate-600">
                {currentCandidate.phone && (
                  <a
                    href={`tel:${currentCandidate.phone}`}
                    className="inline-flex items-center gap-1 font-semibold text-slate-700 hover:text-blue-600 transition-colors"
                  >
                    <FiPhone className="w-3.5 h-3.5 text-blue-500" />
                    {currentCandidate.phone}
                  </a>
                )}
                {currentCandidate.email && (
                  <a
                    href={`mailto:${currentCandidate.email}`}
                    className="inline-flex items-center gap-1 font-medium text-slate-600 hover:text-blue-600 transition-colors"
                  >
                    <FiMail className="w-3.5 h-3.5 text-slate-400" />
                    {currentCandidate.email}
                  </a>
                )}
              </div>

              {/* Instant WhatsApp outreach shortcut */}
              {phoneDigits ? (
                <a
                  href={`https://wa.me/91${phoneDigits}?text=${waText}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm transition-colors"
                >
                  <FaWhatsapp className="w-3.5 h-3.5" />
                  Pre-joining WhatsApp Call / Text
                </a>
              ) : null}
            </div>
          </div>

          {/* Action Reminder Checklist Box */}
          <div className="bg-amber-50/70 border border-amber-200/80 rounded-xl p-3 text-xs text-amber-900 space-y-1">
            <p className="font-bold flex items-center gap-1.5 text-amber-950">
              <FiClock className="w-3.5 h-3.5 text-amber-600" />
              Pre-Joining Checklist for Rajwant Kaur / HR Team:
            </p>
            <ul className="list-disc list-inside space-y-0.5 text-amber-900/90 pl-1">
              <li>Call candidate to re-confirm scheduled joining date.</li>
              <li>Notify IT / Admin (Anik Sir) for system, email ID & asset setup.</li>
              <li>Prepare physical welcome & induction documents.</li>
            </ul>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="bg-slate-50 px-6 py-3.5 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-2.5">
          <button
            type="button"
            onClick={() => {
              setIsOpen(false);
              navigate('/hr');
            }}
            className="w-full sm:w-auto px-4 py-2 text-xs font-bold text-blue-700 hover:text-blue-800 hover:bg-blue-50 border border-blue-200 rounded-lg transition-colors flex items-center justify-center gap-1.5"
          >
            Open in HR ATS Module
            <FiChevronRight className="w-3.5 h-3.5" />
          </button>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <button
              type="button"
              onClick={handleDismissToday}
              className="w-full sm:w-auto px-4 py-2 text-xs font-bold text-slate-700 hover:text-slate-900 bg-white hover:bg-slate-100 border border-slate-300 rounded-lg shadow-sm transition-colors"
              title="Do not show again today"
            >
              Acknowledge & Dismiss for Today
            </button>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="w-full sm:w-auto px-4 py-2 text-xs font-bold text-white bg-slate-800 hover:bg-slate-900 rounded-lg shadow-sm transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
    );
}


    // Header notification pill button
    export function CandidateJoiningHeaderButton() {
  const {user} = useAuth();
    const [count, setCount] = useState(0);

  const userEmail = useMemo(() => (user?.email || '').trim().toLowerCase(), [user]);
  const isWhitelisted = useMemo(() => {
    const isLocal = typeof window !== 'undefined' && (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === '::1' ||
    window.location.hostname === ''
    );
    const roleLower = String(user?.role || '').trim().toLowerCase();
    return ALLOWED_EMAILS.includes(userEmail) || (isLocal && (roleLower === 'admin' || userEmail === 'admin@erp.com'));
  }, [userEmail, user]);

  useEffect(() => {
    if (!user || !isWhitelisted) return;
    let cancelled = false;
    api.get('/hr/candidates/upcoming-joinings').then(res => {
      if (!cancelled && res.data?.allowed && Array.isArray(res.data?.candidates)) {
      setCount(res.data.candidates.length);
      }
    }).catch(() => { });
    return () => {cancelled = true; };
  }, [user, isWhitelisted]);

    if (!isWhitelisted || count === 0) return null;

    return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent('sepl:open-joining-alert'))}
      className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold bg-amber-50 text-amber-800 hover:bg-amber-100 rounded-full border border-amber-300 shadow-sm transition-all"
      title="Candidates joining within 7 days (TK-01553)"
    >
      <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
      <span className="hidden sm:inline font-medium">Joining Alert</span>
      <span className="bg-amber-600 text-white text-[10px] font-bold px-1.5 py-0.2 rounded-full">{count}</span>
    </button>
    );
}
