// Kleine IndexedDB-Hülle. Alles bleibt lokal auf dem Gerät.
const DB_NAME = 'klang-db';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ['tracks', 'audio', 'covers', 'playlists']) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

const asPromise = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });

export async function getAll(store) {
  const db = await open();
  return asPromise(db.transaction(store).objectStore(store).getAll());
}
export async function getAllKeys(store) {
  const db = await open();
  return asPromise(db.transaction(store).objectStore(store).getAllKeys());
}
export async function get(store, key) {
  const db = await open();
  return asPromise(db.transaction(store).objectStore(store).get(key));
}
export async function put(store, value) {
  const db = await open();
  const t = db.transaction(store, 'readwrite');
  t.objectStore(store).put(value);
  return done(t);
}
export async function putMany(store, values) {
  const db = await open();
  const t = db.transaction(store, 'readwrite');
  const s = t.objectStore(store);
  for (const v of values) s.put(v);
  return done(t);
}
export async function del(store, key) {
  const db = await open();
  const t = db.transaction(store, 'readwrite');
  t.objectStore(store).delete(key);
  return done(t);
}
export async function clear(store) {
  const db = await open();
  const t = db.transaction(store, 'readwrite');
  t.objectStore(store).clear();
  return done(t);
}

// Titel + Audiodaten (+ optional Cover) in einem Rutsch speichern
export async function addTrack(track, blob, cover) {
  const db = await open();
  const t = db.transaction(['tracks', 'audio', 'covers'], 'readwrite');
  t.objectStore('tracks').put(track);
  t.objectStore('audio').put({ id: track.id, blob });
  if (cover) t.objectStore('covers').put(cover);
  return done(t);
}
