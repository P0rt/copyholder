// Seeded pseudo-random numbers for the resampling code (core/ never calls Math.random()).
// Generator: sfc32 (Small Fast Counter, Chris Doty-Humphrey, public domain). Its state is
// filled from the seed by a golden-ratio counter passed through the MurmurHash3 fmix32
// finalizer. Only 32-bit integer operations, so the stream is identical in Node and in
// every browser: the judge page can recompute the same numbers (spec 7.11).

/** A source of uniform numbers in [0, 1). */
export type Rng = () => number;

function seedMixer(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** Deterministic generator of uniform numbers in [0, 1) from an integer seed (uses its low 32 bits). */
export function createSeededRng(seed: number): Rng {
  if (!Number.isSafeInteger(seed)) throw new RangeError(`seed must be a safe integer, got ${String(seed)}`);
  const init = seedMixer(seed);
  let a = init();
  let b = init();
  let c = init();
  let d = init();
  const next = (): number => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t;
  };
  // Discard the first outputs so that nearby seeds decorrelate.
  for (let i = 0; i < 12; i++) next();
  return () => next() / 4294967296;
}
