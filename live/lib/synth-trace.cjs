'use strict';
// Synthetic SDK stream for the mock tap (spec 6.5 live:sim): a smooth breathing trace, the talking
// flag, 16 face points and the lip gap g computed from them by the formula of spec 7.5.

// The 16 points tap keeps, in this order (spec 7.1, 8.1).
const LANDMARK_IDS = Object.freeze([13, 14, 82, 87, 312, 317, 81, 178, 311, 402, 78, 308, 33, 263, 133, 362]);
// (upper, lower) lip pairs of g (spec 7.5).
const LIP_PAIRS = Object.freeze([[13, 14], [82, 87], [312, 317], [81, 178], [311, 402]]);

/** Seeded PRNG (mulberry32): the same seed gives the same stream. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function median(xs) {
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** g: median of the five lower-minus-upper y differences, divided by the 33-263 distance (spec 7.5). */
function lipGapFromPoints(points) {
  const at = (id) => points[LANDMARK_IDS.indexOf(id)];
  const diffs = LIP_PAIRS.map(([up, low]) => at(low)[1] - at(up)[1]);
  const [x1, y1] = at(33);
  const [x2, y2] = at(263);
  return median(diffs) / Math.hypot(x2 - x1, y2 - y1);
}

/** Breathing value at tS seconds: one breath per periodS plus a slow drift. */
function breathAt(tS, periodS) {
  return 0.5 * Math.sin((2 * Math.PI * tS) / periodS) + 0.06 * Math.sin((2 * Math.PI * tS) / 41);
}

/** 16 points [x, y] in LANDMARK_IDS order on a 1280x720 frame; gapPx opens the inner lips. */
function facePoints(gapPx, dx, dy) {
  const cx = 640 + dx;
  const eyeY = 330 + dy;
  const mouthY = 450 + dy;
  const half = gapPx / 2;
  const up = (x, k) => [x, mouthY - half * k];
  const low = (x, k) => [x, mouthY + half * k];
  const pts = {
    13: up(cx, 1), 14: low(cx, 1),
    82: up(cx - 14, 0.95), 87: low(cx - 14, 0.95),
    312: up(cx + 14, 0.95), 317: low(cx + 14, 0.95),
    81: up(cx - 26, 0.8), 178: low(cx - 26, 0.8),
    311: up(cx + 26, 0.8), 402: low(cx + 26, 0.8),
    78: [cx - 45, mouthY], 308: [cx + 45, mouthY],
    33: [cx - 90, eyeY], 263: [cx + 90, eyeY],
    133: [cx - 40, eyeY + 2], 362: [cx + 40, eyeY + 2],
  };
  return LANDMARK_IDS.map((id) => pts[id].map((v) => Math.round(v * 10) / 10));
}

/**
 * Frames of the synthetic stream. talking: [[startMs, endMs], ...] from the start.
 * frame(tS) gives {value, talking, g, hm, points} at tS seconds.
 */
class SyntheticStream {
  constructor({ seed = 1, breathPeriodS = 4.6, talking = [] } = {}) {
    this.rng = mulberry32(seed);
    this.breathPeriodS = breathPeriodS;
    this.talking = talking;
  }

  frame(tS) {
    const ms = tS * 1000;
    const talking = this.talking.some(([a, b]) => ms >= a && ms < b);
    const value = Math.fround(breathAt(tS, this.breathPeriodS) + (this.rng() - 0.5) * 0.004);
    const gapPx = talking
      ? 6 + 6 * (1 + Math.sin(2 * Math.PI * tS * 4))
      : 1.6 + this.rng() * 0.4;
    const headDx = 1.5 * Math.sin((2 * Math.PI * tS) / 7);
    const headDy = 2 * breathAt(tS, this.breathPeriodS);
    const points = facePoints(gapPx, headDx, headDy);
    const vxPxPerS = ((1.5 * 2 * Math.PI) / 7) * Math.cos((2 * Math.PI * tS) / 7);
    return {
      value,
      talking: talking ? 1 : 0,
      g: lipGapFromPoints(points),
      hm: Math.abs(vxPxPerS) / 180,
      points,
    };
  }
}

module.exports = { LANDMARK_IDS, LIP_PAIRS, mulberry32, lipGapFromPoints, breathAt, facePoints, SyntheticStream };
