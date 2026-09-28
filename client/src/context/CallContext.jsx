// 1-on-1 voice & video calling for the internal WhatsApp (mam 2026-06-19).
// WebRTC carries the audio/video peer-to-peer; the existing chat Socket.IO
// only relays the tiny offer/answer/ICE control messages. A single global
// provider holds the call + renders the call overlay, so an incoming call
// rings anywhere in the app.
import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import api from '../api';
import { useAuth } from './AuthContext';
import { useAppSocket } from './SocketProvider';
import toast from 'react-hot-toast';
import { FiPhone, FiPhoneOff, FiVideo, FiVideoOff, FiMic, FiMicOff, FiX } from 'react-icons/fi';

const CallContext = createContext(null);
export const useCall = () => useContext(CallContext) || { startCall: () => {} };

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }];
const initials = (s) => String(s || '?').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 2).toUpperCase() || '#';

export function CallProvider({ children }) {
  const { user } = useAuth();
  const { subscribe, emit, isConnected } = useAppSocket();
  // call: null | { phase:'incoming'|'calling'|'active', peerId, peerName, video, callId }
  const [call, updateCall] = useState(null);
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);

  const pcRef = useRef(null);
  const localRef = useRef(null);            // local MediaStream
  const remoteRef = useRef(null);
  const callTimer = useRef(null);
  const localVidRef = useRef(null);         // <video> for self
  const remoteVidRef = useRef(null);        // <video> for the other person
  const remoteAudRef = useRef(null);        // <audio> fallback for voice calls
  const iceServersRef = useRef(DEFAULT_ICE);
  const pendingIce = useRef([]);            // ICE candidates that arrive before remoteDescription
  const incomingOffer = useRef(null);       // stored SDP offer for an incoming call
  const callRef = useRef(null);
  const setCall = useCallback((value) => { callRef.current = value; updateCall(value); }, []);
  const ringOsc = useRef(null);

  // ── ringtone (Web Audio beep loop — no asset needed) ──────────────────
  const startRing = () => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ac = new Ctx();
      const tick = () => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = 480; o.connect(g); g.connect(ac.destination);
        g.gain.setValueAtTime(0.0001, ac.currentTime);
        g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.5);
        o.start(); o.stop(ac.currentTime + 0.5);
      };
      tick();
      ringOsc.current = { ac, timer: setInterval(tick, 1500) };
    } catch (_) { /* ignore */ }
  };
  const stopRing = () => { try { clearInterval(ringOsc.current?.timer); ringOsc.current?.ac?.close(); } catch (_) {} ringOsc.current = null; };

  // ── cleanup ──────────────────────────────────────────────────────────
  const cleanup = useCallback(() => {
    callRef.current = null;
    clearTimeout(callTimer.current);
    stopRing();
    const pc = pcRef.current;
    pcRef.current = null;
    try { pc?.close(); } catch (_) {}
    try { localRef.current?.getTracks().forEach(t => t.stop()); } catch (_) {}
    localRef.current = null;
    remoteRef.current = null;
    pendingIce.current = []; incomingOffer.current = null;
    setMuted(false); setCamOff(false);
    setCall(null);
  }, [setCall]);

  const newPc = useCallback((peerId, callId) => {
    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
    pc.onicecandidate = (e) => {
      if (e.candidate) emit('call:ice', { to: peerId, callId, candidate: e.candidate });
    };
    pc.ontrack = (e) => {
      const [stream] = e.streams;
      remoteRef.current = stream;
      if (remoteVidRef.current) remoteVidRef.current.srcObject = stream;
      if (remoteAudRef.current) remoteAudRef.current.srcObject = stream;
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        if (callRef.current) cleanup();
      }
    };
    pcRef.current = pc;
    return pc;
  }, [cleanup, emit]);

  const drainIce = async () => {
    const pc = pcRef.current; if (!pc) return;
    for (const c of pendingIce.current) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {} }
    pendingIce.current = [];
  };

  // ── start an outgoing call ─────────────────────────────────────────────
  const startCall = useCallback(async (peerId, peerName, video) => {
    if (!peerId || callRef.current) return;
    if (!isConnected()) { toast.error('Calling is disconnected. Please wait for reconnection and try again.'); return; }
    const callId = (window.crypto?.randomUUID?.() || String(peerId) + '-' + performance.now());
    setCall({ phase: 'calling', peerId, peerName, video: !!video, callId });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: !!video });
      if (callRef.current?.callId !== callId) { stream.getTracks().forEach(t => t.stop()); return; }
      localRef.current = stream;
      const pc = newPc(peerId, callId);
      stream.getTracks().forEach(t => pc.addTrack(t, stream));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (callRef.current?.callId !== callId) return;
      if (!isConnected()) throw new Error('disconnected');
      callTimer.current = setTimeout(() => {
        if (callRef.current?.callId !== callId) return;
        emit('call:cancel', { to: peerId, callId });
        cleanup();
        toast.error('The call did not reach their screen. Ask them to open or refresh SOTYN and try again.');
      }, 12000);
      emit('call:offer', { to: peerId, callId, sdp: offer, video: !!video }, (result) => {
        if (callRef.current?.callId !== callId || result?.ok) return;
        cleanup();
        toast.error(result?.reason === 'offline'
          ? `${peerName || 'This person'} is not available for calls. They need to open or refresh SOTYN.`
          : 'Could not deliver the call invitation.');
      });
    } catch (e) {
      if (callRef.current?.callId !== callId) return;
      cleanup();
      toast.error(e.message === 'disconnected' ? 'Calling is disconnected. Please try again.'
        : 'Could not start the call — check microphone' + (video ? ' / camera' : '') + ' access.');
    }
  }, [newPc, cleanup, emit, isConnected, setCall]);

  // ── accept an incoming call ─────────────────────────────────────────────
  const acceptCall = useCallback(async () => {
    const c = callRef.current; const offer = incomingOffer.current;
    if (!c || !offer) return;
    stopRing();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: !!c.video });
      if (callRef.current?.callId !== c.callId) { stream.getTracks().forEach(t => t.stop()); return; }
      localRef.current = stream;
      const pc = newPc(c.peerId, c.callId);
      stream.getTracks().forEach(t => pc.addTrack(t, stream));
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await drainIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (callRef.current?.callId !== c.callId) return;
      clearTimeout(callTimer.current);
      emit('call:answer', { to: c.peerId, callId: c.callId, sdp: answer });
      setCall({ ...c, phase: 'active' });
    } catch (e) {
      if (callRef.current?.callId !== c.callId) return;
      emit('call:reject', { to: c.peerId, callId: c.callId });
      cleanup();
      alert('Could not join the call — allow microphone' + (c.video ? ' / camera' : '') + ' access.');
    }
  }, [newPc, cleanup, emit, setCall]);

  const rejectCall = useCallback(() => {
    const c = callRef.current; if (c) emit('call:reject', { to: c.peerId, callId: c.callId });
    cleanup();
  }, [cleanup, emit]);

  const endCall = useCallback(() => {
    const c = callRef.current;
    if (c) emit(c.phase === 'calling' ? 'call:cancel' : 'call:end', { to: c.peerId, callId: c.callId });
    cleanup();
  }, [cleanup, emit]);

  const toggleMute = () => {
    const s = localRef.current; if (!s) return;
    const on = !muted; s.getAudioTracks().forEach(t => { t.enabled = !on; }); setMuted(on);
  };
  const toggleCam = () => {
    const s = localRef.current; if (!s) return;
    const on = !camOff; s.getVideoTracks().forEach(t => { t.enabled = !on; }); setCamOff(on);
  };

  // ── call signalling (rides the shared shell socket — SocketProvider) ──────
  useEffect(() => {
    if (!user?.id) return;
    api.get('/site-chat/ice').then(r => { if (Array.isArray(r.data?.iceServers)) iceServersRef.current = r.data.iceServers; }).catch(() => {});
    // subscribe() attaches now (or when the deferred connect fires) and stays
    // attached across reconnects, so an incoming call rings on any page. Auth /
    // transports / storage-blocked handling live once in the shared socket.
    const onBye = (d) => { const c = callRef.current; if (c && c.callId === d.callId) cleanup(); };
    const offs = [
      subscribe('connect', () => emit('call:ready')),
      subscribe('disconnect', () => {
        if (!callRef.current) return;
        cleanup();
        toast.error('Call ended because the connection was lost. Please try again.');
      }),
      subscribe('call:offer', (d) => {
        if (callRef.current) { emit('call:reject', { to: d.from, callId: d.callId }); return; } // busy
        incomingOffer.current = d.sdp;
        setCall({ phase: 'incoming', peerId: d.from, peerName: d.fromName, video: !!d.video, callId: d.callId });
        emit('call:ringing', { to: d.from, callId: d.callId });
        callTimer.current = setTimeout(() => {
          if (callRef.current?.callId !== d.callId || callRef.current?.phase !== 'incoming') return;
          emit('call:reject', { to: d.from, callId: d.callId });
          cleanup();
        }, 45000);
        startRing();
      }),
      subscribe('call:ringing', (d) => {
        const c = callRef.current;
        if (!c || c.callId !== d.callId || c.phase !== 'calling' || c.ringing) return;
        clearTimeout(callTimer.current);
        setCall({ ...c, ringing: true });
        callTimer.current = setTimeout(() => {
          if (callRef.current?.callId !== d.callId) return;
          emit('call:cancel', { to: c.peerId, callId: c.callId });
          cleanup();
          toast.error('No answer. Please try again later.');
        }, 40000);
      }),
      subscribe('call:answer', async (d) => {
        const c = callRef.current; if (!c || c.callId !== d.callId) return;
        clearTimeout(callTimer.current);
        try {
          await pcRef.current?.setRemoteDescription(new RTCSessionDescription(d.sdp));
          await drainIce();
          if (callRef.current?.callId === c.callId) setCall({ ...c, phase: 'active' });
        } catch (_) { cleanup(); toast.error('Could not connect the call. Please try again.'); }
      }),
      subscribe('call:ice', async (d) => {
        const c = callRef.current; if (!c || c.callId !== d.callId || !d.candidate) return;
        if (pcRef.current?.remoteDescription) { try { await pcRef.current.addIceCandidate(new RTCIceCandidate(d.candidate)); } catch (_) {} }
        else pendingIce.current.push(d.candidate);
      }),
      subscribe('call:end', onBye),
      subscribe('call:reject', onBye),
      subscribe('call:cancel', onBye),
    ];
    if (isConnected()) emit('call:ready');
    return () => { emit('call:unready'); offs.forEach(off => off()); cleanup(); };
  }, [user?.id, cleanup, subscribe, emit, isConnected, setCall]);

  // attach local preview stream to the <video> when it mounts / call changes
  useEffect(() => {
    if (call?.phase === 'active' && call.video && localVidRef.current && localRef.current) {
      localVidRef.current.srcObject = localRef.current;
    }
    if (remoteVidRef.current && remoteRef.current) remoteVidRef.current.srcObject = remoteRef.current;
  }, [call?.phase, call?.video]);

  // Stable context value — only changes when startCall (memoised) or the call
  // state changes, so useCall consumers (e.g. SiteChat) don't re-render on
  // unrelated CallProvider re-renders, e.g. when Layout re-renders around it.
  const ctx = useMemo(() => ({ startCall, inCall: !!call }), [startCall, call]);

  return (
    <CallContext.Provider value={ctx}>
      {children}
      {call && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 text-white select-none" style={{ height: '100dvh' }}>
          {/* hidden remote audio so voice calls have sound even with no video element shown */}
          <audio ref={remoteAudRef} autoPlay playsInline className="hidden" />

          {call.phase === 'active' && call.video ? (
            <div className="relative w-full h-full">
              <video ref={remoteVidRef} autoPlay playsInline className="absolute inset-0 w-full h-full object-cover bg-black" />
              <video ref={localVidRef} autoPlay playsInline muted className="absolute right-3 w-24 h-32 sm:w-32 sm:h-44 object-cover rounded-lg border-2 border-white/40 bg-black" style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 6rem)' }} />
              <div className="absolute left-0 right-0 text-center text-lg font-semibold drop-shadow" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }}>{call.peerName}</div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4">
              <div className="w-28 h-28 rounded-full bg-emerald-600 flex items-center justify-center text-4xl font-bold">{initials(call.peerName)}</div>
              <div className="text-2xl font-semibold">{call.peerName}</div>
              <div className="text-sm text-white/70">
                {call.phase === 'incoming' ? `Incoming ${call.video ? 'video' : 'voice'} call…`
                  : call.phase === 'calling' ? `${call.ringing ? 'Ringing' : 'Calling'}… (${call.video ? 'video' : 'voice'})`
                    : `${call.video ? 'Video' : 'Voice'} call`}
              </div>
            </div>
          )}

          {/* controls */}
          <div className="absolute left-0 right-0 flex items-center justify-center gap-4" style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 2rem)' }}>
            {call.phase === 'incoming' ? (
              <>
                <button onClick={rejectCall} className="w-16 h-16 rounded-full bg-red-600 hover:bg-red-700 flex items-center justify-center" title="Decline"><FiPhoneOff size={26} /></button>
                <button onClick={acceptCall} className="w-16 h-16 rounded-full bg-emerald-500 hover:bg-emerald-600 flex items-center justify-center" title="Accept"><FiPhone size={26} /></button>
              </>
            ) : (
              <>
                <button onClick={toggleMute} className={`w-12 h-12 rounded-full flex items-center justify-center ${muted ? 'bg-white text-gray-800' : 'bg-white/20 hover:bg-white/30'}`} title={muted ? 'Unmute' : 'Mute'}>{muted ? <FiMicOff size={20} /> : <FiMic size={20} />}</button>
                {call.video && (
                  <button onClick={toggleCam} className={`w-12 h-12 rounded-full flex items-center justify-center ${camOff ? 'bg-white text-gray-800' : 'bg-white/20 hover:bg-white/30'}`} title={camOff ? 'Camera on' : 'Camera off'}>{camOff ? <FiVideoOff size={20} /> : <FiVideo size={20} />}</button>
                )}
                <button onClick={endCall} className="w-16 h-16 rounded-full bg-red-600 hover:bg-red-700 flex items-center justify-center" title="Hang up"><FiPhoneOff size={26} /></button>
              </>
            )}
          </div>
        </div>
      )}
    </CallContext.Provider>
  );
}
