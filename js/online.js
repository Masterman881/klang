// Legale, kostenlose Online-Quellen:
//  - Audius (audius.co): Künstler laden ihre Musik selbst hoch und erlauben das Streaming.
//  - Radio Browser (radio-browser.info): offenes Verzeichnis von Internetradio-Sendern.

const AUDIUS = 'https://api.audius.co/v1';
const APP = 'Klang';

async function aget(path, params = {}) {
  const q = new URLSearchParams({ ...params, app_name: APP });
  const r = await fetch(`${AUDIUS}${path}?${q}`);
  if (!r.ok) throw new Error(`Audius HTTP ${r.status}`);
  return (await r.json()).data;
}

const pic = (o, size = '480x480') => (o && o[size] ? 'url:' + o[size] : null);
// Audius liefert pro Bild Ersatz-Server mit: gleiche Datei, anderer Host
const alts = (o, size = '480x480') => {
  if (!o || !o[size] || !Array.isArray(o.mirrors)) return [];
  let path;
  try { path = new URL(o[size]).pathname; } catch { return []; }
  return o.mirrors.map((m) => m.replace(/\/$/, '') + path).filter((u) => u !== o[size]);
};
const playable = (x) => x && x.is_streamable !== false && !x.is_stream_gated && x.access?.stream !== false && !x.is_delete && x.is_available !== false;

export function normTrack(x) {
  const u = x.user || {};
  return {
    id: 'au:' + x.id,
    remote: 'audius',
    title: (x.title || 'Ohne Titel').trim(),
    artist: (u.name || 'Unbekannter Künstler').trim(),
    artistId: u.id || x.user_id || null,
    artistPic: pic(u.profile_picture),
    artistPicAlts: alts(u.profile_picture),
    artistVerified: !!u.is_verified,
    artistFollowers: u.follower_count || 0,
    album: 'Online',
    albumArtist: '',
    year: (x.release_date || '').slice(0, 4),
    genre: x.genre || '',
    trackNo: 0,
    discNo: 0,
    duration: x.duration || 0,
    coverId: pic(x.artwork) || pic(u.profile_picture),
    coverAlts: x.artwork?.['480x480'] ? alts(x.artwork) : alts(u.profile_picture),
    coverHi: pic(x.artwork, '1000x1000'),
    coverHiAlts: alts(x.artwork, '1000x1000'),
    streamUrl: `${AUDIUS}/tracks/${x.id}/stream?app_name=${APP}`,
    permalink: x.permalink ? 'https://audius.co' + x.permalink : null,
    plays: x.play_count || 0,
    fav: false, favAt: 0, playCount: 0, lastPlayed: 0,
    addedAt: Date.now(),
  };
}

export function normUser(u) {
  return {
    id: u.id,
    name: (u.name || u.handle || '').trim(),
    handle: u.handle,
    followers: u.follower_count || 0,
    trackCount: u.track_count || 0,
    verified: !!u.is_verified,
    pic: pic(u.profile_picture),
    picAlts: alts(u.profile_picture),
    bio: u.bio || '',
  };
}

export const audius = {
  async trending(genre, time = 'week', limit = 50) {
    const p = { limit, time };
    if (genre) p.genre = genre;
    return (await aget('/tracks/trending', p)).filter(playable).map(normTrack);
  },
  async searchTracks(query, limit = 30) {
    return (await aget('/tracks/search', { query, limit })).filter(playable).map(normTrack);
  },
  async searchUsers(query, limit = 12) {
    return (await aget('/users/search', { query, limit })).filter((u) => u.track_count > 0).map(normUser);
  },
  async user(id) {
    return normUser(await aget(`/users/${encodeURIComponent(id)}`));
  },
  async userTracks(id, limit = 100) {
    return (await aget(`/users/${encodeURIComponent(id)}/tracks`, { limit, sort: 'plays' })).filter(playable).map(normTrack);
  },
};

// ---------- Radio ----------
const RADIO_HOSTS = ['https://de1.api.radio-browser.info', 'https://de2.api.radio-browser.info', 'https://fi1.api.radio-browser.info'];
let radioHost = 0;

async function rget(path, params = {}) {
  const q = new URLSearchParams(params);
  let lastErr;
  for (let i = 0; i < RADIO_HOSTS.length; i++) {
    const host = RADIO_HOSTS[(radioHost + i) % RADIO_HOSTS.length];
    try {
      const r = await fetch(`${host}/json${path}?${q}`);
      if (!r.ok) throw new Error(`Radio HTTP ${r.status}`);
      radioHost = (radioHost + i) % RADIO_HOSTS.length;
      return await r.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const TAG_DE = { pop: 'Pop', rock: 'Rock', news: 'Nachrichten', 'hip hop': 'Hip-Hop', hiphop: 'Hip-Hop', dance: 'Dance', electronic: 'Elektronisch', '80s': '80er', '90s': '90er', schlager: 'Schlager', jazz: 'Jazz', classical: 'Klassik', chillout: 'Chillout', charts: 'Charts', oldies: 'Oldies', house: 'House', techno: 'Techno', rnb: 'R&B', metal: 'Metal', country: 'Country', talk: 'Talk' };

export function normStation(s) {
  const tags = (s.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  const nice = tags.map((t) => TAG_DE[t.toLowerCase()]).filter(Boolean);
  const sub = [...new Set(nice)].slice(0, 3).join(' · ') || tags.slice(0, 2).join(' · ') || s.country || 'Radio';
  return {
    id: 'radio:' + s.stationuuid,
    remote: 'radio',
    live: true,
    title: (s.name || 'Radio').trim().replace(/\s+/g, ' '),
    artist: sub,
    album: 'Live-Radio',
    albumArtist: '',
    genre: 'Radio',
    country: s.countrycode || '',
    duration: 0,
    coverId: s.favicon && s.favicon.startsWith('https://') ? 'url:' + s.favicon : null,
    streamUrl: s.url_resolved,
    homepage: s.homepage || null,
    fav: false, favAt: 0, playCount: 0, lastPlayed: 0, trackNo: 0, discNo: 0, year: '',
  };
}

export const radio = {
  async search(params = {}) {
    const list = await rget('/stations/search', { hidebroken: 'true', order: 'clickcount', reverse: 'true', limit: 60, ...params });
    const seen = new Set();
    return list
      .filter((s) => s.url_resolved && s.url_resolved.startsWith('https://'))
      .filter((s) => { const k = s.name.trim().toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .map(normStation);
  },
};
