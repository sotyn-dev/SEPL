import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [q,setQ]=useState(''),[chats,setChats]=useState([]),[cursor,setCursor]=useState(null),[searching,setSearching]=useState(false);
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
  const loadChats=useCallback(async(next=null,gen=generation.current)=>{
    setSearching(true);
    try {
      const {data}=await api.get('/site-chat/groups',{params:{limit:30,q,...(next || {})}});
      if(gen!==generation.current)return;
      setChats(old=>next ? [...old,...data.groups.filter(g=>!old.some(o=>o.id===g.id))] : data.groups);
      setCursor(data.hasMore ? data.nextCursor : null);
    } catch(e) {if(gen===generation.current){setError(errorText(e));setNeedsLogin(e.response?.status===401);}}
    finally {if(gen===generation.current)setSearching(false);}
  },[q]);
  const hasDraft=!!draft;
  useEffect(()=>{
    const gen=++generation.current;
    const timer=setTimeout(()=>{if(hasDraft && online)loadChats(null,gen);},200);
    return()=>clearTimeout(timer);
  },[loadChats,hasDraft,online]); // API search is debounced and discards stale responses.
  async function edit(change) {
    if(running.current || draft.locked)return;
    const next={...draft,...change};
    setDraft(next);
    try {await (await getStore()).save(next);}catch(e){setError(e.message);}
  }
  function toggle(chat) {
    if(draft.groups.includes(chat.id)) edit({groups:draft.groups.filter(g=>g!==chat.id)});
    else if(draft.groups.length<10) edit({groups:[...draft.groups,chat.id],labels:{...draft.labels,[chat.id]:chat.name}});
    else setError('Select up to 10 conversations.');
  }
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
          <section className="bg-white rounded-2xl border p-5 space-y-3"><h2 className="font-semibold">2. Choose conversations <span className="text-slate-500 font-normal">({draft.groups.length}/10)</span></h2>
            {!!draft.groups.length && <div className="flex flex-wrap gap-2">{draft.groups.map(g=><span key={g} className="bg-blue-50 text-blue-800 px-3 py-1 rounded-full text-sm">{draft.labels?.[g] || `Chat ${g}`}</span>)}</div>}
            <input aria-label="Search conversations" value={q} onChange={e=>setQ(e.target.value)} placeholder="Search personal or group chats…" className="w-full border rounded-xl p-3" />
            <div className="max-h-72 overflow-auto divide-y">{chats.map(chat=><label key={chat.id} className="flex gap-3 items-center py-3 cursor-pointer">
              <input type="checkbox" checked={draft.groups.includes(chat.id)} disabled={draft.locked || busy} onChange={()=>toggle(chat)} />
              <span className="flex-1"><span className="block font-medium">{chat.name}</span><span className="text-xs text-slate-500">{chat.is_dm?'Personal conversation':`${chat.members} members · Group`}</span></span></label>)}
              {!chats.length && !searching && <p className="text-sm text-slate-500 py-4">No matching conversations. Start a conversation in Chat first.</p>}</div>
            {searching && <p role="status" className="text-sm text-slate-500">Loading conversations…</p>}
            {cursor && <button onClick={()=>loadChats(cursor)} disabled={searching} className="text-blue-700 underline">Load more conversations</button>}
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
