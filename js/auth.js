// Lokale Konten: alles bleibt auf diesem Gerät (localStorage), nichts geht an einen Server.
// Passwörter werden nie im Klartext gespeichert, sondern als PBKDF2-SHA-256-Fingerabdruck mit Salz.
// Hinweis: Das ist ein Profil-Schloss für die App, kein Schutz gegen jemanden mit Zugriff aufs entsperrte Gerät.

const KEY = 'klang-accounts';
const SESSION = 'klang-session';
const ITER = 150000;

// Startkonto (Passwort nur als Fingerabdruck – bitte nach dem ersten Login ändern)
const SEED = [
  { name: 'Manni', salt: 'kA/1LoUU3n8HdLU08Vzc7A==', hash: 'XntduGwAhKkHTEduIv4+p1I9gkf4Obd/6OtOwTKmDn4=' },
];

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const keyOf = (n) => String(n || '').trim().toLowerCase();

async function derive(pw, salt) {
  if (globalThis.crypto?.subtle) {
    const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, key, 256);
    return b64(bits);
  }
  // Ohne HTTPS (Handy im WLAN per http) gibt es kein WebCrypto: gleiches PBKDF2 in reinem JavaScript
  await new Promise((r) => setTimeout(r, 30)); // Ladeanzeige zuerst zeichnen lassen
  return b64(pbkdf2Sha256(enc.encode(pw), salt, ITER).buffer);
}

// ---------- PBKDF2-HMAC-SHA-256 (32 Byte) ohne WebCrypto ----------
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const IV256 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const Wbuf = new Uint32Array(64);
function compress(H, W) {
  for (let i = 16; i < 64; i++) {
    const a = W[i - 15], b = W[i - 2];
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K256[i] + W[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
  H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
}
// SHA-256 über Bytes, optional mit Startzustand und schon verarbeiteten Bytes (für HMAC)
function sha256(bytes, state = IV256, done = 0) {
  const H = new Uint32Array(state);
  const total = done + bytes.length;
  const padLen = ((bytes.length + 9 + 63) & ~63);
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const bits = total * 8;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padLen - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(padLen - 4, bits >>> 0);
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) Wbuf[i] = dv.getUint32(off + i * 4);
    compress(H, Wbuf);
  }
  return H;
}
const wordsToBytes = (H) => { const out = new Uint8Array(32); const dv = new DataView(out.buffer); for (let i = 0; i < 8; i++) dv.setUint32(i * 4, H[i]); return out; };
function pbkdf2Sha256(password, salt, iterations) {
  let key = password;
  if (key.length > 64) key = wordsToBytes(sha256(key));
  const ipad = new Uint8Array(64).fill(0x36);
  const opad = new Uint8Array(64).fill(0x5c);
  for (let i = 0; i < key.length; i++) { ipad[i] ^= key[i]; opad[i] ^= key[i]; }
  const blockState = (pad) => { const H = new Uint32Array(IV256); const dv = new DataView(pad.buffer); for (let i = 0; i < 16; i++) Wbuf[i] = dv.getUint32(i * 4); compress(H, Wbuf); return H; };
  const iState = blockState(ipad);
  const oState = blockState(opad);
  // U1 = HMAC(salt || 00000001)
  const msg = new Uint8Array(salt.length + 4);
  msg.set(salt);
  msg[salt.length + 3] = 1;
  let U = sha256(wordsToBytes(sha256(msg, iState, 64)), oState, 64);
  const T = new Uint32Array(U);
  // Folgerunden: Nachricht ist immer 32 Byte -> genau ein Block, schnelle Schleife
  const W = new Uint32Array(64);
  const Hin = new Uint32Array(8);
  const Hout = new Uint32Array(8);
  for (let n = 1; n < iterations; n++) {
    Hin.set(iState);
    for (let i = 0; i < 8; i++) W[i] = U[i];
    W[8] = 0x80000000; W[9] = 0; W[10] = 0; W[11] = 0; W[12] = 0; W[13] = 0; W[14] = 0; W[15] = 768;
    compress(Hin, W);
    Hout.set(oState);
    for (let i = 0; i < 8; i++) W[i] = Hin[i];
    W[8] = 0x80000000; W[9] = 0; W[10] = 0; W[11] = 0; W[12] = 0; W[13] = 0; W[14] = 0; W[15] = 768;
    compress(Hout, W);
    U = Hout;
    for (let i = 0; i < 8; i++) T[i] ^= Hout[i];
  }
  return wordsToBytes(T);
}
export const _test = { pbkdf2Sha256 };
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function read() {
  try { const v = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(v) ? v : null; } catch { return null; }
}
function write(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch { return false; }
}
const fresh = (name, salt, hash) => ({ name, display: name, salt, hash, premium: true, bio: '', avatar: null, genre: 'all', createdAt: Date.now() });

export function accounts() {
  let list = read();
  if (!list) {
    list = SEED.map((s) => fresh(s.name, s.salt, s.hash));
    write(list);
  }
  return list;
}
export function current() {
  let k = null;
  try { k = localStorage.getItem(SESSION); } catch { /* */ }
  return k ? accounts().find((a) => keyOf(a.name) === k) || null : null;
}
export async function login(name, pw) {
  const a = accounts().find((x) => keyOf(x.name) === keyOf(name));
  if (!a) return { error: 'name', msg: 'Auf diesem Gerät gibt es kein Konto mit diesem Namen.' };
  const h = await derive(pw, unb64(a.salt));
  if (!sameText(h, a.hash)) {
    await new Promise((r) => setTimeout(r, 400)); // bremst Durchprobieren
    return { error: 'pw', msg: 'Das Passwort stimmt nicht.' };
  }
  try { localStorage.setItem(SESSION, keyOf(a.name)); } catch { /* */ }
  return { ok: true, account: a };
}
export async function register(name, pw, pw2) {
  name = String(name || '').trim();
  if (name.length < 2 || name.length > 24) return { error: 'name', msg: 'Der Name braucht 2 bis 24 Zeichen.' };
  if (accounts().some((a) => keyOf(a.name) === keyOf(name))) return { error: 'name', msg: 'Diesen Namen gibt es auf diesem Gerät schon.' };
  if (pw.length < 6) return { error: 'pw', msg: 'Das Passwort braucht mindestens 6 Zeichen.' };
  if (pw !== pw2) return { error: 'pw2', msg: 'Die Passwörter sind nicht gleich.' };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const acc = fresh(name, b64(salt), await derive(pw, salt));
  const list = accounts();
  list.push(acc);
  if (!write(list)) return { error: 'name', msg: 'Speichern nicht möglich (privater Modus?).' };
  try { localStorage.setItem(SESSION, keyOf(name)); } catch { /* */ }
  return { ok: true, account: acc };
}
export function logout() {
  try { localStorage.removeItem(SESSION); } catch { /* */ }
}
export function update(patch) {
  const list = accounts();
  const me = current();
  if (!me) return null;
  const a = list.find((x) => keyOf(x.name) === keyOf(me.name));
  Object.assign(a, patch);
  return write(list) ? a : null;
}
export async function changePassword(oldPw, newPw, newPw2) {
  const me = current();
  if (!me) return { error: 'old', msg: 'Nicht eingeloggt.' };
  if (!sameText(await derive(oldPw, unb64(me.salt)), me.hash)) return { error: 'old', msg: 'Das aktuelle Passwort stimmt nicht.' };
  if (newPw.length < 6) return { error: 'new', msg: 'Das neue Passwort braucht mindestens 6 Zeichen.' };
  if (newPw !== newPw2) return { error: 'new2', msg: 'Die neuen Passwörter sind nicht gleich.' };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  update({ salt: b64(salt), hash: await derive(newPw, salt) });
  return { ok: true };
}
