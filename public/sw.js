// Offline shell only: never intercept API/auth/tiles or queue rewards and coordinates.
const CACHE='cityquest-shell-0.8.0-1';
const SHELL=['/','/index.html','/app.js','/map.js','/platform.js','/styles.css','/companion.js','/companion.css','/adventures.js','/adventures.css','/team-presence.js','/icon.svg','/manifest.webmanifest','/icons/icon-192.png','/icons/icon-512.png','/icons/maskable-512.png','/vendor/maplibre-gl.js','/vendor/maplibre-gl.css','/vendor/three.module.js','/vendor/three.core.js'];
const ALLOWED=new Set(SHELL);
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('cityquest-shell-')&&key!==CACHE).map(key=>caches.delete(key))))));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(event.request.method!=='GET'||url.origin!==self.location.origin||url.search||!ALLOWED.has(url.pathname))return;
 if(event.request.mode==='navigate'){
  // HTML and modules must come from the same installed release. A waiting
  // worker may already have cached a newer shell; never read its cache here.
  event.respondWith(caches.open(CACHE).then(cache=>cache.match('/index.html')).then(cached=>cached||fetch(event.request)));return;
 }
 event.respondWith(caches.open(CACHE).then(cache=>cache.match(event.request)).then(cached=>cached||fetch(event.request)));
});
