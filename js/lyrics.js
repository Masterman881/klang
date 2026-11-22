// Songtexte: eigene (aus der Datei oder selbst eingefügt) haben Vorrang, sonst LRCLIB (freie, offene
// Songtext-Datenbank, oft mit Zeitstempeln). Einmal geladen bleiben sie auf dem Gerät und gehen offline.
import * as db from './db.js';

const API = 'https://lrclib.net/api';
const RETRY_MISS = 3 * 24 * 3600e3; // nicht gefunden: nach 5 Tagen nochmal fragen
const mem = new Map(); // id -> { text, synced, src, miss, at }
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9äöüß ]/g, ' ').replace(/\s+/g, ' ').trim();
let loaded = null;

// Alle gespeicherten Texte einmal in den Speicher holen (für die Textsuche)
export function loadAll() {
  if (!loaded) loaded = db.getAll('lyrics').then((rows) => { for (const r of rows) mem.set(r.id, r); }).catch(() => {});
  return loaded;
}
export const cachedText = (id) => mem.get(id)?.text || '';
export const hasCached = (id) => !!mem.get(id)?.text;
export const isMiss = (id) => { const r = mem.get(id); return !!r && !r.text; };

// Zeilen ohne Zeitstempel für die Suche
const plainCache = new Map();
export function plainOf(id) {
  const r = mem.get(id);
  if (!r?.text) return '';
  let p = plainCache.get(id);
  if (p == null) { p = r.text.replace(/\[[^\]]*\]/g, '').replace(/\r/g, ''); plainCache.set(id, p); }
  return p;
}
// Findet die passende Textzeile zu einer Suche (für die Anzeige „… Zeile …“)
const fullNorm = new Map();
export const lnorm = norm;
export function matchLine(id, terms) {
  const p = plainOf(id);
  if (!p) return null;
  let all = fullNorm.get(id);
  if (all == null) { all = norm(p); fullNorm.set(id, all); }
  if (!terms.every((t) => all.includes(t))) return null;
  for (const line of p.split('\n')) { const n = norm(line); if (n && terms.every((t) => n.includes(t))) return line.trim(); }
  return p.split('\n').find((l) => l.trim())?.trim() || '';
}
export const cachedIds = () => [...mem.keys()].filter((id) => mem.get(id)?.text);

async function save(rec) {
  mem.set(rec.id, rec);
  plainCache.delete(rec.id);
  fullNorm.delete(rec.id);
  try { await db.put('lyrics', rec); } catch { /* voll */ }
}

const isInstrumental = (t) => /instrumental/i.test(`${t.version || ''} ${t.title}`);
const mainArtist = (t) => (t.artists && t.artists[0]) || String(t.artist || '').split(/\s*(?:,|&|\/|\bfeat\.?\s|\bft\.?\s)\s*/i)[0];

// Höflich bleiben: Hintergrund-Anfragen mit Abstand, bei „zu viele Anfragen“ warten und nochmal
let lastAt = 0, chain = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ask(url, bg = false) {
  if (bg) {
    const turn = chain.then(async () => { const w = 1300 - (Date.now() - lastAt); if (w > 0) await sleep(w); lastAt = Date.now(); });
    chain = turn.catch(() => {});
    await turn;
  } else lastAt = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { cache: 'no-store' });
    if (r.status === 404) return null;
    if (r.status === 429 || r.status === 502 || r.status === 503) {
      const wait = Math.min(60, +(r.headers.get('retry-after') || 0) || (attempt + 1) * (bg ? 15 : 3));
      if (attempt === 2) throw Object.assign(new Error('busy'), { busy: true });
      await sleep(wait * 1000);
      continue;
    }
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  }
  return null;
}
function pick(hit) {
  if (!hit) return null;
  if (hit.instrumental) return { text: '', instrumental: true };
  const text = (hit.syncedLyrics || hit.plainLyrics || '').trim();
  return text ? { text, synced: !!hit.syncedLyrics } : null;
}
// Bester Treffer: gleicher Titelanfang, passende Länge, gleicher Künstler; mit Zeitstempeln bevorzugt
function best(list, t, artist) {
  const nt = norm(t.title.replace(/\([^)]*\)|\[[^\]]*\]/g, ''));
  const na = norm(artist).replace(/ /g, '');
  const scored = (list || [])
    .filter((h) => (h.syncedLyrics || h.plainLyrics || h.instrumental) && norm(h.trackName).startsWith(nt.slice(0, Math.min(6, nt.length))))
    .map((h) => {
      const ha = norm(h.artistName).replace(/ /g, '');
      const sameArtist = ha.includes(na.slice(0, 5)) || na.includes(ha.slice(0, 5));
      return [Math.abs((h.duration || 0) - (t.duration || 0)) + (h.syncedLyrics ? 0 : 1.5) + (sameArtist ? 0 : 4), h];
    })
    .filter(([d]) => !t.duration || d <= 6)
    .sort((a, b) => a[0] - b[0]);
  return pick(scored[0]?.[1]);
}
async function lookup(t, bg) {
  const artist = mainArtist(t);
  const q = new URLSearchParams({ track_name: t.title, artist_name: artist });
  if (t.album) q.set('album_name', t.album);
  if (t.duration) q.set('duration', String(Math.round(t.duration)));
  let res = pick(await ask(`${API}/get?${q}`, bg));
  if (res) return res;
  // Suche nach Titel + Künstler, dann frei (findet abweichende Schreibweisen)
  res = best(await ask(`${API}/search?${new URLSearchParams({ track_name: t.title, artist_name: artist })}`, bg), t, artist);
  if (res) return res;
  return best(await ask(`${API}/search?${new URLSearchParams({ q: `${artist} ${t.title}` })}`, bg), t, artist);
}

const inflight = new Map();
// Liefert { text, synced } oder null. force = auch wenn zuletzt nichts gefunden wurde
export async function get(t, { force = false, net = true, bg = false } = {}) {
  if (!t || t.live) return null;
  if (t.lyrics) return { text: t.lyrics, synced: /\[\d+:\d+/.test(t.lyrics), src: 'own' };
  await loadAll();
  const r = mem.get(t.id);
  if (r?.text) return r;
  if (isInstrumental(t)) return { text: '', instrumental: true };
  if (!net || !navigator.onLine) return null;
  if (r && !force && Date.now() - (r.at || 0) < RETRY_MISS) return null;
  if (inflight.has(t.id)) return inflight.get(t.id);
  const p = (async () => {
    try {
      const res = await lookup(t, bg);
      const rec = { id: t.id, text: res?.text || '', synced: !!res?.synced, src: 'lrclib', at: Date.now(), instrumental: !!res?.instrumental };
      await save(rec);
      return rec.text || rec.instrumental ? rec : null;
    } catch (e) {
      if (e.busy) throw e;
      return null;
    } finally { inflight.delete(t.id); }
  })();
  inflight.set(t.id, p);
  return p;
}
export async function setOwn(id, text) {
  // Eigener Text ersetzt den geladenen (wird im Titel selbst gespeichert)
  mem.delete(id);
  plainCache.delete(id);
  try { await db.del('lyrics', id); } catch { /* */ }
}

// Im Hintergrund für alle Songs laden (langsam, damit niemand überlastet wird)
let prefetching = false;
export async function prefetch(tracks, onProgress = () => {}) {
  if (prefetching) return;
  prefetching = true;
  await loadAll();
  try {
    const todo = tracks.filter((t) => !t.live && !t.lyrics && !isInstrumental(t) && !mem.get(t.id)?.text && !(mem.has(t.id) && Date.now() - (mem.get(t.id).at || 0) < RETRY_MISS));
    let done = 0;
    for (const t of todo) {
      if (!navigator.onLine) break;
      try { await get(t, { bg: true }); } catch (e) { if (e.busy) await sleep(60000); }
      done++;
      onProgress(done, todo.length);
    }
  } finally { prefetching = false; }
}
export function counts(tracks) {
  let have = 0, miss = 0;
  for (const t of tracks) { if (t.lyrics || mem.get(t.id)?.text) have++; else if (mem.has(t.id) || /instrumental/i.test(`${t.version || ''} ${t.title}`)) miss++; }
  return { have, miss, open: tracks.length - have - miss };
}
export async function clearAll() { mem.clear(); plainCache.clear(); try { await db.clear('lyrics'); } catch { /* */ } }
