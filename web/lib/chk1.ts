// Binary audio frame on /session (docs/protocol.md): "CHK1", uint32 LE frames, float64 LE n0,
// then float32 LE ch0[frames] (microphone) and ch1[frames] (Deck output).

export const CHK1_HEADER_BYTES = 16;
const MAGIC = [0x43, 0x48, 0x4b, 0x31]; // "CHK1"
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export interface ChunkFrame {
  frames: number;
  n0: number;
  ch0: Float32Array;
  ch1: Float32Array;
}

export function encodeChunkFrame(n0: number, ch0: Float32Array, ch1: Float32Array): ArrayBuffer {
  const frames = ch0.length;
  if (ch1.length !== frames) throw new Error('CHK1: channels differ in length');
  const buf = new ArrayBuffer(CHK1_HEADER_BYTES + 8 * frames);
  const dv = new DataView(buf);
  MAGIC.forEach((b, i) => dv.setUint8(i, b));
  dv.setUint32(4, frames, true);
  dv.setFloat64(8, n0, true);
  if (LITTLE_ENDIAN) {
    new Float32Array(buf, CHK1_HEADER_BYTES, frames).set(ch0);
    new Float32Array(buf, CHK1_HEADER_BYTES + 4 * frames, frames).set(ch1);
  } else {
    for (let i = 0; i < frames; i++) {
      dv.setFloat32(CHK1_HEADER_BYTES + 4 * i, ch0[i] as number, true);
      dv.setFloat32(CHK1_HEADER_BYTES + 4 * (frames + i), ch1[i] as number, true);
    }
  }
  return buf;
}

export function decodeChunkFrame(data: ArrayBuffer | ArrayBufferView): ChunkFrame {
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.byteLength < CHK1_HEADER_BYTES || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new Error('CHK1: bad magic');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = dv.getUint32(4, true);
  const n0 = dv.getFloat64(8, true);
  if (bytes.byteLength !== CHK1_HEADER_BYTES + 8 * frames) throw new Error('CHK1: length does not match frames');
  const ch0 = new Float32Array(frames);
  const ch1 = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    ch0[i] = dv.getFloat32(CHK1_HEADER_BYTES + 4 * i, true);
    ch1[i] = dv.getFloat32(CHK1_HEADER_BYTES + 4 * (frames + i), true);
  }
  return { frames, n0, ch0, ch1 };
}
