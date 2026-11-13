// audio.wav reader (spec 8.1): 2 channels, float32, 48 kHz, interleaved; ch0 microphone,
// ch1 Deck output. After a crash the header length is missing or wrong: the length then comes
// from the file size, as live/lib/wav.cjs does.

import fs from 'node:fs';
import os from 'node:os';

export const WAV_FORMAT_IEEE_FLOAT = 3;
/** The size fields hold this while host records (live/lib/wav.cjs: "length unknown"). */
export const WAV_UNKNOWN_SIZE = 0xffffffff;

export interface WavInfo {
  fileBytes: number;
  riffBytes: number;
  dataOffset: number;
  /** data chunk size as the header says. */
  dataBytes: number;
  /** Bytes really present after the data chunk start. */
  presentBytes: number;
  formatTag: number;
  channels: number;
  sampleRateHz: number;
  blockAlign: number;
  bitsPerSample: number;
  /** Whole frames read. */
  frames: number;
  /** 'header' when the header length was used, 'file size' when it was missing or wrong. */
  lengthFrom: 'header' | 'file size';
  /** Why the header length was not used; null when it was. */
  headerNote: string | null;
}

export interface WavAudio {
  info: WavInfo;
  /** Channel 0: microphone. */
  ch0: Float32Array;
  /** Channel 1: Deck output after gain. */
  ch1: Float32Array;
}

export class WavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WavError';
  }
}

/** Header fields and the data chunk position; reads at most the first 4 KiB. */
export function readWavHeader(file: string): Omit<WavInfo, 'frames' | 'lengthFrom' | 'headerNote'> {
  const fd = fs.openSync(file, 'r');
  try {
    const fileBytes = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(fileBytes, 4096));
    fs.readSync(fd, head, 0, head.length, 0);
    if (head.length < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
      throw new WavError(`${file} is not a RIFF/WAVE file`);
    }
    const riffBytes = head.readUInt32LE(4);
    let fmt: { formatTag: number; channels: number; sampleRateHz: number; blockAlign: number; bitsPerSample: number } | null = null;
    let dataOffset = -1;
    let dataBytes = -1;
    let off = 12;
    while (off + 8 <= head.length) {
      const id = head.toString('ascii', off, off + 4);
      const len = head.readUInt32LE(off + 4);
      if (id === 'fmt ' && off + 24 <= head.length) {
        fmt = {
          formatTag: head.readUInt16LE(off + 8),
          channels: head.readUInt16LE(off + 10),
          sampleRateHz: head.readUInt32LE(off + 12),
          blockAlign: head.readUInt16LE(off + 20),
          bitsPerSample: head.readUInt16LE(off + 22),
        };
      }
      if (id === 'data') {
        dataOffset = off + 8;
        dataBytes = len;
        break;
      }
      off += 8 + len + (len & 1);
    }
    if (!fmt || dataOffset < 0) throw new WavError(`${file} has no fmt or data chunk`);
    return { fileBytes, riffBytes, dataOffset, dataBytes, presentBytes: Math.max(0, fileBytes - dataOffset), ...fmt };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Bytes of audio to read. The header length is used when it is a real length within the file;
 * it is replaced by the bytes present when it holds the recording marker, is 0 with audio
 * present (a crash before the close), or runs past the end of the file (a cut file).
 */
export function usableDataBytes(h: Pick<WavInfo, 'riffBytes' | 'dataBytes' | 'presentBytes' | 'blockAlign'>): {
  bytes: number;
  lengthFrom: 'header' | 'file size';
  note: string | null;
} {
  let note: string | null = null;
  if (h.dataBytes === WAV_UNKNOWN_SIZE || h.riffBytes === WAV_UNKNOWN_SIZE) note = 'header still holds the recording marker (crash before close)';
  else if (h.dataBytes === 0 && h.presentBytes > 0) note = 'header says 0 bytes of audio (crash before close)';
  else if (h.dataBytes > h.presentBytes) note = `header says ${h.dataBytes} bytes of audio, the file holds ${h.presentBytes}`;
  const raw = note === null ? h.dataBytes : h.presentBytes;
  const bytes = h.blockAlign > 0 ? raw - (raw % h.blockAlign) : 0;
  return { bytes, lengthFrom: note === null ? 'header' : 'file size', note };
}

const READ_FRAMES = 65_536;

/**
 * Reads a 2-channel float32 WAV into two Float32Arrays, piece by piece (a 10-minute recording
 * is about 230 MB). Throws WavError on another format.
 */
export function readStereoFloatWav(file: string): WavAudio {
  const h = readWavHeader(file);
  if (h.formatTag !== WAV_FORMAT_IEEE_FLOAT || h.bitsPerSample !== 32) {
    throw new WavError(`${file}: expected 32-bit float audio (format 3), got format ${h.formatTag} with ${h.bitsPerSample} bits`);
  }
  if (h.channels !== 2 || h.blockAlign !== 8) {
    throw new WavError(`${file}: expected 2 channels (microphone, Deck output), got ${h.channels}`);
  }
  const { bytes, lengthFrom, note } = usableDataBytes(h);
  const frames = bytes / h.blockAlign;
  const ch0 = new Float32Array(frames);
  const ch1 = new Float32Array(frames);
  const littleEndian = os.endianness() === 'LE';
  const buf = Buffer.alloc(READ_FRAMES * h.blockAlign);
  const fd = fs.openSync(file, 'r');
  try {
    for (let f = 0; f < frames; f += READ_FRAMES) {
      const want = Math.min(READ_FRAMES, frames - f);
      const got = Math.floor(fs.readSync(fd, buf, 0, want * h.blockAlign, h.dataOffset + f * h.blockAlign) / h.blockAlign);
      if (littleEndian && buf.byteOffset % 4 === 0) {
        const view = new Float32Array(buf.buffer, buf.byteOffset, got * 2);
        for (let i = 0; i < got; i++) {
          ch0[f + i] = view[2 * i]!;
          ch1[f + i] = view[2 * i + 1]!;
        }
      } else {
        for (let i = 0; i < got; i++) {
          ch0[f + i] = buf.readFloatLE(8 * i);
          ch1[f + i] = buf.readFloatLE(8 * i + 4);
        }
      }
      if (got < want) throw new WavError(`${file}: audio ends after ${f + got} of ${frames} frames`);
    }
  } finally {
    fs.closeSync(fd);
  }
  return { info: { ...h, frames, lengthFrom, headerNote: note }, ch0, ch1 };
}

/** A 2-channel float32 WAV as host writes it (tests, tools). dataBytes overrides the header length field. */
export function encodeStereoFloatWav(
  ch0: Float32Array,
  ch1: Float32Array,
  opts: { sampleRateHz?: number; headerDataBytes?: number; headerRiffBytes?: number } = {},
): Buffer {
  if (ch0.length !== ch1.length) throw new RangeError('encodeStereoFloatWav: channels differ in length');
  const rate = opts.sampleRateHz ?? 48_000;
  const dataBytes = ch0.length * 8;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(opts.headerRiffBytes ?? 36 + dataBytes, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(WAV_FORMAT_IEEE_FLOAT, 20);
  out.writeUInt16LE(2, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 8, 28);
  out.writeUInt16LE(8, 32);
  out.writeUInt16LE(32, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(opts.headerDataBytes ?? dataBytes, 40);
  if (os.endianness() === 'LE') {
    const inter = new Float32Array(ch0.length * 2);
    for (let i = 0; i < ch0.length; i++) {
      inter[2 * i] = ch0[i]!;
      inter[2 * i + 1] = ch1[i]!;
    }
    Buffer.from(inter.buffer, inter.byteOffset, inter.byteLength).copy(out, 44);
  } else {
    for (let i = 0; i < ch0.length; i++) {
      out.writeFloatLE(ch0[i]!, 44 + 8 * i);
      out.writeFloatLE(ch1[i]!, 48 + 8 * i);
    }
  }
  return out;
}
