// Liest Metadaten (Titel, Künstler, Album, Cover …) direkt im Browser.
// Unterstützt: ID3v2.2/2.3/2.4 + ID3v1 (MP3), FLAC, MP4/M4A, Ogg Vorbis/Opus.

const latin1 = (b, s = 0, e = b.length) => { let r = ''; for (let i = s; i < e && i < b.length; i++) r += String.fromCharCode(b[i]); return r; };
const be32 = (b, p) => ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
const syncsafe = (b, p) => ((b[p] & 0x7f) << 21) | ((b[p + 1] & 0x7f) << 14) | ((b[p + 2] & 0x7f) << 7) | (b[p + 3] & 0x7f);
const utf8 = (b) => new TextDecoder('utf-8').decode(b);

function smart8(b) {
  // Viele Tagger schreiben UTF-8, obwohl sie Latin-1 angeben – erst UTF-8 versuchen.
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
  catch { return new TextDecoder('windows-1252').decode(b); }
}
function utf16(b, le) {
  if (b.length >= 2) {
    if (b[0] === 0xff && b[1] === 0xfe) { le = true; b = b.subarray(2); }
    else if (b[0] === 0xfe && b[1] === 0xff) { le = false; b = b.subarray(2); }
  }
  if (b.length % 2) b = b.subarray(0, b.length - 1);
  return new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(b);
}
function decodeText(enc, b) {
  let s;
  if (enc === 1) s = utf16(b, true);
  else if (enc === 2) s = utf16(b, false);
  else if (enc === 3) s = utf8(b);
  else s = smart8(b);
  return s.replace(/^\u0000+/, '').split('\u0000')[0].trim();
}
function unsync(b) {
  const out = new Uint8Array(b.length);
  let j = 0;
  for (let i = 0; i < b.length; i++) { out[j++] = b[i]; if (b[i] === 0xff && b[i + 1] === 0x00) i++; }
  return out.subarray(0, j);
}
function sniffMime(d, fallback) {
  if (d[0] === 0xff && d[1] === 0xd8) return 'image/jpeg';
  if (d[0] === 0x89 && d[1] === 0x50) return 'image/png';
  if (d[0] === 0x47 && d[1] === 0x49) return 'image/gif';
  if (latin1(d, 8, 12) === 'WEBP') return 'image/webp';
  return fallback && fallback.includes('/') ? fallback : 'image/jpeg';
}
const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
const year = (v) => { const m = String(v || '').match(/\d{4}/); return m ? m[0] : ''; };

// ---------- ID3v2 ----------
const ID3MAP = {
  TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album',
  TPE2: 'albumArtist', TP2: 'albumArtist', TRCK: 'trackNo', TRK: 'trackNo', TPOS: 'discNo', TPA: 'discNo',
  TYER: 'year', TYE: 'year', TDRC: 'year', TDOR: 'year', TCON: 'genre', TCO: 'genre',
};

async function readID3v2(file, head) {
  const ver = head[3];
  const flags = head[5];
  const size = syncsafe(head, 6);
  let data = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
  if ((flags & 0x80) && ver < 4) data = unsync(data);
  let pos = 0;
  if (flags & 0x40) pos += ver === 4 ? syncsafe(data, 0) : be32(data, 0) + 4;
  const out = {};
  let picType = -1;
  const idLen = ver === 2 ? 3 : 4;
  const hdrLen = ver === 2 ? 6 : 10;
  while (pos + hdrLen < data.length) {
    const id = latin1(data, pos, pos + idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let fsize;
    if (ver === 2) fsize = (data[pos + 3] << 16) | (data[pos + 4] << 8) | data[pos + 5];
    else if (ver === 4) fsize = syncsafe(data, pos + 4);
    else fsize = be32(data, pos + 4);
    const start = pos + hdrLen;
    const end = start + fsize;
    if (fsize <= 0 || end > data.length) break;
    let frame = data.subarray(start, end);
    const fmt = ver === 2 ? 0 : data[pos + 9];
    pos = end;
    if (ver === 3 && (fmt & 0xc0)) continue; // komprimiert/verschlüsselt
    if (ver === 4) {
      if (fmt & 0x0c) continue;
      if (fmt & 0x01) frame = frame.subarray(4);
      if (fmt & 0x02) frame = unsync(frame);
    }
    const key = ID3MAP[id];
    if (key) {
      const v = decodeText(frame[0], frame.subarray(1));
      if (!v || out[key]) continue;
      if (key === 'trackNo' || key === 'discNo') out[key] = num(v);
      else if (key === 'year') out[key] = year(v);
      else if (key === 'genre') out[key] = v.replace(/^\((\d+)\)/, '').trim();
      else out[key] = v;
    } else if (id === 'APIC' || id === 'PIC') {
      try {
        const enc = frame[0];
        let p, mime;
        if (id === 'PIC') { mime = 'image/' + latin1(frame, 1, 4).toLowerCase().replace('jpg', 'jpeg'); p = 4; }
        else { const z = frame.indexOf(0, 1); mime = latin1(frame, 1, z); p = z + 1; }
        const ptype = frame[p++];
        if (enc === 1 || enc === 2) { while (p + 1 < frame.length && !(frame[p] === 0 && frame[p + 1] === 0)) p += 2; p += 2; }
        else { while (p < frame.length && frame[p] !== 0) p++; p++; }
        // Frontcover (Typ 3) bevorzugen
        if (!out.picture || (ptype === 3 && picType !== 3)) {
          const img = frame.slice(p);
          if (img.length > 100) { out.picture = { mime: sniffMime(img, mime), data: img }; picType = ptype; }
        }
      } catch { /* kaputtes Bild ignorieren */ }
    }
  }
  return out;
}

async function readID3v1(file) {
  if (file.size < 128) return {};
  const b = new Uint8Array(await file.slice(file.size - 128).arrayBuffer());
  if (latin1(b, 0, 3) !== 'TAG') return {};
  const f = (s, e) => { const sub = b.subarray(s, e); const z = sub.indexOf(0); return smart8(z >= 0 ? sub.subarray(0, z) : sub).trim(); };
  const out = { title: f(3, 33), artist: f(33, 63), album: f(63, 93), year: year(f(93, 97)) };
  if (b[125] === 0 && b[126]) out.trackNo = b[126];
  return out;
}

// ---------- Vorbis Comments (FLAC / Ogg) ----------
function vorbisComments(b, out) {
  if (b.length < 8) return;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 4 + dv.getUint32(0, true);
  if (p + 4 > b.length) return;
  const n = dv.getUint32(p, true); p += 4;
  for (let k = 0; k < n && p + 4 <= b.length; k++) {
    const len = dv.getUint32(p, true); p += 4;
    if (len > b.length - p) break;
    const entry = b.subarray(p, p + len); p += len;
    const eq = entry.indexOf(0x3d);
    if (eq < 1) continue;
    const key = latin1(entry, 0, eq).toUpperCase();
    if (key === 'METADATA_BLOCK_PICTURE') {
      if (!out.picture) {
        try {
          const bin = Uint8Array.from(atob(latin1(entry, eq + 1).replace(/\s/g, '')), (c) => c.charCodeAt(0));
          out.picture = flacPicture(bin);
        } catch { /* ignorieren */ }
      }
      continue;
    }
    const val = utf8(entry.subarray(eq + 1)).trim();
    if (!val) continue;
    switch (key) {
      case 'TITLE': out.title ||= val; break;
      case 'ARTIST': out.artist ||= val; break;
      case 'ALBUM': out.album ||= val; break;
      case 'ALBUMARTIST': case 'ALBUM ARTIST': out.albumArtist ||= val; break;
      case 'DATE': case 'YEAR': out.year ||= year(val); break;
      case 'TRACKNUMBER': out.trackNo ||= num(val); break;
      case 'DISCNUMBER': out.discNo ||= num(val); break;
      case 'GENRE': out.genre ||= val; break;
    }
  }
}

function flacPicture(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 4;
  const ml = dv.getUint32(p); p += 4;
  const mime = latin1(b, p, p + ml); p += ml;
  const dl = dv.getUint32(p); p += 4 + dl + 16;
  const len = dv.getUint32(p); p += 4;
  const data = b.slice(p, p + len);
  return data.length > 100 ? { mime: sniffMime(data, mime), data } : null;
}

async function readFLAC(file) {
  const buf = new Uint8Array(await file.slice(0, Math.min(file.size, 16 * 1024 * 1024)).arrayBuffer());
  let pos = 4;
  const out = {};
  while (pos + 4 <= buf.length) {
    const h = buf[pos];
    const type = h & 0x7f;
    const len = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    const s = pos + 4, e = s + len;
    if (e > buf.length) break;
    if (type === 4) vorbisComments(buf.subarray(s, e), out);
    else if (type === 6 && !out.picture) { try { out.picture = flacPicture(buf.subarray(s, e)); } catch { /* */ } }
    pos = e;
    if (h & 0x80) break;
  }
  return out;
}

function indexOfSeq(b, seq) {
  outer: for (let i = 0; i <= b.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (b[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

async function readOgg(file) {
  const b = new Uint8Array(await file.slice(0, Math.min(file.size, 512 * 1024)).arrayBuffer());
  const out = {};
  let i = indexOfSeq(b, [0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]); // "OpusTags"
  let start = i >= 0 ? i + 8 : -1;
  if (start < 0) {
    i = indexOfSeq(b, [0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]); // "\x03vorbis"
    if (i >= 0) start = i + 7;
  }
  if (start >= 0) { try { vorbisComments(b.subarray(start), out); } catch { /* */ } }
  return out;
}

// ---------- MP4 / M4A ----------
function findAtom(b, s, e, type) {
  let p = s;
  while (p + 8 <= e) {
    let size = be32(b, p);
    const t = latin1(b, p + 4, p + 8);
    let hdr = 8;
    if (size === 1) { size = be32(b, p + 12); hdr = 16; } else if (size === 0) size = e - p;
    if (size < 8) return null;
    if (t === type) return { s: p + hdr, e: Math.min(p + size, e) };
    p += size;
  }
  return null;
}

async function readMP4(file) {
  const out = {};
  let pos = 0, moov = null;
  while (pos + 8 <= file.size) {
    const h = new Uint8Array(await file.slice(pos, pos + 16).arrayBuffer());
    let size = be32(h, 0);
    const type = latin1(h, 4, 8);
    let hdr = 8;
    if (size === 1) { size = be32(h, 8) * 4294967296 + be32(h, 12); hdr = 16; } else if (size === 0) size = file.size - pos;
    if (size < 8) break;
    if (type === 'moov') { moov = new Uint8Array(await file.slice(pos + hdr, pos + size).arrayBuffer()); break; }
    pos += size;
  }
  if (!moov) return out;
  const udta = findAtom(moov, 0, moov.length, 'udta');
  if (!udta) return out;
  const meta = findAtom(moov, udta.s, udta.e, 'meta');
  if (!meta) return out;
  const ilst = findAtom(moov, meta.s + 4, meta.e, 'ilst');
  if (!ilst) return out;
  let p = ilst.s;
  while (p + 8 <= ilst.e) {
    const size = be32(moov, p);
    if (size < 8) break;
    const name = latin1(moov, p + 4, p + 8);
    const d = findAtom(moov, p + 8, p + size, 'data');
    if (d) {
      const v = moov.subarray(d.s + 8, d.e);
      const text = () => utf8(v).trim();
      switch (name) {
        case '©nam': out.title = text(); break;
        case '©ART': out.artist = text(); break;
        case '©alb': out.album = text(); break;
        case 'aART': out.albumArtist = text(); break;
        case '©day': out.year = year(text()); break;
        case '©gen': out.genre = text(); break;
        case 'trkn': if (v.length >= 4) out.trackNo = (v[2] << 8) | v[3]; break;
        case 'disk': if (v.length >= 4) out.discNo = (v[2] << 8) | v[3]; break;
        case 'covr': if (!out.picture && v.length > 100) out.picture = { mime: sniffMime(v), data: v.slice() }; break;
      }
    }
    p += size;
  }
  return out;
}

// ---------- Dateiname als Fallback ----------
export function fromFileName(name) {
  let base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  base = base.replace(/^\d{1,3}\s*[-.)]?\s+/, '');
  const parts = base.split(' - ');
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { title: base };
}

export async function readTags(file) {
  let tags = {};
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const magic = latin1(head, 0, 4);
    if (magic.startsWith('ID3')) {
      tags = await readID3v2(file, head);
      if (!tags.title || !tags.artist) {
        const v1 = await readID3v1(file);
        for (const k in v1) if (!tags[k]) tags[k] = v1[k];
      }
    } else if (magic === 'fLaC') tags = await readFLAC(file);
    else if (magic === 'OggS') tags = await readOgg(file);
    else if (latin1(head, 4, 8) === 'ftyp') tags = await readMP4(file);
    else if (/\.mp3$/i.test(file.name)) tags = await readID3v1(file);
  } catch (e) {
    console.warn('Tags konnten nicht gelesen werden:', file.name, e);
  }
  const fb = fromFileName(file.name);
  return {
    title: tags.title || fb.title || file.name,
    artist: tags.artist || fb.artist || 'Unbekannter Künstler',
    album: tags.album || 'Unbekanntes Album',
    albumArtist: tags.albumArtist || '',
    year: tags.year || '',
    genre: tags.genre || '',
    trackNo: num(tags.trackNo),
    discNo: num(tags.discNo),
    picture: tags.picture || null,
  };
}
