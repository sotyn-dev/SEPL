import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../api';
import {
  FiAlertCircle, FiCalendar, FiPhone, FiMail, FiUser,
  FiDollarSign, FiClock, FiX, FiCheckCircle, FiChevronRight, FiChevronLeft,
  FiUserCheck
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
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-rose-600 text-white shadow-xs animate-pulse">
          <FiAlertCircle className="w-3 h-3" />
          OVERDUE ({Math.abs(daysLeft)} {Math.abs(daysLeft) === 1 ? 'day' : 'days'} past)
        </span>
      );
    }
    if (daysLeft === 0) {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-red-600 text-white shadow-xs animate-pulse">
          <FiAlertCircle className="w-3 h-3" />
          JOINING TODAY!
        </span>
      );
    }
    if (daysLeft === 1) {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-500 text-white shadow-xs">
          <FiClock className="w-3 h-3" />
          JOINING TOMORROW!
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-900 border border-amber-300">
        <FiCalendar className="w-3 h-3 text-amber-600" />
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

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-2 sm:p-4 bg-slate-900/75 backdrop-blur-xs animate-fadeIn"
      onClick={() => setIsOpen(false)}
    >
      <div
        className="relative w-full max-w-xl max-h-[94vh] sm:max-h-[90vh] bg-white rounded-2xl shadow-2xl border border-amber-200 overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header Banner - Fixed at top */}
        <div className="bg-gradient-to-r from-amber-600 via-amber-700 to-rose-700 text-white px-4 sm:px-6 py-3 sm:py-3.5 flex items-center justify-between shadow-sm flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-white/20 backdrop-blur-md flex items-center justify-center text-white shadow-inner flex-shrink-0">
              <FiCalendar className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-amber-100 font-medium uppercase tracking-wider">
                  T-minus 7 Days Notice
                </span>
              </div>
              <h2 className="text-sm sm:text-base font-bold text-white leading-tight">
                Upcoming Candidate Joining
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors flex-shrink-0 ml-2"
            title="Close modal"
            aria-label="Close"
          >
            <FiX className="w-5 h-5" />
          </button>
        </div>

        {/* Carousel indicator if multiple candidates - Fixed */}
        {candidates.length > 1 && (
          <div className="bg-amber-50/90 px-4 sm:px-6 py-2 border-b border-amber-100 flex items-center justify-between text-xs text-amber-900 font-medium flex-shrink-0">
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

        {/* Modal Body - Scrollable */}
        <div className="flex-1 overflow-y-auto p-3.5 sm:p-5 space-y-3.5 overscroll-contain">
          {/* Main Candidate Card */}
          <div className="bg-slate-50 rounded-xl p-3 sm:p-4 border border-slate-200">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-200">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-amber-500 text-white font-bold text-base sm:text-lg flex items-center justify-center shadow-xs flex-shrink-0">
                  {currentCandidate.name?.charAt(0)?.toUpperCase() || 'C'}
                </div>
                <div>
                  <h3 className="text-base sm:text-lg font-bold text-slate-800 leading-tight">
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-2.5 mt-3 text-xs">
              <div className="flex items-center gap-2 text-slate-700 bg-white p-2 rounded-lg border border-slate-200">
                <FiCalendar className="w-4 h-4 text-amber-600 shrink-0" />
                <div>
                  <span className="block text-[9px] uppercase font-bold text-slate-400">Date of Joining</span>
                  <span className="font-bold text-slate-800 text-xs sm:text-sm">
                    {formatJoiningDate(currentCandidate.joining_date)}
                  </span>
                </div>
              </div>

              {currentCandidate.offered_salary ? (
                <div className="flex items-center gap-2 text-slate-700 bg-white p-2 rounded-lg border border-slate-200">
                  <FiDollarSign className="w-4 h-4 text-emerald-600 shrink-0" />
                  <div>
                    <span className="block text-[9px] uppercase font-bold text-slate-400">Offered Salary</span>
                    <span className="font-bold text-emerald-700 text-xs sm:text-sm">
                      ₹{Number(currentCandidate.offered_salary).toLocaleString('en-IN')}/mo
                    </span>
                  </div>
                </div>
              ) : null}

              {currentCandidate.reporting_to ? (
                <div className="flex items-center gap-2 text-slate-700 bg-white p-2 rounded-lg border border-slate-200">
                  <FiUser className="w-4 h-4 text-blue-600 shrink-0" />
                  <div>
                    <span className="block text-[9px] uppercase font-bold text-slate-400">Reporting Manager</span>
                    <span className="font-semibold text-slate-800">
                      {currentCandidate.reporting_to}
                    </span>
                  </div>
                </div>
              ) : null}

              <div className="flex items-center gap-2 text-slate-700 bg-white p-2 rounded-lg border border-slate-200">
                <FiCheckCircle className="w-4 h-4 text-teal-600 shrink-0" />
                <div>
                  <span className="block text-[9px] uppercase font-bold text-slate-400">Offer Status</span>
                  <span className="font-semibold capitalize text-teal-800">
                    {currentCandidate.status || 'Offer Accepted'}
                  </span>
                </div>
              </div>
            </div>

            {/* Contact Details Bar */}
            <div className="mt-3 pt-3 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
              <div className="flex flex-wrap items-center gap-2 sm:gap-3 text-slate-600">
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
                    className="inline-flex items-center gap-1 font-medium text-slate-600 hover:text-blue-600 transition-colors truncate max-w-[200px]"
                    title={currentCandidate.email}
                  >
                    <FiMail className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span className="truncate">{currentCandidate.email}</span>
                  </a>
                )}
              </div>

              {/* Instant WhatsApp outreach shortcut */}
              {phoneDigits ? (
                <a
                  href={`https://wa.me/91${phoneDigits}?text=${waText}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white shadow-2xs transition-colors w-full sm:w-auto"
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
              <FiClock className="w-3.5 h-3.5 text-amber-600 shrink-0" />
              Pre-Joining Checklist for Rajwant Kaur / HR Team:
            </p>
            <ul className="list-disc list-inside space-y-0.5 text-amber-900/90 pl-1 text-[11px]">
              <li>Call candidate to re-confirm scheduled joining date.</li>
              <li>Notify IT / Admin (Anik Sir) for system, email ID & asset setup.</li>
              <li>Prepare physical welcome & induction documents.</li>
            </ul>
          </div>
        </div>

        {/* Modal Footer - Fixed at bottom */}
        <div className="bg-slate-50 px-4 sm:px-6 py-2.5 sm:py-3 border-t border-slate-200 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => {
              setIsOpen(false);
              navigate('/hr');
            }}
            className="w-full sm:w-auto px-3 py-1.5 sm:py-2 text-xs font-bold text-blue-700 hover:text-blue-800 hover:bg-blue-50 border border-blue-200 rounded-lg transition-colors flex items-center justify-center gap-1.5"
          >
            Open in HR ATS Module
            <FiChevronRight className="w-3.5 h-3.5" />
          </button>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-1.5 sm:gap-2 w-full sm:w-auto">
            <button
              type="button"
              onClick={handleDismissToday}
              className="w-full sm:w-auto px-3 py-1.5 sm:py-2 text-xs font-bold text-slate-700 hover:text-slate-900 bg-white hover:bg-slate-100 border border-slate-300 rounded-lg shadow-2xs transition-colors"
              title="Do not show again today"
            >
              Acknowledge & Dismiss for Today
            </button>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="w-full sm:w-auto px-4 py-1.5 sm:py-2 text-xs font-bold text-white bg-slate-800 hover:bg-slate-900 rounded-lg shadow-2xs transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined'
    ? createPortal(modal, document.body)
    : modal;
}

// Header notification pill button
export function CandidateJoiningHeaderButton() {
  const { user } = useAuth();
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
    return () => { cancelled = true; };
  }, [user, isWhitelisted]);

  if (!isWhitelisted || count === 0) return null;

  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent('sepl:open-joining-alert'))}
      className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-1 text-xs font-semibold bg-amber-50 text-amber-800 hover:bg-amber-100 rounded-full border border-amber-300 shadow-2xs transition-all whitespace-nowrap flex-shrink-0"
      title="Candidates joining within 7 days (TK-01553)"
    >
      <FiUserCheck className="text-amber-700 w-3.5 h-3.5 flex-shrink-0" />
      <span className="hidden md:inline font-medium">Joining Alert</span>
      <span className="bg-amber-600 text-white text-[10px] font-bold px-1.5 py-0.2 rounded-full shadow-xs">{count}</span>
    </button>
  );
}
