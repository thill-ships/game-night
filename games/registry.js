// Available games. Adding a game = adding a folder and a line here.
// dev:true games only appear in the host's picker with ?dev.
const ENTRIES = [
  { id: 'bank', load: () => import('./bank/index.js') },
  { id: 'sample', dev: true, load: () => import('./_sample/index.js') },
];

let cache = null;
export async function loadGames({ dev = false } = {}) {
  if (!cache) {
    cache = await Promise.all(ENTRIES.map(async (e) => {
      const mod = (await e.load()).default;
      if (mod.id !== e.id) throw new Error(`Game id mismatch: ${e.id} vs ${mod.id}`);
      if (mod.css && !document.querySelector(`link[data-game="${mod.id}"]`)) {
        const link = document.createElement('link');
        link.rel = 'stylesheet'; link.href = mod.css; link.dataset.game = mod.id;
        document.head.append(link);
      }
      return Object.assign(mod, { dev: !!e.dev });
    }));
  }
  return cache.filter((g) => dev || !g.dev);
}
