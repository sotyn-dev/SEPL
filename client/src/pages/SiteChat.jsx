// "WhatsApp" — internal group chat, WhatsApp-styled (mam 2026-06-18). Create
// named groups, add the people you want, chat (text + photo/file). Members-
// gated, read receipts (✓✓ + who-read), unread badges, day separators.
import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react';
import { io } from 'socket.io-client';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtTime, fmtDate, fmtDateTime } from '../utils/datetime';
import { FiSearch, FiSend, FiPaperclip, FiTrash2, FiFile, FiUsers, FiX, FiPlus, FiMic, FiUserPlus, FiInfo, FiPhone, FiVideo, FiArrowLeft } from 'react-icons/fi';
import { FaWhatsapp } from 'react-icons/fa';
import { useCall } from '../context/CallContext';

const DAY_OPTS = { day: '2-digit', month: 'short', year: 'numeric' };
const GREEN = '#075e54';                          // WhatsApp header green
const isImg = (u) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(String(u || ''));
const isAudio = (u) => /\.(webm|ogg|mp3|m4a|wav|aac|opus)$/i.test(String(u || ''));
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const preview = (m) => (m ? (m.body || (m.attachment_name ? `📎 ${m.attachment_name}` : '')) : '');
const initials = (s) => String(s || '?').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 2).toUpperCase() || '#';

// Stable, module-level avatar (photo or initials). MUST live outside the page
// component — an inline component is a new type each render, which remounts &
// reloads every photo on every keystroke and freezes the chat (mam 2026-06-19
// "add group is hang").
function Avatar({ url, name, size = 36, className = '' }) {
  const st = { width: size, height: size };
  return url
    ? <img src={url} alt={name || ''} className={`rounded-full object-cover flex-shrink-0 ${className}`} style={st} />
    : <span className={`rounded-full bg-emerald-100 text-emerald-700 font-bold flex items-center justify-center flex-shrink-0 ${className}`} style={{ ...st, fontSize: Math.round(size * 0.34) }}>{initials(name)}</span>;
}

export default function SiteChat() {
  const { canCreate, canDelete, isAdmin, user } = useAuth();
  const { startCall } = useCall();
  const [groups, setGroups] = useState([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);            // selected group {id, name}
  const [msgs, setMsgs] = useState([]);
  const [members, setMembers] = useState([]);
  const [reads, setReads] = useState({});
  const [readsAt, setReadsAt] = useState({});      // user_id -> last-read timestamp (for Message Info)
  const [infoMsg, setInfoMsg] = useState(null);    // message whose "info" panel is open
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [allUsers, setAllUsers] = useState([]);
  const [memOpen, setMemOpen] = useState(false);
  const [memSearch, setMemSearch] = useState('');
  const [renameVal, setRenameVal] = useState('');
  const [dmOpen, setDmOpen] = useState(false);     // "new direct message" picker
  const [dmSearch, setDmSearch] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSel, setNewSel] = useState([]);
  const [newSearch, setNewSearch] = useState('');
  const [recording, setRecording] = useState(false);
  const [recTime, setRecTime] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [mention, setMention] = useState(null);    // @-tag autocomplete: { query, start } or null
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const avatarRef = useRef(null);
  const sendingRef = useRef(false);   // synchronous guard against double-send
  const endRef = useRef(null);
  const scrollRef = useRef(null);       // the messages scroll container
  const atBottomRef = useRef(true);     // is the user currently pinned to the bottom?
  const lastGroupRef = useRef(null);    // detect a thread switch (always jump to bottom then)
  const socketRef = useRef(null);
  const mediaRef = useRef(null);
  const chunksRef = useRef([]);
  const recTimerRef = useRef(null);

  const loadGroups = useCallback(() => { api.get('/site-chat/groups').then(r => setGroups(r.data || [])).catch(() => {}); }, []);
  const reloadUsers = useCallback(() => api.get('/auth/users').then(r => setAllUsers((r.data || []).filter(u => u.active !== 0))).catch(() => {}), []);
  const loadThread = useCallback((id) => {
    if (!id) return;
    api.get(`/site-chat/${id}`).then(r => {
      setMsgs(r.data.messages || []); setMembers(r.data.members || []); setReads(r.data.reads || {}); setReadsAt(r.data.readsAt || {});
      if (r.data.group) setSel(s => (s && s.id === id ? { ...s, name: r.data.group.name, is_dm: r.data.group.is_dm } : s));
      loadGroups();
    }).catch(() => {});
  }, [loadGroups]);

  useEffect(() => { loadGroups(); reloadUsers(); }, [loadGroups, reloadUsers]);
  // Real-time: one Socket.IO connection; the server pushes a 'changed' event
  // to each group's room on any message/read/member change. Polling stays as
  // a fallback if the socket can't connect.
  useEffect(() => {
    const socket = io({ path: '/socket.io', auth: { token: localStorage.getItem('token') }, transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    // On (re)connect, re-join the open group's room and catch up on anything
    // missed while disconnected — fixes "always need to refresh" after a drop.
    socket.on('connect', () => { loadGroups(); setSel(s => { if (s) { socket.emit('join', s.id); loadThread(s.id); } return s; }); });
    socket.on('changed', ({ groupId }) => { setSel(s => { if (s && s.id === groupId) loadThread(s.id); return s; }); loadGroups(); });
    socket.on('group_deleted', ({ groupId }) => { loadGroups(); setSel(s => (s && s.id === groupId ? null : s)); });
    return () => { socket.disconnect(); socketRef.current = null; };
  }, [loadThread, loadGroups]);
  useEffect(() => {
    if (!sel) return;
    socketRef.current?.emit('join', sel.id);
    loadThread(sel.id);
    const t = setInterval(() => loadThread(sel.id), 6000);    // fallback poll (safe: GET no longer self-emits)
    const onFocus = () => loadThread(sel.id);
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [sel?.id, loadThread]);
  // Auto-scroll, WhatsApp-style: jump to the bottom only when opening a thread
  // or when a new message arrives AND the user is already near the bottom. If
  // they've scrolled up to read history, the 6 s poll must NOT yank them back
  // down (mam 2026-06-22: "if i read old message it automatically comes to latest").
  useEffect(() => {
    if (sel?.id !== lastGroupRef.current) {     // thread just opened/switched
      lastGroupRef.current = sel?.id;
      atBottomRef.current = true;
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end' }));
      return;
    }
    if (atBottomRef.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [msgs, sel?.id]);
  const onMsgScroll = () => {
    const el = scrollRef.current; if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  useEffect(() => { if (memOpen && sel) setRenameVal(sel.name || ''); }, [memOpen, sel?.id]);

  const todayLbl = fmtDate(new Date(), DAY_OPTS);
  const yestLbl = fmtDate(new Date(Date.now() - 864e5), DAY_OPTS);
  const dayLabel = (ts) => { const l = fmtDate(ts, DAY_OPTS); return l === todayLbl ? 'Today' : l === yestLbl ? 'Yesterday' : l; };

  const send = async (extra = {}) => {
    if (!sel || sendingRef.current) return;          // ref guard = no duplicate sends
    const payload = { body: text, ...extra };
    if (!payload.body?.trim() && !payload.attachment_url) return;
    sendingRef.current = true; setBusy(true);
    atBottomRef.current = true;                       // sending my own message always jumps to bottom
    try { await api.post(`/site-chat/${sel.id}`, payload); setText(''); setMention(null); loadThread(sel.id); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed to send'); }
    finally { sendingRef.current = false; setBusy(false); }
  };
  const attach = async (file) => {
    if (!file || !sel) return;
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      await send({ attachment_url: r.data.url, attachment_name: r.data.filename || file.name });
    } catch (err) { toast.error(err.response?.data?.error || 'Upload failed'); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  // Voice messages — record with MediaRecorder, then upload + send like any
  // attachment. Tap mic to start; tick to send, bin to cancel.
  const startRec = async () => {
    if (!navigator.mediaDevices?.getUserMedia) return toast.error('Mic not supported here');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = e => { if (e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
        if (mr._send && blob.size > 0) {
          const ext = (mr.mimeType || '').includes('ogg') ? 'ogg' : 'webm';
          attach(new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type }));
        }
      };
      mediaRef.current = mr; mr.start();
      setRecording(true); setRecTime(0);
      recTimerRef.current = setInterval(() => setRecTime(t => t + 1), 1000);
    } catch (e) { toast.error('Microphone blocked — allow access'); }
  };
  const stopRec = (sendIt) => {
    const mr = mediaRef.current; if (!mr) return;
    mr._send = !!sendIt; clearInterval(recTimerRef.current); setRecording(false);
    try { mr.stop(); } catch (_) {}
  };
  const onDrop = (e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer?.files?.[0]; if (f) attach(f); };

  // ── Profile photos (mam 2026-06-19 "like whatsapp use profile photo") ──
  const userAvatars = useMemo(() => { const m = {}; for (const u of allUsers) m[u.id] = u.avatar_url; return m; }, [allUsers]);
  const onAvatarFile = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      await api.post('/auth/avatar', { avatar_url: r.data.url });
      reloadUsers(); if (sel) loadThread(sel.id);
      toast.success('Profile photo updated');
    } catch (err) { toast.error(err.response?.data?.error || 'Upload failed'); }
    finally { setBusy(false); if (avatarRef.current) avatarRef.current.value = ''; }
  };
  const removeAvatar = async () => {
    try { await api.post('/auth/avatar', { avatar_url: null }); reloadUsers(); toast.success('Photo removed'); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // ── @-mention / tag-by-name (mam 2026-06-19: "at the rate tag by name") ──
  // On each keystroke, look back from the caret for an "@word" token (at the
  // start or after a space) and open a member picker filtered by that word.
  const onTextChange = (e) => {
    const val = e.target.value; setText(val);
    const pos = e.target.selectionStart ?? val.length;
    const m = val.slice(0, pos).match(/(?:^|\s)@([^\s@]*)$/);
    setMention(m ? { query: m[1], start: pos - m[1].length - 1 } : null);
  };
  const mentionList = mention
    ? members.filter(m => m.user_id !== user?.id && m.name && m.name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 6)
    : [];
  const pickMention = (name) => {
    const ta = taRef.current;
    const pos = ta?.selectionStart ?? text.length;
    const before = text.slice(0, mention?.start ?? pos);
    const after = text.slice(pos);
    const inserted = `@${name} `;
    setText(before + inserted + after); setMention(null);
    requestAnimationFrame(() => { if (ta) { const c = (before + inserted).length; ta.focus(); ta.setSelectionRange(c, c); } });
  };
  // Highlight @mentions of current members when rendering a message body.
  const renderBody = (body) => {
    const names = members.map(m => m.name).filter(Boolean).sort((a, b) => b.length - a.length);
    if (!body || !names.length) return body;
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`@(${names.map(esc).join('|')})`, 'g');
    const out = []; let last = 0; let mm;
    while ((mm = re.exec(body))) {
      if (mm.index > last) out.push(body.slice(last, mm.index));
      out.push(<span key={mm.index} className="text-emerald-700 font-semibold">@{mm[1]}</span>);
      last = mm.index + mm[0].length;
    }
    if (last < body.length) out.push(body.slice(last));
    return out;
  };

  const delMsg = async (m) => {
    if (!confirm('Delete this message?')) return;
    try { await api.delete(`/site-chat/${sel.id}/messages/${m.id}`); loadThread(sel.id); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const saveRename = async () => {
    const name = renameVal.trim();
    if (!name) return toast.error('Group name is required');
    if (name === sel.name) return;
    try { await api.put(`/site-chat/${sel.id}`, { name }); setSel(s => ({ ...s, name })); loadGroups(); loadThread(sel.id); toast.success('Group renamed'); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed to rename'); }
  };
  const addMember = async (uid) => { try { await api.post(`/site-chat/${sel.id}/members`, { user_ids: [uid] }); loadThread(sel.id); } catch (err) { toast.error(err.response?.data?.error || 'Failed'); } };
  const removeMember = async (uid) => { try { await api.delete(`/site-chat/${sel.id}/members/${uid}`); loadThread(sel.id); } catch (err) { toast.error(err.response?.data?.error || 'Failed'); } };

  // Open (or create) a 1-on-1 direct message with a person — anyone can.
  const startDm = async (uid, name) => {
    try {
      const r = await api.post('/site-chat/dm', { user_id: uid });
      setDmOpen(false); setDmSearch(''); loadGroups();
      setSel({ id: r.data.id, name: r.data.name || name, is_dm: 1 });
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to start chat'); }
  };

  const createGroup = async () => {
    if (!newName.trim()) return toast.error('Give the group a name');
    if (busy) return;                                   // guard against double-submit
    setBusy(true);
    try {
      const r = await api.post('/site-chat/groups', { name: newName.trim(), member_ids: newSel });
      setNewOpen(false); setNewName(''); setNewSel([]); setNewSearch('');
      loadGroups(); setSel({ id: r.data.id, name: r.data.name });
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to create group'); }
    finally { setBusy(false); }
  };
  const delGroup = async () => {
    if (!sel || !confirm(`Delete the group "${sel.name}" and all its messages?`)) return;
    try { await api.delete(`/site-chat/${sel.id}`); setSel(null); setMemOpen(false); loadGroups(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const shown = groups.filter(g => !q || String(g.name).toLowerCase().includes(q.toLowerCase()));

  // Hidden file input for the profile photo — kept at the top level so BOTH the
  // desktop header button and the mobile (chat-list) avatar button can trigger
  // it. `hidden` keeps the element mounted, so the ref stays valid on mobile.
  const avatarInput = <input ref={avatarRef} type="file" accept="image/*" className="hidden" onChange={e => onAvatarFile(e.target.files?.[0])} />;

  return (
    // Full-height flex column. The chat card flex-fills the remaining space, so
    // no fragile magic-number height. dvh (NOT vh) keeps the composer above the
    // phone browser's bottom toolbar (mam 2026-06-19: "below button not show").
    // Mobile subtracts only the app bar + page padding; desktop also the header.
    <div className="flex flex-col h-[calc(100dvh-64px)] md:h-[calc(100dvh-104px)]">
      {avatarInput}
      {/* Page header — desktop only. On mobile the chat takes the full screen
          (like real WhatsApp); the profile photo moves into the list header. */}
      <div className="hidden sm:flex items-start justify-between gap-3 mb-3 flex-shrink-0">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2"><FaWhatsapp className="text-[#25d366]" /> WhatsApp</h1>
          <p className="text-sm text-gray-500">Internal group chat · create groups · add your people · text + photos/files</p>
        </div>
        {/* Your profile photo — tap to upload (mam 2026-06-19). */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={() => avatarRef.current?.click()} disabled={busy} className="relative" title="Change your photo">
            <Avatar url={userAvatars[user?.id]} name={user?.name} size={42} />
            <span className="absolute -bottom-0.5 -right-0.5 bg-emerald-600 text-white rounded-full w-4 h-4 flex items-center justify-center text-[9px] ring-2 ring-white">✎</span>
          </button>
          {userAvatars[user?.id] && <button onClick={removeAvatar} className="text-[11px] text-gray-400 hover:text-red-600">Remove</button>}
        </div>
      </div>

      <div className="flex flex-1 min-h-0 border rounded-xl overflow-hidden bg-white">
        {/* ── Group list ────────────────────────────────── */}
        <div className={`w-full sm:w-80 border-r flex flex-col ${sel ? 'hidden sm:flex' : 'flex'}`}>
          <div className="flex items-center gap-2 px-3 py-2 text-white" style={{ background: GREEN }}>
            {/* Profile photo — mobile only (desktop has it in the page header). */}
            <button onClick={() => avatarRef.current?.click()} disabled={busy} className="sm:hidden relative flex-shrink-0" title="Change your photo">
              <Avatar url={userAvatars[user?.id]} name={user?.name} size={28} />
              <span className="absolute -bottom-0.5 -right-0.5 bg-emerald-600 rounded-full w-3.5 h-3.5 flex items-center justify-center text-[8px] ring-2 ring-[#075e54]">✎</span>
            </button>
            <FaWhatsapp className="hidden sm:block" /> <span className="font-semibold text-sm flex-1">WhatsApp</span>
            <button onClick={() => { setDmSearch(''); setDmOpen(true); }} className="p-1.5 rounded hover:bg-white/15" title="New direct message"><FiUserPlus size={18} /></button>
            {canCreate('site_chat') && <button onClick={() => { setNewName(''); setNewSel([]); setNewSearch(''); setNewOpen(true); }} className="p-1.5 rounded hover:bg-white/15" title="New group"><FiPlus size={18} /></button>}
          </div>
          <div className="p-2 border-b">
            <div className="relative">
              <FiSearch className="absolute left-2.5 top-2.5 text-gray-400" size={14} />
              <input className="input pl-8" placeholder="Search group…" value={q} onChange={e => setQ(e.target.value)} />
            </div>
          </div>
          <div className="overflow-y-auto flex-1">
            {shown.length === 0 && <div className="text-center text-gray-400 text-sm py-8">No groups yet.{canCreate('site_chat') ? ' Tap + to create one.' : ''}</div>}
            {shown.map(g => (
              <button key={g.id} onClick={() => setSel({ id: g.id, name: g.name })}
                className={`w-full text-left px-3 py-2.5 border-b flex items-start gap-2 hover:bg-gray-50 ${sel?.id === g.id ? 'bg-emerald-50' : ''}`}>
                <Avatar url={g.is_dm ? userAvatars[g.dm_uid] : null} name={g.name} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="flex justify-between items-baseline gap-2">
                    <span className="font-semibold text-sm text-gray-800 truncate">{g.name}</span>
                    {g.last && <span className="text-[10px] text-gray-400 flex-shrink-0">{fmtTime(g.last.created_at)}</span>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="text-xs text-gray-500 truncate flex-1">{g.last ? `${g.last.sender_name ? g.last.sender_name.split(' ')[0] + ': ' : ''}${preview(g.last)}` : <span className="italic text-gray-300">{g.members} member{g.members === 1 ? '' : 's'}</span>}</div>
                    {g.unread > 0 && <span className="text-[10px] font-bold text-white bg-[#25d366] rounded-full px-1.5 min-w-[18px] text-center flex-shrink-0">{g.unread}</span>}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* ── Thread ────────────────────────────────────── */}
        <div className={`flex-1 flex-col ${sel ? 'flex' : 'hidden sm:flex'}`}>
          {!sel ? (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-400 gap-2" style={{ background: '#f7f5f2' }}>
              <FaWhatsapp size={44} className="text-[#25d366]" /><span className="text-sm">Pick a group to start chatting</span>
            </div>
          ) : (
            <>
              <div className="px-3 py-2 flex items-center gap-2 text-white" style={{ background: GREEN }}>
                <button onClick={() => setSel(null)} className="sm:hidden -ml-1 p-1 rounded hover:bg-white/15" title="Back" aria-label="Back to chats"><FiArrowLeft size={22} /></button>
                <Avatar url={sel.is_dm ? userAvatars[members.find(m => m.user_id !== user?.id)?.user_id] : null} name={sel.name} size={36} />
                {sel.is_dm ? (
                  <>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-sm truncate">{sel.name}</div>
                      <div className="text-[11px] text-white/80 truncate">Direct message</div>
                    </div>
                    {(() => { const oid = members.find(m => m.user_id !== user?.id)?.user_id; return oid ? (
                      <>
                        <button onClick={() => startCall(oid, sel.name, false)} className="p-1.5 rounded hover:bg-white/15" title="Voice call"><FiPhone size={18} /></button>
                        <button onClick={() => startCall(oid, sel.name, true)} className="p-1.5 rounded hover:bg-white/15" title="Video call"><FiVideo size={18} /></button>
                      </>
                    ) : null; })()}
                  </>
                ) : (
                  <>
                    <button onClick={() => { setMemSearch(''); setMemOpen(true); }} className="min-w-0 text-left flex-1">
                      <div className="font-semibold text-sm truncate">{sel.name}</div>
                      <div className="text-[11px] text-white/80 truncate">{members.length ? members.map(m => m.name).filter(Boolean).slice(0, 5).join(', ') : 'tap to add members'}</div>
                    </button>
                    <button onClick={() => { setMemSearch(''); setMemOpen(true); }} className="p-1.5 rounded hover:bg-white/15" title="Members"><FiUsers size={18} /></button>
                  </>
                )}
              </div>

              <div ref={scrollRef} onScroll={onMsgScroll} className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5 relative" style={{ background: '#efeae2' }}
                onDragOver={e => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
                onDragLeave={e => { if (e.currentTarget === e.target) setDragOver(false); }}
                onDrop={onDrop}>
                {dragOver && <div className="absolute inset-0 z-10 m-2 rounded-lg border-2 border-dashed border-emerald-500 bg-emerald-500/10 flex items-center justify-center text-emerald-700 font-semibold pointer-events-none">Drop file to send</div>}
                {msgs.length === 0 && <div className="text-center text-gray-500 text-xs py-8">No messages yet — say hello 👋</div>}
                {(() => { let prevDay = null; return msgs.map(m => {
                  const own = m.sender_id === user?.id;
                  const day = fmtDate(m.created_at, DAY_OPTS);
                  const sep = day !== prevDay; prevDay = day;
                  const others = members.filter(mm => mm.user_id !== user?.id);
                  const readers = others.filter(o => (reads[o.user_id] || 0) >= m.id);
                  const allRead = others.length > 0 && readers.length === others.length;
                  return (
                    <Fragment key={m.id}>
                      {sep && <div className="flex justify-center my-1.5"><span className="text-[10px] font-medium bg-white/85 text-gray-500 px-2.5 py-0.5 rounded-full shadow-sm">{dayLabel(m.created_at)}</span></div>}
                      <div className={`flex items-end gap-1.5 ${own ? 'justify-end' : 'justify-start'}`}>
                        {!own && !sel.is_dm && <Avatar url={userAvatars[m.sender_id]} name={m.sender_name} size={26} />}
                        <div className={`group max-w-[78%] rounded-lg px-2.5 py-1.5 shadow-sm text-sm ${own ? 'bg-[#d9fdd3]' : 'bg-white'}`}>
                          {!own && <div className="text-[11px] font-semibold text-emerald-700 mb-0.5">{m.sender_name}</div>}
                          {m.attachment_url && (
                            isImg(m.attachment_url)
                              ? <a href={m.attachment_url} target="_blank" rel="noreferrer"><img src={m.attachment_url} alt={m.attachment_name || ''} className="rounded mb-1 max-h-52 object-cover" /></a>
                              : isAudio(m.attachment_url)
                                ? <audio controls src={m.attachment_url} className="mb-1 h-9 max-w-[230px]" />
                                : <a href={m.attachment_url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-blue-700 underline mb-1 break-all"><FiFile size={13} /> {m.attachment_name || 'attachment'}</a>)}
                          {m.body && <div className="whitespace-pre-wrap break-words text-gray-800">{renderBody(m.body)}</div>}
                          <div className="flex items-center justify-end gap-1.5 mt-0.5">
                            <button onClick={() => setInfoMsg(m)} className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-emerald-600" title="Message info"><FiInfo size={11} /></button>
                            {(own || isAdmin()) && <button onClick={() => delMsg(m)} className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600"><FiTrash2 size={11} /></button>}
                            <span className="text-[10px] text-gray-400" title={fmtDateTime(m.created_at)}>{fmtTime(m.created_at)}</span>
                            {own && <span title={others.length === 0 ? 'Sent' : readers.length ? `Read by: ${readers.map(r => r.name).join(', ')}` : 'Delivered · not read yet'} className={`text-[11px] leading-none ${allRead ? 'text-sky-500' : 'text-gray-400'}`}>{others.length === 0 ? '✓' : '✓✓'}</span>}
                          </div>
                        </div>
                      </div>
                    </Fragment>
                  );
                }); })()}
                <div ref={endRef} />
              </div>

              {/* min-w-0 on the textarea + flex-shrink-0 on the buttons so the
                  send / mic button never gets clipped off the right edge on a
                  narrow phone (mam 2026-06-19). */}
              <div className="border-t p-2 flex items-end gap-2 bg-gray-50 relative">
                {/* @-mention picker — floats above the composer */}
                {mention && mentionList.length > 0 && (
                  <div className="absolute bottom-full left-2 right-2 mb-1 bg-white border rounded-lg shadow-lg max-h-52 overflow-y-auto z-20">
                    <div className="px-3 py-1 text-[10px] text-gray-400 uppercase font-semibold border-b">Tag someone</div>
                    {mentionList.map(mu => (
                      <button key={mu.user_id} type="button" onMouseDown={e => { e.preventDefault(); pickMention(mu.name); }}
                        className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-emerald-50 text-sm">
                        <span className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold flex items-center justify-center flex-shrink-0">{initials(mu.name)}</span>
                        <span className="truncate">{mu.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                {recording ? (
                  <>
                    <button onClick={() => stopRec(false)} className="flex-shrink-0 p-2 text-red-500" title="Cancel"><FiTrash2 size={18} /></button>
                    <div className="flex-1 min-w-0 flex items-center gap-2 text-red-500 text-sm px-2"><span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse flex-shrink-0" /> Recording… {mmss(recTime)}</div>
                    <button onClick={() => stopRec(true)} className="flex-shrink-0 p-2.5 rounded-full text-white" style={{ background: '#25d366' }} title="Send voice"><FiSend size={16} /></button>
                  </>
                ) : (
                  <>
                    <input ref={fileRef} type="file" className="hidden" onChange={e => attach(e.target.files?.[0])} />
                    <button onClick={() => fileRef.current?.click()} disabled={busy} className="flex-shrink-0 p-2 text-gray-500 hover:text-emerald-600" title="Attach photo / file"><FiPaperclip size={18} /></button>
                    <textarea ref={taRef} className="input flex-1 min-w-0 resize-none" rows="1" placeholder="Type a message… (@ to tag)" value={text}
                      onChange={onTextChange}
                      onKeyDown={e => {
                        if (mention && mentionList.length) {
                          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionList[0].name); return; }
                          if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
                        }
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                      }} />
                    {text.trim()
                      ? <button onClick={() => send()} disabled={busy} className="flex-shrink-0 p-2.5 rounded-full text-white disabled:opacity-40" style={{ background: '#25d366' }}><FiSend size={16} /></button>
                      : <button onClick={startRec} disabled={busy} className="flex-shrink-0 p-2.5 rounded-full text-white" style={{ background: '#25d366' }} title="Record voice message"><FiMic size={16} /></button>}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── New group ─────────────────────────────────────── */}
      <Modal isOpen={newOpen} onClose={() => setNewOpen(false)} title="New group">
        <div className="space-y-3 text-sm">
          <div><label className="label">Group name *</label><input className="input" value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Hero Homes Site, Accounts Team…" autoFocus /></div>
          <div>
            <label className="label">Add members <span className="text-gray-400 font-normal normal-case">({newSel.length} selected · you're added automatically)</span></label>
            <input className="input mb-1" placeholder="Search people…" value={newSearch} onChange={e => setNewSearch(e.target.value)} />
            <div className="space-y-0.5 max-h-52 overflow-y-auto border rounded p-1">
              {allUsers.filter(u => u.id !== user?.id && (!newSearch || `${u.name} ${u.username || ''}`.toLowerCase().includes(newSearch.toLowerCase()))).map(u => {
                const on = newSel.includes(u.id);
                return (
                  <label key={u.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50 cursor-pointer">
                    <input type="checkbox" checked={on} onChange={() => setNewSel(s => on ? s.filter(x => x !== u.id) : [...s, u.id])} />
                    <span>{u.name} <span className="text-[11px] text-gray-400">@{u.username}</span></span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={createGroup} disabled={busy} className="btn btn-primary flex-1 disabled:opacity-50">{busy ? 'Creating…' : 'Create group'}</button>
            <button onClick={() => setNewOpen(false)} className="btn border">Cancel</button>
          </div>
        </div>
      </Modal>

      {/* ── New direct message ────────────────────────────── */}
      <Modal isOpen={dmOpen} onClose={() => setDmOpen(false)} title="New direct message">
        <div className="space-y-2 text-sm">
          <p className="text-xs text-gray-500">Pick a person to message directly — a private 1-on-1 chat.</p>
          <input className="input" placeholder="Search people…" value={dmSearch} onChange={e => setDmSearch(e.target.value)} autoFocus />
          <div className="space-y-0.5 max-h-72 overflow-y-auto border rounded p-1">
            {allUsers.filter(u => u.id !== user?.id && (!dmSearch || `${u.name} ${u.username || ''}`.toLowerCase().includes(dmSearch.toLowerCase()))).map(u => (
              <button key={u.id} onClick={() => startDm(u.id, u.name)} className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded hover:bg-emerald-50">
                <Avatar url={userAvatars[u.id]} name={u.name} size={28} />
                <span className="truncate">{u.name} <span className="text-[11px] text-gray-400">@{u.username}</span></span>
              </button>
            ))}
            {allUsers.filter(u => u.id !== user?.id).length === 0 && <div className="text-center text-gray-400 text-xs py-4">No other users found</div>}
          </div>
        </div>
      </Modal>

      {/* ── Members ───────────────────────────────────────── */}
      {sel && (
        <Modal isOpen={memOpen} onClose={() => setMemOpen(false)} title={`Members · ${sel.name}`}>
          <div className="space-y-3 text-sm">
            {!sel.is_dm && canCreate('site_chat') && (
              <div>
                <label className="label">Group name</label>
                <div className="flex gap-2">
                  <input className="input flex-1" value={renameVal} onChange={e => setRenameVal(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); saveRename(); } }} placeholder="Group name" />
                  <button onClick={saveRename} disabled={!renameVal.trim() || renameVal.trim() === sel.name} className="btn btn-primary disabled:opacity-40">Rename</button>
                </div>
              </div>
            )}
            <p className="text-xs text-gray-500">Only people added here can see and post in this group.</p>
            <div>
              <div className="font-semibold text-gray-700 mb-1">In this group ({members.length})</div>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {members.map(m => (
                  <div key={m.user_id} className="flex items-center justify-between bg-gray-50 rounded px-2 py-1">
                    <span className="flex items-center gap-2"><Avatar url={userAvatars[m.user_id]} name={m.name} size={24} />{m.name}</span>
                    {canCreate('site_chat') && m.user_id !== user?.id && <button onClick={() => removeMember(m.user_id)} className="text-gray-400 hover:text-red-600" title="Remove"><FiX size={14} /></button>}
                  </div>
                ))}
              </div>
            </div>
            {canCreate('site_chat') && (
              <div>
                <div className="font-semibold text-gray-700 mb-1">Add member</div>
                <input className="input mb-1" placeholder="Search people…" value={memSearch} onChange={e => setMemSearch(e.target.value)} />
                <div className="space-y-0.5 max-h-40 overflow-y-auto">
                  {allUsers.filter(u => !members.some(m => m.user_id === u.id) && (!memSearch || `${u.name} ${u.username || ''}`.toLowerCase().includes(memSearch.toLowerCase()))).map(u => (
                    <div key={u.id} className="flex items-center justify-between px-2 py-1 border-b">
                      <span>{u.name} <span className="text-[11px] text-gray-400">@{u.username}</span></span>
                      <button onClick={() => addMember(u.id)} className="text-xs font-semibold text-emerald-700 hover:bg-emerald-50 rounded px-2 py-0.5">+ Add</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {canDelete('site_chat') && <button onClick={delGroup} className="text-xs text-red-600 font-semibold flex items-center gap-1.5 pt-1"><FiTrash2 size={13} /> Delete group</button>}
          </div>
        </Modal>
      )}

      {/* ── Message info (read / delivered) ────────────────── */}
      {infoMsg && (() => {
        const m = infoMsg;
        const others = members.filter(mm => mm.user_id !== m.sender_id);
        const readBy = others.filter(o => (reads[o.user_id] || 0) >= m.id);
        const delivered = others.filter(o => (reads[o.user_id] || 0) < m.id);
        const Row = ({ o, time, tone }) => (
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2"><span className={`w-6 h-6 rounded-full text-[10px] font-bold flex items-center justify-center ${tone}`}>{initials(o.name)}</span>{o.name}</span>
            {time && <span className="text-[11px] text-gray-400">{fmtDateTime(time)}</span>}
          </div>
        );
        return (
          <Modal isOpen={!!infoMsg} onClose={() => setInfoMsg(null)} title="Message info">
            <div className="space-y-3 text-sm">
              <div className="rounded-lg bg-[#d9fdd3] px-3 py-2">
                {m.attachment_name && <div className="text-xs text-gray-600 mb-0.5">📎 {m.attachment_name}</div>}
                {m.body && <div className="whitespace-pre-wrap break-words text-gray-800">{m.body}</div>}
                <div className="text-[10px] text-gray-500 mt-1">{m.sender_name} · {fmtDateTime(m.created_at)}</div>
              </div>
              <div>
                <div className="font-semibold text-sky-600 mb-1">✓✓ Read by ({readBy.length})</div>
                {readBy.length === 0 ? <div className="text-xs text-gray-400">No one yet</div>
                  : <div className="space-y-1">{readBy.map(o => <Row key={o.user_id} o={o} time={readsAt[o.user_id]} tone="bg-sky-100 text-sky-700" />)}</div>}
              </div>
              <div>
                <div className="font-semibold text-gray-500 mb-1">✓✓ Delivered to ({delivered.length})</div>
                {delivered.length === 0 ? <div className="text-xs text-gray-400">—</div>
                  : <div className="space-y-1">{delivered.map(o => <Row key={o.user_id} o={o} tone="bg-gray-100 text-gray-600" />)}</div>}
              </div>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}
