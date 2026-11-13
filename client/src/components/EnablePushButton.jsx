// Small header button that lets users turn on / off push notifications
// for the current device, and provides Admins a direct entrance to the
// Employee Push & Notification Control Desk.

import { useState, useEffect } from 'react';
import {
  FiBell,
  FiBellOff,
  FiShield,
  FiLock,
  FiSend,
  FiX,
  FiSmartphone,
  FiChevronRight,
  FiHelpCircle
} from 'react-icons/fi';
import toast from 'react-hot-toast';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import { pushSupported, enablePushNotifications, disablePushNotifications, getPermissionState } from '../lib/push';
import AdminNotificationControlModal from './AdminNotificationControlModal';

export default function EnablePushButton() {
  const { user } = useAuth();
  const [state, setState] = useState('loading'); // loading | unsupported | denied | off | on
  const [open, setOpen] = useState(false);
  const [strictlyEnforced, setStrictlyEnforced] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [testing, setTesting] = useState(false);

  const refresh = async () => {
    if (!pushSupported()) { setState('unsupported'); return; }
    const perm = await getPermissionState();
    if (perm === 'denied') { setState('denied'); return; }

    // Check enforcement policy
    try {
      const pRes = await api.get('/notifications/preferences');
      setStrictlyEnforced(Boolean(pRes.data?._is_strictly_enforced));
    } catch (_) {}

    // Check if a subscription exists for this device
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      const saved = sub && perm === 'granted' ? await enablePushNotifications() : null;
      setState(saved?.ok ? 'on' : 'off');
    } catch {
      setState('off');
    }
  };

  useEffect(() => { refresh(); }, []);

  const turnOn = async () => {
    const r = await enablePushNotifications();
    if (r.ok) {
      toast.success('SOTYN chat and call notifications enabled on this device');
      refresh();
    } else if (r.reason === 'permission_denied') {
      toast.error('You blocked notifications. Open browser settings → Site Settings → Notifications → Allow.', { duration: 6000 });
      setState('denied');
    } else {
      toast.error(`Failed: ${r.reason}${r.error ? ` (${r.error})` : ''}`, { duration: 6000 });
    }
  };

  const turnOff = async () => {
    if (strictlyEnforced) {
      toast.error('Push notifications are strictly mandatory for your role and cannot be turned off.');
      return;
    }
    await disablePushNotifications();
    toast.success('Push disabled on this device');
    refresh();
  };

  const test = async () => {
    setTesting(true);
    try {
      const r = await api.post('/push/test', { message: 'Test from SOTYN.AI — your devices are connected ✓' });
      if (r.data.sent) toast.success(`Accepted by push service — ${r.data.sent} of ${r.data.total} devices. Check your phone.`);
      else toast.error('No connected device accepted the test. Enable notifications again and check phone settings.');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    } finally {
      setTesting(false);
    }
  };

  if (state === 'loading') return null;

  const isAdmin = user?.role === 'admin';

  return (
    <div className="sm:relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={`p-2 rounded-xl transition flex-shrink-0 relative ${
          state === 'on'
            ? 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100 ring-1 ring-emerald-200'
            : 'text-gray-500 hover:bg-gray-100'
        }`}
        title={state === 'on' ? 'Push ON for this device' : 'Push OFF — click to enable'}
        aria-label={state === 'on' ? 'Push notifications on — manage' : 'Push notifications off — enable'}
      >
        {state === 'on' ? <FiBell size={18} /> : <FiBellOff size={18} />}
        {state === 'on' && (
          <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-white animate-pulse" />
        )}
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/30 sm:bg-transparent"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            className="fixed inset-x-3 top-14 sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 w-auto sm:w-[380px] max-w-[calc(100vw-1.5rem)] max-h-[calc(100vh-4.5rem)] flex flex-col bg-white border border-gray-200/90 rounded-2xl shadow-2xl z-50 overflow-hidden text-xs animate-fade-in"
          >
            {/* Header */}
            <div className="px-4 py-3 bg-gradient-to-r from-slate-900 via-indigo-950 to-blue-900 text-white flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2">
                <div className="p-1.5 bg-blue-500/20 rounded-lg text-blue-300">
                  <FiBell size={15} />
                </div>
                <div>
                  <h4 className="font-bold text-sm leading-tight text-white">Notifications & Alerts</h4>
                  <p className="text-[10px] text-blue-200/80">Device connectivity & management</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="p-1 text-white/70 hover:text-white rounded-lg hover:bg-white/10 transition"
                aria-label="Close"
              >
                <FiX size={16} />
              </button>
            </div>

            <div className="p-3.5 space-y-3 flex-1 overflow-y-auto overscroll-contain">
              {/* Mandatory Policy Banner */}
              {strictlyEnforced && (
                <div className="p-2.5 bg-indigo-50 border border-indigo-200 rounded-xl text-indigo-950 text-[11px] flex items-start gap-2">
                  <FiLock className="text-indigo-600 mt-0.5 flex-shrink-0" size={13} />
                  <div>
                    <span className="font-bold">Mandatory Policy Active:</span> Alerts are required for your account by company administration.
                  </div>
                </div>
              )}

              {/* Current Device Status Card */}
              <div className="p-3 bg-slate-50 border border-gray-200 rounded-xl space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-gray-800 flex items-center gap-1.5 text-xs">
                    <FiSmartphone className="text-gray-500" size={14} /> This Device
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 ${
                      state === 'on'
                        ? 'bg-emerald-100 text-emerald-800'
                        : state === 'denied'
                        ? 'bg-rose-100 text-rose-800'
                        : 'bg-amber-100 text-amber-800'
                    }`}
                  >
                    {state === 'on' && <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />}
                    {state === 'on' ? 'Push Active' : state === 'denied' ? 'Blocked' : 'Disabled'}
                  </span>
                </div>

                {state === 'unsupported' && (
                  <p className="text-[11px] text-amber-700 leading-relaxed">
                    Browser push is not supported in this mode. On iPhone, use Safari → Share → Add to Home Screen.
                  </p>
                )}

                {state === 'denied' && (
                  <div className="space-y-1.5">
                    <p className="text-[11px] text-rose-700 leading-relaxed">
                      Notifications were blocked. Please enable them in browser site permissions and refresh.
                    </p>
                  </div>
                )}

                {state === 'off' && (
                  <div className="space-y-2">
                    <p className="text-[11px] text-gray-600 leading-relaxed">
                      Receive SOTYN chat messages, task assignments, and call alerts even when closed.
                    </p>
                    <button
                      onClick={turnOn}
                      className="w-full py-2 px-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg text-xs transition shadow-xs flex items-center justify-center gap-1.5"
                    >
                      <FiBell size={13} /> Enable On This Device
                    </button>
                  </div>
                )}

                {state === 'on' && (
                  <div className="space-y-2.5">
                    <p className="text-[11px] text-emerald-800 leading-relaxed bg-emerald-50/60 p-2 rounded-lg border border-emerald-100">
                      ✓ Connected. You will receive chat messages, delegations, and incoming calls here.
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={test}
                        disabled={testing}
                        className="btn btn-secondary flex-1 text-xs py-1.5 flex items-center justify-center gap-1.5 font-medium"
                      >
                        <FiSend size={12} className={testing ? 'animate-bounce' : ''} />
                        {testing ? 'Sending...' : 'Send Test'}
                      </button>

                      {strictlyEnforced ? (
                        <div
                          className="flex-1 flex items-center justify-center text-xs py-1.5 bg-gray-100 text-gray-400 border border-gray-200 rounded-lg font-medium cursor-not-allowed"
                          title="Mandatory company policy enforced by admin"
                        >
                          <FiLock className="mr-1" size={11} /> Locked
                        </div>
                      ) : (
                        <button
                          onClick={turnOff}
                          className="btn btn-danger flex-1 text-xs py-1.5 font-medium"
                        >
                          Disable
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Admin Management Desk Banner (Prominent Card for Admins) */}
              {isAdmin && (
                <div className="p-3 bg-gradient-to-br from-indigo-950 via-slate-900 to-blue-950 rounded-xl text-white shadow-md border border-indigo-800/40 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 font-bold text-xs text-blue-200">
                      <FiShield className="text-blue-400" size={14} /> Admin Control Desk
                    </div>
                    <span className="text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-400/30">
                      Company Policy
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-300 leading-relaxed">
                    Audit all employee devices, remotely turn ON notifications, and enforce strict compliance locks.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      setShowAdminModal(true);
                    }}
                    className="w-full py-2 px-3 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg text-xs transition flex items-center justify-center gap-1.5 shadow-sm"
                  >
                    <span>Manage Employee Notifications</span>
                    <FiChevronRight size={14} />
                  </button>
                </div>
              )}

              {/* Sound & Troubleshooting Collapsible */}
              <details className="pt-1 text-[11px] text-gray-500 group">
                <summary className="cursor-pointer hover:text-gray-800 font-medium flex items-center justify-between py-1 select-none">
                  <span className="flex items-center gap-1 text-gray-600">
                    <FiHelpCircle size={12} /> Sound & Device Help
                  </span>
                  <span className="text-gray-400 group-open:rotate-180 transition-transform text-[10px]">
                    ▼
                  </span>
                </summary>
                <div className="p-2.5 mt-1 bg-gray-50 rounded-lg space-y-1.5 text-[10px] text-gray-600 border border-gray-100">
                  <p>
                    <strong>Android:</strong> Long-press a SOTYN notification → Settings → Set to Alerting & choose sound.
                  </p>
                  <p>
                    <strong>iPhone:</strong> Settings → Notifications → SOTYN → Turn Sounds ON. Ensure Focus mode is off.
                  </p>
                  <p className="text-gray-400">
                    Each device must be enabled individually. Internet or battery saver can delay background push.
                  </p>
                </div>
              </details>
            </div>
          </div>
        </>
      )}

      {/* Admin Control Modal */}
      {isAdmin && (
        <AdminNotificationControlModal
          isOpen={showAdminModal}
          onClose={() => setShowAdminModal(false)}
        />
      )}
    </div>
  );
}
