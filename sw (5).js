const CACHE = 'manyuka-v5';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => {
      return cache.addAll(['./', './index.html']).catch(err => {
        console.warn('SW install partial:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  if(url.includes('supabase.co')){
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response('[]', {headers: {'Content-Type': 'application/json'}})
      )
    );
    return;
  }

  if(url.includes('index.html') || url.endsWith('/') || url.endsWith('/manyuka-farm/') || url.endsWith('/manyuka-farm')){
    e.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          const networkFetch = fetch(e.request)
            .then(res => {
              if(res.ok && res.status === 200){
                cache.put(e.request, res.clone());
              }
              return res;
            })
            .catch(() => null);
          if(cached){
            return cached;
          }
          return networkFetch || new Response('App not cached yet. Please connect to internet first.', {status: 503});
        })
      )
    );
    return;
  }

  e.respondWith(
    caches.open(CACHE).then(cache =>
      fetch(e.request)
        .then(res => {
          if(res.ok) cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => cache.match(e.request))
    )
  );
});

// ── Push Notifications ────────────────────────────────────────
self.addEventListener('push', e => {
  let data = { title: 'Manyuka Enterprise', body: 'You have a new notification', link: '/' };
  try { if(e.data) data = e.data.json(); } catch(_) {}

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { link: data.link || '/' },
      vibrate: [200, 100, 200],
      requireInteraction: data.type === 'alert',
      tag: 'manyuka-' + (data.link || 'notif'),
      renotify: true
    })
  );
});

// ── Notification click → open/focus app ──────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const link = (e.notification.data && e.notification.data.link) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for(const client of clients){
        if('focus' in client){
          client.focus();
          client.postMessage({ type: 'NOTIF_CLICK', link });
          return;
        }
      }
      if(self.clients.openWindow){
        return self.clients.openWindow('/?notif=' + encodeURIComponent(link));
      }
    })
  );
});

// ── App icon badge count (from app via postMessage) ───────────
self.addEventListener('message', e => {
  if(e.data && e.data.type === 'UPDATE_BADGE'){
    const count = e.data.count || 0;
    if('setAppBadge' in self.registration){
      if(count > 0) self.registration.setAppBadge(count);
      else self.registration.clearAppBadge();
    }
  }
});
