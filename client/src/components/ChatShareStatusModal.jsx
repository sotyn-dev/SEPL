import { useEffect, useState } from 'react';
import { FiCheckCircle, FiAlertTriangle, FiSmartphone, FiRefreshCw, FiExternalLink, FiX, FiHelpCircle, FiCheck } from 'react-icons/fi';
import Modal from './Modal';

export default function ChatShareStatusModal({ isOpen, onClose }) {
  const [swActive, setSwActive] = useState(false);
  const [idbReady, setIdbReady] = useState(false);
  const [testResult, setTestResult] = useState('');
  const [testing, setTesting] = useState(false);

  const isIOS = typeof navigator !== 'undefined' && (
    /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
  const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
  const isStandalone = typeof window !== 'undefined' && (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );

  useEffect(() => {
    if (!isOpen) return;
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      setSwActive(!!navigator.serviceWorker.controller);
      navigator.serviceWorker.ready.then(() => setSwActive(true)).catch(() => {});
    }
    if (typeof window !== 'undefined' && 'indexedDB' in window) {
      setIdbReady(true);
    }
  }, [isOpen]);

  async function testReceiver() {
    setTesting(true);
    setTestResult('');
    try {
      if (!window.SotynChatShares) {
        const STORE_URL = '/chat-share-store.js';
        await import(/* @vite-ignore */ STORE_URL);
      }
      const store = window.SotynChatShares;
      if (!store) throw new Error('Share storage script not loaded');
      const sample = await store.create({
        text: 'Self-test diagnostic verification',
        files: []
      });
      await store.remove(sample.id);
      setTestResult('success');
    } catch (e) {
      setTestResult(e.message || 'Diagnostic failed');
    } finally {
      setTesting(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="WhatsApp & Media Share Setup">
      <div className="space-y-4 text-sm text-gray-700">
        {/* Device & environment summary */}
        <div className="bg-slate-50 border rounded-xl p-3.5 space-y-2">
          <div className="flex items-center justify-between text-xs text-gray-500 font-medium">
            <span>DEVICE & APP DIAGNOSTICS</span>
            <span className="flex items-center gap-1">
              <FiSmartphone size={13} />
              {isAndroid ? 'Android' : isIOS ? 'iPhone / iOS' : 'Desktop / Other'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs pt-1">
            <div className="bg-white p-2 rounded-lg border">
              <span className="text-gray-400 block">App Installation</span>
              <span className="font-semibold text-gray-800 flex items-center gap-1 mt-0.5">
                {isStandalone ? (
                  <><FiCheckCircle className="text-green-600" /> Installed (App)</>
                ) : (
                  <><FiAlertTriangle className="text-amber-500" /> Web Browser Tab</>
                )}
              </span>
            </div>
            <div className="bg-white p-2 rounded-lg border">
              <span className="text-gray-400 block">Share Receiver</span>
              <span className="font-semibold text-gray-800 flex items-center gap-1 mt-0.5">
                {swActive && idbReady ? (
                  <><FiCheckCircle className="text-green-600" /> Ready on device</>
                ) : (
                  <><FiRefreshCw className="text-blue-500 animate-spin" /> Initializing</>
                )}
              </span>
            </div>
          </div>

          {/* Test receiver button */}
          <div className="pt-1 flex items-center justify-between">
            <button
              onClick={testReceiver}
              disabled={testing}
              className="text-xs text-blue-700 underline flex items-center gap-1 hover:text-blue-900"
            >
              {testing ? 'Testing storage…' : 'Run self-test diagnostic'}
            </button>
            {testResult === 'success' && (
              <span className="text-xs text-green-700 font-semibold flex items-center gap-1">
                <FiCheck size={12} /> Storage receiver verified
              </span>
            )}
            {testResult && testResult !== 'success' && (
              <span className="text-xs text-red-600 font-medium">
                {testResult}
              </span>
            )}
          </div>
        </div>

        {/* Platform-specific instructions */}
        {isIOS ? (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2 text-amber-900 font-semibold">
              <FiAlertTriangle className="text-amber-600 flex-shrink-0" size={18} />
              <span>iPhone (iOS) Notice</span>
            </div>
            <p className="text-xs text-amber-800 leading-relaxed">
              Apple iOS does not permit browser-installed apps to appear in WhatsApp’s system Share sheet. WhatsApp sharing on iPhone requires an Apple App Store native app with an Xcode Share Extension.
            </p>
            <div className="bg-white/80 rounded-lg p-2.5 text-xs text-amber-900 space-y-1.5 border border-amber-100">
              <p className="font-semibold">How to share WhatsApp photos/files on iPhone:</p>
              <ol className="list-decimal pl-4 space-y-1">
                <li>In WhatsApp, save the photo to <strong>Photos</strong> or document to <strong>Files</strong>.</li>
                <li>In SOTYN Chat, open any chat and tap <strong>📎 (Paperclip)</strong> to send it.</li>
                <li>Or tap <strong>Share Media</strong> below to pick files and send to up to 10 chats.</li>
              </ol>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-2">
              <div className="flex items-center gap-2 text-blue-900 font-semibold">
                <FiHelpCircle className="text-blue-600 flex-shrink-0" size={18} />
                <span>Why SOTYN doesn't show in WhatsApp Share yet</span>
              </div>
              <p className="text-xs text-blue-800 leading-relaxed">
                When you installed SOTYN on Android, Chrome built an app package (WebAPK). Because the direct sharing receiver was added recently, your phone’s installed SOTYN app has not updated its Android Share Sheet registration yet.
              </p>
            </div>

            {/* The Fast Fix */}
            <div className="border border-green-200 bg-green-50/60 rounded-xl p-3.5 space-y-2">
              <div className="flex items-center gap-1.5 text-green-900 font-bold text-xs uppercase tracking-wide">
                <span>⚡ Instant 30-Second Fix (Recommended)</span>
              </div>
              <ol className="list-decimal pl-4 text-xs text-green-900 space-y-1 leading-relaxed">
                <li>On your phone home screen, <strong>long-press SOTYN</strong> and tap <strong>Uninstall</strong>.</li>
                <li>Open <strong>Google Chrome</strong> on your phone and open <strong>SOTYN ERP</strong>.</li>
                <li>Tap <strong>Install</strong> (or 3-dots menu ⋮ → <em>"Install application"</em> / <em>"Add to Home screen"</em>).</li>
                <li><strong>Done!</strong> Now open WhatsApp, select a photo/PDF, tap Share → <strong>SOTYN will immediately appear</strong> in the list!</li>
              </ol>
            </div>

            {/* Alternative slow update */}
            <div className="border rounded-xl p-3 bg-gray-50 text-xs text-gray-600 space-y-1">
              <p className="font-semibold text-gray-700">Alternative (without reinstalling):</p>
              <p>In phone Chrome, visit <code className="bg-white px-1 rounded border">chrome://webapks</code>, find SOTYN, and tap <strong>Update</strong>. Keep phone on Wi-Fi and charging. Android will install the update in the background within 24–48 hours.</p>
            </div>
          </div>
        )}

        {/* In-app direct media share fallback */}
        <div className="pt-2 flex flex-col sm:flex-row gap-2">
          <a
            href="/site-chat/share"
            className="flex-1 text-center bg-blue-700 hover:bg-blue-800 text-white font-medium py-2.5 px-4 rounded-xl text-xs flex items-center justify-center gap-1.5 shadow-sm"
          >
            <FiExternalLink size={14} /> Open SOTYN Media Uploader
          </a>
          <button
            onClick={onClose}
            className="border border-gray-300 hover:bg-gray-100 font-medium py-2.5 px-4 rounded-xl text-xs text-gray-700"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
