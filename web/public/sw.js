// Installability only. No fetch caching: every API response is behind login and must not outlive the cookie.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
