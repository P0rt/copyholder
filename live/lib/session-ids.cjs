'use strict';
// Session folder names (spec 8.1 examples: gate-a, s1, demo-2). An existing folder is never reused:
// the next free name gets a suffix (-2, -3, ...).
const fs = require('node:fs');
const path = require('node:path');

function listNames(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** base, or base-2, base-3, ... whichever does not exist yet. */
function nextFreeId(sessionsDir, base) {
  if (!fs.existsSync(path.join(sessionsDir, base))) return base;
  for (let k = 2; k < 10_000; k++) {
    const id = `${base}-${k}`;
    if (!fs.existsSync(path.join(sessionsDir, id))) return id;
  }
  throw new Error(`no free folder name for ${base}`);
}

/** prefix-<n> with n one above the highest existing number (doctor-3 after doctor-2). */
function nextNumberedId(sessionsDir, prefix) {
  const escaped = prefix.replace(/[^A-Za-z0-9]/g, (c) => `\\${c}`);
  const re = new RegExp('^' + escaped + '-(\\d+)$');
  let max = 0;
  for (const name of listNames(sessionsDir)) {
    const m = re.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${max + 1}`;
}

/** The folder name a run asks for before the no-overwrite rule. */
function baseIdFor(opts, sessionsDir) {
  if (opts.id) return opts.id;
  switch (opts.mode) {
    case 'gate': return `gate-${opts.pack.toLowerCase()}`;
    case 'doctor': case 'smoke': case 'headstart': case 'live-from':
      return nextNumberedId(sessionsDir, opts.mode);
    default:
      return opts.plan; // sealed plans: the folder is named after the plan (s1, rehearsal, demo-1, k1, pilot)
  }
}

/** Creates the folder for this run and returns {id, dir}. */
function reserveSessionDir(sessionsDir, base) {
  fs.mkdirSync(sessionsDir, { recursive: true });
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = nextFreeId(sessionsDir, base);
    const dir = path.join(sessionsDir, id);
    try {
      fs.mkdirSync(dir);
      return { id, dir };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`could not create a folder for ${base}`);
}

module.exports = { nextFreeId, nextNumberedId, baseIdFor, reserveSessionDir };
