// Game Night service worker: always serve the newest deploy.
// GitHub Pages lets browsers and its CDN reuse files for ~10 minutes. We ask for
// each file with ?gnv=<latest build>, a URL no cache has seen before a deploy,
// so a normal reload always gets the current version. Unchanged builds reuse
// the browser's copy, so it stays fast.
let latest = null, checkedAt = 0;

async function latestBuild() {
  if (latest && Date.now() - checkedAt < 20000) return latest;
  try {
    const r = await fetch(new URL('version.json?t=' + Date.now(), self.registration.scope), { cache: 'no-store' });
    if (r.ok) { latest = (await r.json()).build; checkedAt = Date.now(); }
  } catch { /* offline: fall through */ }
  return latest;
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || !url.href.startsWith(self.registration.scope)) return;
  if (url.pathname.endsWith('/version.json') || url.pathname.endsWith('/sw.js')) return;
  e.respondWith((async () => {
    const build = await latestBuild();
    try {
      // A navigation Request can't be re-issued with options, so refetch it by URL.
      if (!build || build === 'dev') return await (req.mode === 'navigate' ? fetch(req.url, { cache: 'no-cache' }) : fetch(req, { cache: 'no-cache' }));
      const fresh = new URL(url);
      fresh.searchParams.set('gnv', build);
      const res = await fetch(fresh.href, { credentials: 'same-origin' });
      if (res.redirected || !res.ok) return await fetch(req);
      return res;
    } catch {
      return fetch(req);
    }
  })());
});
