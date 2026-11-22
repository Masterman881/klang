// Hörstatistik: zählt echte Wiedergabezeit (nicht Klicks), pro Tag, Künstler und Song. Bleibt auf dem Gerät.
const KEY = 'klang-stats';
const day = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
let S = null;
let dirty = false;

function load() {
  if (S) return S;
  try { S = JSON.parse(localStorage.getItem(KEY)) || null; } catch { S = null; }
  if (!S || S.v !== 1) S = { v: 1, since: Date.now(), days: {}, names: {} };
  return S;
}
function flush() {
  if (!dirty) return;
  dirty = false;
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { prune(30); try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* */ } }
}
setInterval(flush, 10000);
addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

// Ältere Tage: Songs zusammenfassen, Künstler und Minuten bleiben
function prune(keepDays = 120) {
  const cut = day(new Date(Date.now() - keepDays * 864e5));
  for (const [d, v] of Object.entries(S.days)) if (d < cut && v.t) { delete v.t; delete v.p; }
}

const keyOf = (name) => String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// sec gehörte Sekunden für Titel t (artists = alle beteiligten Künstler)
export function tick(t, sec) {
  if (!t || !(sec > 0) || sec > 5) return;
  load();
  const d = (S.days[day()] ||= { s: 0, a: {}, t: {}, p: {} });
  d.s += sec;
  dirty = true;
  if (t.live) return; // Radio zählt zur Hörzeit, aber nicht zu Künstlern und Songs
  d.t ||= {};
  d.t[t.id] = (d.t[t.id] || 0) + sec;
  for (const name of t.artists?.length ? t.artists : [t.artist]) {
    const k = keyOf(name);
    if (!k) continue;
    d.a[k] = (d.a[k] || 0) + sec;
    S.names[k] = name;
  }
  S.titles ||= {};
  S.titles[t.id] = [t.title, t.artist, t.coverId || ''];
  dirty = true;
}
// Ein „Play“ zählt erst nach 30 Sekunden bzw. der Hälfte des Songs
export function countPlay(t) {
  load();
  const d = (S.days[day()] ||= { s: 0, a: {}, t: {}, p: {} });
  d.p ||= {};
  d.p[t.id] = (d.p[t.id] || 0) + 1;
  dirty = true;
}

export function rangeDays(range) {
  if (range === 'today') return 1;
  if (range === 'week') return 7;
  if (range === 'month') return 30;
  if (range === 'year') return 365;
  return Infinity;
}
export function summary(range = 'month') {
  load();
  const n = rangeDays(range);
  const from = n === Infinity ? '' : day(new Date(Date.now() - (n - 1) * 864e5));
  let total = 0;
  const artists = new Map(), tracks = new Map(), plays = new Map(), perDay = new Map();
  for (const [d, v] of Object.entries(S.days)) {
    if (d < from) continue;
    total += v.s;
    perDay.set(d, v.s);
    for (const [k, s] of Object.entries(v.a || {})) artists.set(k, (artists.get(k) || 0) + s);
    for (const [id, s] of Object.entries(v.t || {})) tracks.set(id, (tracks.get(id) || 0) + s);
    for (const [id, c] of Object.entries(v.p || {})) plays.set(id, (plays.get(id) || 0) + c);
  }
  const playsByArtist = new Map();
  return {
    total,
    days: perDay,
    artists: [...artists].map(([k, s]) => ({ key: k, name: S.names[k] || k, sec: s })).sort((a, b) => b.sec - a.sec),
    tracks: [...tracks].map(([id, s]) => ({ id, sec: s, plays: plays.get(id) || 0, info: S.titles?.[id] })).sort((a, b) => b.sec - a.sec),
    plays: [...plays.values()].reduce((a, b) => a + b, 0),
    playsByArtist,
    since: S.since,
  };
}
export function artistSeconds(name) {
  load();
  const k = keyOf(name);
  let s = 0;
  for (const v of Object.values(S.days)) s += v.a?.[k] || 0;
  return s;
}
export function trackSeconds() {
  load();
  const m = new Map();
  for (const v of Object.values(S.days)) for (const [id, s] of Object.entries(v.t || {})) m.set(id, (m.get(id) || 0) + s);
  return m;
}
export function streak() {
  load();
  let n = 0;
  for (let i = (S.days[day()]?.s || 0) >= 60 ? 0 : 1; i < 4000; i++) {
    const d = S.days[day(new Date(Date.now() - i * 864e5))];
    if (d && d.s >= 60) n++; else break;
  }
  return n;
}
export function reset() { S = { v: 1, since: Date.now(), days: {}, names: {} }; dirty = true; flush(); }
export function exportJSON() { load(); flush(); return JSON.stringify(S); }
export const dayKey = day;
