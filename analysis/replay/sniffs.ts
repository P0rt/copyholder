// The sniff lag of row 4 recounted from a published gate set, as stage B recounts it from the
// session (analysis/clocks/compute.ts recountSniffLag, spec 6.3, PREREG §4). Stage B finds the
// sniff onsets in audio.wav channel 0 after the sniff_<i> step marks; the set carries them in
// SNIFFS_FILE (analysis/replay/set.ts), as pack finds them with recountSniffLag itself. Everything
// else of the recount is in the set: A_ref is the amplitude of the trace that arrived during the
// listening step, whose span the step marks of marks.jsonl give, the packets and their arrivals are
// those of stream.jsonl (detector_in.jsonl carries the trace of each "m" line of samples.jsonl as
// tap sent it, web/lib/detector-adapter.ts batchFromTapLine, and stream.jsonl the arr stamp of
// each), and L_rt and the trace sign come from calib.json. Pack checks that the recount from the
// set gives what recountSniffLag gives on the session before it writes the file (analysis/pack.ts
// sniffOnsetsJson).

import { chunkLayout, sniffLag, sniffLrtMs, tracePackets, type CalibLrt, type Stamp } from '../../core/clock/index.ts';
import type { DetectorInput } from '../../core/detector.ts';
import type { DetectorInLine, MarkLine } from '../../core/schemas/index.ts';
import { samplesFromDetectorIn } from '../clocks/inputs.ts';
import type { SniffRecount } from '../clocks/compute.ts';
import { listeningAmplitudeRef, SNIFF_SEARCH_MS } from '../clocks/measure.ts';
import { RATE } from '../gate/common.ts';
import type { SessionView } from '../lib/measure.ts';
import { stepSpan, stepStart } from '../lib/session.ts';

/** What the recount reads from a set besides the sniff onsets. */
export interface SetSniffInputs {
  /** stream.jsonl as detector inputs, and the nArr of each packet. */
  inputs: readonly DetectorInput[];
  nArrBySeq: ReadonlyMap<number, number>;
  /** The lines of marks.jsonl. */
  marks: readonly MarkLine[];
  /** The step of the listening block (lib/steps.ts GateSteps listening). */
  listening: string;
  /** L_rt_ms of calib.json, as core/clock reads it (gate/common.ts coreLrtOf). */
  lrt: CalibLrt;
  /** The trace sign of calib.json (gate/stage-a.ts signOf). */
  sign: 1 | -1;
}

/**
 * The session view the recount needs, built from the set: the step marks of marks.jsonl, an arr
 * stamp per packet of stream.jsonl, and an "m" line per packet (clocks/inputs.ts
 * samplesFromDetectorIn, which keeps the trace). No audio: the onsets come from the file.
 */
function setView(a: SetSniffInputs): SessionView {
  const arrivals = [...a.nArrBySeq].map(([seq, n]) => ({ n, k: 'arr', seq }));
  return {
    sampleRateHz: RATE,
    ch0: new Float32Array(0),
    ch1: new Float32Array(0),
    stamps: [...a.marks, ...arrivals] as unknown as Stamp[],
    samples: samplesFromDetectorIn(a.inputs as unknown as DetectorInLine[]),
    events: [],
    micSettings: null,
    layout: chunkLayout([], 0),
  };
}

/** The recount of recountSniffLag on the set, with `onsets` (SNIFFS_FILE) in place of the search in audio.wav. */
export function sniffRecountFrom(a: SetSniffInputs, onsets: readonly number[]): SniffRecount {
  const view = setView(a);
  const aRef = listeningAmplitudeRef(view, stepSpan(view, a.listening)).aRef;
  const lag = aRef !== null && aRef > 0 ? sniffLag({ onsets, packets: tracePackets(view), aRef, lrtMs: sniffLrtMs(a.lrt), sign: a.sign }) : null;
  return { onsets: [...onsets], aRef, lag };
}

/**
 * Checks the sniff onsets of SNIFFS_FILE against the step marks of marks.jsonl: stage B searches
 * each onset from its 'Sniff' prompt for at most 2 s (clocks/measure.ts sniffOnsets), prompt after
 * prompt, so the onsets, in prompt order, each lie within 2 s after the mark of a sniff step of its
 * own. Problems in plain words; none for onsets that fit.
 */
export function sniffOnsetsProblems(onsets: readonly number[], marks: readonly MarkLine[], sniffSteps: readonly string[]): string[] {
  const view = { stamps: marks as unknown as Stamp[] };
  const prompts = sniffSteps.map((step) => stepStart(view, step)).filter((n): n is number => n !== null);
  const searchN = (SNIFF_SEARCH_MS * RATE) / 1000;
  let next = 0;
  for (const p of prompts) {
    const n = onsets[next];
    if (n !== undefined && n >= p && n <= p + searchN) next++;
  }
  if (next >= onsets.length) return [];
  const at = onsets[next]!;
  return [
    `onset ${next + 1} of ${onsets.length}, at sample ${at}, lies within 2 s after the mark of no sniff step left in prompt order (${prompts.length} of ${sniffSteps.length} sniff steps have a mark)`,
  ];
}
