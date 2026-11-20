// What pack takes from audio.wav (spec 8.7), in one pass over the file: audio_env.json, the level
// of both channels every 10 ms (ch0 microphone -> mic_db, ch1 Deck output -> narrator_db), and,
// with --with-audio, the published copy: both channels as 16-bit PCM at 48 kHz.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { SAMPLE_RATE_HZ, WAV_FORMAT_PCM, checkWavFormat, round1, type AudioEnv } from '../../core/schemas/index.ts';
import { readWavHeader, usableDataBytes, WavError } from '../lib/wav.ts';
import { PackRefusal } from './rules.ts';

/** Step of audio_env.json (spec 8.7). */
export const ENV_STEP_MS = 10;
/** Frames in one step at 48 kHz. */
export const ENV_STEP_FRAMES = (SAMPLE_RATE_HZ * ENV_STEP_MS) / 1000;
/** Floor for silence and anything quieter (the spec 8.7 example uses -90.0). */
export const SILENCE_DB = -90;

const READ_FRAMES = 65_536;
const PCM16_HEADER_BYTES = 44;

export interface SessionAudio {
  env: AudioEnv;
  /** The 16-bit published audio.wav (the frames used), when asked for; else null. */
  pcm16: Buffer | null;
  /** SHA-256 of the whole session audio.wav as read: header, audio and anything after it. */
  sha256: string;
  /** Frames of audio the file holds. */
  frames: number;
  /** Frames audio_env.json and the copy cover: all of them, or those before `endFrame`. */
  usedFrames: number;
  /** Samples beyond the 16-bit range, clipped in the copy (0 without the copy). */
  clipped: number;
  /** Set when the header length was not used (a recording that did not close; analysis/lib/wav.ts). */
  lengthNote: string | null;
}

/**
 * Level of one step in dB: 10 log10 of the mean of the squared samples (so 0 dB is a square wave
 * at full scale), rounded to 0.1 (spec 8.1); silence and anything at or below -90 dB is -90.
 */
export function levelDb(sumSquares: number, count: number): number {
  const mean = count > 0 ? sumSquares / count : 0;
  if (!(mean > 0)) return SILENCE_DB;
  const db = 10 * Math.log10(mean);
  return db <= SILENCE_DB ? SILENCE_DB : Math.max(SILENCE_DB, round1(db));
}

/** A float sample scaled to 16 bit as web/ui/wav.ts does (x * 32768, rounded), before clamping. */
function scaled16(x: number): number {
  return Math.round(x * 32768);
}

function clamp16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

function pcm16Header(frames: number): Buffer {
  const dataBytes = frames * 4;
  const h = Buffer.alloc(PCM16_HEADER_BYTES);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(WAV_FORMAT_PCM, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(SAMPLE_RATE_HZ, 24);
  h.writeUInt32LE(SAMPLE_RATE_HZ * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Reads `length` bytes at `position` into the start of `buf`; returns the bytes read. */
function readAt(fd: number, buf: Buffer, length: number, position: number): number {
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, position + got);
    if (n === 0) break;
    got += n;
  }
  return got;
}

/**
 * Reads sessions/<id>/audio.wav (2 x float32, 48 kHz, spec 8.1) once: the levels of audio_env.json,
 * the SHA-256 of the file and, with `pcm16`, the 16-bit copy. Steps start at the first frame of
 * the file; a last step shorter than 10 ms covers the frames there are. A recording that did not
 * close is read up to the audio present, as analysis/lib/wav.ts does. With `endFrame` the levels
 * and the copy stop before that frame (the cut at the objection block); the hash still covers the
 * whole file. Refuses another format and samples that are not finite numbers.
 */
export function readSessionAudio(file: string, opts: { pcm16: boolean; endFrame?: number | null }): SessionAudio {
  let h: ReturnType<typeof readWavHeader>;
  try {
    h = readWavHeader(file);
  } catch (e) {
    if (e instanceof WavError) throw new PackRefusal(`audio.wav cannot be read: ${e.message}`);
    throw e;
  }
  const problems = checkWavFormat('session', h);
  if (h.blockAlign !== 8) problems.push(`audio.wav: expected 8 bytes per frame (2 x float32), got ${h.blockAlign}`);
  if (problems.length > 0) throw new PackRefusal(`audio.wav is not in the session format, so audio_env.json cannot be made:\n  ${problems.join('\n  ')}`);

  const usable = usableDataBytes(h);
  const frames = usable.bytes / 8;
  const used = opts.endFrame === undefined || opts.endFrame === null ? frames : Math.max(0, Math.min(frames, Math.floor(opts.endFrame)));
  const mic: number[] = [];
  const narrator: number[] = [];
  let sum0 = 0;
  let sum1 = 0;
  let inStep = 0;
  const closeStep = (): void => {
    if (!Number.isFinite(sum0) || !Number.isFinite(sum1)) {
      throw new PackRefusal(`audio.wav holds samples that are not finite numbers in the 10 ms from ${mic.length * ENV_STEP_MS} ms: the file is damaged`);
    }
    mic.push(levelDb(sum0, inStep));
    narrator.push(levelDb(sum1, inStep));
    sum0 = 0;
    sum1 = 0;
    inStep = 0;
  };

  const hash = createHash('sha256');
  const out = opts.pcm16 ? Buffer.alloc(PCM16_HEADER_BYTES + used * 4) : null;
  if (out !== null) pcm16Header(used).copy(out, 0);
  const outView = out !== null && os.endianness() === 'LE' && (out.byteOffset + PCM16_HEADER_BYTES) % 2 === 0
    ? new Int16Array(out.buffer, out.byteOffset + PCM16_HEADER_BYTES, used * 2)
    : null;
  let clipped = 0;
  const littleEndian = os.endianness() === 'LE';

  const fd = fs.openSync(file, 'r');
  try {
    // Header bytes before the audio.
    const head = Buffer.alloc(h.dataOffset);
    if (readAt(fd, head, h.dataOffset, 0) !== h.dataOffset) throw new PackRefusal('audio.wav ends inside its header');
    hash.update(head);

    const buf = Buffer.alloc(READ_FRAMES * 8);
    for (let f = 0; f < frames; f += READ_FRAMES) {
      const want = Math.min(READ_FRAMES, frames - f);
      const got = readAt(fd, buf, want * 8, h.dataOffset + f * 8);
      if (got < want * 8) throw new PackRefusal(`audio.wav ends after ${f + Math.floor(got / 8)} of ${frames} frames while it is read`);
      hash.update(buf.subarray(0, got));
      const view = littleEndian && buf.byteOffset % 4 === 0 ? new Float32Array(buf.buffer, buf.byteOffset, want * 2) : null;
      // Frames from `used` on are only hashed.
      const take = Math.max(0, Math.min(want, used - f));
      for (let i = 0; i < take; i++) {
        const x0 = view !== null ? view[2 * i]! : buf.readFloatLE(8 * i);
        const x1 = view !== null ? view[2 * i + 1]! : buf.readFloatLE(8 * i + 4);
        sum0 += x0 * x0;
        sum1 += x1 * x1;
        inStep++;
        if (inStep === ENV_STEP_FRAMES) closeStep();
        if (out !== null) {
          const k = 2 * (f + i);
          const r0 = scaled16(x0);
          const r1 = scaled16(x1);
          const s0 = clamp16(r0);
          const s1 = clamp16(r1);
          if (s0 !== r0 && !Number.isNaN(r0)) clipped++;
          if (s1 !== r1 && !Number.isNaN(r1)) clipped++;
          if (outView !== null) {
            outView[k] = s0;
            outView[k + 1] = s1;
          } else {
            out.writeInt16LE(s0, PCM16_HEADER_BYTES + 2 * k);
            out.writeInt16LE(s1, PCM16_HEADER_BYTES + 2 * k + 2);
          }
        }
      }
    }
    if (inStep > 0) closeStep();

    // Anything after the audio (a cut frame, chunks after data) still belongs to the file's hash.
    let pos = h.dataOffset + usable.bytes;
    while (pos < h.fileBytes) {
      const got = readAt(fd, buf, Math.min(buf.length, h.fileBytes - pos), pos);
      if (got === 0) break;
      hash.update(buf.subarray(0, got));
      pos += got;
    }
  } finally {
    fs.closeSync(fd);
  }
  return {
    env: { schema: 'audio-env/1', step_ms: ENV_STEP_MS, mic_db: mic, narrator_db: narrator },
    pcm16: out,
    sha256: hash.digest('hex'),
    frames,
    usedFrames: used,
    clipped,
    lengthNote: usable.note,
  };
}
