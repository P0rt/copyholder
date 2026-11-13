import { beforeAll, describe, expect, it } from 'vitest';
import {
  CHUNK_SAMPLES,
  FADE_SAMPLES,
  QUANTUM_SAMPLES,
  SAMPLE_RATE_HZ,
  arrivalsBySeq,
  chunkLayout,
  clickWaveform,
  traceRateMedian,
  type SessionData,
} from '../../core/clock/index.ts';
import { validateEventLine, validateSampleLine, validateStampLine } from '../../core/schemas/index.ts';
import { makeSyntheticSession, type SyntheticSession } from './session.ts';

const R = SAMPLE_RATE_HZ;

function checksum(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 97) s += a[i]! * ((i % 13) + 1);
  return s;
}

function rms(a: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / (to - from));
}

/** Every stamps, samples and events line through the core/schemas validators; the problems found. */
function schemaProblems(session: SessionData): string[] {
  return [
    ...session.stamps.flatMap((l, i) => validateStampLine(l).map((p) => `stamps[${i}] ${p}`)),
    ...session.samples.flatMap((l, i) => validateSampleLine(l).map((p) => `samples[${i}] ${p}`)),
    ...session.events.flatMap((l, i) => validateEventLine(l).map((p) => `events[${i}] ${p}`)),
  ];
}

describe('makeSyntheticSession: default numbers session', () => {
  let clean: SyntheticSession;
  beforeAll(() => {
    clean = makeSyntheticSession();
  });

  it('is deterministic for a seed', () => {
    const again = makeSyntheticSession();
    expect(checksum(again.session.ch0)).toBe(checksum(clean.session.ch0));
    expect(checksum(again.session.ch1)).toBe(checksum(clean.session.ch1));
    expect(JSON.stringify(again.session.samples)).toBe(JSON.stringify(clean.session.samples));
    expect(again.session.stamps).toEqual(clean.session.stamps);
    expect(again.truth).toEqual(clean.truth);
    expect(checksum(makeSyntheticSession({ seed: 2 }).session.ch0)).not.toBe(checksum(clean.session.ch0));
  });

  it('writes lines that pass the core/schemas validators', () => {
    expect(schemaProblems(clean.session)).toEqual([]);
  });

  it('records two 48 kHz channels in 9600-sample blocks from sample 0, the last one shorter', () => {
    const { session, truth } = clean;
    expect(session.sampleRateHz).toBe(R);
    expect(session.ch0.length).toBe(truth.totalSamples);
    expect(session.ch1.length).toBe(truth.totalSamples);
    const chunks = session.stamps.filter((s) => s.k === 'chunk');
    const count = Math.ceil(truth.totalSamples / CHUNK_SAMPLES);
    expect(chunks.map((c) => c.n)).toEqual(Array.from({ length: count }, (_, i) => i * CHUNK_SAMPLES));
    expect(chunks.slice(0, -1).every((c) => c.frames === CHUNK_SAMPLES)).toBe(true);
    expect(chunks.at(-1)!.frames).toBe(truth.totalSamples - (count - 1) * CHUNK_SAMPLES);
    expect(chunks.at(-1)!.frames).toBeLessThan(CHUNK_SAMPLES);
    expect(chunkLayout(session.stamps, session.ch0.length).contiguous).toBe(true);
  });

  it('orders stamps as host writes them: by sample, each chunk stamp after its block', () => {
    const { stamps } = clean.session;
    const deck = stamps.filter((s) => s.k !== 'chunk').map((s) => s.n);
    expect(deck).toEqual([...deck].sort((a, b) => a - b));
    let maxBefore = Number.NEGATIVE_INFINITY;
    stamps.forEach((s, i) => {
      if (s.k !== 'chunk') {
        maxBefore = Math.max(maxBefore, s.n);
        return;
      }
      const end = s.n + s.frames!;
      expect(maxBefore).toBeLessThan(end);
      const next = stamps.slice(i + 1).find((x) => x.k !== 'chunk');
      if (next) expect(next.n).toBeGreaterThanOrEqual(end);
    });
  });

  it('plays two loop checks of 10 clicks in channel 1 and logs their stamps', () => {
    const { session, truth } = clean;
    const clicks = session.stamps.filter((s) => s.k === 'click');
    expect(clicks.map((c) => c.i)).toEqual([...Array(10).keys(), ...Array(10).keys()]);
    expect(clicks.map((c) => c.n)).toEqual([...truth.clicks.A, ...truth.clicks.B]);
    const w = clickWaveform();
    expect(Array.from(session.ch1.subarray(truth.clicks.A[3]!, truth.clicks.A[3]! + w.length))).toEqual(Array.from(w));
  });

  it('writes samples.jsonl as tap does: arrival order, seq over SDK callbacks, no seq on l lines', () => {
    const { samples } = clean.session;
    const tArr = samples.map((l) => BigInt(l.tArrNs!));
    expect(tArr.every((t, i) => i === 0 || t >= tArr[i - 1]!)).toBe(true);
    const seqs = samples.filter((l) => l.k !== 'l').map((l) => l.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
    expect(samples.filter((l) => l.k === 'l').every((l) => l.seq === undefined && l.p99Ms! > 0)).toBe(true);
    expect(samples[0]).toMatchObject({ k: 's', code: 3, name: 'kRunning' });
    // A frame's frameSentThrough line arrives before its metrics packet.
    const m = samples.filter((l) => l.k === 'm');
    const firstSent = samples.findIndex((l) => l.k === 'f' && l.tsCbUs === m[5]!.tr![0]![0]);
    expect(firstSent).toBeLessThan(samples.indexOf(m[5]!));
  });

  it('sends about 30 packets per second with arrival stamps on the 128-sample quantum', () => {
    const { session } = clean;
    const m = session.samples.filter((l) => l.k === 'm');
    expect(traceRateMedian(session.samples)).toBe(30);
    const arr = arrivalsBySeq(session.stamps);
    expect(arr.size).toBe(m.length);
    let prevN = 0;
    let prevTs = 0;
    for (const line of m) {
      const n = arr.get(line.seq!)!;
      expect(n % QUANTUM_SAMPLES).toBe(0);
      expect(n).toBeGreaterThanOrEqual(prevN);
      const ts = line.tr![0]![0];
      expect(ts).toBeGreaterThan(prevTs);
      expect(line.lm!.ts).toBe(ts);
      expect(line.lm!.p).toHaveLength(16);
      prevN = n;
      prevTs = ts;
    }
  });

  it('stops the narrator live: fade from nCmd, exact zeros from nSilent to the resume', () => {
    const { session, truth } = clean;
    expect(truth.stops).toHaveLength(3);
    const arr = arrivalsBySeq(session.stamps);
    for (const [i, s] of truth.stops.entries()) {
      expect(s.cause).toBe('chest');
      expect(s.nSilent).toBe(s.nCmd + FADE_SAMPLES);
      expect(arr.get(s.seq!)).toBe(s.nCmd);
      expect(s.nSilent / R + truth.lrtMs.A / 1000).toBeLessThan(truth.voiceOnsets[i]! / R);
      for (let n = s.nSilent; n < s.nResume; n++) expect(session.ch1[n]).toBe(0);
      const hold = session.stamps.find((x) => x.k === 'hold' && x.n === s.nCmd)!;
      expect(hold).toMatchObject({ cause: 'chest', seq: s.seq, nSilent: s.nSilent });
      expect(session.stamps.some((x) => x.k === 'resume' && x.n === s.nResume)).toBe(true);
      expect(session.events.filter((e) => e.n === s.nCmd).map((e) => e.e).sort()).toEqual(['fire', 'hold']);
    }
  });

  it('leaks the narrator into channel 0 at -40 dB, delayed by L_rt', () => {
    const { session, truth } = clean;
    const d = Math.round((truth.lrtMs.A * R) / 1000);
    const from = truth.narration[0];
    const to = from + 4 * R;
    let xy = 0;
    let xx = 0;
    for (let n = from; n < to; n++) {
      xy += session.ch1[n]! * session.ch0[n + d]!;
      xx += session.ch1[n]! * session.ch1[n]!;
    }
    expect(xy / xx).toBeCloseTo(0.01, 3);
    expect(rms(session.ch1, from, to)).toBeGreaterThan(0.02);
  });

  it('puts voice replies on channel 0 far above the noise floor', () => {
    const { session, truth } = clean;
    const floor = rms(session.ch0, truth.steps['headset']!, truth.steps['headset']! + R);
    for (const nV of truth.voiceOnsets) {
      expect(rms(session.ch0, nV - R / 20, nV)).toBeLessThan(4 * floor);
      expect(rms(session.ch0, nV, nV + R / 2) / floor).toBeGreaterThan(30);
    }
  });

  it('logs microphone settings with processing off at 48 kHz', () => {
    expect(clean.session.micSettings).toMatchObject({
      sampleRate: R,
      contextSampleRate: R,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });
});

describe('makeSyntheticSession: other scenarios and faults', () => {
  it('builds a gate recording: sniffs, cues with replies, no live stops', () => {
    const { session, truth } = makeSyntheticSession({ scenario: 'gate', narrationS: 20, replies: 3 });
    expect(truth.sniffOnsets).toHaveLength(5);
    expect(truth.cues).toHaveLength(3);
    expect(truth.voiceOnsets.every((n, i) => n > truth.cues[i]!)).toBe(true);
    expect(truth.stops).toEqual([]);
    expect(session.stamps.some((s) => s.k === 'hold')).toBe(false);
    const cueMarks = session.stamps.filter((s) => s.k === 'mark' && s.what === 'cue');
    expect(cueMarks.map((s) => [s.n, s.on])).toEqual(truth.cues.flatMap((n) => [[n, true], [n + 72_000, false]]));
    expect(session.stamps.filter((s) => s.k === 'voice')).toHaveLength(6);
    // Step names of web/scenarios/gate.ts.
    expect(Object.keys(truth.steps)).toEqual(
      expect.arrayContaining([
        'loop_a_ready', 'loop_a', 'headset', 'breathe_normally', 'deep_1_in', 'deep_3_out', 'sniff_1_wait', 'sniff_5',
        'rest_1', 'pa_start_1_closed', 'pa_start_5', 'rest_2', 'listening', 'objections', 'pa_end_1_closed', 'pa_end_5',
        'loop_b_ready', 'loop_b', 'end',
      ]),
    );
    // Each sniff and each 'pa' follows its prompt.
    truth.sniffOnsets.forEach((n, i) => expect(n).toBeGreaterThan(truth.steps[`sniff_${i + 1}`]!));
    truth.paBursts.start.forEach((n, i) => expect(n).toBeGreaterThan(truth.steps[`pa_start_${i + 1}`]!));
    expect(truth.listeningEnd).toBe(truth.narration[0] + 10 * R);
    expect(schemaProblems(session)).toEqual([]);
  });

  it('builds a recording without the camera: no SDK lines, stops by voice', () => {
    const { session, truth } = makeSyntheticSession({ camera: false, narrationS: 16 });
    expect(session.samples).toEqual([]);
    expect(session.stamps.some((s) => s.k === 'arr')).toBe(false);
    expect(truth.stops.map((s) => s.cause)).toEqual(['voice', 'voice', 'voice']);
    // The audio insurance acts after voice_on plus 250 ms: never before the voice (spec 6.4).
    expect(truth.stops.every((s, i) => s.seq === null && s.nCmd > truth.voiceOnsets[i]! + 0.28 * R)).toBe(true);
    expect(schemaProblems(session)).toEqual([]);
  });

  it('drops one block from the audio and from the stamps, as host records a gap', () => {
    const { session, truth } = makeSyntheticSession({ narrationS: 16, faults: { dropChunk: true } });
    expect(session.ch0.length).toBe(truth.totalSamples - CHUNK_SAMPLES);
    expect(session.stamps.some((s) => s.k === 'chunk' && s.n === truth.droppedChunkN0)).toBe(false);
    // live/lib/session-store.cjs: written when the next block arrives, n = lastN() = expected n0.
    expect(session.events.filter((e) => e.e === 'audio_gap')).toEqual([
      {
        n: truth.droppedChunkN0,
        e: 'audio_gap',
        by: 'host',
        expected: truth.droppedChunkN0,
        got: truth.droppedChunkN0! + CHUNK_SAMPLES,
        missing: CHUNK_SAMPLES,
      },
    ]);
  });

  it('slows the SDK to 15 frames per second on request', () => {
    const { session } = makeSyntheticSession({ narrationS: 16, faults: { traceRateHz: 15 } });
    expect(traceRateMedian(session.samples)).toBe(15);
  });

  it('writes the fault lines in the shapes tap, host and the page use', () => {
    const faults = [
      { sdkError: true },
      { tapLost: true },
      { hardEvent: 'hidden' as const },
      { hardEvent: 'track_mute' as const },
      { dropChunk: true },
    ];
    for (const f of faults) {
      const { session } = makeSyntheticSession({ narrationS: 16, faults: f });
      expect(schemaProblems(session)).toEqual([]);
    }
    const err = makeSyntheticSession({ narrationS: 16, faults: { sdkError: true } }).session;
    expect(err.samples.filter((l) => l.k === 'e')).toEqual([expect.objectContaining({ code: 5, name: 'kNetworkError' })]);
    // Host lines carry by 'host' and n = lastN(): the end of a stored block.
    const [sdk] = err.events.filter((e) => e.e === 'sdk_error');
    expect(sdk).toEqual({ n: expect.any(Number), e: 'sdk_error', by: 'host', code: 5, name: 'kNetworkError', message: 'synthetic fault' });
    expect(sdk!.n! % CHUNK_SAMPLES).toBe(0);
    const lost = makeSyntheticSession({ narrationS: 16, faults: { tapLost: true } }).session;
    const [tap] = lost.events.filter((e) => e.e === 'tap_lost');
    expect(tap).toMatchObject({ e: 'tap_lost', by: 'host', why: 'silence' });
    expect(tap!.n! % CHUNK_SAMPLES).toBe(0);
  });

  it('refuses more replies than the narration holds', () => {
    expect(() => makeSyntheticSession({ narrationS: 10, replies: 5 })).toThrow(RangeError);
  });
});
