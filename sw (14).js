// ─────────────────────────────────────────────────────────────────────────────
//  Manyuka Farm — Service Worker  (optimised)
//  Changes over previous version are marked  ← OPT: <reason>
// ─────────────────────────────────────────────────────────────────────────────

const CACHE      = '__APP_VERSION__';      // injected at deploy time by GitHub Actions
const DB_NAME    = 'manyuka-sw-db';
const DB_STORE   = 'kv';
const MAX_NOTIF_IDS   = 500;             // cap on stored notification IDs
const BG_FETCH_TIMEOUT_MS = 8_000;       // ← OPT: prevent runBackgroundCheck hanging forever

const VAPID_PUBLIC_KEY =
  'BCsYXlfhmqYCZEVuj-c3kqupK74_XmyVIK9Luq6Co9B2DYINBu6jugJO4jO3rk7gdCHfCgq5dglLg-HsY6EoItc';

// ── IndexedDB — single shared connection promise ──────────────────────────────
// ← OPT: previously openDB() opened a fresh connection on every dbGet/dbSet call.
//         Now we cache the promise so the DB is opened at most once per SW lifetime.
let _dbPromise = null;
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(DB_STORE);
    req.onsuccess       = e => res(e.target.result);
    req.onerror         = e => {
      _dbPromise = null;   // allow retry on next call
      rej(e.target.error);
    };
  });
  return _dbPromise;
}

async function dbGet(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
    req.onsuccess = e => res(e.target.result ?? null);  // ← OPT: explicit null instead of undefined
    req.onerror   = e => rej(e.target.error);
  });
}

async function dbSet(key, val) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(val, key);
    tx.oncomplete = () => res();
    tx.onerror    = e  => rej(e.target.error);
  });
}

// ← OPT: new helper — fetch with a timeout so background checks can't hang forever
function fetchWithTimeout(url, opts, ms = BG_FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache =>
      // ← OPT: removed duplicate './' entry — it resolves to the same resource as './index.html'
      cache.addAll(['./index.html']).catch(err => console.warn('[SW] install partial:', err))
    )
  );
  self.skipWaiting();
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    Promise.all([
      // Purge old caches
      caches.keys().then(keys =>
        Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
      ),
      self.clients.claim(),
    ]).then(() => {
      // Tell every open tab that a new version is active — they will reload
      return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then(clients => clients.forEach(c => c.postMessage({ type: 'NEW_VERSION', version: CACHE })));
    })
  );

  // Register periodic background sync (Chrome Android PWA only)
  self.registration.periodicSync?.register('manyuka-bg-check', {
    minInterval: 15 * 60 * 1000
  }).catch(() => {});
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const { url } = e.request;

  // Supabase API — GET reads get an empty-array fallback so loadAll() can
  // degrade gracefully offline. Everything else (POST/PATCH/DELETE — logins,
  // RPC calls like verify_login, and actual data writes) must be allowed to
  // fail for real: faking a success response here would make a failed write
  // look like it went through, and made offline login impossible to detect.
  if (url.includes('supabase.co')) {
    if (e.request.method !== 'GET') {
      e.respondWith(fetch(e.request));
      return;
    }
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response('[]', { headers: { 'Content-Type': 'application/json' } })
      )
    );
    return;
  }

  // App shell (index.html / root) — stale-while-revalidate
  if (
    url.includes('index.html') ||
    url.endsWith('/')           ||
    url.endsWith('/manyuka-farm/') ||
    url.endsWith('/manyuka-farm')
  ) {
    e.respondWith(staleWhileRevalidate(e.request));
    return;
  }

  // Everything else — network first, fall back to cache
  e.respondWith(networkFirstWithCache(e.request));
});

// ← OPT: extracted fetch strategies into named functions for readability + reuse
async function staleWhileRevalidate(request) {
  const cache       = await caches.open(CACHE);
  const cached      = await cache.match(request);
  const networkFetch = fetch(request)
    .then(res => { if (res.ok) cache.put(request, res.clone()); return res; })
    .catch(() => null);
  return cached ?? await networkFetch
    ?? new Response('App not cached yet. Please connect first.', { status: 503 });
}

async function networkFirstWithCache(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    return cache.match(request)
      ?? new Response('Offline', { status: 503 });  // ← OPT: explicit offline fallback instead of undefined
  }
}

// ── Background check ──────────────────────────────────────────────────────────
async function runBackgroundCheck() {
  // ← OPT: wrapped entire function in try/catch so one failure doesn't kill the SW event
  try {
    const creds = await dbGet('manyuka-creds');
    if (!creds?.sb || !creds?.sk || !creds?.userId) return;

    const headers = {
      'Content-Type': 'application/json',
      'apikey':        creds.sk,
      'Authorization': 'Bearer ' + creds.sk,
    };

    // ── Unread messages ──────────────────────────────────────────────────────
    const r = await fetchWithTimeout(   // ← OPT: timeout guard
      `${creds.sb}/rest/v1/messages?recipient_id=eq.${creds.userId}&is_read=eq.false&select=id,sender_name,subject,created_at`,
      { headers }
    );
    if (!r.ok) return;

    const msgs           = await r.json();
    const totalUnread    = msgs.length;

    // ← OPT: load notifiedIds once, build Set once
    const storedIds      = (await dbGet('manyuka-notified-ids')) || [];
    const notifiedSet    = new Set(storedIds);
    const newMsgs        = msgs.filter(m => !notifiedSet.has(m.id));

    // Update home-screen badge
    if ('setAppBadge' in self.registration) {
      totalUnread > 0
        ? await self.registration.setAppBadge(totalUnread)
        : await self.registration.clearAppBadge();
    }

    // Show a notification per new message
    for (const msg of newMsgs) {
      await self.registration.showNotification('💬 New Message — Manyuka Farm', {
        body:    `From ${msg.sender_name || 'Someone'}: ${(msg.subject || '').slice(0, 80)}`,
        icon:    '/icon-192.png',
        badge:   '/icon-192.png',
        tag:     'msg-' + msg.id,
        renotify: false,
        data:    { link: 'messages' },
        vibrate: [200, 100, 200],
      });
      notifiedSet.add(msg.id);
    }

    // Persist (capped) — ← OPT: only write if something actually changed
    if (newMsgs.length > 0) {
      await dbSet('manyuka-notified-ids', [...notifiedSet].slice(-MAX_NOTIF_IDS));
    }

    // ── No eggs logged today (past 10am Zimbabwe time) ─────────────────────
    const ZIM_OFFSET_MS = 2 * 60 * 60 * 1000; // CAT = UTC+2, no DST
    const zimNow = new Date(Date.now() + ZIM_OFFSET_MS);
    const todayZim = zimNow.getUTCFullYear()+'-'+String(zimNow.getUTCMonth()+1).padStart(2,'0')+'-'+String(zimNow.getUTCDate()).padStart(2,'0');
    const hourNow = zimNow.getUTCHours(); // Zimbabwe hour
    const eggKey  = 'no-eggs-' + todayZim;
    const alreadyShownEgg = await dbGet(eggKey);
    if (!alreadyShownEgg && hourNow >= 10) {
      try {
        const er = await fetchWithTimeout(
          `${creds.sb}/rest/v1/eggs?date=eq.${todayZim}&select=id&limit=1`,
          { headers }
        );
        if (er.ok) {
          const rows = await er.json();
          if (rows.length === 0) {
            await self.registration.showNotification('🐔 No Eggs Logged Yet — Manyuka Farm', {
              body:    `It's past 10am and no eggs have been recorded today — don't forget the morning collection`,
              icon:    '/icon-192.png',
              badge:   '/icon-192.png',
              tag:     'no-eggs-' + todayZim,
              data:    { link: 'eggs' },
              vibrate: [200, 100, 200],
            });
            await dbSet(eggKey, true);
          }
        }
      } catch { /* egg check is non-critical */ }
    }

    // ── Overdue orders ───────────────────────────────────────────────────────
    const today      = todayZim; // reuse Zimbabwe today for all remaining checks
    const overdueKey = 'overdue-' + today;

    // ← OPT: skip the network call entirely if we've already notified today
    const alreadyShown = await dbGet(overdueKey);
    if (!alreadyShown) {
      try {
        const or = await fetchWithTimeout(   // ← OPT: timeout guard
          `${creds.sb}/rest/v1/orders?status=eq.pending&due_date=lt.${today}&select=id,customer,due_date`,
          { headers }
        );
        if (or.ok) {
          const overdue = await or.json();
          if (overdue.length) {
            await self.registration.showNotification('🔴 Overdue Orders — Manyuka Farm', {
              body:    `${overdue.length} order${overdue.length > 1 ? 's' : ''} past due — check orders`,
              icon:    '/icon-192.png',
              badge:   '/icon-192.png',
              tag:     'overdue-orders',
              data:    { link: 'orders' },
              vibrate: [300, 100, 300],
            });
            await dbSet(overdueKey, true);
          }
        }
      } catch { /* overdue check is non-critical */ }
    }

  } catch (err) {
    console.warn('[SW] Background check failed:', err);
  }
}

// ── Periodic Background Sync ──────────────────────────────────────────────────
self.addEventListener('periodicsync', e => {
  if (e.tag === 'manyuka-bg-check') {
    e.waitUntil(runBackgroundCheck());
  }
});

// ── Push Notifications ────────────────────────────────────────────────────────
self.addEventListener('push', e => {
  let data = { title: 'Manyuka Enterprise', body: 'You have a new notification', link: '/' };
  try { if (e.data) data = e.data.json(); } catch (_) {}

  // ── Silent background sync push (no notification shown) ──────────────────
  // Sent by the sync-push Edge Function when another device saves data.
  // The SW runs a background check so all devices stay in sync automatically.
  if (data.type === 'BACKGROUND_SYNC') {
    e.waitUntil(runBackgroundCheck());
    return;
  }

  // ── Visible notification push ─────────────────────────────────────────────
  const options = {
    body:              data.body,
    icon:              '/icon-192.png',
    badge:             '/icon-192.png',
    data:              { link: data.link || '/' },
    vibrate:           [200, 100, 200],
    requireInteraction: data.type === 'alert',
    tag:               'manyuka-' + (data.link || 'notif'),
    renotify:          true,
    ...(data.actions ? { actions: data.actions } : {}),
  };

  if (typeof data.badge === 'number' && 'setAppBadge' in self.registration) {
    self.registration.setAppBadge(data.badge).catch(() => {});
  }

  e.waitUntil(
    self.registration.showNotification(data.title, options).then(() => {
      if (data.notifId && data.userId) {
        return self.clients
          .matchAll({ type: 'window', includeUncontrolled: true })
          .then(clients =>
            clients.forEach(c =>
              c.postMessage({ type: 'PUSH_DELIVERED', notifId: data.notifId, userId: data.userId })
            )
          );
      }
    })
  );
});

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const link      = e.notification.data?.link || '/';
  const targetUrl = self.registration.scope + '?notif=' + encodeURIComponent(link);

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url.includes('manyuka-farm'));
      if (existing) {
        existing.focus();
        existing.postMessage({ type: 'NOTIF_CLICK', link });
        return;   // ← OPT: early return avoids unnecessary openWindow check
      }
      return self.clients.openWindow?.(targetUrl);
    })
  );
});

// ── Messages from app ─────────────────────────────────────────────────────────
self.addEventListener('message', async e => {
  // ← OPT: guard against malformed message payloads
  if (!e.data || typeof e.data !== 'object') return;
  const { type } = e.data;

  if (type === 'STORE_CREDS') {
    const { sb, sk, userId, username } = e.data;
    // ← OPT: only write if all required fields present
    if (sb && sk && userId) {
      await dbSet('manyuka-creds', { sb, sk, userId, username });
    }
  }

  if (type === 'UPDATE_BADGE') {
    const count = e.data.count || 0;
    if ('setAppBadge' in self.registration) {
      count > 0
        ? self.registration.setAppBadge(count)
        : self.registration.clearAppBadge();
    }
  }

  if (type === 'RUN_CHECK') {
    await runBackgroundCheck();
  }
});

// ── Push subscription refresh ─────────────────────────────────────────────────
self.addEventListener('pushsubscriptionchange', e => {
  // ← OPT: was an immediately-invoked async function without error handling;
  //         now uses a proper named async function passed to waitUntil
  e.waitUntil(refreshPushSubscription());
});

async function refreshPushSubscription() {
  try {
    const creds = await dbGet('manyuka-creds');
    if (!creds) return;

    const sub     = await self.registration.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: VAPID_PUBLIC_KEY,
    });
    const subJSON = sub.toJSON();

    await fetch(`${creds.sb}/rest/v1/push_subscriptions`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':         creds.sk,
        'Authorization': 'Bearer ' + creds.sk,
        'Prefer':        'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        user_id:    creds.userId,
        endpoint:   subJSON.endpoint,
        p256dh:     subJSON.keys.p256dh,
        auth:       subJSON.keys.auth,
        updated_at: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.warn('[SW] pushsubscriptionchange failed:', err);
  }
}

/*
═══════════════════════════════════════════════════════════════
  SUPABASE EDGE FUNCTION — send-push/index.ts
  Deploy with: supabase functions deploy send-push
  Set secrets: supabase secrets set VAPID_PRIVATE_KEY=... VAPID_PUBLIC_KEY=...

  Triggered by a Supabase Database Webhook on INSERT to `messages`.
═══════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push';

const VAPID_PUBLIC_KEY  = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const SB_URL            = Deno.env.get('SUPABASE_URL')!;
const SB_SERVICE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

webpush.setVapidDetails('mailto:admin@manyukafarm.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

Deno.serve(async (req) => {
  const payload = await req.json();
  const record  = payload.record;

  const supabase = createClient(SB_URL, SB_SERVICE_KEY);
  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('*')
    .eq('user_id', record.recipient_id);

  const pushPayload = JSON.stringify({
    title: '💬 New Message — Manyuka Farm',
    body:  `From ${record.sender_name}: ${(record.subject || '').slice(0, 80)}`,
    link:  'messages',
    type:  'message',
  });

  for (const sub of (subs || [])) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        pushPayload
      );
    } catch (err) {
      if (err.statusCode === 410) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      }
    }
  }
  return new Response('ok');
});

═══════════════════════════════════════════════════════════════
  SUPABASE SQL — create push_subscriptions table
═══════════════════════════════════════════════════════════════

create table push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references app_users(id) on delete cascade,
  endpoint    text unique not null,
  p256dh      text not null,
  auth        text not null,
  updated_at  timestamptz default now()
);
alter table push_subscriptions enable row level security;
create policy "Users manage own subs" on push_subscriptions
  for all using (auth.uid() = user_id);

*/
