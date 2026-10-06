/* ============================================================
   Service worker — Yoann's French Bakery (boutique client)

   Stratégie « réseau d'abord » : la page fraîche l'emporte toujours,
   le cache ne sert que si le réseau est indisponible. C'est le seul
   moyen d'avoir la boutique consultable hors ligne sans jamais
   servir un catalogue périmé après un déploiement.

   Deux exceptions, et deux seulement :

   — les modules Firebase servis par gstatic.com passent en cache d'abord,
     parce que leur adresse porte leur version et que leur contenu ne
     changera jamais (voir SDK plus bas) ;

   — Firestore, l'authentification et les fonctions Cloud ne sont jamais
     touchés : ils gèrent leur propre hors-ligne, et un cache posé dessus
     ferait croire à une commande partie alors qu'elle dort sur l'appareil.
   ============================================================ */

const VERSION = 'yfb-boutique-v28';

/* Modules Firebase servis par gstatic.com : cache d'abord.

   Leur adresse porte le numéro de version — 10.12.0 — donc leur contenu ne
   change jamais. Les redemander au réseau à chaque visite coûte plus de
   100 Ko et deux allers-retours vers Mountain View, avant que la moindre
   ligne du catalogue puisse être lue. Sur une 4G philippine, c'est une à
   deux secondes d'écran vide, à chaque fois.

   Une fois en cache, ils sont instantanés. C'est exactement ce que fait
   déjà sw-admin.js, et c'est ce qui rend l'administration fluide d'un
   onglet à l'autre.

   Si le numéro de version du SDK change dans les pages, il doit changer ici
   aussi : sans quoi la nouvelle version se téléchargera au réseau comme
   avant — sans casse, mais sans gain. */
const SDK = 'https://www.gstatic.com/firebasejs/10.12.0/';
const MODULES = [
  SDK + 'firebase-app.js',
  SDK + 'firebase-auth.js',
  SDK + 'firebase-firestore.js'
];

const ESSENTIELS = [
  './',
  './index.html',
  './checkout.html',
  './promo.js',
  './abo.js',
  './qr.js',
  './compte.html',
  './abonnement.html',
  './confirmation.html',
  './confirmation-abonnement.html',
  './manifest.json',
  './logo.jpg',
  './faq.html'
];

self.addEventListener('install', (e) => {
  // Une nouvelle version prend la main sans attendre la fermeture des onglets.
  self.skipWaiting();
  e.waitUntil(
    caches.open(VERSION).then(c => Promise.all([
      c.addAll(ESSENTIELS).catch(() => {}),
      /* Les modules sont précachés dès l'installation : la toute première
         visite les paie encore, la deuxième n'attend plus rien.
         mode:'cors' pour obtenir une réponse lisible et réutilisable, et
         non une réponse opaque qu'on ne pourrait pas resservir. */
      Promise.all(MODULES.map(u =>
        fetch(u, { mode: 'cors' })
          .then(r => (r.ok ? c.put(u, r) : null))
          .catch(() => {})
      ))
    ])).catch(() => {})
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

  if (req.method !== 'GET') return;

  /* Modules Firebase : cache d'abord. Seule exception à la règle de même
     origine, et elle ne concerne que ces trois adresses figées. */
  if (req.url.startsWith(SDK)) {
    e.respondWith(
      caches.match(req).then(cache => {
        if (cache) return cache;
        // Absent du cache — première visite, ou précache échoué : on va le
        // chercher et on le garde pour les fois suivantes.
        return fetch(req).then(rep => {
          if (rep.ok) {
            const copie = rep.clone();
            caches.open(VERSION).then(c => c.put(req, copie)).catch(() => {});
          }
          return rep;
        });
      })
    );
    return;
  }

  /* Tout le reste : même origine uniquement. Firestore, l'authentification
     et les fonctions Cloud gèrent leur propre hors-ligne et ne doivent
     jamais passer par ici. */
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
