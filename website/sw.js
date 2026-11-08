// Makes the page cross-origin isolated where the host cannot send the
// headers that do it, as GitHub Pages cannot: E8's editor runs on a worker
// sharing the page's WebAssembly memory, which only an isolated page may
// share. Every response from this site passes through here and gains the
// two headers; the page registers this once and reloads to be served
// through it (see index.html). The site loads nothing from elsewhere.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // A request the browser may only answer from its cache, which fetch()
  // here would refuse.
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
  event.respondWith(
    fetch(request).then((response) => {
      if (response.status === 0) return response;
      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }),
  );
});
