// timings.json: start and end of every narrator word, by word number, plus its sentence number.
// No text (spec 7.7, 8.2). tools/tts/tts.py writes timings/1 for one clip; words.ts defines the
// numbering. timings-set/1 holds the timings of several clips in one file, each with the SHA-256
// of its WAV: the sealed folder and sample/ keep one timings.json next to opening, p1, p2 and p3
// (spec 8.2). Pure: no Node APIs, so the page can use it too.

import { splitPassageWords } from './words.ts';

export const TIMINGS_SCHEMA = 'timings/1';
export const TIMINGS_SET_SCHEMA = 'timings-set/1';
export const WORD_RULE = 'copyholder-words/1';
/** How tts.py places word edges (README "Times"). Files written before it have no engine.timeRule. */
export const TIME_RULE = 'copyholder-times/1';
/** Narrator audio is 48 kHz (spec 7.7). */
export const SAMPLE_RATE_HZ = 48_000;

export interface WordTiming {
  /** Word number, as in words.ts. */
  index: number;
  /** Integer milliseconds from the first sample of the WAV. */
  startMs: number;
  endMs: number;
  /** Sentence number, as in words.ts. */
  sentenceIndex: number;
}

export interface TimingsEngine {
  name: string;
  kokoroVersion: string;
  misakiVersion: string;
  torchVersion: string;
  modelRepo: string;
  modelRevision: string;
  modelFile: string;
  modelLicence: string;
  voice: string;
  speed: number;
  langCode: string;
  seed: number;
  nativeRateHz: number;
  resampler: string;
  /** TIME_RULE; missing in files rendered before it. */
  timeRule?: string;
}

export interface Timings {
  schema: typeof TIMINGS_SCHEMA;
  wordRule: typeof WORD_RULE;
  sampleRateHz: number;
  durationSamples: number;
  durationMs: number;
  wordCount: number;
  sentenceCount: number;
  engine: TimingsEngine;
  /** Kokoro chunks whose own timestamps were off and were recomputed (see tts.py). */
  correctedChunks: number;
  words: WordTiming[];
}

export interface TimingsSetEntry {
  /** The clip's file name without .wav: opening, p1, p2, p3 (spec 8.2, 8.3). */
  passageId: string;
  /** SHA-256 of the clip's plain WAV bytes, as host serves them (sealed: before encryption), lowercase hex. */
  audioSha256: string;
  timings: Timings;
}

/** Word timings of several clips in one file (spec 8.2: one timings.json for all passages). */
export interface TimingsSet {
  schema: typeof TIMINGS_SET_SCHEMA;
  passages: TimingsSetEntry[];
}

const isInt = (v: unknown): v is number => Number.isInteger(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks the shape of a parsed timings.json and returns it typed; throws on the first defect. */
export function parseTimings(value: unknown): Timings {
  if (!isObject(value)) throw new Error('timings.json: not an object');
  if (value.schema !== TIMINGS_SCHEMA) throw new Error(`timings.json: schema is ${String(value.schema)}, expected ${TIMINGS_SCHEMA}`);
  if (value.wordRule !== WORD_RULE) throw new Error(`timings.json: wordRule is ${String(value.wordRule)}, expected ${WORD_RULE}`);
  for (const key of ['sampleRateHz', 'durationSamples', 'durationMs', 'wordCount', 'sentenceCount', 'correctedChunks']) {
    if (!isInt(value[key]) || (value[key] as number) < 0) throw new Error(`timings.json: ${key} is not a whole number`);
  }
  if (!isObject(value.engine)) throw new Error('timings.json: engine is missing');
  if (!Array.isArray(value.words)) throw new Error('timings.json: words is not an array');
  value.words.forEach((w: unknown, k: number) => {
    if (!isObject(w) || !isInt(w.index) || !isInt(w.startMs) || !isInt(w.endMs) || !isInt(w.sentenceIndex)) {
      throw new Error(`timings.json: word ${k} needs integer index, startMs, endMs and sentenceIndex`);
    }
  });
  return value as unknown as Timings;
}

/** Order and count checks; an empty list means the timings are usable. */
export function timingsProblems(t: Timings): string[] {
  const out: string[] = [];
  if (t.sampleRateHz !== SAMPLE_RATE_HZ) out.push(`sampleRateHz is ${t.sampleRateHz}, expected ${SAMPLE_RATE_HZ}`);
  if (t.words.length !== t.wordCount) out.push(`wordCount is ${t.wordCount} but ${t.words.length} words are listed`);
  if (t.sampleRateHz > 0 && t.durationMs !== Math.floor((t.durationSamples * 1000 + t.sampleRateHz / 2) / t.sampleRateHz)) {
    out.push(`durationMs ${t.durationMs} does not match ${t.durationSamples} samples`);
  }
  let prevEnd = 0;
  t.words.forEach((w, k) => {
    if (w.index !== k) out.push(`word ${k} has index ${w.index}`);
    if (!(w.startMs < w.endMs)) out.push(`word ${k} starts at ${w.startMs} ms, not before its end ${w.endMs} ms`);
    if (w.startMs < prevEnd) out.push(`word ${k} starts at ${w.startMs} ms, before word ${k - 1} ends at ${prevEnd} ms`);
    if (k === 0) {
      if (w.sentenceIndex !== 0) out.push(`word 0 is in sentence ${w.sentenceIndex}, expected 0`);
    } else {
      const prevSentence = t.words[k - 1]!.sentenceIndex;
      if (w.sentenceIndex !== prevSentence && w.sentenceIndex !== prevSentence + 1) {
        out.push(`word ${k} jumps from sentence ${prevSentence} to ${w.sentenceIndex}`);
      }
    }
    prevEnd = Math.max(prevEnd, w.endMs);
  });
  const last = t.words[t.words.length - 1];
  if (last === undefined) {
    if (t.sentenceCount !== 0) out.push(`sentenceCount is ${t.sentenceCount} but no words are listed`);
  } else {
    if (last.endMs > t.durationMs) out.push(`the last word ends at ${last.endMs} ms, after the audio (${t.durationMs} ms)`);
    if (last.sentenceIndex + 1 !== t.sentenceCount) out.push(`sentenceCount is ${t.sentenceCount} but the last word is in sentence ${last.sentenceIndex}`);
  }
  return out;
}

/** Problems when the timings do not number the words of this text as words.ts does. */
export function timingsTextProblems(t: Timings, text: string): string[] {
  const words = splitPassageWords(text);
  const out: string[] = [];
  if (words.length !== t.words.length) out.push(`words.ts finds ${words.length} words, timings.json lists ${t.words.length}`);
  const n = Math.min(words.length, t.words.length);
  for (let k = 0; k < n; k++) {
    if (words[k]!.sentenceIndex !== t.words[k]!.sentenceIndex) {
      out.push(`word ${k} is in sentence ${words[k]!.sentenceIndex} for words.ts, ${t.words[k]!.sentenceIndex} in timings.json`);
      break;
    }
  }
  return out;
}

/** Drops a leading byte order mark, as tts.py does when it reads a passage. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ---- several clips in one file (spec 8.2) ---------------------------------------------------

/** A passage id is also a clip file name: no dots, slashes or capitals. */
export const PASSAGE_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Checks the shape of a parsed timings-set/1 file and returns it typed; throws on the first defect. */
export function parseTimingsSet(value: unknown): TimingsSet {
  if (!isObject(value)) throw new Error('timings set: not an object');
  if (value.schema !== TIMINGS_SET_SCHEMA) throw new Error(`timings set: schema is ${String(value.schema)}, expected ${TIMINGS_SET_SCHEMA}`);
  const extra = Object.keys(value).filter((k) => k !== 'schema' && k !== 'passages');
  if (extra.length > 0) throw new Error(`timings set: unexpected field ${extra[0]}`);
  if (!Array.isArray(value.passages) || value.passages.length === 0) throw new Error('timings set: passages is not a non-empty array');
  value.passages.forEach((p: unknown, k: number) => {
    if (!isObject(p)) throw new Error(`timings set: passage ${k} is not an object`);
    const extraKeys = Object.keys(p).filter((key) => !['passageId', 'audioSha256', 'timings'].includes(key));
    if (extraKeys.length > 0) throw new Error(`timings set: passage ${k} has an unexpected field ${extraKeys[0]}`);
    if (typeof p.passageId !== 'string' || !PASSAGE_ID.test(p.passageId)) throw new Error(`timings set: passage ${k} has no valid passageId`);
    if (typeof p.audioSha256 !== 'string' || !SHA256_HEX.test(p.audioSha256)) throw new Error(`timings set: passage ${p.passageId} has no valid audioSha256`);
    try {
      parseTimings(p.timings);
    } catch (e) {
      throw new Error(`timings set: passage ${p.passageId}: ${(e as Error).message}`);
    }
  });
  return value as unknown as TimingsSet;
}

/** Duplicate ids and the problems of each clip's timings; an empty list means the set is usable. */
export function timingsSetProblems(set: TimingsSet): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of set.passages) {
    if (seen.has(p.passageId)) out.push(`passage ${p.passageId} is listed twice`);
    seen.add(p.passageId);
    for (const problem of timingsProblems(p.timings)) out.push(`passage ${p.passageId}: ${problem}`);
  }
  return out;
}

/** A checked timings-set/1 document from per-clip timings; throws on any problem. */
export function makeTimingsSet(entries: readonly TimingsSetEntry[]): TimingsSet {
  const set = parseTimingsSet({
    schema: TIMINGS_SET_SCHEMA,
    passages: entries.map((e) => ({ passageId: e.passageId, audioSha256: e.audioSha256, timings: e.timings })),
  });
  const problems = timingsSetProblems(set);
  if (problems.length > 0) throw new Error(`timings set: ${problems.slice(0, 3).join('; ')}`);
  return set;
}

const WORD_OBJECT = /\{\n\s*"index": (-?\d+),\n\s*"startMs": (-?\d+),\n\s*"endMs": (-?\d+),\n\s*"sentenceIndex": (-?\d+)\n\s*\}/g;

/** Two-space JSON with one word per line, as tts.py writes timings/1, so diffs stay readable. */
export function timingsSetJson(set: TimingsSet): string {
  const json = JSON.stringify(set, null, 2).replace(WORD_OBJECT, '{"index": $1, "startMs": $2, "endMs": $3, "sentenceIndex": $4}');
  return `${json}\n`;
}

/**
 * Word timings of one clip from a parsed timings.json: a timings/1 file is the clip's own, a
 * timings-set/1 file gives the entry whose passageId is the clip name without .wav. Null when the
 * set has no such clip. Throws on any other document.
 */
export function timingsForClip(value: unknown, clip: string): Timings | null {
  if (isObject(value) && value.schema === TIMINGS_SET_SCHEMA) {
    const id = clip.replace(/\.wav$/i, '');
    return parseTimingsSet(value).passages.find((p) => p.passageId === id)?.timings ?? null;
  }
  return parseTimings(value);
}

// ---- the WAV beside the timings ---------------------------------------------------------------

export interface WavInfo {
  /** 1 integer PCM, 3 IEEE float. */
  formatTag: number;
  channels: number;
  sampleRateHz: number;
  bitsPerSample: number;
  /** Sample frames in the data chunk. */
  frames: number;
  dataOffset: number;
  dataBytes: number;
}

/** Reads the fmt and data chunks of a RIFF/WAVE file; throws when it is not one. */
export function wavInfo(bytes: Uint8Array): WavInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let pos = 12;
  let fmt: Omit<WavInfo, 'frames' | 'dataOffset' | 'dataBytes'> | null = null;
  let blockAlign = 0;
  while (pos + 8 <= bytes.length) {
    const id = tag(pos);
    const size = view.getUint32(pos + 4, true);
    if (id === 'fmt ' && size >= 16 && pos + 24 <= bytes.length) {
      fmt = {
        formatTag: view.getUint16(pos + 8, true),
        channels: view.getUint16(pos + 10, true),
        sampleRateHz: view.getUint32(pos + 12, true),
        bitsPerSample: view.getUint16(pos + 22, true),
      };
      blockAlign = view.getUint16(pos + 20, true);
    } else if (id === 'data') {
      if (fmt === null || blockAlign === 0) throw new Error('WAV data chunk before its fmt chunk');
      const dataBytes = Math.min(size, bytes.length - pos - 8);
      return { ...fmt, frames: Math.floor(dataBytes / blockAlign), dataOffset: pos + 8, dataBytes };
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error('WAV file without fmt or data chunk');
}

/** Problems when the WAV is not the mono 48 kHz clip these timings describe (spec 7.7). */
export function wavTimingsProblems(info: WavInfo, t: Timings): string[] {
  const out: string[] = [];
  if (info.channels !== 1) out.push(`the WAV has ${info.channels} channels, expected 1`);
  if (info.sampleRateHz !== t.sampleRateHz) out.push(`the WAV runs at ${info.sampleRateHz} Hz, timings.json at ${t.sampleRateHz} Hz`);
  if (info.frames !== t.durationSamples) out.push(`the WAV holds ${info.frames} samples, timings.json says ${t.durationSamples}`);
  return out;
}

/** Samples of a mono 32-bit float WAV (what tts.py writes). */
export function wavFloatSamples(bytes: Uint8Array, info: WavInfo = wavInfo(bytes)): Float32Array {
  if (info.formatTag !== 3 || info.bitsPerSample !== 32 || info.channels !== 1) throw new Error('not a mono 32-bit float WAV');
  const view = new DataView(bytes.buffer, bytes.byteOffset + info.dataOffset, info.frames * 4);
  const out = new Float32Array(info.frames);
  for (let i = 0; i < info.frames; i++) out[i] = view.getFloat32(4 * i, true);
  return out;
}

// ---- word times against the sound (spec 6.4, 7.7) ----------------------------------------------

/** A 5 ms frame at or above this level is sound (tts.py LOUD_DBFS). */
export const LOUD_DBFS = -50;
/** Frame of the sound check: 5 ms at 48 kHz. */
export const SOUND_FRAME_SAMPLES = 240;
/** Slack of the check tts.py runs on every render (tts.py SOUND_SLACK_MS). */
export const SOUND_SLACK_MS = 100;

/** RMS level of each whole frame in dBFS, floored at -120 (tts.py frame_levels_db). */
export function frameLevelsDb(samples: Float32Array, frameSamples: number = SOUND_FRAME_SAMPLES): number[] {
  const out: number[] = [];
  for (let f = 0; (f + 1) * frameSamples <= samples.length; f++) {
    let sum = 0;
    for (let i = f * frameSamples; i < (f + 1) * frameSamples; i++) sum += samples[i]! * samples[i]!;
    const rms = Math.sqrt(sum / frameSamples);
    out.push(rms > 0 ? Math.max(-120, 20 * Math.log10(rms)) : -120);
  }
  return out;
}

function lowerBound(sorted: readonly number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface SoundCheckOptions {
  frameMs?: number;
  loudDbfs?: number;
  slackMs?: number;
}

/**
 * Word times against the frame levels of their clip, as tts.py checks every render: no sound
 * farther than slackMs from every word, and a word next to a pause holds at most slackMs of
 * silence after its last sound (pause after it) or before its first sound (pause before it).
 */
export function soundProblems(levelsDb: readonly number[], words: readonly WordTiming[], opts: SoundCheckOptions = {}): string[] {
  const frameMs = opts.frameMs ?? 5;
  const loudDbfs = opts.loudDbfs ?? LOUD_DBFS;
  const slack = opts.slackMs ?? SOUND_SLACK_MS;
  const loud: number[] = [];
  levelsDb.forEach((v, k) => {
    if (v >= loudDbfs) loud.push(k);
  });
  const out: string[] = [];
  if (words.length === 0) return out;
  const starts = words.map((w) => w.startMs);
  for (const k of loud) {
    const a = k * frameMs;
    const b = a + frameMs;
    const i = lowerBound(starts, a + 1) - 1; // the last word that starts at or before the frame
    if (!words.slice(Math.max(0, i), i + 2).some((w) => w.startMs - slack < b && a < w.endMs + slack)) {
      out.push(`sound at ${a} ms lies outside every word`);
      break;
    }
  }
  words.forEach((w, k) => {
    const pauseBefore = k === 0 || words[k - 1]!.endMs < w.startMs;
    const pauseAfter = k === words.length - 1 || words[k + 1]!.startMs > w.endMs;
    if (pauseAfter) {
      const j = lowerBound(loud, Math.ceil(w.endMs / frameMs)) - 1; // last frame that starts inside the word
      const end = j >= 0 ? (loud[j]! + 1) * frameMs : 0;
      if (j >= 0 && loud[j]! * frameMs >= w.startMs && w.endMs - end > slack) {
        out.push(`word ${k} ends at ${w.endMs} ms, ${w.endMs - end} ms after its sound`);
      }
    }
    if (pauseBefore) {
      const j = lowerBound(loud, Math.floor(w.startMs / frameMs)); // first frame that ends inside the word
      const begin = j < loud.length ? loud[j]! * frameMs : 0;
      if (j < loud.length && begin + frameMs <= w.endMs && begin - w.startMs > slack) {
        out.push(`word ${k} starts at ${w.startMs} ms, ${begin - w.startMs} ms before its sound`);
      }
    }
  });
  return out;
}
