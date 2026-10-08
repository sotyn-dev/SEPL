// Only explicitly shared POST content is read. No WhatsApp account/API access.
importScripts('/chat-share-store.js');
const sharePage = (message, href='/site-chat/share') => new Response(`<!doctype html>
  <html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SOTYN Chat sharing</title><body><main><h1>SOTYN Chat</h1><p>${message.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</p>
  <p>Nothing is sent automatically from this page.</p><a href="${href}">Open sharing when online</a></main></body></html>`,
  {status:200,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'"}});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(url.origin !== self.location.origin) return;
  if(url.pathname === '/site-chat/share-target' && event.request.method === 'POST') {
    event.respondWith((async()=>{
      try {
        const data=await event.request.formData();
        const text=['title','text','url'].map(k=>data.get(k)).filter(v=>typeof v==='string' && v.trim()).join('\n');
        const files=data.getAll('files').filter(v=>typeof v!=='string' && v.name);
        const draft=await self.SotynChatShares.create({text,files});
        return Response.redirect(`${url.origin}/site-chat/share?draft=${draft.id}`,303);
      } catch(error) { return sharePage(error.message || 'Could not save the selected content. Please try sharing again.'); }
    })());
  } else if(url.pathname === '/site-chat/share' && event.request.mode === 'navigate' && event.request.method === 'GET') {
    event.respondWith(fetch(event.request).catch(()=>sharePage('You are offline. Your draft stays on this device for up to 24 hours. Reconnect, then open sharing.',
      self.SotynChatShares.UUID.test(url.searchParams.get('draft') || '') ? `/site-chat/share?draft=${url.searchParams.get('draft')}` : '/site-chat/share')));
  }
});
