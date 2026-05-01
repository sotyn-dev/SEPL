import { useState, useEffect, useRef } from 'react';
import { FiBell, FiPlus, FiX, FiTrash2, FiBookmark, FiEdit2, FiEye, FiChevronDown } from 'react-icons/fi';
import api from '../api';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';

// Bell icon for the header. Shows an unread-count badge that polls every
// 60 seconds. Clicking opens a dropdown panel listing all announcements
// (pinned first), highlighting any posted since this user's last visit.
// Admins also see a small "+ New" button inside the panel to post directly.
export default function AnnouncementBell() {
  const { isAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', pinned: false, expires_at: '' });
  const [editing, setEditing] = useState(null);
  // Per-announcement reader drill-down (admin only). Map of id → readers data.
  const [readers, setReaders] = useState({}); // { [annId]: { read_count, unread_count, readers, non_readers } }
  const [expandedReaders, setExpandedReaders] = useState(null); // id of announcement currently expanded
  const ref = useRef(null);

  const loadCount = () => {
    api.get('/announcements/unread-count').then(r => setUnread(r.data?.count || 0)).catch(() => {});
  };
  const loadItems = () => {
    api.get('/announcements').then(r => setItems(r.data || [])).catch(() => setItems([]));
  };

  // Poll the unread count every 60s so the bell badge stays current even
  // when the user keeps the same tab open all day.
  useEffect(() => {
    loadCount();
    const t = setInterval(loadCount, 60000);
    return () => clearInterval(t);
  }, []);

  // Click outside the panel closes it. Loaded once per mount.
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const onOpen = async () => {
    setOpen(true);
    loadItems();
    // Mark as seen — clears the badge once the panel opens.
    try { await api.post('/announcements/mark-seen'); setUnread(0); } catch {}
  };

  const submitNew = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) return toast.error('Title required');
    try {
      if (editing) {
        await api.put(`/announcements/${editing.id}`, form);
        toast.success('Announcement updated');
      } else {
        await api.post('/announcements', form);
        toast.success('Announcement posted');
      }
      setForm({ title: '', body: '', pinned: false, expires_at: '' });
      setAdding(false);
      setEditing(null);
      loadItems();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const remove = async (id) => {
    if (!confirm('Delete this announcement?')) return;
    try { await api.delete(`/announcements/${id}`); toast.success('Deleted'); loadItems(); }
    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
  };

  const startEdit = (a) => {
    setEditing(a);
    setForm({
      title: a.title || '',
      body: a.body || '',
      pinned: !!a.pinned,
      expires_at: a.expires_at ? a.expires_at.slice(0, 16) : '',
    });
    setAdding(true);
  };

  const fmt = (s) => {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ' · ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  };

  // Lazy-load the reader breakdown for one announcement when admin clicks
  // the "👁 N read" pill. Cache so flipping back & forth is instant.
  const toggleReaders = async (annId) => {
    if (expandedReaders === annId) { setExpandedReaders(null); return; }
    setExpandedReaders(annId);
    if (!readers[annId]) {
      try {
        const { data } = await api.get(`/announcements/${annId}/readers`);
        setReaders(prev => ({ ...prev, [annId]: data }));
      } catch (err) {
        toast.error(err.response?.data?.error || 'Failed to load readers');
      }
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => open ? setOpen(false) : onOpen()}
        className="relative p-2 hover:bg-gray-100 rounded-lg flex-shrink-0"
        title="Announcements"
      >
        <FiBell size={20} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-red-600 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-[92vw] sm:w-[420px] max-h-[80vh] bg-white border border-gray-200 rounded-lg shadow-xl z-50 flex flex-col">
          <div className="px-3 py-2 border-b flex items-center justify-between bg-gradient-to-r from-blue-50 to-blue-100">
            <h4 className="font-semibold text-sm flex items-center gap-1.5"><FiBell size={14} /> Announcements</h4>
            <div className="flex items-center gap-1">
              {isAdmin() && !adding && (
                <button onClick={() => { setEditing(null); setForm({ title: '', body: '', pinned: false, expires_at: '' }); setAdding(true); }} className="text-[11px] font-semibold text-blue-700 hover:bg-white px-2 py-1 rounded flex items-center gap-1">
                  <FiPlus size={11} /> New
                </button>
              )}
              <button onClick={() => setOpen(false)} className="p-1 hover:bg-white rounded"><FiX size={14} /></button>
            </div>
          </div>

          {adding && isAdmin() && (
            <form onSubmit={submitNew} className="border-b bg-gray-50/60 p-3 space-y-2">
              <input
                className="input text-sm"
                placeholder="Title (e.g. Office holiday on May 1)"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                required
              />
              <textarea
                className="input text-sm"
                rows="3"
                placeholder="Details (optional)"
                value={form.body}
                onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
              />
              <div className="grid grid-cols-2 gap-2">
                <label className="flex items-center gap-1.5 text-[11px] text-gray-600">
                  <input type="checkbox" checked={!!form.pinned} onChange={e => setForm(f => ({ ...f, pinned: e.target.checked }))} />
                  Pin to top
                </label>
                <input
                  type="datetime-local"
                  className="input text-[11px] py-1"
                  title="Auto-hide after this date (optional)"
                  value={form.expires_at}
                  onChange={e => setForm(f => ({ ...f, expires_at: e.target.value }))}
                />
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => { setAdding(false); setEditing(null); }} className="text-[11px] text-gray-500 hover:text-gray-700 px-2 py-1">Cancel</button>
                <button type="submit" className="btn btn-primary text-[11px] py-1 px-3">{editing ? 'Update' : 'Post'}</button>
              </div>
            </form>
          )}

          <div className="flex-1 overflow-y-auto">
            {items.length === 0 && (
              <div className="text-center text-gray-400 text-sm py-8 px-4">
                No announcements yet.{isAdmin() && ' Click "+ New" to post the first one.'}
              </div>
            )}
            {items.map(a => (
              <div key={a.id} className={`px-3 py-2.5 border-b ${a.is_new ? 'bg-blue-50/50' : 'hover:bg-gray-50'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {!!a.pinned && <FiBookmark size={11} className="text-amber-500 flex-shrink-0 fill-amber-500" title="Pinned" />}
                      <span className="font-semibold text-sm text-gray-800">{a.title}</span>
                      {!!a.is_new && <span className="text-[9px] font-bold uppercase bg-red-100 text-red-700 px-1.5 py-0.5 rounded">NEW</span>}
                    </div>
                    {a.body && <p className="text-[12px] text-gray-600 mt-1 whitespace-pre-wrap">{a.body}</p>}
                    <div className="text-[10px] text-gray-400 mt-1 flex flex-wrap items-center gap-2">
                      <span>{a.created_by_name || 'Admin'} · {fmt(a.created_at)}</span>
                      {a.expires_at && <span>· expires {fmt(a.expires_at)}</span>}
                      {/* Read tracker — admin only. Shows N of M read.
                          Coloured green when everyone read it, amber otherwise.
                          Click expands a small list of who has / hasn't read. */}
                      {isAdmin() && a.total_users > 0 && (
                        <button
                          onClick={() => toggleReaders(a.id)}
                          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium ${
                            a.read_count >= a.total_users
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                              : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                          }`}
                          title="Click to see who read"
                        >
                          <FiEye size={10} /> {a.read_count} of {a.total_users} read
                          <FiChevronDown size={10} className={`transition-transform ${expandedReaders === a.id ? 'rotate-180' : ''}`} />
                        </button>
                      )}
                    </div>

                    {/* Reader drill-down — only rendered when expanded.
                        Shows two lists: ✓ who has read (with timestamp) and
                        ✗ who hasn't yet, so admin can chase up the laggards. */}
                    {isAdmin() && expandedReaders === a.id && (
                      <div className="mt-2 border-t pt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                        <div>
                          <div className="font-bold text-emerald-700 mb-1">✓ Read ({readers[a.id]?.read_count || 0})</div>
                          {readers[a.id]?.readers?.length ? (
                            <ul className="space-y-0.5 max-h-32 overflow-y-auto">
                              {readers[a.id].readers.map(u => (
                                <li key={u.id} className="text-gray-700">
                                  {u.name} <span className="text-gray-400 text-[9px]">· {fmt(u.seen_at)}</span>
                                </li>
                              ))}
                            </ul>
                          ) : <div className="text-gray-400 italic">Nobody yet</div>}
                        </div>
                        <div>
                          <div className="font-bold text-red-700 mb-1">✗ Not yet ({readers[a.id]?.unread_count || 0})</div>
                          {readers[a.id]?.non_readers?.length ? (
                            <ul className="space-y-0.5 max-h-32 overflow-y-auto">
                              {readers[a.id].non_readers.map(u => (
                                <li key={u.id} className="text-gray-700">{u.name}</li>
                              ))}
                            </ul>
                          ) : <div className="text-emerald-600 italic">Everyone read! 🎉</div>}
                        </div>
                      </div>
                    )}
                  </div>
                  {isAdmin() && (
                    <div className="flex flex-col gap-1 flex-shrink-0">
                      <button onClick={() => startEdit(a)} className="p-1 text-gray-400 hover:text-blue-600" title="Edit"><FiEdit2 size={12} /></button>
                      <button onClick={() => remove(a.id)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={12} /></button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
