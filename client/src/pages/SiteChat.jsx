// "WhatsApp" — internal group chat, WhatsApp-styled (mam 2026-06-18). Create
// named groups, add the people you want, chat (text + photo/file). Members-
// gated, read receipts (✓✓ + who-read), unread badges, day separators.
import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import { io } from 'socket.io-client';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtTime, fmtDate, fmtDateTime } from '../utils/datetime';
import { FiSearch, FiSend, FiPaperclip, FiTrash2, FiFile, FiUsers, FiX, FiPlus, FiMic, FiUserPlus } from 'react-icons/fi';
import { FaWhatsapp } from 'react-icons/fa';

const DAY_OPTS = { day: '2-digit', month: 'short', year: 'numeric' };
const GREEN = '#075e54';                          // WhatsApp header green
const isImg = (u) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(String(u || ''));
const isAudio = (u) => /\.(webm|ogg|mp3|m4a|wav|aac|opus)$/i.test(String(u || ''));
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const preview = (m) => (m ? (m.body || (m.attachment_name ? `📎 ${m.attachment_name}` : '')) : '');
const initials = (s) => String(s || '?').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 2).toUpperCase() || '#';

export default function SiteChat() {
  const { canCreate, canDelete, isAdmin, user } = useAuth();
  const [groups, setGroups] = useState([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);            // selected group {id, name}
  const [msgs, setMsgs] = useState([]);
  const [members, setMembers] = useState([]);
  const [reads, setReads] = useState({});
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
  const endRef = useRef(null);
  const socketRef = useRef(null);
  const mediaRef = useRef(null);
  const chunksRef = useRef([]);
  const recTimerRef = useRef(null);

  const loadGroups = useCallback(() => { api.get('/site-chat/groups').then(r => setGroups(r.data || [])).catch(() => {}); }, []);
  const loadThread = useCallback((id) => {
    if (!id) return;
    api.get(`/site-chat/${id}`).then(r => {
      setMsgs(r.data.messages || []); setMembers(r.data.members || []); setReads(r.data.reads || {});
      if (r.data.group) setSel(s => (s && s.id === id ? { ...s, name: r.data.group.name, is_dm: r.data.group.is_dm } : s));
      loadGroups();
    }).catch(() => {});
  }, [loadGroups]);

  useEffect(() => { loadGroups(); api.get('/auth/users').then(r => setAllUsers((r.data || []).filter(u => u.active !== 0))).catch(() => {}); }, [loadGroups]);
  // Real-time: one Socket.IO connection; the server pushes a 'changed' event
  // to each group's room on any message/read/member change. Polling stays as
  // a fallback if the socket can't connect.
  useEffect(() => {
    const socket = io({ path: '/socket.io', auth: { token: localStorage.getItem('token') }, transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    socket.on('changed', ({ groupId }) => { setSel(s => { if (s && s.id === groupId) loadThread(s.id); return s; }); loadGroups(); });
    socket.on('group_deleted', ({ groupId }) => { loadGroups(); setSel(s => (s && s.id === groupId ? null : s)); });
    return () => { socket.disconnect(); socketRef.current = null; };
  }, [loadThread, loadGroups]);
  useEffect(() => {
    if (!sel) return;
    socketRef.current?.emit('join', sel.id);
    loadThread(sel.id);
    const t = setInterval(() => loadThread(sel.id), 15000);   // fallback poll
    const onFocus = () => loadThread(sel.id);
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [sel?.id, loadThread]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs]);
  useEffect(() => { if (memOpen && sel) setRenameVal(sel.name || ''); }, [memOpen, sel?.id]);

  const todayLbl = fmtDate(new Date(), DAY_OPTS);
  const yestLbl = fmtDate(new Date(Date.now() - 864e5), DAY_OPTS);
  const dayLabel = (ts) => { const l = fmtDate(ts, DAY_OPTS); return l === todayLbl ? 'Today' : l === yestLbl ? 'Yesterday' : l; };

  const send = async (extra = {}) => {
    if (!sel) return;
    const payload = { body: text, ...extra };
    if (!payload.body?.trim() && !payload.attachment_url) return;
    setBusy(true);
    try { await api.post(`/site-chat/${sel.id}`, payload); setText(''); setMention(null); loadThread(sel.id); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed to send'); }
    finally { setBusy(false); }
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
    try {
      const r = await api.post('/site-chat/groups', { name: newName.trim(), member_ids: newSel });
      setNewOpen(false); setNewName(''); setNewSel([]); setNewSearch('');
      loadGroups(); setSel({ id: r.data.id, name: r.data.name });
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to create group'); }
  };
  const delGroup = async () => {
    if (!sel || !confirm(`Delete the group "${sel.name}" and all its messages?`)) return;
    try { await api.delete(`/site-chat/${sel.id}`); setSel(null); setMemOpen(false); loadGroups(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const shown = groups.filter(g => !q || String(g.name).toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2"><FaWhatsapp className="text-[#25d366]" /> WhatsApp</h1>
        {/* Subtitle hidden on mobile to give the chat more vertical room. */}
        <p className="hidden sm:block text-sm text-gray-500">Internal group chat · create groups · add your people · text + photos/files</p>
      </div>

      {/* 100dvh (dynamic viewport height) — NOT 100vh — so the composer / mic
          button stays visible above the phone browser's bottom toolbar
          (mam 2026-06-19: "below button not show" on mobile). */}
      <div className="flex border rounded-xl overflow-hidden bg-white" style={{ height: 'calc(100dvh - 185px)', minHeight: 360 }}>
        {/* ── Group list ────────────────────────────────── */}
        <div className={`w-full sm:w-80 border-r flex flex-col ${sel ? 'hidden sm:flex' : 'flex'}`}>
          <div className="flex items-center gap-2 px-3 py-2 text-white" style={{ background: GREEN }}>
            <FaWhatsapp /> <span className="font-semibold text-sm flex-1">WhatsApp</span>
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
                <div className="w-9 h-9 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold text-xs flex-shrink-0">{initials(g.name)}</div>
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
                <button onClick={() => setSel(null)} className="sm:hidden mr-1">←</button>
                <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center font-bold text-xs">{initials(sel.name)}</div>
                {sel.is_dm ? (
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-sm truncate">{sel.name}</div>
                    <div className="text-[11px] text-white/80 truncate">Direct message</div>
                  </div>
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

              <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5 relative" style={{ background: '#efeae2' }}
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
                      <div className={`flex ${own ? 'justify-end' : 'justify-start'}`}>
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
            <button onClick={createGroup} className="btn btn-primary flex-1">Create group</button>
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
                <span className="w-7 h-7 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold flex items-center justify-center flex-shrink-0">{initials(u.name)}</span>
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
                    <span className="flex items-center gap-2"><span className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold flex items-center justify-center">{initials(m.name)}</span>{m.name}</span>
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
    </div>
  );
}
