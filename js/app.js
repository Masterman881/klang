import * as db from './db.js';
import { readTags } from './tags.js';
import { icon, hydrateIcons } from './icons.js';

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
};

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

function coverUrl(id) {
  if (!id) return Promise.resolve(null);
  if (!coverUrls.has(id)) {
    coverUrls.set(id, db.get('covers', id).then((r) => (r ? URL.createObjectURL(r.blob) : null)).catch(() => null));
  }
  return coverUrls.get(id);
}

function coverHTML(coverId, seed, cls = '') {
  return `<div class="cover ${cls}" ${coverId ? `data-cover="${esc(coverId)}"` : ''} style="--h:${hue(seed)}">${icon('music')}</div>`;
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
  if (u && el.dataset.cover === id) { el.style.backgroundImage = `url("${u}")`; el.classList.add('has-img'); }
}
function setCoverEl(el, coverId, seed) {
  el.classList.remove('has-img');
  el.style.backgroundImage = '';
  el.style.setProperty('--h', hue(seed));
  if (!el.querySelector('.ic')) el.innerHTML = icon('music');
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
    return `<button class="menu-item ${it.danger ? 'danger' : ''} ${it.checked ? 'checked' : ''}" data-mi="${i}" role="menuitem">${icon(it.icon || 'dot')}<span>${esc(it.label)}</span></button>`;
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
  if (name === 'np') $('#np').classList.toggle('open', on);
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

async function loadAndPlay(autoplay = true, startAt = 0) {
  const id = S.queue[S.index];
  if (!id) return;
  const token = ++loadToken;
  wantPlay = autoplay;
  let rec = null;
  try { rec = await db.get('audio', id); } catch { /* */ }
  if (token !== loadToken) return;
  if (!rec) { toast('Audiodatei nicht gefunden.'); return; }
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(rec.blob);
  curId = id;
  audio.src = audioUrl;
  if (startAt > 0) audio.addEventListener('loadedmetadata', () => { audio.currentTime = Math.min(startAt, (audio.duration || startAt + 1) - 0.5); }, { once: true });
  const t = S.tracks.get(id);
  if (autoplay) {
    audio.play().catch((e) => { if (e.name === 'NotAllowedError') updatePlayState(); });
    if (t) { t.playCount = (t.playCount || 0) + 1; t.lastPlayed = Date.now(); db.put('tracks', t); _albums = null; }
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
  rawIds.forEach((x, j) => { if (S.tracks.has(x)) { if (j === start) startAt = ids.length; ids.push(x); } });
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
  ids = ids.filter((id) => S.tracks.has(id));
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
  ids = ids.filter((id) => S.tracks.has(id));
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
  const cur = st.queue?.[st.index];
  S.queue = (st.queue || []).filter((id) => S.tracks.has(id));
  S.original = (st.original || []).filter((id) => S.tracks.has(id));
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
  const t = S.tracks.get(curId);
  if (t && Number.isFinite(audio.duration) && Math.abs((t.duration || 0) - audio.duration) > 1) {
    t.duration = audio.duration;
    db.put('tracks', t);
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
  const t = S.tracks.get(curId);
  toast(`„${t?.title || 'Titel'}“ kann in diesem Browser nicht abgespielt werden.`, 4000);
  if (wantPlay && ++errorStreak < 3 && S.index < S.queue.length - 1) setTimeout(() => next(true), 800);
});
audio.addEventListener('volumechange', () => { updateVolumeUI(); });

// ---- Media Session (Sperrbildschirm, Kopfhörertasten) ----
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* nicht unterstützt */ } };
  h('play', () => { wantPlay = true; audio.play().catch(() => {}); });
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
  if (artCache.has(coverId)) return artCache.get(coverId);
  const rec = await db.get('covers', coverId).catch(() => null);
  if (!rec) return null;
  const url = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = () => r(null); fr.readAsDataURL(rec.blob); });
  artCache.set(coverId, url);
  return url;
}
async function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const t = S.tracks.get(curId);
  if (!t) { navigator.mediaSession.metadata = null; return; }
  const id = curId;
  const art = await artworkDataUrl(t.coverId);
  if (id !== curId) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist, album: t.album,
    artwork: art
      ? [{ src: art, sizes: '600x600', type: 'image/jpeg' }]
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
function cacheNpEls() {
  for (const k of ['title', 'artist-link', 'cover', 'fav', 'play', 'shuffle', 'repeat', 'cur', 'dur', 'bar', 'source', 'sleep', 'sleep-label', 'vol-icon']) {
    npEls[k] = $$(`[data-np="${k}"]`);
  }
  npEls.seek = $$('[data-seek]');
  npEls.vol = $$('[data-vol]');
}

async function updatePlayerUI() {
  const t = S.tracks.get(curId);
  $('#player').classList.toggle('hidden', !t);
  document.body.classList.toggle('has-player', !!t);
  if (!t) { document.title = 'Klang'; closeAllOverlays(); return; }
  npEls.title.forEach((e) => { e.textContent = t.title; e.title = t.title; });
  npEls['artist-link'].forEach((e) => { e.textContent = t.artist; e.href = `#/artist/${encodeURIComponent(t.artist)}`; });
  npEls.cover.forEach((e) => setCoverEl(e, t.coverId, t.album + t.artist));
  npEls.source.forEach((e) => { e.textContent = S.source || 'Deiner Bibliothek'; });
  updateFavUI();
  document.title = `${t.title} · ${t.artist}`;
  const id = curId;
  const tint = await tintOf(t.coverId);
  if (id !== curId) return;
  const c = tint || `hsl(${hue(t.album + t.artist)} 35% 32%)`;
  $('#np').style.setProperty('--tint', c);
  $('#player').style.setProperty('--tint', c);
}
function updateFavUI() {
  const t = S.tracks.get(curId);
  npEls.fav.forEach((e) => {
    e.innerHTML = icon(t?.fav ? 'heart-fill' : 'heart');
    e.classList.toggle('fav-on', !!t?.fav);
    e.setAttribute('aria-label', t?.fav ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen');
  });
}
function updatePlayState() {
  const playing = !audio.paused && !!curId;
  document.body.classList.toggle('is-playing', playing);
  npEls.play.forEach((e) => { e.innerHTML = icon(playing ? 'pause' : 'play'); });
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = curId ? (playing ? 'playing' : 'paused') : 'none';
}
function updateProgress() {
  const d = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : S.tracks.get(curId)?.duration || 0;
  const c = audio.currentTime || 0;
  const p = d ? Math.min(1, c / d) : 0;
  if (!seeking) {
    npEls.seek.forEach((r) => { r.value = Math.round(p * 1000); r.style.setProperty('--p', p * 100 + '%'); });
    npEls.cur.forEach((e) => { e.textContent = fmt(c); });
  }
  npEls.dur.forEach((e) => { e.textContent = fmt(d); });
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
   Warteschlange
   ========================================================= */
function renderQueue() {
  const el = $('#queue-list');
  const cur = S.tracks.get(S.queue[S.index]);
  let html = '';
  if (cur) html += `<div class="q-label">Läuft gerade</div>${qRow(cur, S.index, true)}`;
  const upcoming = S.queue.slice(S.index + 1, S.index + 1 + 300);
  html += `<div class="q-label">Als Nächstes${S.source ? ` · ${esc(S.source)}` : ''}</div>`;
  html += upcoming.map((id, j) => { const t = S.tracks.get(id); return t ? qRow(t, S.index + 1 + j) : ''; }).join('');
  if (!upcoming.length) html += '<p class="muted pad">Keine weiteren Titel. Füge welche über das ⋯-Menü hinzu.</p>';
  const more = S.queue.length - (S.index + 1 + upcoming.length);
  if (more > 0) html += `<p class="muted pad">… und ${plural(more, 'weiterer Titel', 'weitere Titel')}</p>`;
  el.innerHTML = html;
  hydrateCovers(el);
}
function qRow(t, qi, current = false) {
  return `<div class="row q-row ${current ? 'playing current' : ''}" data-qi="${qi}" data-id="${t.id}">
    ${coverHTML(t.coverId, t.album + t.artist, 'row-cover')}
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
  if (!audioItems.length) { toast('Keine Audiodateien gefunden.'); return []; }
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
      const track = {
        id,
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
  const t = S.tracks.get(id);
  if (!t) return;
  t.fav = val;
  t.favAt = val ? Date.now() : 0;
  await db.put('tracks', t);
  $$(`.row[data-id="${id}"] .row-fav`).forEach((b) => { b.classList.toggle('on', val); b.innerHTML = icon(val ? 'heart-fill' : 'heart'); });
  if (id === curId) updateFavUI();
  if (parseRoute().name === 'favorites') refresh();
  toast(val ? 'Zu Favoriten hinzugefügt' : 'Aus Favoriten entfernt', 1600);
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
    covers.add(S.tracks.get(id).coverId);
    S.tracks.delete(id);
    await db.del('tracks', id);
    await db.del('audio', id);
  }
  for (const p of S.playlists) {
    const before = p.trackIds.length;
    p.trackIds = p.trackIds.filter((x) => !del.has(x));
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
  const body = `<div class="pick-list">
    <button class="pick" data-value="__new"><span class="pick-ic">${icon('plus')}</span><span>Neue Playlist</span></button>
    ${S.playlists.map((p) => `<button class="pick" data-value="${p.id}">${playlistCover(p, 'mini')}<span>${esc(p.name)}<small>${plural(p.trackIds.length, 'Titel', 'Titel')}</small></span></button>`).join('')}
  </div>`;
  const pr = openDialog({ title: 'Zu Playlist hinzufügen', body, buttons: [{ label: 'Abbrechen' }] });
  hydrateCovers($('#dialog-layer'));
  const r = await pr;
  if (!r) return;
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
  const t = S.tracks.get(id);
  if (!t) return;
  const items = [
    { header: `${coverHTML(t.coverId, t.album + t.artist)}<div><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></div>` },
    { label: 'Als Nächstes abspielen', icon: 'play-next', fn: () => playNext([id]) },
    { label: 'Zur Warteschlange hinzufügen', icon: 'list-plus', fn: () => addToQueue([id]) },
    { label: 'Zu Playlist hinzufügen', icon: 'playlist', fn: () => pickPlaylist([id]) },
    { label: t.fav ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen', icon: t.fav ? 'heart-fill' : 'heart', fn: () => setFav(id, !t.fav) },
    { sep: true },
    { label: 'Zum Album', icon: 'disc', fn: () => go('album', albumKeyOf(t)) },
    { label: 'Zum Künstler', icon: 'user', fn: () => go('artist', t.artist) },
  ];
  if (ctx.playlist) {
    const p = S.playlists.find((x) => x.id === ctx.playlist);
    if (p) {
      items.push({ sep: true });
      if (ctx.index > 0) items.push({ label: 'Nach oben verschieben', icon: 'arrow-up', fn: () => movePlaylistTrack(p.id, ctx.index, ctx.index - 1) });
      if (ctx.index < p.trackIds.length - 1) items.push({ label: 'Nach unten verschieben', icon: 'arrow-down', fn: () => movePlaylistTrack(p.id, ctx.index, ctx.index + 1) });
      items.push({ label: 'Aus dieser Playlist entfernen', icon: 'x', fn: () => removeFromPlaylist(p.id, ctx.index) });
    }
  }
  items.push({ sep: true },
    { label: 'Infos bearbeiten', icon: 'edit', fn: () => editTrack(id) },
    { label: 'Aus Bibliothek löschen', icon: 'trash', danger: true, fn: () => deleteTracks([id]) });
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
  const h = head && !o.noHead ? `<div class="list-head"><span>#</span><span>Titel</span>${o.numbers ? '' : '<span>Album</span>'}<span></span><span class="r">${icon('clock')}</span><span></span></div>` : '';
  return `<div class="tracklist ${o.numbers ? 'no-album' : ''}" data-list="${k}">${h}</div>`;
}
const eqHTML = () => '<span class="eq"><i></i><i></i><i></i></span>';

function rowHTML(t, i, key, o) {
  const lead = o.numbers
    ? `<div class="row-num"><span class="n">${t.trackNo || i + 1}</span>${eqHTML()}</div>`
    : coverHTML(t.coverId, t.album + t.artist, 'row-cover');
  return `<div class="row" data-id="${t.id}" data-list="${key}" data-i="${i}"${o.playlist && finePointer() ? ' draggable="true"' : ''}>
    ${lead}
    <div class="row-main"><div class="row-title">${o.numbers ? '' : eqHTML()}<span class="t">${esc(t.title)}</span></div><div class="row-sub">${esc(t.artist)}</div></div>
    <div class="row-album">${esc(t.album)}</div>
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
      for (let i = n; i < end; i++) { const t = S.tracks.get(L.ids[i]); if (t) html += rowHTML(t, i, key, L.opts); }
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

function albumCard(a) {
  return `<a class="card" href="#/album/${encodeURIComponent(a.key)}" data-album-key="${esc(a.key)}">
    <div class="card-art">${coverHTML(a.coverId, a.key)}<button class="card-play" data-action="play-album" data-key="${esc(a.key)}" aria-label="${esc(a.name)} abspielen">${icon('play')}</button></div>
    <div class="card-title">${esc(a.name)}</div>
    <div class="card-sub">${esc(a.artist)}${a.year ? ' · ' + esc(a.year) : ''}</div>
  </a>`;
}
function artistCard(a) {
  return `<a class="card center" href="#/artist/${encodeURIComponent(a.name)}">
    <div class="card-art">${coverHTML(a.coverId, a.name, 'round')}<button class="card-play" data-action="play-artist" data-name="${esc(a.name)}" aria-label="${esc(a.name)} abspielen">${icon('play')}</button></div>
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
  return `<a class="card" href="#/playlist/${p.id}">
    <div class="card-art">${playlistCover(p)}<button class="card-play" data-action="play-playlist" data-id="${p.id}" aria-label="${esc(p.name)} abspielen">${icon('play')}</button></div>
    <div class="card-title">${esc(p.name)}</div>
    <div class="card-sub">Playlist · ${plural(p.trackIds.length, 'Titel', 'Titel')}</div>
  </a>`;
}

function pageHead(title, sub = '', actions = '') {
  return `<header class="page-head"><div><h1>${title}</h1>${sub ? `<p class="muted">${sub}</p>` : ''}</div><div class="head-actions">${actions}</div></header>`;
}
function libTabs(active) {
  return `<div class="chips m-only">${[['songs', 'Titel'], ['albums', 'Alben'], ['artists', 'Künstler'], ['favorites', 'Favoriten']]
    .map(([k, l]) => `<a class="chip ${k === active ? 'on' : ''}" href="#/${k}">${l}</a>`).join('')}</div>`;
}
const settingsBtn = () => `<a class="icon-btn lg m-only" href="#/settings" aria-label="Einstellungen">${icon('settings')}</a>`;

function emptyLib() {
  const folder = finePointer() && 'webkitdirectory' in document.createElement('input');
  return `<div class="empty">
    <div class="big-ic">${icon('music')}</div>
    <h2>Deine Musik, dein Player</h2>
    <p>Füge deine eigenen Musikdateien hinzu (MP3, M4A, FLAC, OGG, WAV …). Sie werden nur auf diesem Gerät gespeichert. Kein Abo, keine Werbung, und es läuft auch offline.</p>
    <div class="btns">
      <button class="btn btn-accent" data-action="import-files">${icon('upload')}Dateien auswählen</button>
      ${folder ? `<button class="btn" data-action="import-folder">${icon('folder')}Ordner auswählen</button>` : ''}
    </div>
    ${finePointer() ? '<p class="hint">Du kannst Dateien und Ordner auch einfach ins Fenster ziehen.</p>' : ''}
    <div class="feature-list">
      <div><b>Playlists & Favoriten</b>Eigene Listen anlegen und sortieren</div>
      <div><b>Cover & Tags</b>Werden automatisch aus den Dateien gelesen</div>
      <div><b>Sperrbildschirm</b>Steuerung über Kopfhörer & Lockscreen</div>
    </div>
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
  const hr = new Date().getHours();
  const greet = hr < 5 ? 'Gute Nacht' : hr < 11 ? 'Guten Morgen' : hr < 18 ? 'Guten Tag' : 'Guten Abend';
  if (!S.tracks.size) return pageHead(greet, '', settingsBtn()) + emptyLib();
  const albums = [...getAlbums().values()];
  const recent = albums.filter((a) => a.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 14);
  const newest = albums.slice().sort((a, b) => b.addedAt - a.addedAt).slice(0, 14);
  const all = [...S.tracks.values()];
  const top = all.filter((t) => t.playCount).sort((a, b) => b.playCount - a.playCount).slice(0, 6);
  const favs = all.filter((t) => t.fav).length;
  const artists = [...getArtists().values()].sort((a, b) => b.tracks.reduce((s, t) => s + (t.playCount || 0), 0) - a.tracks.reduce((s, t) => s + (t.playCount || 0), 0) || b.tracks.length - a.tracks.length).slice(0, 14);

  const tiles = [
    `<a class="tile" href="#/favorites"><span class="tile-art grad">${icon('heart-fill')}</span><span class="tile-label"><span>Favoriten</span><small>${plural(favs, 'Titel', 'Titel')}</small></span></a>`,
    `<button class="tile" data-action="shuffle-all"><span class="tile-art grad2">${icon('shuffle')}</span><span class="tile-label"><span>Zufallsmix</span><small>Alles durcheinander</small></span></button>`,
    `<button class="tile" data-action="play-newest"><span class="tile-art grad3">${icon('sparkle')}</span><span class="tile-label"><span>Neu hinzugefügt</span><small>Die letzten 50 Titel</small></span></button>`,
    top.length ? `<button class="tile" data-action="play-top"><span class="tile-art grad4">${icon('music')}</span><span class="tile-label"><span>Meistgespielt</span><small>Deine Top 50</small></span></button>` : '',
    ...S.playlists.slice(-2).reverse().map((p) => `<a class="tile" href="#/playlist/${p.id}">${playlistCover(p, 'mini').replace('class="cover', 'class="cover tile-art')}<span class="tile-label"><span>${esc(p.name)}</span><small>Playlist</small></span></a>`),
  ].join('');

  let html = pageHead(greet, '', settingsBtn()) + `<div class="tiles">${tiles}</div>`;
  if (recent.length) html += section('Zuletzt gespielt', '#/albums', `<div class="shelf">${recent.map(albumCard).join('')}</div>`);
  if (top.length) { const k = regList(top.map((t) => t.id), { source: 'Meistgespielt', noHead: true }); html += section('Deine Top-Titel', '', listEl(k, false)); }
  html += section('Neu hinzugefügt', '#/albums', `<div class="shelf">${newest.map(albumCard).join('')}</div>`);
  if (artists.length > 1) html += section('Deine Künstler', '#/artists', `<div class="shelf">${artists.map(artistCard).join('')}</div>`);
  return html;
};
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
      <div class="hero-info"><div class="eyebrow">Album</div><h1>${esc(a.name)}</h1>
      <p><a class="link" href="#/artist/${encodeURIComponent(a.artist)}">${esc(a.artist)}</a>${a.year ? ' · ' + esc(a.year) : ''} · ${plural(ids.length, 'Titel', 'Titel')} · ${fmtLong(dur)}</p></div>
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
      <div class="hero-info"><div class="eyebrow">Künstler</div><h1>${esc(displayName)}</h1>
      <p>${plural(albums.length, 'Album', 'Alben')} · ${plural(tracks.length, 'Titel', 'Titel')} · ${fmtLong(dur)}</p></div>
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
  const head = libTabs('favorites') + `<div class="hero" style="--tint: var(--accent)">
      <div class="cover hero-art" style="background:linear-gradient(135deg,var(--accent),var(--accent-2));color:var(--on-accent)">${icon('heart-fill')}</div>
      <div class="hero-info"><div class="eyebrow">Playlist</div><h1>Favoriten</h1><p>${plural(ids.length, 'Titel', 'Titel')}</p></div>
    </div>`;
  if (!ids.length) return head + '<div class="empty-small">Noch keine Favoriten. Tippe bei einem Titel auf das Herz.</div>';
  return head + `<div class="actions-bar">${playButtons(k)}</div>` + listEl(k);
};

views.playlists = () => {
  const cards = [
    `<button class="card card-new" data-action="new-playlist" style="text-align:left"><div class="card-art"><div class="cover">${icon('plus')}</div></div><div class="card-title">Neue Playlist</div><div class="card-sub">Erstellen</div></button>`,
    `<a class="card" href="#/favorites"><div class="card-art"><div class="cover" style="background:linear-gradient(135deg,var(--accent),var(--accent-2));color:var(--on-accent)">${icon('heart-fill')}</div><button class="card-play" data-action="play-favs" aria-label="Favoriten abspielen">${icon('play')}</button></div><div class="card-title">Favoriten</div><div class="card-sub">${plural([...S.tracks.values()].filter((t) => t.fav).length, 'Titel', 'Titel')}</div></a>`,
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
      <div class="hero-info"><div class="eyebrow">Playlist</div><h1>${esc(p.name)}</h1>
      <p>${plural(ids.length, 'Titel', 'Titel')}${ids.length ? ' · ' + fmtLong(dur) : ''}</p></div>
    </div>
    <div class="actions-bar">${ids.length ? playButtons(k) : ''}<button class="icon-btn lg" data-action="playlist-menu" data-id="${p.id}" aria-label="Mehr">${icon('more')}</button></div>
    ${ids.length ? listEl(k) : `<div class="empty-small">Diese Playlist ist noch leer.<br>Füge Titel über das ⋯-Menü bei einem Song hinzu.</div>`}`;
};

views.search = () => `${pageHead('Suchen')}<div class="search-box">${icon('search')}<input id="search-input" type="search" placeholder="Titel, Künstler oder Alben" value="${esc(S.search)}" autocomplete="off" enterkeyhint="search"></div><div id="search-results"></div>`;
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
  const q = norm(S.search.trim());
  if (!S.tracks.size) { box.innerHTML = emptyLib(); return; }
  if (!q) {
    const artists = [...getArtists().values()].sort((a, b) => b.tracks.length - a.tracks.length).slice(0, 40);
    box.innerHTML = section('Künstler entdecken', '#/artists', `<div class="artist-chips">${artists.map((a) => `<a class="chip" href="#/artist/${encodeURIComponent(a.name)}">${esc(a.name)}</a>`).join('')}</div>`);
    return;
  }
  const terms = q.split(/\s+/);
  const match = (s) => terms.every((t) => s.includes(t));
  const tracks = [...S.tracks.values()].filter((t) => match(searchStr(t)))
    .sort((a, b) => (norm(b.title).startsWith(q) - norm(a.title).startsWith(q)) || (b.playCount || 0) - (a.playCount || 0) || coll.compare(a.title, b.title));
  const albums = [...getAlbums().values()].filter((a) => match(norm(`${a.name} ${a.artist}`))).slice(0, 14);
  const artists = [...getArtists().values()].filter((a) => match(norm(a.name))).slice(0, 14);
  if (!tracks.length && !albums.length && !artists.length) {
    box.innerHTML = `<div class="empty-small">Keine Treffer für „${esc(S.search)}“.</div>`;
    return;
  }
  let html = '';
  if (tracks.length) { const k = regList(tracks.slice(0, 100).map((t) => t.id), { source: `Suche: ${S.search}` }); html += section(`Titel <span class="muted" style="font-weight:500;font-size:15px">${tracks.length}</span>`, '', listEl(k)); }
  if (artists.length) html += section('Künstler', '', `<div class="shelf">${artists.map(artistCard).join('')}</div>`);
  if (albums.length) html += section('Alben', '', `<div class="shelf">${albums.map(albumCard).join('')}</div>`);
  box.innerHTML = html;
  mountLists(box);
  hydrateCovers(box);
}

const ACCENTS = [
  { name: 'Koralle', a: '#ff6b4a', b: '#e5397f', on: '#fff' },
  { name: 'Violett', a: '#8b7bff', b: '#5b3fe0', on: '#fff' },
  { name: 'Mint', a: '#2dd4a7', b: '#0ea5e9', on: '#06221b' },
  { name: 'Pink', a: '#f472b6', b: '#a855f7', on: '#fff' },
  { name: 'Blau', a: '#4f9dff', b: '#4f46e5', on: '#fff' },
  { name: 'Gold', a: '#fbbf24', b: '#f97316', on: '#241600' },
  { name: 'Grün', a: '#4ade80', b: '#16a34a', on: '#052e12' },
];
function applyAccent(name) {
  const a = ACCENTS.find((x) => x.name === name) || ACCENTS[0];
  const r = document.documentElement.style;
  r.setProperty('--accent', a.a);
  r.setProperty('--accent-2', a.b);
  r.setProperty('--on-accent', a.on);
}

views.settings = () => {
  const tracks = [...S.tracks.values()];
  const size = tracks.reduce((s, t) => s + (t.size || 0), 0);
  const accent = ls.get('klang-accent', 'Koralle');
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
      <h2>Akzentfarbe</h2>
      <div class="swatches" style="margin-top:12px">${ACCENTS.map((a) => `<button class="swatch ${a.name === accent ? 'on' : ''}" data-action="accent" data-name="${a.name}" title="${a.name}" aria-label="${a.name}" style="background:linear-gradient(135deg,${a.a},${a.b})"></button>`).join('')}</div>
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
  const view = $('#view');
  view.innerHTML = fn(r.arg);
  mountLists(view);
  hydrateCovers(view);
  $$('[data-tint]', view).forEach(async (el) => { const c = await tintOf(el.dataset.tint); if (c) el.style.setProperty('--tint', c); });
  after[r.name]?.(r.arg);
  updateNav(r.name);
  main.scrollTop = keepScroll ? top : 0;
}
function refresh() {
  if (parseRoute().name === 'search') renderSearch();
  else render(true);
}
function updateNav(name) {
  const map = { album: 'albums', artist: 'artists', playlist: 'playlists' };
  const key = map[name] || name;
  const lib = ['songs', 'albums', 'artists', 'favorites', 'album', 'artist'].includes(name);
  $$('[data-nav]').forEach((a) => {
    const n = a.dataset.nav;
    a.classList.toggle('active', n === key || (n === 'library' && lib));
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
  'fav-current': () => { const t = S.tracks.get(curId); if (t) setFav(t.id, !t.fav); },
  'goto-artist': (el) => {
    if (el.closest('#player') && isMobile()) { if (curId) openOverlay('np'); return; }
    const t = S.tracks.get(curId);
    if (t) go('artist', t.artist);
  },
  'np-menu': (el) => { if (curId) trackMenu(curId, el); },
  fav: (el) => { const id = el.closest('[data-id]').dataset.id; setFav(id, !S.tracks.get(id)?.fav); },
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
  'album-menu': (el) => albumMenu(el.dataset.key, el),
  'playlist-menu': (el) => playlistMenu(el.dataset.id, el),
  'new-playlist': async () => { const p = await newPlaylistFlow(); if (p) go('playlist', p.id); },
  accent: (el) => { ls.set('klang-accent', el.dataset.name); applyAccent(el.dataset.name); $$('.swatch').forEach((s) => s.classList.toggle('on', s === el)); },
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
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (a && !a.disabled) {
      e.preventDefault();
      e.stopPropagation();
      actions[a.dataset.action]?.(a, e);
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
    const card = e.target.closest('[data-album-key]');
    if (card) { e.preventDefault(); albumMenu(card.dataset.albumKey, { x: e.clientX, y: e.clientY }); }
  });

  document.addEventListener('change', (e) => {
    const s = e.target.closest('[data-change="sort"]');
    if (s) { S.sort[s.dataset.what] = s.value; ls.set('klang-sort', S.sort); render(); }
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
      const d = audio.duration || S.tracks.get(curId)?.duration || 0;
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
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); go('search'); return; }
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
    else if (k === '/') go('search');
    else handled = false;
    if (handled) e.preventDefault();
  });

  // Vollbild-Player nach unten wischen zum Schließen
  let ty = null;
  const np = $('#np');
  np.addEventListener('touchstart', (e) => { ty = e.target.closest('.range, button') ? null : e.touches[0].clientY; }, { passive: true });
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
  window.addEventListener('hashchange', () => { closeMenu(); render(); });
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
async function init() {
  hydrateIcons(document);
  applyAccent(ls.get('klang-accent', 'Koralle'));
  cacheNpEls();
  updateVolumeUI();
  updateModeButtons();
  updatePlayState();
  try {
    const [tracks, playlists, ckeys] = await Promise.all([db.getAll('tracks'), db.getAll('playlists'), db.getAllKeys('covers')]);
    tracks.forEach((t) => S.tracks.set(t.id, t));
    S.playlists = playlists;
    coverKeys = new Set(ckeys);
  } catch (e) {
    console.error(e);
    toast('Die Bibliothek konnte nicht geladen werden. Ist der private Modus aktiv?', 6000);
  }
  setupEvents();
  setupMediaSession();
  renderSidebarPlaylists();
  render();
  restorePlayer();
  setupLaunchQueue();
  registerSW();
}

init();
