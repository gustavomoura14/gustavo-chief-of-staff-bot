"use strict";

// ---------------------------------------------------------------------------
// Delegation-queue storage backends.
//
// The server keeps the queue in memory as the source of truth and mirrors it
// out through a store on every mutation; on startup the store's load() seeds
// the in-memory array. Both operations are best-effort from the server's
// point of view (failures are logged there, never thrown into request
// handling), and the persisted data shape is identical in every backend: a
// plain JSON array of delegation entries (see the queue comment in
// src/server.js for the per-type entry shapes).
//
// Backend selection (createStore):
//   STORAGE_BACKEND unset or "file"  -> file store: DATA_DIR/delegations.json
//                                       (DATA_DIR defaults to the OS temp
//                                       dir), atomic write-to-temp + rename.
//                                       This is byte-for-byte the pre-existing
//                                       Render behavior.
//   STORAGE_BACKEND=firestore        -> Firestore (native mode) via
//                                       @google-cloud/firestore using
//                                       Application Default Credentials - on
//                                       Cloud Run this authenticates as the
//                                       service's runtime service account
//                                       with no key material in the image.
//                                       The whole queue lives in ONE document
//                                       (collection FIRESTORE_COLLECTION,
//                                       default "cos-bot", doc "delegations",
//                                       field "entries"), so reads/writes stay
//                                       atomic and the array shape is
//                                       preserved exactly. Firestore docs cap
//                                       at ~1 MiB; the queue is drained and
//                                       acked continuously, so this is ample -
//                                       oversize writes are logged by the
//                                       server's save error handling.
//
// The Firestore client is require()d lazily inside its factory so the file
// backend (i.e. today's Render deployment) never loads the dependency.
// ---------------------------------------------------------------------------

const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * File-backed store - the original DATA_DIR/delegations.json behavior,
 * unchanged: sync atomic writes, sync load.
 *
 * @param {string} dataDir
 * @returns {{description: string, load(): Promise<Array<object>>, save(entries: Array<object>): Promise<void>}}
 */
function createFileStore(dataDir) {
  const file = path.join(dataDir, "delegations.json");
  return {
    description: `file (${file})`,
    async load() {
      if (!fs.existsSync(file)) return [];
      const loaded = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(loaded) ? loaded : [];
    },
    async save(entries) {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmpFile = `${file}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(entries));
      fs.renameSync(tmpFile, file);
    },
  };
}

/**
 * Firestore-backed store: the whole queue in a single document so the data
 * shape (one JSON array) matches the file backend exactly.
 *
 * @returns {{description: string, load(): Promise<Array<object>>, save(entries: Array<object>): Promise<void>}}
 */
function createFirestoreStore() {
  const { Firestore } = require("@google-cloud/firestore");
  const db = new Firestore({
    // Entries are built defensively in server.js, but never let a stray
    // `undefined` field turn a best-effort save into a hard error.
    ignoreUndefinedProperties: true,
  });
  const collection = process.env.FIRESTORE_COLLECTION || "cos-bot";
  const docRef = db.collection(collection).doc("delegations");
  return {
    description: `firestore (${collection}/delegations)`,
    async load() {
      const snapshot = await docRef.get();
      if (!snapshot.exists) return [];
      const entries = snapshot.data().entries;
      return Array.isArray(entries) ? entries : [];
    },
    async save(entries) {
      await docRef.set({
        entries,
        updatedAt: new Date().toISOString(),
      });
    },
  };
}

/**
 * Picks the storage backend from the environment (see the header comment).
 * Unknown STORAGE_BACKEND values fail fast at startup rather than silently
 * running without persistence.
 *
 * @param {{backend?: string, dataDir?: string}} [opts]
 * @returns {{description: string, load(): Promise<Array<object>>, save(entries: Array<object>): Promise<void>}}
 */
function createStore(opts = {}) {
  const backend = opts.backend || process.env.STORAGE_BACKEND || "file";
  if (backend === "file") {
    return createFileStore(opts.dataDir || process.env.DATA_DIR || os.tmpdir());
  }
  if (backend === "firestore") {
    return createFirestoreStore();
  }
  throw new Error(`Unknown STORAGE_BACKEND "${backend}" (expected "file" or "firestore")`);
}

module.exports = { createStore };
