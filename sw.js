'use strict';
// Le préfixe et le périmètre protègent les caches des autres applications du domaine.
const PREFIX = 'tickets-de-caisses-' + encodeURIComponent(self.registration.scope) + '-';
const CACHE = PREFIX + 'v1';
const ASSETS = ['./', './index.html', './style.css', './core.js', './app.js', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png', './LIRE-MOI.md'];
const ASSET_URLS = new Set(ASSETS.map(path => new URL(path, self.registration.scope).href));
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || !ASSET_URLS.has(event.request.url)) return;
  // Une version cohérente de l'app ; aucune requête Google ni aucun ticket en cache HTTP.
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(event.request)) || fetch(event.request)));
});
