// Service Worker: macht Klang offline-fähig und installierbar.
// Bei Änderungen an der App die Versionsnummer erhöhen.
const CACHE = 'klang-v10';
const ASSETS = [
  './',
  'index.html',
  'css/style.css',
  'css/fonts.css',
  'fonts/barlow-400-latin.woff2',
  'fonts/barlow-500-latin.woff2',
  'fonts/barlow-600-latin.woff2',
  'fonts/oswald-latin.woff2',
  'js/vendor/gsap.min.js',
  'js/vendor/ScrollTrigger.min.js',
  'js/vendor/SplitText.min.js',
  'js/vendor/lenis.min.js',
  'js/app.js',
  'js/db.js',
  'js/tags.js',
  'js/icons.js',
  'js/online.js',
  'js/auth.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Stale-while-revalidate: sofort aus dem Cache, im Hintergrund aktualisieren.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Musik-Ordner vom lokalen Server: Liste immer frisch, Audio direkt streamen (Teil-Antworten,
  // große Dateien) – beides nie über den Cache leiten.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/music/') || req.headers.has('range')) return;

  const network = fetch(req)
    .then(async (res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        const c = await caches.open(CACHE);
        await c.put(req, res.clone());
      }
      return res;
    })
    .catch(() => null);

  e.waitUntil(network.then(() => undefined));
  e.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    const res = await network;
    if (res) return res;
    if (req.mode === 'navigate') return (await caches.match('index.html')) || Response.error();
    return Response.error();
  })());
});
