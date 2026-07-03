const CACHE_NAME = "trainsheet-v2.4.1";
const APP_FILES = ["./","./index.html","./style.css","./app.js","./manifest.json"];
self.addEventListener("install",event=>{self.skipWaiting();event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_FILES)))});
self.addEventListener("activate",event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",event=>{const url=new URL(event.request.url);if(event.request.method!=="GET"||url.origin!==self.location.origin)return;event.respondWith(fetch(event.request).then(response=>{const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(event.request,copy));return response}).catch(async()=>await caches.match(event.request)||new Response("Offline",{status:503,headers:{"Content-Type":"text/plain; charset=utf-8"}})))});
