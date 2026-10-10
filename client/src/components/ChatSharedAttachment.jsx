import { useEffect, useRef, useState } from 'react';
import api from '../api';

// Fetch new private attachments with the existing auth client. Never place a JWT
// in an image/link URL. Legacy /uploads attachments keep their existing renderer.
export default function ChatSharedAttachment({url,name}) {
  const image=/\.(jpe?g|png|gif|webp)$/i.test(name || '');
  const [blobUrl,setBlobUrl]=useState(''),[error,setError]=useState(''),[retry,setRetry]=useState(0),[requested,setRequested]=useState(false);
  const host=useRef(null),downloadLink=useRef(null);
  useEffect(()=>{
    if(!image)return;
    const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){setRequested(true);observer.disconnect();}},{rootMargin:'100px'});
    if(host.current)observer.observe(host.current);
    return()=>observer.disconnect();
  },[image,url]);
  useEffect(()=>{
    if(!requested)return;
    let active=true,objectUrl;
    api.get(url.replace(/^\/api/,''),{responseType:'blob'}).then(({data})=>{
      if(!active)return;
      objectUrl=URL.createObjectURL(data);setBlobUrl(objectUrl);
    }).catch(()=>active && setError('File unavailable. Check your session or connection.'));
    return()=>{active=false;if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[url,retry,requested]);
  useEffect(()=>{if(blobUrl && !image)downloadLink.current?.click();},[blobUrl,image]);
  if(error)return <button onClick={()=>{setError('');setRetry(n=>n+1);}} className="text-xs text-red-700 underline">{error} Retry</button>;
  if(!blobUrl)return <button ref={host} onClick={()=>setRequested(true)} className="text-blue-700 underline mb-1 break-all">{requested?'Loading attachment…':`${name || 'Attachment'} · Open / download`}</button>;
  return <a ref={downloadLink} href={blobUrl} download={name || 'attachment'} className="block text-blue-700 underline mb-1 break-all">
    {image && <img src={blobUrl} alt={name} className="rounded max-h-52 max-w-full object-contain" />}
    {name || 'Attachment'} · Open / download
  </a>;
}
