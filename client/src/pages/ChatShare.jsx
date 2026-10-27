import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import ChatShareStatusModal from '../components/ChatShareStatusModal';
import { useAuth } from '../context/AuthContext';
import { chatShareLoginPath } from '../lib/chatShareReturn';

let storePromise;
const STORE_URL='/chat-share-store.js';
const getStore=()=>storePromise ||= import(/* @vite-ignore */ STORE_URL).then(()=>window.SotynChatShares);
const errorText=e=>e.response?.status===401 ? 'Your session expired. Sign in again to resume this draft.' :
  e.response?.data?.error || e.message || 'Connection interrupted. Your draft is saved; retry when online.';

function FilePreview({item}) {
  const [url,setUrl]=useState(''),[show,setShow]=useState(false),[text,setText]=useState('');
  const pdf=/\.pdf$/i.test(item.name),plain=/\.txt$/i.test(item.name);
  useEffect(()=>{
    let active=true;
    // The sending app's MIME is untrusted. Force a PDF MIME for PDF previews;
    // text is rendered as React text, never injected markup.
    const u=URL.createObjectURL(pdf ? item.file.slice(0,item.file.size,'application/pdf') : item.file);
    // The object URL is an external browser resource owned and revoked by this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(u);
    if(plain)item.file.slice(0,5000).text().then(value=>active && setText(value));
    return()=>{active=false;URL.revokeObjectURL(u);};
  },[item.file,pdf,plain]);
  const image=/\.(jpe?g|png|gif|webp)$/i.test(item.name);
  return <div className="rounded-xl border p-3 bg-white space-y-2"><div className="flex gap-3 items-center">
    {image && url && <img src={url} alt={item.name} className="w-16 h-16 object-contain rounded" />}
    <div className="min-w-0 flex-1"><p className="font-medium break-all">{item.name}</p>
      <p className="text-xs text-gray-500">{(item.file.size/1024).toFixed(1)} KB · {item.uploadId ? 'Upload ready' : 'On this device'}</p>
      {(pdf || plain) && <button onClick={()=>setShow(s=>!s)} className="text-blue-700 text-xs underline mr-3">{show?'Hide preview':'Preview'}</button>}
      {url && <a href={url} download={item.name} className="text-blue-700 text-xs underline">Open file</a>}</div></div>
    {show && plain && <pre className="text-xs whitespace-pre-wrap break-all max-h-44 overflow-auto bg-slate-50 p-2 rounded">{text}</pre>}
    {show && pdf && <iframe src={url} title={`Preview ${item.name}`} sandbox="" className="w-full h-72 border rounded" />}
  </div>;
}

export default function ChatShare() {
  const {user,logout}=useAuth();
  const id=new URLSearchParams(window.location.search).get('draft');
  const [draft,setDraft]=useState(null), [pending,setPending]=useState([]), [error,setError]=useState('');
  const [q,setQ]=useState(''),[targets,setTargets]=useState([]),[tab,setTab]=useState('all'),[searching,setSearching]=useState(false);
  const [resolvingId,setResolvingId]=useState(null);
  const [busy,setBusy]=useState(false),[progress,setProgress]=useState(''),[sent,setSent]=useState(null);
  const [online,setOnline]=useState(navigator.onLine),[newText,setNewText]=useState(''),[newFiles,setNewFiles]=useState([]);
  const [needsLogin,setNeedsLogin]=useState(false);
  const [helpOpen,setHelpOpen]=useState(false);
  const running=useRef(false), generation=useRef(0);
  useEffect(()=>{
    let active=true;
    getStore().then(async store=>{
      if(id) { const d=await store.claim(id,user.id); if(active) setDraft(d); }
      else {const items=await store.list(user.id);if(active)setPending(items);}
    }).catch(e=>active && setError(e.message));
    return()=>{active=false;};
  },[id,user.id]);
  useEffect(()=>{
    const change=()=>setOnline(navigator.onLine);
    window.addEventListener('online',change);window.addEventListener('offline',change);
    return()=>{window.removeEventListener('online',change);window.removeEventListener('offline',change);};
  },[]);
  const loadTargets=useCallback(async(gen=generation.current)=>{
    setSearching(true);
    try {
      const {data}=await api.get('/site-chat/forward-targets');
      if(gen!==generation.current)return;
      setTargets(Array.isArray(data) ? data : []);
    } catch(e) {
      if(gen===generation.current){
        // Fallback to /site-chat/groups if forward-targets ever fails
        try {
          const {data: gData}=await api.get('/site-chat/groups',{params:{limit:100}});
          if(gen===generation.current && gData?.groups) {
            setTargets(gData.groups.map(g => ({
              targetType: 'group', targetId: g.id, groupId: g.id, isDm: !!g.is_dm,
              name: g.name, subtitle: g.is_dm ? 'Direct Message' : `${g.members || 0} members`
            })));
          }
        } catch {
          setError(errorText(e));
          setNeedsLogin(e.response?.status===401);
        }
      }
    } finally {
      if(gen===generation.current)setSearching(false);
    }
  },[]);
  const hasDraft=!!draft;
  useEffect(()=>{
    const gen=++generation.current;
    if(hasDraft && online)loadTargets(gen);
  },[loadTargets,hasDraft,online]);
  async function edit(change) {
    if(running.current || draft.locked)return;
    const next={...draft,...change};
    setDraft(next);
    try {await (await getStore()).save(next);}catch(e){setError(e.message);}
  }
  async function toggle(target) {
    if(running.current || draft.locked || resolvingId)return;
    let gid = target.groupId;
    if(!gid) {
      if(!navigator.onLine) {
        setError('Internet connection required to start a new chat with this colleague.');
        return;
      }
      setResolvingId(target.targetId);
      try {
        const {data} = await api.post('/site-chat/dm', { user_id: target.targetId });
        gid = data.id;
        setTargets(prev => prev.map(t =>
          (t.targetType === target.targetType && t.targetId === target.targetId)
            ? { ...t, groupId: gid }
            : t
        ));
      } catch(err) {
        setError(err.response?.data?.error || 'Failed to start direct conversation with colleague');
        return;
      } finally {
        setResolvingId(null);
      }
    }
    if(!gid) return;

    if(draft.groups.includes(gid)) {
      edit({groups:draft.groups.filter(g=>g!==gid)});
    } else if(draft.groups.length<10) {
      edit({groups:[...draft.groups,gid],labels:{...draft.labels,[gid]:target.name}});
    } else {
      setError('Select up to 10 conversations.');
    }
  }

  const peopleCount = useMemo(() => targets.filter(t => t.isDm).length, [targets]);
  const groupsCount = useMemo(() => targets.filter(t => !t.isDm).length, [targets]);

  const filteredTargets = useMemo(() => {
    const term = q.trim().toLowerCase();
    let rows = targets;
    if (tab === 'people') rows = rows.filter(t => t.isDm);
    else if (tab === 'groups') rows = rows.filter(t => !t.isDm);

    if (term) {
      rows = rows.filter(t =>
        [t.name, t.subtitle, t.phone, t.email, t.username]
          .some(v => String(v || '').toLowerCase().includes(term))
      );
    }

    return [...rows].sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      if (term) {
        const dmA = a.isDm ? 1 : 0;
        const dmB = b.isDm ? 1 : 0;
        if (dmA !== dmB) return dmB - dmA; // Prioritize single user first
      }
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }, [targets, tab, q]);
  async function createDraft() {
    try {
      const d=await (await getStore()).create({text:newText,files:newFiles});
      window.location.assign(`/site-chat/share?draft=${d.id}`);
    } catch(e){setError(e.message);}
  }
  async function send() {
    if(running.current || !draft || !draft.groups.length || !navigator.onLine)return;
    running.current=true;setBusy(true);setError('');setNeedsLogin(false);
    let d=draft;
    try {
      const store=await getStore();
      const {data:account}=await api.get('/auth/me');
      if(account.id!==d.ownerId)throw new Error('Your account changed. Sign in with the account that opened this draft.');
      // Persist the immutable payload BEFORE the first network write. Reloads and
      // ambiguous timeouts reuse the same upload keys and send request ID.
      d={...d,locked:true};await store.save(d);setDraft(d);
      for(let i=0;i<d.files.length;i++) {
        if(d.files[i].uploadId)continue;
        setProgress(`Uploading ${i+1} of ${d.files.length}…`);
        const fd=new FormData();fd.append('file',d.files[i].file,d.files[i].name);
        const {data}=await api.post(`/site-chat/share/uploads/${d.files[i].uploadKey}`,fd,{timeout:120000});
        d={...d,files:d.files.map((f,n)=>n===i?{...f,uploadId:data.id}:f)};
        await store.save(d);setDraft(d);
      }
      setProgress('Sending to selected chats…');
      const {data}=await api.post('/site-chat/share/send',{
        request_id:d.requestId,expected_sender_id:d.ownerId,group_ids:d.groups,text:d.text,
        attachment_ids:d.files.map(f=>f.uploadId),
      },{timeout:30000});
      setSent(data);setProgress('Sent');
      // A failed local cleanup must not turn a confirmed server success into a retry.
      await store.remove(d.id).catch(()=>{});
    } catch(e) {setError(errorText(e));setNeedsLogin(e.response?.status===401);setProgress('');}
    finally {running.current=false;setBusy(false);}
  }
  async function discard() {
    if(busy)return;
    const store=await getStore();
    // An uncertain send may already have committed: only discard the local copy.
    if(!draft.locked) for(const f of draft.files) if(f.uploadId) await api.delete(`/site-chat/share/uploads/${f.uploadId}`).catch(()=>{});
    await store.remove(draft.id);window.location.assign('/site-chat/share');
  }
  async function signInAgain() {
    const path=chatShareLoginPath();await logout();window.location.assign(path);
  }
  return <main className="min-h-screen bg-slate-50 text-slate-800 p-4 sm:p-8">
    <div className="max-w-3xl mx-auto space-y-5">
      <header className="flex items-start justify-between gap-3"><div><p className="text-blue-700 text-xs font-semibold">SOTYN CHAT</p>
        <h1 className="text-2xl font-bold mt-1">Share to conversations</h1><p className="text-sm text-slate-500 mt-1">Sending as {user.name}. Choose chats, review, then send.</p></div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={()=>setHelpOpen(true)} className="text-xs text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg px-2.5 py-1.5 font-medium transition-colors">
            📲 WhatsApp Setup
          </button>
          <Link to="/site-chat" className="text-sm text-blue-700 underline">Open Chat</Link>
        </div></header>
      {!online && <p role="status" className="p-3 rounded-lg bg-amber-50 border border-amber-200">You’re offline. Your draft stays on this device for 24 hours. Reconnect, then press Send.</p>}
      {error && <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700">{error}
        {needsLogin && <button onClick={signInAgain} className="block underline mt-2">Sign in and resume</button>}</div>}
      {sent ? <section className="bg-white rounded-2xl border p-6"><h2 className="text-xl font-bold text-green-700">Sent to {sent.groups.length} conversation{sent.groups.length===1?'':'s'}</h2>
        <p className="my-3">Your messages are in SOTYN Chat.</p>{sent.groups.map(g=><Link key={g} to={`/site-chat?chat=${g}`} className="block text-blue-700 underline py-2">{draft.labels?.[g] || `Conversation ${g}`}</Link>)}</section>
        : draft ? <>
          <section className="bg-white rounded-2xl border p-5 space-y-3"><h2 className="font-semibold">1. Preview shared content</h2>
            <textarea aria-label="Shared text" value={draft.text} readOnly={draft.locked || busy} maxLength={16000}
              onChange={e=>edit({text:e.target.value})} rows={4} className="w-full border rounded-xl p-3" placeholder="Shared message" />
            <div className="grid sm:grid-cols-2 gap-3">{draft.files.map(f=><FilePreview key={f.uploadKey} item={f}/>)}</div>
          </section>
          <section className="bg-white rounded-2xl border p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-slate-800">
                2. Choose recipients <span className="text-slate-500 font-normal">({draft.groups.length}/10)</span>
              </h2>
              {draft.groups.length > 0 && !draft.locked && !busy && (
                <button
                  type="button"
                  onClick={() => edit({ groups: [], labels: {} })}
                  className="text-xs text-slate-500 hover:text-red-600 underline"
                >
                  Clear all
                </button>
              )}
            </div>

            {/* Selected pills */}
            {!!draft.groups.length && (
              <div className="flex flex-wrap gap-2 pt-1 pb-1">
                {draft.groups.map(g => (
                  <span
                    key={g}
                    className="inline-flex items-center gap-1.5 bg-blue-50 text-blue-800 border border-blue-200 px-3 py-1 rounded-full text-xs font-medium"
                  >
                    <span>{draft.labels?.[g] || `Chat ${g}`}</span>
                    {!draft.locked && !busy && (
                      <button
                        type="button"
                        onClick={() => edit({ groups: draft.groups.filter(id => id !== g) })}
                        aria-label={`Remove ${draft.labels?.[g] || g}`}
                        className="hover:bg-blue-200/80 rounded-full w-4 h-4 inline-flex items-center justify-center text-xs text-blue-700 font-bold ml-0.5 transition-colors"
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}

            {/* Filter Tabs: All, Single Users (People), Groups */}
            <div className="flex items-center gap-2 border-b border-slate-100 pb-2 pt-1 text-sm font-medium">
              <button
                type="button"
                onClick={() => setTab('all')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  tab === 'all'
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-slate-600 hover:bg-slate-100 bg-slate-50 border border-slate-200'
                }`}
              >
                All ({targets.length})
              </button>
              <button
                type="button"
                onClick={() => setTab('people')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                  tab === 'people'
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-slate-600 hover:bg-slate-100 bg-slate-50 border border-slate-200'
                }`}
              >
                <span>👤 Single Users / People</span>
                <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${tab === 'people' ? 'bg-blue-700 text-blue-100' : 'bg-slate-200 text-slate-700'}`}>
                  {peopleCount}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setTab('groups')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                  tab === 'groups'
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-slate-600 hover:bg-slate-100 bg-slate-50 border border-slate-200'
                }`}
              >
                <span>👥 Groups</span>
                <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${tab === 'groups' ? 'bg-blue-700 text-blue-100' : 'bg-slate-200 text-slate-700'}`}>
                  {groupsCount}
                </span>
              </button>
            </div>

            {/* Instant Search Bar */}
            <div className="relative">
              <input
                aria-label="Search recipients"
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder={
                  tab === 'people'
                    ? 'Search single users by name, role, department, or phone…'
                    : tab === 'groups'
                    ? 'Search groups by name…'
                    : 'Search colleagues or groups by name, role, department…'
                }
                className="w-full border border-slate-300 rounded-xl p-3 pr-9 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              />
              {q && (
                <button
                  type="button"
                  onClick={() => setQ('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-base font-semibold p-1"
                  aria-label="Clear search"
                >
                  ×
                </button>
              )}
            </div>

            {/* Recipient list */}
            <div className="max-h-80 overflow-y-auto space-y-2 pr-1">
              {filteredTargets.map(target => {
                const isSelected = Boolean(target.groupId && draft.groups.includes(target.groupId));
                const isResolving = resolvingId === target.targetId;
                return (
                  <label
                    key={`${target.targetType}:${target.targetId}`}
                    className={`flex items-center gap-3 p-3 rounded-xl border transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-blue-50/80 border-blue-300 shadow-xs ring-1 ring-blue-300'
                        : 'bg-white hover:bg-slate-50 border-slate-200'
                    } ${isResolving ? 'opacity-70 pointer-events-none' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={draft.locked || busy || isResolving}
                      onChange={() => toggle(target)}
                      className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500 cursor-pointer"
                    />
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 ${
                      target.isDm
                        ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                        : 'bg-blue-100 text-blue-800 border border-blue-200'
                    }`}>
                      {target.isDm ? '👤' : '👥'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-900 truncate">{target.name}</span>
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${
                          target.isDm
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : 'bg-blue-50 text-blue-700 border border-blue-200'
                        }`}>
                          {target.isDm ? 'Single User' : 'Group'}
                        </span>
                        {target.favorite && (
                          <span className="text-amber-500 text-xs shrink-0" title="Favorite">★</span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 truncate">
                        {target.subtitle || (target.isDm ? 'Colleague' : 'Chat group')}
                      </p>
                    </div>
                    {isResolving && (
                      <span className="text-xs text-blue-600 font-medium animate-pulse shrink-0">Connecting…</span>
                    )}
                  </label>
                );
              })}
              {!filteredTargets.length && !searching && (
                <div className="text-center py-6 text-sm text-slate-500 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                  {q ? (
                    <>
                      <p>No contacts or groups match &ldquo;{q}&rdquo;.</p>
                      <button type="button" onClick={() => setQ('')} className="mt-2 text-blue-600 underline font-medium">Clear search</button>
                    </>
                  ) : (
                    <p>No recipients found.</p>
                  )}
                </div>
              )}
              {searching && (
                <p role="status" className="text-sm text-slate-500 text-center py-4">Loading contacts and groups…</p>
              )}
            </div>
          </section>
          {draft.locked && <p className="text-sm text-slate-600">Messages may already have been sent if the connection dropped. Retry checks the same request without creating duplicates. Content and recipients stay locked during recovery.</p>}
          <footer className="flex items-center justify-between gap-4 sticky bottom-0 bg-slate-50 py-4">
            <button onClick={()=>discard().catch(e=>setError(e.message))} disabled={busy} className="text-slate-500 underline text-sm">{draft.locked?'Close draft':'Discard draft'}</button>
            <span role="status" className="text-sm text-slate-500">{progress}</span>
            <button onClick={send} disabled={busy || !online || !draft.groups.length || (!draft.text.trim() && !draft.files.length)} className="rounded-xl bg-blue-700 text-white px-6 py-3 font-semibold disabled:opacity-40">{busy?'Sending…':draft.locked?'Retry send':'Send'}</button>
          </footer>
        </> : !id ? <section className="bg-white border rounded-2xl p-5 space-y-4">
          <h2 className="font-semibold">Pending shares</h2>{pending.map(d=><div key={d.id} className="flex gap-3"><Link className="text-blue-700 underline flex-1" to={`/site-chat/share?draft=${d.id}`}>Resume share · {d.files} files · {new Date(d.createdAt).toLocaleString()}</Link>
            <button className="text-sm text-slate-500 underline" onClick={async()=>{await (await getStore()).remove(d.id);setPending(p=>p.filter(x=>x.id!==d.id));}}>Discard</button></div>)}
          {!pending.length && <p className="text-sm text-slate-500">No pending shares.</p>}
          <p className="text-sm">On a supported Android browser, install SOTYN and select it from WhatsApp’s Share menu. You can also select content here.</p>
          <textarea aria-label="New share text" rows={3} value={newText} maxLength={16000} onChange={e=>setNewText(e.target.value)} placeholder="Text to share" className="border rounded-xl p-3 w-full" />
          <input aria-label="Choose files to share" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt" onChange={e=>setNewFiles(Array.from(e.target.files))} />
          <button onClick={createDraft} className="block bg-blue-700 text-white rounded-xl px-5 py-2">Preview and choose chats</button>
        </section> : !error && <p>Loading shared content…</p>}
    </div>
    <ChatShareStatusModal isOpen={helpOpen} onClose={()=>setHelpOpen(false)} />
  </main>;
}
