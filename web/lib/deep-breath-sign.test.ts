import { describe, expect, it } from 'vitest';
import { DeepBreathSign, DEEP_BREATH_SIGN_ERROR, exhaleStep, inhaleStep, sampleToCameraUs } from './deep-breath-sign.ts';
import type { TracePair } from './messages.ts';
import { deepBreathTake, type DeepBreathTake, type DeepBreathTakeOptions } from './testing/deep-breaths.ts';

/** Feeds a take to the finder as the worker does: each packet, then its arr stamp; step marks in sample order. */
function feed(take: DeepBreathTake): { finder: DeepBreathSign; dueAt: string | null } {
  const finder = new DeepBreathSign();
  const marks = [...take.marks];
  let dueAt: string | null = null;
  for (const line of take.lines) {
    const nArr = take.nArrBySeq.get(line.seq) as number;
    while (marks.length > 0 && marks[0]!.n <= nArr) {
      const m = marks.shift()!;
      if (finder.step(m.name, m.n) && dueAt === null) dueAt = m.name;
    }
    const lm = line.lm as { ts: number };
    finder.packet(line.seq, line.tr as TracePair[], lm.ts);
    finder.arrival(line.seq, nArr);
  }
  for (const m of marks) if (finder.step(m.name, m.n) && dueAt === null) dueAt = m.name;
  return { finder, dueAt };
}

function signOf(opts: DeepBreathTakeOptions) {
  return feed(deepBreathTake(opts)).finder.result();
}

describe('the trace sign from the three paced deep breaths (spec 7.4, 7.11)', () => {
  it('finds +1 when the inhales raise the trace and -1 when they lower it', () => {
    const up = signOf({});
    expect(up).toMatchObject({ sign: 1, agree: true, margin: true, use: 1, why: null });
    expect(up.d).toHaveLength(3);
    for (const d of up.d) expect(d).toBeGreaterThan(0.8);
    const down = signOf({ signs: [-1, -1, -1] });
    expect(down).toMatchObject({ sign: -1, agree: true, margin: true, use: -1, why: null });
    for (const d of down.d) expect(d).toBeLessThan(-0.8);
  });

  it('puts the inhale steps on the camera clock through the arrivals of the packets', () => {
    const take = deepBreathTake({ latencyS: 0.31 });
    const r = feed(take).finder.result();
    expect(r.windows).toHaveLength(3);
    r.windows.forEach((w, i) => {
      expect(Math.abs(w.startUs - take.windowsUs[i]!.startUs)).toBeLessThan(1_000);
      expect(Math.abs(w.endUs - take.windowsUs[i]!.endUs)).toBeLessThan(1_000);
    });
  });

  it('gives no sign when the breaths disagree', () => {
    const r = signOf({ signs: [1, -1, 1] });
    expect(r).toMatchObject({ sign: null, agree: false, use: null, why: 'the deep breaths do not move the trace the same way' });
    expect(r.d[1]).toBeLessThan(0);
  });

  it('gives no sign when the smallest change is under a third of the largest, though the breaths agree', () => {
    const r = signOf({ amps: [1, 0.2, 1] });
    expect(r).toMatchObject({ sign: 1, agree: true, margin: false, use: null });
    expect(r.why).toMatch(/under a third of the largest/);
    // At a third and above the sign holds.
    expect(signOf({ amps: [1, 0.45, 1] })).toMatchObject({ use: 1, margin: true });
  });

  it('gives no sign without both marks of every inhale, or without packets to map them', () => {
    const take = deepBreathTake();
    const twoBreaths = new DeepBreathSign();
    for (const m of take.marks.slice(0, 3)) twoBreaths.step(m.name, m.n);
    expect(twoBreaths.result()).toMatchObject({ use: null, why: 'only 1 of 3 deep breaths have both marks' });
    const noArrivals = new DeepBreathSign();
    for (const m of take.marks) noArrivals.step(m.name, m.n);
    for (const line of take.lines) noArrivals.packet(line.seq, line.tr as TracePair[]);
    expect(noArrivals.result()).toMatchObject({ use: null, why: 'too few trace packets to put the deep breaths on the camera clock' });
  });

  it('keeps the first value of a camera timestamp, as the analysis does', () => {
    const take = deepBreathTake({ signs: [-1, -1, -1] });
    const { finder } = feed(take);
    const before = finder.result();
    // Every packet again under a new seq, with a value that would flip the sign: it is ignored.
    for (const line of take.lines) {
      const ts = (line.tr as TracePair[])[0]![0];
      finder.packet(100_000 + line.seq, [[ts, 50]]);
    }
    const r = finder.result();
    expect(r.use).toBe(-1);
    expect(r.d).toEqual(before.d);
  });

  it('says the sign is due at the step after the last exhale, once', () => {
    const { dueAt } = feed(deepBreathTake());
    expect(dueAt).toBe('rest_1');
    const f = new DeepBreathSign();
    expect(f.sawBreaths).toBe(false);
    expect(f.step('breathe_normally', 0)).toBe(false);
    expect(f.step(inhaleStep(1), 10)).toBe(false);
    expect(f.sawBreaths).toBe(true);
    expect(f.step(exhaleStep(3), 20)).toBe(false);
    expect(f.step(exhaleStep(3), 21)).toBe(false);
    expect(f.step('rest_1', 30)).toBe(true);
    expect(f.step('demo_clicks', 40)).toBe(false);
    expect(inhaleStep(2)).toBe('deep_2_in');
    expect(exhaleStep(2)).toBe('deep_2_out');
  });

  it('ignores an arr stamp of a packet it never saw', () => {
    const f = new DeepBreathSign();
    f.arrival(7, 1_000);
    for (const m of deepBreathTake().marks) f.step(m.name, m.n);
    expect(f.result().why).toBe('too few trace packets to put the deep breaths on the camera clock');
  });

  it('sampleToCameraUs inverts the lower envelope (analysis/lib/measure.ts)', () => {
    const env = { x0Us: 1_000_000_000_000, slope: 0.001, intercept: 0.1, windows: 3 };
    const n = 48_000 * (0.1 + 1.001 * 5);
    expect(sampleToCameraUs(env, n)).toBeCloseTo(env.x0Us + 5e6, 3);
  });

  it('has the error text the page shows', () => {
    expect(DEEP_BREATH_SIGN_ERROR).toBe('The chest trace gave no clear direction on the deep breaths, so in this run only the voice stops the narrator.');
  });
});
