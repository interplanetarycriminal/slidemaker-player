// js/studio-db.js — IndexedDB persistence for SlideMaker Studio.
// Plain ES2022 module. Zero dependencies.
//
// db "slidemaker-studio" v1, three stores (all out-of-line keys):
//   "project" — single autosave record under key "autosave"
//               (settings / slides meta / gaps — JSON-safe data ONLY, no blobs, no key)
//   "images"  — { original: Blob, normalized: Blob, sourceName, type } by slide uid
//   "clips"   — { blob: Blob(mp4), mimeType, savedAt } by gap uid

const DB_NAME = 'slidemaker-studio';
const DB_VERSION = 1;
const STORES = ['project', 'images', 'clips'];
const PROJECT_KEY = 'autosave';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // If another tab upgrades the schema, drop our handle gracefully.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
  });
  return dbPromise;
}

/** Run one operation in its own transaction; resolves with the request result. */
async function op(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let request;
    let tx;
    try {
      tx = db.transaction(storeName, mode);
      request = fn(tx.objectStore(storeName));
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error ?? new Error(`IndexedDB ${mode} on ${storeName} failed`));
    tx.onabort = () => reject(tx.error ?? new Error(`IndexedDB tx aborted on ${storeName}`));
  });
}

// ---------------- project (single autosave record) ----------------

export function saveProject(record) {
  return op('project', 'readwrite', (s) => s.put(record, PROJECT_KEY));
}

export function loadProject() {
  return op('project', 'readonly', (s) => s.get(PROJECT_KEY));
}

export function clearProject() {
  return op('project', 'readwrite', (s) => s.delete(PROJECT_KEY));
}

// ---------------- images (by slide uid) ----------------

export function putImage(uid, record) {
  return op('images', 'readwrite', (s) => s.put(record, uid));
}

export function getImage(uid) {
  return op('images', 'readonly', (s) => s.get(uid));
}

export function deleteImage(uid) {
  return op('images', 'readwrite', (s) => s.delete(uid));
}

// ---------------- clips (by gap uid) ----------------

export function putClip(uid, record) {
  return op('clips', 'readwrite', (s) => s.put(record, uid));
}

export function getClip(uid) {
  return op('clips', 'readonly', (s) => s.get(uid));
}

export function deleteClip(uid) {
  return op('clips', 'readwrite', (s) => s.delete(uid));
}

export function listClipKeys() {
  return op('clips', 'readonly', (s) => s.getAllKeys());
}
