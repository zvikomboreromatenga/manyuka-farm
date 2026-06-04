const CACHE = 'manyuka-v5';
const DB_NAME = 'manyuka-sw-db';
const DB_STORE = 'kv';

// ── IndexedDB helpers (SW cannot use localStorage) ───────────
function openDB(){
  return new Promise((res,rej)=>{
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(DB_STORE);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}
async function dbGet(key){
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx  = db.transaction(DB_STORE,'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}
async function dbSet(key, val){
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx = db.transaction(DB_STORE,'readwrite');
    tx.objectStore(DB_STORE).put(val, key);
    tx.oncomplete = () => res();
    tx.onerror    = e  => rej(e.target.error);
  });
}

// ── Install ───────────────────────────────────────────────────
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

// ── Activate ──────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
  // Register periodic background sync if supported (Chrome Android PWA)
  self.registration.periodicSync?.register('manyuka-bg-check', {
    minInterval: 15 * 60 * 1000
  }).catch(() => {});
});

// ── Fetch (your original strategy — untouched) ────────────────
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

// ── Background check (runs when app is closed) ───────────────
async function runBackgroundCheck(){
  const creds = await dbGet('manyuka-creds');
  if(!creds || !creds.sb || !creds.sk || !creds.userId) return;

  const headers = {
    'Content-Type': 'application/json',
    'apikey': creds.sk,
    'Authorization': 'Bearer ' + creds.sk
  };

  try{
    // Check unread messages
    const r = await fetch(
      `${creds.sb}/rest/v1/messages?recipient_id=eq.${creds.userId}&is_read=eq.false&select=id,sender_name,subject,created_at`,
      {headers}
    );
    if(!r.ok) return;
    const msgs = await r.json();

    // Deduplicate — only notify for messages not already shown
    const notifiedIds = (await dbGet('manyuka-notified-ids')) || [];
    const notifiedSet = new Set(notifiedIds);
    const newMsgs = msgs.filter(m => !notifiedSet.has(m.id));
    const totalUnread = msgs.length;

    // Update home screen badge
    if('setAppBadge' in self.registration){
      if(totalUnread > 0) await self.registration.setAppBadge(totalUnread);
      else await self.registration.clearAppBadge();
    }

    // Show lock screen notification for each new message
    for(const msg of newMsgs){
      await self.registration.showNotification('💬 New Message — Manyuka Farm', {
        body: `From ${msg.sender_name || 'Someone'}: ${(msg.subject || '').slice(0, 80)}`,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: 'msg-' + msg.id,
        renotify: false,
        data: { link: 'messages' },
        vibrate: [200, 100, 200]
      });
      notifiedSet.add(msg.id);
    }

    // Save updated notified IDs (cap at 500)
    await dbSet('manyuka-notified-ids', [...notifiedSet].slice(-500));

    // Check overdue orders
    try{
      const today = new Date().toISOString().slice(0, 10);
      const or = await fetch(
        `${creds.sb}/rest/v1/orders?status=eq.pending&due_date=lt.${today}&select=id,customer,due_date`,
        {headers}
      );
      if(or.ok){
        const overdue = await or.json();
        if(overdue.length){
          const overdueKey = 'overdue-' + today;
          const alreadyShown = await dbGet(overdueKey);
          if(!alreadyShown){
            await self.registration.showNotification('🔴 Overdue Orders — Manyuka Farm', {
              body: `${overdue.length} order${overdue.length > 1 ? 's' : ''} past due date — check orders`,
              icon: '/icon-192.png',
              badge: '/icon-192.png',
              tag: 'overdue-orders',
              data: { link: 'orders' },
              vibrate: [300, 100, 300]
            });
            await dbSet(overdueKey, true);
          }
        }
      }
    }catch(e){}

  }catch(e){
    console.warn('[SW] Background check failed:', e);
  }
}

// ── Periodic Background Sync (Chrome Android PWA) ─────────────
self.addEventListener('periodicsync', e => {
  if(e.tag === 'manyuka-bg-check'){
    e.waitUntil(runBackgroundCheck());
  }
});

// ── Push Notifications (your original — untouched) ────────────
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

// ── Notification click (your original — untouched) ────────────
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

// ── Messages from app ─────────────────────────────────────────
self.addEventListener('message', async e => {
  // Store Supabase credentials so SW can query independently when app is closed
  if(e.data && e.data.type === 'STORE_CREDS'){
    await dbSet('manyuka-creds', {
      sb: e.data.sb,
      sk: e.data.sk,
      userId: e.data.userId,
      username: e.data.username
    });
  }

  // Badge count update from app (your original UPDATE_BADGE — untouched)
  if(e.data && e.data.type === 'UPDATE_BADGE'){
    const count = e.data.count || 0;
    if('setAppBadge' in self.registration){
      if(count > 0) self.registration.setAppBadge(count);
      else self.registration.clearAppBadge();
    }
  }

  // Immediate background check trigger (e.g. when app is backgrounded)
  if(e.data && e.data.type === 'RUN_CHECK'){
    await runBackgroundCheck();
  }
});
