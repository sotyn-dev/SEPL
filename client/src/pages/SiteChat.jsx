// Site Chat — an internal, WhatsApp-style message thread per site (mam
// 2026-06-18). Left: site list with last-message preview. Right: the thread
// (own messages right/green, others left/white) + a composer with text and
// photo/file attachments. Team-only; everything stored in the ERP.
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtTime, fmtDateTime } from '../utils/datetime';
import { FiSearch, FiSend, FiPaperclip, FiTrash2, FiMessageSquare, FiFile } from 'react-icons/fi';

const isImg = (u) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(String(u || ''));
const preview = (m) => (m ? (m.body || (m.attachment_name ? `📎 ${m.attachment_name}` : '')) : '');

export default function SiteChat() {
  const { canCreate, canDelete, isAdmin, user } = useAuth();
  const [sites, setSites] = useState([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);          // selected site {id, name, ...}
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const endRef = useRef(null);

  const loadSites = useCallback(() => { api.get('/site-chat/sites').then(r => setSites(r.data || [])).catch(() => {}); }, []);
  const loadMsgs = useCallback((id) => { if (id) api.get(`/site-chat/${id}`).then(r => setMsgs(r.data || [])).catch(() => {}); }, []);

  useEffect(() => { loadSites(); }, [loadSites]);
  // Load + light polling for the open thread (refresh on window focus too).
  useEffect(() => {
    if (!sel) return;
    loadMsgs(sel.id);
    const t = setInterval(() => loadMsgs(sel.id), 8000);
    const onFocus = () => loadMsgs(sel.id);
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [sel, loadMsgs]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs]);

  const send = async (extra = {}) => {
    if (!sel) return;
    const payload = { body: text, ...extra };
    if (!payload.body?.trim() && !payload.attachment_url) return;
    setBusy(true);
    try {
      await api.post(`/site-chat/${sel.id}`, payload);
      setText('');
      loadMsgs(sel.id); loadSites();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to send'); }
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

  const del = async (m) => {
    if (!confirm('Delete this message?')) return;
    try { await api.delete(`/site-chat/${m.id}`); loadMsgs(sel.id); loadSites(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const shown = sites.filter(s => !q || `${s.name} ${s.client_name || ''}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><FiMessageSquare className="text-emerald-600" /> Site Chat</h1>
        <p className="text-sm text-gray-500">A message thread per site · team-only · text + photos/files</p>
      </div>

      <div className="flex border rounded-xl overflow-hidden bg-white" style={{ height: 'calc(100vh - 210px)', minHeight: 420 }}>
        {/* ── Chat list ─────────────────────────────────── */}
        <div className={`w-full sm:w-80 border-r flex flex-col ${sel ? 'hidden sm:flex' : 'flex'}`}>
          <div className="p-2 border-b">
            <div className="relative">
              <FiSearch className="absolute left-2.5 top-2.5 text-gray-400" size={14} />
              <input className="input pl-8" placeholder="Search site…" value={q} onChange={e => setQ(e.target.value)} />
            </div>
          </div>
          <div className="overflow-y-auto flex-1">
            {shown.length === 0 && <div className="text-center text-gray-400 text-sm py-8">No sites.</div>}
            {shown.map(s => (
              <button key={s.id} onClick={() => setSel(s)}
                className={`w-full text-left px-3 py-2.5 border-b flex items-start gap-2 hover:bg-gray-50 ${sel?.id === s.id ? 'bg-emerald-50' : ''}`}>
                <div className="w-9 h-9 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold text-xs flex-shrink-0">
                  {String(s.name || '?').slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex justify-between items-baseline gap-2">
                    <span className="font-semibold text-sm text-gray-800 truncate">{s.name}</span>
                    {s.last && <span className="text-[10px] text-gray-400 flex-shrink-0">{fmtTime(s.last.created_at)}</span>}
                  </div>
                  <div className="text-xs text-gray-500 truncate">{s.last ? preview(s.last) : <span className="italic text-gray-300">No messages yet</span>}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* ── Thread ────────────────────────────────────── */}
        <div className={`flex-1 flex-col ${sel ? 'flex' : 'hidden sm:flex'}`}>
          {!sel ? (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-400 gap-2">
              <FiMessageSquare size={40} /><span className="text-sm">Pick a site to open its chat</span>
            </div>
          ) : (
            <>
              <div className="px-4 py-2.5 border-b flex items-center gap-2 bg-gray-50">
                <button onClick={() => setSel(null)} className="sm:hidden text-gray-500 mr-1">←</button>
                <div className="w-9 h-9 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold text-xs">{String(sel.name || '?').slice(0, 2).toUpperCase()}</div>
                <div className="min-w-0">
                  <div className="font-semibold text-sm text-gray-800 truncate">{sel.name}</div>
                  <div className="text-[11px] text-gray-500 truncate">{sel.client_name || ''}{sel.status ? ` · ${sel.status}` : ''}</div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5" style={{ background: '#efeae2' }}>
                {msgs.length === 0 && <div className="text-center text-gray-500 text-xs py-8">No messages yet — say something about this site.</div>}
                {msgs.map(m => {
                  const own = m.sender_id === user?.id;
                  return (
                    <div key={m.id} className={`flex ${own ? 'justify-end' : 'justify-start'}`}>
                      <div className={`group max-w-[78%] rounded-lg px-2.5 py-1.5 shadow-sm text-sm ${own ? 'bg-[#d9fdd3]' : 'bg-white'}`}>
                        {!own && <div className="text-[11px] font-semibold text-emerald-700 mb-0.5">{m.sender_name}</div>}
                        {m.attachment_url && (isImg(m.attachment_url)
                          ? <a href={m.attachment_url} target="_blank" rel="noreferrer"><img src={m.attachment_url} alt={m.attachment_name || ''} className="rounded mb-1 max-h-52 object-cover" /></a>
                          : <a href={m.attachment_url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-blue-700 underline mb-1 break-all"><FiFile size={13} /> {m.attachment_name || 'attachment'}</a>)}
                        {m.body && <div className="whitespace-pre-wrap break-words text-gray-800">{m.body}</div>}
                        <div className="flex items-center justify-end gap-1.5 mt-0.5">
                          {(own || isAdmin()) && canDelete('site_chat') && <button onClick={() => del(m)} className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600"><FiTrash2 size={11} /></button>}
                          <span className="text-[10px] text-gray-400" title={fmtDateTime(m.created_at)}>{fmtTime(m.created_at)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={endRef} />
              </div>

              {canCreate('site_chat') && (
                <div className="border-t p-2 flex items-end gap-2 bg-gray-50">
                  <input ref={fileRef} type="file" className="hidden" onChange={e => attach(e.target.files?.[0])} />
                  <button onClick={() => fileRef.current?.click()} disabled={busy} className="p-2 text-gray-500 hover:text-emerald-600" title="Attach photo / file"><FiPaperclip size={18} /></button>
                  <textarea className="input flex-1 resize-none" rows="1" placeholder="Type a message…" value={text}
                    onChange={e => setText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
                  <button onClick={() => send()} disabled={busy || !text.trim()} className="p-2.5 rounded-full bg-emerald-600 text-white disabled:opacity-40"><FiSend size={16} /></button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
