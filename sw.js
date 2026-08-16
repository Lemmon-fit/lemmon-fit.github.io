// LEMMON FIT — service worker
//
// VERSION doit rester identique à APP_VERSION dans index.html et à "version"
// dans manifest.json. Le nom du cache en découle : changer de version purge
// donc automatiquement l'ancien cache, ce que "lemmonfit-cache-v1" (figé) ne
// faisait jamais.
var VERSION = "1.8.1";
var CACHE_NAME = "lemmonfit-" + VERSION;

var INDEX_URL = new URL("./index.html", self.location.href).href;
var PRECACHE_URLS = ["./", "./index.html", "./icon-180.png", "./icon-512.png", "./manifest.json"];

// Au-delà de ce délai on sert le cache sans attendre. Le téléchargement
// continue en arrière-plan pour rafraîchir le cache.
// Sans ce garde-fou, un réseau faible mais vivant — sous-sol de salle de sport,
// portail Wi-Fi qui ne répond pas — laissait fetch() suspendu : le lancement se
// figeait des dizaines de secondes au lieu de basculer sur le cache.
var NET_TIMEOUT_MS = 3500;

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(PRECACHE_URLS);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_NAME; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

// Le bouton « Mettre à jour l'appli » recharge avec ?v=<horodatage>. Sans
// normalisation, chaque mise à jour ajoutait une entrée de plus dans le cache,
// qui grossissait donc sans limite. On range tout sous l'URL sans requête.
function cacheKey(request) {
  var url = new URL(request.url);
  url.search = "";
  url.hash = "";
  return url.href;
}

// On ne met en cache que de vraies réponses de notre propre origine : ni une
// erreur 502, ni une redirection, ni une réponse opaque, sinon la coquille de
// l'appli pouvait être remplacée en cache par une page d'erreur.
function isCacheable(response) {
  return response && response.ok && response.type === "basic" && !response.redirected;
}

function offlineFallback(request, key) {
  return caches.match(key).then(function (cached) {
    if (cached) return cached;
    if (request.mode === "navigate") {
      return caches.match(INDEX_URL).then(function (index) {
        return index || new Response(
          "LEMMON FIT est hors-ligne et n'a rien en cache. Reconnecte-toi une fois.",
          { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      });
    }
    return new Response("", { status: 504 });
  });
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;

  var url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;   // on laisse passer l'externe
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // Sonde réseau du bouton « Mettre à jour l'appli » : on ne l'intercepte PAS.
  // Sinon elle serait servie depuis le cache (cacheKey retire la requête), donc
  // elle réussirait hors-ligne — et l'appli viderait son cache en croyant le
  // réseau disponible, avant de recharger dans le vide.
  if (url.searchParams.has("nocache")) return;

  var key = cacheKey(request);

  var network = fetch(request).then(function (response) {
    if (isCacheable(response)) {
      var copy = response.clone();
      caches.open(CACHE_NAME)
        .then(function (cache) { return cache.put(key, copy); })
        .catch(function () {});
    }
    return response;
  });

  // Le téléchargement se poursuit même si on a déjà répondu depuis le cache :
  // la version fraîche sera prête pour la prochaine ouverture.
  event.waitUntil(network.catch(function () {}));

  event.respondWith(new Promise(function (resolve) {
    var settled = false;
    function finish(response) { if (!settled) { settled = true; resolve(response); } }

    var timer = setTimeout(function () {
      caches.match(key).then(function (cached) {
        if (cached) finish(cached);   // sinon on continue d'attendre le réseau
      });
    }, NET_TIMEOUT_MS);

    network.then(
      function (response) { clearTimeout(timer); finish(response); },
      function () {
        clearTimeout(timer);
        offlineFallback(request, key).then(finish);
      }
    );
  }));
});
