// sw.js — Service Worker para Nexus PWA
const CACHE_NAME = 'nexus-cache-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Instalación: cachear assets estáticos
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activación: limpiar caches antiguos
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Estrategia: stale-while-revalidate
self.addEventListener('fetch', event => {
  const { request } = event;
  
  // Solo interceptar peticiones GET
  if (request.method !== 'GET') return;
  
  // API calls no se cachean (para no romper lógica)
  if (request.url.includes('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request).then(response => {
        // Actualizar cache con la respuesta fresca
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => {
        // Si falla la red y no hay cache, mostrar offline
        if (!cached) {
          return new Response('⚠️ Sin conexión. Abre Nexus desde el escritorio.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' }
          });
        }
        return cached;
      });

      return cached || networkFetch;
    })
  );
});
