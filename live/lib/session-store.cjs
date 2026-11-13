'use strict';
// The files host writes into sessions/<id>/ from the /session socket (spec 7.2, 8.1):
// audio.wav, stamps.jsonl, detector_in.jsonl, events.jsonl, plus calib.json (doctor's output gain).
// Event lines written by host carry by:"host" and follow core/schemas/session.ts (validateEventLine).
// Lost audio gives one of three events (core/clock/check.ts AUDIO_GAP_EVENTS): audio_gap (n0 does not
// follow on), audio_bad_block (a frame that is not a CHK1 block), audio_full (the WAV size limit).
const fs = require('node:fs');
const path = require('node:path');
const { WavWriter } = require('./wav.cjs');
const { parseAudioBlock, interleaveStereoBytes, checkBlockContinuity } = require('./audio-block.cjs');
const { writeJsonAtomic } = require('./hash.cjs');

const LINE_FILES = Object.freeze({ stamp: 'stamps.jsonl', det: 'detector_in.jsonl', event: 'events.jsonl' });

/**
 * A line from the page: a JSON object, or the JSON text of one (written unchanged, so detector
 * values keep every digit, spec 8.1). Returns {text, obj} or {error}.
 */
function normalizeLine(line) {
  if (typeof line === 'string') {
    const text = line.replace(/\r?\n$/, '');
    if (/[\r\n]/.test(text)) return { error: 'line breaks inside a line' };
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      return { error: 'not JSON' };
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'not a JSON object' };
    return { text, obj };
  }
  if (line && typeof line === 'object' && !Array.isArray(line)) {
    return { text: JSON.stringify(line), obj: line };
  }
  return { error: 'missing line' };
}

class SessionStore {
  constructor(dir, { sampleRateHz = 48000 } = {}) {
    this.dir = dir;
    this.sampleRateHz = sampleRateHz;
    this.isOpen = false;
    this.lastBlock = null;
    this.firstN0 = null;
    this.blocks = 0;
    this.gaps = 0;
    this.badBlocks = 0;
    this.lostBlocks = 0;
    this.badLines = 0;
    this.lineCounts = { stamp: 0, det: 0, event: 0 };
  }

  /** Creates the files of a recording. Never overwrites: audio.wav is opened with 'wx'. */
  open() {
    if (this.isOpen) return;
    this.wav = new WavWriter(path.join(this.dir, 'audio.wav'), { channels: 2, sampleRateHz: this.sampleRateHz });
    this.fds = {};
    for (const [kind, name] of Object.entries(LINE_FILES)) {
      this.fds[kind] = fs.openSync(path.join(this.dir, name), 'a');
    }
    this.isOpen = true;
  }

  /** Sample number just after the last stored audio block, null before audio: host events use it as `n`. */
  lastN() {
    return this.lastBlock === null ? null : this.lastBlock.n0 + this.lastBlock.frames;
  }

  writeText(kind, text) {
    fs.writeSync(this.fds[kind], text + '\n');
    this.lineCounts[kind] += 1;
  }

  /** A stamp, det or event line from the worker. Returns the parsed object or null. */
  writeLine(kind, line) {
    if (!this.isOpen || !LINE_FILES[kind]) return null;
    const v = normalizeLine(line);
    if (v.error) {
      this.badLines += 1;
      return null;
    }
    this.writeText(kind, v.text);
    return v.obj;
  }

  /** An events.jsonl line written by host: {n, e, by:'host', ...fields}; n defaults to lastN(). */
  writeHostEvent(e, fields = {}, n = this.lastN()) {
    if (!this.isOpen) return null;
    const obj = { n, e, by: 'host', ...fields };
    this.writeText('event', JSON.stringify(obj));
    return obj;
  }

  /**
   * A binary audio block (CHK1). Appends it interleaved to audio.wav and writes the chunk stamp
   * {"n":n0,"k":"chunk","frames":frames}. A block whose n0 is not the previous n0 + frames gives
   * event audio_gap and makes the audio unusable (spec 6.3, 7.2). Returns {ok, gap, error}.
   * Like every host line, audio_gap and audio_full carry n = lastN(), the expected n0 (docs/protocol.md).
   */
  writeAudioBlock(buf) {
    if (!this.isOpen) return { ok: false, gap: null, error: 'not recording' };
    const b = parseAudioBlock(buf);
    if (b.error) {
      this.badBlocks += 1;
      this.writeHostEvent('audio_bad_block', { detail: b.error });
      return { ok: false, gap: null, error: b.error };
    }
    const c = checkBlockContinuity(this.lastBlock, b.n0);
    let gap = null;
    if (!c.ok) {
      this.gaps += 1;
      gap = { expected: c.expectedN0, got: b.n0, missing: b.n0 - c.expectedN0 };
      this.writeHostEvent('audio_gap', gap);
    }
    if (!this.wav.append(interleaveStereoBytes(b.planar, b.frames))) {
      this.lostBlocks += 1;
      if (this.lostBlocks === 1) this.writeHostEvent('audio_full', { got: b.n0 });
      return { ok: false, gap, error: 'audio.wav is full' };
    }
    if (this.firstN0 === null) this.firstN0 = b.n0;
    this.writeText('stamp', JSON.stringify({ n: b.n0, k: 'chunk', frames: b.frames }));
    this.lastBlock = { n0: b.n0, frames: b.frames };
    this.blocks += 1;
    return { ok: true, gap, error: null };
  }

  /** Merges `data` into calib.json of this folder (spec 8.1: host is one of its writers). */
  writeCalib(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    const file = path.join(this.dir, 'calib.json');
    let cur = {};
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (v && typeof v === 'object' && !Array.isArray(v)) cur = v;
    } catch {
      // no calib.json yet, or a broken one that is replaced
    }
    const merged = { schema: 'calib/1', ...cur, ...data };
    merged.schema = 'calib/1';
    writeJsonAtomic(file, merged);
    return true;
  }

  audioSummary() {
    return {
      first_n0: this.firstN0,
      frames: this.wav ? this.wav.frames : 0,
      blocks: this.blocks,
      contiguous: this.gaps === 0 && this.badBlocks === 0 && this.lostBlocks === 0,
      gaps: this.gaps,
      bad_blocks: this.badBlocks,
      lost_blocks: this.lostBlocks,
      bad_lines: this.badLines,
    };
  }

  /** Writes the WAV sizes and closes every file. Safe to call twice. */
  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    try {
      this.wav.close();
    } finally {
      for (const fd of Object.values(this.fds)) fs.closeSync(fd);
    }
  }
}

module.exports = { LINE_FILES, normalizeLine, SessionStore };
