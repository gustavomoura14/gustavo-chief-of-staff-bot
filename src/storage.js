"use strict";

/**
 * Tiny named-store persistence layer: each store is one JSON file under
 * DATA_DIR (same location and write-to-temp + rename pattern as the
 * delegation queue in server.js, so a crash mid-write never truncates the
 * previous good file). Values live in memory and are re-persisted on every
 * set(); load happens once at createStore() time. Best-effort: persistence
 * failures are logged, never thrown.
 *
 * This module is the single swap point for alternative storage backends —
 * every new stateful feature (priorities, completions, drafts, meetings)
 * goes through createStore() and nothing else touches the filesystem.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || os.tmpdir();

/**
 * Creates (and loads) one named store.
 *
 * @param {string} name - file basename; the store persists to DATA_DIR/<name>.json
 * @param {*} initialValue - value used when no file exists (or it is unreadable)
 * @returns {{get: Function, set: Function}}
 */
function createStore(name, initialValue) {
  const file = path.join(DATA_DIR, `${name}.json`);
  let value = initialValue;

  try {
    if (fs.existsSync(file)) {
      value = JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch (err) {
    console.error(`Failed to load ${name} state from ${file}:`, err);
    value = initialValue;
  }

  function save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmpFile = `${file}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(value));
      fs.renameSync(tmpFile, file);
    } catch (err) {
      console.error(`Failed to persist ${name} state to ${file}:`, err);
    }
  }

  return {
    /** Returns the current in-memory value. */
    get: () => value,
    /** Replaces the value and persists it. */
    set(next) {
      value = next;
      save();
    },
  };
}

module.exports = { createStore };
