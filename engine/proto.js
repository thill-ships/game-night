// Shared protocol constants and environment flags.
export const V = 1; // protocol version; bump on breaking message changes
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export const T = {
  STATE_EVERY: 4000,   // host re-broadcasts state
  HELLO_EVERY: 8000,   // phone heartbeat
  ONLINE_MS: 20000,    // host counts a phone online if heard within this
  RECONNECT_MS: 13000, // phone shows "Reconnecting…" after this much silence
  ACT_RETRY: 1200,     // phone resends an unacknowledged intent
  ACT_TRIES: 4,
};

export const params = new URLSearchParams(location.search);
export const DEV = params.has('dev');

export function isLocalMode() {
  const cfg = window.GN_CONFIG || {};
  return params.has('local') || !cfg.supabaseUrl || !cfg.supabaseKey;
}

export function randomId(len = 10) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  const b = new Uint32Array(len);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += a[x % a.length];
  return s;
}

export function newRoomCode() {
  const b = new Uint32Array(4);
  crypto.getRandomValues(b);
  return [...b].map((x) => ROOM_ALPHABET[x % ROOM_ALPHABET.length]).join('');
}

export function cleanCode(s) {
  return String(s || '').toUpperCase().split('').filter((c) => ROOM_ALPHABET.includes(c)).join('').slice(0, 4);
}

export function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 18);
}

export function clone(x) {
  return x === undefined ? undefined : (typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)));
}

export function urlWith(qs) {
  const keep = DEV ? '&dev' : '';
  const local = params.has('local') ? '&local' : '';
  return location.pathname + '?' + qs + keep + local;
}
