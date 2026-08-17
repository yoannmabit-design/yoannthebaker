/* ============================================================
   Service worker — Yoann's French Bakery Gestion

   Stratégie « réseau d'abord » : la page fraîche l'emporte toujours,
   le cache ne sert que si le réseau est indisponible. C'est le seul
   moyen d'avoir l'application hors ligne sans jamais servir une
   version périmée après un déploiement.

   Firestore et les SDK Firebase ne sont jamais mis en cache : ils
   gèrent leur propre hors-ligne.
   ============================================================ */

const VERSION = 'yfb-gestion-v1';
const ESSENTIELS = [
  './',
  './index.html',
  './manifest.json',
  './logo.png'
];

self.addEventListener('install', (e) => {
  // Une nouvelle version prend la main sans attendre la fermeture des onglets.
  self.skipWaiting();
  e.waitUntil(
    caches.open(VERSION).then(c => c.addAll(ESSENTIELS)).catch(() => {})
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(noms => Promise.all(
        noms.filter(n => n !== VERSION).map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // Seules les requêtes GET de même origine sont concernées.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then(rep => {
        // On garde une copie fraîche pour le prochain passage hors ligne.
        const copie = rep.clone();
        caches.open(VERSION).then(c => c.put(req, copie)).catch(() => {});
        return rep;
      })
      .catch(() =>
        caches.match(req).then(rep => rep || caches.match('./index.html'))
      )
  );
});
