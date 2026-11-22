import * as db from './db.js';
import { readTags } from './tags.js';
import { icon, hydrateIcons } from './icons.js';
import { audius, radio } from './online.js';
import * as auth from './auth.js';

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
  discGenre: 'all',
  discTime: 'week',
  radioCat: 'top',
};

/* ---------- Online-Titel (Audius / Radio) ---------- */
// Nicht gespeicherte Online-Titel leben nur hier. Gespeicherte (Favorit/Playlist) stehen zusätzlich in S.tracks.
const remote = new Map();
const getT = (id) => S.tracks.get(id) || remote.get(id);
// Online = Audius/Radio. Songs aus dem lokalen Musik-Ordner (remote: 'server') zählen als eigene Musik.
const isOnline = (t) => !!t?.remote && t.remote !== 'server';
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

function getArtists() {
  if (_artists) return _artists;
  const m = new Map();
  for (const t of S.tracks.values()) {
    const k = t.artist.toLowerCase();
    let a = m.get(k);
    if (!a) { a = { key: k, name: t.artist, tracks: [], albums: new Set(), coverId: null }; m.set(k, a); }
    a.tracks.push(t);
    a.albums.add(albumKeyOf(t));
    if (!a.coverId && t.coverId) a.coverId = t.coverId;
  }
  _artists = m;
  return m;
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
    coverUrls.set(id, db.get('covers', id).then((r) => (r ? URL.createObjectURL(r.blob) : null)).catch(() => null));
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
}
window.addEventListener('popstate', () => {
  const top = overlays.pop();
  if (top) setOverlayClass(top, false);
});

/* =========================================================
   Player
   ========================================================= */
const audio = new Audio();
audio.preload = 'auto';
let audioUrl = null;
let curId = null;
let loadToken = 0;
let wantPlay = false;
let errorStreak = 0;
let seeking = false;
let lastSave = 0;

let deferred = null; // Online-Titel nach Neustart erst beim Antippen laden

async function loadAndPlay(autoplay = true, startAt = 0) {
  const id = S.queue[S.index];
  const t = getT(id);
  if (!t) return;
  const token = ++loadToken;
  wantPlay = autoplay;
  deferred = null;
  let src;
  if (t.remote) {
    if (t.live) startAt = 0;
    if (!autoplay) {
      // Nicht schon beim App-Start Daten aus dem Netz laden
      curId = id;
      deferred = { startAt };
      audio.pause();
      audio.removeAttribute('src');
      updatePlayerUI(); updateMediaSession(); markPlaying(); updatePlayState(); updateProgress();
      return;
    }
    if (t.remote !== 'server' && !navigator.onLine) toast('Keine Internetverbindung – Online-Titel brauchen Internet.', 3500);
    src = t.streamUrl;
  } else {
    let rec = null;
    try { rec = await db.get('audio', id); } catch { /* */ }
    if (token !== loadToken) return;
    if (!rec) { toast('Audiodatei nicht gefunden.'); return; }
    src = URL.createObjectURL(rec.blob);
  }
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = t.remote ? null : src;
  curId = id;
  audio.src = src;
  if (startAt > 0) audio.addEventListener('loadedmetadata', () => { audio.currentTime = Math.min(startAt, (audio.duration || startAt + 1) - 0.5); }, { once: true });
  if (autoplay) {
    audio.play().catch((e) => { if (e.name === 'NotAllowedError') updatePlayState(); });
    t.playCount = (t.playCount || 0) + 1;
    t.lastPlayed = Date.now();
    if (S.tracks.has(id)) { db.put('tracks', t); _albums = null; }
  }
  updatePlayerUI();
  updateMediaSession();
  markPlaying();
  saveState();
  if (overlays.includes('queue')) renderQueue();
}

function togglePlay() {
  if (!S.queue.length) {
    if (S.tracks.size) playIds(sortedTrackIds('title'), 0, { source: 'Alle Titel', shuffle: true });
    return;
  }
  if (!curId) { loadAndPlay(true, 0); return; }
  if (deferred) { const d = deferred; deferred = null; loadAndPlay(true, d.startAt); return; }
  if (audio.paused) { wantPlay = true; audio.play().catch(() => {}); } else audio.pause();
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
    S.queue = [f, ...shuffleArr(rest)];
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

function toggleShuffle() {
  S.shuffle = !S.shuffle;
  const cur = S.queue[S.index];
  if (S.queue.length) {
    if (S.shuffle) {
      S.original = S.queue.slice();
      const rest = S.queue.slice();
      rest.splice(S.index, 1);
      S.queue = cur ? [cur, ...shuffleArr(rest)] : shuffleArr(rest);
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
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
  S.queue = []; S.original = []; S.index = -1;
  updatePlayerUI();
  markPlaying();
  saveState();
}

function saveState() {
  ls.set('klang-player', {
    queue: S.queue, original: S.original, index: S.index,
    time: curId ? audio.currentTime || 0 : 0,
    shuffle: S.shuffle, repeat: S.repeat, source: S.source,
    volume: audio.volume, muted: audio.muted,
    remote: [...new Set(S.queue)].filter((id) => !S.tracks.has(id) && remote.has(id)).slice(0, 400).map((id) => remote.get(id)),
  });
}
function restorePlayer() {
  const st = ls.get('klang-player', null);
  if (!st) return;
  audio.volume = Number.isFinite(st.volume) ? st.volume : 1;
  audio.muted = !!st.muted;
  S.shuffle = !!st.shuffle;
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

// ---- Audio-Events ----
audio.addEventListener('play', updatePlayState);
audio.addEventListener('pause', () => { updatePlayState(); saveState(); });
audio.addEventListener('playing', () => { errorStreak = 0; });
audio.addEventListener('timeupdate', () => {
  updateProgress();
  if (Date.now() - lastSave > 4000) { lastSave = Date.now(); saveState(); }
});
audio.addEventListener('loadedmetadata', () => {
  const t = getT(curId);
  if (t && !t.live && Number.isFinite(audio.duration) && Math.abs((t.duration || 0) - audio.duration) > 1) {
    t.duration = audio.duration;
    if (S.tracks.has(t.id)) db.put('tracks', t);
  }
  updateProgress();
  updatePosState();
});
audio.addEventListener('ended', () => {
  if (S.sleep?.mode === 'end') { clearSleep(); toast('Sleep-Timer: Wiedergabe beendet'); return; }
  next(true);
});
audio.addEventListener('error', () => {
  if (!curId || !audio.getAttribute('src')) return;
  const t = getT(curId);
  toast(t?.remote
    ? `„${t.title}“ konnte nicht geladen werden${navigator.onLine ? '' : ' (keine Internetverbindung)'}.`
    : `„${t?.title || 'Titel'}“ kann in diesem Browser nicht abgespielt werden.`, 4000);
  if (wantPlay && ++errorStreak < 3 && S.index < S.queue.length - 1) setTimeout(() => next(true), 800);
});
audio.addEventListener('volumechange', () => { updateVolumeUI(); });

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
  h('seekbackward', (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); updatePosState(); });
  h('seekforward', (d) => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10)); updatePosState(); });
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
      ? [{ src: art, sizes: t.remote ? '480x480' : '600x600', ...(t.remote ? {} : { type: 'image/jpeg' }) }]
      : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
}
function updatePosState() {
  try {
    if ('mediaSession' in navigator && Number.isFinite(audio.duration) && audio.duration > 0) {
      navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate || 1 });
    }
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
  if (!t) { document.title = 'Klang'; closeAllOverlays(); return; }
  npEls.title.forEach((e) => { e.textContent = t.title; e.title = t.title; });
  npEls['artist-link'].forEach((e) => {
    e.textContent = t.live ? `Live-Radio · ${t.artist}` : t.artist;
    e.href = t.live ? '#/radio' : t.artistId ? `#/oartist/${encodeURIComponent(t.artistId)}` : `#/artist/${encodeURIComponent(t.artist)}`;
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
  npEls.shuffle.forEach((e) => e.classList.toggle('on', S.shuffle));
  npEls.repeat.forEach((e) => { e.classList.toggle('on', S.repeat !== 'off'); e.innerHTML = icon(S.repeat === 'one' ? 'repeat1' : 'repeat'); });
}
function updateVolumeUI() {
  const v = audio.muted ? 0 : audio.volume;
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
  const v0 = audio.volume;
  let i = 0;
  const iv = setInterval(() => {
    i++;
    audio.volume = Math.max(0, v0 * (1 - i / 30));
    if (i >= 30) { clearInterval(iv); audio.pause(); audio.volume = v0; clearSleep(); }
  }, 200);
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
  lyricsParsed = t && !t.live ? parseLyrics(t.lyrics) : null;
  if (!t) { box.innerHTML = ''; return; }
  if (t.live) { box.innerHTML = '<div class="ly-empty"><p>Beim Live-Radio gibt es keine Songtexte.</p></div>'; return; }
  if (!lyricsParsed) {
    box.innerHTML = `<div class="ly-empty">
      <p class="ly-empty-title">Kein Songtext gespeichert</p>
      <p>Klang zeigt Songtexte aus deinen Dateien oder aus einer .lrc-Datei mit dem gleichen Namen wie der Song. Mit Zeitstempeln wie [01:23.45] laufen sie live mit.</p>
      <div class="btns"><button class="btn btn-accent" data-action="lyrics-edit">${icon('edit')}Songtext einfügen</button><button class="btn" data-action="lyrics-file">${icon('upload')}.lrc-Datei laden</button></div>
    </div>`;
    return;
  }
  const { synced, lines } = lyricsParsed;
  box.innerHTML = `<div class="ly-lines ${synced ? 'synced' : ''}">${lines.map((l, i) => l.text
    ? `<p class="ly-line" data-i="${i}" ${synced ? `role="button" tabindex="0" data-t="${l.t}"` : ''}>${esc(l.text)}</p>`
    : `<p class="ly-gap" data-i="${i}" aria-hidden="true">${synced ? '♪' : ''}</p>`).join('')}</div>
    <div class="ly-foot">${synced ? '' : '<span>Nicht synchronisiert · </span>'}<button class="link-sm" data-action="lyrics-edit">Bearbeiten</button></div>`;
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
    body: `<label class="field"><span>Text oder LRC mit Zeitstempeln, z. B. [00:12.50] Erste Zeile</span><textarea name="text" rows="12" spellcheck="false" placeholder="[00:12.50] …">${esc(t.lyrics || '')}</textarea></label>`,
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
    ${coverHTML(t.coverId, t.album + t.artist, `row-cover ${t.live ? 'station-art' : ''}`, t.live ? 'radio' : 'music')}
    <div class="row-main"><div class="row-title">${eqHTML()}<span class="t">${esc(t.title)}</span></div><div class="row-sub">${esc(t.artist)}</div></div>
    ${current ? '<span></span>' : `<button class="icon-btn row-more" data-action="q-remove" aria-label="Entfernen">${icon('x')}</button>`}
  </div>`;
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

let importing = false;
async function importItems(items) {
  if (importing) { toast('Import läuft bereits …'); return []; }
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
    if (id && !used.has(id)) {
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
    { label: 'Zu Playlist hinzufügen', icon: 'playlist', fn: () => pickPlaylist([id]) },
    { label: t.fav ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen', icon: t.fav ? 'heart-fill' : 'heart', fn: () => setFav(id, !t.fav) },
    { sep: true },
  ];
  if (isOnline(t)) {
    if (t.artistId) items.push({ label: 'Zum Künstler', icon: 'user', fn: () => go('oartist', t.artistId) });
    if (t.permalink) items.push({ label: 'Auf Audius öffnen', icon: 'external', fn: () => window.open(t.permalink, '_blank', 'noopener') });
  } else {
    items.push({ label: 'Zum Album', icon: 'disc', fn: () => go('album', albumKeyOf(t)) },
      { label: 'Zum Künstler', icon: 'user', fn: () => go('artist', t.artist) });
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
  if (ctx.np) items.push({ label: 'Farbe & Live-Cover', icon: 'palette', fn: () => colorMenu(anchor) });
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
    <div class="row-main"><div class="row-title">${o.numbers ? '' : eqHTML()}<span class="t">${esc(t.title)}</span></div><div class="row-sub">${esc(t.artist)}</div></div>
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
    <button class="icon-btn lg" data-action="shuffle-list" data-list="${k}" title="Zufällig abspielen" aria-label="Zufällig abspielen">${icon('shuffle')}</button>`;
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
    info: { title: a.name, meta: `${esc(a.artist)}${a.year ? ' · ' + esc(a.year) : ''}`, line: `Album · ${plural(a.tracks.length, 'Titel', 'Titel')} · ${fmtLong(dur)}`, cta: 'Album öffnen' },
  });
}
function artistCard(a) {
  return `<a class="card center" href="#/artist/${encodeURIComponent(a.name)}">
    <div class="card-frame"><div class="card-art">${coverHTML(a.coverId, a.name, 'round')}<button class="card-play" data-action="play-artist" data-name="${esc(a.name)}" aria-label="${esc(a.name)} abspielen">${icon('play')}</button></div></div>
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
  return `<div class="chips m-only">${[['songs', 'Titel'], ['albums', 'Alben'], ['artists', 'Künstler'], ['favorites', 'Favoriten']]
    .map(([k, l]) => `<a class="chip ${k === active ? 'on' : ''}" href="#/${k}">${l}</a>`).join('')}</div>`;
}
function discTabs(active) {
  return `<div class="chips m-only">${[['discover', 'Musik'], ['radio', 'Radio']]
    .map(([k, l]) => `<a class="chip ${k === active ? 'on' : ''}" href="#/${k}">${l}</a>`).join('')}</div>`;
}
const settingsBtn = () => `${auth.current() ? `<a class="m-only profile-btn" href="#/profil" aria-label="Mein Profil">${avatarHTML(auth.current(), 'sm')}</a>` : ''}<button class="icon-btn lg m-only" data-action="color-menu" aria-label="Farbe und Live-Cover">${icon('palette')}</button><a class="icon-btn lg m-only" href="#/settings" aria-label="Einstellungen">${icon('settings')}</a>`;

function emptyLib() {
  const folder = finePointer() && 'webkitdirectory' in document.createElement('input');
  return `<div class="empty">
    <h2>Deine Bibliothek ist noch leer</h2>
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

  let html = feature + `<div class="tiles">${tiles}</div>`;
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
  return libTabs('songs') + pageHead('Titel', `${plural(ids.length, 'Titel', 'Titel')} · ${fmtLong(total)}`, `<button class="btn" data-action="import-files">${icon('plus')}Hinzufügen</button>`)
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
      <p>Album · <a class="link" href="#/artist/${encodeURIComponent(a.artist)}">${esc(a.artist)}</a>${a.year ? ' · ' + esc(a.year) : ''} · ${plural(ids.length, 'Titel', 'Titel')} · ${fmtLong(dur)}</p></div>
    </div>
    <div class="actions-bar">${playButtons(k)}<button class="icon-btn lg" data-action="album-menu" data-key="${esc(a.key)}" aria-label="Mehr">${icon('more')}</button></div>
    ${listEl(k)}`;
};

views.artists = () => {
  S.lastLib = 'artists';
  if (!S.tracks.size) return libTabs('artists') + pageHead('Künstler') + emptyLib();
  const arr = [...getArtists().values()].sort((a, b) => coll.compare(a.name, b.name));
  return libTabs('artists') + pageHead('Künstler', plural(arr.length, 'Künstler', 'Künstler')) + `<div class="grid">${arr.map(artistCard).join('')}</div>`;
};

views.artist = (name) => {
  const n = (name || '').toLowerCase();
  const tracks = [...S.tracks.values()].filter((t) => t.artist.toLowerCase() === n || (t.albumArtist || '').toLowerCase() === n);
  if (!tracks.length) return notFound();
  const displayName = tracks.find((t) => t.artist.toLowerCase() === n)?.artist || tracks[0].albumArtist || name;
  const albums = [...getAlbums().values()].filter((a) => a.artist.toLowerCase() === n || a.tracks.some((t) => t.artist.toLowerCase() === n))
    .sort((a, b) => (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0) || coll.compare(a.name, b.name));
  const allIds = albums.flatMap((a) => a.tracks.filter((t) => tracks.includes(t)).map((t) => t.id));
  const popular = tracks.slice().sort((a, b) => (b.playCount || 0) - (a.playCount || 0) || coll.compare(a.title, b.title)).slice(0, 5).map((t) => t.id);
  const coverId = tracks.find((t) => t.coverId)?.coverId;
  const kAll = regList(allIds, { source: displayName });
  const kPop = regList(popular, { source: displayName, noHead: true });
  const dur = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  return `<div class="hero" style="--h:${hue(displayName)}" ${coverId ? `data-tint="${esc(coverId)}"` : ''}>
      ${coverHTML(coverId, displayName, 'hero-art round')}
      <div class="hero-info"><h1>${esc(displayName)}</h1>
      <p>Künstler · ${plural(albums.length, 'Album', 'Alben')} · ${plural(tracks.length, 'Titel', 'Titel')} · ${fmtLong(dur)}</p></div>
    </div>
    <div class="actions-bar">${playButtons(kAll)}</div>
    ${section('Beliebt', '', listEl(kPop, false))}
    ${section('Alben', '', `<div class="grid">${albums.map(albumCard).join('')}</div>`)}
    ${section('Alle Titel', '', listEl(kAll))}`;
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
  return head + `<div class="actions-bar">${playButtons(k)}</div>` + listEl(k);
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

views.search = () => `${pageHead('Suchen')}<div class="search-box">${icon('search')}<input id="search-input" type="search" placeholder="Songs, Künstler oder Radiosender" value="${esc(S.search)}" autocomplete="off" enterkeyhint="search"></div><div id="search-results"></div>`;
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
  const tracks = [...S.tracks.values()].filter((t) => match(searchStr(t)))
    .sort((a, b) => (norm(b.title).startsWith(q) - norm(a.title).startsWith(q)) || (b.playCount || 0) - (a.playCount || 0) || coll.compare(a.title, b.title));
  const albums = [...getAlbums().values()].filter((a) => match(norm(`${a.name} ${a.artist}`))).slice(0, 14);
  const artists = [...getArtists().values()].filter((a) => match(norm(a.name))).slice(0, 14);
  const hasLocal = tracks.length || albums.length || artists.length;
  let html = '';
  if (tracks.length) { const k = regList(tracks.slice(0, 100).map((t) => t.id), { source: `Suche: ${raw}` }); html += section(`In deiner Bibliothek <span class="muted" style="font-weight:500;font-size:15px">${tracks.length}</span>`, '', listEl(k)); }
  if (artists.length) html += section('Deine Künstler', '', `<div class="shelf">${artists.map(artistCard).join('')}</div>`);
  if (albums.length) html += section('Deine Alben', '', `<div class="shelf">${albums.map(albumCard).join('')}</div>`);
  html += `<div id="search-online">${raw.length >= 2 ? loadingHTML('Suche online …') : ''}</div>`;
  box.innerHTML = html;
  mountLists(box);
  hydrateCovers(box);
  if (raw.length < 2) return;
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
  { name: 'Koralle', a: '#ff6b4a', b: '#e5397f', on: '#fff' },
  { name: 'Violett', a: '#8b7bff', b: '#5b3fe0', on: '#fff' },
  { name: 'Mint', a: '#2dd4a7', b: '#0ea5e9', on: '#06221b' },
  { name: 'Pink', a: '#f472b6', b: '#a855f7', on: '#fff' },
  { name: 'Blau', a: '#4f9dff', b: '#4f46e5', on: '#fff' },
  { name: 'Gold', a: '#e9b44c', b: '#c98a2b', on: '#17120a' },
  { name: 'Grün', a: '#4ade80', b: '#16a34a', on: '#052e12' },
];
function applyAccent(name) {
  const a = ACCENTS.find((x) => x.name === name) || ACCENTS.find((x) => x.name === 'Gold');
  const r = document.documentElement.style;
  r.setProperty('--accent', a.a);
  r.setProperty('--accent-2', a.b);
  r.setProperty('--on-accent', a.on);
}

views.settings = () => {
  const tracks = [...S.tracks.values()];
  const size = tracks.reduce((s, t) => s + (t.size || 0), 0);
  const accent = ls.get('klang-accent', 'Gold');
  const folder = finePointer() && 'webkitdirectory' in document.createElement('input');
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return pageHead('Einstellungen') + `<div class="settings">
    <div class="set-card">
      <h2>Bibliothek</h2>
      <p>${plural(tracks.length, 'Titel', 'Titel')} · ${plural(getAlbums().size, 'Album', 'Alben')} · ${plural(S.playlists.length, 'Playlist', 'Playlists')} · ${fmtBytes(size)}</p>
      <div class="btn-row">
        <button class="btn btn-accent" data-action="import-files">${icon('upload')}Dateien hinzufügen</button>
        ${folder ? `<button class="btn" data-action="import-folder">${icon('folder')}Ordner hinzufügen</button>` : ''}
      </div>
    </div>
    <div class="set-card">
      <h2>Speicher</h2>
      <p>Deine Musik liegt nur auf diesem Gerät, im Speicher des Browsers bzw. der App.</p>
      <div id="storage-info" class="muted" style="font-size:14px">Wird berechnet …</div>
    </div>
    <div class="set-card">
      <h2>Farbe &amp; Live-Cover</h2>
      <p>Die Farbe gilt für Play-Knöpfe, Fortschritt und den Score-Bug im Player.</p>
      <div class="swatches">${ACCENTS.map((a) => `<button class="swatch ${a.name === accent ? 'on' : ''}" data-action="accent" data-name="${a.name}" title="${a.name}" aria-label="${a.name}" style="background:${a.a}"></button>`).join('')}</div>
      <div class="set-row" style="margin-top:14px;border-top:1px solid var(--line)"><div class="lbl">Live-Cover<small>Bewegtes Cover-Bild hinter dem Vollbild-Player</small></div><button class="btn btn-sm" data-action="toggle-live">${liveCoverOn() ? 'An' : 'Aus'}</button></div>
    </div>
    <div class="set-card">
      <h2>App installieren</h2>
      ${standalone ? '<p>Klang läuft bereits als installierte App. 🎉</p>'
        : ios ? '<p>Tippe in Safari unten auf <b>Teilen</b> und dann auf <b>„Zum Home-Bildschirm“</b>. Danach startet Klang wie eine normale App, im Vollbild und offline.</p>'
          : `<p>Installiere Klang als eigene App mit Icon auf dem Startbildschirm bzw. im Startmenü. Danach funktioniert sie auch offline.</p>
             <button class="btn ${deferredInstall ? 'btn-accent' : 'hidden'}" data-action="install" data-install>${icon('download')}Jetzt installieren</button>
             ${deferredInstall ? '' : '<p class="muted" style="font-size:13px;margin:0">Falls kein Knopf erscheint: im Browser-Menü (⋮) auf <b>„App installieren“</b> bzw. <b>„Zum Startbildschirm hinzufügen“</b> tippen.</p>'}`}
    </div>
    ${finePointer() ? `<div class="set-card">
      <h2>Tastenkürzel</h2>
      <div class="kbd-list" style="margin-top:12px">
        <kbd>Leertaste</kbd><span>Abspielen / Pause</span>
        <kbd>← →</kbd><span>5 Sekunden zurück / vor</span>
        <kbd>Shift + ← →</kbd><span>Vorheriger / nächster Titel</span>
        <kbd>↑ ↓</kbd><span>Lautstärke</span>
        <kbd>M</kbd><span>Stumm</span>
        <kbd>S</kbd><span>Zufallswiedergabe</span>
        <kbd>R</kbd><span>Wiederholen</span>
        <kbd>L</kbd><span>Aktuellen Titel als Favorit</span>
        <kbd>Q</kbd><span>Warteschlange</span>
        <kbd>T</kbd><span>Songtext ein/aus</span>
        <kbd>Strg + K</kbd><span>Suchen</span>
      </div>
    </div>` : ''}
    <div class="set-card">
      <h2>Gefahrenzone</h2>
      <p>Entfernt alle Titel, Cover und Playlists von diesem Gerät. Deine Originaldateien bleiben unberührt.</p>
      <button class="btn btn-danger" data-action="wipe" ${tracks.length || S.playlists.length ? '' : 'disabled'}>${icon('trash')}Bibliothek komplett löschen</button>
    </div>
    <p class="muted" style="font-size:12.5px;text-align:center">Klang 1.0 · Deine Musik bleibt bei dir.</p>
  </div>`;
};
after.settings = async () => {
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
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
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
  if (stage) stage.innerHTML = `<div class="ft-slide"><div class="ft-body"><div class="ft-copy"><h1 class="ft-title">Klang</h1><p class="ft-meta">${esc(msg || (navigator.onLine ? 'Der Online-Katalog ist gerade nicht erreichbar.' : 'Offline: deine eigene Musik läuft trotzdem.'))}</p></div></div></div>`;
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
      <div class="auth-brand"><img src="icons/icon.svg" alt=""><span><b>KLANG</b><small>MUSIK</small></span></div>
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

views.profil = () => {
  const a = auth.current();
  if (!a) return notFound();
  const all = [...S.tracks.values()];
  const since = new Date(a.createdAt).toLocaleDateString('de', { month: 'long', year: 'numeric' });
  const genreOpts = GENRES.map(([k, l]) => `<option value="${k}" ${a.genre === k ? 'selected' : ''}>${k === 'all' ? 'Keins' : l}</option>`).join('');
  return `<div class="hero profile-hero" style="--h:${hue(a.display)}">
      <div class="avatar-wrap">${avatarHTML(a, 'xl')}<button class="avatar-edit" data-action="avatar-pick" aria-label="Profilbild ändern">${icon('image')}</button></div>
      <div class="hero-info">
        ${premiumBadge('lg')}
        <h1>${esc(a.display)}</h1>
        <p>${[`@${esc(a.name)}`, `Mitglied seit ${since}`, plural(all.length, 'Titel', 'Titel'), plural(S.playlists.length, 'Playlist', 'Playlists'), plural(all.filter((t) => t.fav).length, 'Favorit', 'Favoriten')].map((x) => `<span class="nowrap">${x}</span>`).join(' · ')}</p>
        ${a.bio ? `<p class="profile-bio">${esc(a.bio)}</p>` : ''}
      </div>
    </div>
    <div class="settings">
      <div class="set-card">
        <h2>Profil</h2>
        <form data-form="profile" novalidate>
          <label class="field"><span>Anzeigename</span><input name="display" value="${esc(a.display)}" maxlength="32" autocomplete="nickname"></label>
          <label class="field"><span>Status</span><input name="bio" value="${esc(a.bio || '')}" maxlength="90" placeholder="Was hörst du gerade am liebsten?"></label>
          <label class="field"><span>Lieblingsgenre (startet Entdecken damit)</span><select class="select wide-select" name="genre">${genreOpts}</select></label>
          <div class="btn-row"><button class="btn btn-accent" type="submit">${icon('check')}Speichern</button>
            <button class="btn" type="button" data-action="avatar-pick">${icon('image')}Profilbild ändern</button>
            ${a.avatar ? `<button class="btn" type="button" data-action="avatar-remove">${icon('x')}Bild entfernen</button>` : ''}</div>
        </form>
      </div>
      <div class="set-card">
        <h2>Passwort ändern</h2>
        <p>Für das Startkonto bitte ein eigenes Passwort setzen.</p>
        <form data-form="password" novalidate>
          <label class="field"><span>Aktuelles Passwort</span><input name="old" type="password" autocomplete="current-password"><em class="field-err" data-err="old"></em></label>
          <div class="field-grid">
            <label class="field"><span>Neues Passwort</span><input name="new" type="password" autocomplete="new-password"><em class="field-err" data-err="new"></em></label>
            <label class="field"><span>Wiederholen</span><input name="new2" type="password" autocomplete="new-password"><em class="field-err" data-err="new2"></em></label>
          </div>
          <button class="btn btn-accent" type="submit">${icon('check')}Passwort speichern</button>
        </form>
      </div>
      <div class="set-card">
        <h2>Abmelden</h2>
        <p>Deine Musik, Playlists und Favoriten bleiben auf dem Gerät. Beim nächsten Öffnen fragt Klang wieder nach Name und Passwort.</p>
        <button class="btn btn-danger" data-action="logout">${icon('logout')}Abmelden</button>
      </div>
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
  const lib = ['songs', 'albums', 'artists', 'favorites', 'album', 'artist'].includes(name);
  $$('[data-nav]').forEach((a) => {
    const n = a.dataset.nav;
    a.classList.toggle('active', n === key || (n === 'library' && lib) || (n === 'discover-m' && ['discover', 'radio', 'oartist'].includes(name)));
  });
  const libLink = $('#bottomnav [data-nav="library"]');
  if (libLink) libLink.href = `#/${S.lastLib}`;
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
  toggle: () => togglePlay(),
  next: () => next(),
  prev: () => prev(),
  shuffle: () => toggleShuffle(),
  repeat: () => cycleRepeat(),
  mute: () => { audio.muted = !audio.muted; saveState(); },
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
    else go('artist', t.artist);
  },
  'np-menu': (el) => { if (curId) trackMenu(curId, el, { np: true }); },
  'color-menu': (el) => colorMenu(el),
  'open-lyrics': () => { if (!curId) return; openOverlay('np'); setLyricsMode(true); },
  'toggle-lyrics': () => setLyricsMode(!lyricsOpen),
  'lyrics-edit': () => editLyrics(),
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
  'play-artist': (el) => {
    const a = getArtists().get(el.dataset.name.toLowerCase());
    if (a) playIds(a.tracks.slice().sort((x, y) => coll.compare(x.album, y.album) || (x.trackNo || 0) - (y.trackNo || 0)).map((t) => t.id), 0, { source: a.name });
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
  'toggle-live': (el) => { const on = !liveCoverOn(); ls.set('klang-live', on); applyLiveCover(); el.textContent = on ? 'An' : 'Aus'; },
  persist: async () => {
    const ok = await navigator.storage?.persist?.();
    toast(ok ? 'Dauerhafter Speicher aktiviert' : 'Der Browser hat abgelehnt. Installiere Klang als App, dann klappt es meist.', 4000);
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
      auth.update({ display, bio: (d.bio || '').trim(), genre: d.genre || 'all' });
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
    audio.volume = r.value / 100;
    audio.muted = r.value == 0;
    saveState();
  }));
  $('#player').addEventListener('wheel', (e) => {
    if (!e.target.closest('.pb-right')) return;
    e.preventDefault();
    audio.muted = false;
    audio.volume = Math.min(1, Math.max(0, audio.volume - Math.sign(e.deltaY) * 0.05));
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
    else if (k === 'ArrowUp') { audio.muted = false; audio.volume = Math.min(1, audio.volume + 0.05); }
    else if (k === 'ArrowDown') audio.volume = Math.max(0, audio.volume - 0.05);
    else if (k === 'm' || k === 'M') audio.muted = !audio.muted;
    else if (k === 's' || k === 'S') toggleShuffle();
    else if (k === 'r' || k === 'R') cycleRepeat();
    else if (k === 'l' || k === 'L') actions['fav-current']();
    else if (k === 'q' || k === 'Q') actions.queue();
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
  window.addEventListener('hashchange', () => { closeMenu(); withTransition('route', () => render()); });
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
  toast('Klang wurde installiert 🎉');
});

function registerSW() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service Worker:', e));
  }
}

function setupLaunchQueue() {
  // Am PC: Audiodateien per Doppelklick / "Öffnen mit" direkt in Klang öffnen
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
async function loadServerLibrary(showToast = false) {
  let list;
  try {
    const r = await fetch('/api/music', { cache: 'no-store' });
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error('kein Musik-Server');
    list = await r.json();
    if (!Array.isArray(list)) throw new Error('unerwartete Antwort');
  } catch {
    // Kein lokaler Klang-Server (z. B. auf der Online-Version): Knopf bleibt versteckt
    if (showToast) toast('Der Musik-Ordner geht nur mit dem Klang-Server auf deinem PC („Klang starten.bat“).', 4500);
    return;
  }
  $$('[data-server-lib]').forEach((b) => b.classList.remove('hidden'));

  if (!list.length) {
    if (showToast) toast('Im Musik-Ordner (Downloads\\music) liegen noch keine Songs.', 4000);
    return;
  }

  let added = 0;
  const fresh = [];
  for (const item of list) {
    const id = 'srv:' + item.url;
    if (S.tracks.has(id)) continue;
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
      fileName: item.file, size: 0,
      coverId: null,
      fav: false, favAt: 0, playCount: 0, lastPlayed: 0,
      addedAt: Date.now(),
    };
    S.tracks.set(id, track);
    fresh.push(track);
    added++;
  }
  if (fresh.length) { try { await db.putMany('tracks', fresh); } catch { /* */ } }

  if (added > 0) {
    invalidate();
    refresh();
    if (showToast) toast(`${plural(added, 'Titel', 'Titel')} aus Musik-Ordner geladen`, 3000);
  } else if (showToast) {
    toast(`Alles aktuell: ${plural(list.length, 'Song', 'Songs')} im Musik-Ordner`, 3000);
  }
}

async function init() {
  hydrateIcons(document);
  applyAccent(ls.get('klang-accent', 'Gold'));
  cacheNpEls();
  applyLiveCover();
  updateVolumeUI();
  updateModeButtons();
  updatePlayState();
  try {
    const [tracks, playlists, ckeys] = await Promise.all([db.getAll('tracks'), db.getAll('playlists'), db.getAllKeys('covers')]);
    tracks.forEach((t) => { S.tracks.set(t.id, t); regAlts(t.coverId, t.coverAlts); });
    S.playlists = playlists;
    coverKeys = new Set(ckeys);
  } catch (e) {
    console.error(e);
    toast('Die Bibliothek konnte nicht geladen werden. Ist der private Modus aktiv?', 6000);
  }
  setupMotion();
  setupEvents();
  setupWallHover();
  setupMediaSession();
  renderSidebarPlaylists();
  updateProfileUI();
  render();
  if (!auth.current()) showAuth('login');
  restorePlayer();
  setupLaunchQueue();
  registerSW();
  // Musik-Ordner automatisch laden
  loadServerLibrary(false);
}

init();
