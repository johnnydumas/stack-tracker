const CACHE_NAME = 'stack-shell-v5';
const SHELL_FILES = ['/', '/index.html', '/style.css', '/app.js', '/shared/time.js', '/manifest.json', '/print.html', '/print.css', '/print.js'];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// App files: network first, so a new deploy is picked up immediately and old
// and new files never get mixed. The cache is only a fallback when offline
// or when the network is very slow. API calls are never cached.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(networkFirst(event.request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const network = fetch(request).then((res) => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch {
    // offline — fall through to cache
  }
  const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
  return cached || network;
}

self.addEventListener('push', (event) => {
  let payload = { title: 'Stack', body: 'You have an activity update.' };
  try {
    payload = { ...payload, ...event.data.json() };
  } catch {
    // fall back to defaults above
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag || 'stack-notification',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { activityId: payload.activityId || null },
      renotify: true,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const activityId = event.notification.data?.activityId;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          if (activityId) client.postMessage({ type: 'open-activity', activityId });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(activityId ? `/?activity=${encodeURIComponent(activityId)}` : '/');
      }
    })
  );
});
