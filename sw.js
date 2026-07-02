/* TrainSheet AI Version: 0.9.1 */
const CACHE_NAME="trainsheet-ai-v0-9-1";
const APP_FILES=["./","./index.html","./style.css","./app.js","./manifest.json","./tesseract.min.js","./worker.min.js","./tesseract-core-lstm.wasm.js","./tesseract-core-simd-lstm.wasm.js","./tesseract-core-relaxedsimd-lstm.wasm.js","./eng.traineddata.gz"];
self.addEventListener("install",event=>{self.skipWaiting();event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_FILES)))});
self.addEventListener("activate",event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)))));self.clients.claim()});
self.addEventListener("fetch",event=>{event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request).then(response=>{const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(event.request,copy));return response})))})
