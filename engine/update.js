// Update checks. Each deploy stamps version.json and engine/version.js with the
// commit id. Running pages poll version.json; when it differs from the code they
// loaded, a newer version is out.
import { BUILD } from './version.js';

const EVERY = 60000;

export function watchUpdates(onUpdate) {
  if (BUILD === 'dev') return;
  let told = null;
  const check = async () => {
    try {
      const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const { build } = await r.json();
      if (build && build !== 'dev' && build !== BUILD && build !== told) { told = build; onUpdate(build); }
    } catch { /* offline: try again later */ }
  };
  setTimeout(check, 4000);
  setInterval(check, EVERY);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}

// The service worker makes every load fetch the newest files, so a plain reload
// (or reopening the link) is always enough. Not used on localhost.
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (['localhost', '127.0.0.1'].includes(location.hostname)) return;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
}
