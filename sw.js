/* ============================================================
   Service worker — Yoann's French Bakery (boutique client)

   Stratégie « réseau d'abord » : la page fraîche l'emporte toujours,
   le cache ne sert que si le réseau est indisponible. C'est le seul
   moyen d'avoir la boutique consultable hors ligne sans jamais
   servir un catalogue périmé après un déploiement.

   Firestore et les SDK Firebase (gstatic.com) ne sont jamais mis en
   cache : ils sont d'une autre origine et gèrent leur propre
   hors-ligne.
   ============================================================ */

const VERSION = 'yfb-boutique-v4';

const ESSENTIELS = [
  './',
  './index.html',
  './checkout.html',
  './promo.js',
  './qr.js',
  './compte.html',
  './abonnement.html',
  './confirmation.html',
  './manifest.json',
  './logo.jpg'
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
        // On ne garde qu'une réponse saine : une 404 en cache est pire
        // que pas de cache du tout.
        if (rep && rep.ok && rep.type === 'basic') {
          const copie = rep.clone();
          caches.open(VERSION).then(c => c.put(req, copie)).catch(() => {});
        }
        return rep;
      })
      .catch(() =>
        caches.match(req).then(rep => {
          if (rep) return rep;
          // Hors ligne sur une page jamais visitée : on renvoie la
          // vitrine plutôt que l'écran d'erreur du navigateur.
          if (req.mode === 'navigate') return caches.match('./index.html');
          return Response.error();
        })
      )
  );
});
