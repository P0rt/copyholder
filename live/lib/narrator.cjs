'use strict';
// Narrator files for the page (GET /api/narrator/<name>): one allow list and one read function
// (spec 7.2, 8.2). Every narrator byte the host serves goes through readNarrator().
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { sha256Hex } = require('./hash.cjs');
const { channelAsMonoWav } = require('./wav.cjs');

// THE allow list. Names are what the page asks for; nothing else is ever served.
const NARRATOR_ALLOW = Object.freeze({
  // gate/pack-<X>/ (public packs, spec 9.2): served only when the pack's pack.json lists them.
  gate: Object.freeze([
    'pack.json', 'cues.json', 'listen.wav', 'objections.wav', 'listen.timings.json', 'objections.timings.json',
  ]),
  // Sealed folder of a plan (spec 8.2): narrator audio and word timings only, decrypted in memory.
  // Name -> file inside the sealed folder. plan.json.enc, texts.json.enc, score.json.enc,
  // planter.log.enc are never reachable.
  sealed: Object.freeze({
    'opening.wav': 'audio/opening.wav.enc',
    'p1.wav': 'audio/p1.wav.enc',
    'p2.wav': 'audio/p2.wav.enc',
    'p3.wav': 'audio/p3.wav.enc',
    'timings.json': 'timings.json.enc',
  }),
  // sample/ (public sample text with its plan, spec 7.11): plain files, for headstart.
  sample: Object.freeze(['opening.wav', 'p1.wav', 'p2.wav', 'p3.wav', 'timings.json']),
  // doctor: the 20 s volume sample, not from the gate packs (spec 7.7): gate/level/level.wav, where
  // gate/level/render.ts writes it; sample/ is only a fallback (assumption).
  doctor: Object.freeze(['level.wav']),
  // live-from (spec 6.5): channel 0 of the replayed audio.wav stands in for the microphone.
  replay: Object.freeze(['mic.wav']),
});

const SEALED_FILES = new Map(Object.entries(NARRATOR_ALLOW.sealed));

function contentTypeFor(name) {
  return name.endsWith('.wav') ? 'audio/wav' : 'application/json';
}

/** AES-256-GCM file: 12-byte nonce, ciphertext, 16-byte tag (spec 8.2). */
function openSealed(buf, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('seal key must be 32 bytes');
  if (buf.length < 28) throw new Error('sealed file too short');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([decipher.update(buf.subarray(12, buf.length - 16)), decipher.final()]);
}

/** Inverse of openSealed (tests and tools). */
function sealBytes(plain, key, nonce = crypto.randomBytes(12)) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

/** Seal key text (64 hex chars or base64 of 32 bytes) to a Buffer. */
function parseSealKey(text) {
  const t = String(text).trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
  const b = Buffer.from(t, 'base64');
  if (b.length === 32 && /^[A-Za-z0-9+/]+={0,2}$/.test(t)) return b;
  throw new Error('the seal key is neither 64 hex characters nor base64 of 32 bytes');
}

const HASH_RE = /^(?:sha256:)?([0-9a-f]{64})$/;

/**
 * Which allowed names a pack.json lists, with an expected SHA-256 when it gives one.
 * The pack format belongs to the gate packs; this accepts names as values, as keys
 * (value: hash or {sha256}), or as {name|file|path, sha256} objects.
 */
function packListing(packJson) {
  const allowed = new Set(NARRATOR_ALLOW.gate);
  const listing = new Map();
  const note = (name, hash) => {
    if (!allowed.has(name) || name === 'pack.json') return;
    if (hash || !listing.has(name)) listing.set(name, hash || listing.get(name) || null);
  };
  const hashOf = (v) => {
    if (typeof v === 'string') return HASH_RE.exec(v)?.[1] ?? null;
    if (v && typeof v === 'object' && typeof v.sha256 === 'string') return HASH_RE.exec(v.sha256)?.[1] ?? null;
    return null;
  };
  const walk = (v) => {
    if (typeof v === 'string') return note(v, null);
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    for (const key of ['name', 'file', 'path']) {
      if (typeof v[key] === 'string') note(v[key], hashOf(v));
    }
    for (const [k, child] of Object.entries(v)) {
      if (allowed.has(k)) note(k, hashOf(child));
      walk(child);
    }
  };
  walk(packJson);
  listing.set('pack.json', null);
  return listing;
}

// ---- sources ----------------------------------------------------------------------------------

function noSource() {
  return { kind: 'none' };
}

/** gate/pack-<X>/ with its pack.json. Throws when pack.json is missing or not JSON. */
function gateSource(packDir) {
  const raw = fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8');
  return { kind: 'gate', dir: packDir, listing: packListing(JSON.parse(raw)) };
}

/** Sealed folder of one plan; `key` is the 32-byte seal key. */
function sealedSource(planDir, key) {
  return { kind: 'sealed', dir: planDir, key };
}

function sampleSource(sampleDir) {
  return { kind: 'sample', dir: sampleDir };
}

/**
 * doctor: level.wav from the first of `dirs` that holds it (directly or in audio/). host passes
 * gate/level/, where the sample is rendered, then sample/ as a fallback (spec 7.7, assumption).
 */
function doctorSource(...dirs) {
  const list = dirs.filter((d) => typeof d === 'string' && d.length > 0);
  return { kind: 'doctor', dir: list[0] ?? null, dirs: list };
}

/** live-from: mic.wav from the recorded audio.wav, other names from the recording's own source. */
function replaySource(audioFile, inner) {
  return { kind: 'replay', audioFile, inner: inner || noSource() };
}

function samplePath(dir, name) {
  const direct = path.join(dir, name);
  return fs.existsSync(direct) ? direct : path.join(dir, 'audio', name);
}

/** The file a sample or doctor source serves for `name`: for doctor the first folder that has it. */
function sourceFile(source, name) {
  const dirs = source.kind === 'doctor' && Array.isArray(source.dirs) ? source.dirs : [source.dir];
  const files = dirs.filter((d) => typeof d === 'string').map((d) => samplePath(d, name));
  return files.find((f) => fs.existsSync(f)) ?? files[0] ?? null;
}

/** Is `name` on the allow list of this source? (Says nothing about whether the file exists.) */
function isAllowedName(source, name) {
  if (typeof name !== 'string') return false;
  switch (source.kind) {
    case 'gate': return source.listing.has(name);
    case 'sealed': return SEALED_FILES.has(name);
    case 'sample': return NARRATOR_ALLOW.sample.includes(name);
    case 'doctor': return NARRATOR_ALLOW.doctor.includes(name);
    case 'replay': return NARRATOR_ALLOW.replay.includes(name) || isAllowedName(source.inner, name);
    default: return false;
  }
}

/** Sealed audio waits for the preflight_ok event (spec 7.2). */
function needsPreflight(source, name) {
  if (source.kind === 'sealed') return true;
  if (source.kind === 'replay') return !NARRATOR_ALLOW.replay.includes(name) && needsPreflight(source.inner, name);
  return false;
}

/** Whether the narrator clips of this source are sealed: then the first one played spends the text (spec 10.4). */
function holdsSealedAudio(source) {
  if (source.kind === 'sealed') return true;
  return source.kind === 'replay' && holdsSealedAudio(source.inner);
}

/** Allowed names whose files exist: the list GET /api/config shows as `narrator`. */
function narratorNames(source) {
  switch (source.kind) {
    case 'gate':
      return [...source.listing.keys()].filter((n) => fs.existsSync(path.join(source.dir, n))).sort();
    case 'sealed':
      return [...SEALED_FILES].filter(([, f]) => fs.existsSync(path.join(source.dir, f))).map(([n]) => n);
    case 'sample':
    case 'doctor':
      return NARRATOR_ALLOW[source.kind].filter((n) => {
        const file = sourceFile(source, n);
        return file !== null && fs.existsSync(file);
      });
    case 'replay':
      return [...NARRATOR_ALLOW.replay, ...narratorNames(source.inner)];
    default:
      return [];
  }
}

function refused(status, error) {
  return { status, error, contentType: null, body: null, length: 0 };
}

function served(name, body) {
  return { status: 200, error: null, contentType: contentTypeFor(name), body, length: body.length };
}

/**
 * THE narrator read function. Returns {status, error, contentType, body, length}:
 * 200 with a Buffer or a stream; 404 for any name off the allow list or missing;
 * 409 for sealed audio before preflight_ok; 500 when a file fails its check.
 */
async function readNarrator(source, name, { preflightOk = false } = {}) {
  if (!isAllowedName(source, name)) return refused(404, 'not on the narrator allow list');
  if (needsPreflight(source, name) && !preflightOk) return refused(409, 'sealed audio waits for preflight_ok');
  try {
    switch (source.kind) {
      case 'gate': {
        const file = path.join(source.dir, name);
        if (!fs.existsSync(file)) return refused(404, 'missing');
        const body = await fs.promises.readFile(file);
        const want = source.listing.get(name);
        if (want && sha256Hex(body) !== want) return refused(500, `${name} does not match pack.json`);
        return served(name, body);
      }
      case 'sealed': {
        const file = path.join(source.dir, SEALED_FILES.get(name));
        if (!fs.existsSync(file)) return refused(404, 'missing');
        return served(name, openSealed(await fs.promises.readFile(file), source.key));
      }
      case 'sample':
      case 'doctor': {
        const file = sourceFile(source, name);
        if (file === null || !fs.existsSync(file)) return refused(404, 'missing');
        return served(name, await fs.promises.readFile(file));
      }
      case 'replay': {
        if (!NARRATOR_ALLOW.replay.includes(name)) return readNarrator(source.inner, name, { preflightOk });
        if (!fs.existsSync(source.audioFile)) return refused(404, 'missing');
        const { length, stream } = channelAsMonoWav(source.audioFile, 0);
        return { status: 200, error: null, contentType: 'audio/wav', body: stream, length };
      }
      default:
        return refused(404, 'no narrator in this mode');
    }
  } catch (err) {
    return refused(500, err && err.message ? err.message : String(err));
  }
}

module.exports = {
  NARRATOR_ALLOW, openSealed, sealBytes, parseSealKey, packListing,
  noSource, gateSource, sealedSource, sampleSource, doctorSource, replaySource,
  isAllowedName, needsPreflight, holdsSealedAudio, narratorNames, readNarrator,
};
