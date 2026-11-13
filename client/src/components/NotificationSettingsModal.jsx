import { useState, useEffect } from 'react';
import { FiX, FiBell, FiCheck, FiSmartphone, FiShield, FiSliders, FiLock } from 'react-icons/fi';
import api from '../api';
import toast from 'react-hot-toast';
import { enablePushNotifications, getPermissionState, pushSupported } from '../lib/push';

const CATEGORIES = [
  { key: 'chat_mention', label: 'Group Chat Mentions (@Mentions)', icon: '💬' },
  { key: 'chat_dm',      label: 'Direct Messages (DMs)',          icon: '✉️' },
  { key: 'delegation',   label: 'Task Delegations',               icon: '📋' },
  { key: 'ticket',       label: 'Helpdesk Tickets',               icon: '🆘' },
  { key: 'approval',     label: 'Procurement & Approvals',        icon: '📄' },
];

export default function NotificationSettingsModal({ isOpen, onClose }) {
  const [prefs, setPrefs] = useState({});
  const [isStrictlyEnforced, setIsStrictlyEnforced] = useState(false);
  const [loading, setLoading] = useState(true);
  const [permState, setPermState] = useState('default');
  const [enablingPush, setEnablingPush] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    loadPrefs();
    checkPushStatus();
  }, [isOpen]);

  const loadPrefs = async () => {
    try {
      setLoading(true);
      const res = await api.get('/notifications/preferences');
      const data = res.data || {};
      setIsStrictlyEnforced(Boolean(data._is_strictly_enforced));
      setPrefs(data);
    } catch (_) {
      // Defaults if not set
      setPrefs({});
      setIsStrictlyEnforced(false);
    } finally {
      setLoading(false);
    }
  };

  const checkPushStatus = async () => {
    try {
      const state = await getPermissionState();
      setPermState(state);
    } catch (_) {
      setPermState('unsupported');
    }
  };

  const handleToggle = async (catKey, channel) => {
    const current = prefs[catKey] || { in_app: true, push: true, email: false };
    const nextVal = !current[channel];

    // If strictly enforced, block turning off
    if (isStrictlyEnforced && !nextVal) {
      toast.error('Notification settings are strictly locked by company administration.', {
        icon: '🔒'
      });
      return;
    }

    const updated = {
      ...current,
      [channel]: nextVal
    };

    setPrefs(prev => ({ ...prev, [catKey]: updated }));

    try {
      await api.put('/notifications/preferences', {
        category: catKey,
        in_app: updated.in_app,
        push: updated.push,
        email: updated.email
      });
      toast.success('Preference updated');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update preference');
      loadPrefs();
    }
  };

  const handleEnablePush = async () => {
    setEnablingPush(true);
    try {
      const res = await enablePushNotifications();
      if (res.ok) {
        toast.success('Push notifications active for this device! 🎉');
        setPermState('granted');
      } else {
        if (res.reason === 'permission_denied') {
          toast.error('Notification permission was blocked in your browser settings. Please allow notifications in site settings.');
        } else {
          toast.error(`Push setup: ${res.reason || 'Could not subscribe'}`);
        }
      }
    } catch (err) {
      toast.error(err.message || 'Push activation failed');
    } finally {
      setEnablingPush(false);
      checkPushStatus();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-3 bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full border border-gray-200 overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="px-4 py-3 bg-gradient-to-r from-blue-600 to-indigo-700 text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FiSliders size={18} />
            <h3 className="font-semibold text-sm">Notification Settings</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-white/20 rounded-lg transition-colors text-white"
          >
            <FiX size={16} />
          </button>
        </div>

        <div className="p-4 overflow-y-auto space-y-4 text-xs">
          {/* Strictly Enforced Policy Banner */}
          {isStrictlyEnforced && (
            <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-lg space-y-1">
              <div className="flex items-center gap-1.5 font-bold text-indigo-900 text-xs">
                <FiLock className="text-indigo-600" /> Mandatory Company Policy Enforced
              </div>
              <p className="text-[11px] text-indigo-700 leading-relaxed">
                Your notification channels and push alerts are strictly locked ON by administration to ensure operational compliance.
              </p>
            </div>
          )}

          {/* Device Push Status Banner */}
          <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-blue-900 flex items-center gap-1.5">
                <FiSmartphone size={14} /> System Push Notifications
              </span>
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                permState === 'granted' ? 'bg-emerald-100 text-emerald-800' :
                permState === 'denied' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'
              }`}>
                {permState}
              </span>
            </div>
            <p className="text-[11px] text-gray-600">
              Receive alerts on Chrome desktop, Android lock screen, or iOS Home Screen app even when SEPL is closed.
            </p>
            {permState !== 'granted' && (
              <button
                type="button"
                onClick={handleEnablePush}
                disabled={enablingPush}
                className="w-full mt-1 btn btn-primary text-[11px] py-1.5 px-3 flex items-center justify-center gap-1.5 shadow-sm"
              >
                <FiBell size={13} />
                {enablingPush ? 'Enabling...' : 'Enable System Notifications on this Device'}
              </button>
            )}
          </div>

          {/* Channel Matrix */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-semibold text-gray-800 flex items-center gap-1.5">
                <FiShield size={13} className="text-gray-500" /> Channel Preferences
              </h4>
              {isStrictlyEnforced && (
                <span className="text-[10px] text-indigo-700 font-bold flex items-center gap-1">
                  <FiLock size={10} /> Locked ON
                </span>
              )}
            </div>
            
            <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
              <div className="bg-gray-50 px-3 py-2 flex items-center justify-between font-semibold text-gray-500 text-[10px] uppercase tracking-wider">
                <span>Scenario</span>
                <div className="flex items-center gap-5 pr-2">
                  <span>In-App</span>
                  <span>Push</span>
                </div>
              </div>

              {CATEGORIES.map(cat => {
                const setting = prefs[cat.key] || { in_app: true, push: true };
                return (
                  <div key={cat.key} className="px-3 py-2.5 flex items-center justify-between hover:bg-gray-50/70">
                    <span className="font-medium text-gray-800 flex items-center gap-1.5">
                      <span>{cat.icon}</span> {cat.label}
                    </span>
                    <div className="flex items-center gap-6 pr-3">
                      {/* In-App Toggle */}
                      <input
                        type="checkbox"
                        checked={setting.in_app !== false}
                        disabled={isStrictlyEnforced && setting.in_app !== false}
                        onChange={() => handleToggle(cat.key, 'in_app')}
                        className={`rounded text-blue-600 focus:ring-blue-500 h-4 w-4 ${
                          isStrictlyEnforced ? 'cursor-not-allowed opacity-80' : 'cursor-pointer'
                        }`}
                        title={isStrictlyEnforced ? 'Locked by company administration' : 'In-app notification bar'}
                      />
                      {/* Push Toggle */}
                      <input
                        type="checkbox"
                        checked={setting.push !== false}
                        disabled={isStrictlyEnforced && setting.push !== false}
                        onChange={() => handleToggle(cat.key, 'push')}
                        className={`rounded text-indigo-600 focus:ring-indigo-500 h-4 w-4 ${
                          isStrictlyEnforced ? 'cursor-not-allowed opacity-80' : 'cursor-pointer'
                        }`}
                        title={isStrictlyEnforced ? 'Locked by company administration' : 'Browser / Mobile push notification'}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 bg-gray-50 border-t border-gray-100 flex justify-end">
          <button
            onClick={onClose}
            className="btn btn-secondary text-xs py-1 px-4"
          >
            Close
          </button>
        </div>

      </div>
    </div>
  );
}
