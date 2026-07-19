// SOTYN Flow — Trello-style task boards. Full-width, one screen at a time:
//   /sotyn-flow            → boards list (responsive grid)
//   /sotyn-flow/:boardId   → single board (columns fill the width)
// Own DB (sotynflow.db) + shared Socket.IO (flow:* events). Blue SOTYN palette.
import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { io } from 'socket.io-client';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { getToken } from '../lib/tokenStore';
import {
  FiPlus, FiSearch, FiX, FiTrash2, FiArrowLeft, FiChevronDown, FiUsers,
  FiPaperclip, FiMoreHorizontal, FiCalendar, FiTag, FiCheckSquare, FiFile,
  FiEdit2, FiSettings, FiTrello, FiCheck, FiMessageSquare, FiImage,
} from 'react-icons/fi';

const NAVY = '#1e3a8a';
const BLUE = '#2563eb';
// Board canvas background — pattern #1 (dot grid). Kept here as the single
// swappable const so options #2–#5 can drop in without hunting.
const CANVAS_BG = { backgroundColor: '#f4f6fb', backgroundImage: 'radial-gradient(#cdd9f0 1.4px, transparent 1.4px)', backgroundSize: '18px 18px' };
const LABEL_COLORS = ['#2563eb', '#16a34a', '#dc2626', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];
// Fixed priority set — one radio choice per card. These 4 ids are VIRTUAL board
// labels the server injects on read (see sotynFlow.js), so they always resolve.
const PRIORITY_LABELS = [
  { id: 'p:urgent', name: 'Urgent', color: '#dc2626' },
  { id: 'p:high', name: 'High', color: '#ea580c' },
  { id: 'p:medium', name: 'Medium', color: '#d97706' },
  { id: 'p:low', name: 'Low', color: '#6b7280' },
];
const isPriorityId = (id) => typeof id === 'string' && id.startsWith('p:');
const CUSTOM_MAX = 3, CUSTOM_LEN = 16;   // board custom-label palette caps (match server)

const initials = (s) => String(s || '?').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 2).toUpperCase() || '#';
// Distinct per-person avatar colours — a stable [bg, text] pair hashed from the
// name so each member reads as their own colour (multicoloured avatar stacks).
const AV_COLORS = [
  ['#dbeafe', '#1d4ed8'], ['#dcfce7', '#15803d'], ['#fee2e2', '#b91c1c'], ['#fef3c7', '#b45309'],
  ['#f3e8ff', '#7c3aed'], ['#cffafe', '#0e7490'], ['#fce7f3', '#be185d'], ['#ecfccb', '#4d7c0f'],
  ['#ffedd5', '#c2410c'], ['#e0e7ff', '#4338ca'], ['#d1fae5', '#047857'], ['#fae8ff', '#a21caf'],
];
const hashStr = (s) => { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
const avColor = (key) => AV_COLORS[hashStr(key) % AV_COLORS.length];
function Avatar({ url, name, size = 26, className = '' }) {
  const st = { width: size, height: size };
  if (url) return <img src={url} alt={name || ''} className={`rounded-full object-cover flex-shrink-0 ${className}`} style={st} />;
  const [bg, fg] = avColor(name);
  return <span className={`rounded-full font-bold flex items-center justify-center flex-shrink-0 ${className}`} style={{ ...st, background: bg, color: fg, fontSize: Math.round(size * 0.36) }}>{initials(name)}</span>;
}
const AvatarStack = ({ people = [], avatars = {}, size = 22 }) => (
  <div className="flex items-center">
    {people.slice(0, 4).map((p, i) => (
      <span key={p.user_id ?? i} style={{ marginLeft: i ? -6 : 0, zIndex: 10 - i }} className="ring-2 ring-white rounded-full">
        <Avatar url={avatars[p.user_id]} name={p.name} size={size} />
      </span>
    ))}
    {people.length > 4 && <span className="text-[10px] text-gray-500 ml-1">+{people.length - 4}</span>}
  </div>
);

const fmtDue = (d) => { try { return new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: '2-digit', month: 'short' }); } catch { return d; } };
const dueMeta = (due, completed) => {
  if (!due) return null;
  const d = new Date(due + 'T00:00:00'); const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  const label = fmtDue(due);
  if (completed) return { cls: 'bg-green-100 text-green-700', label };
  if (diff < 0) return { cls: 'bg-red-100 text-red-700', label };
  if (diff <= 2) return { cls: 'bg-amber-100 text-amber-700', label };
  return { cls: 'bg-gray-100 text-gray-600', label };
};
const relTime = (ts) => {
  try {
    const d = new Date(ts.includes('T') || ts.includes('Z') ? ts : ts.replace(' ', 'T') + 'Z');
    const s = Math.round((Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return ts; }
};
const isImg = (u) => /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif)$/i.test(String(u || ''));
const uid = () => Math.random().toString(36).slice(2, 9);

// Attachment photo that degrades gracefully (mirrors SiteChat's ChatImage): a
// broken/missing upload or an iPhone HEIC/HEIF that non-Safari can't decode would
// otherwise render a blank box — on error we swap to a clear tap-to-open link.
function CardImage({ url, name }) {
  const [failed, setFailed] = useState(false);
  if (failed) return (
    <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-blue-700 underline mt-1 break-all"><FiImage size={13} /> {name || 'Photo'} — tap to open</a>
  );
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt={name || ''} loading="lazy" decoding="async" onError={() => setFailed(true)}
        className="mt-1 max-h-52 max-w-full rounded object-cover bg-gray-100" />
    </a>
  );
}

async function uploadFile(file) {
  const fd = new FormData(); fd.append('file', file);
  const r = await api.post('/upload?folder=sotyn-flow', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
  return r.data; // { url, filename, size }
}

/* ══════════════════════════════════════════════════════════════════════════
   Card modal — Trello-style. Fetches its own detail (comments + activity) and
   re-fetches when `refreshKey` bumps (a flow:changed on the parent board).
   ══════════════════════════════════════════════════════════════════════════ */
function CardModal({ boardId, cardId, board, members, avatars, canManage, user, refreshKey, onClose, onChanged }) {
  const [card, setCard] = useState(null);
  const [comments, setComments] = useState([]);
  const [activity, setActivity] = useState([]);
  const [tab, setTab] = useState('main');        // mobile tab: 'main' | 'comments'
  const [showDetails, setShowDetails] = useState(true);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(null);  // 'members'|'labels'|'due'
  const [memberQuery, setMemberQuery] = useState('');  // filter for the assignee picker
  // Staged-then-Apply drafts for the Members / Labels / Dates popovers.
  const [selMembers, setSelMembers] = useState([]);
  const [draftLabels, setDraftLabels] = useState([]);
  const [selLabels, setSelLabels] = useState([]);
  const [plainName, setPlainName] = useState('');
  const [draftDue, setDraftDue] = useState('');
  const [applying, setApplying] = useState(false);
  const fileRef = useRef(null);
  const boardLabels = board?.labels || [];

  const load = useCallback(() => {
    api.get(`/sotyn-flow/${boardId}/cards/${cardId}`).then(r => {
      setCard(r.data.card); setComments(r.data.comments || []); setActivity(r.data.activity || []);
      setTitle(r.data.card.title); setDesc(r.data.card.description || '');
    }).catch(e => { toast.error(e.response?.data?.error || 'Card not found'); onClose(); });
    // `onClose` is intentionally NOT a dep: the parent recreates it on every
    // render, so keeping load stable stops the card from re-fetching on every
    // board tick and clobbering in-progress title/description edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, cardId]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const patch = async (body) => {
    try { const r = await api.put(`/sotyn-flow/${boardId}/cards/${cardId}`, body); setCard(r.data); onChanged?.(); load(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  const saveTitle = () => { const t = title.trim(); if (t && t !== card.title) patch({ title: t }); };
  const saveDesc = () => { if ((desc || '') !== (card.description || '')) patch({ description: desc }); };
  const toggleComplete = () => patch({ completed: card.completed ? 0 : 1 });
  const closeMenu = () => setMenuOpen(null);
  // Open handlers seed each popover's draft from the card's current state, so
  // nothing commits until Apply (click-away / Cancel discards).
  const openMembers = () => { setSelMembers((card.members || []).map(m => m.user_id)); setMemberQuery(''); setMenuOpen(menuOpen === 'members' ? null : 'members'); };
  const openLabels = () => { setDraftLabels(boardLabels.filter(l => !isPriorityId(l.id)).map(l => ({ ...l }))); setSelLabels([...(card.label_ids || [])]); setPlainName(''); setMenuOpen(menuOpen === 'labels' ? null : 'labels'); };
  const openDue = () => { setDraftDue(card.due_date || ''); setMenuOpen(menuOpen === 'due' ? null : 'due'); };

  // Members — commit the add/remove diff, then close.
  const applyMembers = async () => {
    const cur = (card.members || []).map(m => m.user_id);
    const toAdd = selMembers.filter(id => !cur.includes(id));
    const toRemove = cur.filter(id => !selMembers.includes(id));
    setApplying(true);
    try {
      if (toAdd.length) await api.post(`/sotyn-flow/${boardId}/cards/${cardId}/members`, { user_ids: toAdd });
      for (const id of toRemove) await api.delete(`/sotyn-flow/${boardId}/cards/${cardId}/members/${id}`);
      onChanged?.(); load(); closeMenu();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); } finally { setApplying(false); }
  };

  // Labels — one priority (radio, always available) + up to CUSTOM_MAX board
  // custom labels (plain, board-admin manages the palette).
  const selCustomCount = selLabels.filter(id => !isPriorityId(id)).length;
  const setPriority = (id) => setSelLabels(s => {
    const rest = s.filter(x => !isPriorityId(x));
    return s.includes(id) ? rest : [id, ...rest];   // click the selected one → clear
  });
  const toggleSelLabel = (id) => setSelLabels(s => {
    if (s.includes(id)) return s.filter(x => x !== id);
    if (s.filter(x => !isPriorityId(x)).length >= CUSTOM_MAX) return s;   // cap customs per card
    return [...s, id];
  });
  const removeDraftLabel = (id) => { setDraftLabels(d => d.filter(l => l.id !== id)); setSelLabels(s => s.filter(x => x !== id)); };
  const addPlain = () => {
    const n = plainName.trim().slice(0, CUSTOM_LEN); if (!n) return;
    if (draftLabels.length >= CUSTOM_MAX) return;
    const nl = { id: uid(), name: n, color: null };
    setDraftLabels(d => [...d, nl]);
    setSelLabels(s => (s.filter(x => !isPriorityId(x)).length >= CUSTOM_MAX ? s : [...s, nl.id]));
    setPlainName('');
  };
  const applyLabels = async () => {
    setApplying(true);
    try {
      const prevCustoms = boardLabels.filter(l => !isPriorityId(l.id));
      if (canManage && JSON.stringify(draftLabels) !== JSON.stringify(prevCustoms))
        await api.put(`/sotyn-flow/${boardId}`, { labels: draftLabels });
      const valid = new Set([...PRIORITY_LABELS.map(p => p.id), ...draftLabels.map(l => l.id)]);
      await patch({ label_ids: selLabels.filter(id => valid.has(id)) });
      closeMenu();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); } finally { setApplying(false); }
  };

  // Dates — commit the drafted due date, then close.
  const applyDue = async () => { setApplying(true); try { await patch({ due_date: draftDue || null }); closeMenu(); } finally { setApplying(false); } };

  // Checklist (JSON) ----------------------------------------------------------
  const checklist = card?.checklist || [];
  const [newItem, setNewItem] = useState('');
  const saveChecklist = (list) => patch({ checklist: list });
  const addItem = () => { const t = newItem.trim(); if (!t) return; saveChecklist([...checklist, { id: uid(), text: t, done: false }]); setNewItem(''); };
  const toggleItem = (id) => saveChecklist(checklist.map(i => i.id === id ? { ...i, done: !i.done } : i));
  const removeItem = (id) => saveChecklist(checklist.filter(i => i.id !== id));
  const doneCount = checklist.filter(i => i.done).length;

  // Comments ------------------------------------------------------------------
  const sendComment = async (attachment) => {
    const body = comment.trim();
    if (!body && !attachment) return;
    setBusy(true);
    try {
      await api.post(`/sotyn-flow/${boardId}/cards/${cardId}/comments`, { body: body || undefined, attachment_url: attachment?.url, attachment_name: attachment?.filename });
      setComment(''); load(); onChanged?.();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); } finally { setBusy(false); }
  };
  const onFile = async (e) => {
    const f = e.target.files?.[0]; if (!f) return; e.target.value = '';
    setBusy(true);
    try { const up = await uploadFile(f); await sendComment(up); } catch { toast.error('Upload failed'); } finally { setBusy(false); }
  };
  const delComment = (id) => api.delete(`/sotyn-flow/${boardId}/cards/${cardId}/comments/${id}`).then(() => { load(); onChanged?.(); });

  // Merged, most-recent-first feed of comments + (optional) activity ----------
  const feed = useMemo(() => {
    const items = comments.map(c => ({ kind: 'comment', ...c }));
    if (showDetails) items.push(...activity.map(a => ({ kind: 'activity', ...a })));
    return items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }, [comments, activity, showDetails]);

  const canEditCard = true; // any board member
  if (!card) return <Modal isOpen onClose={onClose} title="Card"><div className="py-10 text-center text-gray-400 text-sm">Loading…</div></Modal>;

  const Main = (
    <div className="space-y-4">
      {/* title + complete */}
      <div className="flex items-start gap-2">
        <button onClick={toggleComplete} title={card.completed ? 'Mark not complete' : 'Mark complete'}
          className={`mt-1 w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${card.completed ? 'bg-green-600 border-green-600 text-white' : 'border-gray-300 hover:border-green-500'}`}>
          {card.completed ? <FiCheck size={12} /> : null}
        </button>
        <textarea value={title} onChange={e => setTitle(e.target.value)} onBlur={saveTitle} rows={1}
          className={`flex-1 text-lg font-bold resize-none outline-none bg-transparent ${card.completed ? 'line-through text-gray-400' : 'text-gray-800'}`} />
      </div>

      {/* quick actions */}
      <div className="flex flex-wrap gap-1.5">
        <ActionBtn icon={FiUsers} label="Members" onClick={openMembers} />
        <ActionBtn icon={FiTag} label="Labels" onClick={openLabels} />
        <ActionBtn icon={FiCalendar} label="Dates" onClick={openDue} />
        <ActionBtn icon={FiPaperclip} label="Attachment" onClick={() => fileRef.current?.click()} />
        <input ref={fileRef} type="file" className="hidden" onChange={onFile} />
      </div>

      {/* popovers — staged; nothing saves until Apply, which also closes them */}
      {menuOpen === 'members' && (() => {
        const q = memberQuery.trim().toLowerCase();
        const list = members.filter(m => !q || (m.name || '').toLowerCase().includes(q));
        return (
          <div className="rounded-lg border bg-white shadow-sm p-2">
            <div className="text-xs font-semibold text-gray-500 mb-1 px-1">Assign members</div>
            <input className="w-full text-xs border rounded px-2 py-1 mb-1" placeholder="Search people…" value={memberQuery}
              onChange={e => setMemberQuery(e.target.value)} autoFocus />
            <div className="max-h-40 overflow-y-auto">
              {list.map(m => { const on = selMembers.includes(m.user_id); return (
                <label key={m.user_id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-blue-50 cursor-pointer text-sm">
                  <input type="checkbox" checked={on} onChange={() => setSelMembers(s => on ? s.filter(x => x !== m.user_id) : [...s, m.user_id])} />
                  <Avatar url={avatars[m.user_id]} name={m.name} size={22} /> {m.name}
                </label>
              ); })}
              {list.length === 0 && <div className="text-xs text-gray-400 px-2 py-1">No people match.</div>}
            </div>
            <PopoverActions onApply={applyMembers} onCancel={closeMenu} applying={applying} />
          </div>
        );
      })()}
      {menuOpen === 'labels' && (() => {
        const selPriority = selLabels.find(isPriorityId) || '';
        const full = draftLabels.length >= CUSTOM_MAX;
        return (
        <div className="rounded-lg border bg-white shadow-sm p-2">
          {/* Priority — one radio choice per card (available to any card editor). */}
          <div className="text-xs font-semibold text-gray-500 mb-1 px-1">Priority</div>
          <div className="flex flex-wrap gap-1 mb-2">
            {PRIORITY_LABELS.map(p => { const on = selPriority === p.id; return (
              <button key={p.id} onClick={() => setPriority(p.id)} className="text-[11px] px-2 py-0.5 rounded border"
                style={on ? { background: p.color, borderColor: p.color, color: '#fff' } : { borderColor: p.color, color: p.color }}>
                {p.name}
              </button>
            ); })}
            <button onClick={() => selPriority && setPriority(selPriority)}
              className={`text-[11px] px-2 py-0.5 rounded border border-gray-300 ${selPriority ? 'text-gray-500' : 'bg-gray-100 text-gray-700'}`}>
              None
            </button>
          </div>
          {/* Custom — small palette of plain labels (board-admin manages it). */}
          <div className="text-xs font-semibold text-gray-500 mb-1 px-1 flex items-center justify-between">
            <span>Custom</span><span className="text-gray-300">{selCustomCount}/{CUSTOM_MAX}</span>
          </div>
          <div className="max-h-32 overflow-y-auto space-y-0.5">
            {draftLabels.length === 0 && <div className="text-xs text-gray-400 px-1 py-1">No custom labels{canManage ? ' — add one below.' : '.'}</div>}
            {draftLabels.map(l => { const on = selLabels.includes(l.id); const capped = !on && selCustomCount >= CUSTOM_MAX; return (
              <div key={l.id} className="flex items-center gap-1 text-sm">
                <button onClick={() => toggleSelLabel(l.id)} disabled={capped}
                  className={`flex-1 flex items-center gap-2 px-2 py-1 rounded text-left ${capped ? 'opacity-40 cursor-not-allowed' : 'hover:bg-gray-50'}`}>
                  <span className="text-[11px] text-gray-700 bg-gray-100 border border-gray-300 px-2 py-0.5 rounded">{l.name}</span>
                  {on && <FiCheck size={14} className="text-blue-600 ml-auto" />}
                </button>
                {canManage && <button onClick={() => removeDraftLabel(l.id)} className="text-gray-300 hover:text-red-600 p-1" title="Remove label from board"><FiX size={13} /></button>}
              </div>
            ); })}
          </div>
          {canManage && (
            <div className="flex gap-1 mt-2">
              <input value={plainName} maxLength={CUSTOM_LEN} disabled={full}
                onChange={e => setPlainName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPlain(); } }}
                placeholder={full ? `Max ${CUSTOM_MAX} custom` : 'Custom label…'}
                className="flex-1 min-w-0 text-xs border rounded px-2 py-1 disabled:bg-gray-50 disabled:text-gray-400" />
              <button onClick={addPlain} disabled={full} className="text-xs px-2.5 py-1 rounded border text-gray-600 hover:bg-gray-50 disabled:opacity-50">Add</button>
            </div>
          )}
          <PopoverActions onApply={applyLabels} onCancel={closeMenu} applying={applying} />
        </div>
        );
      })()}
      {menuOpen === 'due' && (
        <div className="rounded-lg border bg-white shadow-sm p-2">
          <div className="text-xs font-semibold text-gray-500 mb-1 px-1">Due date</div>
          <input type="date" value={draftDue} onChange={e => setDraftDue(e.target.value)} className="w-full text-xs border rounded px-2 py-1" />
          {draftDue && <button onClick={() => setDraftDue('')} className="block text-xs text-red-600 mt-1">Clear date</button>}
          <PopoverActions onApply={applyDue} onCancel={closeMenu} applying={applying} />
        </div>
      )}

      {/* applied labels + due summary */}
      {((card.label_ids || []).length > 0 || card.due_date) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {(card.label_ids || []).map(id => { const l = boardLabels.find(x => x.id === id); if (!l) return null; return l.color
            ? <span key={id} className="text-[11px] text-white px-2 py-0.5 rounded" style={{ background: l.color }}>{l.name}</span>
            : <span key={id} className="text-[11px] text-gray-700 bg-gray-100 border border-gray-300 px-2 py-0.5 rounded">{l.name}</span>; })}
          {card.due_date && (() => { const dm = dueMeta(card.due_date, card.completed); return <span className={`text-[11px] px-2 py-0.5 rounded flex items-center gap-1 ${dm.cls}`}><FiCalendar size={11} /> {dm.label}</span>; })()}
        </div>
      )}

      {/* assignee avatars */}
      {(card.members || []).length > 0 && (
        <div className="flex items-center gap-2"><span className="text-xs font-semibold text-gray-500">Assigned:</span><AvatarStack people={card.members} avatars={avatars} /></div>
      )}

      {/* description */}
      <div>
        <div className="text-sm font-semibold text-gray-700 mb-1">Description</div>
        <textarea value={desc} onChange={e => setDesc(e.target.value)} onBlur={saveDesc} placeholder="Add a more detailed description…"
          className="input w-full min-h-[70px]" />
      </div>

      {/* checklist */}
      <div>
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-700 mb-1"><FiCheckSquare size={15} /> Checklist {checklist.length > 0 && <span className="text-xs text-gray-400">{doneCount}/{checklist.length}</span>}</div>
        {checklist.length > 0 && (
          <div className="h-1.5 rounded bg-gray-200 mb-2 overflow-hidden"><div className="h-full rounded" style={{ width: `${(doneCount / checklist.length) * 100}%`, background: '#16a34a' }} /></div>
        )}
        <div className="space-y-1">
          {checklist.map(i => (
            <div key={i.id} className="flex items-center gap-2 group text-sm">
              <input type="checkbox" checked={i.done} onChange={() => toggleItem(i.id)} />
              <span className={`flex-1 ${i.done ? 'line-through text-gray-400' : ''}`}>{i.text}</span>
              <button onClick={() => removeItem(i.id)} className="text-gray-300 hover:text-red-600 opacity-0 group-hover:opacity-100"><FiX size={14} /></button>
            </div>
          ))}
        </div>
        <div className="flex gap-2 mt-1.5">
          <input value={newItem} onChange={e => setNewItem(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } }} placeholder="Add an item…" className="input flex-1 text-sm" />
          <button onClick={addItem} className="btn btn-primary text-sm">Add</button>
        </div>
      </div>
    </div>
  );

  const Comments = (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input value={comment} onChange={e => setComment(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendComment(); } }}
          placeholder="Write a comment…" className="input flex-1" disabled={busy} />
        <button onClick={() => fileRef.current?.click()} className="p-2 text-gray-500 hover:text-blue-600" title="Attach"><FiPaperclip size={18} /></button>
        <button onClick={() => sendComment()} disabled={busy} className="btn btn-primary disabled:opacity-40">Send</button>
      </div>
      <label className="flex items-center gap-2 text-xs text-gray-500 select-none">
        <input type="checkbox" checked={showDetails} onChange={e => setShowDetails(e.target.checked)} /> Show details (activity)
      </label>
      <div className="space-y-3">
        {feed.length === 0 && <div className="text-center text-gray-400 text-sm py-6">No comments yet.</div>}
        {feed.map(it => it.kind === 'comment' ? (
          <div key={`c${it.id}`} className="flex gap-2">
            <Avatar url={avatars[it.sender_id]} name={it.sender_name} size={30} />
            <div className="flex-1 min-w-0">
              <div className="text-xs"><span className="font-semibold text-gray-700">{it.sender_name}</span> <span className="text-gray-400">{relTime(it.created_at)}</span></div>
              <div className="rounded-lg bg-[#e6ecf7] px-3 py-1.5 mt-0.5 text-sm text-gray-800 whitespace-pre-wrap break-words">
                {it.body}
                {it.attachment_url && (isImg(it.attachment_url)
                  ? <CardImage url={it.attachment_url} name={it.attachment_name} />
                  : <a href={it.attachment_url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-blue-700 underline mt-1"><FiFile size={13} /> {it.attachment_name || 'attachment'}</a>)}
              </div>
              {(it.sender_id === user?.id || canManage) && <button onClick={() => delComment(it.id)} className="text-[11px] text-gray-400 hover:text-red-600 mt-0.5">Delete</button>}
            </div>
          </div>
        ) : (
          <div key={`a${it.id}`} className="flex gap-2 items-center text-[12px] text-gray-500 pl-1">
            <Avatar name={it.actor_name} size={22} />
            <span><span className="font-medium text-gray-600">{it.actor_name}</span> {it.detail} · <span className="text-gray-400">{relTime(it.created_at)}</span></span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <Modal isOpen onClose={onClose} title={card.title} wide>
      <div className="-mt-2">
        {/* mobile tab switch — full-width pills */}
        <div className="grid grid-cols-2 gap-1 md:hidden mb-2 rounded-lg bg-gray-100 p-0.5 text-xs font-semibold">
          {['main', 'comments'].map(t => (
            <button key={t} onClick={() => setTab(t)} className={`py-1.5 rounded-md transition-colors ${tab === t ? 'bg-white shadow text-blue-700' : 'text-gray-500'}`}>{t === 'main' ? 'Main' : 'Comments & Activity'}</button>
          ))}
        </div>
        <div className="md:grid md:grid-cols-[1fr_360px] md:gap-5">
          <div className={tab === 'main' ? '' : 'hidden md:block'}>{Main}</div>
          <div className={`${tab === 'comments' ? '' : 'hidden md:block'} md:border-l md:pl-5 mt-4 md:mt-0`}>
            <div className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1.5"><FiMessageSquare size={15} /> Comments and activity</div>
            {Comments}
          </div>
        </div>
      </div>
    </Modal>
  );
}
const ActionBtn = ({ icon: Icon, label, onClick }) => (
  <button onClick={onClick} className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-gray-100 hover:bg-gray-200 text-sm text-gray-700"><Icon size={14} /> {label}</button>
);
// Apply / Cancel footer shared by the staged Members / Labels / Dates popovers.
const PopoverActions = ({ onApply, onCancel, applying }) => (
  <div className="flex justify-end gap-2 mt-2 pt-2 border-t">
    <button onClick={onCancel} className="text-xs px-3 py-1 rounded border text-gray-600 hover:bg-gray-50">Cancel</button>
    <button onClick={onApply} disabled={applying} className="text-xs px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">{applying ? 'Applying…' : 'Apply'}</button>
  </div>
);

/* ══════════════════════════════════════════════════════════════════════════
   Main page
   ══════════════════════════════════════════════════════════════════════════ */
export default function SotynFlow() {
  const { boardId } = useParams();
  const nav = useNavigate();
  const { user, isAdmin, canCreate } = useAuth();
  const mayCreate = canCreate('sotyn_flow');

  const [boards, setBoards] = useState([]);
  const [boardsLoading, setBoardsLoading] = useState(true);   // gate the first-load empty-state flash
  const [canSeeAll, setCanSeeAll] = useState(false);
  const [mineOnly, setMineOnly] = useState(() => localStorage.getItem('flow_mine') === '1');
  const [q, setQ] = useState('');
  const [allUsers, setAllUsers] = useState([]);
  const avatars = useMemo(() => { const m = {}; for (const u of allUsers) m[u.id] = u.avatar_url; return m; }, [allUsers]);

  const [board, setBoard] = useState(null);   // { board, columns, cards, members }
  const [openCard, setOpenCard] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const socketRef = useRef(null);

  // modals
  const [newOpen, setNewOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [boardMenu, setBoardMenu] = useState(false);

  const loadBoards = useCallback(() => {
    // No `q` param: search is filtered client-side (`shown` below), so we don't
    // re-hit the API on every keystroke.
    api.get('/sotyn-flow', { params: { mine: mineOnly ? 1 : undefined } })
      .then(r => { setBoards(r.data.boards || []); setCanSeeAll(!!r.data.can_see_all); }).catch(() => {})
      .finally(() => setBoardsLoading(false));   // first resolution ends the gate; later refetches keep it false (no flash)
  }, [mineOnly]);
  const loadBoard = useCallback(() => {
    if (!boardId) return;
    api.get(`/sotyn-flow/${boardId}`).then(r => setBoard(r.data))
      .catch(e => { toast.error(e.response?.data?.error || 'Board not available'); nav('/sotyn-flow'); });
  }, [boardId, nav]);

  useEffect(() => { api.get('/auth/users').then(r => setAllUsers((r.data || []).filter(u => u.active !== 0))).catch(() => {}); }, []);
  useEffect(() => { loadBoards(); }, [loadBoards]);
  useEffect(() => { setBoard(null); if (boardId) loadBoard(); }, [boardId, loadBoard]);
  useEffect(() => { localStorage.setItem('flow_mine', mineOnly ? '1' : '0'); }, [mineOnly]);

  // socket — join current board, refetch on flow:changed; fallback poll when down
  useEffect(() => {
    const socket = io({ path: '/socket.io', auth: (cb) => cb({ token: getToken() }), transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    socket.on('connect', () => { if (boardId) socket.emit('flow:join', boardId); loadBoards(); if (boardId) loadBoard(); });
    socket.on('flow:changed', ({ boardId: bid }) => {
      loadBoards();
      if (String(bid) === String(boardId)) { loadBoard(); setRefreshKey(k => k + 1); }
    });
    socket.on('flow:board_deleted', ({ boardId: bid }) => { loadBoards(); if (String(bid) === String(boardId)) nav('/sotyn-flow'); });
    return () => { socket.disconnect(); socketRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId]);
  useEffect(() => {
    if (boardId && socketRef.current?.connected) socketRef.current.emit('flow:join', boardId);
    const t = setInterval(() => { if (!socketRef.current?.connected) { loadBoards(); if (boardId) loadBoard(); } }, 20000);
    return () => { if (boardId && socketRef.current) socketRef.current.emit('flow:leave', boardId); clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId]);

  const myRole = board?.board?.my_role;
  const canManage = isAdmin() || myRole === 'admin';

  // Board-view derived data + stable handlers — declared before the early
  // returns so they stay unconditional hooks. Memoizing the card grouping and
  // callbacks means an optimistic move (which keeps unchanged card object refs)
  // and local UI state only repaint the affected cards, not the whole board.
  const cardsByColMap = useMemo(() => {
    const m = {};
    for (const c of (board?.cards || [])) (m[c.column_id] ||= []).push(c);
    for (const k in m) m[k].sort((a, b) => a.position - b.position);
    return m;
  }, [board]);
  const cardsByCol = useCallback((colId) => cardsByColMap[colId] || [], [cardsByColMap]);
  const openBoardLabels = useMemo(() => board?.board?.labels || [], [board]);
  const moveCard = useCallback(async (cardId, toCol, position) => {
    setBoard(bd => bd ? { ...bd, cards: bd.cards.map(c => c.id === cardId ? { ...c, column_id: toCol, position: position ?? c.position } : c) } : bd);
    try { await api.put(`/sotyn-flow/${boardId}/cards/${cardId}/move`, { column_id: toCol, position }); }
    catch (e) { toast.error(e.response?.data?.error || 'Move failed'); loadBoard(); }
  }, [boardId, loadBoard]);
  const dropOnColumn = useCallback((colId) => moveCard(window.__flowDragId, colId, undefined), [moveCard]);
  const dropOnCard = useCallback((target) => {
    const list = cardsByCol(target.column_id);
    const idx = list.findIndex(c => c.id === target.id);
    const prev = idx > 0 ? list[idx - 1].position : 0;
    moveCard(window.__flowDragId, target.column_id, (prev + target.position) / 2);
  }, [cardsByCol, moveCard]);
  const onOpenCard = useCallback((c) => setOpenCard(c), []);

  /* ── boards list view ─────────────────────────────────────────── */
  if (!boardId) {
    const shown = boards.filter(b => !q || `${b.name} ${b.description || ''}`.toLowerCase().includes(q.toLowerCase()));
    return (
      <div className="flow-wrapper flex flex-col h-[calc(100dvh-69px)] -m-2 md:m-0 sm:h-[calc(100dvh-61px)] md:h-[calc(100dvh-104px)]">
        <SubNav>
          <h1 className="text-base sm:text-lg font-bold flex items-center gap-2"><FiTrello /> SOTYN Flow</h1>
          <div className="flex-1" />
          <div className="relative hidden sm:block">
            <FiSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/60" size={14} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search boards…" className="pl-8 pr-2 py-1.5 rounded-lg bg-white/15 text-white placeholder-white/60 text-sm outline-none w-40 focus:w-56 transition-all" />
          </div>
          {canSeeAll && (
            <button onClick={() => setMineOnly(v => !v)} title="Only my boards" className="flex items-center gap-1.5 text-xs text-white/90">
              <span className={`relative w-9 h-5 rounded-full transition-colors ${mineOnly ? 'bg-[#2563eb]' : 'bg-white/25'}`}><span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${mineOnly ? 'left-4' : 'left-0.5'}`} /></span>
              <span className="hidden md:inline">Only mine</span>
            </button>
          )}
          {mayCreate && <button onClick={() => setNewOpen(true)} className="flex items-center gap-1.5 bg-white/15 hover:bg-white/25 text-white text-sm font-medium px-3 py-1.5 rounded-lg"><FiPlus size={16} /> <span className="hidden sm:inline">New board</span></button>}
        </SubNav>

        <div className="flex-1 overflow-y-auto p-3 border border-gray-200 md:p-5">
          {boardsLoading ? (
            <div className="flow-fade flex flex-col items-center justify-center text-gray-400 gap-3 py-20">
              <div className="w-8 h-8 border-2 border-gray-200 border-t-blue-500 rounded-full animate-spin" />
              <span className="text-sm">Loading boards…</span>
            </div>
          ) : shown.length === 0 ? (
            <div className="flow-fade flex flex-col items-center justify-center text-gray-400 gap-2 py-20">
              <FiTrello size={44} />
              <span className="text-sm text-center max-w-xs">{q ? 'No boards match your search.' : (mayCreate ? 'No boards yet — create your first one.' : "No boards yet — you'll see boards here once you're added to one.")}</span>
              {!q && mayCreate && <button onClick={() => setNewOpen(true)} className="btn btn-primary mt-1"><FiPlus className="inline -mt-0.5" /> New board</button>}
            </div>
          ) : (
            <div className="flow-fade grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {shown.map(b => (
                <button key={b.id} onClick={() => nav(`/sotyn-flow/${b.id}`)} className="text-left rounded-xl border border-gray-200 bg-white p-4 hover:shadow-md hover:border-blue-300 transition-all flex flex-col">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="flex-1 min-w-0 font-bold text-gray-800 truncate">{b.name}</h3>
                    {b.my_role === 'admin' && <span className="text-[9px] font-bold text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded flex-shrink-0">ADMIN</span>}
                  </div>
                  {b.description && <p className="text-xs text-gray-500 mt-1 truncate">{b.description}</p>}
                  <div className="flex items-center justify-between mt-auto pt-3">
                    <AvatarStack people={b.members} avatars={avatars} size={24} />
                    <div className="text-[11px] text-gray-400 flex gap-2"><span>{b.column_count} lists</span><span>{b.card_count} cards</span></div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <NewBoardModal open={newOpen} onClose={() => setNewOpen(false)} allUsers={allUsers} user={user} avatars={avatars}
          onCreated={(id) => { setNewOpen(false); loadBoards(); nav(`/sotyn-flow/${id}`); }} />
      </div>
    );
  }

  /* ── single board view ────────────────────────────────────────── */
  if (!board) return <div className="flex items-center justify-center h-full text-gray-400"><span className="w-8 h-8 rounded-full border-[3px] border-gray-300 border-t-blue-600 animate-spin" /></div>;
  const { columns, members } = board;

  const deleteBoard = async () => {
    if (!confirm('Delete this board and everything in it? This cannot be undone.')) return;
    try { await api.delete(`/sotyn-flow/${boardId}`); toast.success('Board deleted'); nav('/sotyn-flow'); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed to delete board'); }
  };

  return (
    <div className="flow-wrapper flex flex-col h-[calc(100dvh-69px)] -m-2 md:m-0 sm:h-[calc(100dvh-61px)] md:h-[calc(100dvh-104px)]">
      <SubNav>
        <button onClick={() => nav('/sotyn-flow')} className="p-1.5 rounded hover:bg-white/15" title="Back to boards"><FiArrowLeft size={18} /></button>
        {/* board switcher */}
        <div className="relative">
          <button onClick={() => setSwitcherOpen(o => !o)} className="flex items-center gap-1.5 font-bold text-base sm:text-lg max-w-[40vw] truncate">
            <span className="truncate">{board.board.name}</span><FiChevronDown size={16} className="flex-shrink-0" />
          </button>
          {switcherOpen && (
            <div className="absolute z-30 mt-1 left-0 w-60 max-h-72 overflow-y-auto rounded-lg bg-white shadow-lg border text-gray-700 py-1" onMouseLeave={() => setSwitcherOpen(false)}>
              {boards.map(b => (
                <button key={b.id} onClick={() => { setSwitcherOpen(false); nav(`/sotyn-flow/${b.id}`); }} className={`w-full text-left px-3 py-2 text-sm hover:bg-blue-50 ${String(b.id) === String(boardId) ? 'bg-blue-50 font-semibold' : ''}`}>{b.name}</button>
              ))}
            </div>
          )}
        </div>
        <div className="flex-1" />
        <button onClick={() => setSettingsOpen(true)} className="flex items-center gap-1.5 bg-white/15 hover:bg-white/25 text-sm px-3 py-1.5 rounded-lg"><FiUsers size={15} /> <span className="hidden sm:inline">Members</span></button>
        {canManage && (
          <div className="relative">
            <button onClick={() => setBoardMenu(o => !o)} className="p-1.5 rounded hover:bg-white/15" title="Board actions"><FiMoreHorizontal size={18} /></button>
            {boardMenu && (
              <div className="absolute right-0 z-30 mt-1 w-44 rounded-lg bg-white shadow-lg border text-gray-700 py-1 text-sm" onMouseLeave={() => setBoardMenu(false)}>
                <button onClick={() => { setBoardMenu(false); setSettingsOpen(true); }} className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2"><FiSettings size={14} /> Board settings</button>
                <button onClick={() => { setBoardMenu(false); deleteBoard(); }} className="w-full text-left px-3 py-2 hover:bg-red-50 text-red-600 flex items-center gap-2 border-t"><FiTrash2 size={14} /> Delete board</button>
              </div>
            )}
          </div>
        )}
      </SubNav>

      {board.board.description && <div className="px-4 py-1.5 text-sm text-gray-500 bg-white border-x truncate">{board.board.description}</div>}

      {/* columns */}
      <div className="flex-1 border border-gray-200 overflow-x-auto overflow-y-hidden" style={CANVAS_BG}>
        <div className="flex gap-3 p-3 h-full items-start snap-x">
          {columns.map(col => (
            <Column key={col.id} col={col} cards={cardsByCol(col.id)} avatars={avatars} boardLabels={openBoardLabels}
              canManage={canManage} boardId={boardId} columns={columns}
              onOpenCard={onOpenCard} onDropColumn={dropOnColumn} onDropCard={dropOnCard}
              onReload={loadBoard} onMoveMenu={moveCard} />
          ))}
          {canManage && <AddColumn boardId={boardId} onAdded={loadBoard} />}
        </div>
      </div>

      {openCard && (
        <CardModal boardId={boardId} cardId={openCard.id} board={board.board} members={members} avatars={avatars}
          canManage={canManage} user={user} refreshKey={refreshKey} onClose={() => setOpenCard(null)} onChanged={loadBoard} />
      )}
      {settingsOpen && (
        <BoardSettings board={board} allUsers={allUsers} avatars={avatars} canManage={canManage} user={user} isAdmin={isAdmin}
          boardId={boardId} onClose={() => setSettingsOpen(false)} onReload={loadBoard}
          onDeleted={() => { setSettingsOpen(false); nav('/sotyn-flow'); }} />
      )}
    </div>
  );
}

/* ── subnav strip ─────────────────────────────────────────────── */
const SubNav = ({ children }) => (
  <div className="flex items-center gap-2 px-3 py-2 text-white flex-shrink-0 md:rounded-t-lg" style={{ background: NAVY, paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}>{children}</div>
);

/* ── column lane ──────────────────────────────────────────────── */
const Column = memo(function Column({ col, cards, avatars, boardLabels, canManage, boardId, columns, onOpenCard, onDropColumn, onDropCard, onReload, onMoveMenu }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(col.title);

  const addCard = async () => {
    const t = title.trim(); if (!t) return;
    try { await api.post(`/sotyn-flow/${boardId}/cards`, { column_id: col.id, title: t }); setTitle(''); setAdding(false); onReload(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  const rename = async () => { const n = name.trim(); if (n && n !== col.title) { try { await api.put(`/sotyn-flow/${boardId}/columns/${col.id}`, { title: n }); } catch { toast.error('Failed'); } } setRenaming(false); onReload(); };
  const del = async () => { if (!confirm(`Delete list "${col.title}" and its ${cards.length} card(s)?`)) return; try { await api.delete(`/sotyn-flow/${boardId}/columns/${col.id}`); onReload(); } catch { toast.error('Failed'); } };

  return (
    <div className="w-[85vw] sm:w-72 flex-shrink-0 flex flex-col max-h-full snap-start bg-black/[0.03] rounded-xl"
      onDragOver={e => e.preventDefault()} onDrop={() => onDropColumn(col.id)}>
      <div className="flex items-center gap-1 px-3 py-2">
        {renaming ? (
          <input autoFocus value={name} onChange={e => setName(e.target.value)} onBlur={rename} onKeyDown={e => e.key === 'Enter' && rename()} className="input flex-1 text-sm py-1" />
        ) : (
          <h3 className="flex-1 font-semibold text-sm text-gray-700 truncate">{col.title} <span className="text-gray-400 font-normal">{cards.length}</span></h3>
        )}
        {canManage && !renaming && (
          <div className="relative">
            <button onClick={() => setMenu(m => !m)} className="text-gray-400 hover:text-gray-700 p-1"><FiMoreHorizontal size={16} /></button>
            {menu && (
              <div className="absolute right-0 z-20 mt-1 w-36 rounded-lg bg-white shadow-lg border py-1 text-sm" onMouseLeave={() => setMenu(false)}>
                <button onClick={() => { setMenu(false); setRenaming(true); }} className="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2"><FiEdit2 size={13} /> Rename</button>
                <button onClick={() => { setMenu(false); del(); }} className="w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600 flex items-center gap-2"><FiTrash2 size={13} /> Delete</button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2 space-y-2 min-h-[8px]">
        {cards.map(c => (
          <CardTile key={c.id} card={c} avatars={avatars} boardLabels={boardLabels} columns={columns}
            onOpen={onOpenCard} onDropCard={onDropCard} onMove={onMoveMenu} boardId={boardId} onReload={onReload} />
        ))}
      </div>

      <div className="p-2">
        {adding ? (
          <div className="space-y-1.5">
            <textarea autoFocus value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addCard(); } }} placeholder="Card title…" className="input w-full text-sm min-h-[52px]" />
            <div className="flex gap-2"><button onClick={addCard} className="btn btn-primary text-sm flex-1">Add card</button><button onClick={() => { setAdding(false); setTitle(''); }} className="btn border text-sm"><FiX size={14} /></button></div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="w-full text-left text-sm text-gray-500 hover:text-blue-700 hover:bg-white/60 rounded-lg px-2 py-1.5 flex items-center gap-1.5"><FiPlus size={14} /> Add a card</button>
        )}
      </div>
    </div>
  );
});

/* ── card tile ────────────────────────────────────────────────── */
const CardTile = memo(function CardTile({ card, avatars, boardLabels, columns, onOpen, onDropCard, onMove, boardId, onReload }) {
  const [menu, setMenu] = useState(false);
  const dm = dueMeta(card.due_date, card.completed);
  const labels = (card.label_ids || []).map(id => boardLabels.find(l => l.id === id)).filter(Boolean);
  const priority = labels.find(l => isPriorityId(l.id));
  const customs = labels.filter(l => !isPriorityId(l.id));
  const done = (card.checklist || []).filter(i => i.done).length;
  const total = (card.checklist || []).length;
  const del = async (e) => { e.stopPropagation(); if (!confirm('Delete this card?')) return; try { await api.delete(`/sotyn-flow/${boardId}/cards/${card.id}`); onReload(); } catch { toast.error('Failed'); } };

  return (
    <div draggable onDragStart={() => { window.__flowDragId = card.id; }} onDragOver={e => e.preventDefault()} onDrop={e => { e.stopPropagation(); onDropCard(card); }}
      onClick={() => { if (!menu) onOpen(card); }} className="bg-white rounded-lg shadow-sm hover:shadow-md border border-gray-100 p-2.5 cursor-pointer relative group">
      <div className={`text-sm ${card.completed ? 'line-through text-gray-400' : 'text-gray-800'}`}>{card.title}</div>
      {(priority || customs.length > 0) && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {priority && <span className="text-[10px] text-white px-1.5 py-0.5 rounded" style={{ background: priority.color }}>{priority.name}</span>}
          {customs.map(l => <span key={l.id} className="text-[10px] text-gray-600 bg-gray-50 border border-gray-300 px-1.5 py-0.5 rounded">{l.name}</span>)}
        </div>
      )}
      <div className="flex items-center justify-between mt-2 gap-2">
        <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
          {dm && <span className={`px-1.5 py-0.5 rounded flex items-center gap-1 ${dm.cls}`}><FiCalendar size={10} /> {dm.label}</span>}
          {total > 0 && <span className={`px-1.5 py-0.5 rounded flex items-center gap-1 ${done === total ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}><FiCheckSquare size={10} /> {done}/{total}</span>}
          {card.comment_count > 0 && <span className="text-gray-400 flex items-center gap-0.5"><FiMessageSquare size={10} /> {card.comment_count}</span>}
          {card.attachment_count > 0 && <span className="text-gray-400 flex items-center gap-0.5"><FiPaperclip size={10} /> {card.attachment_count}</span>}
        </div>
        {(card.members || []).length > 0 && <AvatarStack people={card.members} avatars={avatars} size={20} />}
      </div>
      {/* quick move/delete — opened as a Modal so it never clips inside the
          column's overflow-y-auto scroll area (and is touch-friendly). */}
      <div className="absolute top-1 right-1">
        <button onClick={e => { e.stopPropagation(); setMenu(true); }} className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 text-gray-400 hover:text-gray-700 bg-white/80 rounded p-0.5"><FiMoreHorizontal size={14} /></button>
      </div>
      {menu && (
        <Modal isOpen onClose={() => setMenu(false)} title={card.title}>
          <div className="space-y-1 text-sm">
            <div className="text-[11px] font-semibold text-gray-400 px-1 mb-0.5">Move to list</div>
            {columns.filter(c => c.id !== card.column_id).map(c => (
              <button key={c.id} onClick={() => { setMenu(false); onMove(card.id, c.id, undefined); }} className="w-full text-left px-3 py-2 rounded hover:bg-blue-50">{c.title}</button>
            ))}
            {columns.filter(c => c.id !== card.column_id).length === 0 && <div className="text-xs text-gray-400 px-3 py-1">No other list to move to.</div>}
            <button onClick={(e) => { del(e); }} className="w-full text-left px-3 py-2 rounded hover:bg-red-50 text-red-600 flex items-center gap-2 border-t mt-1"><FiTrash2 size={13} /> Delete card</button>
          </div>
        </Modal>
      )}
    </div>
  );
});
/* ── add column ───────────────────────────────────────────────── */
function AddColumn({ boardId, onAdded }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const add = async () => { const t = title.trim(); if (!t) return; try { await api.post(`/sotyn-flow/${boardId}/columns`, { title: t }); setTitle(''); setAdding(false); onAdded(); } catch { toast.error('Failed'); } };
  return (
    <div className="w-[85vw] sm:w-72 flex-shrink-0">
      {adding ? (
        <div className="bg-black/[0.03] rounded-xl p-2 space-y-1.5">
          <input autoFocus value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} placeholder="List title…" className="input w-full text-sm" />
          <div className="flex gap-2"><button onClick={add} className="btn btn-primary text-sm flex-1">Add list</button><button onClick={() => setAdding(false)} className="btn border text-sm"><FiX size={14} /></button></div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="w-full text-sm text-gray-600 bg-white/50 hover:bg-white/80 rounded-xl px-3 py-2 flex items-center gap-1.5"><FiPlus size={15} /> Add another list</button>
      )}
    </div>
  );
}

/* ── new board modal ──────────────────────────────────────────── */
function NewBoardModal({ open, onClose, allUsers, user, avatars, onCreated }) {
  const [name, setName] = useState(''); const [desc, setDesc] = useState('');
  const [sel, setSel] = useState([]); const [search, setSearch] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setName(''); setDesc(''); setSel([]); setSearch(''); } }, [open]);
  const create = async () => {
    const n = name.trim(); if (!n) return toast.error('Board name is required');
    setBusy(true);
    try { const r = await api.post('/sotyn-flow', { name: n, description: desc || undefined, member_ids: sel }); onCreated(r.data.id); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); } finally { setBusy(false); }
  };
  return (
    <Modal isOpen={open} onClose={onClose} title="New board">
      <div className="space-y-2 text-sm">
        <div><label className="label">Board name</label><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Pharma Rollout" autoFocus /></div>
        <div><label className="label">Description <span className="text-gray-400">(optional)</span></label><textarea className="input min-h-[60px]" value={desc} onChange={e => setDesc(e.target.value)} /></div>
        <div>
          <label className="label">Add members</label>
          <input className="input mb-1" placeholder="Search people…" value={search} onChange={e => setSearch(e.target.value)} />
          <div className="max-h-44 overflow-y-auto border rounded p-1">
            {allUsers.filter(u => u.id !== user?.id && (!search || `${u.name} ${u.username || ''}`.toLowerCase().includes(search.toLowerCase()))).map(u => {
              const on = sel.includes(u.id);
              return <label key={u.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50 cursor-pointer"><input type="checkbox" checked={on} onChange={() => setSel(s => on ? s.filter(x => x !== u.id) : [...s, u.id])} /><Avatar url={avatars[u.id]} name={u.name} size={24} /><span>{u.name} <span className="text-[11px] text-gray-400">@{u.username}</span></span></label>;
            })}
          </div>
        </div>
        <div className="flex gap-2 pt-1"><button onClick={create} disabled={busy} className="btn btn-primary flex-1 disabled:opacity-50">{busy ? 'Creating…' : 'Create board'}</button><button onClick={onClose} className="btn border">Cancel</button></div>
      </div>
    </Modal>
  );
}

/* ── board settings / members / labels ────────────────────────── */
function BoardSettings({ board, allUsers, avatars, canManage, user, isAdmin, boardId, onClose, onReload, onDeleted }) {
  const b = board.board;
  const [name, setName] = useState(b.name); const [desc, setDesc] = useState(b.description || '');
  const [memSearch, setMemSearch] = useState('');
  const [labels, setLabels] = useState(b.labels || []);
  const members = board.members;

  const saveMeta = async () => { try { await api.put(`/sotyn-flow/${boardId}`, { name: name.trim(), description: desc }); onReload(); toast.success('Saved'); } catch (e) { toast.error(e.response?.data?.error || 'Failed'); } };
  const addMember = (id) => api.post(`/sotyn-flow/${boardId}/members`, { user_ids: [id] }).then(onReload).catch(() => toast.error('Failed'));
  const removeMember = (id) => api.delete(`/sotyn-flow/${boardId}/members/${id}`).then(onReload).catch(e => toast.error(e.response?.data?.error || 'Failed'));
  const setRole = (id, role) => api.put(`/sotyn-flow/${boardId}/members/${id}/role`, { role }).then(onReload).catch(e => toast.error(e.response?.data?.error || 'Failed'));
  const del = async () => { if (!confirm('Delete this board and everything in it? This cannot be undone.')) return; try { await api.delete(`/sotyn-flow/${boardId}`); onDeleted(); } catch { toast.error('Failed'); } };

  const adminCount = members.filter(m => m.role === 'admin').length;
  const saveLabels = (next) => { setLabels(next); api.put(`/sotyn-flow/${boardId}`, { labels: next }).then(onReload).catch(() => toast.error('Failed')); };
  const addLabel = () => saveLabels([...labels, { id: uid(), name: 'New label', color: LABEL_COLORS[labels.length % LABEL_COLORS.length] }]);
  const editLabel = (id, patch) => saveLabels(labels.map(l => l.id === id ? { ...l, ...patch } : l));
  const delLabel = (id) => saveLabels(labels.filter(l => l.id !== id));

  return (
    <Modal isOpen onClose={onClose} title={`Board · ${b.name}`}>
      <div className="space-y-3 text-sm">
        {canManage ? (
          <>
            <div><label className="label">Board name</label><div className="flex gap-2"><input className="input flex-1" value={name} onChange={e => setName(e.target.value)} /><button onClick={saveMeta} disabled={!name.trim()} className="btn btn-primary disabled:opacity-40">Save</button></div></div>
            <div><label className="label">Description</label><textarea className="input min-h-[56px]" value={desc} onChange={e => setDesc(e.target.value)} onBlur={saveMeta} /></div>
          </>
        ) : (
          <div className="text-xs text-gray-500">You can view this board. Only a board admin can edit its settings and members.</div>
        )}

        <div>
          <div className="font-semibold text-gray-700 mb-1">Members ({members.length})</div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {members.map(m => (
              <div key={m.user_id} className="flex items-center justify-between bg-gray-50 rounded px-2 py-1">
                <span className="flex items-center gap-2"><Avatar url={avatars[m.user_id]} name={m.name} size={24} />{m.name}{m.role === 'admin' && <span className="text-[9px] font-bold text-blue-700 bg-blue-100 px-1 rounded">ADMIN</span>}</span>
                {canManage && (
                  <div className="flex items-center gap-1">
                    {m.role === 'admin'
                      ? <button disabled={adminCount <= 1} onClick={() => setRole(m.user_id, 'member')} title={adminCount <= 1 ? 'A board needs at least one admin' : 'Remove admin'} className="text-[11px] text-gray-500 hover:text-gray-800 disabled:opacity-30">Remove admin</button>
                      : <button onClick={() => setRole(m.user_id, 'admin')} className="text-[11px] text-blue-700 hover:underline">Make admin</button>}
                    <button onClick={() => removeMember(m.user_id)} className="text-gray-400 hover:text-red-600" title="Remove"><FiX size={14} /></button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {canManage && (
          <div>
            <div className="font-semibold text-gray-700 mb-1">Add member</div>
            <input className="input mb-1" placeholder="Search people…" value={memSearch} onChange={e => setMemSearch(e.target.value)} />
            <div className="max-h-36 overflow-y-auto">
              {allUsers.filter(u => !members.some(m => m.user_id === u.id) && (!memSearch || `${u.name} ${u.username || ''}`.toLowerCase().includes(memSearch.toLowerCase()))).map(u => (
                <div key={u.id} className="flex items-center justify-between px-2 py-1 border-b"><span className="flex items-center gap-2"><Avatar url={avatars[u.id]} name={u.name} size={22} />{u.name}</span><button onClick={() => addMember(u.id)} className="text-xs font-semibold text-blue-700 hover:bg-blue-50 rounded px-2 py-0.5">+ Add</button></div>
              ))}
            </div>
          </div>
        )}

        {canManage && (
          <div>
            <div className="font-semibold text-gray-700 mb-1 flex items-center gap-1.5"><FiTag size={13} /> Labels</div>
            <div className="space-y-1">
              {labels.map(l => (
                <div key={l.id} className="flex items-center gap-2">
                  <input type="color" value={l.color} onChange={e => editLabel(l.id, { color: e.target.value })} className="w-7 h-7 rounded border p-0" />
                  <input value={l.name} onChange={e => editLabel(l.id, { name: e.target.value })} className="input flex-1 text-sm py-1" />
                  <button onClick={() => delLabel(l.id)} className="text-gray-400 hover:text-red-600"><FiX size={14} /></button>
                </div>
              ))}
            </div>
            <button onClick={addLabel} className="text-xs font-semibold text-blue-700 mt-1">+ Add label</button>
          </div>
        )}

        {canManage && <button onClick={del} className="text-xs text-red-600 font-semibold flex items-center gap-1.5 pt-1"><FiTrash2 size={13} /> Delete board</button>}
      </div>
    </Modal>
  );
}
