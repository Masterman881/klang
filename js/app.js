import * as db from './db.js';
import { readTags } from './tags.js';
import { icon, hydrateIcons } from './icons.js';
import { audius, radio } from './online.js';
import * as auth from './auth.js';
import * as lyr from './lyrics.js';
import * as stats from './stats.js';

/* =========================================================
   Helfer
   ========================================================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const coll = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
const pad2 = (n) => String(n).padStart(2, '0');
const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(x)}` : `${m}:${pad2(x)}`;
};
const fmtLong = (s) => {
  const m = Math.round((s || 0) / 60);
  return m < 60 ? `${m} Min.` : `${Math.floor(m / 60)} Std. ${m % 60} Min.`;
};
const fmtBytes = (b) => {
  if (!b) return '0 MB';
  if (b > 1e9) return (b / 1e9).toFixed(2).replace('.', ',') + ' GB';
  return Math.max(1, Math.round(b / 1e6)) + ' MB';
};
const hue = (str) => { let h = 7; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const shuffleArr = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const isMobile = () => matchMedia('(max-width: 860px)').matches;
const finePointer = () => matchMedia('(pointer: fine)').matches;
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const plural = (n, one, many) => `${n.toLocaleString('de')} ${n === 1 ? one : many}`;
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* voll/privat */ } },
};

/* =========================================================
   Zustand
   ========================================================= */
const S = {
  tracks: new Map(),
  playlists: [],
  queue: [],
  original: [],
  index: -1,
  shuffle: false,
  repeat: 'off', // off | all | one
  source: '',
  sleep: null,
  search: '',
  sort: ls.get('klang-sort', { songs: 'title', albums: 'name' }),
  lastLib: 'songs',
  smart: false, // Smart Shuffle
  recs: new Set(), // eingemischte Empfehlungen
  discGenre: 'all',
  discTime: 'week',
  radioCat: 'top',
};

/* ---------- Online-Titel (Audius / Radio) ---------- */
// Nicht gespeicherte Online-Titel leben nur hier. Gespeicherte (Favorit/Playlist) stehen zusätzlich in S.tracks.
const remote = new Map();
const getT = (id) => S.tracks.get(id) || remote.get(id);
// Online = Audius/Radio. Songs aus dem lokalen Musik-Ordner (remote: 'server') zählen als eigene Musik.
const isOnline = (t) => !!t?.remote && t.remote !== 'server' && t.remote !== 'cloud';

// Zugangsschlüssel zum Musik-Ordner auf dem PC (kommt per QR-Code aufs Handy, bleibt nur auf dem Gerät)
const SRV_KEY = 'klang-srv-key';
(() => {
  const k = new URLSearchParams(location.search).get('k');
  if (k) {
    try { localStorage.setItem(SRV_KEY, k); } catch { /* */ }
    history.replaceState(null, '', location.pathname + location.hash); // Schlüssel nicht in der Adresszeile lassen
  }
})();
// Privater Cloud-Speicher (Cloudflare R2 hinter dem VERS-Worker). Zugang kommt per QR-Code als #cloud=…&ck=…
const CLOUD = 'klang-cloud';
function takeCloudLink(text) {
  const m = /#cloud=([^&\s]+)&ck=([^&\s#]+)/.exec(String(text || ''));
  if (!m) return false;
  try {
    const url = decodeURIComponent(m[1]).replace(/\/+$/, '');
    if (!/^https:\/\/[a-z0-9.-]+$/i.test(url)) return false;
    ls.set(CLOUD, { url, key: decodeURIComponent(m[2]) });
    return true;
  } catch { return false; }
}
if (/^#cloud=/.test(location.hash)) { takeCloudLink(location.hash); history.replaceState(null, '', location.pathname + location.search + '#/'); }
const cloudCfg = () => { const c = ls.get(CLOUD, null); return c?.url && c?.key ? c : null; };
const cloudSrc = (path) => { const c = cloudCfg(); return c ? `${c.url}${encPath(path)}?k=${encodeURIComponent(c.key)}` : ''; };
function withKey(url) {
  let k = null;
  try { k = localStorage.getItem(SRV_KEY); } catch { /* */ }
  return k ? `${url}${url.includes('?') ? '&' : '?'}k=${encodeURIComponent(k)}` : url;
}
const hasT = (id) => S.tracks.has(id) || remote.has(id);
function adopt(list) {
  return list.map((t) => {
    regAlts(t.coverId, t.coverAlts);
    regAlts(t.coverHi, t.coverHiAlts);
    regAlts(t.artistPic, t.artistPicAlts);
    const saved = S.tracks.get(t.id);
    if (saved) return saved.id;
    remote.set(t.id, t);
    return t.id;
  });
}
const inPlaylist = (id) => S.playlists.some((p) => p.trackIds.includes(id));

const radioFavs = () => ls.get('klang-radio', []);
const isRadioFav = (id) => radioFavs().some((s) => s.id === id);
function toggleRadioFav(t, val) {
  let list = radioFavs().filter((s) => s.id !== t.id);
  if (val) list = [{ ...t, fav: false }, ...list];
  ls.set('klang-radio', list);
}

const apiCache = new Map();
async function cached(key, fn, ttl = 10 * 60e3) {
  const c = apiCache.get(key);
  if (c && Date.now() - c.t < ttl) return c.v;
  const v = await fn();
  apiCache.set(key, { t: Date.now(), v });
  return v;
}
let renderSeq = 0;
const loadingHTML = (txt = 'Lädt …') => `<div class="loading"><span class="spinner"></span>${txt}</div>`;
const offlineHTML = () => `<div class="empty-small">${navigator.onLine ? 'Der Online-Katalog ist gerade nicht erreichbar.' : 'Keine Internetverbindung. Deine eigene Musik funktioniert trotzdem.'}<br><button class="btn btn-sm" data-action="retry" style="margin-top:12px">Nochmal versuchen</button></div>`;
async function fillAsync(sel, loader) {
  const seq = renderSeq;
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (!el) return;
  el.innerHTML = loadingHTML();
  try {
    const html = await loader();
    if (seq !== renderSeq || !el.isConnected) return;
    el.innerHTML = html;
  } catch (e) {
    console.warn(e);
    if (seq !== renderSeq || !el.isConnected) return;
    el.innerHTML = offlineHTML();
  }
  mountLists(el);
  hydrateCovers(el);
  applyTints(el);
}

let _albums = null, _artists = null;
const searchCache = new Map();
function invalidate() { _albums = null; _artists = null; searchCache.clear(); }

const albumKeyOf = (t) => `${(t.albumArtist || t.artist).toLowerCase()}|||${t.album.toLowerCase()}`;

function getAlbums() {
  if (_albums) return _albums;
  const m = new Map();
  for (const t of S.tracks.values()) {
    const k = albumKeyOf(t);
    let a = m.get(k);
    if (!a) {
      a = { key: k, name: t.album, artist: t.albumArtist || t.artist, year: t.year, tracks: [], coverId: null, addedAt: 0, lastPlayed: 0 };
      m.set(k, a);
    }
    a.tracks.push(t);
    if (!a.coverId && t.coverId) a.coverId = t.coverId;
    if (!a.year && t.year) a.year = t.year;
    if (t.addedAt > a.addedAt) a.addedAt = t.addedAt;
    if ((t.lastPlayed || 0) > a.lastPlayed) a.lastPlayed = t.lastPlayed;
  }
  for (const a of m.values()) {
    a.tracks.sort((x, y) => (x.discNo || 0) - (y.discNo || 0) || (x.trackNo || 0) - (y.trackNo || 0) || coll.compare(x.title, y.title));
  }
  _albums = m;
  return m;
}

// Alle Künstler eines Titels (Hauptkünstler zuerst, dann Features)
const splitNames = (s) => String(s || '').split(/\s*(?:,|\/|;|\bfeat\.?\s|\bft\.?\s)\s*/i).map((x) => x.trim()).filter(Boolean);
const artistsOf = (t) => (t.artists?.length ? t.artists : splitNames(t.artist));
const artKey = (name) => nk(name) || String(name || '').toLowerCase();
function getArtists() {
  if (_artists) return _artists;
  const m = new Map();
  for (const t of S.tracks.values()) {
    artistsOf(t).forEach((name, i) => {
      const k = artKey(name);
      let a = m.get(k);
      if (!a) { a = { key: k, name, tracks: [], lead: 0, albums: new Set(), coverId: null }; m.set(k, a); }
      a.tracks.push(t);
      if (i === 0) { a.lead++; a.albums.add(albumKeyOf(t)); }
    });
  }
  // Künstlerbild nur aus echten Künstlerbildern, nie aus Song-Covern
  for (const a of m.values()) a.coverId = artistPicId(a.name);
  _artists = m;
  return m;
}
const isMainArtist = (a) => a.lead >= 2 || !!a.coverId;
const initials = (name) => { const w = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/); return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || '?').slice(0, 2)).toUpperCase(); };
function artistArt(name, pic, cls = '') {
  return pic ? coverHTML(pic, name, `${cls} round`, 'user') : `<div class="cover ${cls} round mono" style="--h:${hue(name)}"><span>${esc(initials(name))}</span></div>`;
}

const searchStr = (t) => {
  let s = searchCache.get(t.id);
  if (!s) { s = norm(`${t.title} ${t.artist} ${t.album} ${t.albumArtist || ''} ${t.genre || ''}`); searchCache.set(t.id, s); }
  return s;
};

/* =========================================================
   Cover
   ========================================================= */
const coverUrls = new Map();
let coverBase = null; // (Datei) => Adresse der Song-Cover vom PC bzw. aus der Cloud
let coverKeys = new Set();
const tintCache = new Map();

// Online-Bilder: erst testen, bei Fehler die Ersatz-Server der Reihe nach probieren
const coverAlts = new Map();
function regAlts(id, list) { if (id && list?.length && !coverAlts.has(id)) coverAlts.set(id, list); }
const tryImage = (u) => new Promise((r) => {
  const i = new Image();
  const timer = setTimeout(() => r(false), 6000);
  i.onload = () => { clearTimeout(timer); r(i.naturalWidth > 0); };
  i.onerror = () => { clearTimeout(timer); r(false); };
  i.src = u;
});
async function firstWorking(list) { for (const u of list) if (await tryImage(u)) return u; return null; }
function coverUrl(id) {
  if (!id) return Promise.resolve(null);
  if (id.startsWith('url:')) {
    if (!coverUrls.has(id)) coverUrls.set(id, firstWorking([id.slice(4), ...(coverAlts.get(id) || [])]));
    return coverUrls.get(id);
  }
  if (!coverUrls.has(id)) {
    const p = (async () => {
      const r = await db.get('covers', id).catch(() => null);
      if (r) return URL.createObjectURL(r.blob);
      // Song-Cover aus dem Katalog (PC oder Cloud): einmal laden, verkleinert speichern, danach offline
      if (!id.startsWith('c:') || !coverBase) return null;
      try {
        const res = await fetch(coverBase(id.slice(2)));
        if (!res.ok) return null;
        const blob = await makeCover(await res.blob());
        db.put('covers', { id, blob }).catch(() => {});
        coverKeys.add(id);
        return URL.createObjectURL(blob);
      } catch { return null; }
    })();
    coverUrls.set(id, p);
    p.then((u) => { if (!u) coverUrls.delete(id); }); // später nochmal versuchen
  }
  return coverUrls.get(id);
}

function coverHTML(coverId, seed, cls = '', ic = 'music') {
  return `<div class="cover ${cls}" ${coverId ? `data-cover="${esc(coverId)}"` : ''} style="--h:${hue(seed)}">${icon(ic)}</div>`;
}

const coverIO = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { coverIO.unobserve(e.target); loadCover(e.target); }
}, { rootMargin: '400px' });

function hydrateCovers(root) {
  root.querySelectorAll('.cover[data-cover]:not(.has-img)').forEach((el) => coverIO.observe(el));
}
async function loadCover(el) {
  const id = el.dataset.cover;
  const u = await coverUrl(id);
  if (!u || el.dataset.cover !== id) return;
  el.style.backgroundImage = `url("${u.replace(/"/g, '%22')}")`;
  el.classList.add('has-img');
}
function setCoverEl(el, coverId, seed) {
  el.classList.remove('has-img');
  el.style.backgroundImage = '';
  el.style.setProperty('--h', hue(seed));
  el.innerHTML = icon('music');
  if (coverId) { el.dataset.cover = coverId; loadCover(el); } else delete el.dataset.cover;
}

async function tintOf(coverId) {
  if (!coverId) return null;
  if (tintCache.has(coverId)) return tintCache.get(coverId);
  const url = await coverUrl(coverId);
  if (!url) return null;
  const color = await new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 16;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, 16, 16);
        const d = x.getImageData(0, 0, 16, 16).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
          const w = 1 + (mx - mn) / 40; // gesättigte Pixel stärker gewichten
          r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; n += w;
        }
        r /= n; g /= n; b /= n;
        const k = Math.min(1.6, 150 / Math.max(r, g, b, 1));
        res(`rgb(${Math.round(r * k)} ${Math.round(g * k)} ${Math.round(b * k)})`);
      } catch { res(null); }
    };
    img.onerror = () => res(null);
    img.crossOrigin = 'anonymous';
    img.src = url;
  });
  tintCache.set(coverId, color);
  return color;
}

async function makeCover(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return await new Promise((r) => c.toBlob((b) => r(b || blob), 'image/jpeg', 0.86));
  } catch {
    return blob;
  }
}

/* ---------- Künstlerbilder ----------
   Bilder aus Downloads\profilbilder (Dateiname = Künstlername) oder selbst gewählt.
   Gespeichert unter „a:<name>“ im Cover-Speicher, damit sie auch offline da sind. */
const nk = (s) => norm(s).replace(/[^a-z0-9]/g, '');
const mainArtist = (s) => String(s || '').split(/\s*(?:,|&|\bfeat\.?\s|\bft\.?\s|\sx\s)\s*/i)[0].trim() || String(s || '');
function artistPicId(name) {
  for (const n of [name, mainArtist(name)]) { const id = 'a:' + nk(n); if (coverKeys.has(id)) return id; }
  return null;
}
function lev(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}
// Wie gut passt ein Dateiname zum Künstler? „caney“ → CANEY030, „ak“ → AK AUSSERKONTROLLE, „gansta ralph“ → GANGSTAR RALPH
function picScore(artistKey, picKey) {
  if (!picKey || !artistKey) return 0;
  if (artistKey === picKey) return 100;
  if (artistKey.replace(/\d+$/, '') === picKey) return 95;
  if (picKey.length >= 2 && artistKey.startsWith(picKey)) return 80 + Math.min(10, picKey.length);
  if (picKey.length >= 5 && lev(artistKey, picKey) <= 2) return 70;
  return 0;
}
async function storeArtistPic(key, blob) {
  const id = 'a:' + key;
  await db.put('covers', { id, blob: await makeCover(blob) });
  coverKeys.add(id);
  const old = coverUrls.get(id);
  if (old) { old.then((u) => u && URL.revokeObjectURL(u)); coverUrls.delete(id); }
  tintCache.delete(id);
  artCache.delete(id);
}
// Künstlerbilder sind nie Song-Cover: alte Zuordnungen aus früheren Versionen entfernen
async function applyArtistPicsToTracks() {
  const changed = [];
  for (const t of S.tracks.values()) if (t.coverId?.startsWith('a:')) { t.coverId = null; changed.push(t); }
  if (changed.length) { try { await db.putMany('tracks', changed); } catch { /* */ } }
  return changed.length;
}
async function syncArtistPics(src = { list: withKey('/api/pics'), file: (u) => withKey(u) }) {
  let pics;
  try {
    const r = await fetch(src.list, { cache: 'no-store' });
    if (!r.ok) return;
    pics = await r.json();
  } catch { return; }
  if (!Array.isArray(pics) || !pics.length) return;
  const seen = ls.get('klang-apics', {});
  const keys = new Set([...getArtists().values()].map((a) => nk(mainArtist(a.name))));
  let changed = 0;
  for (const key of keys) {
    if (seen[key] === 'manual') continue; // selbst gewähltes Bild nicht überschreiben
    let best = null, bs = 0;
    for (const p of pics) { const sc = picScore(key, nk(p.name)); if (sc > bs) { bs = sc; best = p; } }
    if (!best) continue;
    const ver = `${best.url}|${best.v}`;
    if (seen[key] === ver && coverKeys.has('a:' + key)) continue;
    try {
      const r = await fetch(src.file(best.url));
      if (!r.ok) continue;
      await storeArtistPic(key, await r.blob());
      seen[key] = ver;
      changed++;
    } catch { /* nächstes Bild */ }
  }
  ls.set('klang-apics', seen);
  const tracksChanged = await applyArtistPicsToTracks();
  if (changed || tracksChanged) { invalidate(); refresh(); if (curId) updatePlayerUI(); }
}
async function changeArtistPic(name) {
  const file = await pickFile('#image-input');
  if (!file) return;
  const key = nk(mainArtist(name));
  await storeArtistPic(key, file);
  const seen = ls.get('klang-apics', {});
  seen[key] = 'manual';
  ls.set('klang-apics', seen);
  await applyArtistPicsToTracks();
  invalidate();
  refresh();
  if (curId) updatePlayerUI();
  toast('Künstlerbild gespeichert');
}

/* =========================================================
   Toasts, Dialoge, Menüs
   ========================================================= */
function toast(msg, ms = 2800) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}
function progressToast() {
  const el = document.createElement('div');
  el.className = 'toast progress';
  el.innerHTML = '<b class="t-main"></b><span class="t-sub"></span><div class="meter"><div style="width:0"></div></div>';
  $('#toasts').appendChild(el);
  return {
    update(i, n, sub) {
      el.querySelector('.t-main').textContent = `Importiere ${i} von ${n} …`;
      el.querySelector('.t-sub').textContent = sub || '';
      el.querySelector('.meter div').style.width = `${(i / n) * 100}%`;
    },
    text(main, p) {
      el.querySelector('.t-main').textContent = main;
      el.querySelector('.meter div').style.width = `${Math.round(p * 100)}%`;
    },
    close() { el.classList.add('out'); setTimeout(() => el.remove(), 300); },
  };
}

function openDialog({ title, body = '', buttons = [] }) {
  return new Promise((resolve) => {
    const layer = $('#dialog-layer');
    layer.innerHTML = `<div class="dlg-backdrop"></div><div class="dlg" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h2>${esc(title)}</h2><div class="dlg-body">${body}</div>
      ${buttons.length ? `<div class="dlg-actions">${buttons.map((b, i) => `<button class="btn ${b.primary ? 'btn-accent' : ''} ${b.danger ? 'btn-danger' : ''}" data-dlg="${i}">${esc(b.label)}</button>`).join('')}</div>` : ''}
    </div>`;
    layer.classList.add('open');
    const dlg = $('.dlg', layer);
    const finish = (val) => {
      const data = {};
      dlg.querySelectorAll('[name]').forEach((i) => { data[i.name] = i.type === 'checkbox' ? i.checked : i.value; });
      document.removeEventListener('keydown', onKey, true);
      layer.classList.remove('open');
      layer.innerHTML = '';
      layer.onclick = null;
      resolve(val == null ? null : { value: val, data });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); finish(null); }
      else if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        const p = buttons.find((b) => b.primary);
        if (p) { e.preventDefault(); finish(p.value ?? 'ok'); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    layer.onclick = (e) => {
      if (e.target.classList.contains('dlg-backdrop')) return finish(null);
      const b = e.target.closest('[data-dlg]');
      if (b) { const bt = buttons[+b.dataset.dlg]; return finish(bt.value === undefined ? null : bt.value); }
      const p = e.target.closest('[data-value]');
      if (p) finish(p.dataset.value);
    };
    setTimeout(() => { const i = dlg.querySelector('input'); if (i) { i.focus(); i.select?.(); } }, 60);
  });
}
async function promptText(title, { value = '', placeholder = '', ok = 'Speichern', label = '' } = {}) {
  const r = await openDialog({
    title,
    body: `<label class="field">${label ? `<span>${esc(label)}</span>` : ''}<input name="text" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="120" autocomplete="off"></label>`,
    buttons: [{ label: 'Abbrechen' }, { label: ok, primary: true, value: 'ok' }],
  });
  const v = r?.data.text?.trim();
  return v || null;
}
async function confirmDialog(title, text, ok = 'OK', danger = false) {
  const r = await openDialog({ title, body: `<p>${text}</p>`, buttons: [{ label: 'Abbrechen' }, { label: ok, primary: !danger, danger, value: 'ok' }] });
  return !!r;
}

function openMenu(items, anchor) {
  const layer = $('#menu-layer');
  layer.innerHTML = `<div class="menu-backdrop"></div><div class="menu" role="menu">${items.map((it, i) => {
    if (it.sep) return '<div class="menu-sep"></div>';
    if (it.header) return `<div class="menu-head">${it.header}</div>`;
    const lead = it.swatch ? `<span class="swatch-dot" style="background:${it.swatch}"></span>` : icon(it.icon || 'dot');
    return `<button class="menu-item ${it.danger ? 'danger' : ''} ${it.checked ? 'checked' : ''}" data-mi="${i}" role="menuitem">${lead}<span>${esc(it.label)}</span>${it.checked ? icon('check', 'tick') : ''}</button>`;
  }).join('')}</div>`;
  layer.classList.add('open');
  hydrateCovers(layer);
  const menu = $('.menu', layer);
  if (!isMobile() && anchor) {
    let x, y;
    if (anchor instanceof Element) {
      const r = anchor.getBoundingClientRect();
      x = r.right - menu.offsetWidth; y = r.bottom + 4;
      if (x < 8) x = r.left;
    } else { x = anchor.x; y = anchor.y; }
    const w = menu.offsetWidth, h = menu.offsetHeight;
    if (x + w > innerWidth - 8) x = innerWidth - w - 8;
    if (y + h > innerHeight - 8) y = Math.max(8, (anchor instanceof Element ? anchor.getBoundingClientRect().top - h - 4 : y - h));
    menu.style.left = Math.max(8, x) + 'px';
    menu.style.top = Math.max(8, y) + 'px';
  }
  layer.onclick = (e) => {
    const b = e.target.closest('[data-mi]');
    if (!b && e.target.closest('.menu')) return;
    closeMenu();
    if (b) items[+b.dataset.mi].fn?.();
  };
}
function closeMenu() { const l = $('#menu-layer'); l.classList.remove('open'); l.innerHTML = ''; }

/* =========================================================
   Overlays (Vollbild-Player, Warteschlange) mit Zurück-Taste
   ========================================================= */
const overlays = [];
function openOverlay(name) {
  if (overlays.includes(name)) return;
  overlays.push(name);
  setOverlayClass(name, true);
  history.pushState({ overlay: name }, '');
  if (name === 'queue') renderQueue();
}
function closeOverlay(name) {
  if (!overlays.includes(name)) return;
  if (overlays[overlays.length - 1] === name && history.state?.overlay === name) history.back();
  else { overlays.splice(overlays.indexOf(name), 1); setOverlayClass(name, false); }
}
function closeAllOverlays() {
  while (overlays.length) setOverlayClass(overlays.pop(), false);
}
function setOverlayClass(name, on) {
  if (name === 'np') {
    // Signatur: Das Cover fliegt aus der Player-Leiste in den Vollbild-Player (und zurück)
    const np = $('#np');
    const apply = () => {
      np.classList.toggle('open', on);
      document.body.classList.toggle('np-open', on);
    };
    if (np.classList.contains('open') !== on) {
      np.classList.add('vt');
      const vt = withTransition('np', apply);
      if (vt) vt.finished.finally(() => np.classList.remove('vt'));
      else np.classList.remove('vt');
    }
    if (on && lyricsOpen) { renderLyrics(true); startLyricsLoop(); }
    if (!on) cancelAnimationFrame(lyricsRaf);
  }
  if (name === 'queue') { $('#queue').classList.toggle('open', on); $('#queue-backdrop').classList.toggle('open', on); }
  if (name === 'drawer') { if (on) renderDrawer(); $('#drawer-layer').classList.toggle('open', on); document.body.classList.toggle('drawer-open', on); }
}
window.addEventListener('popstate', () => {
  const top = overlays.pop();
  if (top) setOverlayClass(top, false);
});

/* =========================================================
   Player
   ========================================================= */
// Vier Abspieler: je zwei direkt (gehen immer, auch im Hintergrund auf dem iPhone) und je zwei durch den
// Equalizer (brauchen CORS-Freigabe der Quelle). Je zwei, damit der nächste Song vorab lädt
// (lückenlos) und beide beim Überblenden gleichzeitig laufen können. `audio` zeigt auf den aktiven.
// Abspieler liegen im Dokument und erlauben AirPlay, sonst bietet iOS sie nicht für AirPlay/Bluetooth an
const mkAudio = (cors) => {
  const a = document.createElement('audio');
  if (cors) a.crossOrigin = 'anonymous';
  a.preload = 'auto';
  a.setAttribute('x-webkit-airplay', 'allow');
  a.setAttribute('playsinline', '');
  a.disableRemotePlayback = false;
  a.hidden = true;
  document.body.appendChild(a);
  return a;
};
const decks = { plain: [mkAudio(false), mkAudio(false)], eq: [mkAudio(true), mkAudio(true)] };
const allEls = [...decks.plain, ...decks.eq];
const isEqEl = (el) => decks.eq.includes(el);
let audio = decks.plain[0];
const noCors = new Set(); // Quellen ohne Freigabe: laufen ohne Equalizer
let curId = null;
let loadToken = 0;
let wantPlay = false;
let errorStreak = 0;
let seeking = false;
let lastSave = 0;

let deferred = null; // Online-Titel nach Neustart erst beim Antippen laden
let reloadOnly = false;

// Wiedergabe-Einstellungen
const PB = Object.assign({ xfade: 0, gapless: true, smartMix: 'balanced', shareStatus: true }, ls.get('klang-playback', {}));
const savePB = () => ls.set('klang-playback', PB);
// iPhone/iPad: Lautstärke einzelner Abspieler lässt sich nicht regeln und ein zweiter Abspieler startet
// im Hintergrund nicht zuverlässig. Dort bleibt es bei einem Abspieler.
const canSetVolume = (() => { try { const a = new Audio(); a.volume = 0.5; return a.volume === 0.5; } catch { return false; } })();
const decksOK = () => canSetVolume;
const xfadeSecs = () => (decksOK() ? PB.xfade : 0);

// Lautstärke gehört der App, nicht dem Abspieler (beim Überblenden laufen zwei gleichzeitig)
const vol = { level: 1, muted: false };
const volFactor = new Map(); // Abspieler -> 0..1 beim Überblenden
function applyVol(el) {
  const f = volFactor.has(el) ? volFactor.get(el) : 1;
  el.muted = vol.muted;
  el.volume = Math.max(0, Math.min(1, vol.level * f));
}
function setVolume(level = vol.level, muted = vol.muted) {
  vol.level = Math.max(0, Math.min(1, level));
  vol.muted = !!muted;
  for (const el of allEls) applyVol(el);
  updateVolumeUI();
}
const fades = new Map();
function cancelFade(el) { clearTimeout(fades.get(el)); fades.delete(el); }
// Gleichmäßig laut überblenden (equal power): rein mit Sinus, raus mit Kosinus
function fade(el, dir, secs, done) {
  cancelFade(el);
  const t0 = performance.now();
  const step = () => {
    const k = secs > 0 ? Math.min(1, (performance.now() - t0) / (secs * 1000)) : 1;
    volFactor.set(el, dir === 'in' ? Math.sin(k * Math.PI / 2) : Math.cos(k * Math.PI / 2));
    applyVol(el);
    if (k < 1) fades.set(el, setTimeout(step, 30));
    else { fades.delete(el); if (dir === 'in') { volFactor.delete(el); applyVol(el); } done?.(); }
  };
  step();
}
const objUrls = new Map();
function clearEl(el) {
  cancelFade(el);
  el.pause();
  if (el.getAttribute('src')) { el.removeAttribute('src'); el.load(); }
  const u = objUrls.get(el);
  if (u) { URL.revokeObjectURL(u); objUrls.delete(el); }
  volFactor.delete(el);
  applyVol(el);
}
async function sourceFor(t) {
  if (t.remote && isDl(t.id)) {
    const rec = await db.get('audio', t.id).catch(() => null);
    if (rec) { const u = URL.createObjectURL(rec.blob); return { src: u, obj: u }; }
  }
  if (t.remote && memPre.id === t.id && memPre.url) { const u = memPre.url; memPre.id = memPre.url = null; return { src: u, obj: u }; }
  if (t.remote) return { src: t.remote === 'server' ? withKey(encPath(t.streamUrl)) : t.remote === 'cloud' ? cloudSrc(t.streamUrl) : t.streamUrl };
  let rec = null;
  try { rec = await db.get('audio', t.id); } catch { /* */ }
  if (!rec) return null;
  const u = URL.createObjectURL(rec.blob);
  return { src: u, obj: u };
}
function setSrc(el, s) {
  clearEl(el);
  el.src = s.src;
  if (s.obj) objUrls.set(el, s.obj);
}
const wantsEq = (id) => eq.on && !noCors.has(id);

// ---- Nächsten Song vorbereiten (lückenlos / Überblenden) ----
let prep = null; // { id, el }
let preparing = false;
let gapTimer = null;
function upcomingIndex() {
  if (!S.queue.length || S.repeat === 'one') return -1;
  if (S.index < S.queue.length - 1) return S.index + 1;
  return S.repeat === 'all' && S.queue.length > 1 ? 0 : -1;
}
function dropPrep() {
  if (!prep) return;
  if (prep.el !== audio) clearEl(prep.el);
  prep = null;
}
async function prepareNext() {
  if (prep || preparing || !decksOK()) return;
  const i = upcomingIndex();
  if (i < 0) return;
  const id = S.queue[i];
  const t = getT(id);
  if (!t || t.live || (isOnline(t) && !navigator.onLine)) return;
  preparing = true;
  try {
    const we = wantsEq(id);
    if (we) ensureEqGraph();
    const [a, b] = we ? decks.eq : decks.plain;
    const el = a === audio || fades.has(a) ? b : a;
    if (el === audio) return;
    const s = await sourceFor(t);
    if (!s) return;
    if (S.queue[upcomingIndex()] !== id || el === audio) { if (s.obj) URL.revokeObjectURL(s.obj); return; }
    setSrc(el, s);
    el.load();
    prep = { id, el };
  } finally { preparing = false; }
}
function prepValid() {
  return !!prep && S.queue[upcomingIndex()] === prep.id && isEqEl(prep.el) === wantsEq(prep.id) && !prep.el.error && prep.el !== audio;
}
// Automatisch zum vorbereiteten Song wechseln: xf Sekunden überblenden, 0 = nahtlos
function advanceAuto(xf) {
  if (!prepValid()) { dropPrep(); return false; }
  const i = upcomingIndex();
  const t = getT(prep.id);
  if (!t) return false;
  const old = audio;
  const el = prep.el;
  prep = null;
  clearTimeout(gapTimer); gapTimer = null;
  S.index = i;
  curId = t.id;
  audio = el;
  loadToken++;
  deferred = null;
  wantPlay = true;
  if (isEqEl(el)) eq.ctx?.resume();
  if (xf > 0) { volFactor.set(el, 0); applyVol(el); fade(el, 'in', xf); fade(old, 'out', xf, () => clearEl(old)); }
  else { volFactor.delete(el); applyVol(el); fade(old, 'out', 0.04, () => clearEl(old)); }
  el.play().catch(() => { clearEl(el); audio = old; loadAndPlay(true); });
  onTrackStart(t);
  afterTrackChange();
  return true;
}
function checkTransition() {
  if (!decksOK() || (!PB.gapless && !PB.xfade)) return;
  const t = getT(curId);
  if (!t || t.live || audio.paused || seeking) return;
  const d = audio.duration;
  if (!Number.isFinite(d) || d < 15) return;
  if (prep && !prepValid()) dropPrep();
  const rem = d - audio.currentTime;
  if (rem < 25 && !prep) prepareNext();
  if (!prep || S.sleep?.mode === 'end') return;
  const xf = Math.min(xfadeSecs(), d / 3);
  if (xf > 0 && rem <= xf) advanceAuto(xf);
  else if (!xf && PB.gapless && rem < 0.7 && !gapTimer) {
    gapTimer = setTimeout(() => { gapTimer = null; if (audio.duration - audio.currentTime < 0.7) advanceAuto(0); }, Math.max(0, (rem - 0.06) * 1000));
  }
}

// ---- Zählen: echte Hörzeit, „gespielt“ erst nach 30 s bzw. halber Länge ----
let listened = 0, credited = false, lastPos = null, preTimer = null;
function onTrackStart(t) {
  t.lastPlayed = Date.now();
  if (S.tracks.has(t.id)) { db.put('tracks', t); _albums = null; }
  listened = 0; credited = false; lastPos = null;
  topUpSmart();
  clearTimeout(preTimer);
  preTimer = setTimeout(prefetchNext, 2500);
}
function listenTick() {
  const c = audio.currentTime || 0;
  if (!audio.paused && !seeking && lastPos != null) {
    const d = c - lastPos;
    const t = getT(curId);
    if (t && d > 0 && d < 3) {
      stats.tick(t, d);
      listened += d;
      const dur = t.duration || audio.duration || 0;
      if (!credited && !t.live && (listened >= 30 || (dur && listened >= dur * 0.5))) {
        credited = true;
        stats.countPlay(t);
        t.playCount = (t.playCount || 0) + 1;
        if (S.tracks.has(t.id)) { db.put('tracks', t); _albums = null; }
      }
    }
  }
  lastPos = c;
}
function afterTrackChange() {
  updatePlayerUI();
  updateMediaSession();
  markPlaying();
  saveState();
  sendPresence();
  if (overlays.includes('queue')) renderQueue();
  const t = getT(curId);
  if (t && !t.live) lyr.get(t).then(() => { if (lyricsOpen && curId === t.id) renderLyrics(true); }).catch(() => {});
}

async function loadAndPlay(autoplay = true, startAt = 0) {
  const id = S.queue[S.index];
  const t = getT(id);
  if (!t) return;
  const counts = !reloadOnly;
  reloadOnly = false;
  const token = ++loadToken;
  wantPlay = autoplay;
  deferred = null;
  clearTimeout(gapTimer); gapTimer = null;
  if (t.remote && !autoplay) {
    // Nicht schon beim App-Start Daten aus dem Netz laden
    curId = id;
    deferred = { startAt };
    dropPrep();
    for (const x of allEls) clearEl(x);
    updatePlayerUI(); updateMediaSession(); markPlaying(); updatePlayState(); updateProgress();
    return;
  }
  if (isOnline(t) && !navigator.onLine) toast('Keine Internetverbindung – Online-Titel brauchen Internet.', 3500);
  const we = wantsEq(id);
  if (we) ensureEqGraph();
  let el;
  if (prep && prep.id === id && isEqEl(prep.el) === we && !prep.el.error) { el = prep.el; prep = null; }
  else {
    dropPrep();
    const s = await sourceFor(t);
    if (token !== loadToken) { if (s?.obj) URL.revokeObjectURL(s.obj); return; }
    if (!s) { toast('Audiodatei nicht gefunden.'); return; }
    const pair = we ? decks.eq : decks.plain;
    el = pair.includes(audio) ? audio : pair[0]; // möglichst denselben Abspieler weiterverwenden (wichtig fürs iPhone)
    setSrc(el, s);
  }
  for (const x of allEls) if (x !== el) clearEl(x);
  cancelFade(el);
  volFactor.delete(el);
  applyVol(el);
  curId = id;
  audio = el;
  if (startAt > 0) {
    const seek = () => { el.currentTime = Math.min(startAt, (el.duration || startAt + 1) - 0.5); };
    if (el.readyState >= 1) seek(); else el.addEventListener('loadedmetadata', seek, { once: true });
  } else if (el.currentTime > 0) el.currentTime = 0;
  if (autoplay) {
    if (isEqEl(el)) eq.ctx?.resume();
    el.play().catch((e) => { if (e.name === 'NotAllowedError') updatePlayState(); });
    if (counts) onTrackStart(t);
  }
  lastPos = null;
  afterTrackChange();
}

function togglePlay() {
  if (!S.queue.length) {
    if (S.tracks.size) playIds(sortedTrackIds('title'), 0, { source: 'Alle Titel', shuffle: true });
    return;
  }
  if (!curId) { loadAndPlay(true, 0); return; }
  if (deferred) { const d = deferred; deferred = null; loadAndPlay(true, d.startAt); return; }
  if (audio.paused) { wantPlay = true; if (isEqEl(audio)) eq.ctx?.resume(); audio.play().catch(() => {}); } else audio.pause();
}

function next(auto = false) {
  if (!S.queue.length) return;
  if (auto && S.repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  if (S.index < S.queue.length - 1) S.index++;
  else if (S.repeat === 'all' || (!auto && S.queue.length > 1)) S.index = 0;
  else { audio.pause(); audio.currentTime = 0; return; }
  loadAndPlay(true);
}

function prev() {
  if (!S.queue.length) return;
  if (audio.currentTime > 3 || (S.index === 0 && S.repeat !== 'all')) { audio.currentTime = 0; return; }
  S.index = S.index > 0 ? S.index - 1 : S.queue.length - 1;
  loadAndPlay(true);
}

// Zufall ohne Klumpen: derselbe Künstler kommt möglichst nicht direkt hintereinander
const leadKey = (id) => { const t = getT(id); return nk(t?.artists?.[0] || t?.artist || ''); };
function spreadShuffle(ids) {
  const groups = new Map();
  for (const id of shuffleArr(ids.slice())) {
    const k = leadKey(id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(id);
  }
  // Jeder Künstler verteilt sich gleichmäßig über die Liste (mit etwas Zufall)
  const placed = [];
  for (const list of groups.values()) {
    const n = list.length;
    const off = Math.random() / n;
    list.forEach((id, j) => placed.push([(j / n) + off + (Math.random() - 0.5) * (0.6 / n), id]));
  }
  const out = placed.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  // Restliche direkte Wiederholungen auflösen
  for (let i = 1; i < out.length; i++) {
    if (leadKey(out[i]) !== leadKey(out[i - 1])) continue;
    for (let j = i + 1; j < out.length; j++) {
      if (leadKey(out[j]) !== leadKey(out[i - 1]) && (i + 1 >= out.length || leadKey(out[j]) !== leadKey(out[i + 1]))) { [out[i], out[j]] = [out[j], out[i]]; break; }
    }
  }
  return out;
}

function playIds(rawIds, start = 0, opts = {}) {
  const ids = [];
  let startAt = 0;
  rawIds.forEach((x, j) => { if (hasT(x)) { if (j === start) startAt = ids.length; ids.push(x); } });
  if (!ids.length) return;
  if (opts.shuffle) S.shuffle = true;
  S.original = ids.slice();
  if (S.shuffle) {
    const first = opts.shuffle ? Math.floor(Math.random() * ids.length) : startAt;
    const rest = ids.slice();
    const [f] = rest.splice(first, 1);
    S.queue = [f, ...spreadShuffle(rest)];
    S.index = 0;
  } else {
    S.queue = ids.slice();
    S.index = startAt;
  }
  S.source = opts.source || '';
  updateModeButtons();
  loadAndPlay(true);
}

function playNext(ids) {
  ids = ids.filter(hasT);
  if (!ids.length) return;
  if (!S.queue.length) return playIds(ids, 0, { source: 'Warteschlange' });
  S.queue.splice(S.index + 1, 0, ...ids);
  const oi = S.original.indexOf(curId);
  S.original.splice(oi + 1, 0, ...ids);
  saveState();
  if (overlays.includes('queue')) renderQueue();
  toast(ids.length === 1 ? 'Wird als Nächstes gespielt' : `${ids.length} Titel werden als Nächstes gespielt`);
}
function addToQueue(ids) {
  ids = ids.filter(hasT);
  if (!ids.length) return;
  if (!S.queue.length) return playIds(ids, 0, { source: 'Warteschlange' });
  S.queue.push(...ids);
  S.original.push(...ids);
  saveState();
  if (overlays.includes('queue')) renderQueue();
  toast(ids.length === 1 ? 'Zur Warteschlange hinzugefügt' : `${ids.length} Titel zur Warteschlange hinzugefügt`);
}

// Drei Stufen: aus -> Zufall -> Smart Shuffle -> aus
function toggleShuffle() {
  if (S.shuffle && !S.smart) {
    S.smart = true;
    topUpSmart();
    updateModeButtons();
    saveState();
    if (overlays.includes('queue')) renderQueue();
    toast(S.recs.size ? 'Smart Shuffle an: passende Songs sind eingemischt' : 'Smart Shuffle an', 2400);
    return;
  }
  if (S.smart) { S.smart = false; removeRecsAhead(); }
  S.shuffle = !S.shuffle;
  const cur = S.queue[S.index];
  if (S.queue.length) {
    if (S.shuffle) {
      S.original = S.queue.slice();
      const rest = S.queue.slice();
      rest.splice(S.index, 1);
      S.queue = cur ? [cur, ...spreadShuffle(rest)] : spreadShuffle(rest);
      S.index = 0;
    } else {
      const i = S.original.indexOf(cur);
      S.queue = S.original.slice();
      S.index = Math.max(0, i);
    }
  }
  updateModeButtons();
  saveState();
  if (overlays.includes('queue')) renderQueue();
  toast(S.shuffle ? 'Zufallswiedergabe an' : 'Zufallswiedergabe aus', 1500);
}
function cycleRepeat() {
  S.repeat = S.repeat === 'off' ? 'all' : S.repeat === 'all' ? 'one' : 'off';
  updateModeButtons();
  saveState();
  toast({ off: 'Wiederholen aus', all: 'Alle wiederholen', one: 'Titel wiederholen' }[S.repeat], 1500);
}

function stopPlayback() {
  curId = null;
  deferred = null;
  loadToken++;
  prep = null;
  for (const x of allEls) clearEl(x);
  S.queue = []; S.original = []; S.index = -1;
  updatePlayerUI();
  markPlaying();
  saveState();
  sendPresence();
}

function saveState() {
  ls.set('klang-player', {
    queue: S.queue, original: S.original, index: S.index,
    time: curId ? (deferred ? deferred.startAt : audio.currentTime || 0) : 0,
    shuffle: S.shuffle, smart: S.smart, recs: [...S.recs].filter((id) => S.queue.includes(id)),
    repeat: S.repeat, source: S.source,
    volume: vol.level, muted: vol.muted,
    remote: [...new Set(S.queue)].filter((id) => !S.tracks.has(id) && remote.has(id)).slice(0, 400).map((id) => remote.get(id)),
    saved: Date.now(),
  });
}
function restorePlayer() {
  const st = ls.get('klang-player', null);
  if (!st) return;
  setVolume(Number.isFinite(st.volume) ? st.volume : 1, !!st.muted);
  S.shuffle = !!st.shuffle;
  S.smart = S.shuffle && !!st.smart;
  S.recs = new Set(Array.isArray(st.recs) ? st.recs : []);
  S.repeat = ['off', 'all', 'one'].includes(st.repeat) ? st.repeat : 'off';
  S.source = st.source || '';
  for (const t of st.remote || []) if (t?.id && !S.tracks.has(t.id)) { remote.set(t.id, t); regAlts(t.coverId, t.coverAlts); }
  const cur = st.queue?.[st.index];
  S.queue = (st.queue || []).filter(hasT);
  S.original = (st.original || []).filter(hasT);
  S.index = S.queue.indexOf(cur);
  if (S.index < 0 && S.queue.length) S.index = 0;
  updateModeButtons();
  updateVolumeUI();
  if (S.index >= 0) loadAndPlay(false, cur === S.queue[S.index] ? st.time || 0 : 0);
}
addEventListener('pagehide', () => saveState());
document.addEventListener('visibilitychange', () => { if (document.hidden) saveState(); });

// ---- Audio-Events (für alle Abspieler, wirken nur beim aktiven) ----
function bindAudio(el) {
  const on = (type, fn) => el.addEventListener(type, (e) => { if (el === audio) fn(e); });
  on('play', () => { updatePlayState(); sendPresence(); updatePosState(); });
  on('pause', () => { updatePlayState(); saveState(); sendPresence(); updatePosState(); });
  on('durationchange', updatePosState);
  on('playing', () => { errorStreak = 0; lastPos = audio.currentTime; });
  on('seeking', () => { lastPos = null; });
  on('seeked', () => { lastPos = audio.currentTime; sendPresence(); updatePosState(); });
  on('timeupdate', () => {
    updateProgress();
    listenTick();
    checkTransition();
    if (Date.now() - lastSave > 4000) { lastSave = Date.now(); saveState(); }
  });
  on('loadedmetadata', () => {
    const t = getT(curId);
    if (t && !t.live && Number.isFinite(audio.duration) && Math.abs((t.duration || 0) - audio.duration) > 1) {
      t.duration = audio.duration;
      if (S.tracks.has(t.id)) db.put('tracks', t);
    }
    updateProgress();
    updatePosState();
  });
  on('ended', () => {
    if (S.sleep?.mode === 'end') { clearSleep(); toast('Sleep-Timer: Wiedergabe beendet'); sendPresence(); return; }
    if (prep && advanceAuto(0)) return;
    next(true);
  });
  on('error', () => {
    if (!curId || !audio.getAttribute('src')) return;
    const t = getT(curId);
    // Quelle ohne CORS-Freigabe: ohne Equalizer nochmal versuchen
    if (isEqEl(audio) && t?.remote && !noCors.has(t.id)) {
      noCors.add(t.id);
      toast('Bei dieser Quelle wirkt der Equalizer nicht. Sie läuft ohne.', 3500);
      reloadOnly = true;
      loadAndPlay(wantPlay, t.live ? 0 : audio.currentTime || 0);
      return;
    }
    if (!navigator.onLine && t?.remote && !isDl(t.id)) { netRetry = { id: t.id, pos: audio.currentTime || 0, play: wantPlay }; toast('Kein Internet. Der Song läuft weiter, sobald du wieder online bist.', 3500); return; }
    toast(t?.remote
      ? `„${t.title}“ konnte nicht geladen werden${navigator.onLine ? '' : ' (keine Internetverbindung)'}.`
      : `„${t?.title || 'Titel'}“ kann in diesem Browser nicht abgespielt werden.`, 4000);
    if (wantPlay && ++errorStreak < 3 && S.index < S.queue.length - 1) setTimeout(() => next(true), 800);
  });
}
allEls.forEach(bindAudio);

// ---- Discord-Status: was gerade läuft (PC direkt, Handy über die private Cloud) ----
let presTimer = null;
function sendPresence() {
  clearTimeout(presTimer);
  presTimer = setTimeout(() => {
    if (!PB.shareStatus) return;
    const t = getT(curId);
    const np = t && !t.live
      ? { title: t.title + (t.version ? ` (${t.version})` : ''), artist: t.artist, album: t.album, dur: t.duration || audio.duration || 0, pos: audio.currentTime || 0, paused: audio.paused || !!deferred, device: isMobile() ? 'Handy' : 'PC' }
      : { paused: true };
    const body = JSON.stringify(np);
    if (S.srvOK) fetch(withKey('/api/presence'), { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
    else { const c = cloudCfg(); if (c) fetch(`${c.url}/api/now?k=${encodeURIComponent(c.key)}`, { method: 'PUT', body, keepalive: true }).catch(() => {}); }
  }, 700);
}

// Nur für automatische Tests am eigenen PC (nicht auf der Online-Version)
if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
  window.__klangTest = { get audio() { return audio; }, get eq() { return eq; }, get S() { return S; }, getT, PB, get prep() { return prep; }, setVolume, stats };
}

/* =========================================================
   Equalizer (10 Bänder, Web Audio)
   ========================================================= */
const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = [
  ['flat', 'Flach', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  ['bass', 'Bass Boost', [7, 6, 5, 3, 1, 0, 0, 0, 0, 0]],
  ['rap', 'Rap', [6, 5, 3, 1, -1, 0, 1, 2, 2, 1]],
  ['pop', 'Pop', [-1, 1, 3, 4, 3, 1, 0, 1, 2, 2]],
  ['rock', 'Rock', [5, 4, 2, 0, -1, 0, 2, 3, 4, 4]],
  ['edm', 'Elektronisch', [6, 5, 2, 0, -2, 0, 1, 3, 4, 5]],
  ['vocal', 'Stimme', [-3, -2, -1, 1, 3, 4, 4, 3, 1, 0]],
  ['treble', 'Höhen', [0, 0, 0, 0, 0, 1, 2, 4, 5, 6]],
  ['night', 'Leise hören', [5, 4, 2, 0, 0, 0, 0, 1, 3, 4]],
];
const eqSaved = ls.get('klang-eq', null);
const eq = {
  on: !!eqSaved?.on,
  gains: Array.isArray(eqSaved?.gains) && eqSaved.gains.length === 10 ? eqSaved.gains : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  pre: Number.isFinite(eqSaved?.pre) ? eqSaved.pre : 0,
  preset: eqSaved?.preset || 'flat',
  ctx: null, filters: [], preGain: null, analyser: null,
};
const saveEq = () => ls.set('klang-eq', { on: eq.on, gains: eq.gains, pre: eq.pre, preset: eq.preset });
function ensureEqGraph() {
  if (eq.ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  eq.ctx = new AC();
  const input = eq.ctx.createGain();
  eq.preGain = eq.ctx.createGain();
  eq.filters = EQ_FREQS.map((f, i) => {
    const b = eq.ctx.createBiquadFilter();
    b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
    b.frequency.value = f;
    b.Q.value = 1.1;
    return b;
  });
  // Begrenzer gegen Übersteuern, wenn viel angehoben wird
  const limiter = eq.ctx.createDynamicsCompressor();
  limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.1;
  eq.analyser = eq.ctx.createAnalyser();
  eq.analyser.fftSize = 2048;
  eq.analyser.smoothingTimeConstant = 0.8;
  let node = input.connect(eq.preGain);
  for (const f of eq.filters) node = node.connect(f);
  node.connect(limiter).connect(eq.analyser).connect(eq.ctx.destination);
  // Beide Equalizer-Abspieler laufen durch dieselbe Kette (Überblenden geht auch mit Equalizer)
  for (const el of decks.eq) { eq.ctx.createMediaElementSource(el).connect(input); el.addEventListener('play', () => eq.ctx.resume()); }
  applyEq();
}
function applyEq() {
  if (!eq.ctx) return;
  const t = eq.ctx.currentTime;
  eq.filters.forEach((f, i) => f.gain.setTargetAtTime(eq.gains[i], t, 0.03));
  eq.preGain.gain.setTargetAtTime(10 ** (eq.pre / 20), t, 0.03);
}
// An/Aus wechselt den Abspieler – an derselben Stelle weiter
function setEqOn(on) {
  eq.on = on;
  saveEq();
  updateEqButtons();
  if (on) ensureEqGraph();
  const t = getT(curId);
  if (!t || deferred) return;
  if (wantsEq(t.id) === isEqEl(audio)) return;
  const wasPlaying = !audio.paused;
  reloadOnly = true; // gleicher Song, nur anderer Abspieler: nicht als neues Abspielen zählen
  loadAndPlay(wasPlaying, t.live ? 0 : audio.currentTime || 0);
}
function updateEqButtons() {
  $$('[data-action="eq"]').forEach((b) => b.classList.toggle('on', eq.on));
  // Schalter im offenen Equalizer-Fenster mitziehen (z. B. wenn eine Voreinstellung ihn einschaltet)
  $$('[data-eq-toggle]').forEach((tg) => {
    tg.classList.toggle('on', eq.on);
    tg.setAttribute('aria-checked', String(eq.on));
    tg.querySelector('span').textContent = eq.on ? 'An' : 'Aus';
  });
}
let eqRaf = 0;
function eqDialog() {
  const presetChips = EQ_PRESETS.map(([k, l]) => `<button class="chip ${eq.preset === k ? 'on' : ''}" type="button" data-eq-preset="${k}">${l}</button>`).join('') + `<span class="chip eq-custom ${eq.preset === 'custom' ? 'on' : ''}">Eigene</span>`;
  const fmtHz = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));
  const sliders = EQ_FREQS.map((f, i) => `<label class="eq-band"><output data-eq-out="${i}">${eq.gains[i] > 0 ? '+' : ''}${eq.gains[i]}</output><input type="range" min="-12" max="12" step="1" value="${eq.gains[i]}" data-eq-band="${i}" aria-label="${fmtHz(f)} Hertz"><span>${fmtHz(f)}</span></label>`).join('');
  openDialog({
    title: 'Equalizer',
    body: `<div class="eq-top">
        <button class="eq-switch ${eq.on ? 'on' : ''}" type="button" data-eq-toggle role="switch" aria-checked="${eq.on}"><i></i><span>${eq.on ? 'An' : 'Aus'}</span></button>
        <button class="btn btn-sm" type="button" data-eq-reset>${icon('refresh')}Zurücksetzen</button>
      </div>
      <div class="chips wrap eq-presets">${presetChips}</div>
      <div class="eq-stage">
        <canvas class="eq-canvas" width="900" height="300" aria-hidden="true"></canvas>
        <div class="eq-bands">${sliders}
          <label class="eq-band eq-pre"><output data-eq-out="pre">${eq.pre > 0 ? '+' : ''}${eq.pre}</output><input type="range" min="-12" max="6" step="1" value="${eq.pre}" data-eq-pre aria-label="Vorverstärker"><span>Pre</span></label>
        </div>
      </div>
      <p class="small muted eq-note">Wirkt auf eigene Musik, den Musik-Ordner und Audius. Manche Radiosender erlauben keinen Equalizer, die laufen dann normal.${/iphone|ipad/i.test(navigator.userAgent) ? ' iPhone: Mit Equalizer kann die Musik bei gesperrtem Bildschirm pausieren. Für unterwegs ausschalten.' : ''}</p>`,
    buttons: [{ label: 'Fertig', primary: true, value: 'ok' }],
  }).then(() => cancelAnimationFrame(eqRaf));
  const layer = $('#dialog-layer');
  const markCustom = () => {
    const match = EQ_PRESETS.find(([, , g]) => g.every((v, i) => v === eq.gains[i]));
    eq.preset = match ? match[0] : 'custom';
    layer.querySelectorAll('[data-eq-preset]').forEach((c) => c.classList.toggle('on', c.dataset.eqPreset === eq.preset));
    layer.querySelector('.eq-custom')?.classList.toggle('on', eq.preset === 'custom');
  };
  const setOut = (i, v) => { const o = layer.querySelector(`[data-eq-out="${i}"]`); if (o) o.textContent = `${v > 0 ? '+' : ''}${v}`; };
  layer.addEventListener('input', (e) => {
    const band = e.target.closest('[data-eq-band]');
    if (band) {
      const i = +band.dataset.eqBand;
      eq.gains[i] = +band.value;
      setOut(i, eq.gains[i]);
      if (!eq.on) setEqOn(true);
      markCustom(); applyEq(); saveEq();
      drawEqCurve();
    }
    const pre = e.target.closest('[data-eq-pre]');
    if (pre) { eq.pre = +pre.value; setOut('pre', eq.pre); applyEq(); saveEq(); }
  });
  layer.addEventListener('click', (e) => {
    const p = e.target.closest('[data-eq-preset]');
    if (p) {
      const preset = EQ_PRESETS.find(([k]) => k === p.dataset.eqPreset);
      eq.gains = preset[2].slice();
      eq.preset = preset[0];
      layer.querySelectorAll('[data-eq-band]').forEach((s, i) => { s.value = eq.gains[i]; setOut(i, eq.gains[i]); });
      markCustom();
      if (!eq.on) setEqOn(true);
      applyEq(); saveEq(); drawEqCurve();
      return;
    }
    const tg = e.target.closest('[data-eq-toggle]');
    if (tg) {
      setEqOn(!eq.on);
      tg.classList.toggle('on', eq.on);
      tg.setAttribute('aria-checked', String(eq.on));
      tg.querySelector('span').textContent = eq.on ? 'An' : 'Aus';
      drawEqCurve();
      return;
    }
    if (e.target.closest('[data-eq-reset]')) {
      eq.gains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; eq.pre = 0; eq.preset = 'flat';
      layer.querySelectorAll('[data-eq-band]').forEach((s, i) => { s.value = 0; setOut(i, 0); });
      const preEl = layer.querySelector('[data-eq-pre]'); if (preEl) { preEl.value = 0; setOut('pre', 0); }
      markCustom(); applyEq(); saveEq(); drawEqCurve();
    }
  });
  drawEqCurve();
}
// Kurve der Einstellung + Live-Spektrum der Musik
function drawEqCurve() {
  cancelAnimationFrame(eqRaf);
  const cv = $('#dialog-layer .eq-canvas');
  if (!cv) return;
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e9b44c';
  const xOf = (f) => (Math.log10(f / 20) / Math.log10(20000 / 20)) * W;
  const spec = eq.analyser ? new Uint8Array(eq.analyser.frequencyBinCount) : null;
  const frame = () => {
    g.clearRect(0, 0, W, H);
    g.strokeStyle = 'rgba(243,241,236,.08)';
    g.lineWidth = 1;
    for (const db of [-12, -6, 0, 6, 12]) { const y = H / 2 - (db / 12) * (H / 2 - 16); g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    // Spektrum (nur wenn Musik durch den Equalizer läuft)
    if (spec && eq.on && isEqEl(audio) && !audio.paused) {
      eq.analyser.getByteFrequencyData(spec);
      const ny = eq.ctx.sampleRate / 2;
      g.fillStyle = 'rgba(243,241,236,.10)';
      for (let x = 0; x < W; x += 6) {
        const f = 20 * Math.pow(1000, x / W);
        const v = spec[Math.min(spec.length - 1, Math.round((f / ny) * spec.length))] / 255;
        g.fillRect(x, H - v * H, 4, v * H);
      }
    }
    // Einstellungskurve
    g.beginPath();
    for (let x = 0; x <= W; x += 4) {
      const f = 20 * Math.pow(1000, x / W);
      let db = 0;
      EQ_FREQS.forEach((cf, i) => { const d = Math.log2(f / cf); db += eq.gains[i] * Math.exp(-(d * d) / 0.9); });
      const y = H / 2 - (Math.max(-14, Math.min(14, db)) / 12) * (H / 2 - 16);
      x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.strokeStyle = eq.on ? accent : 'rgba(243,241,236,.35)';
    g.lineWidth = 4;
    g.stroke();
    EQ_FREQS.forEach((cf, i) => {
      g.beginPath();
      g.arc(xOf(cf), H / 2 - (eq.gains[i] / 12) * (H / 2 - 16), 7, 0, Math.PI * 2);
      g.fillStyle = eq.on ? accent : 'rgba(243,241,236,.35)';
      g.fill();
    });
    if (spec && !reducedMotion()) eqRaf = requestAnimationFrame(frame);
  };
  frame();
}

/* =========================================================
   Smart Shuffle: mischt passende Empfehlungen ein
   ========================================================= */
const artistKeys = (t) => {
  const parts = [t.artist, t.albumArtist || ''];
  if (t.title.includes(' - ')) parts.push(t.title.split(' - ')[0]);
  return [...new Set(parts.join(',').split(/\s*(?:,|&|\/|\bx\b|\bfeat\.?|\bft\.?|\bund\b)\s*/i).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 1))];
};
// Wer arbeitet mit wem? (aus allen Features der Bibliothek)
let _collab = null;
function collabGraph() {
  if (_collab && _collab.size === S.tracks.size) return _collab.g;
  const g = new Map();
  for (const t of S.tracks.values()) {
    const ks = artistsOf(t).map(artKey);
    for (const a of ks) { if (!g.has(a)) g.set(a, new Map()); for (const b of ks) if (a !== b) g.get(a).set(b, (g.get(a).get(b) || 0) + 1); }
  }
  _collab = { size: S.tracks.size, g };
  return g;
}
// Wie gut passt Titel t hinter base? Schlau zwischen Künstlern wechseln statt immer derselbe
function recommendFor(base, exclude, neighbors = []) {
  if (!base) return null;
  const now = Date.now();
  if (isOnline(base) && !base.live) {
    const mine = new Set(artistKeys(base));
    const pool = [...remote.values()].filter((t) => t.remote === 'audius' && !exclude.has(t.id) && t.id !== base.id);
    const scored = pool.map((t) => [artistKeys(t).filter((a) => mine.has(a)).length * 3 + (t.genre === base.genre ? 1.5 : 0) + Math.random() * 1.5, t.id]).filter((x) => x[0] > 1.6).sort((a, b) => b[0] - a[0]).slice(0, 8);
    return scored.length ? scored[Math.floor(Math.random() * scored.length)][1] : null;
  }
  const g = collabGraph();
  const baseKeys = artistsOf(base).map(artKey);
  const lead = baseKeys[0];
  const avoid = new Set(neighbors.map((id) => leadKey(id)).concat(lead));
  // Nähe: direkte Partner zählen stark, Partner der Partner schwächer
  const near = new Map();
  for (const k of baseKeys) for (const [p, c] of g.get(k) || []) near.set(p, (near.get(p) || 0) + 2 + Math.min(3, c));
  for (const [p] of g.get(lead) || []) for (const [q, c] of g.get(p) || []) if (!baseKeys.includes(q)) near.set(q, (near.get(q) || 0) + Math.min(1.5, c * 0.5));
  // Geschmack: was hörst du viel?
  const taste = stats.summary('month').artists;
  const top = taste[0]?.sec || 1;
  const like = new Map(taste.slice(0, 30).map((a) => [a.key, a.sec / top]));
  const by = parseInt(base.year, 10) || 0;
  const mix = PB.smartMix; // 'close' = nah am Song, 'balanced', 'wide' = mehr Abwechslung
  const scored = [];
  for (const t of S.tracks.values()) {
    if (t.live || exclude.has(t.id) || t.id === base.id) continue;
    if (t.lastPlayed && now - t.lastPlayed < 3 * 3600e3) continue; // nicht gerade erst gehört
    if (/instrumental/i.test(t.version || '')) continue;
    const ks = artistsOf(t).map(artKey);
    let s = 0;
    for (const k of ks) s += near.get(k) || 0;
    if (ks.some((k) => baseKeys.includes(k))) s += mix === 'close' ? 3 : 1.5; // gleiche Crew
    if (avoid.has(ks[0])) s -= mix === 'close' ? 2 : 6; // nicht derselbe Künstler direkt hintereinander
    if (albumKeyOf(t) === albumKeyOf(base)) s -= 1.5;
    const ty = parseInt(t.year, 10) || 0;
    if (by && ty) s += Math.max(0, 1.5 - Math.abs(by - ty) * 0.3);
    s += (like.get(ks[0]) || 0) * 2;
    if (t.fav) s += 1.2;
    s += Math.random() * (mix === 'wide' ? 4 : mix === 'close' ? 1 : 2.2);
    if (s > 1) scored.push([s, t.id]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const pick = scored.slice(0, mix === 'wide' ? 14 : 8);
  return pick.length ? pick[Math.floor(Math.random() * pick.length)][1] : null;
}
// Hält die nächsten Songs gefüllt: nach je drei Songs eine Empfehlung
const recAdded = new Set(); // Empfehlungen, die neu dazukamen (nicht nur nach vorne geholt)
function topUpSmart() {
  if (!S.smart || !S.queue.length) return;
  const WINDOW = 14;
  // Gesperrt: schon gehört und die nächsten Plätze. Songs weiter hinten dürfen nach vorne geholt werden.
  const near = new Set(S.queue.slice(0, Math.min(S.queue.length, S.index + WINDOW + 1)));
  let run = 0;
  let changed = false;
  for (let i = S.index + 1; i < Math.min(S.queue.length, S.index + WINDOW); i++) {
    if (S.recs.has(S.queue[i])) { run = 0; continue; }
    run++;
    if (run === 3) {
      const rec = recommendFor(getT(S.queue[i]) || getT(curId), near, [S.queue[i], S.queue[i + 1]].filter(Boolean));
      if (!rec) break;
      const later = S.queue.indexOf(rec, i + 1);
      if (later > -1) S.queue.splice(later, 1); else recAdded.add(rec);
      S.queue.splice(i + 1, 0, rec);
      S.recs.add(rec);
      near.add(rec);
      changed = true;
      run = 0;
      i++;
    }
  }
  if (changed) { saveState(); if (overlays.includes('queue')) renderQueue(); }
}
function removeRecsAhead() {
  // Neu hinzugefügte Empfehlungen wieder raus, nach vorne geholte Songs bleiben einfach drin
  S.queue = S.queue.filter((id, i) => i <= S.index || !recAdded.has(id));
  S.recs = new Set([...S.recs].filter((id) => S.queue.indexOf(id) <= S.index));
  recAdded.clear();
}

// ---- Media Session (Sperrbildschirm, Kopfhörertasten) ----
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* nicht unterstützt */ } };
  h('play', () => { if (deferred) { togglePlay(); return; } wantPlay = true; audio.play().catch(() => {}); });
  h('pause', () => audio.pause());
  h('stop', () => audio.pause());
  h('previoustrack', prev);
  h('nexttrack', () => next());
  h('seekto', (d) => { if (d.fastSeek && 'fastSeek' in audio) audio.fastSeek(d.seekTime); else audio.currentTime = d.seekTime; updatePosState(); });
  // Keine ±10-Sekunden-Knöpfe: dann zeigt der Sperrbildschirm „Zurück“ und „Weiter“
  h('seekbackward', null);
  h('seekforward', null);
}
const artCache = new Map();
async function artworkDataUrl(coverId) {
  if (!coverId) return null;
  if (coverId.startsWith('url:')) return coverUrl(coverId);
  if (artCache.has(coverId)) return artCache.get(coverId);
  const rec = await db.get('covers', coverId).catch(() => null);
  if (!rec) return null;
  const url = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = () => r(null); fr.readAsDataURL(rec.blob); });
  artCache.set(coverId, url);
  return url;
}
async function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const t = getT(curId);
  if (!t) { navigator.mediaSession.metadata = null; return; }
  const id = curId;
  const art = await artworkDataUrl(t.coverId);
  if (id !== curId) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist, album: t.album,
    artwork: art
      ? (art.startsWith('data:') ? ['96x96', '256x256', '512x512', '600x600'].map((sizes) => ({ src: art, sizes, type: 'image/jpeg' })) : [{ src: art, sizes: '480x480' }])
      : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
  updatePosState();
}
function updatePosState() {
  try {
    if (!('mediaSession' in navigator)) return;
    const t = getT(curId);
    if (!t || t.live) { navigator.mediaSession.setPositionState?.(); return; }
    const d = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : t.duration || 0;
    if (!d) return;
    const pos = deferred ? Math.min(deferred.startAt || 0, d) : Math.min(audio.currentTime || 0, d);
    navigator.mediaSession.setPositionState({ duration: d, position: pos, playbackRate: audio.paused ? 1 : audio.playbackRate || 1 });
  } catch { /* */ }
}

// ---- Player-UI ----
const npEls = {};
let lastShownId = null;
function cacheNpEls() {
  for (const k of ['title', 'artist-link', 'cover', 'fav', 'play', 'shuffle', 'repeat', 'cur', 'dur', 'bar', 'source', 'sleep', 'sleep-label', 'vol-icon', 'bug-label', 'lyrics-btn']) {
    npEls[k] = $$(`[data-np="${k}"]`);
  }
  npEls.seek = $$('[data-seek]');
  npEls.vol = $$('[data-vol]');
}

async function updatePlayerUI() {
  const t = getT(curId);
  $('#player').classList.toggle('hidden', !t);
  document.body.classList.toggle('has-player', !!t);
  document.body.classList.toggle('is-live', !!t?.live);
  if (!t) { document.title = 'VERS'; closeAllOverlays(); return; }
  npEls.title.forEach((e) => { e.textContent = t.title; e.title = t.title; });
  npEls['artist-link'].forEach((e) => {
    e.textContent = t.live ? `Live-Radio · ${t.artist}` : t.artist;
    e.href = t.live ? '#/radio' : t.artistId ? `#/oartist/${encodeURIComponent(t.artistId)}` : `#/artist/${encodeURIComponent(artistsOf(t)[0] || t.artist)}`;
  });
  npEls.cover.forEach((e) => {
    setCoverEl(e, t.coverId, t.album + t.artist);
    e.classList.toggle('station-art', !!t.live);
    if (t.live && !t.coverId) e.innerHTML = icon('radio');
  });
  npEls.source.forEach((e) => { e.textContent = S.source || 'Deiner Bibliothek'; });
  updateFavUI();
  updatePlayState();
  document.title = `${t.title} · ${t.artist}`;
  if (lastShownId !== t.id) {
    // Signatur-Moment: Der Score-Bug wischt bei jedem neuen Titel einmal herein
    lastShownId = t.id;
    $$('.pb-left, .np-meta').forEach((el) => { el.classList.remove('wipe'); void el.offsetWidth; el.classList.add('wipe'); });
  }
  const id = curId;
  if (lyricsOpen && overlays.includes('np')) renderLyrics();
  // Live-Cover: großes, unscharfes Cover treibt langsam hinter dem Vollbild-Player
  const liveImg = $('.np-live-img');
  const liveUrl = t.coverId && !t.live ? await coverUrl(t.coverId) : null;
  if (id !== curId) return;
  liveImg.style.backgroundImage = liveUrl ? `url("${liveUrl.replace(/"/g, '%22')}")` : '';
  $('.np-live').classList.toggle('has-img', !!liveUrl);
  const tint = await tintOf(t.coverId);
  if (id !== curId) return;
  const c = tint || `hsl(${hue(t.album + t.artist)} 35% 32%)`;
  $('#np').style.setProperty('--tint', c);
  $('#player').style.setProperty('--tint', c);
}
function updateFavUI() {
  const t = getT(curId);
  const on = t?.live ? isRadioFav(t.id) : !!t?.fav;
  npEls.fav.forEach((e) => {
    e.innerHTML = icon(on ? 'heart-fill' : 'heart');
    e.classList.toggle('fav-on', on);
    e.setAttribute('aria-label', on ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen');
  });
}
function updatePlayState() {
  const playing = !audio.paused && !!curId;
  document.body.classList.toggle('is-playing', playing);
  npEls.play.forEach((e) => { e.innerHTML = icon(playing ? 'pause' : 'play'); });
  const live = !!getT(curId)?.live;
  npEls['bug-label'].forEach((e) => { e.textContent = live ? '● Live' : playing ? 'Läuft' : 'Pause'; });
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = curId ? (playing ? 'playing' : 'paused') : 'none';
}
function updateProgress() {
  const t = getT(curId);
  const live = !!t?.live;
  const d = live ? 0 : Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : t?.duration || 0;
  const c = audio.currentTime || 0;
  const p = live ? 1 : d ? Math.min(1, c / d) : 0;
  if (!seeking) {
    npEls.seek.forEach((r) => { r.value = Math.round(p * 1000); r.style.setProperty('--p', p * 100 + '%'); r.disabled = live; });
    npEls.cur.forEach((e) => { e.textContent = fmt(c); });
  }
  npEls.dur.forEach((e) => { e.textContent = live ? '● LIVE' : fmt(d); });
  npEls.bar.forEach((e) => { e.style.width = p * 100 + '%'; });
}
function updateModeButtons() {
  npEls.shuffle.forEach((e) => {
    e.classList.toggle('on', S.shuffle);
    e.classList.toggle('smart', S.smart);
    e.innerHTML = icon(S.smart ? 'shuffle-smart' : 'shuffle');
    const label = S.smart ? 'Smart Shuffle an (tippen: aus)' : S.shuffle ? 'Zufall an (tippen: Smart Shuffle)' : 'Zufallswiedergabe (S)';
    e.title = label;
    e.setAttribute('aria-label', label);
  });
  npEls.repeat.forEach((e) => { e.classList.toggle('on', S.repeat !== 'off'); e.innerHTML = icon(S.repeat === 'one' ? 'repeat1' : 'repeat'); });
}
function updateVolumeUI() {
  const v = vol.muted ? 0 : vol.level;
  npEls.vol.forEach((r) => { r.value = Math.round(v * 100); r.style.setProperty('--p', v * 100 + '%'); });
  npEls['vol-icon'].forEach((e) => { e.innerHTML = icon(v === 0 ? 'mute' : v < 0.5 ? 'volume-low' : 'volume'); });
}
function markPlaying(root = document) {
  root.querySelectorAll('.row.playing:not(.q-row)').forEach((r) => r.classList.remove('playing'));
  if (curId) root.querySelectorAll(`.row[data-id="${curId}"]:not(.q-row)`).forEach((r) => r.classList.add('playing'));
}

// ---- Sleep-Timer ----
let sleepTick = null;
function clearSleep() {
  if (S.sleep?.timer) clearTimeout(S.sleep.timer);
  S.sleep = null;
  clearInterval(sleepTick);
  updateSleepUI();
}
function setSleep(mins) {
  clearSleep();
  if (mins === 'end') { S.sleep = { mode: 'end' }; toast('Wiedergabe stoppt nach diesem Titel'); }
  else if (mins) {
    S.sleep = { mode: 'time', at: Date.now() + mins * 60000, timer: setTimeout(fadeOutAndPause, mins * 60000) };
    sleepTick = setInterval(updateSleepUI, 15000);
    toast(`Sleep-Timer: ${mins} Minuten`);
  }
  updateSleepUI();
}
function fadeOutAndPause() {
  const el = audio;
  fade(el, 'out', 6, () => { el.pause(); volFactor.delete(el); applyVol(el); clearSleep(); });
}
function updateSleepUI() {
  let label = 'Sleep-Timer';
  if (S.sleep?.mode === 'end') label = 'Nach diesem Titel';
  else if (S.sleep?.mode === 'time') label = `${Math.max(1, Math.ceil((S.sleep.at - Date.now()) / 60000))} Min.`;
  npEls.sleep.forEach((e) => { e.classList.toggle('on', !!S.sleep); e.title = label; });
  npEls['sleep-label'].forEach((e) => { e.textContent = label; });
}
function sleepMenu(anchor) {
  const cur = S.sleep;
  const opts = [5, 15, 30, 45, 60, 90].map((m) => ({ label: `${m} Minuten`, icon: 'clock', fn: () => setSleep(m) }));
  openMenu([
    ...(cur ? [{ label: 'Timer ausschalten', icon: 'x', fn: () => { clearSleep(); toast('Sleep-Timer aus'); } }, { sep: true }] : []),
    ...opts,
    { label: 'Ende des Titels', icon: 'moon', fn: () => setSleep('end') },
  ], anchor);
}

/* =========================================================
   Live-Lyrics
   ========================================================= */
// LRC: [mm:ss.xx]Zeile – mehrere Zeitstempel pro Zeile erlaubt, [offset:+/-ms] wird beachtet
function parseLyrics(text) {
  if (!text || !text.trim()) return null;
  const stampRe = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
  let offset = 0;
  const timed = [];
  const plain = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    const off = line.match(/^\[offset:\s*([+-]?\d+)\]$/i);
    if (off) { offset = +off[1] / 1000; continue; }
    if (/^\[[a-z]+:[^\]]*\]$/i.test(line)) continue; // [ar:…], [ti:…] usw.
    const stamps = [...line.matchAll(stampRe)];
    const txt = line.replace(stampRe, '').replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
    if (stamps.length) for (const s of stamps) timed.push({ t: +s[1] * 60 + parseFloat(s[2].replace(':', '.')), text: txt });
    else plain.push(txt);
  }
  if (timed.length >= 2) {
    return { synced: true, lines: timed.map((l) => ({ ...l, t: Math.max(0, l.t - offset) })).sort((a, b) => a.t - b.t) };
  }
  const lines = plain.filter((l, i, a) => l || (i > 0 && a[i - 1])).map((text) => ({ t: null, text }));
  return lines.some((l) => l.text) ? { synced: false, lines } : null;
}

let lyricsOpen = false;
let lyricsFor = null;
let lyricsParsed = null;
let lyricsIdx = -1;
let lyricsUserScroll = 0;
let lyricsRaf = 0;

function setLyricsMode(on) {
  lyricsOpen = on;
  $('#np').classList.toggle('lyrics-on', on);
  npEls['lyrics-btn']?.forEach((b) => b.classList.toggle('on', on));
  if (on) { renderLyrics(true); startLyricsLoop(); } else cancelAnimationFrame(lyricsRaf);
}
function renderLyrics(force = false) {
  const box = $('#np-lyrics');
  const t = getT(curId);
  if (!box || (!force && lyricsFor === curId)) return;
  lyricsFor = curId;
  lyricsIdx = -1;
  const own = t && !t.live ? (t.lyrics || lyr.cachedText(t.id)) : '';
  lyricsParsed = own ? parseLyrics(own) : null;
  if (!t) { box.innerHTML = ''; return; }
  if (t.live) { box.innerHTML = '<div class="ly-empty"><p>Beim Live-Radio gibt es keine Songtexte.</p></div>'; return; }
  if (!lyricsParsed) {
    const instr = /instrumental/i.test(`${t.version || ''} ${t.title}`);
    const tryNet = !instr && navigator.onLine && !lyr.isMiss(t.id);
    if (tryNet) {
      box.innerHTML = `<div class="ly-empty ly-loading"><span class="spinner"></span><p>Songtext wird geladen …</p></div>`;
      const id = t.id;
      lyr.get(t).then(() => { if (curId === id && lyricsFor === id) renderLyrics(true); }).catch(() => {});
      lyricsFor = null; // nach dem Laden neu zeichnen
      lyricsFor = id;
      return;
    }
    box.innerHTML = `<div class="ly-empty">
      <p class="ly-empty-title">${instr ? 'Instrumental' : navigator.onLine ? 'Kein Songtext gefunden' : 'Offline: Songtext noch nicht geladen'}</p>
      <p>${instr ? 'Dieser Song hat keinen Gesang. Lehn dich zurück.' : 'Du kannst den Text selbst einfügen. Mit Zeitstempeln wie [01:23.45] läuft er live mit.'}</p>
      ${instr ? '' : `<div class="btns"><button class="btn btn-accent" data-action="lyrics-edit">${icon('edit')}Songtext einfügen</button>${navigator.onLine ? `<button class="btn" data-action="lyrics-retry">${icon('refresh')}Nochmal suchen</button>` : ''}<button class="btn" data-action="lyrics-file">${icon('upload')}.lrc-Datei</button></div>`}
    </div>`;
    return;
  }
  const { synced, lines } = lyricsParsed;
  box.innerHTML = `<div class="ly-lines ${synced ? 'synced' : ''}">${lines.map((l, i) => l.text
    ? `<p class="ly-line" data-i="${i}" ${synced ? `role="button" tabindex="0" data-t="${l.t}"` : ''}>${esc(l.text)}</p>`
    : `<p class="ly-gap" data-i="${i}" aria-hidden="true">${synced ? '♪' : ''}</p>`).join('')}</div>
    <div class="ly-foot">${synced ? '' : '<span>Nicht synchronisiert · </span>'}${t.lyrics ? '' : '<span>Quelle: LRCLIB · </span>'}<button class="link-sm" data-action="lyrics-edit">Bearbeiten</button></div>`;
  box.scrollTop = 0;
  syncLyrics(true);
}
function syncLyrics(jump = false) {
  if (!lyricsOpen || !lyricsParsed?.synced) return;
  const now = (audio.currentTime || 0) + 0.25;
  const lines = lyricsParsed.lines;
  let i = -1;
  for (let k = 0; k < lines.length; k++) { if (lines[k].t <= now) i = k; else break; }
  if (i === lyricsIdx && !jump) return;
  lyricsIdx = i;
  const box = $('#np-lyrics');
  box.querySelectorAll('.ly-line.on, .ly-gap.on').forEach((e) => e.classList.remove('on'));
  box.querySelectorAll('[data-i]').forEach((e) => e.classList.toggle('past', +e.dataset.i < i));
  const el = box.querySelector(`[data-i="${i}"]`);
  if (el) el.classList.add('on');
  if (Date.now() - lyricsUserScroll > 4000) {
    const target = el ? el.offsetTop - box.clientHeight * 0.38 : 0;
    box.scrollTo({ top: Math.max(0, target), behavior: jump || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
}
function startLyricsLoop() {
  cancelAnimationFrame(lyricsRaf);
  const tick = () => { syncLyrics(); if (lyricsOpen) lyricsRaf = requestAnimationFrame(tick); };
  lyricsRaf = requestAnimationFrame(tick);
}
async function editLyrics(id = curId) {
  const t = getT(id);
  if (!t || t.live) return;
  const r = await openDialog({
    title: 'Songtext',
    body: `<label class="field"><span>Text oder LRC mit Zeitstempeln, z. B. [00:12.50] Erste Zeile</span><textarea name="text" rows="12" spellcheck="false" placeholder="[00:12.50] …">${esc(t.lyrics || lyr.cachedText(t.id) || '')}</textarea></label>`,
    buttons: [{ label: 'Abbrechen' }, { label: 'Speichern', primary: true, value: 'ok' }],
  });
  if (!r) return;
  await saveLyrics(id, r.data.text || '');
}
async function saveLyrics(id, text) {
  const t = getT(id);
  if (!t) return;
  t.lyrics = text.trim();
  if (t.remote && !S.tracks.has(id)) await ensureSaved([id]);
  else await db.put('tracks', t);
  toast(t.lyrics ? 'Songtext gespeichert' : 'Songtext entfernt');
  if (id === curId) renderLyrics(true);
}

/* =========================================================
   Farbe & Live-Cover
   ========================================================= */
const liveCoverOn = () => ls.get('klang-live', true);
function setAccent(name) {
  ls.set('klang-accent', name);
  applyAccent(name);
  $$('.swatch').forEach((s) => s.classList.toggle('on', s.dataset.name === name));
}
function applyLiveCover() {
  $('#np').classList.toggle('live-on', liveCoverOn());
}
function colorMenu(anchor) {
  const cur = ls.get('klang-accent', 'Gold');
  const live = liveCoverOn();
  openMenu([
    { header: '<div><b>Farbe &amp; Live-Cover</b><span>Die Farbe gilt für Play, Fortschritt und Score-Bug</span></div>' },
    ...ACCENTS.map((a) => ({ label: a.name, swatch: a.a, checked: a.name === cur, fn: () => { setAccent(a.name); toast(`Farbe: ${a.name}`, 1400); } })),
    { sep: true },
    { label: live ? 'Live-Cover ausschalten' : 'Live-Cover einschalten', icon: 'sparkle', checked: live, fn: () => { ls.set('klang-live', !live); applyLiveCover(); toast(live ? 'Live-Cover aus' : 'Live-Cover an', 1400); } },
  ], anchor);
}

/* =========================================================
   Warteschlange
   ========================================================= */
function renderQueue() {
  const el = $('#queue-list');
  const cur = getT(S.queue[S.index]);
  let html = '';
  if (cur) html += `<div class="q-label">Läuft gerade</div>${qRow(cur, S.index, true)}`;
  const upcoming = S.queue.slice(S.index + 1, S.index + 1 + 300);
  html += `<div class="q-label">Als Nächstes${S.source ? ` · ${esc(S.source)}` : ''}</div>`;
  html += upcoming.map((id, j) => { const t = getT(id); return t ? qRow(t, S.index + 1 + j) : ''; }).join('');
  if (!upcoming.length) html += '<p class="muted pad">Keine weiteren Titel. Füge welche über das ⋯-Menü hinzu.</p>';
  const more = S.queue.length - (S.index + 1 + upcoming.length);
  if (more > 0) html += `<p class="muted pad">… und ${plural(more, 'weiterer Titel', 'weitere Titel')}</p>`;
  el.innerHTML = html;
  hydrateCovers(el);
}
function qRow(t, qi, current = false) {
  return `<div class="row q-row ${current ? 'playing current' : ''}" data-qi="${qi}" data-id="${t.id}">
    ${current ? '' : `<button class="q-handle" aria-label="Verschieben (Pfeiltasten)" title="Ziehen zum Verschieben">${icon('grip')}</button>`}
    ${coverHTML(t.coverId, t.album + t.artist, `row-cover ${t.live ? 'station-art' : ''}`, t.live ? 'radio' : 'music')}
    <div class="row-main"><div class="row-title">${eqHTML()}<span class="t">${esc(t.title)}</span></div><div class="row-sub">${S.recs.has(t.id) ? `<span class="rec-tag">${icon('sparkle')}Empfohlen</span> · ` : ''}${esc(t.artist)}</div></div>
    ${current ? '<span></span>' : `<button class="icon-btn row-more" data-action="q-remove" aria-label="Entfernen">${icon('x')}</button>`}
  </div>`;
}
// Verschieben in der Warteschlange (nur kommende Titel)
function moveQueue(from, to) {
  if (from === to || from <= S.index || to <= S.index || to >= S.queue.length) return;
  const [id] = S.queue.splice(from, 1);
  S.queue.splice(to, 0, id);
  saveState();
  renderQueue();
  const h = $(`#queue-list .q-row[data-qi="${to}"] .q-handle`);
  if (h && document.activeElement?.classList.contains('q-handle')) h.focus();
}
function setupQueueDrag() {
  const list = $('#queue-list');
  list.addEventListener('keydown', (e) => {
    const h = e.target.closest('.q-handle');
    if (!h || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    e.stopPropagation();
    const qi = +h.closest('.q-row').dataset.qi;
    moveQueue(qi, qi + (e.key === 'ArrowUp' ? -1 : 1));
  });
  list.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.q-handle');
    if (!h || e.button > 0) return;
    e.preventDefault();
    const row = h.closest('.q-row');
    const rows = [...list.querySelectorAll('.q-row:not(.current)')];
    const rects = rows.map((r) => r.getBoundingClientRect());
    const idx = rows.indexOf(row);
    const hgt = rects[idx].height;
    const scroller = list.closest('#queue') ? list : list;
    const st0 = scroller.scrollTop;
    const y0 = e.clientY;
    let to = idx, lastY = e.clientY, raf = 0;
    try { h.setPointerCapture(e.pointerId); } catch { /* */ }
    row.classList.add('dragging');
    list.classList.add('sorting');
    const layout = () => {
      const dy = lastY - y0 + (scroller.scrollTop - st0);
      row.style.transform = `translateY(${dy}px)`;
      const cy = rects[idx].top + hgt / 2 + dy - (scroller.scrollTop - st0);
      const absY = cy + (scroller.scrollTop - st0);
      to = idx;
      for (let i = 0; i < rects.length; i++) {
        const mid = rects[i].top + rects[i].height / 2;
        if (i < idx && absY < mid) { to = i; break; }
        if (i > idx && absY > mid) to = i;
      }
      rows.forEach((r, i) => {
        if (r === row) return;
        const sh = idx < to && i > idx && i <= to ? -hgt : to < idx && i >= to && i < idx ? hgt : 0;
        r.style.transform = sh ? `translateY(${sh}px)` : '';
      });
      // Am Rand automatisch scrollen
      const b = scroller.getBoundingClientRect();
      if (lastY < b.top + 50) scroller.scrollTop -= 8; else if (lastY > b.bottom - 50) scroller.scrollTop += 8;
      if (lastY < b.top + 50 || lastY > b.bottom - 50) raf = requestAnimationFrame(layout); else raf = 0;
    };
    const move = (ev) => { lastY = ev.clientY; if (!raf) raf = requestAnimationFrame(layout); };
    const up = () => {
      cancelAnimationFrame(raf);
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      h.removeEventListener('pointercancel', up);
      list.classList.remove('sorting');
      rows.forEach((r) => { r.style.transform = ''; });
      row.classList.remove('dragging');
      if (to !== idx) moveQueue(+rows[idx].dataset.qi, +rows[to].dataset.qi);
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
  });
}
function removeFromQueue(qi) {
  if (qi === S.index) return;
  const [id] = S.queue.splice(qi, 1);
  if (qi < S.index) S.index--;
  const oi = S.original.indexOf(id);
  if (oi >= 0) S.original.splice(oi, 1);
  saveState();
  renderQueue();
}

/* =========================================================
   Bibliothek: Import
   ========================================================= */
const AUDIO_EXT = /\.(mp3|m4a|mp4|aac|flac|ogg|oga|opus|wav|wave|weba|webm|aif|aiff|caf)$/i;
const IMG_NAME = /(^|\/)(cover|folder|front|album|albumart[^/]*)\.(jpe?g|png|webp)$/i;
const isAudio = (f) => AUDIO_EXT.test(f.name) || (f.type || '').startsWith('audio/');
const dirOf = (p) => p.slice(0, p.lastIndexOf('/') + 1);

function getDuration(blob) {
  return new Promise((res) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    let done = false;
    const fin = (d) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      a.removeAttribute('src');
      res(Number.isFinite(d) ? d : 0);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => fin(a.duration);
    a.onerror = () => fin(0);
    setTimeout(() => fin(0), 8000);
    a.src = url;
  });
}

// ZIP-Pakete (z. B. „für unterwegs“) auspacken. Unterstützt unkomprimierte ZIPs (so baut sie VERS);
// gelesen wird nur das Inhaltsverzeichnis, die Songs werden als Ausschnitte der Datei übernommen.
const isZip = (f) => /\.zip$/i.test(f.name) || /zip/.test(f.type || '');
async function unzipStored(file) {
  const tailLen = Math.min(file.size, 65557);
  const tail = new Uint8Array(await file.slice(file.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('keine ZIP-Datei');
  const tv = new DataView(tail.buffer, eocd);
  const count = tv.getUint16(10, true);
  const cdSize = tv.getUint32(12, true);
  const cdOff = tv.getUint32(16, true);
  const cd = new Uint8Array(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dv = new DataView(cd.buffer);
  const out = [];
  let skipped = 0;
  for (let i = 0, p = 0; i < count && p + 46 <= cd.length; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const nameBytes = cd.subarray(p + 46, p + 46 + nlen);
    const name = new TextDecoder(flags & 0x0800 ? 'utf-8' : 'windows-1252').decode(nameBytes);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/') || /(^|\/)(__MACOSX|\.)/.test(name)) continue;
    if (method !== 0) { skipped++; continue; } // komprimierte Einträge kann VERS nicht auspacken
    const lh = new DataView(await file.slice(lho, lho + 30).arrayBuffer());
    const start = lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const base = name.split('/').pop();
    const type = AUDIO_EXT.test(base) ? guessType(base) : /\.lrc$/i.test(base) ? 'text/plain' : '';
    out.push({ file: new File([file.slice(start, start + csize)], base, { type }), path: name });
  }
  return { items: out, skipped };
}

let importing = false;
async function importItems(items) {
  if (importing) { toast('Import läuft bereits …'); return []; }
  if (items.some((x) => isZip(x.file))) {
    const expanded = [];
    for (const x of items) {
      if (!isZip(x.file)) { expanded.push(x); continue; }
      try {
        const z = await unzipStored(x.file);
        expanded.push(...z.items);
        if (z.skipped) toast(`${plural(z.skipped, 'Datei', 'Dateien')} im ZIP sind gepackt und wurden übersprungen. VERS-Pakete gehen immer.`, 5000);
      } catch { toast(`„${x.file.name}“ ist keine lesbare ZIP-Datei.`, 4000); }
    }
    items = expanded;
  }
  const audioItems = items.filter((x) => isAudio(x.file));
  // Songtexte (.lrc) gehören zum Song mit gleichem Dateinamen
  const baseKey = (p) => p.replace(/\.[^./]+$/, '').toLowerCase();
  const lrcMap = new Map();
  for (const x of items) if (/\.lrc$/i.test(x.file.name)) lrcMap.set(baseKey(x.path), x.file);
  if (!audioItems.length) {
    if (lrcMap.size) { await attachLyricsFiles(lrcMap); return []; }
    toast('Keine Audiodateien gefunden.');
    return [];
  }
  importing = true;

  // Cover-Bilder aus Ordnern (cover.jpg, folder.jpg …)
  const dirCovers = new Map();
  for (const x of items) {
    if (IMG_NAME.test(x.path) || IMG_NAME.test('/' + x.file.name)) {
      const d = dirOf(x.path);
      if (!dirCovers.has(d) || /cover|front/i.test(x.file.name)) dirCovers.set(d, x.file);
    }
  }

  const existing = new Map();
  for (const t of S.tracks.values()) existing.set(`${t.fileName}|${t.size}`, t.id);
  const prog = progressToast();
  const ids = [];
  let added = 0, skipped = 0, failed = 0;
  let lastRefresh = Date.now();
  const base = Date.now();

  for (let i = 0; i < audioItems.length; i++) {
    const { file, path } = audioItems[i];
    prog.update(i + 1, audioItems.length, file.name);
    const key = `${file.name}|${file.size}`;
    if (existing.has(key)) { skipped++; ids.push(existing.get(key)); continue; }
    try {
      const tags = await readTags(file);
      const id = uid();
      const album = tags.album;
      const coverKey = album !== 'Unbekanntes Album'
        ? `a:${(tags.albumArtist || tags.artist).toLowerCase()}|||${album.toLowerCase()}`
        : `t:${id}`;
      let cover = null;
      if (!coverKeys.has(coverKey)) {
        let src = tags.picture ? new Blob([tags.picture.data], { type: tags.picture.mime }) : dirCovers.get(dirOf(path)) || null;
        if (src) cover = { id: coverKey, blob: await makeCover(src) };
      }
      const type = file.type || guessType(file.name);
      let lyrics = tags.lyrics;
      const lrc = lrcMap.get(baseKey(path));
      if (lrc) { try { lyrics = (await lrc.text()).trim() || lyrics; } catch { /* */ } }
      const track = {
        id,
        lyrics,
        title: tags.title, artist: tags.artist, album, albumArtist: tags.albumArtist,
        year: tags.year, genre: tags.genre, trackNo: tags.trackNo, discNo: tags.discNo,
        duration: await getDuration(file),
        fileName: file.name, size: file.size, type,
        addedAt: base + i, coverId: cover || coverKeys.has(coverKey) ? coverKey : null,
        fav: false, favAt: 0, playCount: 0, lastPlayed: 0,
      };
      await db.addTrack(track, new Blob([file], { type }), cover);
      if (cover) coverKeys.add(coverKey);
      S.tracks.set(id, track);
      existing.set(key, id);
      ids.push(id);
      added++;
    } catch (e) {
      console.error('Import fehlgeschlagen:', file.name, e);
      failed++;
      if (e && e.name === 'QuotaExceededError') { toast('Speicher voll – Import abgebrochen.', 5000); break; }
    }
    if (Date.now() - lastRefresh > 1500) { lastRefresh = Date.now(); invalidate(); refresh(); }
  }

  prog.close();
  importing = false;
  invalidate();
  refresh();
  let msg = `${plural(added, 'Titel', 'Titel')} hinzugefügt`;
  if (skipped) msg += ` · ${skipped} schon vorhanden`;
  if (failed) msg += ` · ${failed} fehlgeschlagen`;
  toast(msg, 4000);
  if (added && navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  return ids;
}
// Nur .lrc-Dateien gewählt: den vorhandenen Songs mit gleichem Dateinamen zuordnen
async function attachLyricsFiles(lrcMap) {
  const byName = new Map();
  for (const t of S.tracks.values()) if (t.fileName) byName.set(t.fileName.replace(/\.[^.]+$/, '').toLowerCase(), t);
  let n = 0;
  for (const [key, file] of lrcMap) {
    const t = byName.get(key.split('/').pop());
    if (!t) continue;
    t.lyrics = (await file.text()).trim();
    await db.put('tracks', t);
    n++;
  }
  toast(n ? `${plural(n, 'Songtext', 'Songtexte')} zugeordnet` : 'Kein passender Song gefunden. Die .lrc-Datei muss wie die Musikdatei heißen.', 4000);
  if (n && overlays.includes('np')) renderLyrics(true);
}
function guessType(name) {
  const ext = name.split('.').pop().toLowerCase();
  return ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', wave: 'audio/wav', webm: 'audio/webm', weba: 'audio/webm', aif: 'audio/aiff', aiff: 'audio/aiff' })[ext] || 'audio/mpeg';
}

async function filesFromDrop(dt) {
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files].map((f) => ({ file: f, path: f.name }));
  const out = [];
  const walk = async (entry, path) => {
    if (entry.isFile) {
      try { const f = await new Promise((res, rej) => entry.file(res, rej)); out.push({ file: f, path: path + f.name }); } catch { /* */ }
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res) => reader.readEntries(res, () => res([])));
        for (const e of batch) await walk(e, path + entry.name + '/');
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

/* =========================================================
   Bibliothek: Bearbeiten, Löschen, Favoriten, Playlists
   ========================================================= */
async function setFav(id, val) {
  const t = getT(id);
  if (!t) return;
  if (t.live) {
    toggleRadioFav(t, val);
    if (id === curId) updateFavUI();
    if (parseRoute().name === 'radio') refresh();
    toast(val ? 'Zu „Meine Sender“ hinzugefügt' : 'Aus „Meine Sender“ entfernt', 1600);
    return;
  }
  t.fav = val;
  t.favAt = val ? Date.now() : 0;
  if (val && PB.autoDlFavs && canDownload(t)) setTimeout(() => downloadTracks([t.id]), 300);
  if (t.remote && val && !S.tracks.has(id)) { S.tracks.set(id, t); invalidate(); }
  if (S.tracks.has(id)) {
    if (!val && isOnline(t) && !inPlaylist(id)) {
      // Online-Titel ohne Favorit/Playlist wieder aus der Bibliothek nehmen
      S.tracks.delete(id);
      remote.set(id, t);
      await db.del('tracks', id);
      invalidate();
    } else await db.put('tracks', t);
  }
  $$(`.row[data-id="${id}"] .row-fav`).forEach((b) => { b.classList.toggle('on', val); b.innerHTML = icon(val ? 'heart-fill' : 'heart'); });
  $$(`.ft-fav[data-id="${id}"]`).forEach((b) => { b.classList.toggle('on', val); b.innerHTML = `${icon(val ? 'heart-fill' : 'heart')}<span>Favorit</span>`; });
  if (id === curId) updateFavUI();
  if (parseRoute().name === 'favorites') refresh();
  toast(val ? 'Zu Favoriten hinzugefügt' : 'Aus Favoriten entfernt', 1600);
}

// Online-Titel dauerhaft in die Bibliothek übernehmen (z. B. für Playlists)
async function ensureSaved(ids) {
  const out = [];
  for (const id of ids) {
    const t = getT(id);
    if (!t || t.live) continue;
    if (!S.tracks.has(id)) { S.tracks.set(id, t); await db.put('tracks', t); invalidate(); }
    out.push(id);
  }
  return out;
}

async function editTrack(id) {
  const t = S.tracks.get(id);
  if (!t) return;
  const f = (name, label, val, type = 'text') => `<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${esc(val)}" autocomplete="off"></label>`;
  const r = await openDialog({
    title: 'Infos bearbeiten',
    body: f('title', 'Titel', t.title) + f('artist', 'Künstler', t.artist) + f('album', 'Album', t.album) + f('albumArtist', 'Album-Künstler (optional)', t.albumArtist || '')
      + `<div class="field-grid">${f('trackNo', 'Track-Nr.', t.trackNo || '', 'number')}${f('year', 'Jahr', t.year || '', 'number')}</div>`
      + `<p class="muted" style="font-size:13px">Datei: ${esc(t.fileName)}</p>`,
    buttons: [{ label: 'Abbrechen' }, { label: 'Speichern', primary: true, value: 'ok' }],
  });
  if (!r) return;
  const d = r.data;
  t.title = d.title.trim() || t.title;
  t.artist = d.artist.trim() || 'Unbekannter Künstler';
  t.artists = splitNames(t.artist);
  t.album = d.album.trim() || 'Unbekanntes Album';
  t.albumArtist = d.albumArtist.trim();
  t.trackNo = parseInt(d.trackNo, 10) || 0;
  t.year = (d.year || '').trim().slice(0, 4);
  await db.put('tracks', t);
  invalidate();
  refresh();
  if (id === curId) { updatePlayerUI(); updateMediaSession(); }
  toast('Gespeichert');
}

async function changeAlbumCover(albumKey) {
  const a = getAlbums().get(albumKey);
  if (!a) return;
  const file = await pickFile('#image-input');
  if (!file) return;
  const blob = await makeCover(file);
  const cid = 'c:' + uid();
  await db.put('covers', { id: cid, blob });
  coverKeys.add(cid);
  const old = new Set(a.tracks.map((t) => t.coverId).filter(Boolean));
  for (const t of a.tracks) t.coverId = cid;
  await db.putMany('tracks', a.tracks);
  await cleanupCovers(old);
  invalidate();
  refresh();
  if (a.tracks.some((t) => t.id === curId)) { updatePlayerUI(); updateMediaSession(); }
  toast('Cover aktualisiert');
}
function pickFile(sel) {
  return new Promise((res) => {
    const inp = $(sel);
    inp.value = '';
    inp.onchange = () => res(inp.files[0] || null);
    inp.click();
  });
}
async function cleanupCovers(ids) {
  const used = new Set([...S.tracks.values()].map((t) => t.coverId));
  for (const id of ids) {
    if (id && !used.has(id) && !id.startsWith('a:')) {
      await db.del('covers', id).catch(() => {});
      coverKeys.delete(id);
      const p = coverUrls.get(id);
      if (p) { p.then((u) => u && URL.revokeObjectURL(u)); coverUrls.delete(id); }
      tintCache.delete(id);
      artCache.delete(id);
    }
  }
}

async function deleteTracks(ids, ask = true) {
  ids = ids.filter((id) => S.tracks.has(id));
  if (!ids.length) return;
  if (ask) {
    const one = ids.length === 1 ? S.tracks.get(ids[0]) : null;
    const ok = await confirmDialog(
      one ? 'Titel löschen?' : `${ids.length} Titel löschen?`,
      one ? `„${esc(one.title)}“ wird aus deiner Bibliothek und von diesem Gerät entfernt.` : 'Die Titel werden aus deiner Bibliothek und von diesem Gerät entfernt.',
      'Löschen', true,
    );
    if (!ok) return;
  }
  const del = new Set(ids);
  const covers = new Set();
  for (const id of ids) {
    const t = S.tracks.get(id);
    covers.add(t.coverId);
    S.tracks.delete(id);
    await db.del('tracks', id);
    await db.del('audio', id);
    if (t.remote) { t.fav = false; remote.set(id, t); del.delete(id); } // bleibt online abspielbar
  }
  for (const p of S.playlists) {
    const before = p.trackIds.length;
    p.trackIds = p.trackIds.filter((x) => !ids.includes(x));
    if (p.trackIds.length !== before) await db.put('playlists', p);
  }
  // Warteschlange anpassen
  if (S.queue.length) {
    const curDeleted = del.has(curId);
    const removedBefore = S.queue.slice(0, S.index).filter((x) => del.has(x)).length;
    S.queue = S.queue.filter((x) => !del.has(x));
    S.original = S.original.filter((x) => !del.has(x));
    if (!S.queue.length) stopPlayback();
    else {
      S.index = Math.min(Math.max(0, S.index - removedBefore), S.queue.length - 1);
      if (curDeleted) { const was = !audio.paused; loadAndPlay(was); }
      saveState();
    }
  }
  await cleanupCovers(covers);
  invalidate();
  renderSidebarPlaylists();
  refresh();
  toast(ids.length === 1 ? 'Titel gelöscht' : `${ids.length} Titel gelöscht`);
}

async function createPlaylist(name, ids = []) {
  const p = { id: uid(), name, trackIds: ids.slice(), createdAt: Date.now(), updatedAt: Date.now() };
  S.playlists.push(p);
  await db.put('playlists', p);
  renderSidebarPlaylists();
  return p;
}
async function savePlaylist(p) {
  p.updatedAt = Date.now();
  await db.put('playlists', p);
  renderSidebarPlaylists();
}
async function newPlaylistFlow(ids = []) {
  const name = await promptText('Neue Playlist', { placeholder: 'Name der Playlist', ok: 'Erstellen', value: `Meine Playlist #${S.playlists.length + 1}` });
  if (!name) return null;
  const p = await createPlaylist(name, ids);
  if (ids.length) toast(`Zu „${name}“ hinzugefügt`);
  return p;
}
async function pickPlaylist(ids) {
  if (ids.some((id) => getT(id)?.live)) {
    ids = ids.filter((id) => !getT(id)?.live);
    if (!ids.length) { toast('Radiosender können nicht in Playlists. Nutze das Herz für „Meine Sender“.', 3500); return; }
  }
  const body = `<div class="pick-list">
    <button class="pick" data-value="__new"><span class="pick-ic">${icon('plus')}</span><span>Neue Playlist</span></button>
    ${S.playlists.map((p) => `<button class="pick" data-value="${p.id}">${playlistCover(p, 'mini')}<span>${esc(p.name)}<small>${plural(p.trackIds.length, 'Titel', 'Titel')}</small></span></button>`).join('')}
  </div>`;
  const pr = openDialog({ title: 'Zu Playlist hinzufügen', body, buttons: [{ label: 'Abbrechen' }] });
  hydrateCovers($('#dialog-layer'));
  const r = await pr;
  if (!r) return;
  ids = await ensureSaved(ids);
  if (r.value === '__new') { await newPlaylistFlow(ids); refresh(); return; }
  const p = S.playlists.find((x) => x.id === r.value);
  if (!p) return;
  const fresh = ids.filter((id) => !p.trackIds.includes(id));
  if (!fresh.length) { toast('Schon in der Playlist'); return; }
  p.trackIds.push(...fresh);
  await savePlaylist(p);
  toast(`Zu „${p.name}“ hinzugefügt`);
  if (parseRoute().name === 'playlist' || parseRoute().name === 'playlists') refresh();
}
async function renamePlaylist(id) {
  const p = S.playlists.find((x) => x.id === id);
  if (!p) return;
  const name = await promptText('Playlist umbenennen', { value: p.name });
  if (!name) return;
  p.name = name;
  await savePlaylist(p);
  refresh();
}
async function deletePlaylist(id) {
  const p = S.playlists.find((x) => x.id === id);
  if (!p) return;
  if (!await confirmDialog('Playlist löschen?', `„${esc(p.name)}“ wird gelöscht. Die Titel bleiben in deiner Bibliothek.`, 'Löschen', true)) return;
  S.playlists = S.playlists.filter((x) => x.id !== id);
  await db.del('playlists', id);
  renderSidebarPlaylists();
  if (parseRoute().name === 'playlist') location.hash = '#/playlists'; else refresh();
  toast('Playlist gelöscht');
}
async function movePlaylistTrack(pid, from, to) {
  const p = S.playlists.find((x) => x.id === pid);
  if (!p || to < 0 || to >= p.trackIds.length || from === to) return;
  const [id] = p.trackIds.splice(from, 1);
  p.trackIds.splice(to, 0, id);
  await savePlaylist(p);
  refresh();
}
async function removeFromPlaylist(pid, index) {
  const p = S.playlists.find((x) => x.id === pid);
  if (!p) return;
  p.trackIds.splice(index, 1);
  await savePlaylist(p);
  refresh();
  toast('Aus Playlist entfernt', 1600);
}

/* =========================================================
   Kontextmenüs
   ========================================================= */
function trackMenu(id, anchor, ctx = {}) {
  const t = getT(id);
  if (!t) return;
  const header = { header: `${coverHTML(t.coverId, t.album + t.artist, t.live ? 'station-art' : '', t.live ? 'radio' : 'music')}<div><b>${esc(t.title)}</b><span>${esc(t.live ? 'Live-Radio · ' + t.artist : t.artist)}</span></div>` };
  if (t.live) {
    const fav = isRadioFav(id);
    const items = [header,
      { label: 'Jetzt hören', icon: 'play', fn: () => playIds([id], 0, { source: 'Radio' }) },
      { label: fav ? 'Aus „Meine Sender“ entfernen' : 'Zu „Meine Sender“ hinzufügen', icon: fav ? 'heart-fill' : 'heart', fn: () => setFav(id, !fav) },
    ];
    if (t.homepage?.startsWith('http')) items.push({ sep: true }, { label: 'Website des Senders', icon: 'external', fn: () => window.open(t.homepage, '_blank', 'noopener') });
    openMenu(items, anchor);
    return;
  }
  const items = [
    header,
    { label: 'Als Nächstes abspielen', icon: 'play-next', fn: () => playNext([id]) },
    { label: 'Zur Warteschlange hinzufügen', icon: 'list-plus', fn: () => addToQueue([id]) },
    ...(canDownload(t) ? [isDl(id) ? { label: 'Download entfernen', icon: 'dl-done', fn: () => removeDownloads([id]).then(() => toast('Download entfernt')) } : { label: 'Herunterladen (offline)', icon: 'download', fn: () => downloadTracks([id]) }] : []),
    { label: 'Zu Playlist hinzufügen', icon: 'playlist', fn: () => pickPlaylist([id]) },
    { label: t.fav ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen', icon: t.fav ? 'heart-fill' : 'heart', fn: () => setFav(id, !t.fav) },
    { sep: true },
  ];
  if (isOnline(t)) {
    if (t.artistId) items.push({ label: 'Zum Künstler', icon: 'user', fn: () => go('oartist', t.artistId) });
    if (t.permalink) items.push({ label: 'Auf Audius öffnen', icon: 'external', fn: () => window.open(t.permalink, '_blank', 'noopener') });
  } else {
    const names = artistsOf(t);
    items.push({ label: 'Zum Album', icon: 'disc', fn: () => go('album', albumKeyOf(t)) },
      ...names.slice(0, 4).map((n) => ({ label: names.length > 1 ? `Zu ${n}` : 'Zum Künstler', icon: 'user', fn: () => go('artist', n) })));
  }
  if (ctx.playlist) {
    const p = S.playlists.find((x) => x.id === ctx.playlist);
    if (p) {
      items.push({ sep: true });
      if (ctx.index > 0) items.push({ label: 'Nach oben verschieben', icon: 'arrow-up', fn: () => movePlaylistTrack(p.id, ctx.index, ctx.index - 1) });
      if (ctx.index < p.trackIds.length - 1) items.push({ label: 'Nach unten verschieben', icon: 'arrow-down', fn: () => movePlaylistTrack(p.id, ctx.index, ctx.index + 1) });
      items.push({ label: 'Aus dieser Playlist entfernen', icon: 'x', fn: () => removeFromPlaylist(p.id, ctx.index) });
    }
  }
  items.push({ sep: true }, { label: t.lyrics ? 'Songtext bearbeiten' : 'Songtext hinzufügen', icon: 'lyrics', fn: () => editLyrics(id) });
  if (ctx.np) items.push({ label: 'Farbe & Live-Cover', icon: 'palette', fn: () => colorMenu(anchor) }, { label: eq.on ? 'Equalizer (an)' : 'Equalizer', icon: 'equalizer', fn: () => eqDialog() });
  if (!isOnline(t)) items.push({ label: 'Infos bearbeiten', icon: 'edit', fn: () => editTrack(id) });
  if (S.tracks.has(id)) {
    if (isOnline(t)) items.push({ sep: true });
    items.push({ label: 'Aus Bibliothek löschen', icon: 'trash', danger: true, fn: () => deleteTracks([id]) });
  }
  openMenu(items, anchor);
}

function albumMenu(key, anchor) {
  const a = getAlbums().get(key);
  if (!a) return;
  const ids = a.tracks.map((t) => t.id);
  openMenu([
    { header: `${coverHTML(a.coverId, a.key)}<div><b>${esc(a.name)}</b><span>${esc(a.artist)}</span></div>` },
    { label: 'Abspielen', icon: 'play', fn: () => playIds(ids, 0, { source: a.name }) },
    { label: 'Zufällig abspielen', icon: 'shuffle', fn: () => playIds(ids, 0, { source: a.name, shuffle: true }) },
    { label: 'Als Nächstes abspielen', icon: 'play-next', fn: () => playNext(ids) },
    { label: 'Zur Warteschlange hinzufügen', icon: 'list-plus', fn: () => addToQueue(ids) },
    { label: 'Zu Playlist hinzufügen', icon: 'playlist', fn: () => pickPlaylist(ids) },
    { sep: true },
    { label: 'Zum Künstler', icon: 'user', fn: () => go('artist', a.artist) },
    { label: 'Cover ändern', icon: 'image', fn: () => changeAlbumCover(key) },
    { label: 'Album löschen', icon: 'trash', danger: true, fn: () => deleteTracks(ids) },
  ], anchor);
}

function playlistMenu(id, anchor) {
  const p = S.playlists.find((x) => x.id === id);
  if (!p) return;
  openMenu([
    { label: 'Abspielen', icon: 'play', fn: () => playIds(p.trackIds, 0, { source: p.name }) },
    { label: 'Zufällig abspielen', icon: 'shuffle', fn: () => playIds(p.trackIds, 0, { source: p.name, shuffle: true }) },
    { label: 'Zur Warteschlange hinzufügen', icon: 'list-plus', fn: () => addToQueue(p.trackIds) },
    { sep: true },
    { label: 'Umbenennen', icon: 'edit', fn: () => renamePlaylist(id) },
    { label: 'Playlist löschen', icon: 'trash', danger: true, fn: () => deletePlaylist(id) },
  ], anchor);
}

/* =========================================================
   Rendering-Bausteine
   ========================================================= */
let lists = {};
let listSeq = 0;
function regList(ids, opts = {}) { const k = 'l' + listSeq++; lists[k] = { ids, opts }; return k; }
function listEl(k, head = true) {
  const o = lists[k].opts;
  const ids = lists[k].ids;
  const online = ids.length && ids.every((id) => isOnline(getT(id)));
  const h = head && !o.noHead ? `<div class="list-head">${o.rank ? '<span>Platz</span>' : ''}<span>${o.rank ? '' : '#'}</span><span>Titel</span>${o.numbers ? '' : `<span>${online ? 'Genre' : 'Album'}</span>`}<span></span><span class="r">${icon('clock')}</span><span></span></div>` : '';
  return `<div class="tracklist ${o.numbers ? 'no-album' : ''} ${o.rank ? 'ranked' : ''}" data-list="${k}">${h}</div>`;
}
const eqHTML = () => '<span class="eq"><i></i><i></i><i></i></span>';

function rowHTML(t, i, key, o) {
  const lead = o.numbers
    ? `<div class="row-num"><span class="n">${t.trackNo || i + 1}</span>${eqHTML()}</div>`
    : coverHTML(t.coverId, t.album + t.artist, 'row-cover');
  return `<div class="row" data-id="${t.id}" data-list="${key}" data-i="${i}"${o.playlist && finePointer() ? ' draggable="true"' : ''}>
    ${o.rank ? `<div class="row-rank ${i < 3 ? 'podium' : ''}">${i + 1}</div>` : ''}${lead}
    <div class="row-main"><div class="row-title">${o.numbers ? '' : eqHTML()}<span class="t">${esc(t.title)}</span>${t.version ? `<span class="ver">${esc(t.version)}</span>` : ''}</div><div class="row-sub">${esc(o.artistCtx ? artistsOf(t).filter((n) => artKey(n) !== o.artistCtx).join(', ') || artistsOf(t)[0] : t.artist)}</div></div>
    <div class="row-album">${esc(isOnline(t) ? t.genre || 'Online' : t.album)}</div>
    <button class="icon-btn row-fav ${t.fav ? 'on' : ''}" data-action="fav" aria-label="Favorit">${icon(t.fav ? 'heart-fill' : 'heart')}</button>
    <div class="row-dur">${fmt(t.duration)}</div>
    <button class="icon-btn row-more" data-action="track-menu" aria-label="Mehr Optionen">${icon('more')}</button>
  </div>`;
}

function mountLists(root) {
  root.querySelectorAll('.tracklist[data-list]').forEach((el) => {
    const key = el.dataset.list;
    const L = lists[key];
    if (!L) return;
    let n = 0;
    const more = () => {
      const end = Math.min(L.ids.length, n + 150);
      let html = '';
      for (let i = n; i < end; i++) { const t = getT(L.ids[i]); if (t) html += rowHTML(t, i, key, L.opts); }
      el.insertAdjacentHTML('beforeend', html);
      n = end;
      hydrateCovers(el);
      markPlaying(el);
      el.querySelectorAll('.row[data-id]').forEach((r) => { if (dlIds.has(r.dataset.id)) r.classList.add('is-dl'); });
      if (n < L.ids.length) {
        const s = document.createElement('div');
        s.className = 'sentinel';
        el.appendChild(s);
        const io = new IntersectionObserver((es) => {
          if (es[0].isIntersecting) { io.disconnect(); s.remove(); more(); }
        }, { root: $('#main'), rootMargin: '800px' });
        io.observe(s);
      }
    };
    more();
  });
}

function playButtons(k) {
  return `<button class="btn-play" data-action="play-list" data-list="${k}" aria-label="Abspielen">${icon('play')}</button>
    <button class="icon-btn lg" data-action="shuffle-list" data-list="${k}" title="Zufällig abspielen" aria-label="Zufällig abspielen">${icon('shuffle')}</button>${packBtn(k)}`;
}

// Kino-Wand-Kachel: quadratisches Cover; in Regalen wächst sie beim Fokus und zeigt Infos
function tile({ tag = 'a', attrs = '', cover, play = '', title, sub, info, cover1 = '' }) {
  return `<${tag} class="card" ${attrs}>
    <div class="card-frame">
      <div class="card-art">${cover}${play}</div>
      <div class="card-info" aria-hidden="true">
        <b>${esc(info.title)}</b>
        <span>${info.meta}</span>
        ${info.line ? `<em>${info.line}</em>` : ''}
        <i class="ci-play">${icon('play')}<u>${info.cta || 'Abspielen'}</u></i>
      </div>
    </div>
    <div class="card-title">${title}</div>
    <div class="card-sub">${sub}</div>${cover1}
  </${tag}>`;
}
function albumCard(a) {
  const dur = a.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  return tile({
    attrs: `href="#/album/${encodeURIComponent(a.key)}" data-album-key="${esc(a.key)}" data-tint-src="${esc(a.coverId || '')}"`,
    cover: coverHTML(a.coverId, a.key),
    play: `<button class="card-play" data-action="play-album" data-key="${esc(a.key)}" aria-label="${esc(a.name)} abspielen">${icon('play')}</button>`,
    title: esc(a.name),
    sub: `${esc(a.artist)}${a.year ? ' · ' + esc(a.year) : ''}`,
    info: { title: a.name, meta: `${esc(a.artist)}${a.year ? ' · ' + esc(a.year) : ''}`, line: `Album · ${plural(a.tracks.length, 'Titel', 'Titel')}${dur >= 60 ? ' · ' + fmtLong(dur) : ''}`, cta: 'Album öffnen' },
  });
}
function artistCard(a) {
  return `<a class="card center" href="#/artist/${encodeURIComponent(a.name)}">
    <div class="card-frame"><div class="card-art">${artistArt(a.name, a.coverId)}<button class="card-play" data-action="play-artist" data-name="${esc(a.name)}" aria-label="${esc(a.name)} abspielen">${icon('play')}</button></div></div>
    <div class="card-title">${esc(a.name)}</div>
    <div class="card-sub">${plural(a.tracks.length, 'Titel', 'Titel')}</div>
  </a>`;
}
function playlistCover(p, size = '') {
  const covers = [];
  const seen = new Set();
  for (const id of p.trackIds) {
    const t = S.tracks.get(id);
    if (t?.coverId && !seen.has(t.coverId)) { seen.add(t.coverId); covers.push(t.coverId); }
    if (covers.length === 4) break;
  }
  if (covers.length === 4 && size !== 'mini') return `<div class="mosaic">${covers.map((c) => coverHTML(c, c)).join('')}</div>`;
  const cls = size === 'hero' ? 'hero-art' : '';
  if (covers.length) return coverHTML(covers[0], p.id, cls);
  return `<div class="cover ${cls}" style="--h:${hue(p.name)}">${icon('playlist')}</div>`;
}
function playlistCard(p) {
  return tile({
    attrs: `href="#/playlist/${p.id}"`,
    cover: playlistCover(p),
    play: `<button class="card-play" data-action="play-playlist" data-id="${p.id}" aria-label="${esc(p.name)} abspielen">${icon('play')}</button>`,
    title: esc(p.name),
    sub: `Playlist · ${plural(p.trackIds.length, 'Titel', 'Titel')}`,
    info: { title: p.name, meta: 'Playlist', line: plural(p.trackIds.length, 'Titel', 'Titel'), cta: 'Playlist öffnen' },
  });
}

function onlineTrackCard(t, k, i) {
  return tile({
    tag: 'div',
    attrs: `role="button" tabindex="0" data-action="play-at" data-list="${k}" data-i="${i}" data-id="${t.id}" data-tint-src="${esc(t.coverId || '')}"`,
    cover: coverHTML(t.coverId, t.title),
    play: `<span class="card-play">${icon('play')}</span>`,
    title: esc(t.title),
    sub: esc(t.artist),
    info: { title: t.title, meta: `${esc(t.artist)}${t.genre ? ' · ' + esc(t.genre.split(',')[0]) : ''}`, line: `${fmt(t.duration)}${t.plays ? ` · ${fmtCount(t.plays)} Plays` : ''}` },
  });
}
function stationCard(s, k, i) {
  return tile({
    tag: 'div',
    attrs: `role="button" tabindex="0" data-action="play-at" data-list="${k}" data-i="${i}" data-id="${s.id}"`,
    cover: coverHTML(s.coverId, s.title, 'station-art', 'radio'),
    play: `<span class="card-play">${icon('play')}</span>`,
    title: esc(s.title),
    sub: esc(s.artist),
    info: { title: s.title, meta: esc(s.artist), line: '<span class="live-dot">● Live</span>', cta: 'Einschalten' },
  });
}
// Top 10 wie im Kino-Streaming: riesige Ziffer neben dem Cover
const top10Of = (ids, k) => `<div class="shelf top10">${ids.map((id, i) => `<div class="t10"><span class="t10-n" aria-hidden="true">${i + 1}</span>${onlineTrackCard(getT(id), k, i)}</div>`).join('')}</div>`;
function oartistCard(u) {
  return `<a class="card center" href="#/oartist/${encodeURIComponent(u.id)}">
    <div class="card-frame"><div class="card-art">${coverHTML(u.pic, u.name, 'round', 'user')}</div></div>
    <div class="card-title">${esc(u.name)}${u.verified ? ` <span class="verified" title="Verifiziert">${icon('check')}</span>` : ''}</div>
    <div class="card-sub">${u.followers ? `${fmtCount(u.followers)} Follower` : 'Künstler'}</div>
  </a>`;
}
const fmtCount = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' Mio.' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : n.toLocaleString('de'));
const shelfOf = (ids, k, card) => `<div class="shelf">${ids.map((id, i) => card(getT(id), k, i)).join('')}</div>`;
function applyTints(root) {
  $$('[data-tint]', root).forEach(async (el) => { const c = await tintOf(el.dataset.tint); if (c) el.style.setProperty('--tint', c); });
}

function pageHead(title, sub = '', actions = '') {
  return `<header class="page-head"><div><h1>${title}</h1>${sub ? `<p class="muted">${sub}</p>` : ''}</div><div class="head-actions">${actions}</div></header>`;
}
function libTabs(active) {
  return `<div class="chips m-only">${[['songs', 'Titel'], ['albums', 'Alben'], ['artists', 'Künstler'], ['favorites', 'Favoriten'], ['playlists', 'Playlists'], ['downloads', 'Downloads']]
    .map(([k, l]) => `<a class="chip ${k === active ? 'on' : ''}" href="#/${k}">${l}</a>`).join('')}</div>`;
}
function discTabs(active) {
  return `<div class="chips m-only">${[['discover', 'Musik'], ['radio', 'Radio']]
    .map(([k, l]) => `<a class="chip ${k === active ? 'on' : ''}" href="#/${k}">${l}</a>`).join('')}</div>`;
}
const settingsBtn = () => `<button class="m-only profile-btn" data-action="drawer" aria-label="Menü öffnen">${auth.current() ? avatarHTML(auth.current(), 'sm') : icon('menu')}</button>`;

function emptyLib() {
  const folder = finePointer() && 'webkitdirectory' in document.createElement('input');
  const onPc = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const cloud = !onPc && !cloudCfg() ? `<div class="empty cloud-empty">
    <h2>Deine Songs holen</h2>
    <p>Deine Musik liegt in deiner privaten Cloud. Diese Seite braucht einmal deinen Schlüssel, dann sind alle Songs da.</p>
    <ol class="steps">
      <li>Am PC <b>VERS starten</b> (VERS starten.bat).</li>
      <li>Dort auf <b>„Aufs Handy“</b> klicken.</li>
      <li>Handy: QR-Code scannen. PC: <b>„Link kopieren“</b> drücken und hier einfügen.</li>
    </ol>
    <div class="btns"><button class="btn btn-accent" data-action="cloud-link">${icon('link')}Link einfügen</button></div>
  </div>` : '';
  return `${cloud}<div class="empty">
    <h2>${cloud ? 'Oder Dateien von diesem Gerät' : 'Deine Bibliothek ist noch leer'}</h2>
    <p>Lade deine MP3s, M4As, FLACs oder WAVs. Sie bleiben auf diesem Gerät und spielen auch offline. Bis dahin läuft unten schon Musik von Audius und aus dem Radio.</p>
    <div class="btns">
      <button class="btn btn-accent" data-action="import-files">${icon('upload')}Dateien auswählen</button>
      ${folder ? `<button class="btn" data-action="import-folder">${icon('folder')}Ordner auswählen</button>` : ''}
      <a class="btn" href="#/discover">${icon('compass')}Online entdecken</a>
    </div>
    ${finePointer() ? '<p class="hint">Oder zieh Dateien und Ordner einfach ins Fenster.</p>' : ''}
  </div>`;
}
const notFound = () => `<div class="empty-small">Nicht gefunden. <a class="link" href="#/">Zur Startseite</a></div>`;

function sortedTrackIds(by) {
  const arr = [...S.tracks.values()];
  const cmp = {
    title: (a, b) => coll.compare(a.title, b.title),
    artist: (a, b) => coll.compare(a.artist, b.artist) || coll.compare(a.album, b.album) || (a.trackNo || 0) - (b.trackNo || 0),
    album: (a, b) => coll.compare(a.album, b.album) || (a.discNo || 0) - (b.discNo || 0) || (a.trackNo || 0) - (b.trackNo || 0),
    added: (a, b) => b.addedAt - a.addedAt,
    plays: (a, b) => (b.playCount || 0) - (a.playCount || 0) || (b.lastPlayed || 0) - (a.lastPlayed || 0),
    duration: (a, b) => (b.duration || 0) - (a.duration || 0),
  }[by] || ((a, b) => coll.compare(a.title, b.title));
  return arr.sort(cmp).map((t) => t.id);
}
function sortSelect(what, options) {
  return `<select class="select" data-change="sort" data-what="${what}" aria-label="Sortierung">${options.map(([v, l]) => `<option value="${v}" ${S.sort[what] === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
}

/* =========================================================
   Ansichten
   ========================================================= */
const views = {};
const after = {};

views.home = () => {
  const feature = `<section class="feature" id="feature" aria-label="Top-Songs der Woche"><div class="ft-tools m-only">${settingsBtn()}</div><div class="ft-stage">${featureSkeleton()}</div></section>`;
  const online = section('Top 10 diese Woche', '#/discover', '<div id="home-top10"></div>')
    + (radioFavs().length ? section('Meine Sender', '#/radio', '<div id="home-myradio"></div>') : '')
    + section('Radio hören', '#/radio', '<div id="home-radio"></div>');
  if (!S.tracks.size) return feature + online + section('Deine Bibliothek', '', emptyLib());
  const albums = [...getAlbums().values()];
  const recent = albums.filter((a) => a.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 14);
  const newest = albums.slice().sort((a, b) => b.addedAt - a.addedAt).slice(0, 14);
  const all = [...S.tracks.values()];
  const top = all.filter((t) => t.playCount).sort((a, b) => b.playCount - a.playCount).slice(0, 6);
  const favs = all.filter((t) => t.fav).length;
  const artists = [...getArtists().values()].sort((a, b) => b.tracks.reduce((s, t) => s + (t.playCount || 0), 0) - a.tracks.reduce((s, t) => s + (t.playCount || 0), 0) || b.tracks.length - a.tracks.length).slice(0, 14);

  const tiles = [
    `<a class="tile" href="#/favorites"><span class="tile-art">${icon('heart-fill')}</span><span class="tile-label"><span>Favoriten</span><small>${plural(favs, 'Titel', 'Titel')}</small></span></a>`,
    `<button class="tile" data-action="shuffle-all"><span class="tile-art">${icon('shuffle')}</span><span class="tile-label"><span>Zufallsmix</span><small>Alles durcheinander</small></span></button>`,
    `<button class="tile" data-action="play-newest"><span class="tile-art">${icon('sparkle')}</span><span class="tile-label"><span>Neu hinzugefügt</span><small>Die letzten 50 Titel</small></span></button>`,
    top.length ? `<button class="tile" data-action="play-top"><span class="tile-art">${icon('music')}</span><span class="tile-label"><span>Meistgespielt</span><small>Deine Top 50</small></span></button>` : '',
    ...S.playlists.slice(-2).reverse().map((p) => `<a class="tile" href="#/playlist/${p.id}">${playlistCover(p, 'mini').replace('class="cover', 'class="cover tile-art')}<span class="tile-label"><span>${esc(p.name)}</span><small>Playlist</small></span></a>`),
  ].join('');

  // Handy: eigene Musik zuerst, ruhiger Kopf statt großem Online-Karussell
  const hr = new Date().getHours();
  const hello = hr < 5 ? 'Gute Nacht' : hr < 11 ? 'Guten Morgen' : hr < 18 ? 'Hallo' : 'Guten Abend';
  const me = auth.current();
  const mHead = `<header class="m-home-head m-only"><div><small>${hello}${me ? ',' : ''}</small><h1>${esc(me?.display || 'VERS')}</h1></div>${settingsBtn()}</header>`;
  let html = mHead + feature.replace('class="feature"', 'class="feature d-only"') + `<div class="tiles">${tiles}</div>`;
  if (recent.length) html += section('Weiterhören', '#/albums', `<div class="shelf">${recent.map(albumCard).join('')}</div>`);
  html += online.split('</section>')[0] + '</section>';
  if (top.length) { const k = regList(top.map((t) => t.id), { source: 'Meistgespielt', noHead: true }); html += section('Deine Top-Titel', '', listEl(k, false)); }
  html += section('Neu in deiner Bibliothek', '#/albums', `<div class="shelf">${newest.map(albumCard).join('')}</div>`);
  if (artists.length > 1) html += section('Deine Künstler', '#/artists', `<div class="shelf">${artists.map(artistCard).join('')}</div>`);
  return html + online.split('</section>').slice(1).join('</section>');
};
after.home = () => {
  const trending = cached('trend:all:week', () => audius.trending(null, 'week', 50));
  trending.then((list) => mountFeature(adopt(list), 'Top der Woche')).catch(() => featureOffline());
  fillAsync('#home-top10', async () => {
    const ids = adopt(await trending);
    const k = regList(ids.slice(0, 10), { source: 'Top 10 diese Woche' });
    return top10Of(ids.slice(0, 10), k);
  });
  const my = $('#home-myradio');
  if (my) {
    const ids = adopt(radioFavs());
    const k = regList(ids, { source: 'Meine Sender' });
    my.innerHTML = shelfOf(ids, k, stationCard);
    hydrateCovers(my);
  }
  fillAsync('#home-radio', async () => {
    const ids = adopt(await cached('radio:top', () => radio.search(RADIO_CATS[0][2])));
    const k = regList(ids, { source: 'Radio' });
    return shelfOf(ids.slice(0, 16), k, stationCard);
  });
};

/* ---------- Entdecken (Audius) ---------- */
const GENRES = [
  ['all', 'Alle', null], ['electronic', 'Elektronisch', 'Electronic'], ['hiphop', 'Hip-Hop', 'Hip-Hop/Rap'], ['pop', 'Pop', 'Pop'],
  ['rock', 'Rock', 'Rock'], ['rnb', 'R&B', 'R&B/Soul'], ['lofi', 'Lo-Fi', 'Lo-Fi'], ['house', 'House', 'House'],
  ['techno', 'Techno', 'Techno'], ['trap', 'Trap', 'Trap'], ['alternative', 'Alternative', 'Alternative'], ['dnb', 'Drum & Bass', 'Drum & Bass'],
  ['dubstep', 'Dubstep', 'Dubstep'], ['ambient', 'Ambient', 'Ambient'], ['latin', 'Latin', 'Latin'], ['jazz', 'Jazz', 'Jazz'], ['classical', 'Klassik', 'Classical'],
];
const TIMES = [['week', 'Diese Woche'], ['month', 'Dieser Monat'], ['year', 'Dieses Jahr'], ['allTime', 'Aller Zeiten']];

views.discover = () => {
  const chips = GENRES.map(([k, l]) => `<button class="chip ${k === S.discGenre ? 'on' : ''}" data-action="disc-genre" data-genre="${k}">${l}</button>`).join('');
  return `<section class="feature" id="feature" aria-label="Angesagt"><div class="ft-tools">${discTabs('discover')}</div><div class="ft-stage">${featureSkeleton()}</div></section>`
    + `<div class="chips wrap disc-chips">${chips}</div><div id="disc-content"></div>`
    + '<p class="attribution">Musik über <a href="https://audius.co" target="_blank" rel="noopener">Audius</a>: Künstler laden ihre Songs dort selbst hoch und geben sie zum Streamen frei.</p>';
};
after.discover = () => fillAsync('#disc-content', async () => {
  const g = GENRES.find((x) => x[0] === S.discGenre) || GENRES[0];
  const tracks = await cached(`trend:${g[0]}:${S.discTime}`, () => audius.trending(g[2], S.discTime, 60));
  if (!tracks.length) { featureOffline('Hier ist gerade nichts im Trend.'); return '<div class="empty-small">Hier ist gerade nichts im Trend. Probier ein anderes Genre.</div>'; }
  const ids = adopt(tracks);
  mountFeature(ids, `Angesagt · ${g[1]}`);
  const k10 = regList(ids.slice(0, 10), { source: `Top 10 · ${g[1]}` });
  const k = regList(ids, { source: `Angesagt · ${g[1]}`, rank: true });
  const shelf10 = section(`Top 10 · ${g[1]}`, '', top10Of(ids.slice(0, 10), k10));
  const users = [];
  const seen = new Set();
  for (const t of tracks) {
    if (t.artistId && !seen.has(t.artistId)) { seen.add(t.artistId); users.push({ id: t.artistId, name: t.artist, pic: t.artistPic, verified: t.artistVerified, followers: t.artistFollowers }); }
  }
  const timeSel = `<select class="select" data-change="disc-time" aria-label="Zeitraum">${TIMES.map(([v, l]) => `<option value="${v}" ${v === S.discTime ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  return shelf10
    + `<div class="actions-bar">${playButtons(k)}<span style="flex:1"></span>${timeSel}</div>`
    + section('Die ganze Tabelle', '', listEl(k))
    + section('Künstler im Trend', '', `<div class="shelf">${users.slice(0, 14).map(oartistCard).join('')}</div>`);
});

/* ---------- Radio ---------- */
const RADIO_CATS = [
  ['top', 'Beliebt in DE', { countrycode: 'DE' }], ['charts', 'Charts', { tag: 'charts' }], ['pop', 'Pop', { tag: 'pop' }],
  ['hiphop', 'Hip-Hop', { tag: 'hip hop' }], ['rock', 'Rock', { tag: 'rock' }], ['dance', 'Dance', { tag: 'dance' }],
  ['electronic', 'Elektronisch', { tag: 'electronic' }], ['80s', '80er', { tag: '80s' }], ['90s', '90er', { tag: '90s' }],
  ['schlager', 'Schlager', { tag: 'schlager' }], ['chill', 'Chillout', { tag: 'chillout' }], ['jazz', 'Jazz', { tag: 'jazz' }],
  ['classical', 'Klassik', { tag: 'classical' }], ['world', 'Weltweit', {}],
];
views.radio = () => {
  const chips = RADIO_CATS.map(([k, l]) => `<button class="chip ${k === S.radioCat ? 'on' : ''}" data-action="radio-cat" data-cat="${k}">${l}</button>`).join('');
  const cat = RADIO_CATS.find((c) => c[0] === S.radioCat) || RADIO_CATS[0];
  const favs = radioFavs();
  let html = discTabs('radio') + pageHead('Radio', 'Tausende Live-Sender aus aller Welt, kostenlos');
  if (favs.length) {
    const ids = adopt(favs);
    const k = regList(ids, { source: 'Meine Sender' });
    html += section('Meine Sender', '', `<div class="grid">${ids.map((id, i) => stationCard(getT(id), k, i)).join('')}</div>`);
  }
  return html + section(cat[1] === 'Beliebt in DE' ? 'Sender entdecken' : `${cat[1]}-Sender`, '', `<div class="chips wrap">${chips}</div><div id="radio-grid"></div>`)
    + '<p class="attribution">Senderverzeichnis von <a href="https://www.radio-browser.info" target="_blank" rel="noopener">radio-browser.info</a>. Gestreamt wird direkt vom jeweiligen Sender.</p>';
};
after.radio = () => fillAsync('#radio-grid', async () => {
  const cat = RADIO_CATS.find((c) => c[0] === S.radioCat) || RADIO_CATS[0];
  const ids = adopt(await cached(`radio:${cat[0]}`, () => radio.search(cat[2])));
  if (!ids.length) return '<div class="empty-small">Keine Sender gefunden.</div>';
  const k = regList(ids, { source: `Radio · ${cat[1]}` });
  return `<div class="grid">${ids.map((id, i) => stationCard(getT(id), k, i)).join('')}</div>`;
});

/* ---------- Online-Künstler ---------- */
views.oartist = () => '<div id="oartist-wrap"></div>';
after.oartist = (id) => fillAsync('#oartist-wrap', async () => {
  const [u, tracks] = await Promise.all([cached(`u:${id}`, () => audius.user(id)), cached(`ut:${id}`, () => audius.userTracks(id))]);
  regAlts(u.pic, u.picAlts);
  const ids = adopt(tracks);
  const k = regList(ids, { source: u.name });
  const total = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  return `<div class="hero" style="--h:${hue(u.name)}" ${u.pic ? `data-tint="${esc(u.pic)}"` : ''}>
      ${coverHTML(u.pic, u.name, 'hero-art round', 'user')}
      <div class="hero-info"><h1>${esc(u.name)}</h1>
      <p>${u.verified ? `<span class="verified" title="Verifiziert">${icon('check')}</span> Verifiziert · ` : ''}Künstler · ${fmtCount(u.followers)} Follower · ${plural(ids.length, 'Titel', 'Titel')}${total ? ' · ' + fmtLong(total) : ''}</p></div>
    </div>
    <div class="actions-bar">${ids.length ? playButtons(k) : ''}<span style="flex:1"></span><a class="btn btn-sm" href="https://audius.co/${encodeURIComponent(u.handle)}" target="_blank" rel="noopener">${icon('external')}Auf Audius</a></div>
    ${u.bio ? `<p class="muted bio">${esc(u.bio)}</p>` : ''}
    ${ids.length ? section('Beliebte Titel', '', listEl(k)) : '<div class="empty-small">Dieser Künstler hat keine frei abspielbaren Titel.</div>'}`;
});
function section(title, href, inner) {
  return `<section class="section"><div class="section-head"><h2>${title}</h2>${href ? `<a class="link-sm" href="${href}">Alle anzeigen</a>` : ''}</div>${inner}</section>`;
}

views.songs = () => {
  S.lastLib = 'songs';
  if (!S.tracks.size) return libTabs('songs') + pageHead('Titel') + emptyLib();
  const ids = sortedTrackIds(S.sort.songs);
  const total = [...S.tracks.values()].reduce((s, t) => s + (t.duration || 0), 0);
  const k = regList(ids, { source: 'Alle Titel' });
  return libTabs('songs') + pageHead('Titel', `${plural(ids.length, 'Titel', 'Titel')}${total >= 60 ? ' · ' + fmtLong(total) : ''}`, `<button class="btn" data-action="import-files">${icon('plus')}Hinzufügen</button>`)
    + `<div class="actions-bar">${playButtons(k)}<span style="flex:1"></span>${sortSelect('songs', [['title', 'Titel A–Z'], ['artist', 'Künstler'], ['album', 'Album'], ['added', 'Zuletzt hinzugefügt'], ['plays', 'Meistgespielt']])}</div>`
    + listEl(k);
};

views.albums = () => {
  S.lastLib = 'albums';
  if (!S.tracks.size) return libTabs('albums') + pageHead('Alben') + emptyLib();
  const arr = [...getAlbums().values()];
  const by = S.sort.albums;
  arr.sort(by === 'artist' ? (a, b) => coll.compare(a.artist, b.artist) || coll.compare(a.name, b.name)
    : by === 'added' ? (a, b) => b.addedAt - a.addedAt
      : by === 'year' ? (a, b) => (b.year || 0) - (a.year || 0)
        : (a, b) => coll.compare(a.name, b.name));
  return libTabs('albums') + pageHead('Alben', plural(arr.length, 'Album', 'Alben'), sortSelect('albums', [['name', 'Name'], ['artist', 'Künstler'], ['added', 'Zuletzt hinzugefügt'], ['year', 'Jahr']]))
    + `<div class="grid">${arr.map(albumCard).join('')}</div>`;
};

views.album = (key) => {
  const a = getAlbums().get(key);
  if (!a) return notFound();
  const ids = a.tracks.map((t) => t.id);
  const dur = a.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const k = regList(ids, { numbers: true, source: a.name });
  return `<div class="hero" style="--h:${hue(a.key)}" ${a.coverId ? `data-tint="${esc(a.coverId)}"` : ''}>
      ${coverHTML(a.coverId, a.key, 'hero-art')}
      <div class="hero-info"><h1>${esc(a.name)}</h1>
      <p>Album · <a class="link" href="#/artist/${encodeURIComponent(a.artist)}">${esc(a.artist)}</a>${a.year ? ' · ' + esc(a.year) : ''} · ${plural(ids.length, 'Titel', 'Titel')}${dur >= 60 ? ' · ' + fmtLong(dur) : ''}</p></div>
    </div>
    <div class="actions-bar">${playButtons(k)}<button class="icon-btn lg" data-action="album-menu" data-key="${esc(a.key)}" aria-label="Mehr">${icon('more')}</button></div>
    ${listEl(k)}`;
};

views.artists = () => {
  S.lastLib = 'artists';
  if (!S.tracks.size) return libTabs('artists') + pageHead('Künstler') + emptyLib();
  const all = [...getArtists().values()];
  const main = all.filter(isMainArtist).sort((a, b) => coll.compare(a.name, b.name));
  const guests = all.filter((a) => !isMainArtist(a)).sort((a, b) => b.tracks.length - a.tracks.length || coll.compare(a.name, b.name));
  return libTabs('artists') + pageHead('Künstler', `${plural(main.length, 'Künstler', 'Künstler')}${guests.length ? ` · ${guests.length} Gäste` : ''}`)
    + `<div class="grid">${main.map(artistCard).join('')}</div>`
    + (guests.length ? section('Gäste &amp; Features', '', `<div class="artist-chips">${guests.map((a) => `<a class="chip" href="#/artist/${encodeURIComponent(a.name)}">${esc(a.name)} <small>${a.tracks.length}</small></a>`).join('')}</div>`) : '');
};

const artistSortOf = () => S.sort.artist || 'new';
function artistTrackOrder(tracks, by) {
  const listened = stats.trackSeconds();
  const yr = (t) => parseInt(t.year, 10) || 0;
  const arr = tracks.slice();
  if (by === 'az') arr.sort((a, b) => coll.compare(a.title, b.title));
  else if (by === 'top') arr.sort((a, b) => (listened.get(b.id) || 0) - (listened.get(a.id) || 0) || (b.playCount || 0) - (a.playCount || 0) || coll.compare(a.title, b.title));
  else arr.sort((a, b) => yr(b) - yr(a) || coll.compare(a.album, b.album) || (a.discNo || 0) - (b.discNo || 0) || (a.trackNo || 0) - (b.trackNo || 0));
  return arr.map((t) => t.id);
}
views.artist = (name) => {
  const a = getArtists().get(artKey(name));
  if (!a) return notFound();
  const n = a.key;
  const own = a.tracks.filter((t) => artKey(artistsOf(t)[0]) === n);
  const feats = a.tracks.filter((t) => artKey(artistsOf(t)[0]) !== n);
  const listened = stats.trackSeconds();
  const popular = a.tracks.slice().sort((x, y) => (listened.get(y.id) || 0) - (listened.get(x.id) || 0) || (y.playCount || 0) - (x.playCount || 0) || (parseInt(y.year, 10) || 0) - (parseInt(x.year, 10) || 0)).slice(0, 5).map((t) => t.id);
  const albums = [...getAlbums().values()].filter((al) => artKey(al.artist) === n || al.tracks.every((t) => artKey(artistsOf(t)[0]) === n))
    .sort((x, y) => (parseInt(y.year, 10) || 0) - (parseInt(x.year, 10) || 0) || coll.compare(x.name, y.name));
  const big = albums.filter((al) => al.tracks.length >= 4);
  const singles = albums.filter((al) => al.tracks.length < 4);
  const dur = a.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const mine = stats.artistSeconds(a.name);
  // Mit wem arbeitet der Künstler am meisten?
  const peers = new Map();
  for (const t of a.tracks) for (const o of artistsOf(t)) { const k = artKey(o); if (k !== n) peers.set(k, (peers.get(k) || 0) + 1); }
  const peerList = [...peers].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([k, c]) => [getArtists().get(k), c]).filter(([x]) => x);
  const by = artistSortOf();
  const kAll = regList(artistTrackOrder(a.tracks, by), { source: a.name });
  const kPop = regList(popular, { source: a.name, noHead: true });
  const kFeat = feats.length ? regList(artistTrackOrder(feats, 'new'), { source: `${a.name} · Features` }) : null;
  const years = a.tracks.map((t) => parseInt(t.year, 10)).filter(Boolean);
  const span = years.length ? (Math.min(...years) === Math.max(...years) ? `${Math.min(...years)}` : `${Math.min(...years)}–${Math.max(...years)}`) : '';
  const facts = [
    [own.length, own.length === 1 ? 'eigener Song' : 'eigene Songs'],
    [feats.length, feats.length === 1 ? 'Feature' : 'Features'],
    [big.length + singles.length, big.length + singles.length === 1 ? 'Release' : 'Releases'],
    [fmtLong(dur), 'Spielzeit'],
    ...(mine >= 60 ? [[fmtLong(mine), 'von dir gehört']] : []),
  ];
  return `<div class="hero artist-hero" style="--h:${hue(a.name)}" ${a.coverId ? `data-tint="${esc(a.coverId)}"` : ''}>
      ${artistArt(a.name, a.coverId, 'hero-art')}
      <div class="hero-info"><p class="eyebrow">Künstler${span ? ' · ' + span : ''}</p><h1>${esc(a.name)}</h1>
      <dl class="facts">${facts.map(([v, l]) => `<div><dt>${esc(String(v))}</dt><dd>${l}</dd></div>`).join('')}</dl></div>
    </div>
    <div class="actions-bar">${playButtons(kAll)}<button class="btn btn-ghost btn-sm pic-btn" data-action="artist-pic" data-name="${esc(a.name)}" aria-label="Künstlerbild ändern" title="Künstlerbild ändern">${icon('image')}<span>Bild ändern</span></button></div>
    ${section(mine >= 60 ? 'Deine Favoriten von ' + esc(a.name) : 'Beliebt', '', listEl(kPop, false))}
    ${big.length ? section('Alben', '', `<div class="shelf">${big.map(albumCard).join('')}</div>`) : ''}
    ${singles.length ? section('Singles &amp; EPs', '', `<div class="shelf">${singles.map(albumCard).join('')}</div>`) : ''}
    ${kFeat ? section(`Features <span class="muted sec-count">${feats.length}</span>`, '', listEl(kFeat)) : ''}
    <section class="section"><div class="section-head"><h2>Alle Titel <span class="muted sec-count">${a.tracks.length}</span></h2>
      <div class="chips seg" role="group" aria-label="Sortierung">${[['new', 'Neueste'], ['az', 'A–Z'], ['top', 'Meistgehört']].map(([k, l]) => `<button class="chip ${k === by ? 'on' : ''}" data-action="artist-sort" data-sort="${k}" aria-pressed="${k === by}">${l}</button>`).join('')}</div></div>
      ${listEl(kAll)}</section>
    ${peerList.length ? section('Oft zusammen mit', '', `<div class="peer-row">${peerList.map(([p, c]) => `<a class="peer" href="#/artist/${encodeURIComponent(p.name)}">${artistArt(p.name, p.coverId, 'peer-art')}<b>${esc(p.name)}</b><small>${plural(c, 'Song', 'Songs')}</small></a>`).join('')}</div>`) : ''}`;
};

/* ---------- Statistik: gehörte Minuten, Top-Künstler, Top-Songs ---------- */
const STAT_RANGES = [['today', 'Heute'], ['week', '7 Tage'], ['month', '30 Tage'], ['year', '12 Monate'], ['all', 'Gesamt']];
const minutes = (sec) => Math.round((sec || 0) / 60);
const fmtMin = (sec) => { const m = minutes(sec); return m >= 600 ? `${(m / 60).toLocaleString('de', { maximumFractionDigits: 0 })} Std.` : `${m.toLocaleString('de')} Min.`; };
function statBars(sum, range) {
  // Ein Balken pro Tag (7/30 Tage) bzw. pro Monat (12 Monate/Gesamt)
  const buckets = [];
  if (range === 'week' || range === 'month') {
    const n = range === 'week' ? 7 : 30;
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 864e5);
      const k = stats.dayKey(d);
      buckets.push({ label: d.toLocaleDateString('de', range === 'week' ? { weekday: 'short' } : { day: 'numeric' }), full: d.toLocaleDateString('de', { weekday: 'long', day: 'numeric', month: 'long' }), sec: sum.days.get(k) || 0, tick: range === 'week' || i % 5 === 0 || i === 0 });
    }
  } else if (range === 'year' || range === 'all') {
    const byMonth = new Map();
    for (const [k, v] of sum.days) byMonth.set(k.slice(0, 7), (byMonth.get(k.slice(0, 7)) || 0) + v);
    const now = new Date();
    let months = 12;
    if (range === 'all' && byMonth.size) {
      const first = [...byMonth.keys()].sort()[0];
      months = Math.max(1, (now.getFullYear() - +first.slice(0, 4)) * 12 + now.getMonth() - (+first.slice(5, 7) - 1) + 1);
    }
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      buckets.push({ label: d.toLocaleDateString('de', { month: 'short' }), full: d.toLocaleDateString('de', { month: 'long', year: 'numeric' }), sec: byMonth.get(k) || 0, tick: months <= 12 || i % 3 === 0 });
    }
  } else return '';
  const max = Math.max(60, ...buckets.map((b) => b.sec));
  const peak = buckets.reduce((a, b) => (b.sec > a.sec ? b : a), buckets[0]);
  const avg = buckets.reduce((s, b) => s + b.sec, 0) / buckets.length;
  return `<figure class="stat-chart" aria-label="Gehörte Minuten pro ${range === 'week' || range === 'month' ? 'Tag' : 'Monat'}">
    <figcaption><span>Minuten pro ${range === 'week' || range === 'month' ? 'Tag' : 'Monat'}</span><small>Ø ${fmtMin(avg)} · Spitze ${esc(peak.full)}: ${fmtMin(peak.sec)}</small></figcaption>
    <div class="bars" style="--n:${buckets.length}">
      ${buckets.map((b) => `<div class="bar-col" tabindex="0" data-tip="${esc(b.full)}: ${fmtMin(b.sec)}"><div class="bar" style="--v:${(b.sec / max).toFixed(4)}"></div><span class="bar-x">${b.tick ? esc(b.label) : ''}</span></div>`).join('')}
    </div>
  </figure>`;
}
views.stats = () => {
  const range = S.statRange || 'month';
  const sum = stats.summary(range);
  const trackSec = new Map(sum.tracks.map((x) => [x.id, x]));
  // Plays pro Künstler aus den gezählten Songs
  const artPlays = new Map();
  for (const x of sum.tracks) { const t = getT(x.id); if (!t) continue; for (const n of artistsOf(t)) { const k = artKey(n); artPlays.set(k, (artPlays.get(k) || 0) + x.plays); } }
  const topA = sum.artists.slice(0, 10);
  const maxA = topA[0]?.sec || 1;
  const topT = sum.tracks.filter((x) => getT(x.id)).slice(0, 10);
  const chips = `<div class="chips seg" role="group" aria-label="Zeitraum">${STAT_RANGES.map(([k, l]) => `<button class="chip ${k === range ? 'on' : ''}" data-action="stat-range" data-r="${k}" aria-pressed="${k === range}">${l}</button>`).join('')}</div>`;
  const head = libTabs('stats') + pageHead('Statistik', 'Echte Hörzeit, gezählt während die Musik läuft') + chips;
  if (sum.total < 30) {
    return head + `<div class="empty stat-empty"><h2>${range === 'today' ? 'Heute noch nichts gehört' : 'Noch keine Hörzeit'}</h2><p>Sobald Musik läuft, zählt VERS jede Minute mit: insgesamt, pro Künstler und pro Song. Ein Song gilt als gespielt, wenn du mindestens 30 Sekunden oder die Hälfte gehört hast.</p><div class="btns"><button class="btn btn-accent" data-action="shuffle-all">${icon('shuffle')}Zufallsmix starten</button></div></div>`;
  }
  const tiles = [
    [minutes(sum.total).toLocaleString('de'), 'Minuten gehört', sum.total >= 3600 ? `${(sum.total / 3600).toLocaleString('de', { maximumFractionDigits: 1 })} Stunden` : ''],
    [sum.plays.toLocaleString('de'), sum.plays === 1 ? 'Song gespielt' : 'Songs gespielt', ''],
    [sum.artists.length.toLocaleString('de'), 'Künstler', ''],
    [stats.streak().toLocaleString('de'), 'Tage am Stück', 'mind. 1 Minute pro Tag'],
  ];
  const kTop = topT.length ? regList(topT.map((x) => x.id), { source: 'Deine Top-Songs', noHead: true, rank: true }) : null;
  return head + `<div class="stat-tiles">${tiles.map(([v, l, sub], i) => `<div class="stat-tile ${i === 0 ? 'hero-tile' : ''}"><b>${v}</b><span>${l}</span>${sub ? `<small>${sub}</small>` : ''}</div>`).join('')}</div>
    ${statBars(sum, range)}
    <div class="stat-cols">
      ${section('Top-Künstler', '', `<ol class="rank-list">${topA.map((a, i) => {
        const real = getArtists().get(a.key);
        const name = real?.name || a.name;
        return `<li><a class="rank-row" href="#/artist/${encodeURIComponent(name)}">
          <span class="rk ${i < 3 ? 'podium' : ''}">${i + 1}</span>${artistArt(name, real?.coverId || artistPicId(name), 'rank-art')}
          <span class="rk-main"><b>${esc(name)}</b><span class="rk-bar"><i style="--v:${(a.sec / maxA).toFixed(4)}"></i></span></span>
          <span class="rk-num"><b>${fmtMin(a.sec)}</b><small>${Math.round((a.sec / sum.total) * 100)} %${artPlays.get(a.key) ? ` · ${plural(artPlays.get(a.key), 'Play', 'Plays')}` : ''}</small></span></a></li>`;
      }).join('')}</ol>`)}
      ${kTop ? section('Top-Songs', '', `<div class="top-songs">${listEl(kTop, false)}</div><p class="muted stat-note">Sortiert nach gehörter Zeit · ${esc(STAT_RANGES.find((r) => r[0] === range)[1])}</p>`) : ''}
    </div>
    <p class="muted stat-note">Gezählt seit ${new Date(sum.since).toLocaleDateString('de', { day: 'numeric', month: 'long', year: 'numeric' })}. Die Statistik bleibt auf diesem Gerät.</p>`;
};
after.stats = () => {
  // Minuten statt Länge in der Top-Songs-Liste
  const sum = stats.summary(S.statRange || 'month');
  const m = new Map(sum.tracks.map((x) => [x.id, x]));
  $$('.top-songs .row').forEach((r) => { const x = m.get(r.dataset.id); const d = r.querySelector('.row-dur'); if (x && d) { d.textContent = fmtMin(x.sec); d.title = plural(x.plays, 'Play', 'Plays'); } });
};

views.favorites = () => {
  S.lastLib = 'favorites';
  const ids = [...S.tracks.values()].filter((t) => t.fav).sort((a, b) => (b.favAt || 0) - (a.favAt || 0)).map((t) => t.id);
  const k = regList(ids, { source: 'Favoriten' });
  const head = libTabs('favorites') + `<div class="hero">
      <div class="cover hero-art fav-art">${icon('heart-fill')}</div>
      <div class="hero-info"><h1>Favoriten</h1><p>Playlist · ${plural(ids.length, 'Titel', 'Titel')}</p></div>
    </div>`;
  if (!ids.length) return head + '<div class="empty-small">Noch keine Favoriten. Tippe bei einem Titel auf das Herz.</div>';
  const open = ids.filter((id) => canDownload(getT(id)) && !isDl(id)).length;
  return head + `<div class="actions-bar">${playButtons(k)}<span style="flex:1"></span>${open ? `<button class="btn btn-sm" data-action="dl-favs" aria-label="Favoriten herunterladen">${icon('download')}<span>Alle laden (${open})</span></button>` : `<span class="dl-ok">${icon('dl-done')}Offline</span>`}</div>` + listEl(k);
};

views.playlists = () => {
  const cards = [
    `<button class="card card-new" data-action="new-playlist" style="text-align:left"><div class="card-frame"><div class="card-art"><div class="cover">${icon('plus')}</div></div></div><div class="card-title">Neue Playlist</div><div class="card-sub">Erstellen</div></button>`,
    `<a class="card" href="#/favorites"><div class="card-frame"><div class="card-art"><div class="cover fav-art">${icon('heart-fill')}</div><button class="card-play" data-action="play-favs" aria-label="Favoriten abspielen">${icon('play')}</button></div></div><div class="card-title">Favoriten</div><div class="card-sub">${plural([...S.tracks.values()].filter((t) => t.fav).length, 'Titel', 'Titel')}</div></a>`,
    ...S.playlists.slice().sort((a, b) => b.updatedAt - a.updatedAt).map(playlistCard),
  ];
  return pageHead('Playlists', plural(S.playlists.length, 'Playlist', 'Playlists'), settingsBtn()) + `<div class="grid">${cards.join('')}</div>`;
};

views.playlist = (id) => {
  const p = S.playlists.find((x) => x.id === id);
  if (!p) return notFound();
  const ids = p.trackIds.filter((x) => S.tracks.has(x));
  const dur = ids.reduce((s, x) => s + (S.tracks.get(x).duration || 0), 0);
  const k = regList(p.trackIds, { playlist: p.id, source: p.name });
  const firstCover = ids.map((x) => S.tracks.get(x).coverId).find(Boolean);
  return `<div class="hero" style="--h:${hue(p.name)}" ${firstCover ? `data-tint="${esc(firstCover)}"` : ''}>
      ${playlistCover(p, 'hero')}
      <div class="hero-info"><h1>${esc(p.name)}</h1>
      <p>Playlist · ${plural(ids.length, 'Titel', 'Titel')}${ids.length ? ' · ' + fmtLong(dur) : ''}</p></div>
    </div>
    <div class="actions-bar">${ids.length ? playButtons(k) : ''}<button class="icon-btn lg" data-action="playlist-menu" data-id="${p.id}" aria-label="Mehr">${icon('more')}</button></div>
    ${ids.length ? listEl(k) : `<div class="empty-small">Diese Playlist ist noch leer.<br>Füge Titel über das ⋯-Menü bei einem Song hinzu.</div>`}`;
};

views.search = () => `${pageHead('Suchen')}<div class="search-box">${icon('search')}<input id="search-input" type="search" placeholder="Song, Künstler, Album oder eine Zeile aus dem Text" value="${esc(S.search)}" autocomplete="off" enterkeyhint="search"></div><div id="search-results"></div>`;
after.search = () => {
  const inp = $('#search-input');
  let tm;
  inp.addEventListener('input', () => { S.search = inp.value; clearTimeout(tm); tm = setTimeout(renderSearch, 90); });
  renderSearch();
  if (finePointer() || !S.search) setTimeout(() => inp.focus(), 50);
};
function renderSearch() {
  const box = $('#search-results');
  if (!box) return;
  for (const k in lists) delete lists[k];
  const raw = S.search.trim();
  const q = norm(raw);
  clearTimeout(onlineSearchTimer);
  const token = ++searchToken;
  if (!q) {
    const artists = [...getArtists().values()].sort((a, b) => b.tracks.length - a.tracks.length).slice(0, 40);
    let html = section('Genres entdecken', '#/discover', `<div class="chips wrap">${GENRES.slice(1).map(([k, l]) => `<button class="chip" data-action="disc-genre" data-genre="${k}">${l}</button>`).join('')}</div>`)
      + section('Radio', '#/radio', `<div class="chips wrap">${RADIO_CATS.slice(1).map(([k, l]) => `<button class="chip" data-action="radio-cat" data-cat="${k}">${l}</button>`).join('')}</div>`);
    if (artists.length) html += section('Deine Künstler', '#/artists', `<div class="artist-chips">${artists.map((a) => `<a class="chip" href="#/artist/${encodeURIComponent(a.name)}">${esc(a.name)}</a>`).join('')}</div>`);
    box.innerHTML = html;
    return;
  }
  const terms = q.split(/\s+/);
  const match = (s) => terms.every((t) => s.includes(t));
  const f = S.searchFilter || 'all';
  const want = (k) => f === 'all' || f === k;
  const tracks = want('songs') ? [...S.tracks.values()].filter((t) => match(searchStr(t)))
    .sort((a, b) => (norm(b.title).startsWith(q) - norm(a.title).startsWith(q)) || (b.playCount || 0) - (a.playCount || 0) || coll.compare(a.title, b.title)) : [];
  const albums = want('albums') ? [...getAlbums().values()].filter((a) => match(norm(`${a.name} ${a.artist}`))).slice(0, f === 'albums' ? 60 : 14) : [];
  const artists = want('artists') ? [...getArtists().values()].filter((a) => match(norm(a.name)))
    .sort((a, b) => isMainArtist(b) - isMainArtist(a) || b.tracks.length - a.tracks.length).slice(0, f === 'artists' ? 60 : 14) : [];
  // Textstellen: Songs, in deren Songtext die Suche vorkommt
  const lterms = lyr.lnorm(raw).split(' ').filter((x) => x.length > 1);
  const hits = [];
  if (want('lyrics') && raw.length >= 3 && lterms.length) {
    for (const t of S.tracks.values()) {
      const line = lyr.matchLine(t.id, lterms);
      if (line != null) hits.push([t, line]);
      if (hits.length >= (f === 'lyrics' ? 80 : 12)) break;
    }
  }
  const hasLocal = tracks.length || albums.length || artists.length || hits.length;
  const chip = (k, l, n) => `<button class="chip ${k === f ? 'on' : ''}" data-action="search-filter" data-f="${k}" aria-pressed="${k === f}">${l}${n != null ? ` <small>${n}</small>` : ''}</button>`;
  let html = `<div class="chips seg search-filter" role="group" aria-label="Filter">${chip('all', 'Alles')}${chip('songs', 'Songs')}${chip('artists', 'Künstler')}${chip('albums', 'Alben')}${chip('lyrics', 'Songtexte')}${chip('online', 'Online')}</div>`;
  if (tracks.length) { const k = regList(tracks.slice(0, f === 'songs' ? 300 : 100).map((t) => t.id), { source: `Suche: ${raw}` }); html += section(`Songs <span class="muted sec-count">${tracks.length}</span>`, '', listEl(k)); }
  if (artists.length) html += section('Künstler', '', `<div class="shelf">${artists.map(artistCard).join('')}</div>`);
  if (hits.length) {
    const k = regList(hits.map(([t]) => t.id), { source: `Songtext: ${raw}` });
    const hl = (line) => { let h = esc(line); for (const t of terms) { const i = norm(line).indexOf(t); if (i >= 0 && t.length > 1) h = esc(line.slice(0, i)) + '<mark>' + esc(line.slice(i, i + t.length)) + '</mark>' + esc(line.slice(i + t.length)); break; } return h; };
    html += section(`Im Songtext <span class="muted sec-count">${hits.length}</span>`, '', `<div class="lyric-hits">${hits.map(([t, line], i) => `<button class="lyric-hit" data-action="play-hit" data-list="${k}" data-i="${i}">${coverHTML(t.coverId, t.album + t.artist, 'row-cover')}<span class="lh-main"><b>${esc(t.title)}</b><small>${esc(t.artist)}</small><q>${hl(line)}</q></span></button>`).join('')}</div>`);
  }
  if (albums.length) html += section('Alben', '', `<div class="shelf">${albums.map(albumCard).join('')}</div>`);
  if (want('lyrics') && !hits.length && f === 'lyrics') {
    const c = lyr.counts([...S.tracks.values()]);
    html += `<div class="empty-small">${raw.length < 3 ? 'Mindestens drei Buchstaben eingeben.' : `Keine Textstelle gefunden.`}<br><span class="muted">Durchsucht werden ${plural(c.have, 'geladener Songtext', 'geladene Songtexte')}.</span></div>`;
  }
  if (f !== 'all' && f !== 'online' && f !== 'lyrics' && !hasLocal) html += `<div class="empty-small">Keine Treffer für „${esc(raw)}“.</div>`;
  const online = (f === 'all' || f === 'online') && raw.length >= 2;
  html += `<div id="search-online">${online ? loadingHTML('Suche online …') : ''}</div>`;
  box.innerHTML = html;
  mountLists(box);
  hydrateCovers(box);
  if (!online) return;
  onlineSearchTimer = setTimeout(async () => {
    const el = $('#search-online');
    if (!el || token !== searchToken) return;
    const [ot, ou, os] = await Promise.all([
      cached(`st:${q}`, () => audius.searchTracks(raw)).catch(() => null),
      cached(`su:${q}`, () => audius.searchUsers(raw)).catch(() => null),
      cached(`sr:${q}`, () => radio.search({ name: raw, limit: 30 })).catch(() => null),
    ]);
    if (token !== searchToken || !el.isConnected) return;
    if (!ot && !ou && !os) { el.innerHTML = offlineHTML(); return; }
    let out = '';
    ou?.forEach((u) => regAlts(u.pic, u.picAlts));
    if (ou?.length) out += section('Künstler online', '', `<div class="shelf">${ou.map(oartistCard).join('')}</div>`);
    if (ot?.length) { const k = regList(adopt(ot), { source: `Suche: ${raw}` }); out += section('Songs online', '', listEl(k)); }
    if (os?.length) { const ids = adopt(os.slice(0, 16)); const k = regList(ids, { source: 'Radio' }); out += section('Radiosender', '', shelfOf(ids, k, stationCard)); }
    if (!out) out = hasLocal ? '' : `<div class="empty-small">Keine Treffer für „${esc(raw)}“.</div>`;
    el.innerHTML = out;
    mountLists(el);
    hydrateCovers(el);
  }, 380);
}
let onlineSearchTimer = null;
let searchToken = 0;

const ACCENTS = [
  { name: 'Gold', a: '#e9b44c' },
  { name: 'Koralle', a: '#ff6b4a' },
  { name: 'Rot', a: '#ff4d5e' },
  { name: 'Pink', a: '#f472b6' },
  { name: 'Violett', a: '#8b7bff' },
  { name: 'Blau', a: '#4f9dff' },
  { name: 'Türkis', a: '#2dd4bf' },
  { name: 'Grün', a: '#4ade80' },
  { name: 'Limette', a: '#c6f04a' },
  { name: 'Weiß', a: '#ecebe6' },
];
// Hintergründe: alle dunkel, damit Cover leuchten; Kontraste bleiben gleich
const THEMES = [
  { id: 'kino', name: 'Kino', c: ['#08080a', '#0c0c0f', '#131317', '#1b1b21', '#26262e', '#1f1f26', '#2f2f38'] },
  { id: 'oled', name: 'OLED Schwarz', c: ['#000000', '#030303', '#0d0d0f', '#161618', '#212124', '#1a1a1d', '#2a2a2e'] },
  { id: 'nacht', name: 'Mitternacht', c: ['#060a14', '#0a0f1c', '#101726', '#172034', '#212c45', '#1a2338', '#2a3654'] },
  { id: 'graphit', name: 'Graphit', c: ['#121215', '#16161a', '#1d1d22', '#26262c', '#313139', '#2a2a31', '#3b3b45'] },
  { id: 'aubergine', name: 'Aubergine', c: ['#0d0812', '#120b18', '#1a1122', '#23182e', '#2f223d', '#271b33', '#3a2b4a'] },
  { id: 'wald', name: 'Wald', c: ['#060c0a', '#09110e', '#101a16', '#17241e', '#21322a', '#1a2720', '#29392f'] },
  { id: 'espresso', name: 'Espresso', c: ['#0d0a08', '#120e0b', '#1a1511', '#241d18', '#302720', '#2a221c', '#3b3129'] },
];
const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const rgbHex = (r, g, b) => '#' + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
const lum = (h) => { const c = hexRgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mixHex = (a, b, k) => { const p = hexRgb(a), q = hexRgb(b); return rgbHex(...p.map((v, i) => v + (q[i] - v) * k)); };
// Akzent lesbar halten: auf dunklem Grund mindestens 4,5:1, sonst aufhellen
function safeAccent(hex, bg) {
  let a = /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : '#e9b44c';
  for (let i = 0; i < 20 && contrast(a, bg) < 4.5; i++) a = mixHex(a, '#ffffff', 0.12);
  return a;
}
const curTheme = () => THEMES.find((t) => t.id === ls.get('klang-theme', 'kino')) || THEMES[0];
function applyTheme() {
  const t = curTheme();
  const r = document.documentElement.style;
  ['--bg', '--bg2', '--surface', '--surface2', '--surface3', '--line', '--line2'].forEach((k, i) => r.setProperty(k, t.c[i]));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.c[0]);
  applyAccent(ls.get('klang-accent', 'Gold'));
}
function applyAccent(name) {
  const preset = ACCENTS.find((x) => x.name === name);
  const raw = preset ? preset.a : /^#[0-9a-f]{6}$/i.test(name || '') ? name : '#e9b44c';
  const bg = curTheme().c[0];
  const a = safeAccent(raw, bg);
  const r = document.documentElement.style;
  r.setProperty('--accent', a);
  r.setProperty('--accent-2', mixHex(a, '#000000', 0.18));
  r.setProperty('--on-accent', contrast(a, '#111111') >= contrast(a, '#ffffff') ? '#111111' : '#ffffff');
  return a !== raw.toLowerCase();
}
function setMotion(mode) {
  ls.set('klang-motion', mode);
  document.documentElement.classList.toggle('calm', mode === 'calm');
}

const setRow = (label, sub, control) => `<div class="set-row"><div class="lbl">${label}${sub ? `<small>${sub}</small>` : ''}</div>${control}</div>`;
const toggleBtn = (action, on, extra = '') => `<button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" data-action="${action}" ${extra}><span>${on ? 'An' : 'Aus'}</span></button>`;
const segBtns = (action, cur, opts) => `<div class="chips seg" role="group">${opts.map(([v, l]) => `<button class="chip ${String(v) === String(cur) ? 'on' : ''}" data-action="${action}" data-v="${v}" aria-pressed="${String(v) === String(cur)}">${l}</button>`).join('')}</div>`;
const onPC = () => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

views.settings = () => {
  const tracks = [...S.tracks.values()];
  const size = tracks.filter((t) => !t.remote).reduce((s, t) => s + (t.size || 0), 0);
  const accent = ls.get('klang-accent', 'Gold');
  const custom = !ACCENTS.some((a) => a.name === accent);
  const folder = finePointer() && 'webkitdirectory' in document.createElement('input');
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const lc = lyr.counts(tracks.filter((t) => !t.live));
  const motion = ls.get('klang-motion', 'full');
  const nav = [['play', 'Wiedergabe'], ['audio', 'Audio & Geräte'], ['offline', 'Downloads'], ['look', 'Aussehen'], ['lib', 'Bibliothek'], ['discord', 'Discord'], ['data', 'Konto & Daten']];
  const ct = getT(curId);
  const kbps = ct && ct.size && ct.duration ? Math.round((ct.size * 8) / ct.duration / 1000 / 8) * 8 : 0;
  const ext = ct?.streamUrl ? (ct.streamUrl.match(/\.([a-z0-9]+)$/i)?.[1] || '').toUpperCase() : '';
  const dlSize = [...dlIds].reduce((sum, id) => sum + (getT(id)?.size || 0), 0);
  const favOpen = tracks.filter((t) => t.fav && canDownload(t) && !isDl(t.id)).length;
  const outName = canAirPlay() ? 'AirPlay, AirPods und Bluetooth über das Apple-Menü' : canSink() ? 'Lautsprecher, Kopfhörer und Bluetooth-Geräte des PCs' : 'In den Bluetooth-Einstellungen des Geräts';
  return pageHead('Einstellungen') + `<nav class="set-nav chips" aria-label="Bereiche">${nav.map(([k, l]) => `<a class="chip" href="#set-${k}" data-action="set-jump" data-k="${k}">${l}</a>`).join('')}</nav>
  <div class="settings">
    <div class="set-card" id="set-play">
      <h2>Wiedergabe</h2>
      ${setRow('Überblenden', decksOK() ? 'Songs gehen sanft ineinander über' : 'Auf iPhone/iPad nicht möglich (Apple erlaubt keine zwei Abspieler gleichzeitig)', decksOK() ? `<div class="xf"><input type="range" class="range" min="0" max="12" step="1" value="${PB.xfade}" data-xfade aria-label="Überblenden in Sekunden" style="--p:${PB.xfade / 12 * 100}%"><output data-xfade-out>${PB.xfade ? PB.xfade + ' s' : 'Aus'}</output></div>` : '<span class="muted">–</span>')}
      ${setRow('Lückenlos', 'Lädt den nächsten Song vorab, damit keine Pause entsteht', toggleBtn('pb-gapless', PB.gapless && decksOK(), decksOK() ? '' : 'disabled'))}
      ${setRow('Smart Shuffle', 'Wie weit sich die Empfehlungen vom aktuellen Song entfernen', segBtns('pb-mix', PB.smartMix, [['close', 'Nah dran'], ['balanced', 'Ausgewogen'], ['wide', 'Abwechslung']]))}
      ${setRow('Equalizer', '10 Bänder, Voreinstellungen, Begrenzer', `<button class="btn btn-sm" data-action="eq">${icon('equalizer')}Öffnen</button>`)}
      ${finePointer() ? `<details class="kbd"><summary>Tastenkürzel</summary><div class="kbd-list">
        <kbd>Leertaste</kbd><span>Abspielen / Pause</span>
        <kbd>← →</kbd><span>5 Sekunden zurück / vor</span>
        <kbd>Shift + ← →</kbd><span>Vorheriger / nächster Titel</span>
        <kbd>↑ ↓</kbd><span>Lautstärke</span>
        <kbd>M</kbd><span>Stumm</span>
        <kbd>S</kbd><span>Zufall / Smart Shuffle</span>
        <kbd>R</kbd><span>Wiederholen</span>
        <kbd>L</kbd><span>Aktuellen Titel als Favorit</span>
        <kbd>Q</kbd><span>Warteschlange</span>
        <kbd>T</kbd><span>Songtext ein/aus</span>
        <kbd>E</kbd><span>Equalizer</span>
        <kbd>Strg + K</kbd><span>Suchen</span>
        <kbd>Medientasten</kbd><span>Tastatur, Kopfhörer und Sperrbildschirm</span>
      </div></details>` : ''}
    </div>

    <div class="set-card" id="set-audio">
      <h2>Audio &amp; Geräte</h2>
      ${setRow('Qualität', `Immer die Originaldatei, ohne Umwandlung oder Komprimierung. Das ist die beste Qualität, die deine Songs haben.${kbps ? `<br>Aktueller Song: ${ext || 'Audio'}, ca. ${kbps} kbit/s` : ''}`, `<span class="q-badge">${icon('check')}Original</span>`)}
      ${setRow('Ausgabegerät', outName, `<button class="btn btn-sm" data-action="output">${icon('airplay')}Wählen</button>`)}
      ${setRow('AirPods &amp; Bluetooth', 'Kopfhörer und Boxen zuerst am Handy bzw. PC koppeln. Play, Pause und Weiter am Kopfhörer steuern VERS.', '')}
      ${setRow('Alexa / Echo', 'Am Echo „Alexa, koppeln“ sagen, dann das Gerät in den Bluetooth-Einstellungen des Handys verbinden. VERS spielt dann darüber.', '')}
      ${setRow('Sperrbildschirm', 'Cover, Titel, Künstler, Zeit und Vor/Zurück erscheinen automatisch auf dem Sperrbildschirm, im Kontrollzentrum und auf der Uhr.', '')}
    </div>

    <div class="set-card" id="set-look">
      <h2>Aussehen</h2>
      <p>Akzentfarbe für Play, Fortschritt und Auswahl. Zu dunkle Farben hellt VERS automatisch auf, damit alles lesbar bleibt.</p>
      <div class="swatches">${ACCENTS.map((a) => `<button class="swatch ${a.name === accent ? 'on' : ''}" data-action="accent" data-name="${a.name}" title="${a.name}" aria-label="${a.name}" style="background:${a.a}"></button>`).join('')}
        <label class="swatch custom ${custom ? 'on' : ''}" title="Eigene Farbe" style="${custom ? `background:${esc(accent)}` : ''}"><input type="color" data-custom-accent value="${custom ? esc(accent) : '#e9b44c'}" aria-label="Eigene Farbe wählen">${icon('plus')}</label></div>
      <h3>Hintergrund</h3>
      <div class="themes">${THEMES.map((t) => `<button class="theme ${t.id === curTheme().id ? 'on' : ''}" data-action="theme" data-id="${t.id}" aria-pressed="${t.id === curTheme().id}"><span class="theme-prev" style="--b:${t.c[0]};--s:${t.c[3]};--l:${t.c[6]}"><i></i><i></i><i></i></span><span>${t.name}</span></button>`).join('')}</div>
      ${setRow('Live-Cover', 'Bewegtes Cover hinter dem Vollbild-Player', toggleBtn('toggle-live', liveCoverOn()))}
      ${setRow('Animationen', 'Ruhig: keine Bewegung beim Seitenwechsel, schont auch den Akku', segBtns('motion', motion, [['full', 'Voll'], ['calm', 'Ruhig']]))}
    </div>

    <div class="set-card" id="set-lib">
      <h2>Bibliothek</h2>
      <p>${plural(tracks.length, 'Titel', 'Titel')} · ${plural(getAlbums().size, 'Release', 'Releases')} · ${plural([...getArtists().values()].filter(isMainArtist).length, 'Künstler', 'Künstler')} · ${plural(S.playlists.length, 'Playlist', 'Playlists')}</p>
      <div class="btn-row">
        <button class="btn btn-accent" data-action="import-files">${icon('upload')}Dateien hinzufügen</button>
        ${folder ? `<button class="btn" data-action="import-folder">${icon('folder')}Ordner hinzufügen</button>` : ''}
        ${S.srvOK ? `<button class="btn" data-action="reload-server-lib">${icon('refresh')}Musik-Ordner neu laden</button>` : ''}
      </div>
    </div>
    ${S.srvOK && onPC() ? `<div class="set-card">
      <h2>Aufs Handy</h2>
      <p>Deine Songs am Handy: QR-Code scannen, fertig. Mit der Cloud geht das überall, auch ohne PC.</p>
      <button class="btn btn-accent" data-action="phone-connect">${icon('phone')}QR-Code zeigen</button>
    </div>` : ''}
    ${cloudCfg() && !S.srvOK ? `<div class="set-card">
      <h2>Cloud</h2>
      <p>Verbunden mit deinem privaten Cloud-Speicher: ${plural(tracks.filter((t) => t.remote === 'cloud').length, 'Song', 'Songs')}. Läuft überall mit Internet.</p>
      <div class="btn-row">
        <button class="btn btn-accent" data-action="cloud-reload">${icon('refresh')}Neu laden</button>
        <button class="btn btn-danger" data-action="cloud-off">Trennen</button>
      </div>
    </div>` : ''}

    <div class="set-card" id="set-offline">
      <h2>Downloads &amp; Offline</h2>
      ${setRow('Heruntergeladen', dlIds.size ? `${plural(dlIds.size, 'Song', 'Songs')} · ${fmtBytes(dlSize)} · inklusive Cover` : 'Noch nichts. Im ⋯-Menü eines Songs auf „Herunterladen“ tippen.', `<a class="btn btn-sm" href="#/downloads">${icon('download')}Ansehen</a>`)}
      ${setRow('Favoriten offline', 'Neue Favoriten werden automatisch heruntergeladen', toggleBtn('pb-autodl', !!PB.autoDlFavs))}
      ${favOpen ? setRow('Favoriten jetzt laden', `${plural(favOpen, 'Favorit fehlt', 'Favoriten fehlen')} noch`, `<button class="btn btn-sm btn-accent" data-action="dl-favs">${icon('download')}Laden</button>`) : ''}
      ${setRow('Songtexte', `${plural(lc.have, 'Songtext', 'Songtexte')} gespeichert${lc.open ? ` · ${lc.open} noch offen` : ''}${lc.miss ? ` · ${lc.miss} ohne Text` : ''}`, `<button class="btn btn-sm" data-action="lyrics-all" ${lc.open && navigator.onLine ? '' : 'disabled'}>${icon('download')}<span data-lyrics-progress>${lc.open ? 'Alle laden' : 'Vollständig'}</span></button>`)}
      ${setRow('Cover', 'Werden beim ersten Anzeigen gespeichert und gehen danach offline', `<button class="btn btn-sm" data-action="covers-all">${icon('download')}<span data-cover-progress>Alle laden</span></button>`)}
      ${dlIds.size ? setRow('Downloads löschen', 'Gibt Speicher frei, die Songs bleiben in der Bibliothek', `<button class="btn btn-sm btn-danger" data-action="dl-clear">Löschen</button>`) : ''}
      <div id="storage-info" class="muted" style="font-size:14px;margin-top:10px">Wird berechnet …</div>
      ${size ? `<p class="muted small">Davon importierte Musik: ${fmtBytes(size)}</p>` : ''}
    </div>

    <div class="set-card" id="set-discord">
      <h2>Discord</h2>
      <p>Zeigt auf Discord „Hört VERS“ mit Song, Künstler, Cover und Restzeit.</p>
      ${setRow('Status teilen', 'Was du hörst, an deinen Discord-Status senden', toggleBtn('pb-share', PB.shareStatus))}
      ${onPC() && S.srvOK ? `<div id="discord-box" class="discord-box">${loadingHTML('Prüfe Discord …')}</div>` : `<p class="muted small">${isMobile() || ios ? 'Am Handy kann keine App direkt mit Discord reden. VERS schickt den Song deshalb über deine Cloud an den PC, und der PC setzt den Status. Dafür muss VERS am PC laufen und Discord am PC offen sein.' : 'Der Discord-Status wird am PC eingerichtet: VERS über „VERS starten.bat“ öffnen, dann hier Discord einschalten.'}</p>`}
    </div>

    <div class="set-card">
      <h2>App installieren</h2>
      ${standalone ? '<p>VERS läuft bereits als installierte App.</p>'
        : ios ? '<p>Tippe in Safari unten auf <b>Teilen</b> und dann auf <b>„Zum Home-Bildschirm“</b>. Danach startet VERS wie eine normale App, im Vollbild und offline.</p>'
          : `<p>Installiere VERS als eigene App mit Icon auf dem Startbildschirm bzw. im Startmenü. Danach funktioniert sie auch offline.</p>
             <button class="btn ${deferredInstall ? 'btn-accent' : 'hidden'}" data-action="install" data-install>${icon('download')}Jetzt installieren</button>
             ${deferredInstall ? '' : '<p class="muted" style="font-size:13px;margin:0">Falls kein Knopf erscheint: im Browser-Menü (⋮) auf <b>„App installieren“</b> bzw. <b>„Zum Startbildschirm hinzufügen“</b> tippen.</p>'}`}
    </div>

    <div class="set-card" id="set-data">
      <h2>Konto &amp; Daten</h2>
      ${setRow('Profil', 'Bild, Name, Status, Profilfarbe, Passwort', `<a class="btn btn-sm" href="#/profil">${icon('user')}Profil öffnen</a>`)}
      ${setRow('Hörstatistik', `Seit ${new Date(stats.summary('all').since).toLocaleDateString('de')} · ${fmtMin(stats.summary('all').total)}`, `<div class="btn-row"><button class="btn btn-sm" data-action="stats-export">${icon('download')}Sichern</button><button class="btn btn-sm btn-danger" data-action="stats-reset">Zurücksetzen</button></div>`)}
      ${setRow('Gespeicherte Songtexte', 'Werden bei Bedarf neu geladen', `<button class="btn btn-sm" data-action="lyrics-clear">Löschen</button>`)}
      ${setRow('Bibliothek löschen', 'Entfernt Titel, Cover und Playlists von diesem Gerät. Deine Originaldateien bleiben.', `<button class="btn btn-sm btn-danger" data-action="wipe" ${tracks.length || S.playlists.length ? '' : 'disabled'}>${icon('trash')}Löschen</button>`)}
    </div>
    <p class="muted" style="font-size:12.5px;text-align:center">VERS 2.0 · Deine Musik bleibt bei dir.</p>
  </div>`;
};
async function renderDiscordBox() {
  const box = $('#discord-box');
  if (!box) return;
  let info = null;
  try { const r = await fetch('/api/discord', { cache: 'no-store' }); if (r.ok) info = await r.json(); } catch { /* */ }
  if (!box.isConnected) return;
  if (!info) { box.innerHTML = '<p class="muted small">Der VERS-Server am PC ist zu alt. Bitte VERS einmal neu starten.</p>'; return; }
  const ok = info.status === 'verbunden';
  box.innerHTML = `${setRow('Am PC verbinden', info.enabled ? `Status: <b class="${ok ? 'ok' : ''}">${esc(info.status)}</b>` : 'Braucht die Discord-App auf diesem PC', toggleBtn('discord-toggle', info.enabled))}
    <label class="field"><span>Application-ID (einmalig, siehe Anleitung)</span><input data-discord-id inputmode="numeric" placeholder="z. B. 1234567890123456789" value="${esc(info.clientId)}" autocomplete="off"></label>
    <details class="small"><summary>So bekommst du die Application-ID (2 Minuten)</summary><ol class="steps">
      <li><a class="link" href="https://discord.com/developers/applications" target="_blank" rel="noopener">discord.com/developers/applications</a> öffnen und mit deinem Discord-Konto anmelden.</li>
      <li><b>New Application</b> → Name <b>VERS</b> → erstellen. Dieser Name steht später in „Hört VERS“.</li>
      <li>Optional unter <b>App Icon</b> das VERS-Logo hochladen (liegt im Ordner <code>icons</code>).</li>
      <li>Die <b>Application ID</b> kopieren und oben einfügen, dann „Am PC verbinden“ einschalten.</li>
    </ol></details>`;
}

after.settings = async () => {
  renderDiscordBox();
  const xf = $('[data-xfade]');
  xf?.addEventListener('input', () => {
    PB.xfade = +xf.value;
    savePB();
    xf.style.setProperty('--p', PB.xfade / 12 * 100 + '%');
    $('[data-xfade-out]').textContent = PB.xfade ? PB.xfade + ' s' : 'Aus';
  });
  const ca = $('[data-custom-accent]');
  ca?.addEventListener('input', () => { ls.set('klang-accent', ca.value); applyAccent(ca.value); ca.parentElement.style.background = ca.value; });
  ca?.addEventListener('change', () => {
    if (applyAccent(ca.value)) toast('Etwas aufgehellt, damit Text und Knöpfe lesbar bleiben.', 2600);
    $$('.swatch').forEach((s) => s.classList.toggle('on', s === ca.parentElement));
  });
  const el = $('#storage-info');
  if (!el) return;
  let html = '';
  try {
    if (navigator.storage?.estimate) {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      const pct = quota ? Math.min(100, (usage / quota) * 100) : 0;
      html += `<div class="meter"><div style="width:${Math.max(1, pct)}%"></div></div>${fmtBytes(usage)} belegt von ca. ${fmtBytes(quota)} verfügbar`;
    }
    if (navigator.storage?.persisted) {
      const p = await navigator.storage.persisted();
      html += `<div class="set-row" style="margin-top:12px;border-top:1px solid var(--line)"><div class="lbl">Dauerhafter Speicher<small>${p ? 'Aktiv – der Browser löscht deine Musik nicht automatisch.' : 'Nicht aktiv – bei Speichermangel könnte der Browser Daten löschen.'}</small></div>${p ? `<span style="color:var(--accent)">${icon('check')}</span>` : '<button class="btn btn-sm" data-action="persist">Aktivieren</button>'}</div>`;
    }
  } catch { /* */ }
  el.innerHTML = html || 'Keine Informationen verfügbar.';
};

/* =========================================================
   Kino-Bewegung: GSAP, Lenis, View Transitions
   ========================================================= */
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches || ls.get('klang-motion', 'full') === 'calm';
function setSwitch(el, on) { el.classList.toggle('on', on); el.setAttribute('aria-checked', String(on)); const sp = el.querySelector('span'); if (sp) sp.textContent = on ? 'An' : 'Aus'; }
function segSelect(el) { el.parentElement.querySelectorAll('.chip').forEach((c) => { const on = c === el; c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on)); }); }
const motionOK = () => !reducedMotion() && !!window.gsap;
let lenis = null;
function setupMotion() {
  if (!window.gsap) return;
  if (window.ScrollTrigger) gsap.registerPlugin(ScrollTrigger);
  if (window.SplitText) gsap.registerPlugin(SplitText);
  // Weiches Scrollen nur mit Maus und ohne „Bewegung reduzieren“
  if (window.Lenis && finePointer() && !reducedMotion()) {
    lenis = new Lenis({ wrapper: $('#main'), content: $('#view'), lerp: 0.11, smoothWheel: true, wheelMultiplier: 0.95 });
    if (window.ScrollTrigger) lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
  }
}
function scrollMainTo(y) {
  if (lenis) lenis.scrollTo(y, { immediate: true, force: true });
  else $('#main').scrollTop = y;
}
// Seitenwechsel als kurzer Kino-Schnitt (View Transitions), sonst sofort
function withTransition(kind, fn) {
  if (!document.startViewTransition || reducedMotion() || document.hidden) { fn(); return null; }
  document.documentElement.dataset.vt = kind;
  const vt = document.startViewTransition(fn);
  vt.finished.finally(() => { delete document.documentElement.dataset.vt; });
  return vt;
}

// ---- Ambient-Licht: der Bildschirm übernimmt die Farbe des gezeigten Covers ----
let ambTimer = 0;
function setAmbient(coverId) {
  clearTimeout(ambTimer);
  ambTimer = setTimeout(async () => {
    const c = coverId ? await tintOf(coverId) : null;
    document.documentElement.style.setProperty('--amb', c || 'rgba(0,0,0,0)');
  }, 90);
}

// ---- Hero „Feature“: die Top-Songs im Kino-Format, wechselt alle 9 Sekunden ----
const feat = { ids: [], k: null, i: 0, timer: 0, paused: false, hover: false, seq: 0 };
const featureSkeleton = () => `<div class="ft-slide ft-skel"><div class="ft-body"><div class="ft-copy"><span class="sk sk-t"></span><span class="sk sk-t2"></span><span class="sk sk-m"></span></div><div class="ft-art"><div class="cover"></div></div></div></div>`;
function featureOffline(msg) {
  const stage = $('#feature .ft-stage');
  if (stage) stage.innerHTML = `<div class="ft-slide"><div class="ft-body"><div class="ft-copy"><h1 class="ft-title">VERS</h1><p class="ft-meta">${esc(msg || (navigator.onLine ? 'Der Online-Katalog ist gerade nicht erreichbar.' : 'Offline: deine eigene Musik läuft trotzdem.'))}</p></div></div></div>`;
}
const heroCover = (t) => t.coverHi || t.coverId;
async function mountFeature(ids, source) {
  const el = $('#feature');
  if (!el || !ids.length) return;
  clearInterval(feat.timer);
  const seq = renderSeq;
  // Nur Songs mit ladbarem Cover kommen in den Hero (Platzierung bleibt die echte)
  const pool = ids.slice(0, 12);
  const ok = await Promise.all(pool.map((id) => { const t = getT(id); return heroCover(t) ? coverUrl(heroCover(t)) : null; }));
  if (seq !== renderSeq || !$('#feature')) return;
  const picked = pool.map((id, i) => ({ id, rank: i })).filter((x, i) => ok[i]).slice(0, 5);
  if (!picked.length) picked.push(...pool.slice(0, 5).map((id, i) => ({ id, rank: i })));
  feat.ids = picked.map((x) => x.id);
  feat.ranks = picked.map((x) => x.rank);
  feat.k = regList(ids, { source });
  feat.i = 0;
  feat.seq = renderSeq;
  const nav = `<div class="ft-nav">${feat.ids.map((id, i) => `<button class="ft-dot" data-action="feat-go" data-i="${i}" aria-label="Song ${i + 1} zeigen"><i></i></button>`).join('')}
    <button class="icon-btn sm ft-pause" data-action="feat-pause" aria-label="Wechsel anhalten">${icon('pause')}</button></div>`;
  el.insertAdjacentHTML('beforeend', nav);
  el.addEventListener('mouseenter', () => { feat.hover = true; });
  el.addEventListener('mouseleave', () => { feat.hover = false; });
  document.fonts.ready.then(() => { if (feat.seq === renderSeq) showFeature(0); });
  if (!reducedMotion()) feat.timer = setInterval(() => {
    if (feat.seq !== renderSeq || !$('#feature')) { clearInterval(feat.timer); return; }
    if (feat.paused || feat.hover || document.hidden || overlays.length) return;
    if ($('#main').scrollTop > $('#feature').offsetHeight * 0.8) return;
    showFeature((feat.i + 1) % feat.ids.length);
  }, 9000);
  if (motionOK() && window.ScrollTrigger) {
    gsap.to('#feature .ft-stage', { yPercent: 14, ease: 'none', scrollTrigger: { trigger: '#feature', scroller: '#main', start: 'top top', end: 'bottom top', scrub: true } });
    gsap.to('#feature .ft-nav', { opacity: 0, ease: 'none', scrollTrigger: { trigger: '#feature', scroller: '#main', start: 'top top', end: '40% top', scrub: true } });
  }
}
function featureHTML(t, i) {
  const art = t.artistId ? `<a class="link" href="#/oartist/${encodeURIComponent(t.artistId)}">${esc(t.artist)}</a>` : esc(t.artist);
  const genre = t.genre ? ` · ${esc(t.genre.split(',')[0])}` : '';
  const rank = feat.ranks?.[i] ?? i;
  return `<div class="ft-slide" data-i="${i}">
    <div class="ft-bg"></div>
    <div class="ft-body">
      <div class="ft-copy">
        <h1 class="ft-title ${t.title.length > 26 ? 'long' : ''}">${esc(t.title)}</h1>
        <p class="ft-meta"><span class="ft-rank">Platz ${rank + 1}</span>${art}${genre} · ${fmt(t.duration)}</p>
        <div class="ft-actions">
          <button class="btn-cta" data-action="play-at" data-list="${feat.k}" data-i="${rank}">${icon('play')}<span>Jetzt abspielen</span></button>
          <button class="btn btn-ghost ft-fav ${t.fav ? 'on' : ''}" data-action="fav" data-id="${t.id}" aria-label="Favorit">${icon(t.fav ? 'heart-fill' : 'heart')}<span>Favorit</span></button>
        </div>
      </div>
      <div class="ft-art">${coverHTML(heroCover(t), t.title)}</div>
    </div>
  </div>`;
}
async function showFeature(i) {
  const stage = $('#feature .ft-stage');
  const t = getT(feat.ids[i]);
  if (!stage || !t) return;
  feat.i = i;
  const old = [...stage.children];
  stage.insertAdjacentHTML('beforeend', featureHTML(t, i));
  const slide = stage.lastElementChild;
  hydrateCovers(slide);
  loadCover(slide.querySelector('.ft-art .cover'));
  const bg = slide.querySelector('.ft-bg');
  if (t.coverId) coverUrl(t.coverId).then((u) => { if (u) bg.style.backgroundImage = `url("${u.replace(/"/g, '%22')}")`; });
  regAlts(heroCover(t), t.coverHiAlts);
  $$('#feature .ft-dot').forEach((d, j) => d.classList.toggle('on', j === i));
  setAmbient(t.coverId);
  if (!motionOK()) { old.forEach((o) => o.remove()); return; }
  const tl = gsap.timeline();
  tl.fromTo(slide, { opacity: 0 }, { opacity: 1, duration: 0.9, ease: 'power2.out' }, 0);
  if (old.length) tl.to(old, { opacity: 0, duration: 0.7, ease: 'power2.out', onComplete: () => old.forEach((o) => o.remove()) }, 0);
  const title = slide.querySelector('.ft-title');
  if (window.SplitText) {
    const split = SplitText.create(title, { type: 'lines,words,chars', mask: 'lines', linesClass: 'ft-line' });
    tl.from(split.chars, { yPercent: 118, duration: 1.05, ease: 'expo.out', stagger: { each: 0.022, from: 'start' } }, 0.08);
  }
  tl.from(slide.querySelectorAll('.ft-meta, .ft-actions'), { y: 22, opacity: 0, duration: 0.8, ease: 'expo.out', stagger: 0.09 }, 0.32);
  tl.from(slide.querySelector('.ft-art'), { scale: 0.86, rotate: -2.5, opacity: 0, duration: 1.3, ease: 'expo.out' }, 0.04);
  gsap.fromTo(bg, { scale: 1.22 }, { scale: 1.04, duration: 11, ease: 'none' });
  // Fortschrittsbalken im aktiven Punkt
  $$('#feature .ft-dot i').forEach((b) => { gsap.killTweensOf(b); b.style.setProperty('--p', 1); });
  const bar = $('#feature .ft-dot.on i');
  if (bar && !feat.paused) gsap.fromTo(bar, { '--p': 0 }, { '--p': 1, duration: 9, ease: 'none' });
}

// ---- Kacheln: beim Draufzeigen fließt das Ambient-Licht in der Coverfarbe ----
function setupWallHover() {
  if (!finePointer()) return;
  $('#view').addEventListener('pointerover', (e) => {
    const card = e.target.closest('.shelf .card[data-tint-src]');
    if (card && card.dataset.tintSrc) setAmbient(card.dataset.tintSrc);
  });
}

/* =========================================================
   Konto: Login, Registrierung, Profil (alles nur auf diesem Gerät)
   ========================================================= */
const premiumBadge = (cls = '') => `<span class="premium ${cls}">${icon('crown')}<span>Premium</span></span>`;
function avatarHTML(a, size = '') {
  if (a?.avatar) return `<span class="avatar ${size}" style="background-image:url('${a.avatar}')" role="img" aria-label="Profilbild von ${esc(a.display)}"></span>`;
  const initials = esc((a?.display || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase());
  return `<span class="avatar ${size}" style="--h:${hue(a?.display || '')}" aria-hidden="true">${initials}</span>`;
}
function updateProfileUI() {
  const a = auth.current();
  const chip = $('#side-profile');
  if (chip) {
    chip.classList.toggle('hidden', !a);
    chip.innerHTML = a ? `${avatarHTML(a, 'sm')}<span class="sp-text"><b>${esc(a.display)}</b>${premiumBadge('sm')}</span>` : '';
  }
  if (a?.genre && a.genre !== 'all' && GENRES.some((g) => g[0] === a.genre)) S.discGenre = S.discGenre === 'all' ? a.genre : S.discGenre;
}

let authMode = 'login';
function showAuth(mode = 'login') {
  authMode = mode;
  const el = $('#auth');
  const reg = mode === 'register';
  el.hidden = false;
  document.body.classList.add('auth-open');
  el.innerHTML = `
    <div class="auth-wall" aria-hidden="true"></div>
    <div class="auth-shade" aria-hidden="true"></div>
    <form class="auth-card" novalidate data-form="auth">
      <div class="auth-brand"><img src="icons/icon.svg" alt=""><span><b>VERS</b><small>MUSIK</small></span></div>
      <h1>${reg ? 'Konto erstellen' : 'Willkommen zurück'}</h1>
      <p class="auth-sub">${reg ? 'Name und Passwort werden nur auf diesem Gerät gespeichert.' : 'Melde dich an. Dein Konto liegt nur auf diesem Gerät.'}</p>
      <label class="field"><span>Name</span><input name="name" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="24" required><em class="field-err" data-err="name"></em></label>
      <label class="field"><span>Passwort</span>
        <span class="pw-wrap"><input name="pw" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required><button type="button" class="icon-btn sm pw-eye" data-auth="eye" aria-label="Passwort anzeigen">${icon('eye')}</button></span>
        <em class="field-err" data-err="pw"></em></label>
      ${reg ? `<label class="field"><span>Passwort wiederholen</span><input name="pw2" type="password" autocomplete="new-password" required><em class="field-err" data-err="pw2"></em></label>` : ''}
      <button class="btn-cta auth-go" type="submit">${icon(reg ? 'crown' : 'play')}<span>${reg ? 'Konto erstellen' : 'Einloggen'}</span></button>
      <button type="button" class="auth-switch" data-auth="switch">${reg ? 'Schon ein Konto? <b>Einloggen</b>' : 'Neu hier? <b>Konto erstellen</b>'}</button>
    </form>`;
  setTimeout(() => el.querySelector('input[name="name"]')?.focus(), 80);
  // Hintergrund: eine langsam treibende Wand aus angesagten Covern
  cached('trend:all:week', () => audius.trending(null, 'week', 50)).then((list) => {
    const wall = el.querySelector('.auth-wall');
    if (!wall) return;
    const covers = list.map((t) => t.coverId).filter(Boolean).slice(0, 30);
    list.forEach((t) => regAlts(t.coverId, t.coverAlts));
    if (covers.length < 6) return;
    const cols = 6;
    wall.innerHTML = Array.from({ length: cols }, (_, c) => `<div class="aw-col">${[...covers.slice(c * 5, c * 5 + 5), ...covers.slice(c * 5, c * 5 + 5)].map((id) => coverHTML(id, id)).join('')}</div>`).join('');
    hydrateCovers(wall);
  }).catch(() => {});
  if (motionOK()) gsap.from(el.querySelector('.auth-card'), { y: 30, opacity: 0, duration: 0.9, ease: 'expo.out', delay: 0.1 });
}
function hideAuth() {
  const el = $('#auth');
  const done = () => { el.hidden = true; el.innerHTML = ''; document.body.classList.remove('auth-open'); };
  if (!motionOK()) { done(); return; }
  gsap.timeline({ onComplete: done })
    .to(el.querySelector('.auth-card'), { y: -24, opacity: 0, duration: 0.45, ease: 'power2.in' })
    .to(el, { clipPath: 'inset(0 0 100% 0)', duration: 0.7, ease: 'expo.inOut' }, 0.2);
}
function setFieldErr(form, field, msg) {
  form.querySelectorAll('.field-err').forEach((e) => { e.textContent = ''; });
  form.querySelectorAll('input').forEach((i) => i.removeAttribute('aria-invalid'));
  if (!field) return;
  const e = form.querySelector(`[data-err="${field}"]`);
  if (e) e.textContent = msg;
  const inp = form.querySelector(`[name="${field}"]`);
  if (inp) { inp.setAttribute('aria-invalid', 'true'); inp.focus(); }
  if (motionOK()) gsap.fromTo(form, { x: -8 }, { x: 0, duration: 0.5, ease: 'elastic.out(1, .35)' });
}
async function submitAuth(form) {
  const btn = form.querySelector('.auth-go');
  btn.disabled = true;
  const d = Object.fromEntries(new FormData(form));
  const r = authMode === 'register' ? await auth.register(d.name, d.pw || '', d.pw2 || '') : await auth.login(d.name, d.pw || '');
  btn.disabled = false;
  if (!r.ok) { setFieldErr(form, r.error, r.msg); return; }
  updateProfileUI();
  hideAuth();
  toast(authMode === 'register' ? `Konto erstellt. Willkommen, ${r.account.display}!` : `Willkommen zurück, ${r.account.display}`);
  render(true);
}

const PROFILE_COLORS = ['#e9b44c', '#ff6b4a', '#ff4d5e', '#f472b6', '#8b7bff', '#4f9dff', '#2dd4bf', '#4ade80'];
views.profil = () => {
  const a = auth.current();
  if (!a) return notFound();
  const all = [...S.tracks.values()];
  const since = new Date(a.createdAt).toLocaleDateString('de', { month: 'long', year: 'numeric' });
  const genreOpts = GENRES.map(([k, l]) => `<option value="${k}" ${a.genre === k ? 'selected' : ''}>${k === 'all' ? 'Keins' : l}</option>`).join('');
  const color = a.color || 'var(--accent)';
  const month = stats.summary('month');
  const total = stats.summary('all');
  const top = month.artists.slice(0, 6).map((x) => getArtists().get(x.key) || { name: x.name, coverId: artistPicId(x.name) });
  const facts = [
    [minutes(total.total).toLocaleString('de'), 'Minuten gehört'],
    [all.filter((t) => t.fav).length.toLocaleString('de'), 'Favoriten'],
    [S.playlists.length.toLocaleString('de'), 'Playlists'],
    [dlIds.size.toLocaleString('de'), 'Downloads'],
  ];
  return `<div class="profile-card" style="--pc:${esc(color)}">
      <div class="pc-banner"></div>
      <div class="pc-body">
        <div class="avatar-wrap">${avatarHTML(a, 'xl')}<button class="avatar-edit" data-action="avatar-pick" aria-label="Profilbild ändern">${icon('image')}</button></div>
        <div class="pc-name">${premiumBadge('lg')}<h1>${esc(a.display)}</h1><p class="muted">@${esc(a.name)} · dabei seit ${since}</p>${a.bio ? `<p class="profile-bio">${esc(a.bio)}</p>` : ''}</div>
        <a class="icon-btn lg pc-set" href="#/settings" aria-label="Einstellungen" title="Einstellungen">${icon('settings')}</a>
      </div>
      <dl class="facts pc-facts">${facts.map(([v, l]) => `<div><dt>${v}</dt><dd>${l}</dd></div>`).join('')}</dl>
    </div>
    ${top.length ? section('Deine Top-Künstler diesen Monat', '#/stats', `<div class="peer-row">${top.map((p) => `<a class="peer" href="#/artist/${encodeURIComponent(p.name)}">${artistArt(p.name, p.coverId, 'peer-art')}<b>${esc(p.name)}</b></a>`).join('')}</div>`) : ''}
    <div class="settings profile-edit">
      <details class="set-card" ${a.display === a.name && !a.bio ? 'open' : ''}>
        <summary><h2>Profil bearbeiten</h2>${icon('chevron-down')}</summary>
        <form data-form="profile" novalidate>
          <label class="field"><span>Anzeigename</span><input name="display" value="${esc(a.display)}" maxlength="32" autocomplete="nickname"></label>
          <label class="field"><span>Status</span><input name="bio" value="${esc(a.bio || '')}" maxlength="90" placeholder="Was hörst du gerade am liebsten?"></label>
          <label class="field"><span>Lieblingsgenre (startet Entdecken damit)</span><select class="select wide-select" name="genre">${genreOpts}</select></label>
          <div class="field"><span>Profilfarbe</span><div class="swatches">${PROFILE_COLORS.map((c) => `<label class="swatch ${a.color === c ? 'on' : ''}" style="background:${c}"><input type="radio" name="color" value="${c}" ${a.color === c ? 'checked' : ''} aria-label="Farbe ${c}"></label>`).join('')}</div></div>
          <div class="btn-row"><button class="btn btn-accent" type="submit">${icon('check')}Speichern</button>
            <button class="btn" type="button" data-action="avatar-pick">${icon('image')}Profilbild ändern</button>
            ${a.avatar ? `<button class="btn" type="button" data-action="avatar-remove">${icon('x')}Bild entfernen</button>` : ''}</div>
        </form>
      </details>
      <details class="set-card">
        <summary><h2>Konto</h2>${icon('chevron-down')}</summary>
        <p>Passwort ändern. Für das Startkonto bitte ein eigenes Passwort setzen.</p>
        <form data-form="password" novalidate>
          <label class="field"><span>Aktuelles Passwort</span><input name="old" type="password" autocomplete="current-password"><em class="field-err" data-err="old"></em></label>
          <div class="field-grid">
            <label class="field"><span>Neues Passwort</span><input name="new" type="password" autocomplete="new-password"><em class="field-err" data-err="new"></em></label>
            <label class="field"><span>Wiederholen</span><input name="new2" type="password" autocomplete="new-password"><em class="field-err" data-err="new2"></em></label>
          </div>
          <button class="btn btn-accent" type="submit">${icon('check')}Passwort speichern</button>
        </form>
        <div class="set-row" style="margin-top:16px"><div class="lbl">Abmelden<small>Musik, Playlists und Favoriten bleiben auf dem Gerät.</small></div><button class="btn btn-sm btn-danger" data-action="logout">${icon('logout')}Abmelden</button></div>
      </details>
      <a class="set-card set-link" href="#/settings">${icon('settings')}<span><b>Einstellungen</b><small>Wiedergabe, Audio &amp; Geräte, Downloads, Aussehen, Discord</small></span>${icon('chevron-right')}</a>
    </div>`;
};

async function pickAvatar() {
  const file = await pickFile('#image-input');
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    c.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 256, 256);
    const url = c.toDataURL('image/jpeg', 0.86);
    if (!auth.update({ avatar: url })) { toast('Bild konnte nicht gespeichert werden.'); return; }
    updateProfileUI();
    refresh();
    toast('Profilbild gespeichert');
  } catch { toast('Dieses Bild konnte nicht gelesen werden.'); }
}

/* =========================================================
   Router
   ========================================================= */
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const i = h.indexOf('/');
  const name = (i < 0 ? h : h.slice(0, i)) || 'home';
  let arg = null;
  if (i >= 0) { try { arg = decodeURIComponent(h.slice(i + 1)); } catch { arg = h.slice(i + 1); } }
  return { name, arg };
}
function go(name, arg) {
  closeAllOverlays();
  closeMenu();
  location.hash = arg != null ? `#/${name}/${encodeURIComponent(arg)}` : `#/${name}`;
}

function render(keepScroll = false) {
  const r = parseRoute();
  const fn = views[r.name] || views.home;
  const main = $('#main');
  const top = main.scrollTop;
  lists = {};
  renderSeq++;
  clearInterval(feat.timer);
  if (window.ScrollTrigger) ScrollTrigger.getAll().forEach((st) => st.kill());
  const view = $('#view');
  view.innerHTML = fn(r.arg);
  document.body.dataset.route = r.name;
  if (!['home', 'discover'].includes(r.name)) setAmbient(null);
  // Lange Wörter in großen Überschriften nicht zerhacken: Schrift passt sich der Wortlänge an
  $$('.hero h1, .page-head h1', view).forEach((h) => h.style.setProperty('--len', Math.max(4, ...h.textContent.trim().split(/\s+/).map((w) => w.length))));
  mountLists(view);
  hydrateCovers(view);
  applyTints(view);
  after[r.name]?.(r.arg);
  updateNav(r.name);
  scrollMainTo(keepScroll ? top : 0);
  if (window.ScrollTrigger) requestAnimationFrame(() => ScrollTrigger.refresh());
}
function refresh() {
  if (parseRoute().name === 'search') renderSearch();
  else render(true);
}
function updateNav(name) {
  const map = { album: 'albums', artist: 'artists', playlist: 'playlists', oartist: 'discover' };
  const key = map[name] || name;
  const lib = ['songs', 'albums', 'artists', 'album', 'artist', 'playlists', 'playlist', 'downloads'].includes(name);
  $$('[data-nav]').forEach((a) => {
    const n = a.dataset.nav;
    a.classList.toggle('active', n === key || (n === 'library' && lib) || (n === 'discover-m' && ['discover', 'radio', 'oartist'].includes(name)));
  });
  const libLink = $('#bottomnav [data-nav="library"]');
  if (libLink) libLink.href = `#/${['songs', 'albums', 'artists', 'playlists', 'downloads'].includes(S.lastLib) ? S.lastLib : 'songs'}`;
  $$('#side-playlists a').forEach((a) => a.classList.toggle('active', name === 'playlist' && a.dataset.pl === parseRoute().arg));
}
function renderSidebarPlaylists() {
  const el = $('#side-playlists');
  const sorted = S.playlists.slice().sort((a, b) => coll.compare(a.name, b.name));
  el.innerHTML = sorted.length
    ? sorted.map((p) => `<a href="#/playlist/${p.id}" data-pl="${p.id}">${icon('playlist')}<span>${esc(p.name)}</span></a>`).join('')
    : '<div class="empty-hint">Noch keine Playlists</div>';
  updateNavPl();
}
function updateNavPl() {
  const r = parseRoute();
  $$('#side-playlists a').forEach((a) => a.classList.toggle('active', r.name === 'playlist' && a.dataset.pl === r.arg));
}

/* =========================================================
   Aktionen (Klicks per Delegation)
   ========================================================= */
const listOf = (el) => lists[el.dataset.list];
const actions = {
  'import-files': () => { $('#file-input').value = ''; $('#file-input').click(); },
  'import-folder': () => { $('#folder-input').value = ''; $('#folder-input').click(); },
  'reload-server-lib': () => loadServerLibrary(true),
  'cloud-reload': () => loadCloudLibrary(true),
  'cloud-link': () => cloudLinkDialog(),
  'cloud-off': async () => {
    const r = await openDialog({ title: 'Cloud trennen?', body: '<p>Die Cloud-Songs verschwinden von diesem Gerät (Favoriten bleiben). Deine Songs in der Cloud bleiben erhalten, du kannst dich per QR-Code jederzeit neu verbinden.</p>', buttons: [{ label: 'Abbrechen' }, { label: 'Trennen', danger: true, value: 'ok' }] });
    if (r) { cloudDisconnect(); refresh(); }
  },
  'phone-connect': () => phoneConnect(),
  eq: () => eqDialog(),
  pack: (el) => packFor(el.dataset.list),
  toggle: () => togglePlay(),
  next: () => next(),
  prev: () => prev(),
  shuffle: () => toggleShuffle(),
  repeat: () => cycleRepeat(),
  mute: () => { setVolume(vol.level, !vol.muted); saveState(); },
  'open-np': () => { if (curId) openOverlay('np'); },
  'open-np-mobile': () => { if (isMobile() && curId) openOverlay('np'); },
  'close-np': () => closeOverlay('np'),
  queue: () => (overlays.includes('queue') ? closeOverlay('queue') : openOverlay('queue')),
  'close-queue': () => closeOverlay('queue'),
  'clear-queue': () => {
    if (!S.queue.length) return;
    const cur = S.queue[S.index];
    S.queue = cur ? [cur] : [];
    S.original = S.queue.slice();
    S.index = cur ? 0 : -1;
    saveState();
    renderQueue();
  },
  'q-remove': (el) => removeFromQueue(+el.closest('[data-qi]').dataset.qi),
  sleep: (el) => sleepMenu(el),
  'fav-current': () => { const t = getT(curId); if (t) setFav(t.id, t.live ? !isRadioFav(t.id) : !t.fav); },
  'goto-artist': (el) => {
    if (el.closest('#player') && isMobile()) { if (curId) openOverlay('np'); return; }
    const t = getT(curId);
    if (!t) return;
    if (t.live) go('radio');
    else if (t.artistId) go('oartist', t.artistId);
    else go('artist', artistsOf(t)[0] || t.artist);
  },
  'np-menu': (el) => { if (curId) trackMenu(curId, el, { np: true }); },
  'color-menu': (el) => colorMenu(el),
  'open-lyrics': () => { if (!curId) return; openOverlay('np'); setLyricsMode(true); },
  'toggle-lyrics': () => setLyricsMode(!lyricsOpen),
  'lyrics-edit': () => editLyrics(),
  drawer: () => (overlays.includes('drawer') ? closeOverlay('drawer') : openOverlay('drawer')),
  'drawer-close': () => closeOverlay('drawer'),
  'drawer-go': (el) => { const h = el.getAttribute('href'); closeAllOverlays(); if (history.state?.overlay) history.replaceState(null, ''); location.hash = h; },
  'dl-favs': () => downloadTracks([...S.tracks.values()].filter((t) => t.fav).map((t) => t.id), 'Favoriten'),
  'dl-all': () => downloadTracks([...S.tracks.values()].map((t) => t.id), 'alle'),
  'dl-clear': async () => { if (!await confirmDialog('Downloads löschen?', `${plural(dlIds.size, 'Song', 'Songs')} werden vom Gerät entfernt. In der Bibliothek bleiben sie und spielen weiter über das Internet.`, 'Löschen', true)) return; await removeDownloads([...dlIds]); toast('Downloads gelöscht'); },
  output: () => pickOutput(),
  'pb-autodl': (el) => { PB.autoDlFavs = !PB.autoDlFavs; savePB(); setSwitch(el, PB.autoDlFavs); if (PB.autoDlFavs) downloadTracks([...S.tracks.values()].filter((t) => t.fav).map((t) => t.id), 'Favoriten'); },
  'search-filter': (el) => { S.searchFilter = el.dataset.f; renderSearch(); },
  'stat-range': (el) => { S.statRange = el.dataset.r; render(true); },
  'play-hit': (el) => { const L = lists[el.dataset.list]; if (!L) return; playIds(L.ids, +el.dataset.i, { source: L.opts.source }); openOverlay('np'); setLyricsMode(true); },
  'lyrics-retry': () => { const t = getT(curId); if (!t) return; const box = $('#np-lyrics'); if (box) box.innerHTML = `<div class="ly-empty ly-loading"><span class="spinner"></span><p>Suche …</p></div>`; lyr.get(t, { force: true }).then((r) => { if (!r?.text) toast('Leider kein Songtext gefunden.'); renderLyrics(true); }); },
  'lyrics-file': async () => {
    const id = curId;
    const f = await pickFile('#lrc-input');
    if (f && id) await saveLyrics(id, await f.text());
  },
  fav: (el) => { const id = el.closest('[data-id]').dataset.id; setFav(id, !getT(id)?.fav); },
  'track-menu': (el) => { const row = el.closest('.row'); trackMenu(row.dataset.id, el, rowCtx(row)); },
  'play-list': (el) => { const L = listOf(el); if (L) playIds(L.ids, 0, { source: L.opts.source }); },
  'shuffle-list': (el) => { const L = listOf(el); if (L) playIds(L.ids, 0, { source: L.opts.source, shuffle: true }); },
  'play-album': (el) => { const a = getAlbums().get(el.dataset.key); if (a) playIds(a.tracks.map((t) => t.id), 0, { source: a.name }); },
  'artist-pic': (el) => changeArtistPic(el.dataset.name),
  'artist-sort': (el) => { S.sort.artist = el.dataset.sort; ls.set('klang-sort', S.sort); render(true); },
  'play-artist': (el) => {
    const a = getArtists().get(artKey(el.dataset.name));
    if (a) playIds(artistTrackOrder(a.tracks, 'new'), 0, { source: a.name });
  },
  'play-playlist': (el) => { const p = S.playlists.find((x) => x.id === el.dataset.id); if (p) playIds(p.trackIds, 0, { source: p.name }); },
  'play-favs': () => playIds([...S.tracks.values()].filter((t) => t.fav).sort((a, b) => (b.favAt || 0) - (a.favAt || 0)).map((t) => t.id), 0, { source: 'Favoriten' }),
  'shuffle-all': () => playIds(sortedTrackIds('title'), 0, { source: 'Zufallsmix', shuffle: true }),
  'play-newest': () => playIds(sortedTrackIds('added').slice(0, 50), 0, { source: 'Neu hinzugefügt' }),
  'play-top': () => playIds(sortedTrackIds('plays').slice(0, 50), 0, { source: 'Meistgespielt' }),
  'play-at': (el) => {
    const L = listOf(el);
    if (!L) return;
    const i = +el.dataset.i;
    if (L.ids[i] === curId && S.queue.includes(curId)) { togglePlay(); return; }
    playIds(L.ids, i, { source: L.opts.source });
  },
  'disc-genre': (el) => {
    S.discGenre = el.dataset.genre;
    if (parseRoute().name === 'discover') render(true); else go('discover');
  },
  'radio-cat': (el) => {
    S.radioCat = el.dataset.cat;
    if (parseRoute().name === 'radio') render(true); else go('radio');
  },
  retry: () => { apiCache.clear(); refresh(); },
  'avatar-pick': () => pickAvatar(),
  'avatar-remove': () => { auth.update({ avatar: null }); updateProfileUI(); refresh(); toast('Profilbild entfernt'); },
  logout: async () => {
    if (!await confirmDialog('Abmelden?', 'Deine Musik bleibt auf dem Gerät. Zum Weiterhören meldest du dich wieder an.', 'Abmelden')) return;
    audio.pause();
    auth.logout();
    updateProfileUI();
    location.hash = '#/';
    showAuth('login');
  },
  'feat-go': (el) => { if (+el.dataset.i !== feat.i) showFeature(+el.dataset.i); },
  'feat-pause': (el) => {
    feat.paused = !feat.paused;
    el.innerHTML = icon(feat.paused ? 'play' : 'pause');
    el.setAttribute('aria-label', feat.paused ? 'Wechsel fortsetzen' : 'Wechsel anhalten');
    const bar = $('#feature .ft-dot.on i');
    if (bar && window.gsap) { gsap.killTweensOf(bar); bar.style.setProperty('--p', 1); }
  },
  'album-menu': (el) => albumMenu(el.dataset.key, el),
  'playlist-menu': (el) => playlistMenu(el.dataset.id, el),
  'new-playlist': async () => { const p = await newPlaylistFlow(); if (p) go('playlist', p.id); },
  accent: (el) => setAccent(el.dataset.name),
  'toggle-live': (el) => { const on = !liveCoverOn(); ls.set('klang-live', on); applyLiveCover(); setSwitch(el, on); },
  theme: (el) => { ls.set('klang-theme', el.dataset.id); applyTheme(); $$('.theme').forEach((b) => { const on = b === el; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }); },
  motion: (el) => { setMotion(el.dataset.v); segSelect(el); toast(el.dataset.v === 'calm' ? 'Animationen ruhig' : 'Animationen voll', 1400); },
  'pb-gapless': (el) => { PB.gapless = !PB.gapless; savePB(); setSwitch(el, PB.gapless); if (!PB.gapless) dropPrep(); },
  'pb-mix': (el) => { PB.smartMix = el.dataset.v; savePB(); segSelect(el); },
  'pb-share': (el) => { PB.shareStatus = !PB.shareStatus; savePB(); setSwitch(el, PB.shareStatus); if (PB.shareStatus) sendPresence(); else { const c = cloudCfg(); const body = JSON.stringify({ paused: true }); if (S.srvOK) fetch(withKey('/api/presence'), { method: 'POST', body }).catch(() => {}); else if (c) fetch(`${c.url}/api/now?k=${encodeURIComponent(c.key)}`, { method: 'PUT', body }).catch(() => {}); } },
  'discord-toggle': async (el) => {
    const id = ($('[data-discord-id]')?.value || '').replace(/\D/g, '');
    const on = !el.classList.contains('on');
    if (on && id.length < 15) { toast('Bitte zuerst die Application-ID eintragen (siehe Anleitung darunter).', 3500); $('[data-discord-id]')?.focus(); return; }
    el.disabled = true;
    try { await fetch('/api/discord', { method: 'POST', body: JSON.stringify({ clientId: id, enabled: on }) }); } catch { /* */ }
    await renderDiscordBox();
    if (on) setTimeout(() => { sendPresence(); renderDiscordBox(); }, 1500);
  },
  'set-jump': (el, e) => { e?.preventDefault(); $(`#set-${el.dataset.k}`)?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }); },
  'lyrics-all': async (el) => {
    el.disabled = true;
    const lab = el.querySelector('[data-lyrics-progress]');
    await lyr.prefetch([...S.tracks.values()].filter((t) => !t.live && !isOnline(t)), (d, n) => { if (lab?.isConnected) lab.textContent = `${d} / ${n}`; });
    if (lab?.isConnected) lab.textContent = 'Fertig';
    toast('Songtexte geladen. Sie gehen jetzt auch offline.');
  },
  'covers-all': async (el) => {
    el.disabled = true;
    const lab = el.querySelector('[data-cover-progress]');
    const ids = [...new Set([...S.tracks.values()].map((t) => t.coverId).filter((c) => c?.startsWith('c:')))];
    let d = 0;
    for (const id of ids) { await coverUrl(id); d++; if (lab?.isConnected && d % 5 === 0) lab.textContent = `${d} / ${ids.length}`; }
    if (lab?.isConnected) lab.textContent = 'Fertig';
  },
  'stats-export': () => {
    const blob = new Blob([stats.exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `VERS-Statistik-${stats.dayKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  'stats-reset': async () => {
    if (!await confirmDialog('Statistik zurücksetzen?', 'Alle gezählten Minuten, Top-Künstler und Top-Songs werden auf diesem Gerät gelöscht.', 'Zurücksetzen', true)) return;
    stats.reset();
    render(true);
    toast('Statistik zurückgesetzt');
  },
  'lyrics-clear': async () => {
    if (!await confirmDialog('Songtexte löschen?', 'Die gespeicherten Songtexte werden entfernt und beim nächsten Abspielen neu geladen. Selbst eingefügte Texte bleiben.', 'Löschen', true)) return;
    await lyr.clearAll();
    render(true);
  },
  persist: async () => {
    const ok = await navigator.storage?.persist?.();
    toast(ok ? 'Dauerhafter Speicher aktiviert' : 'Der Browser hat abgelehnt. Installiere VERS als App, dann klappt es meist.', 4000);
    after.settings();
  },
  install: async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => {});
    deferredInstall = null;
    $$('[data-install]').forEach((b) => b.classList.add('hidden'));
  },
  wipe: async () => {
    if (!await confirmDialog('Wirklich alles löschen?', 'Alle Titel, Cover und Playlists werden von diesem Gerät entfernt. Das kann nicht rückgängig gemacht werden.', 'Alles löschen', true)) return;
    stopPlayback();
    await Promise.all(['tracks', 'audio', 'covers', 'playlists'].map((s) => db.clear(s)));
    S.tracks.clear(); S.playlists = []; coverKeys.clear(); coverUrls.clear(); tintCache.clear(); artCache.clear();
    invalidate();
    renderSidebarPlaylists();
    render();
    toast('Bibliothek gelöscht');
  },
};
function rowCtx(row) {
  const L = lists[row.dataset.list];
  return { playlist: L?.opts.playlist, index: +row.dataset.i };
}

function setupEvents() {
  // Formulare: Login/Registrierung, Profil, Passwort
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const kind = form.dataset.form;
    if (kind === 'auth') { submitAuth(form); return; }
    const d = Object.fromEntries(new FormData(form));
    if (kind === 'profile') {
      const display = (d.display || '').trim();
      if (!display) { toast('Der Anzeigename darf nicht leer sein.'); return; }
      auth.update({ display, bio: (d.bio || '').trim(), genre: d.genre || 'all', ...(d.color ? { color: d.color } : {}) });
      if (d.genre && d.genre !== 'all') S.discGenre = d.genre;
      updateProfileUI();
      refresh();
      toast('Profil gespeichert');
    } else if (kind === 'password') {
      const r = await auth.changePassword(d.old || '', d.new || '', d.new2 || '');
      if (!r.ok) { setFieldErr(form, r.error, r.msg); return; }
      setFieldErr(form, null);
      form.reset();
      toast('Neues Passwort gespeichert');
    }
  });
  document.addEventListener('click', (e) => {
    const au = e.target.closest('[data-auth]');
    if (au) {
      e.preventDefault();
      if (au.dataset.auth === 'switch') showAuth(authMode === 'login' ? 'register' : 'login');
      if (au.dataset.auth === 'eye') {
        const inp = au.parentElement.querySelector('input');
        const show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        au.innerHTML = icon(show ? 'eye-off' : 'eye');
        au.setAttribute('aria-label', show ? 'Passwort verbergen' : 'Passwort anzeigen');
      }
      return;
    }
  }, true);
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (a && !a.disabled) {
      e.preventDefault();
      e.stopPropagation();
      actions[a.dataset.action]?.(a, e);
      return;
    }
    const ly = e.target.closest('.ly-line[data-t]');
    if (ly) {
      audio.currentTime = +ly.dataset.t;
      lyricsUserScroll = 0;
      if (audio.paused) togglePlay();
      syncLyrics(true);
      return;
    }
    const q = e.target.closest('.q-row[data-qi]');
    if (q) {
      const qi = +q.dataset.qi;
      if (qi === S.index) togglePlay(); else { S.index = qi; loadAndPlay(true); }
      return;
    }
    const row = e.target.closest('.row[data-list]');
    if (row) {
      const L = lists[row.dataset.list];
      if (!L) return;
      if (row.dataset.id === curId && L.ids[+row.dataset.i] === curId && S.queue.includes(curId)) { togglePlay(); return; }
      playIds(L.ids, +row.dataset.i, { source: L.opts.source });
    }
    // Links im Vollbild-Player schließen diesen
    const link = e.target.closest('a[href^="#/"]');
    if (link && overlays.length) closeAllOverlays();
  });

  document.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row[data-list]');
    if (row) { e.preventDefault(); trackMenu(row.dataset.id, { x: e.clientX, y: e.clientY }, rowCtx(row)); return; }
    const oc = e.target.closest('[data-action="play-at"][data-id]');
    if (oc) { e.preventDefault(); trackMenu(oc.dataset.id, { x: e.clientX, y: e.clientY }); return; }
    const card = e.target.closest('[data-album-key]');
    if (card) { e.preventDefault(); albumMenu(card.dataset.albumKey, { x: e.clientX, y: e.clientY }); }
  });

  document.addEventListener('change', (e) => {
    const s = e.target.closest('[data-change="sort"]');
    if (s) { S.sort[s.dataset.what] = s.value; ls.set('klang-sort', S.sort); render(); }
    const dt = e.target.closest('[data-change="disc-time"]');
    if (dt) { S.discTime = dt.value; render(true); }
  });

  // Datei-Inputs
  $('#file-input').addEventListener('change', (e) => {
    const files = [...e.target.files].map((f) => ({ file: f, path: f.name }));
    if (files.length) importItems(files);
  });
  $('#folder-input').addEventListener('change', (e) => {
    const files = [...e.target.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
    if (files.length) importItems(files);
  });

  // Seek & Lautstärke
  npEls.seek.forEach((r) => {
    r.addEventListener('input', () => {
      seeking = true;
      const p = r.value / 1000;
      r.style.setProperty('--p', p * 100 + '%');
      const d = audio.duration || getT(curId)?.duration || 0;
      npEls.cur.forEach((e) => { e.textContent = fmt(p * d); });
    });
    r.addEventListener('change', () => {
      const d = audio.duration;
      if (Number.isFinite(d)) audio.currentTime = (r.value / 1000) * d;
      seeking = false;
      updatePosState();
      updateProgress();
    });
  });
  npEls.vol.forEach((r) => r.addEventListener('input', () => {
    setVolume(r.value / 100, r.value == 0);
    saveState();
  }));
  $('#player').addEventListener('wheel', (e) => {
    if (!e.target.closest('.pb-right')) return;
    e.preventDefault();
    setVolume(vol.level - Math.sign(e.deltaY) * 0.05, false);
  }, { passive: false });

  // Drag & Drop: Dateien importieren
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#drop-overlay').classList.add('on'); });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').classList.remove('on'); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').classList.remove('on');
    const items = await filesFromDrop(e.dataTransfer);
    if (items.length) importItems(items);
  });

  // Drag & Drop: Playlist sortieren (Desktop)
  let dragRow = null;
  document.addEventListener('dragstart', (e) => {
    const row = e.target.closest?.('.row[draggable="true"]');
    if (!row) return;
    dragRow = row;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.dataset.id);
  });
  document.addEventListener('dragover', (e) => {
    if (!dragRow) return;
    const row = e.target.closest('.row[draggable="true"]');
    $$('.drop-before, .drop-after').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
    if (!row || row.dataset.list !== dragRow.dataset.list) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    row.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  document.addEventListener('drop', (e) => {
    if (!dragRow) return;
    const row = e.target.closest('.row[draggable="true"]');
    if (row && row.dataset.list === dragRow.dataset.list) {
      e.preventDefault();
      const from = +dragRow.dataset.i;
      let to = +row.dataset.i + (row.classList.contains('drop-after') ? 1 : 0);
      if (from < to) to--;
      const L = lists[row.dataset.list];
      if (L?.opts.playlist) movePlaylistTrack(L.opts.playlist, from, to);
    }
  });
  document.addEventListener('dragend', () => {
    dragRow?.classList.remove('dragging');
    dragRow = null;
    $$('.drop-before, .drop-after').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
  });

  // Tastatur
  document.addEventListener('keydown', (e) => {
    if (document.body.classList.contains('auth-open')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); go('search'); return; }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[role="button"][data-action]')) { e.preventDefault(); e.target.click(); return; }
    const tag = e.target.tagName;
    if (tag === 'INPUT' && e.target.type !== 'range' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      if ($('#menu-layer').classList.contains('open')) closeMenu();
      else if (overlays.length) closeOverlay(overlays[overlays.length - 1]);
      return;
    }
    const k = e.key;
    let handled = true;
    if (k === ' ') togglePlay();
    else if (k === 'ArrowRight') e.shiftKey ? next() : (audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5));
    else if (k === 'ArrowLeft') e.shiftKey ? prev() : (audio.currentTime = Math.max(0, audio.currentTime - 5));
    else if (k === 'ArrowUp') setVolume(vol.level + 0.05, false);
    else if (k === 'ArrowDown') setVolume(vol.level - 0.05);
    else if (k === 'm' || k === 'M') setVolume(vol.level, !vol.muted);
    else if (k === 's' || k === 'S') toggleShuffle();
    else if (k === 'r' || k === 'R') cycleRepeat();
    else if (k === 'l' || k === 'L') actions['fav-current']();
    else if (k === 'q' || k === 'Q') actions.queue();
    else if (k === 'e' || k === 'E') eqDialog();
    else if (k === 't' || k === 'T') { if (overlays.includes('np')) setLyricsMode(!lyricsOpen); else actions['open-lyrics'](); }
    else if (k === '/') go('search');
    else handled = false;
    if (handled) e.preventDefault();
  });

  // Wer im Songtext selbst scrollt, wird 4 Sekunden nicht automatisch zurückgezogen
  const lyBox = $('#np-lyrics');
  ['wheel', 'touchmove'].forEach((ev) => lyBox.addEventListener(ev, () => { lyricsUserScroll = Date.now(); }, { passive: true }));
  lyBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('.ly-line[data-t]')) e.target.click(); });

  // Vollbild-Player nach unten wischen zum Schließen
  let ty = null;
  const np = $('#np');
  np.addEventListener('touchstart', (e) => { ty = e.target.closest('.range, button, .np-lyrics') ? null : e.touches[0].clientY; }, { passive: true });
  np.addEventListener('touchmove', (e) => {
    if (ty == null) return;
    const dy = e.touches[0].clientY - ty;
    if (dy > 0) { np.style.transition = 'none'; np.style.transform = `translateY(${dy}px)`; }
  }, { passive: true });
  np.addEventListener('touchend', (e) => {
    if (ty == null) return;
    const dy = e.changedTouches[0].clientY - ty;
    np.style.transition = '';
    np.style.transform = '';
    ty = null;
    if (dy > 110) closeOverlay('np');
  });

  window.addEventListener('pagehide', saveState);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveState(); });
  window.addEventListener('hashchange', () => {
    if (/^#cloud=/.test(location.hash)) {
      const ok = takeCloudLink(location.hash);
      history.replaceState(null, '', location.pathname + location.search + '#/');
      if (ok) loadCloudLibrary(true);
    }
    closeMenu(); withTransition('route', () => render()); });
}

/* =========================================================
   PWA: Installation, Service Worker, Dateien öffnen
   ========================================================= */
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  $$('[data-install]').forEach((b) => { b.classList.remove('hidden'); b.classList.add('btn-accent'); });
});
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  $$('[data-install]').forEach((b) => b.classList.add('hidden'));
  toast('VERS wurde installiert 🎉');
});

function registerSW() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service Worker:', e));
  }
}

function setupLaunchQueue() {
  // Am PC: Audiodateien per Doppelklick / "Öffnen mit" direkt in VERS öffnen
  if (!('launchQueue' in window)) return;
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    const files = [];
    for (const h of params.files) { try { files.push(await h.getFile()); } catch { /* */ } }
    const ids = await importItems(files.map((f) => ({ file: f, path: f.name })));
    if (ids.length) playIds(ids, 0, { source: 'Geöffnete Dateien' });
  });
}

/* =========================================================
   Start
   ========================================================= */
/* =========================================================
   Server-Bibliothek (Musik aus Downloads/music)
   ========================================================= */
// ---- Katalog: saubere Titel, alle Künstler, Album, Jahr, Länge und das eigene Cover jedes Songs ----
async function fetchCatalog(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j?.tracks) ? j : null;
  } catch { return null; }
}
// Übernimmt die Katalog-Infos in einen Titel. Gibt true zurück, wenn sich etwas geändert hat.
function applyMeta(t, c, v) {
  if (!c || t.cv === v) return false;
  Object.assign(t, {
    title: c.title, version: c.version || '', artists: c.artists.slice(), artist: c.artists.join(', '),
    album: c.album || c.title, albumArtist: c.albumArtist || c.artists[0], year: c.year || '', genre: c.genre || '',
    trackNo: c.trackNo || 0, discNo: c.discNo || 0, duration: c.dur || t.duration || 0, dup: c.dup || '',
    coverId: c.cover ? 'c:' + c.cover : (t.coverId?.startsWith('a:') ? null : t.coverId), cv: v,
  });
  return true;
}
// Doppelte Songs ausblenden: Favorit, Playlists und Warteschlange gehen auf die behaltene Version über
async function dropDuplicates(idOf) {
  const gone = [...S.tracks.values()].filter((t) => t.dup && S.tracks.has(idOf(t.dup)));
  if (!gone.length) return 0;
  const pls = new Set();
  const swap = new Map();
  for (const t of gone) {
    const keep = S.tracks.get(idOf(t.dup));
    swap.set(t.id, keep.id);
    if (t.fav && !keep.fav) { keep.fav = true; keep.favAt = t.favAt; db.put('tracks', keep).catch(() => {}); }
    keep.playCount = Math.max(keep.playCount || 0, t.playCount || 0);
    for (const p of S.playlists) p.trackIds = p.trackIds.map((id) => { if (id === t.id) { pls.add(p); return keep.id; } return id; });
    S.tracks.delete(t.id);
    db.del('tracks', t.id).catch(() => {});
  }
  const sw = (id) => swap.get(id) || id;
  S.queue = S.queue.map(sw); S.original = S.original.map(sw);
  if (swap.has(curId)) curId = swap.get(curId);
  for (const p of pls) await savePlaylist(p);
  invalidate();
  return gone.length;
}
async function loadServerLibrary(showToast = false) {
  let list;
  try {
    const r = await fetch(withKey('/api/music'), { cache: 'no-store' });
    if (r.status === 403) {
      if (showToast || !location.hostname.match(/^(localhost|127\.0\.0\.1)$/)) toast('Zugang zum Musik-Ordner fehlt. Scanne den QR-Code unter „Aufs Handy“ am PC neu.', 5000);
      return;
    }
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error('kein Musik-Server');
    list = await r.json();
    if (!Array.isArray(list)) throw new Error('unerwartete Antwort');
  } catch {
    // Kein lokaler VERS-Server (z. B. auf der Online-Version): Knopf bleibt versteckt
    if (showToast) toast('Der Musik-Ordner geht nur mit dem VERS-Server auf deinem PC („VERS starten.bat“).', 4500);
    return;
  }
  $$('[data-server-lib]').forEach((b) => b.classList.remove('hidden'));
  const firstContact = !S.srvOK;
  S.srvOK = true; // PC-Musikordner erreichbar: „Für unterwegs“ anbieten
  // „Aufs Handy“ nur am PC selbst anbieten
  fetch('/api/lan', { cache: 'no-store' }).then((r) => { if (r.ok) $$('[data-phone-btn]').forEach((b) => b.classList.remove('hidden')); }).catch(() => {});

  if (!list.length) {
    if (showToast) toast('Im Musik-Ordner (Downloads\\music) liegen noch keine Songs.', 4000);
    return;
  }

  const cat = await fetchCatalog(withKey('/api/catalog'));
  if (cat) coverBase = (f) => withKey('/covers/' + f);
  const meta = new Map((cat?.tracks || []).map((c) => [c.f, c]));
  let added = 0;
  const fresh = [];
  for (const item of list) {
    const id = 'srv:' + item.url;
    const known = S.tracks.get(id);
    const c = meta.get(item.url.slice('/music/'.length));
    if (!known && c?.dup && meta.has(c.dup)) continue; // doppelt: nur eine Version zeigen
    if (known) {
      // Dateigröße nachtragen (für die Paketgröße „für unterwegs“)
      let ch = applyMeta(known, c, cat?.v);
      if (item.size && known.size !== item.size) { known.size = item.size; ch = true; }
      if (ch) fresh.push(known);
      continue;
    }
    const title = item.file.replace(/\.[^.]+$/, '');
    const track = {
      id,
      remote: 'server',
      streamUrl: item.url,
      title,
      artist: item.artist || 'Unbekannter Künstler',
      album: item.artist || 'Lokale Musik',
      albumArtist: item.artist || '',
      year: '', genre: '',
      trackNo: 0, discNo: 0,
      duration: 0,
      fileName: item.file, size: item.size || 0,
      coverId: null,
      fav: false, favAt: 0, playCount: 0, lastPlayed: 0,
      addedAt: Date.now(),
    };
    applyMeta(track, c, cat?.v);
    S.tracks.set(id, track);
    fresh.push(track);
    added++;
  }
  if (fresh.length) { try { await db.putMany('tracks', fresh); } catch { /* */ } }
  const dropped = await dropDuplicates((f) => 'srv:/music/' + f);
  if (fresh.length > added || dropped) { invalidate(); refresh(); if (curId) updatePlayerUI(); }

  if (added > 0) {
    invalidate();
    refresh();
    if (showToast) toast(`${plural(added, 'Titel', 'Titel')} aus Musik-Ordner geladen`, 3000);
  } else {
    if (firstContact) refresh(); // Knopf „Für unterwegs“ einblenden
    if (showToast) toast(`Alles aktuell: ${plural(list.length, 'Song', 'Songs')} im Musik-Ordner`, 3000);
  }
  syncArtistPics();
}

/* ---------- Cloud: alle Songs von überall (privater Speicher, nur mit Schlüssel) ---------- */
async function cloudLinkDialog() {
  const r = await openDialog({
    title: 'Cloud verbinden',
    body: `<label class="field"><span>Link von „Aufs Handy“ am PC</span><input name="link" placeholder="https://masterman881.github.io/klang/#cloud=…" autocomplete="off" spellcheck="false"></label>`,
    buttons: [{ label: 'Abbrechen' }, { label: 'Verbinden', primary: true, value: 'ok' }],
  });
  if (r?.value !== 'ok') return;
  if (!takeCloudLink(r.data.link)) { toast('Das ist nicht der richtige Link. Am PC unter „Aufs Handy“ auf „Link kopieren“ drücken.', 5000); return; }
  await loadCloudLibrary(true);
  render();
}
async function loadCloudLibrary(showToast = false) {
  const c = cloudCfg();
  if (!c) return;
  let list;
  try {
    const r = await fetch(`${c.url}/api/music?k=${encodeURIComponent(c.key)}`, { cache: 'no-store' });
    if (r.status === 403) { toast('Cloud-Zugang ungültig. Scanne den QR-Code am PC neu („Aufs Handy“).', 5000); return; }
    if (!r.ok) throw new Error();
    list = await r.json();
    if (!Array.isArray(list)) throw new Error();
  } catch {
    if (showToast) toast(navigator.onLine ? 'Cloud gerade nicht erreichbar.' : 'Kein Internet: Cloud-Songs brauchen Internet.', 4000);
    return;
  }
  S.cloudOK = true;
  const k = encodeURIComponent(c.key);
  const cat = await fetchCatalog(`${c.url}/api/catalog?k=${k}`);
  if (cat) coverBase = (f) => `${c.url}/covers/${f}?k=${k}`;
  const meta = new Map((cat?.tracks || []).map((x) => [x.f, x]));
  let added = 0;
  const fresh = [];
  for (const item of list) {
    let path;
    try { path = item.url.split('/').map(decodeURIComponent).join('/'); } catch { continue; }
    const id = 'cloud:' + path;
    const known = S.tracks.get(id);
    const m = meta.get(path.slice('/music/'.length));
    if (!known && m?.dup && meta.has(m.dup)) continue;
    if (known) {
      let ch = applyMeta(known, m, cat?.v);
      if (item.size && known.size !== item.size) { known.size = item.size; ch = true; }
      if (ch) fresh.push(known);
      continue;
    }
    const track = {
      id, remote: 'cloud', streamUrl: path,
      title: item.file.replace(/\.[^.]+$/, ''),
      artist: item.artist || 'Unbekannter Künstler',
      album: item.artist || 'Cloud',
      albumArtist: item.artist || '',
      year: '', genre: '', trackNo: 0, discNo: 0, duration: 0,
      fileName: item.file, size: item.size || 0, coverId: null,
      fav: false, favAt: 0, playCount: 0, lastPlayed: 0, addedAt: Date.now(),
    };
    applyMeta(track, m, cat?.v);
    S.tracks.set(id, track);
    fresh.push(track);
    added++;
  }
  if (fresh.length) { try { await db.putMany('tracks', fresh); } catch { /* */ } }
  const dropped = await dropDuplicates((f) => 'cloud:/music/' + f);
  if (fresh.length || dropped) { invalidate(); refresh(); if (curId) updatePlayerUI(); }
  if (showToast) toast(added ? `${plural(added, 'Song', 'Songs')} aus der Cloud geladen` : `Alles aktuell: ${plural(list.length, 'Song', 'Songs')} in der Cloud`, 3000);
  syncArtistPics({ list: `${c.url}/api/pics?k=${k}`, file: (u) => `${c.url}${u}?k=${k}` });
}
function cloudDisconnect() {
  ls.set(CLOUD, null);
  const ids = [...S.tracks.values()].filter((t) => t.remote === 'cloud' && !t.fav).map((t) => t.id);
  for (const id of ids) S.tracks.delete(id);
  Promise.all(ids.map((id) => db.del('tracks', id).catch(() => {}))).then(() => { invalidate(); refresh(); });
  toast('Cloud getrennt');
}

/* ---------- Für unterwegs: Songs vom PC als Paket aufs Handy ---------- */
// Jeden Pfadteil einzeln kodieren, damit auch Namen mit # oder ? funktionieren
function encPath(p) { return p.split('/').map((s) => encodeURIComponent(s)).join('/'); }
function packBtn(k) {
  if (!S.srvOK) return '';
  const n = (lists[k]?.ids || []).filter((id) => getT(id)?.remote === 'server').length;
  return n ? `<button class="btn btn-sm pack-btn" data-action="pack" data-list="${k}" title="Songs aufs Handy kopieren, offline hören" aria-label="Für unterwegs">${icon('download')}<span>Für unterwegs</span></button>` : '';
}
async function packFor(k) {
  const L = lists[k];
  if (!L) return;
  const uniq = [...new Map(L.ids.map(getT).filter((t) => t?.remote === 'server').map((t) => [t.id, t])).values()];
  if (!uniq.length) return;
  const size = uniq.reduce((s, t) => s + (t.size || 0), 0);
  const tooBig = size > 3.9e9;
  const r = await openDialog({
    title: 'Für unterwegs',
    body: `<p><b>${plural(uniq.length, 'Song', 'Songs')}</b>${size ? ` · ca. ${fmtBytes(size)}` : ''} aus „${esc(L.opts.source || 'deiner Auswahl')}“</p>
      ${tooBig ? '<p class="field-err">Das sind mehr als 3,9 GB. Bitte eine kleinere Playlist wählen.</p>' : `
      <ol class="steps">
        <li>Paket herunterladen (am besten im WLAN, das dauert etwas).</li>
        <li>Deine <b>VERS-App</b> vom Startbildschirm öffnen.</li>
        <li><b>Musik hinzufügen</b> tippen und die ZIP-Datei wählen.</li>
      </ol>
      <p class="small muted">Danach liegen die Songs auf dem Handy und laufen offline, auch ohne PC und ohne Internet. Platz auf dem Handy nicht vergessen.</p>`}`,
    buttons: tooBig ? [{ label: 'Schließen', primary: true }] : [{ label: 'Abbrechen' }, { label: 'Paket herunterladen', primary: true, value: 'ok' }],
  });
  if (!r || tooBig) return;
  let res;
  try {
    res = await fetch(withKey('/api/pack'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: uniq.map((t) => encPath(t.streamUrl)) }) });
  } catch { toast('Der PC ist nicht erreichbar. Läuft das schwarze VERS-Fenster?', 4500); return; }
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { toast(d.error || 'Das Paket konnte nicht erstellt werden.', 4500); return; }
  const a = document.createElement('a');
  a.href = withKey(`/api/pack/${d.id}`);
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(`Download startet: ${plural(d.count, 'Song', 'Songs')}, ${fmtBytes(d.size)}. Danach in der VERS-App unter „Musik hinzufügen“ wählen.`, 7000);
}

/* ---------- Aufs Handy: QR-Code mit WLAN-Adresse und Schlüssel ---------- */
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = () => res(); s.onerror = rej;
    document.head.appendChild(s);
  });
}
const ipRank = (u) => (/\/\/192\.168\./.test(u) ? 0 : /\/\/10\./.test(u) ? 1 : /\/\/172\./.test(u) ? 2 : 3);
const APP_URL = 'https://masterman881.github.io/klang/';
async function phoneConnect(forceLan = false) {
  // Mit eingerichteter Cloud: Handy-Zugang von überall (HTTPS, installierbar, PC muss nicht laufen)
  if (!forceLan) {
    let c = null;
    try { const r = await fetch('/api/cloud', { cache: 'no-store' }); if (r.ok) c = await r.json(); } catch { /* */ }
    if (c?.url && c?.key) {
      await loadScript('js/vendor/qrcode.js');
      const link = `${APP_URL}#cloud=${encodeURIComponent(c.url)}&ck=${encodeURIComponent(c.key)}`;
      const qr = qrcode(0, 'M'); qr.addData(link); qr.make();
      const n = [...S.tracks.values()].filter((t) => t.remote === 'server').length;
      const pending = openDialog({
        title: 'Aufs Handy',
        body: `<div class="qr">${qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true, alt: 'QR-Code für VERS mit Cloud-Zugang' })}</div>
          <ol class="steps">
            <li>Code mit der <b>Handy-Kamera</b> scannen und den Link öffnen.</li>
            <li>Einloggen. ${n ? `Deine ${n.toLocaleString('de')} Songs` : 'Deine Songs'} kommen aus deiner privaten Cloud, <b>überall</b>, auch ohne WLAN und ohne PC.</li>
            <li>VERS zum Startbildschirm hinzufügen (iPhone: Teilen → „Zum Home-Bildschirm“).</li>
          </ol>
          <p class="small muted">Der Code enthält deinen geheimen Cloud-Schlüssel. Zeig ihn niemandem. Unterwegs braucht das Handy Internet.</p>
          <div class="btns qr-btns"><button class="btn" type="button" data-copy-link>${icon('link')}Link kopieren</button><a class="btn" href="${esc(link)}" target="_blank" rel="noopener">${icon('external')}Hier am PC öffnen</a></div>
          <p class="small muted"><button class="link" type="button" data-value="lan">Stattdessen nur im WLAN vom PC hören</button></p>`,
        buttons: [{ label: 'Fertig', primary: true, value: 'ok' }],
      });
      $('#dialog-layer [data-copy-link]')?.addEventListener('click', async (e) => {
        try { await navigator.clipboard.writeText(link); toast('Link kopiert. Auf der Online-Seite „Link einfügen“ drücken.'); }
        catch { toast('Kopieren ging nicht. Nimm „Hier am PC öffnen“.'); }
        e.currentTarget.blur();
      });
      const r = await pending;
      if (r?.value === 'lan') phoneConnect(true);
      return;
    }
  }
  let info;
  try {
    const r = await fetch('/api/lan', { cache: 'no-store' });
    if (!r.ok) throw new Error();
    info = await r.json();
  } catch { toast('„Aufs Handy“ geht nur am PC mit dem VERS-Server.'); return; }
  if (!info.lan || !info.urls.length) {
    openDialog({
      title: 'Aufs Handy',
      body: `<p>Damit dein Handy mithören kann, muss VERS im WLAN-Modus laufen:</p>
        <ol class="steps">
          <li>Das schwarze VERS-Fenster schließen.</li>
          <li>Im VERS-Ordner auf <b>„VERS fürs Handy starten.bat“</b> doppelklicken.</li>
          <li>Fragt Windows nach der Firewall: <b>Zulassen</b> für private Netzwerke.</li>
          <li>Hier wieder auf <b>„Aufs Handy“</b> klicken.</li>
        </ol>`,
      buttons: [{ label: 'Verstanden', primary: true, value: 'ok' }],
    });
    return;
  }
  await loadScript('js/vendor/qrcode.js');
  const urls = info.urls.slice().sort((a, b) => ipRank(a) - ipRank(b)).map((u) => `${u}?k=${encodeURIComponent(info.key)}`);
  const qrSvg = (url) => { const qr = qrcode(0, 'M'); qr.addData(url); qr.make(); return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true, alt: 'QR-Code für VERS am Handy' }); };
  const n = [...S.tracks.values()].filter((t) => t.remote === 'server').length;
  openDialog({
    title: 'Aufs Handy',
    body: `<div class="qr" data-qr>${qrSvg(urls[0])}</div>
      <ol class="steps">
        <li>Handy ins <b>gleiche WLAN</b> wie diesen PC bringen.</li>
        <li>Code mit der <b>Handy-Kamera</b> scannen und den Link öffnen.</li>
        <li>Einloggen: ${n ? `deine ${n.toLocaleString('de')} Songs` : 'deine Songs'} spielen vom PC.</li>
      </ol>
      <p class="small muted">Das schwarze VERS-Fenster am PC muss dabei offen bleiben. Tipp: Im Handy-Browser „Zum Startbildschirm hinzufügen“, dann hast du ein Icon.</p>
      ${urls.length > 1 ? `<p class="small muted">Klappt nicht? Andere Adresse probieren: ${urls.map((u, i) => `<button class="link qr-alt" type="button" data-qr-url="${esc(u)}">${esc(new URL(u).host)}</button>${i < urls.length - 1 ? ' · ' : ''}`).join('')}</p>` : ''}
      <details class="small"><summary>Adresse zum Abtippen</summary><code class="qr-url">${esc(urls[0])}</code></details>`,
    buttons: [{ label: 'Fertig', primary: true, value: 'ok' }],
  });
  $('#dialog-layer').addEventListener('click', (e) => {
    const b = e.target.closest('[data-qr-url]');
    if (!b) return;
    $('#dialog-layer [data-qr]').innerHTML = qrSvg(b.dataset.qrUrl);
    $('#dialog-layer .qr-url').textContent = b.dataset.qrUrl;
  });
}

/* =========================================================
   Menü (Drawer) fürs Handy
   ========================================================= */
function renderDrawer() {
  const a = auth.current();
  const st = stats.summary('month');
  const r = parseRoute().name;
  const item = (route, href, ic, label, extra = '') => `<a href="${href}" class="${route === r ? 'on' : ''}" data-action="drawer-go">${icon(ic)}<span>${label}</span>${extra}</a>`;
  $('#drawer').innerHTML = `
    <a class="dr-profile" href="#/profil" data-action="drawer-go">${a ? avatarHTML(a, 'sm') : `<span class="avatar sm">${icon('user')}</span>`}
      <span class="dr-who"><b>${esc(a?.display || 'Profil')}</b><small>Profil ansehen</small></span>${icon('chevron-right')}</a>
    <a class="dr-stat" href="#/stats" data-action="drawer-go"><b>${minutes(st.total).toLocaleString('de')}</b><span>Minuten in 30 Tagen${st.artists[0] ? `<br><small>Top: ${esc(st.artists[0].name)}</small>` : ''}</span>${icon('stats')}</a>
    <div class="dr-group"><small>Hören</small>
      ${item('home', '#/', 'home', 'Start')}${item('discover', '#/discover', 'compass', 'Entdecken')}${item('radio', '#/radio', 'radio', 'Radio')}${item('search', '#/search', 'search', 'Suchen')}
    </div>
    <div class="dr-group"><small>Bibliothek</small>
      ${item('songs', '#/songs', 'music', 'Titel')}${item('albums', '#/albums', 'disc', 'Alben')}${item('artists', '#/artists', 'user', 'Künstler')}${item('favorites', '#/favorites', 'heart', 'Favoriten')}${item('playlists', '#/playlists', 'playlist', 'Playlists')}${item('downloads', '#/downloads', 'download', 'Downloads', dlIds.size ? `<em>${dlIds.size}</em>` : '')}
    </div>
    <div class="dr-group"><small>Du</small>
      ${item('stats', '#/stats', 'stats', 'Statistik')}${item('profil', '#/profil', 'user', 'Profil')}${item('settings', '#/settings', 'settings', 'Einstellungen')}
    </div>`;
}

/* =========================================================
   Mini-Player: Wischen
   rechts = nächster Song · links = von vorne · 2× links schnell = vorheriger Song
   ========================================================= */
function prevTrack() {
  if (!S.queue.length) return;
  if (S.index > 0) S.index--;
  else if (S.repeat === 'all') S.index = S.queue.length - 1;
  else { audio.currentTime = 0; return; }
  loadAndPlay(true);
}
function setupMiniSwipe() {
  const bar = $('#player');
  const area = $('.pb-left', bar);
  const hint = document.createElement('div');
  hint.className = 'swipe-hint';
  hint.setAttribute('aria-hidden', 'true');
  bar.appendChild(hint);
  let st = null, lastLeft = 0, suppressClick = false;
  const showHint = (kind, k) => {
    const map = { next: ['next', 'Nächster Song'], restart: ['restart', 'Von vorne'], prev: ['prev', 'Vorheriger Song'] };
    const [ic, txt] = map[kind];
    if (hint.dataset.kind !== kind) { hint.dataset.kind = kind; hint.innerHTML = `${icon(ic)}<span>${txt}</span>`; }
    hint.style.setProperty('--k', String(k));
    hint.classList.toggle('left', kind !== 'next');
  };
  bar.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !isMobile() || overlays.includes('np')) return;
    if (e.target.closest('.pb-center button, .pb-fav, .pb-right')) return; // Knöpfe bleiben Knöpfe
    st = { x: e.clientX, y: e.clientY, id: e.pointerId, swiping: false, dx: 0 };
  }, { passive: true });
  bar.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.id) return;
    const dx = e.clientX - st.x, dy = e.clientY - st.y;
    if (!st.swiping) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { st = null; return; } // senkrecht: kein Wischen
      if (Math.abs(dx) < 12) return;
      st.swiping = true;
      bar.classList.add('swiping');
      try { bar.setPointerCapture(e.pointerId); } catch { /* */ }
    }
    st.dx = dx;
    const k = Math.min(1, Math.abs(dx) / 90);
    area.style.transform = `translateX(${dx * (1 - k * 0.35)}px)`;
    area.style.opacity = String(1 - k * 0.45);
    const kind = dx > 0 ? 'next' : (Date.now() - lastLeft < 1500 ? 'prev' : 'restart');
    showHint(kind, k);
  });
  const end = () => {
    if (!st) return;
    const { swiping, dx } = st;
    st = null;
    bar.classList.remove('swiping');
    area.style.transition = 'transform .28s var(--ease-out), opacity .28s';
    area.style.transform = '';
    area.style.opacity = '';
    hint.style.setProperty('--k', '0');
    setTimeout(() => { area.style.transition = ''; }, 300);
    if (!swiping) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 350);
    if (Math.abs(dx) < 64 || !curId) return;
    navigator.vibrate?.(12);
    if (dx > 0) { next(); flashHint('next'); return; }
    const now = Date.now();
    if (now - lastLeft < 1500) { lastLeft = 0; prevTrack(); flashHint('prev'); }
    else { lastLeft = now; if (deferred) togglePlay(); else audio.currentTime = 0; updateProgress(); updatePosState(); flashHint('restart'); }
  };
  const flashHint = (kind) => { showHint(kind, 1); hint.classList.add('flash'); setTimeout(() => { hint.classList.remove('flash'); hint.style.setProperty('--k', '0'); }, 650); };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  // Ein Wischen ist kein Antippen (öffnet nicht den Vollbild-Player)
  bar.addEventListener('click', (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
}

/* =========================================================
   Downloads: Songs und Cover offline auf dem Gerät
   ========================================================= */
let dlIds = new Set();
const isDl = (id) => dlIds.has(id);
const canDownload = (t) => !!t && (t.remote === 'server' || t.remote === 'cloud');
let dlQueue = Promise.resolve();
async function downloadTracks(ids, label = '') {
  const todo = ids.map(getT).filter((t) => canDownload(t) && !isDl(t.id));
  if (!todo.length) { toast(ids.length ? 'Schon heruntergeladen' : 'Nichts zum Herunterladen'); return; }
  try { await navigator.storage?.persist?.(); } catch { /* */ }
  const pt = progressToast();
  let done = 0, failed = 0;
  dlQueue = dlQueue.then(async () => {
    for (const t of todo) {
      pt.text(`Lade herunter${label ? ` (${label})` : ''}: ${done + 1} von ${todo.length}`, done / todo.length);
      try {
        const res = await fetch(t.remote === 'server' ? withKey(encPath(t.streamUrl)) : cloudSrc(t.streamUrl));
        if (!res.ok) throw new Error();
        const blob = await res.blob();
        await db.put('audio', { id: t.id, blob });
        if (t.coverId) await coverUrl(t.coverId); // Cover gleich mit speichern
        dlIds.add(t.id);
        t.dl = true;
        if (S.tracks.has(t.id)) await db.put('tracks', t);
        done++;
      } catch { failed++; }
    }
    pt.close(); toast(failed ? `${done} geladen, ${failed} fehlgeschlagen` : `${plural(done, 'Song', 'Songs')} offline verfügbar`);
    markDownloads();
  });
  return dlQueue;
}
async function removeDownloads(ids) {
  for (const id of ids) { if (!isDl(id)) continue; await db.del('audio', id).catch(() => {}); dlIds.delete(id); const t = getT(id); if (t) { t.dl = false; if (S.tracks.has(id)) db.put('tracks', t); } }
  markDownloads();
}
function markDownloads(root = document) {
  root.querySelectorAll('.row[data-id]').forEach((r) => r.classList.toggle('is-dl', isDl(r.dataset.id)));
  if (parseRoute().name === 'downloads' || parseRoute().name === 'settings') render(true);
}
views.downloads = () => {
  S.lastLib = 'downloads';
  const ids = [...S.tracks.values()].filter((t) => isDl(t.id)).sort((a, b) => coll.compare(a.artist, b.artist) || coll.compare(a.title, b.title)).map((t) => t.id);
  const size = ids.length;
  const k = regList(ids, { source: 'Downloads' });
  const favs = [...S.tracks.values()].filter((t) => t.fav && canDownload(t) && !isDl(t.id)).length;
  return libTabs('downloads') + pageHead('Downloads', size ? `${plural(size, 'Song', 'Songs')} offline auf diesem Gerät` : 'Songs zum Offline-Hören')
    + `<div class="actions-bar">${size ? playButtons(k) : ''}<span style="flex:1"></span>${favs ? `<button class="btn btn-sm" data-action="dl-favs">${icon('download')}Favoriten laden (${favs})</button>` : ''}</div>`
    + (size ? listEl(k) : `<div class="empty-small">Noch nichts heruntergeladen.<br>Im ⋯-Menü eines Songs auf „Herunterladen“ tippen oder oben alle Favoriten laden.</div>`);
};

/* ---------- Schneller Songwechsel: nächsten Song im Voraus in den Speicher holen ---------- */
const memPre = { id: null, url: null, ctrl: null };
function dropMemPre() { memPre.ctrl?.abort(); if (memPre.url) URL.revokeObjectURL(memPre.url); memPre.id = memPre.url = memPre.ctrl = null; }
async function prefetchNext() {
  const i = upcomingIndex();
  const id = i >= 0 ? S.queue[i] : null;
  const t = getT(id);
  if (!t || memPre.id === id || isDl(id) || !canDownload(t) || navigator.connection?.saveData) return;
  dropMemPre();
  memPre.id = id;
  memPre.ctrl = new AbortController();
  try {
    const res = await fetch(t.remote === 'server' ? withKey(encPath(t.streamUrl)) : cloudSrc(t.streamUrl), { signal: memPre.ctrl.signal });
    if (!res.ok || memPre.id !== id) return;
    const blob = await res.blob();
    if (memPre.id !== id) return;
    memPre.url = URL.createObjectURL(blob);
  } catch { if (memPre.id === id) memPre.id = null; }
}

/* =========================================================
   Ausgabegerät: AirPlay/Bluetooth (iPhone, Mac) bzw. Lautsprecher am PC
   ========================================================= */
const canAirPlay = () => typeof audio.webkitShowPlaybackTargetPicker === 'function';
const canSink = () => typeof HTMLMediaElement.prototype.setSinkId === 'function';
async function pickOutput() {
  if (canAirPlay()) {
    // Mit Equalizer läuft der Ton durch Web Audio, das kann iOS nicht an AirPlay/Bluetooth-Boxen schicken
    if (eq.on && isEqEl(audio)) { setEqOn(false); toast('Equalizer ist für AirPlay ausgeschaltet. Tippe nochmal auf das Gerät-Symbol.', 4000); return; }
    if (!curId) { toast('Starte zuerst einen Song, dann das Gerät wählen.'); return; }
    if (deferred || audio.paused) togglePlay();
    try { audio.webkitShowPlaybackTargetPicker(); } catch { /* */ }
    return;
  }
  if (navigator.mediaDevices?.selectAudioOutput) {
    try { const d = await navigator.mediaDevices.selectAudioOutput(); await setOutput(d.deviceId, d.label); } catch { /* abgebrochen */ }
    return;
  }
  if (!canSink() || !navigator.mediaDevices?.enumerateDevices) {
    toast('Hier wählst du das Gerät in den Bluetooth-Einstellungen des Handys bzw. im Kontrollzentrum.', 4500);
    return;
  }
  let outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
  if (outs.length && !outs.some((d) => d.label)) {
    // Namen zeigt der Browser erst nach einer einmaligen Erlaubnis
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((x) => x.stop()); outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput'); } catch { /* */ }
  }
  const cur = ls.get('klang-sink', 'default');
  openMenu([{ header: '<div><b>Wiedergabe auf</b><span>Bluetooth-Geräte (AirPods, Echo, Boxen) vorher mit dem PC koppeln</span></div>' },
    ...outs.map((d) => ({ label: d.label || (d.deviceId === 'default' ? 'Standard' : 'Gerät'), icon: 'volume', checked: d.deviceId === cur, fn: () => setOutput(d.deviceId, d.label) }))], $('[data-action="output"]'));
}
async function setOutput(id, label) {
  try { for (const el of allEls) await el.setSinkId(id); ls.set('klang-sink', id); toast(`Wiedergabe auf: ${label || 'Standard'}`, 2200); } catch { toast('Dieses Gerät lässt sich gerade nicht wählen.'); }
}
async function restoreOutput() {
  const id = ls.get('klang-sink', null);
  if (id && id !== 'default' && canSink()) { try { for (const el of allEls) await el.setSinkId(id); } catch { /* Gerät nicht da */ } }
}

/* ---------- Startlogo ---------- */
function hideSplash() {
  const sp = $('#splash');
  if (!sp) return;
  sp.classList.add('out');
  setTimeout(() => sp.remove(), 600);
}


/* ---------- Offline erkennen und beim Zurückkommen von selbst weitermachen ---------- */
let netRetry = null; // Song, der wegen fehlendem Netz hängen blieb
function setNetBanner() {
  const b = $('#net-banner');
  if (!b) return;
  const off = !navigator.onLine;
  document.body.classList.toggle('is-offline', off);
  b.hidden = !off;
  if (off) b.innerHTML = `<i class="dot"></i><span>Offline · ${dlIds.size ? 'Downloads laufen weiter' : 'Kein Internet'}</span>`;
}
async function backOnline() {
  setNetBanner();
  toast('Wieder online', 1600);
  apiCache.clear();
  // Bibliothek, Cover, Songtexte und Status von selbst nachholen, ohne Neuladen
  await loadServerLibrary(false);
  if (!S.srvOK && cloudCfg()) await loadCloudLibrary(false);
  $$('.cover[data-cover]:not(.has-img)').forEach((el) => loadCover(el));
  const r = parseRoute().name;
  if (['home', 'discover', 'radio', 'oartist', 'search'].includes(r)) refresh();
  if (netRetry && netRetry.id === curId) { const { pos, play } = netRetry; netRetry = null; reloadOnly = true; loadAndPlay(play, pos); }
  if (lyricsOpen) renderLyrics(true);
  sendPresence();
  lyr.prefetch([...S.tracks.values()].filter((t) => !t.live && !isOnline(t)));
}
function setupNetwork() {
  addEventListener('offline', setNetBanner);
  addEventListener('online', () => { backOnline(); });
  setNetBanner();
}
// iPhone-Startbildschirm-App: iOS gibt der App dort manchmal ein kürzeres Fenster als den Bildschirm.
// Dann liegt der Rest schon über dem Home-Strich, und die untere Leiste braucht keinen Extra-Abstand.
function fitStandalone() {
  const ios = /iphone|ipod|ipad/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /mac/i.test(navigator.platform || ''));
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const portrait = matchMedia('(orientation: portrait)').matches;
  const full = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
  document.documentElement.classList.toggle('ios-short', ios && standalone && innerHeight < full - 20);
}
fitStandalone();
addEventListener('resize', fitStandalone);
addEventListener('orientationchange', () => setTimeout(fitStandalone, 300));
addEventListener('pageshow', fitStandalone);

async function init() {
  hydrateIcons(document);
  applyTheme();
  setMotion(ls.get('klang-motion', 'full'));
  cacheNpEls();
  applyLiveCover();
  updateEqButtons();
  updateVolumeUI();
  updateModeButtons();
  updatePlayState();
  try {
    const [tracks, playlists, ckeys] = await Promise.all([db.getAll('tracks'), db.getAll('playlists'), db.getAllKeys('covers')]);
    tracks.forEach((t) => { S.tracks.set(t.id, t); regAlts(t.coverId, t.coverAlts); });
    S.playlists = playlists;
    coverKeys = new Set(ckeys);
    await lyr.loadAll();
    const akeys = await db.getAllKeys('audio');
    dlIds = new Set(akeys.filter((k) => { const t = S.tracks.get(k); return t && t.remote; }));
  } catch (e) {
    console.error(e);
    toast('Die Bibliothek konnte nicht geladen werden. Ist der private Modus aktiv?', 6000);
  }
  setupMotion();
  setupEvents();
  setupWallHover();
  setupMediaSession();
  setupQueueDrag();
  setupMiniSwipe();
  setupNetwork();
  restoreOutput();
  renderSidebarPlaylists();
  updateProfileUI();
  render();
  setTimeout(hideSplash, 450);
  if (!auth.current()) showAuth('login');
  restorePlayer();
  setupLaunchQueue();
  registerSW();
  // Musik-Ordner automatisch laden; ohne PC-Server (z. B. unterwegs am Handy) den Cloud-Speicher
  loadServerLibrary(false).then(async () => {
    if (!S.srvOK && cloudCfg()) await loadCloudLibrary(false);
    // Songtexte im Hintergrund holen, damit sie überall und offline da sind
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 4000));
    idle(() => lyr.prefetch([...S.tracks.values()].filter((t) => !t.live && !isOnline(t))), { timeout: 8000 });
  });
}

init();
