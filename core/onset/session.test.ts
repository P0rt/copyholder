import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { validateOnsets } from '../schemas/reports.ts';
import {
  computeFeatures,
  findOnset,
  findSessionOnsets,
  groupReplies,
  onsetEventFields,
  resolveOnsetConfig,
  type Reply,
  type SampleSpan,
} from './index.ts';
import {
  bandNoise,
  breath,
  createRng,
  fricative,
  msToSamples,
  narratorLeak,
  Scene,
  voice,
  type Rng,
} from '../vad/synth.ts';

const MS = 48;
const TOLERANCE = 5 * MS; // spec 7.6: t_v within 5 ms of the truth (assumption)

describe('groupReplies (spec 4.2, 7.6: pauses shorter than 1.0 s merge)', () => {
  it('merges a pause just under 1.0 s and splits at 1.0 s', () => {
    const g = groupReplies([
      [0, 4800],
      [4800 + 47999, 60000],
      [60000 + 48000, 120000],
    ]);
    expect(g.map((r) => [r.start, r.end, r.voicedSamples, r.segments.length])).toEqual([
      [0, 60000, 4800 + 60000 - 52799, 2],
      [108000, 120000, 12000, 1],
    ]);
  });

  it('sorts its input, counts overlaps once and drops empty segments', () => {
    const g = groupReplies([
      [5000, 9000],
      [1000, 6000],
      [20000, 20000],
    ]);
    expect(g).toEqual([{ start: 1000, end: 9000, voicedSamples: 8000, segments: [[1000, 6000], [5000, 9000]] }]);
    expect(groupReplies([])).toEqual([]);
  });

  it('partitions disjoint segments: gaps inside a reply < 1 s, between replies >= 1 s (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 1, max: 30000 }), fc.integer({ min: 1, max: 100000 })), { maxLength: 40 }),
        (parts) => {
          // Consecutive disjoint segments: [gap, length] pairs.
          const segs: SampleSpan[] = [];
          let t = 0;
          for (const [len, gap] of parts) {
            segs.push([t + gap, t + gap + len]);
            t += gap + len;
          }
          const groups = groupReplies([...segs].reverse());
          expect(groups.flatMap((g) => g.segments)).toEqual(segs);
          for (const g of groups) {
            expect(g.voicedSamples).toBe(g.segments.reduce((s, [a, b]) => s + b - a, 0));
            for (let i = 1; i < g.segments.length; i++) expect(g.segments[i]![0] - g.segments[i - 1]![1]).toBeLessThan(48000);
          }
          for (let i = 1; i < groups.length; i++) expect(groups[i]!.start - groups[i - 1]!.end).toBeGreaterThanOrEqual(48000);
        },
      ),
      { numRuns: 200 },
    );
  });
});

/** Words of a reply: voiced tones with short pauses, `words` long; returns the first sample. */
function speak(sc: Scene, rng: Rng, atMs: number, words: number, pauseMs = 150, f0 = 125): number {
  let t = atMs;
  let first = -1;
  for (let w = 0; w < words; w++) {
    const s = sc.add(voice({ durMs: 280, f0Hz: [f0 * 1.05, f0 * 0.92], levelDb: -25 - rng() * 3, attackMs: 3 }, rng), t);
    if (first < 0) first = s;
    t += 280 + pauseMs;
  }
  return first;
}

interface SessionScene {
  signal: Float32Array;
  reading: SampleSpan[];
  truths: { at: number; words: number; inhale: boolean }[];
}

/**
 * About 80 s of a session's channel 0: background at -68 dBFS, the narrator leaking at -70 dB
 * while it reads, hold pauses after the objections, and the user's replies: an objection after
 * an audible inhale, a continuation 2 s later, an objection that starts with /s/, a short
 * 'mm', a cough and a reply with a 0.8 s pause inside.
 */
function sessionScene(seed: number): SessionScene {
  const rng = createRng(seed);
  const total = 80000;
  const sc = new Scene(total).background(-68, rng);
  const leak = narratorLeak(total, -70, rng);
  // The narrator stops at each objection and resumes 1.2 s after its end (spec 6.4).
  const holds: Array<[number, number]> = [
    [20000, 24500],
    [39000, 42500],
    [58000, 63500],
  ];
  for (const [a, b] of holds) leak.fill(0, msToSamples(a), msToSamples(b));
  sc.add(leak, 0);
  const reading: SampleSpan[] = [];
  let from = 0;
  for (const [a, b] of holds) {
    reading.push([msToSamples(from), msToSamples(a)]);
    from = b;
  }
  reading.push([msToSamples(from), msToSamples(total)]);

  const truths: SessionScene['truths'] = [];
  // 1. Objection after an audible inhale, three words.
  sc.add(breath({ durMs: 450, levelDb: -40 }, rng), 19300);
  truths.push({ at: speak(sc, rng, 20000, 3), words: 3, inhale: true });
  // 2. Continuation 2 s after the end of the first reply: a reply of its own.
  truths.push({ at: speak(sc, rng, 23300, 2, 150, 135), words: 2, inhale: false });
  // 3. Objection that starts with a voiceless fricative.
  const s = sc.add(fricative({ durMs: 110, levelDb: -42, attackMs: 3 }, rng), 39000);
  speak(sc, rng, 39110, 2, 150, 115);
  truths.push({ at: s, words: 2, inhale: false });
  // 4. A short 'mm' (150 ms voiced): a reply with less than 250 ms of voice.
  truths.push({ at: sc.add(voice({ durMs: 150, f0Hz: 120, levelDb: -30, attackMs: 3 }, rng), 50000), words: 0, inhale: false });
  // 5. A cough: loud, broadband, not periodic: no reply.
  sc.add(bandNoise({ durMs: 250, levelDb: -30, lowHz: 300, highHz: 6000, attackMs: 4, releaseMs: 60 }, rng), 54000);
  // 6. A reply with a 0.8 s pause inside stays one reply.
  truths.push({ at: speak(sc, rng, 58000, 2, 800, 140), words: 2, inhale: false });
  return { signal: sc.toFloat32(), reading, truths };
}

describe('findSessionOnsets (spec 7.6, session variant)', () => {
  const cache = new Map<number, { scene: SessionScene; replies: Reply[] }>();
  const run = (seed: number): { scene: SessionScene; replies: Reply[] } => {
    let hit = cache.get(seed);
    if (hit === undefined) {
      const scene = sessionScene(seed);
      hit = { scene, replies: findSessionOnsets(scene.signal, { reading: scene.reading }) };
      cache.set(seed, hit);
    }
    return hit;
  };

  it('finds each reply once, with t_v within 5 ms of the truth', () => {
    for (const seed of [1, 2]) {
      const { scene, replies } = run(seed);
      expect(replies).toHaveLength(scene.truths.length);
      replies.forEach((r, i) => {
        const truth = scene.truths[i]!;
        expect(r.onset).not.toBeNull();
        expect(Math.abs(r.onset!.nV - truth.at)).toBeLessThanOrEqual(TOLERANCE);
        expect(r.onset!.nA).toBeGreaterThanOrEqual(r.onset!.nV);
        expect(r.inSearch).toBe(true);
      });
    }
  });

  it('records the audible inhale and keeps voiced time per reply (onsets.json voiced_ms)', () => {
    const { replies } = run(1);
    expect(replies[0]!.onset!.breath).not.toBeNull();
    expect(replies[0]!.onset!.flags).toEqual([]);
    expect(replies.slice(1).map((r) => r.onset!.breath)).toEqual([null, null, null, null]);
    // Three words of 280 ms, two of 280 ms, two of 280 ms, a 150 ms 'mm', two of 280 ms.
    const expected = [840, 560, 560, 150, 560];
    replies.forEach((r, i) => {
      expect(r.voicedMs).toBeGreaterThan(expected[i]! - 40);
      expect(r.voicedMs).toBeLessThan(expected[i]! + 50);
    });
    expect(replies[3]!.voicedMs).toBeLessThan(250);
  });

  it('merges the 0.8 s pause and splits the 2 s pause', () => {
    const { replies } = run(1);
    expect(replies[4]!.segments.length).toBeGreaterThanOrEqual(2);
    expect(replies[4]!.end - replies[4]!.start).toBeGreaterThan(msToSamples(1300));
    expect(replies[1]!.start - replies[0]!.end).toBeGreaterThanOrEqual(msToSamples(1000));
  });

  it('measures the floor where the narrator reads and nobody speaks, per anchor candidate', () => {
    const { scene } = run(2);
    // Without masks the floor still sits at the background plus leak (replies are short) ...
    const plain = findSessionOnsets(scene.signal);
    // ... and with the reply mask the replies themselves are kept out of it.
    const replies: SampleSpan[] = scene.truths.map((t) => [t.at, t.at + msToSamples(2500)]);
    const masked = findSessionOnsets(scene.signal, { reading: scene.reading, replies });
    for (const list of [plain, masked]) {
      expect(list).toHaveLength(scene.truths.length);
      for (const r of list) {
        expect(r.onset!.floorDb).toBeGreaterThan(-75);
        expect(r.onset!.floorDb).toBeLessThan(-68);
      }
    }
  });

  it("each event's floor is the median E from 10 s to 1 s before its own anchor, while the narrator reads and nobody speaks", () => {
    const { scene, replies } = run(1);
    const cfg = resolveOnsetConfig();
    const track = computeFeatures(scene.signal, 0, 0, scene.signal.length, cfg);
    const mask = track.maskFromSpans(scene.reading);
    // The replies found are left out as well (spec 7.6), without a `replies` option.
    track.maskFromSpans(
      replies.map((r): SampleSpan => [r.start, r.end]),
      mask,
      0,
    );
    const scratch = new Float64Array(track.count);
    for (const r of replies) {
      const ka = track.frameAtOrAfter(r.onset!.nA);
      const floor = track.floorOver(ka - 10000, ka - 1000, mask, scratch)!;
      expect(r.onset!.floorDb).toBe(floor.db);
      expect(r.onset!.floorSpreadDb).toBe(floor.spreadDb);
    }
  });

  it('gives onsets.json events that pass the schema (spec 8.1)', () => {
    const { replies } = run(1);
    const events = replies.map((r, i) => ({
      id: `o${String(i + 1).padStart(2, '0')}`,
      kind: 'objection',
      label: null,
      ...onsetEventFields(r.onset!, r),
      manual: null,
    }));
    expect(events[0]!.auto.breath).not.toBeNull();
    expect(validateOnsets({ schema: 'onsets/1', labels_sha256: null, events })).toEqual([]);
  });

  it('a long reply keeps its own words out of the floor: one reply up to its last word (spec 7.6)', () => {
    // 30 words over 12.75 s, no masks: a floor window that slid into the reply would rise with
    // it until its later words fell under N + 15 dB and the reply broke off.
    const rng = createRng(5);
    const sc = new Scene(40000).background(-68, rng);
    sc.add(narratorLeak(40000, -70, rng), 0);
    const at = speak(sc, rng, 15000, 30);
    const next = speak(sc, rng, 15000 + 30 * 430 - 150 + 2000, 2, 150, 135);
    const replies = findSessionOnsets(sc.toFloat32());
    expect(replies).toHaveLength(2);
    const [long, cont] = replies as [Reply, Reply];
    expect(Math.abs(long.onset!.nV - at)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(long.end - (at + msToSamples(30 * 430 - 150)))).toBeLessThanOrEqual(30 * MS);
    expect(long.voicedMs).toBeGreaterThan(30 * 280 - 100);
    expect(long.voicedMs).toBeLessThan(30 * 280 + 100);
    // The continuation 2 s later is a reply of its own; its 10 s window is almost all reply, so
    // N comes from the frames around it (60 s back) and stays at background plus leak.
    expect(Math.abs(cont.onset!.nV - next)).toBeLessThanOrEqual(TOLERANCE);
    expect(cont.onset!.floorDb).toBeLessThan(-68);
  });

  it('a NaN or infinite sample counts as 0', () => {
    const rng = createRng(6);
    const sc = new Scene(30000).background(-68, rng);
    sc.add(narratorLeak(30000, -70, rng), 0);
    const a = speak(sc, rng, 12000, 3);
    const b = speak(sc, rng, 20000, 2);
    const signal = sc.toFloat32();
    const broken = signal.slice();
    const zeroed = signal.slice();
    [0, msToSamples(5000), a - msToSamples(300), b + msToSamples(100), signal.length - 1].forEach((n, i) => {
      broken[n] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY][i % 3]!;
      zeroed[n] = 0;
    });
    const replies = findSessionOnsets(broken);
    expect(replies).toEqual(findSessionOnsets(zeroed));
    expect(replies).toHaveLength(2);
    replies.forEach((r, i) => expect(Math.abs(r.onset!.nV - [a, b][i]!)).toBeLessThanOrEqual(TOLERANCE));
  });

  it('follows a floor that rises during the session', () => {
    const rng = createRng(3);
    const sc = new Scene(60000).background(-68, rng);
    // A fan switches on at 30 s: the background rises by 12 dB.
    const fan = new Scene(30000).background(-56, rng);
    sc.add(fan.samples, 30000);
    const early = speak(sc, rng, 20000, 2);
    const late = speak(sc, rng, 50000, 2);
    const replies = findSessionOnsets(sc.toFloat32());
    expect(replies).toHaveLength(2);
    const [a, b] = replies as [Reply, Reply];
    expect(Math.abs(a.onset!.nV - early)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(b.onset!.nV - late)).toBeLessThanOrEqual(TOLERANCE);
    expect(b.onset!.floorDb - a.onset!.floorDb).toBeGreaterThan(10);
  });

  it('flags replies outside the search time and keeps the walk back out of the previous reply', () => {
    const { scene } = run(1);
    const search: SampleSpan[] = [[0, msToSamples(45000)]];
    const replies = findSessionOnsets(scene.signal, { reading: scene.reading, search });
    expect(replies.map((r) => r.inSearch)).toEqual([true, true, true, false, false]);
    for (let i = 1; i < replies.length; i++) expect(replies[i]!.onset!.nV).toBeGreaterThanOrEqual(replies[i - 1]!.end);
  });

  it('returns nothing for silence, background and narrator leak only', () => {
    expect(findSessionOnsets(new Float32Array(msToSamples(20000)))).toEqual([]);
    const rng = createRng(4);
    const sc = new Scene(30000).background(-68, rng);
    sc.add(narratorLeak(30000, -66, rng), 0);
    expect(findSessionOnsets(sc.toFloat32())).toEqual([]);
  });

  it('analyses a sub-range on absolute sample numbers', () => {
    const { scene } = run(1);
    const offset = 48000 * 1000;
    const whole = findSessionOnsets(scene.signal, { reading: scene.reading });
    const part = findSessionOnsets(scene.signal, {
      n0: offset,
      fromSample: offset + msToSamples(30000),
      toSample: offset + msToSamples(80000),
      reading: scene.reading.map(([a, b]) => [a + offset, b + offset]),
    });
    expect(part.map((r) => r.onset!.nV - offset)).toEqual(whole.slice(2).map((r) => r.onset!.nV));
  });
});

describe('findOnset reply (gate variant: voiced_ms and the reply end)', () => {
  const CUE_MS = 11000;
  const CUE = msToSamples(CUE_MS);

  function gate(seed: number): { rng: Rng; sc: Scene } {
    const rng = createRng(seed);
    const sc = new Scene(40000).background(-68, rng);
    sc.add(narratorLeak(40000, -70, rng), 0);
    return { rng, sc };
  }

  it('merges words with short pauses and stops at a pause of 1.0 s', () => {
    const { rng, sc } = gate(1);
    const truth = speak(sc, rng, CUE_MS + 1500, 4, 200);
    // Another reply 1.5 s after the end of the first one.
    speak(sc, rng, CUE_MS + 1500 + 4 * 480 - 200 + 1500, 2);
    const r = findOnset(sc.toFloat32(), CUE)!;
    expect(Math.abs(r.nV - truth)).toBeLessThanOrEqual(TOLERANCE);
    expect(r.reply.segments).toHaveLength(4);
    expect(r.reply.voicedMs).toBeGreaterThan(4 * 280 - 40);
    expect(r.reply.voicedMs).toBeLessThan(4 * 280 + 60);
    expect(r.reply.start).toBeGreaterThanOrEqual(r.nV);
    expect(Math.abs(r.reply.end - (truth + msToSamples(4 * 480 - 200)))).toBeLessThanOrEqual(30 * MS);
    expect(r.reply.truncated).toBe(false);
  });

  it('marks a reply that runs past the analysed range as truncated', () => {
    const { rng, sc } = gate(2);
    speak(sc, rng, CUE_MS + 1000, 30, 200);
    const r = findOnset(sc.toFloat32(), CUE, { params: { replyMaxMs: 2000 } })!;
    expect(r.reply.truncated).toBe(true);
    const full = findOnset(sc.toFloat32(), CUE)!;
    expect(full.reply.truncated).toBe(false);
    expect(full.reply.voicedMs).toBeGreaterThan(30 * 280 - 100);
  });
});
