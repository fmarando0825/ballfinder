/*
 * Makes the app work with no internet at all.
 *
 * On the first visit it saves every file (including the 10 MB brain and the
 * runtime) into the phone's own storage. After that the phone never asks the
 * network for anything — so it works in the middle of a field.
 *
 * If we ever change the app or retrain the brain, bump CACHE below by one:
 * that's what tells the phone to fetch the new files.
 */
const CACHE = "ballfinder-v1";

const FILES = [
  "./",
  "index.html",
  "app.js",
  "ball_detect.js",
  "ball.onnx",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "ort/ort.webgpu.min.js",
  "ort/ort-wasm-simd-threaded.asyncify.mjs",
  "ort/ort-wasm-simd-threaded.asyncify.wasm",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Saved copy first (instant, works offline); fall back to the network.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) =>
      hit || fetch(e.request).then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
    )
  );
});
