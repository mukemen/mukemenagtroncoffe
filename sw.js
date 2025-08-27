// SW — cache-first for Pro UI
const CACHE = "agtroncam-ultra-mobile-v3";
const CORE = ["/","/index.html","/app.js","/manifest.webmanifest","/icons/icon-64.png","/icons/icon-192.png","/icons/icon-512.png", "/brand/logo.png", "/brand/logo@2x.png", "/brand/header-logo.png", "/brand/header-logo@2x.png"];

self.addEventListener("install", e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)));
  self.skipWaiting();
});
self.addEventListener("activate", e=>{
  e.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.map(k=> k===CACHE?null:caches.delete(k)));
    self.clients.claim();
  })());
});
self.addEventListener("fetch", e=>{
  const req=e.request;
  e.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    const cached=await cache.match(req);
    if (cached) return cached;
    try{
      const fresh=await fetch(req);
      if (req.method==="GET" && fresh.status===200 && fresh.type==="basic") cache.put(req, fresh.clone());
      return fresh;
    }catch(err){ return cached || Response.error(); }
  })());
});
