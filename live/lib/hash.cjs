'use strict';
// SHA-256 helpers for manifest.json and the ledger (spec 8.1, 8.5).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** SHA-256 of a file, read in 1 MiB pieces. */
function sha256FileSync(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
      pos += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/** {name: hex} for the regular files of a folder, sorted by name, minus `exclude`. */
function hashFolderFiles(dir, exclude = []) {
  const skip = new Set(exclude);
  const out = {};
  const names = fs.readdirSync(dir).filter((n) => !skip.has(n) && !n.endsWith('.tmp')).sort();
  for (const name of names) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile()) out[name] = sha256FileSync(p);
  }
  return out;
}

/**
 * Hashes again the files of `hashes` ({name: hex}) that are still in `dir`. Returns {files, changed}:
 * the map with the new hashes, and the names whose hash changed. A file that is gone keeps its entry.
 */
function rehashFiles(dir, hashes) {
  const files = { ...hashes };
  const changed = [];
  for (const name of Object.keys(hashes).sort()) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
    const h = sha256FileSync(p);
    if (h !== hashes[name]) {
      files[name] = h;
      changed.push(name);
    }
  }
  return { files, changed };
}

/** Writes JSON through a temporary file and a rename, so a crash never leaves half a file. */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

module.exports = { sha256Hex, sha256FileSync, hashFolderFiles, rehashFiles, writeJsonAtomic };
