'use strict';
// Binary audio frames on /session (docs/protocol.md):
//   bytes 0-3 "CHK1", 4-7 uint32 LE frames, 8-15 float64 LE n0,
//   then float32 LE ch0[frames] (microphone), float32 LE ch1[frames] (Deck output).

const BLOCK_MAGIC = 'CHK1';
const BLOCK_HEADER_BYTES = 16;
const MAX_BLOCK_FRAMES = 48000 * 10;

/** Returns {frames, n0, planar} or {error}. `planar` is the payload after the header. */
function parseAudioBlock(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < BLOCK_HEADER_BYTES) return { error: 'short block' };
  if (buf.toString('ascii', 0, 4) !== BLOCK_MAGIC) return { error: 'bad magic' };
  const frames = buf.readUInt32LE(4);
  const n0 = buf.readDoubleLE(8);
  if (frames < 1 || frames > MAX_BLOCK_FRAMES) return { error: `bad frame count ${frames}` };
  if (!Number.isSafeInteger(n0) || n0 < 0) return { error: `bad n0 ${n0}` };
  if (buf.length !== BLOCK_HEADER_BYTES + frames * 8) return { error: `length ${buf.length} does not match ${frames} frames` };
  return { frames, n0, planar: buf.subarray(BLOCK_HEADER_BYTES) };
}

/** Planar [ch0..., ch1...] float32 LE bytes to interleaved [l0, r0, l1, r1, ...] bytes. */
function interleaveStereoBytes(planar, frames) {
  const out = Buffer.allocUnsafe(frames * 8);
  const ch1 = frames * 4;
  for (let i = 0; i < frames; i++) {
    planar.copy(out, i * 8, i * 4, i * 4 + 4);
    planar.copy(out, i * 8 + 4, ch1 + i * 4, ch1 + i * 4 + 4);
  }
  return out;
}

/**
 * n0 continuity (spec 6.3, 7.2): a block must start where the previous one ended.
 * prev is {n0, frames} of the previous block or null for the first block.
 */
function checkBlockContinuity(prev, n0) {
  if (prev === null) return { ok: true, expectedN0: n0 };
  const expectedN0 = prev.n0 + prev.frames;
  return { ok: n0 === expectedN0, expectedN0 };
}

/** Encodes a block (tests and tools). ch0 and ch1 are arrays or Float32Arrays of equal length. */
function encodeAudioBlock(n0, ch0, ch1) {
  const frames = ch0.length;
  if (ch1.length !== frames) throw new Error('channel lengths differ');
  const buf = Buffer.alloc(BLOCK_HEADER_BYTES + frames * 8);
  buf.write(BLOCK_MAGIC, 0, 'ascii');
  buf.writeUInt32LE(frames, 4);
  buf.writeDoubleLE(n0, 8);
  for (let i = 0; i < frames; i++) {
    buf.writeFloatLE(ch0[i], BLOCK_HEADER_BYTES + i * 4);
    buf.writeFloatLE(ch1[i], BLOCK_HEADER_BYTES + frames * 4 + i * 4);
  }
  return buf;
}

module.exports = {
  BLOCK_MAGIC, BLOCK_HEADER_BYTES, MAX_BLOCK_FRAMES,
  parseAudioBlock, interleaveStereoBytes, checkBlockContinuity, encodeAudioBlock,
};
