// WAV decoding for narrator clips (spec 7.7: mono, 48 kHz). PCM 16/24/32-bit and float 32/64.

export interface DecodedWav {
  sampleRateHz: number;
  channels: number;
  /** Channel 0, as float in [-1, 1]. */
  samples: Float32Array;
}

function tag(view: DataView, at: number): string {
  return String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
}

export function decodeWav(buffer: ArrayBuffer): DecodedWav {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12 || tag(view, 0) !== 'RIFF' || tag(view, 8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let format = 0;
  let channels = 0;
  let sampleRateHz = 0;
  let bits = 0;
  let dataAt = -1;
  let dataLen = 0;
  for (let at = 12; at + 8 <= buffer.byteLength; ) {
    const id = tag(view, at);
    const len = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRateHz = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === 0xfffe && len >= 26) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      dataAt = body;
      dataLen = Math.min(len, buffer.byteLength - body);
      break;
    }
    at = body + len + (len % 2);
  }
  if (dataAt < 0 || channels === 0) throw new Error('WAVE file without fmt or data chunk');
  const bytes = bits / 8;
  const frame = bytes * channels;
  const frames = Math.floor(dataLen / frame);
  const out = new Float32Array(frames);
  const read = sampleReader(view, format, bits);
  for (let i = 0; i < frames; i += 1) out[i] = read(dataAt + i * frame);
  return { sampleRateHz, channels, samples: out };
}

function sampleReader(view: DataView, format: number, bits: number): (at: number) => number {
  if (format === 1 && bits === 16) return (at) => view.getInt16(at, true) / 32768;
  if (format === 1 && bits === 24)
    return (at) => {
      const v = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16);
      return v / 8388608;
    };
  if (format === 1 && bits === 32) return (at) => view.getInt32(at, true) / 2147483648;
  if (format === 3 && bits === 32) return (at) => view.getFloat32(at, true);
  if (format === 3 && bits === 64) return (at) => view.getFloat64(at, true);
  throw new Error(`unsupported WAVE format ${format} with ${bits} bits`);
}

/** Decodes a narrator clip and checks it is mono at 48 kHz. */
export function decodeNarratorWav(buffer: ArrayBuffer, name: string): Float32Array {
  const wav = decodeWav(buffer);
  if (wav.sampleRateHz !== 48_000) throw new Error(`${name}: ${wav.sampleRateHz} Hz, the narrator must be 48 000 Hz`);
  if (wav.channels !== 1) throw new Error(`${name}: ${wav.channels} channels, the narrator must be mono`);
  return wav.samples;
}

/** A mono 16-bit PCM WAVE file; used by tests and the stand-in fixtures. */
export function encodeWavPcm16(samples: Float32Array, sampleRateHz = 48_000): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (at: number, s: string) => {
    for (let i = 0; i < 4; i += 1) view.setUint8(at + i, s.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(v * 32768))), true));
  return buffer;
}
