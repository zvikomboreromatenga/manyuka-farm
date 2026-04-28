// Manyuka Farm Service Worker
// Caches the app shell so it loads offline
const CACHE = 'manyuka-v1';
const URLS = [
  '/manyuka-farm/',
  '/manyuka-farm/index.html',
];

// Install: cache the app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(URLS))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: serve from cache first, fall back to network
// For Supabase API calls — always go to network (never cache data requests)
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Never cache Supabase API calls — always go to network
  if(url.includes('supabase.co')){
    e.respondWith(fetch(e.request).catch(() => new Response('{"error":"offline"}', {
      headers: {'Content-Type': 'application/json'}
    })));
    return;
  }

  // For Google Fonts — network first, cache fallback
  if(url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')){
    e.respondWith(
      fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(cache => cache.put(e.request, clone));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // App shell — cache first, network fallback, update cache in background
  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request).then(res => {
        // Update cache with fresh version
        if(res.ok){
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => cached); // offline: return cached

      // Return cached immediately if available, otherwise wait for network
      return cached || networkFetch;
    })
  );
});
