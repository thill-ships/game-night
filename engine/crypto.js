// ECDH P-256 key agreement + AES-GCM envelopes.
// Private keys are generated non-extractable and kept in IndexedDB; if IndexedDB
// is unavailable we fall back to an extractable JWK in localStorage.
const subtle = globalThis.crypto && globalThis.crypto.subtle;
export const hasCrypto = !!subtle && globalThis.isSecureContext !== false;

const EC = { name: 'ECDH', namedCurve: 'P-256' };
const DB = 'gn-keys', STORE = 'keys';

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) {
  const db = await idb();
  return new Promise((res, rej) => {
    const r = db.transaction(STORE).objectStore(STORE).get(k);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbPut(k, v) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(v, k);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
async function idbDel(k) {
  const db = await idb();
  return new Promise((res) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(k);
    tx.oncomplete = () => res(); tx.onerror = () => res();
  });
}

export function pubOnly(jwk) {
  return jwk ? { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } : null;
}
export function sameKey(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y;
}

// Returns { privateKey, publicJwk } for a stable id, creating it if needed.
export async function loadKeyPair(id) {
  if (!hasCrypto) return null;
  try {
    const got = await idbGet(id);
    if (got && got.privateKey && got.publicJwk) return got;
    const kp = await subtle.generateKey(EC, false, ['deriveKey']);
    const publicJwk = pubOnly(await subtle.exportKey('jwk', kp.publicKey));
    const rec = { privateKey: kp.privateKey, publicJwk };
    await idbPut(id, rec);
    const check = await idbGet(id); // make sure CryptoKey survives structured clone
    if (!check || !check.privateKey) throw new Error('idb could not store key');
    return rec;
  } catch (e) {
    const lk = 'gn.key.' + id;
    try {
      const saved = JSON.parse(localStorage.getItem(lk) || 'null');
      if (saved) {
        const privateKey = await subtle.importKey('jwk', saved.priv, EC, false, ['deriveKey']);
        return { privateKey, publicJwk: pubOnly(saved.pub) };
      }
      const kp = await subtle.generateKey(EC, true, ['deriveKey']);
      const priv = await subtle.exportKey('jwk', kp.privateKey);
      const pub = await subtle.exportKey('jwk', kp.publicKey);
      localStorage.setItem(lk, JSON.stringify({ priv, pub }));
      return { privateKey: kp.privateKey, publicJwk: pubOnly(pub) };
    } catch (e2) {
      console.warn('No usable key storage', e2);
      return null;
    }
  }
}

// Store an existing pair under another id (a device adopting a seat keeps its key).
export async function saveKeyPair(id, rec, fromId) {
  const ls = fromId && localStorage.getItem('gn.key.' + fromId);
  if (ls) { localStorage.setItem('gn.key.' + id, ls); return true; } // fallback-mode key
  try { await idbPut(id, { privateKey: rec.privateKey, publicJwk: rec.publicJwk }); return true; }
  catch { return false; }
}

export async function deleteKeyPair(id) {
  try { localStorage.removeItem('gn.key.' + id); } catch {}
  try { await idbDel(id); } catch {}
}

export async function deriveShared(privateKey, peerJwk) {
  const pub = await subtle.importKey('jwk', pubOnly(peerJwk), EC, false, []);
  return subtle.deriveKey({ name: 'ECDH', public: pub }, privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (buf) => { let s = ''; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(ct) };
}

export async function unseal(key, iv, ct) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
  return JSON.parse(dec.decode(pt));
}
