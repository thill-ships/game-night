// Host-side randomness. Crypto-backed by default; ?seed=N gives a reproducible
// PRNG, and rig() lets dev/test code force the next values.
export function createRng({ seed = null } = {}) {
  const queue = [];
  let float;
  if (seed != null && seed !== '') {
    let a = (Number(seed) >>> 0) || 1;
    float = () => { // mulberry32
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  } else {
    const b = new Uint32Array(1);
    float = () => { crypto.getRandomValues(b); return b[0] / 4294967296; };
  }
  const seeded = seed != null && seed !== '';
  const rng = {
    float,
    // Uniform integer in [0, n)
    int(n) {
      if (queue.length) return ((queue.shift() % n) + n) % n;
      if (seeded) return Math.floor(float() * n);
      const lim = Math.floor(4294967296 / n) * n, b = new Uint32Array(1);
      do crypto.getRandomValues(b); while (b[0] >= lim);
      return b[0] % n;
    },
    die(sides = 6) { return rng.int(sides) + 1; },
    pick(arr) { return arr[rng.int(arr.length)]; },
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) { const j = rng.int(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
      return a;
    },
    rig(ints) { queue.push(...ints); },
    rigDice(faces) { queue.push(...faces.map((f) => f - 1)); },
  };
  return rng;
}
