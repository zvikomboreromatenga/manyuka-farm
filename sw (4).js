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
