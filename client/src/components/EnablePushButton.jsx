// Small header button that lets users turn on / off push notifications
// for the current device. Phone, laptop, desktop — each device gets
// its own subscription. Mam can also click "Test" to verify.

import { useState, useEffect } from 'react';
import { FiBell, FiBellOff } from 'react-icons/fi';
import toast from 'react-hot-toast';
import api from '../api';
import { pushSupported, enablePushNotifications, disablePushNotifications, getPermissionState } from '../lib/push';

export default function EnablePushButton() {
  const [state, setState] = useState('loading'); // loading | unsupported | denied | off | on
  const [open, setOpen] = useState(false);

  const refresh = async () => {
    if (!pushSupported()) { setState('unsupported'); return; }
    const perm = await getPermissionState();
    if (perm === 'denied') { setState('denied'); return; }
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
      toast.success('SOTYN Chat notifications enabled on this device');
      refresh();
    } else if (r.reason === 'permission_denied') {
      toast.error('You blocked notifications. Open browser settings → Site Settings → Notifications → Allow.', { duration: 6000 });
      setState('denied');
    } else {
      toast.error(`Failed: ${r.reason}${r.error ? ` (${r.error})` : ''}`, { duration: 6000 });
    }
  };

  const turnOff = async () => {
    await disablePushNotifications();
    toast.success('Push disabled on this device');
    refresh();
  };

  const test = async () => {
    try {
      const r = await api.post('/push/test', { message: 'Test from SOTYN.AI — your devices are connected ✓' });
      if (r.data.sent) toast.success(`Accepted by push service — ${r.data.sent} of ${r.data.total} devices. Check your phone.`);
      else toast.error('No connected device accepted the test. Enable notifications again and check phone settings.');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  };

  if (state === 'loading') return null;

  return (
    <div className="sm:relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={`p-2 rounded-lg hover:bg-gray-100 flex-shrink-0 ${state === 'on' ? 'text-emerald-600' : 'text-gray-500'}`}
        title={state === 'on' ? 'Push ON for this device' : 'Push OFF — click to enable'}
        aria-label={state === 'on' ? 'Push notifications on — manage' : 'Push notifications off — enable'}
      >
        {state === 'on' ? <FiBell size={20} /> : <FiBellOff size={20} />}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/20 sm:bg-transparent" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute left-3 right-3 top-full mt-1.5 sm:left-auto sm:right-0 sm:mt-1 sm:w-80 max-w-[calc(100vw-1.5rem)] sm:max-w-none bg-white border border-gray-200 rounded-xl shadow-2xl z-50 p-4 text-sm">
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-bold text-gray-800 flex items-center gap-2">
                <FiBell className="text-blue-600" /> SOTYN Chat Notifications
              </h4>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-gray-400 hover:text-gray-600 p-1 rounded sm:hidden"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            {state === 'unsupported' && (
              <p className="text-xs text-amber-700">On iPhone/iPad (iOS 16.4+), use Safari → Share → Add to Home Screen, then open SOTYN from that icon. On Android, use Chrome and allow notifications.</p>
            )}
            {state === 'denied' && (
              <p className="text-xs text-red-700">Permission was blocked. Open browser site settings → Notifications → Allow, then refresh.</p>
            )}
            {state === 'off' && (
              <>
                <p className="text-xs text-gray-600 mb-3 leading-relaxed">
                  Get only SOTYN Chat messages in your phone notification panel, even when you close the app without logging out. Other alerts stay inside SOTYN.
                </p>
                <button onClick={turnOn} className="btn btn-primary w-full text-sm py-2">Enable on this device</button>
              </>
            )}
            {state === 'on' && (
              <>
                <p className="text-xs text-emerald-700 mb-3 leading-relaxed">
                  ✓ SOTYN Chat alerts are enabled on this device, including when the app is closed. Logging out disconnects this device.
                </p>
                <div className="flex gap-2">
                  <button onClick={test} className="btn btn-secondary flex-1 text-xs py-2">Send Test</button>
                  <button onClick={turnOff} className="btn btn-danger flex-1 text-xs py-2">Disable</button>
                </div>
              </>
            )}
            <p className="text-xs text-gray-600 mt-3 border-t pt-2">No sound? Android: long-press a SOTYN notification → Settings → choose Alerting and a sound. iPhone: Settings → Notifications → SOTYN → Sounds on. Check notification volume and Silent/Focus mode. SOTYN cannot override your phone's sound settings.</p>
            <p className="text-[10px] text-gray-400 mt-2">Enable each phone separately. iPhone needs the Home Screen app. Internet and battery restrictions can affect delivery.</p>
          </div>
        </>
      )}
    </div>
  );
}
