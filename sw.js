'use strict';
// Le préfixe et le périmètre protègent les caches des autres applications du domaine.
const PREFIX = 'tickets-de-caisses-' + encodeURIComponent(self.registration.scope) + '-';
const VERSION = '2026.10.15.4';
const CACHE = PREFIX + VERSION;
const ASSETS = ['./', './index.html', './style.css?v=' + VERSION, './core.js?v=' + VERSION, './app.js?v=' + VERSION, './manifest.json', './icon.svg', './icon-192.png', './icon-512.png', './LIRE-MOI.md'];
const ASSET_URLS = new Set(ASSETS.map(path => new URL(path, self.registration.scope).href));
self.addEventListener('install', event => {
  // Ne pas rester en attente tant qu'un ancien onglet est ouvert. Le document
  // courant reste intact : seul l'utilisateur choisit quand le recharger.
  event.waitUntil(caches.open(CACHE)
    .then(cache => cache.addAll(ASSETS.map(path => new Request(new URL(path, self.registration.scope), { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('message', event => {
  if (event.data?.type === 'GET_VERSION') event.source?.postMessage({ type: 'APP_VERSION', version: VERSION });
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const scope = self.registration.scope;
  // Le lien versionné contourne aussi les anciens caches v1/v2. Après migration,
  // la version courante reste consultable hors ligne avec ce même lien.
  if (event.request.mode === 'navigate' && (url.origin + url.pathname === scope || url.origin + url.pathname === scope + 'index.html') && (!url.search || url.searchParams.get('v') === VERSION)) {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(scope + 'index.html')) || fetch(event.request)));
    return;
  }
  if (!ASSET_URLS.has(event.request.url)) return;
  // Une version cohérente de l'app ; aucune requête Google ni aucun ticket en cache HTTP.
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(event.request)) || fetch(event.request)));
});
