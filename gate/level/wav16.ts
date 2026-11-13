// The doctor volume sample as a 16-bit PCM WAV, mono, 48 kHz (spec 7.7). tools/tts writes IEEE float
// (tools/tts/README.md); this converts it without changing the sample count, so the word timings of
// tools/tts stay valid. Pure: bytes in, bytes out.

export const LEVEL_SAMPLE_RATE_HZ = 48_000;
const PCM16_HEADER_BYTES = 44;
const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

export interface WavFormat {
  /** 1 = integer PCM, 3 = IEEE float (an extensible header reports its sub-format). */
  format: number;
  channels: number;
  sampleRateHz: number;
  bitsPerSample: number;
  /** Byte offset and length of the data chunk. */
  dataOffset: number;
  dataBytes: number;
  frames: number;
}

function tag(view: DataView, at: number): string {
  return String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
}

/** The fmt and data chunks of a RIFF/WAVE file; throws on anything else. */
export function readWavFormat(bytes: Uint8Array): WavFormat {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || tag(view, 0) !== 'RIFF' || tag(view, 8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let fmt: Omit<WavFormat, 'dataOffset' | 'dataBytes' | 'frames'> | null = null;
  for (let at = 12; at + 8 <= bytes.byteLength; ) {
    const id = tag(view, at);
    const len = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      if (len < 16 || body + 16 > bytes.byteLength) throw new Error('fmt chunk too short');
      let format = view.getUint16(body, true);
      if (format === FORMAT_EXTENSIBLE && len >= 26) format = view.getUint16(body + 24, true);
      fmt = {
        format,
        channels: view.getUint16(body + 2, true),
        sampleRateHz: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (fmt === null) throw new Error('data chunk before the fmt chunk');
      const dataBytes = Math.min(len, bytes.byteLength - body);
      const frameBytes = (fmt.bitsPerSample / 8) * fmt.channels;
      if (!(frameBytes > 0)) throw new Error('fmt chunk with no sample size');
      return { ...fmt, dataOffset: body, dataBytes, frames: Math.floor(dataBytes / frameBytes) };
    }
    at = body + len + (len % 2);
  }
  throw new Error('WAVE file without fmt or data chunk');
}

/** Samples of a mono 32-bit float WAV (what tools/tts/tts.py writes). */
export function readFloatMonoWav(bytes: Uint8Array): { sampleRateHz: number; samples: Float32Array } {
  const f = readWavFormat(bytes);
  if (f.format !== FORMAT_FLOAT || f.bitsPerSample !== 32) throw new Error(`expected 32-bit float samples, got format ${f.format} with ${f.bitsPerSample} bits`);
  if (f.channels !== 1) throw new Error(`expected mono, got ${f.channels} channels`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(f.frames);
  for (let i = 0; i < f.frames; i += 1) samples[i] = view.getFloat32(f.dataOffset + i * 4, true);
  return { sampleRateHz: f.sampleRateHz, samples };
}

/**
 * Float samples in [-1, 1] to 16-bit integers, x * 32768 rounded to the nearest and clamped: the
 * inverse of the page's reader (web/ui/wav.ts divides by 32768). No dither, so the bytes depend only
 * on the samples. `clippedSamples` counts samples that did not fit.
 */
export function floatToPcm16(samples: Float32Array): { pcm: Int16Array; clippedSamples: number } {
  const pcm = new Int16Array(samples.length);
  let clippedSamples = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const x = samples[i]!;
    const v = Number.isFinite(x) ? Math.round(x * 32768) : 0;
    if (v > 32767 || v < -32768 || !Number.isFinite(x)) clippedSamples += 1;
    pcm[i] = Math.max(-32768, Math.min(32767, v));
  }
  return { pcm, clippedSamples };
}

/** A mono 16-bit PCM WAV: the 44-byte canonical header and the data chunk, nothing else. */
export function encodePcm16MonoWav(pcm: Int16Array, sampleRateHz: number = LEVEL_SAMPLE_RATE_HZ): Uint8Array {
  const dataBytes = pcm.length * 2;
  const out = new Uint8Array(PCM16_HEADER_BYTES + dataBytes);
  const view = new DataView(out.buffer);
  const write = (at: number, s: string): void => {
    for (let i = 0; i < 4; i += 1) view.setUint8(at + i, s.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, FORMAT_PCM, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i += 1) view.setInt16(PCM16_HEADER_BYTES + i * 2, pcm[i]!, true);
  return out;
}

/** Peak level in dBFS (-Infinity for silence). */
export function peakDbfs(samples: Float32Array): number {
  let peak = 0;
  for (const x of samples) peak = Math.max(peak, Math.abs(x));
  return 20 * Math.log10(peak);
}

/** tools/tts float WAV bytes to the stored 16-bit PCM WAV; refuses another rate (spec 7.7: 48 kHz). */
export function convertTtsWavToPcm16(floatWav: Uint8Array): { wav: Uint8Array; frames: number; clippedSamples: number; peakDbfs: number } {
  const { sampleRateHz, samples } = readFloatMonoWav(floatWav);
  if (sampleRateHz !== LEVEL_SAMPLE_RATE_HZ) throw new Error(`expected ${LEVEL_SAMPLE_RATE_HZ} Hz, got ${sampleRateHz} Hz`);
  const { pcm, clippedSamples } = floatToPcm16(samples);
  return { wav: encodePcm16MonoWav(pcm, sampleRateHz), frames: samples.length, clippedSamples, peakDbfs: peakDbfs(samples) };
}
