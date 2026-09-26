// Service Worker — receives push messages even when the ERP tab is
// closed and shows a desktop / phone notification. On click it tries
// to focus an already-open ERP tab, otherwise opens a new one to the
// notification's deep link.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// The chat page sends the server-confirmed read marker after loading a thread.
// Close only that conversation's read notifications, preserving newer alerts.
self.addEventListener('message', (event) => {
  const data = event.data;
  if (data?.type !== 'chat_read' || !Number.isSafeInteger(data.groupId) || data.groupId <= 0 ||
      !Number.isSafeInteger(data.lastReadId) || data.lastReadId <= 0) return;
  event.waitUntil(self.registration.getNotifications().then(notifications => {
    for (const notification of notifications) {
      const message = notification.data;
      if (message?.type === 'site_chat' && Number(message.groupId) === data.groupId &&
          Number(message.messageId) > 0 && Number(message.messageId) <= data.lastReadId) notification.close();
    }
  }));
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'SEPL ERP', body: event.data ? event.data.text() : 'New notification' };
  }
  const title = data.title || 'SEPL ERP';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    tag: data.tag || 'sepl-erp',
    // Request an audible alert, including when replacing the test notification.
    // The OS still controls sound volume, silent mode and notification channels.
    silent: false,
    renotify: true,
    requireInteraction: !!data.requireInteraction,
    data: { url: data.url || '/', ...data },
    vibrate: [120, 60, 120],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Focus an already-open ERP tab if one exists
      for (const client of clientList) {
        try {
          const u = new URL(client.url);
          if (u.origin === self.location.origin) {
            client.focus();
            client.postMessage({ type: 'navigate', url: targetUrl });
            return;
          }
        } catch {}
      }
      // Otherwise open a fresh tab
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
