const CACHE = 'manyuka-v2';

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

  // Never cache Supabase API calls
  if(url.includes('supabase.co')){
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify([]), {headers:{'Content-Type':'application/json'}})
      )
    );
    return;
  }

  // App shell — cache first, background update
  if(url.includes('index.html') || url.endsWith('/') || url.endsWith('sw.js')){
    e.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          const net = fetch(e.request).then(res => {
            if(res.ok) cache.put(e.request, res.clone());
            return res;
          }).catch(() => cached);
          return cached || net;
        })
      )
    );
    return;
  }

  // Everything else — network first, cache fallback
  e.respondWith(
    fetch(e.request).then(res => {
      if(res.ok){
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
