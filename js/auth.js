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
  // Ohne HTTPS (z. B. im WLAN per http) gibt es kein WebCrypto: einfacher Ersatz-Fingerabdruck
  let h = 0x811c9dc5;
  const s = b64(salt) + pw;
  for (let r = 0; r < 2000; r++) for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i) + r; h = Math.imul(h, 0x01000193) >>> 0; }
  return 'fnv:' + h.toString(16);
}
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
