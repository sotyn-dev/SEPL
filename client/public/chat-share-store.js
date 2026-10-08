/* Shared by the service worker and Chat picker. Never stores authentication tokens. */
(function(root) {
  const DB = 'sotyn-chat-shares-v1', TTL = 24*60*60*1000;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const EXT = /\.(pdf|jpe?g|png|gif|webp|docx?|xlsx?|pptx?|txt)$/i;
  function open() {
    return new Promise((resolve,reject) => {
      const request = indexedDB.open(DB,1);
      request.onupgradeneeded = () => request.result.createObjectStore('drafts',{keyPath:'id'});
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Device storage is unavailable. Open SOTYN outside private browsing and try again.'));
    });
  }
  async function transact(mode,action) {
    const db = await open();
    try { return await new Promise((resolve,reject) => {
      const tx = db.transaction('drafts',mode), store = tx.objectStore('drafts');
      let result, failure;
      const set = value => { result = value; };
      const fail = error => { failure = error; tx.abort(); };
      try { action(store,set,fail); } catch(error) { fail(error); }
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure || new Error('Could not save this share. Check available device storage.'));
    }); } finally { db.close(); }
  }
  function validate({text,files}) {
    if (typeof text !== 'string' || text.length > 16000) throw new Error('Shared text must be 16,000 characters or fewer.');
    if (files.length > 10) throw new Error('Share up to 10 files at a time.');
    if (!text.trim() && !files.length) throw new Error('No supported content was shared.');
    for (const file of files) {
      if (!EXT.test(file.name)) throw new Error(`Unsupported file: ${file.name}. Use PDF, JPG, PNG, GIF, WebP, Office or TXT.`);
      if (!file.size || file.size > 20*1024*1024) throw new Error('Each file must be nonempty and no larger than 20 MB.');
    }
    if (files.reduce((n,f)=>n+f.size,0) > 50*1024*1024) throw new Error('Shared files must total 50 MB or less.');
  }
  async function create({text='',files=[]}) {
    validate({text,files});
    const draft = {id:crypto.randomUUID(),requestId:crypto.randomUUID(),createdAt:Date.now(),ownerId:null,
      text,files:files.map(file=>({file,name:file.name,uploadKey:crypto.randomUUID(),uploadId:null})),groups:[],locked:false};
    await transact('readwrite',(store,set,fail) => {
      const all = store.getAll();
      all.onsuccess = () => {
        const live = all.result.filter(d=>Date.now()-d.createdAt<TTL);
        all.result.filter(d=>!live.includes(d)).forEach(d=>store.delete(d.id));
        if (live.length >= 5 || live.reduce((n,d)=>n+d.files.reduce((s,f)=>s+f.file.size,0),0)+files.reduce((n,f)=>n+f.size,0)>100*1024*1024) {
          return fail(new Error('Pending shares fill device storage. Open SOTYN Chat sharing and discard an old draft first.'));
        }
        store.put(draft); set(draft);
      };
    });
    return draft;
  }
  async function claim(id,ownerId) {
    if (!UUID.test(id || '')) throw new Error('Invalid share link.');
    return transact('readwrite',(store,set,fail) => {
      const request = store.get(id);
      request.onsuccess = () => {
        const d = request.result;
        if (!d || Date.now()-d.createdAt>=TTL) return fail(new Error('This draft expired. Please share the content again. Drafts last 24 hours.'));
        if (d.ownerId != null && d.ownerId !== ownerId) return fail(new Error('This draft belongs to another account. Sign in with that account to continue.'));
        d.ownerId = ownerId; store.put(d); set(d);
      };
    });
  }
  async function save(draft) {
    return transact('readwrite',(store,set,fail) => {
      const request=store.get(draft.id);
      request.onsuccess=()=>{
        const old=request.result;
        if (!old || old.ownerId !== draft.ownerId) return fail(new Error('Draft is no longer available.'));
        if (Date.now()-old.createdAt>=TTL) return fail(new Error('This draft expired. Please share the content again.'));
        // Once a send is attempted its payload is immutable, including across tabs.
        if (old.locked && JSON.stringify({text:old.text,groups:old.groups}) !== JSON.stringify({text:draft.text,groups:draft.groups})) {
          return fail(new Error('This share is already sending. Reload to check its result.'));
        }
        store.put({...draft,locked:old.locked || draft.locked}); set(draft);
      };
    });
  }
  async function list(ownerId) {
    return transact('readwrite',(store,set)=>{
      const request=store.getAll();
      request.onsuccess=()=>{
        const live=[];
        for(const d of request.result) {
          if(Date.now()-d.createdAt>=TTL) store.delete(d.id);
          else if(d.ownerId == null || d.ownerId === ownerId) live.push({id:d.id,createdAt:d.createdAt,files:d.files.length});
        }
        set(live);
      };
    });
  }
  const remove = id => transact('readwrite',store=>store.delete(id));
  root.SotynChatShares = {create,claim,save,list,remove,validate,UUID,TTL};
})(typeof self !== 'undefined' ? self : globalThis);
