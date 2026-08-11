/**
 * The service worker.
 *
 * It exists so the application can be installed on a phone, and for nothing
 * else. In particular it does **not** make the system work offline, and that is
 * a decision rather than an omission: every screen here shows money, and a
 * cached balance is a wrong balance. A teller who is shown 12,400 in the drawer
 * because that is what it held when the signal dropped will pay out against it.
 *
 * So the rule is narrow and absolute:
 *
 *   - Anything under /api is never touched. It goes to the network or it fails.
 *   - A page navigation is never served from cache. Offline, the operator gets
 *     a page that says the connection is gone — not yesterday's figures.
 *   - Only immutable build output is cached, and only because its URL contains
 *     a content hash, so a cached copy can never be the wrong version of it.
 *
 * There is no `skipWaiting` either. A new worker taking over mid-shift would
 * reload the tab under whoever is standing at the counter. It waits for the
 * tabs to close, which costs nothing: the HTML and the JavaScript come from the
 * network anyway, so an update lands on the next page load regardless of which
 * worker is in charge.
 */

const VERSION = 'v1';
const STATIC_CACHE = `static-${VERSION}`;
const SHELL_CACHE = `shell-${VERSION}`;
const OFFLINE_URL = '/offline.html';

/** Only these prefixes are ever cached. All of them are content-addressed. */
const IMMUTABLE = ['/_next/static/', '/icons/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll([OFFLINE_URL, '/favicon.svg'])),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name !== STATIC_CACHE && name !== SHELL_CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Anything that changes state goes straight out. Replaying a POST from a
  // cache would post it twice.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The one rule that matters most: never stand between the counter and its
  // own data.
  if (url.pathname.startsWith('/api/')) return;

  if (IMMUTABLE.some((prefix) => url.pathname.startsWith(prefix))) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkOrOfflineNotice(request));
  }
});

/**
 * Build output only. Its URL carries a content hash, so what is in the cache is
 * the file that URL has always meant — there is no staleness to reason about.
 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(STATIC_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

/**
 * A page, or an honest statement that it could not be fetched.
 *
 * Deliberately not "the last version of this page". An installed application
 * that opens to a stale ledger looks like it is working, which is worse than
 * one that says it is not.
 */
async function networkOrOfflineNotice(request) {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(OFFLINE_URL);
    return (
      cached ??
      new Response('لا يوجد اتصال', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    );
  }
}
