// What the clock functions read when samples.jsonl lacks the SDK packets (spec 8.1): `m` lines
// rebuilt from detector_in.jsonl, which keeps the trace, the talking flag and the lip gap g.

import type { SampleLine } from '../../core/clock/index.ts';
import type { DetectorInLine } from '../../core/schemas/index.ts';
import type { LoadedSession } from '../lib/session.ts';

export type SampleSource = 'samples.jsonl' | 'detector_in.jsonl' | 'none';

/**
 * Packet lines rebuilt from detector_in.jsonl: each `batch` becomes an `m` line and each `val` a
 * `v` line. detector_in.jsonl drops the landmarks, so the frame time of the lip gap is taken as the
 * newest timestamp of the batch's trace and talking samples (assumption: they come from the same frame).
 */
export function samplesFromDetectorIn(lines: readonly DetectorInLine[]): SampleLine[] {
  const out: SampleLine[] = [];
  for (const l of lines) {
    if (l.k === 'batch') {
      let ts = Number.NEGATIVE_INFINITY;
      for (const [t] of l.tr) if (t > ts) ts = t;
      for (const [t] of l.talk) if (t > ts) ts = t;
      const line: SampleLine = { seq: l.seq, k: 'm', tr: l.tr, talk: l.talk, g: l.g, hm: l.hm };
      line.lm = typeof l.g === 'number' && Number.isFinite(ts) ? { ts, reset: 0, p: [] } : null;
      out.push(line);
    } else if (l.k === 'val') {
      out.push({ seq: l.seq, k: 'v', code: l.code });
    }
  }
  return out;
}

/** The sample lines the clock check reads, and where they came from. */
export function clockSamples(s: Pick<LoadedSession, 'samples' | 'detectorIn'>): { samples: SampleLine[]; source: SampleSource } {
  if (s.samples.some((l) => l.k === 'm')) return { samples: [...s.samples], source: 'samples.jsonl' };
  const rebuilt = samplesFromDetectorIn(s.detectorIn);
  if (rebuilt.some((l) => l.k === 'm')) {
    // Keep samples.jsonl's other lines (status, errors, event-loop delay) when there are any.
    const hasStatus = s.samples.some((l) => l.k === 'v');
    return {
      samples: [...s.samples, ...rebuilt.filter((l) => l.k === 'm' || !hasStatus)],
      source: 'detector_in.jsonl',
    };
  }
  return { samples: [...s.samples], source: s.samples.length > 0 ? 'samples.jsonl' : 'none' };
}
