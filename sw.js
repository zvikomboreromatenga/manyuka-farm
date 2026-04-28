const CACHE = 'manyuka-v4';

// Tiny offline fallback shown when app isn't cached yet
const OFFLINE_HTML = `<!DOCTYPE html><html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Manyuka Farm</title>
<style>
  body{font-family:sans-serif;background:#faf9f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}
  .card{background:#fff;border-radius:14px;padding:32px 24px;max-width:320px;width:100%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  h1{font-size:20px;color:#3B6D11;margin:12px 0 6px}
  p{font-size:13px;color:#888780;line-height:1.6;margin:0 0 20px}
  button{background:#3B6D11;color:#fff;border:none;border-radius:8px;padding:12px 24px;font-size:14px;font-weight:700;cursor:pointer;width:100%}
</style>
</head>
<body>
<div class="card">
  <div style="font-size:48px">🌿</div>
  <h1>Manyuka Farm</h1>
  <p>The app needs to download once on a good connection before it can work offline.<br><br>Please connect to WiFi or better data, then tap Retry.</p>
  <button onclick="location.reload()">↺ Retry</button>
</div>
</body></html>`;

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => {
      // Cache app files + store offline fallback
      return Promise.allSettled([
        cache.addAll(['./', './index.html', './sw.js', './icon.png']),
        cache.put('/__offline', new Response(OFFLINE_HTML, {
          headers: {'Content-Type': 'text/html'}
        }))
      ]);
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

  // Supabase — network only, never cache
  if(url.includes('supabase.co')){
    e.respondWith(
      fetch(e.request, {signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined})
        .catch(() => new Response('[]', {headers: {'Content-Type': 'application/json'}}))
    );
    return;
  }

  // Fonts — network first, cache fallback
  if(url.includes('fonts.gstatic.com') || url.includes('fonts.googleapis.com')){
    e.respondWith(
      caches.open(CACHE).then(cache =>
        fetch(e.request)
          .then(res => { if(res.ok) cache.put(e.request, res.clone()); return res; })
          .catch(() => cache.match(e.request))
      )
    );
    return;
  }

  // App shell — CACHE FIRST: serve instantly, update in background
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request).then(cached => {
        // Always fetch fresh in background (stale-while-revalidate)
        const networkFetch = fetch(e.request)
          .then(res => {
            if(res.ok) cache.put(e.request, res.clone());
            return res;
          })
          .catch(() => null);

        if(cached){
          // Serve cached version instantly — background fetch updates for next visit
          networkFetch; // fire and forget
          return cached;
        }

        // Nothing cached — wait for network
        return networkFetch.then(res => {
          if(res) return res;
          // Network failed AND no cache — show friendly offline page
          return cache.match('/__offline');
        });
      })
    )
  );
});
