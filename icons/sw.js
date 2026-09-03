/* ═══════════════════════════════════════════════════════════════
   OHT Service Worker
   ZAROORI USOOL: Ye sirf STATIC files (HTML/manifest/icons) cache
   karta hai — kabhi bhi Supabase ya kisi API-call ko na cache karta
   hai, na "background" mein dobara bhejta hai. Har accounting-save
   hamesha seedha internet se, live jata hai — koi duplicate ka khatra
   nahi. Version badhane ke liye sirf CACHE_VERSION number badlein.
   ═══════════════════════════════════════════════════════════════ */

var CACHE_VERSION = 'oht-shell-v1';

var SHELL_FILES = [
  './',
  './index.html',
  './masters.html',
  './billing.html',
  './daily-ledger.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(SHELL_FILES);
    })
  );
  // Naya SW turant "waiting" state mein na atka rahe — lekin activate
  // hone ke baad bhi hum kabhi bhi khud page ko reload force nahi karte
  // (wo faisla page ke JS/user par chhoda hai — dekhein index.html)
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (n) { return n !== CACHE_VERSION; })
             .map(function (n) { return caches.delete(n); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var url = event.request.url;

  // ZAROORI GUARD: koi bhi Supabase call, ya koi bhi GET-se-alag method
  // (POST/PUT/PATCH/DELETE) — seedha network se, kabhi cache se nahi,
  // kabhi bhi service-worker "background sync" ki koshish nahi karega.
  if (event.request.method !== 'GET') return;
  if (url.indexOf('supabase.co') !== -1) return;
  if (url.indexOf('/rest/v1/') !== -1 || url.indexOf('/auth/v1/') !== -1 || url.indexOf('/rpc/') !== -1) return;

  // Sirf apni hi site ki static files ke liye kuch karo
  if (url.indexOf(self.location.origin) !== 0) return;

  var isHtml = /\.html$|\/$/.test(url.split('?')[0]);

  if (isHtml) {
    // ZAROORI: HTML files (index/masters/billing/daily-ledger) ke liye
    // hamesha PEHLE INTERNET try karo — taake koi bhi naya deploy turant
    // milta rahe (bilkul jaisa Service Worker ke bina hota hai). Cache
    // sirf tab kaam aaye jab internet bilkul na ho.
    event.respondWith(
      fetch(event.request).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_VERSION).then(function (cache) { cache.put(event.request, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(event.request);
      })
    );
    return;
  }

  // Icons/manifest jaisi cheezein — kam badalti hain, is liye "cache-first"
  // theek hai (tez khulti hain, background mein khud refresh bhi ho jati hain)
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var networkFetch = fetch(event.request).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_VERSION).then(function (cache) { cache.put(event.request, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || networkFetch;
    })
  );
});

// Page se "SKIP_WAITING" message aaye (jab user "Update" button dabaye)
self.addEventListener('message', function (event) {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
