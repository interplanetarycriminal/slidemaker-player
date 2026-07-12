/* sw.js — SlideMaker service worker: offline app shell for the installed PWA.
 * Precaches the app code/CSS/icons so the tool launches and runs offline on the
 * tablet. Generated video/image assets (IndexedDB blobs) and OpenRouter API
 * calls are NOT cached — they require network + the user's key. Bump CACHE to
 * ship an update (old caches are pruned on activate). */
const CACHE = 'slidemaker-v3';

const SHELL = [
  './',
  'index.html',
  'studio.html',
  'css/player.css',
  'css/studio.css',
  'css/themes.css',
  'css/director.css',
  'css/tablet.css',
  'js/app.js',
  'js/player.js',
  'js/preload.js',
  'js/grid.js',
  'js/theme.js',
  'js/grammar.js',
  'js/openrouter-client.js',
  'js/studio.js',
  'js/studio-db.js',
  'js/director.js',
  'js/tablet.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll is atomic; use individual puts so one missing file can't abort install
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // never cache POSTs (OpenRouter jobs, etc.)
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let cross-origin (OpenRouter/CDN) hit network
  // Cache-first for the app shell; fall back to network and cache new same-origin GETs.
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('studio.html', { ignoreSearch: true }));
    }),
  );
});
