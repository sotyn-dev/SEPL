const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// A fixed chat-only return path; never accept arbitrary redirect URLs.
export function chatShareLoginPath() {
  const id=new URLSearchParams(window.location.search).get('draft');
  return window.location.pathname === '/site-chat/share' ? `/login?chatShare=${UUID.test(id || '') ? id : 'pending'}` : '/login';
}
export function afterChatShareLogin() {
  const id=new URLSearchParams(window.location.search).get('chatShare');
  return UUID.test(id || '') ? `/site-chat/share?draft=${id}` : id === 'pending' ? '/site-chat/share' : '/';
}
