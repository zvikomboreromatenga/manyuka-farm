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

// ── Scheduled digests (daily admin summary + weekly all-hands summary) ────────
// Runs from inside runBackgroundCheck() so it rides the same cadence as the
// existing message/eggs/orders checks. Best-effort: only as reliable as the
// browser's own background-check scheduling (see periodicSync limitations
// noted at its registration below).
const ITEM_LABELS_SW = {
  fertile_eggs:'Fertile Eggs (BA)', table_eggs:'Table Eggs (Layer)', chicks:'Chicks',
  ba_cocks:'BA Cocks', goats:'Goats', manure:'Manure', car_hire:'Car Hire', other:'Other', eggs:'BA Eggs'
};
function fmtEggsSW(n){
  const e = parseInt(n)||0;
  const crates = Math.floor(e/30), rem = e%30;
  return crates>0 ? `${crates}cr ${rem}` : `${e}`;
}
function fmtMoneySW(n){ const v=parseFloat(n); return '$'+(isNaN(v)?'0.00':v.toFixed(2)); }
function addDaysSW(dateStr, n){
  const d = new Date(dateStr+'T12:00:00');
  d.setDate(d.getDate()+n);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

async function digestAlreadySentToday(creds, headers, senderId, today){
  try{
    const r = await fetchWithTimeout(
      `${creds.sb}/rest/v1/messages?sender_id=eq.${senderId}&recipient_id=eq.${encodeURIComponent(creds.userId)}&select=created_at&order=created_at.desc&limit=1`,
      { headers }
    );
    if (!r.ok) return false; // can't tell — err toward allowing the send rather than silently skipping
    const rows = await r.json();
    if (!rows.length) return false;
    return String(rows[0].created_at).slice(0,10) === today;
  }catch(_){ return false; }
}

async function sendDigestMessage(creds, headers, senderId, recipientId, recipientName, subject, body){
  await fetchWithTimeout(`${creds.sb}/rest/v1/messages`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      id: crypto.randomUUID ? crypto.randomUUID() : (Date.now()+'-'+Math.random().toString(36).slice(2)),
      created_at: new Date().toISOString(),
      sender_id: senderId, sender_name: 'Manyuka Farm',
      recipient_id: recipientId, recipient_name: recipientName || '',
      subject, body, thread_id: (crypto.randomUUID ? crypto.randomUUID() : (Date.now()+'-t')),
      is_read: false, reply_to: null
    })
  });
}

async function checkScheduledDigest(creds, headers) {
  const now = new Date(); // device-local time, same convention the page uses
  const hh = now.getHours(), mm = now.getMinutes(), dow = now.getDay(); // 0=Sunday
  const today = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');

  const pastDigestTime = hh > 19 || (hh === 19 && mm >= 30);
  const pastSummaryTime = dow === 0 && (hh > 12 || (hh === 12 && mm >= 0));
  if (!pastDigestTime && !pastSummaryTime) return; // nothing to do yet, skip the extra fetches

  // Who is this device's user, and what's their role?
  const ur = await fetchWithTimeout(
    `${creds.sb}/rest/v1/app_users_public?id=eq.${encodeURIComponent(creds.userId)}&select=id,display_name,username,role`,
    { headers }
  );
  if (!ur.ok) return;
  const urows = await ur.json();
  const me = urows[0];
  if (!me) return;
  const myName = me.display_name || me.username || 'there';

  // ── Daily digest — admin + main_admin only, after 7:30pm, once per day ──
  if (pastDigestTime && (me.role === 'admin' || me.role === 'main_admin')) {
    const flagKey = 'daily-digest-' + today + '-' + creds.userId;
    const alreadyLocally = await dbGet(flagKey);
    if (!alreadyLocally && !(await digestAlreadySentToday(creds, headers, 'system-daily-digest', today))) {
      try {
        const tomorrow = addDaysSW(today, 1);

        const [salesR, eggsR, layerEggsR, incubatorR, vaccR, tickR, ordersR, pendingR] = await Promise.all([
          fetchWithTimeout(`${creds.sb}/rest/v1/sales?select=item,buyer,amount,amount_paid,fully_paid,payment_due_date&order=created_at.desc&limit=500`, { headers }),
          fetchWithTimeout(`${creds.sb}/rest/v1/eggs?date=eq.${today}&select=id&limit=1`, { headers }),
          fetchWithTimeout(`${creds.sb}/rest/v1/layer_eggs?date=eq.${today}&select=id&limit=1`, { headers }),
          fetchWithTimeout(`${creds.sb}/rest/v1/incubator?status=eq.incubating&hatch_date=eq.${tomorrow}&select=egg_count`, { headers }),
          fetchWithTimeout(`${creds.sb}/rest/v1/vaccinations?next_due=eq.${tomorrow}&select=vaccine_name,animal_group`, { headers }),
          fetchWithTimeout(`${creds.sb}/rest/v1/tick_treatments?next_due=eq.${tomorrow}&select=treatment_name`, { headers }),
          fetchWithTimeout(`${creds.sb}/rest/v1/orders?due_date=eq.${tomorrow}&status=neq.delivered&select=customer`, { headers }),
          fetchWithTimeout(`${creds.sb}/rest/v1/pending_changes?assigned_to=eq.${encodeURIComponent(creds.userId)}&status=eq.pending&select=record_label,table_name`, { headers }),
        ]);

        const sales = salesR.ok ? await salesR.json() : [];
        const baLogged = eggsR.ok ? (await eggsR.json()).length > 0 : true; // assume logged if check failed, avoid false alarms
        const layerLogged = layerEggsR.ok ? (await layerEggsR.json()).length > 0 : true;
        const hatches = incubatorR.ok ? await incubatorR.json() : [];
        const vaccs = vaccR.ok ? await vaccR.json() : [];
        const ticks = tickR.ok ? await tickR.json() : [];
        const ordersDue = ordersR.ok ? await ordersR.json() : [];
        const assigned = pendingR.ok ? await pendingR.json() : [];

        const outstanding = sales.filter(s => {
          const total = s.amount||0, paid = s.amount_paid!=null?s.amount_paid:total;
          return !s.fully_paid && paid<total;
        });
        const dueToday = outstanding.filter(s => s.payment_due_date === today);
        const overdue15 = outstanding.filter(s => {
          if (!s.payment_due_date || s.payment_due_date === today) return false;
          const days = Math.floor((new Date(today) - new Date(s.payment_due_date)) / 86400000);
          return days >= 15;
        });

        const lines = [`Hi ${myName}, here's your evening check-in:\n`];

        if (dueToday.length || overdue15.length) {
          lines.push(`⏳ Outstanding payments needing attention:`);
          dueToday.forEach(s => {
            const bal = (s.amount||0) - (s.amount_paid||0);
            lines.push(`  • Due TODAY — ${ITEM_LABELS_SW[s.item]||s.item||'Sale'}${s.buyer?' to '+s.buyer:''}, ${fmtMoneySW(bal)} owed`);
          });
          overdue15.forEach(s => {
            const bal = (s.amount||0) - (s.amount_paid||0);
            const days = Math.floor((new Date(today) - new Date(s.payment_due_date)) / 86400000);
            lines.push(`  • ${days} days overdue — ${ITEM_LABELS_SW[s.item]||s.item||'Sale'}${s.buyer?' to '+s.buyer:''}, ${fmtMoneySW(bal)} owed`);
          });
          lines.push(`  Does the due date need adjusting, or is follow-up already happening?`);
        } else {
          lines.push(`⏳ No overdue or due-today payments — nice.`);
        }

        if (!baLogged || !layerLogged) {
          lines.push(`\n📝 Reminder: ${!baLogged&&!layerLogged?'BA and Layer eggs haven\'t':(!baLogged?'BA eggs haven\'t':'Layer eggs haven\'t')} been logged today yet.`);
        }

        const tasks = [];
        hatches.forEach(h => tasks.push(`🐣 Hatch due — ${h.egg_count} eggs`));
        vaccs.forEach(v => tasks.push(`💉 ${v.vaccine_name||'Vaccination'} due — ${v.animal_group||'flock'}`));
        ticks.forEach(t => tasks.push(`🪲 ${t.treatment_name||'Tick treatment'} due`));
        ordersDue.forEach(o => tasks.push(`📦 Order due — ${o.customer||'customer'}`));
        if (tasks.length) {
          lines.push(`\n📅 Tomorrow:`);
          tasks.forEach(t => lines.push('  • '+t));
        }

        if (assigned.length) {
          lines.push(`\n✅ Approvals assigned to you (${assigned.length}):`);
          assigned.forEach(p => lines.push('  • ' + (p.record_label || p.table_name)));
        }

        await sendDigestMessage(creds, headers, 'system-daily-digest', creds.userId, myName, '📊 Daily Summary', lines.join('\n'));
        await dbSet(flagKey, true);

        await self.registration.showNotification('📊 Daily Summary — Manyuka Farm', {
          body: 'Your evening check-in is ready — outstanding payments, tomorrow\'s tasks, and more.',
          icon: '/icon-192.png', badge: '/icon-192.png',
          tag: 'daily-digest-' + today, data: { link: 'messages' }, vibrate: [200,100,200],
        });
      } catch (err) { console.warn('[SW] daily digest failed:', err); }
    }
  }

  // ── Weekly summary — everyone, Sunday after noon, once per week ──
  if (pastSummaryTime) {
    const flagKey = 'weekly-summary-' + today + '-' + creds.userId;
    const alreadyLocally = await dbGet(flagKey);
    if (!alreadyLocally && !(await digestAlreadySentToday(creds, headers, 'system-weekly-summary', today))) {
      try {
        const weekAgo = addDaysSW(today, -6);
        const inWeek = ds => ds >= weekAgo && ds <= today;

        const [salesR, layerSalesR, expR, eggsR, layerEggsR, birdMortR, goatMortR, kidsR, ordersR] = await Promise.all([
          fetchWithTimeout(`${creds.sb}/rest/v1/sales?select=item,qty,date&order=created_at.desc&limit=500`, { headers }),
          fetchWithTimeout(`${creds.sb}/rest/v1/layer_sales?select=qty,date&order=created_at.desc&limit=500`, { headers }),
          fetchWithTimeout(`${creds.sb}/rest/v1/expenses?select=category,date&order=created_at.desc&limit=500`, { headers }),
          fetchWithTimeout(`${creds.sb}/rest/v1/eggs?select=count,date&order=created_at.desc&limit=500`, { headers }),
          fetchWithTimeout(`${creds.sb}/rest/v1/layer_eggs?select=count,date&order=created_at.desc&limit=500`, { headers }),
          fetchWithTimeout(`${creds.sb}/rest/v1/bird_mortality?select=count,cause,date&order=created_at.desc&limit=500`, { headers }),
          fetchWithTimeout(`${creds.sb}/rest/v1/goat_mortality?select=count,cause,date&order=created_at.desc&limit=500`, { headers }),
          fetchWithTimeout(`${creds.sb}/rest/v1/goat_kids?select=kid_count,date&order=created_at.desc&limit=500`, { headers }),
          fetchWithTimeout(`${creds.sb}/rest/v1/orders?select=id,date&order=created_at.desc&limit=500`, { headers }),
        ]);

        const sales = (salesR.ok ? await salesR.json() : []).filter(r => inWeek(r.date));
        const layerSales = (layerSalesR.ok ? await layerSalesR.json() : []).filter(r => inWeek(r.date));
        const expenses = (expR.ok ? await expR.json() : []).filter(r => inWeek(r.date));
        const eggs = (eggsR.ok ? await eggsR.json() : []).filter(r => inWeek(r.date)).reduce((s,r)=>s+(r.count||0),0);
        const layerEggs = (layerEggsR.ok ? await layerEggsR.json() : []).filter(r => inWeek(r.date)).reduce((s,r)=>s+(r.count||0),0);
        const birdMort = (birdMortR.ok ? await birdMortR.json() : []).filter(r => inWeek(r.date) && r.cause!=='cock_sale' && r.cause!=='sold').reduce((s,r)=>s+(r.count||0),0);
        const goatMort = (goatMortR.ok ? await goatMortR.json() : []).filter(r => inWeek(r.date) && r.cause!=='sold').reduce((s,r)=>s+(r.count||0),0);
        const kids = (kidsR.ok ? await kidsR.json() : []).filter(r => inWeek(r.date)).reduce((s,r)=>s+(r.kid_count||0),0);
        const orders = (ordersR.ok ? await ordersR.json() : []).filter(r => inWeek(r.date));

        const lines = [`Here's what happened on the farm this past week:\n`];

        if (sales.length || layerSales.length) {
          const byItem = {};
          sales.forEach(r => { const k = ITEM_LABELS_SW[r.item]||r.item||'items'; byItem[k]=(byItem[k]||0)+(r.qty||0); });
          lines.push('💰 Sales:');
          Object.entries(byItem).forEach(([item,qty]) => lines.push(`  • Sold ${qty} ${item}`));
          if (layerSales.length) {
            const eggQty = layerSales.reduce((s,r)=>s+(r.qty||0),0);
            lines.push(`  • Sold ${fmtEggsSW(eggQty)} layer eggs`);
          }
        } else lines.push('💰 Sales: none this week');

        if (expenses.length) {
          lines.push('\n💸 Expenses:');
          const cats = {};
          expenses.forEach(r => { const k=(r.category||'other').replace(/_/g,' '); cats[k]=(cats[k]||0)+1; });
          Object.entries(cats).forEach(([cat,n]) => lines.push(`  • ${cat} (${n})`));
        }

        lines.push(`\n🥚 Eggs collected: ${fmtEggsSW(eggs)} BA, ${fmtEggsSW(layerEggs)} Layer`);
        if (birdMort || goatMort) lines.push(`\n🪦 Losses: ${birdMort} birds, ${goatMort} goats`);
        if (kids) lines.push(`\n🐐 Goat kids born: ${kids}`);
        if (orders.length) lines.push(`\n📦 New orders: ${orders.length}`);

        await sendDigestMessage(creds, headers, 'system-weekly-summary', creds.userId, myName, '📅 Weekly Summary', lines.join('\n'));
        await dbSet(flagKey, true);

        await self.registration.showNotification('📅 Weekly Summary — Manyuka Farm', {
          body: 'This week\'s farm summary is ready.',
          icon: '/icon-192.png', badge: '/icon-192.png',
          tag: 'weekly-summary-' + today, data: { link: 'messages' }, vibrate: [200,100,200],
        });
      } catch (err) { console.warn('[SW] weekly summary failed:', err); }
    }
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

    // ── Scheduled digests (daily 7:30pm admin summary, Sunday noon all-hands) ──
    // Runs first and independently — a failure here shouldn't block the rest
    // of the background check (messages/eggs/orders below).
    await checkScheduledDigest(creds, headers).catch(err => console.warn('[SW] digest check failed:', err));

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
