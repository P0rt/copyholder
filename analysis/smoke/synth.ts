// Synthetic smoke session for tests (spec 7.12, 8.1): the files host, Deck and tap write for one
// smoke run, in the formats of live/tap.cjs (samples.jsonl lines made by reduce.cjs itself,
// sdk_raw.jsonl.gz, tap's console saved as tap.log) or of live/mock-tap.cjs (no sdk_raw, no log).
// No SDK is involved: the decoded messages are built in the layout reduce.cjs reads.
// Deterministic: no clock and no randomness.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildSmokeScenario } from '../../web/scenarios/smoke.ts';
import { encodeStereoFloatWav } from '../lib/wav.ts';
import { REDUCE_PATH } from './reduce-adapter.ts';

type Obj = Record<string, unknown>;
interface LongLike {
  low: number;
  high: number;
  unsigned: boolean;
  toNumber(): number;
}

/** The parts of live/reduce.cjs that tap uses to write its files. */
interface ReduceForSynth {
  LANDMARKS: readonly number[];
  DRY_API: Obj;
  initialState(): unknown;
  reduce(state: unknown, msg: unknown, meta: { seq: number; tArrNs: string; tsCbUs: unknown }): { state: unknown; line: Obj };
  probeMetrics(msg: unknown): Obj;
  typeName(v: unknown): string;
  longLike(n: number): LongLike;
  rawLine(seq: number, kind: string, tArrNs: string, tWallMs: number, body: Obj): string;
  validationLine(seq: number, tArrNs: string, tsCbUs: unknown, code: number, hint: string): Obj;
  processingLine(seq: number, tArrNs: string, code: number): Obj;
  frameLine(seq: number, tArrNs: string, tsCbUs: unknown, sent: boolean): Obj;
  errorLine(seq: number, tArrNs: string, code: number, message: string, retryable: boolean): Obj;
  loopLine(tArrNs: string, stats: Obj): Obj;
  enumReport(sdkModule: unknown): string[];
  processingName(code: number): string;
  validationName(code: number): string;
  errorName(code: number): string;
}

let reduceLoaded: ReduceForSynth | null = null;
function R(): ReduceForSynth {
  if (reduceLoaded === null) reduceLoaded = createRequire(import.meta.url)(REDUCE_PATH) as ReduceForSynth;
  return reduceLoaded;
}

/** Camera-time streams a stray timestamp can be put into (see SynthOptions.strayTimestamps). */
export type StrayStream = 'trace' | 'talk' | 'landmarks' | 'frames' | 'callback';

export interface SynthOptions {
  /** 'tap': live/tap.cjs (default); 'mock': live/mock-tap.cjs. */
  format?: 'tap' | 'mock';
  id?: string;
  /** Camera frames per second (default 30). */
  fps?: number;
  /** Trace samples per second (default: one per frame). */
  traceRateHz?: number;
  /** Trace samples per second during the quiet minute with the screen recording on. */
  screenRecordingRateHz?: number;
  /** Sign of the trace change on the cued inhales (default 1). */
  polarity?: 1 | -1;
  /** false: processingStatus stays kStarting and no packet arrives. */
  running?: boolean;
  /** One SDK error at a run time in seconds; host aborts the run unless it is tap's restart (code 8 before Running). */
  sdkError?: { code: number; atS: number } | null;
  /** Decoded timestamps as protobufjs Longs (the probe then says Long; tap converts them for the files). */
  longTimestamps?: boolean;
  /** Camera times written into the files as JSON Longs {low, high, unsigned} (a writer that does not convert). */
  longJson?: boolean;
  /** Decoded trace under breathing.upper_trace instead of breathing.upperTrace (chestSamples finds nothing). */
  traceFieldMissing?: boolean;
  /** Decoded times under timestampUs instead of timestamp (stampOf finds nothing). */
  stampFieldMissing?: boolean;
  /** Mesh points as [x, y] arrays instead of {x, y} (pointXY finds nothing). */
  pointsAsArrays?: boolean;
  /** Trace values under `val` instead of `value` (traceValue finds nothing, every trace sample is dropped). */
  traceValueMissing?: boolean;
  /**
   * A stray camera time (0, -1, ...) in one sample of a stream: the first trace, talking and landmark
   * sample of the run, the second frameSentThrough, the timestampUs of the tenth packet.
   */
  strayTimestamps?: Partial<Record<StrayStream, number>>;
  /** Packet 1 carries no sample (only a breathing rate); tap then probes the first packet with landmarks too. */
  firstPacketEmpty?: boolean;
  /** No metrics packet until this long after Running (frameSentThrough goes on). */
  firstPacketDelayS?: number;
  /** What tap printed for checkDeviceReadiness() (default 'ready'). */
  readiness?: 'ready' | 'failed' | 'timeout';
  /** No packet at all for this long from 0.2 s into the lens cover. */
  lensGapMs?: number;
  /** Write tap.log (tap format only; default true). */
  tapLog?: boolean;
  /** Extra lines of the SDK log (kInfo) in tap.log. */
  sdkLogLines?: string[];
  /** Write a short audio.wav so analysis/lib/session.ts loads the folder (default true). */
  audio?: boolean;
  /** Extra host events for events.jsonl, at run times in seconds. */
  events?: { atS: number; e: string; fields?: Obj }[];
  /** Cut this many bytes off the end of sdk_raw.jsonl.gz (a crash during a write). */
  cutRawBytes?: number;
  /** manifest.json dry: tap ran its stand-in SDK (spec 6.5; default false, as host writes it). */
  dry?: boolean;
}

export interface SynthResult {
  dir: string;
  id: string;
  /** Step marks: name -> run time in seconds. */
  steps: Map<string, number>;
  runningS: number | null;
  packets: number;
  traceSamples: number;
}

export const SYNTH_RATE_HZ = 48_000;
/** Wall clock at audio sample 0 (ms since the epoch) and tap's hrtime there (ns). */
const W0_MS = 1_794_935_000_000;
const H0_NS = 812_345_678_901_234n;
const START_S = 1.0;
const WAIT_S = 2.0;
const CAMERAS = ['FaceTime HD Camera', 'Desk View Camera'];

const nOf = (t: number): number => Math.round(t * SYNTH_RATE_HZ);
const hr = (t: number): string => (H0_NS + BigInt(Math.round(t * 1e9))).toString();
const wallMs = (t: number): number => Math.floor(W0_MS + t * 1000);
const camUs = (t: number): number => Math.round(W0_MS * 1000 + t * 1e6);
const utc = (t: number): string => new Date(W0_MS + t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** One SDK callback at tap: its arrival time and what it writes once its seq is known. */
interface Callback {
  t: number;
  order: number;
  write(seq: number, tArrNs: string, tWall: number): { sample?: Obj; raw?: string; arrSeq?: boolean };
}

/** Base face mesh: 478 points in frame pixels, eyes and nose placed as in reduce.cjs syntheticMetrics. */
function baseMesh(): { x: number; y: number }[] {
  const pts = Array.from({ length: 478 }, (_, k) => ({ x: 560 + (k % 32) * 5, y: 330 + Math.floor(k / 32) * 12 }));
  const put = (k: number, x: number, y: number) => {
    pts[k] = { x, y };
  };
  put(33, 580, 380);
  put(263, 700, 380);
  put(133, 615, 380);
  put(362, 665, 380);
  put(1, 640, 430);
  put(78, 600, 474);
  put(308, 680, 474);
  return pts;
}

/** Mesh of one frame: lips a little open (upper above lower: y[13] < y[14]). */
function frameMesh(base: readonly { x: number; y: number }[], t: number): { x: number; y: number }[] {
  const pts = base.slice();
  const gap = 8 + 3 * Math.sin(2 * Math.PI * 0.2 * t);
  for (const [up, low, x, d] of [
    [13, 14, 640, 0],
    [82, 87, 628, 1],
    [312, 317, 652, 1],
    [81, 178, 620, 2],
    [311, 402, 660, 2],
  ] as const) {
    pts[up] = { x, y: 470 };
    pts[low] = { x, y: 470 + gap - d };
  }
  pts[1] = { x: 640 + 2 * Math.sin(Math.PI * t), y: 430 };
  return pts;
}

/** Trace value: quiet breathing plus a ramp on each cued deep breath (in over 2 s, out over 4 s). */
function traceValue(t: number, deep: readonly { inS: number; outS: number; endS: number }[], polarity: number): number {
  let v = 0.1 * Math.sin((2 * Math.PI * t) / 4);
  for (const d of deep) {
    if (t >= d.inS && t < d.outS) v += polarity * ((t - d.inS) / (d.outS - d.inS));
    else if (t >= d.outS && t < d.endS) v += polarity * (1 - (t - d.outS) / (d.endS - d.outS));
  }
  return Math.round(v * 1e6) / 1e6;
}

/** Writes one smoke session folder; returns where its steps fell. */
export function writeSmokeSession(dir: string, o: SynthOptions = {}): SynthResult {
  const format = o.format ?? 'tap';
  const id = o.id ?? 'smoke-1';
  const fps = o.fps ?? 30;
  const traceRate = o.traceRateHz ?? fps;
  const polarity = o.polarity ?? 1;
  const running = o.running !== false;
  mkdirSync(dir, { recursive: true });
  const r = R();

  // Step marks of web/scenarios/smoke.ts on the run clock; sdk_start waits until Running.
  const marks: { name: string; t: number }[] = [];
  let t = START_S;
  for (const s of buildSmokeScenario()) {
    marks.push({ name: s.name, t });
    t += s.k === 'wait' ? WAIT_S : s.lenSamples / SYNTH_RATE_HZ;
  }
  const at = (name: string): number => {
    const m = marks.find((x) => x.name === name);
    if (!m) throw new Error(`smoke scenario has no step ${name}`);
    return m.t;
  };
  const tRun = at('signal_ok');
  let tEnd = at('end');
  const err = o.sdkError ?? null;
  const restart = err !== null && err.code === 8 && err.atS < tRun;
  if (err !== null && !restart) tEnd = Math.min(tEnd, err.atS + 0.3);
  if (!running) tEnd = START_S + 20;
  const keptMarks = running ? marks.filter((m) => m.t <= tEnd) : marks.filter((m) => m.name === 'sdk_start');

  const deep = [1, 2, 3].map((i) => ({ inS: at(`deep_${i}_in`), outS: at(`deep_${i}_out`), endS: at(`deep_${i}_out`) + 4 }));
  const quiet = { from: at('quiet'), to: at('lens_ready') };
  const cover = { from: at('lens_cover'), to: at('lens_uncover') };
  const noFace = { from: cover.from + 0.3, to: cover.to + 0.5 };
  const gap = o.lensGapMs ? { from: cover.from + 0.2, to: cover.from + 0.2 + o.lensGapMs / 1000 } : null;
  const T = (us: number): unknown => (o.longJson ? (({ low, high, unsigned }) => ({ low, high, unsigned }))(r.longLike(us)) : o.longTimestamps ? r.longLike(us) : us);

  const callbacks: Callback[] = [];
  let order = 0;
  const add = (tAt: number, write: Callback['write']) => callbacks.push({ t: tAt, order: order++, write });
  const loops: { t: number; line: Obj }[] = [];
  const mock = format === 'mock';

  // processingStatus and validationStatus.
  add(START_S + 0.2, (seq, tArr, tWall) => ({
    sample: mock ? { seq, k: 's', tArrNs: tArr, code: 2, name: r.processingName(2) } : r.processingLine(seq, tArr, 2),
    raw: mock ? undefined : r.rawLine(seq, 'processingStatus', tArr, tWall, { args: [2] }),
  }));
  if (running) {
    add(tRun - 0.05, (seq, tArr, tWall) => ({
      sample: mock ? { seq, k: 's', tArrNs: tArr, code: 3, name: r.processingName(3) } : r.processingLine(seq, tArr, 3),
      raw: mock ? undefined : r.rawLine(seq, 'processingStatus', tArr, tWall, { args: [3] }),
    }));
    const validation = (tAt: number, code: number) =>
      add(tAt, (seq, tArr, tWall) => {
        const ts = camUs(tAt - 0.03);
        return {
          sample: mock
            ? { seq, k: 'v', tArrNs: tArr, tsCbUs: camUs(tAt), code, name: r.validationName(code), hint: '' }
            : r.validationLine(seq, tArr, ts, code, ''),
          raw: mock ? undefined : r.rawLine(seq, 'validationStatus', tArr, tWall, { tsCbUs: ts, args: [code, T(ts), ''] }),
        };
      });
    validation(tRun, 0);
    if (cover.from < tEnd) {
      validation(cover.from + 0.4, 1);
      if (cover.to + 0.8 < tEnd) validation(cover.to + 0.8, 0);
    }
  }
  if (err !== null && err.atS <= tEnd) {
    add(err.atS, (seq, tArr, tWall) => ({
      sample: mock
        ? { seq, k: 'e', tArrNs: tArr, code: err.code, name: r.errorName(err.code), message: 'synthetic SDK error', retryable: false }
        : r.errorLine(seq, tArr, err.code, 'synthetic SDK error', false),
      raw: mock ? undefined : r.rawLine(seq, 'error', tArr, tWall, { args: [err.code, 'synthetic SDK error', false] }),
    }));
  }

  // Frames: frameSentThrough, then the metrics packet.
  const base = baseMesh();
  let state = r.initialState();
  let packets = 0;
  let traceSamples = 0;
  // tap probes packet 1, then the first packet with landmarks (live/tap.cjs handlers.metrics).
  const probeLines: string[] = [];
  let probesDone = 0;
  let packetNo = 0;
  const stray = o.strayTimestamps ?? {};
  const strayAt = (stream: StrayStream, k: number, kAt: number, ts: number): number =>
    k === kAt && stray[stream] !== undefined ? stray[stream]! : ts;
  const firstPacketAt = tRun - 0.05 + (o.firstPacketDelayS ?? 0);
  const frames: { tCap: number; k: number }[] = [];
  if (running) for (let k = 0; tRun + k / fps < tEnd; k++) frames.push({ tCap: tRun + k / fps, k });
  let firstSent: number | null = null;
  for (const { tCap, k } of frames) {
    if (gap && tCap >= gap.from && tCap < gap.to) continue;
    const ts = camUs(tCap);
    const covered = tCap >= noFace.from && tCap < noFace.to;
    const rate = tCap >= quiet.from && tCap < quiet.to && o.screenRecordingRateHz !== undefined ? o.screenRecordingRateHz : traceRate;
    const keepTrace = !covered && (rate >= fps || Math.floor(tCap * rate + 1e-9) > Math.floor((tCap - 1 / fps) * rate + 1e-9));
    const value = traceValue(tCap, deep, polarity);
    const sent = k % 97 !== 50;
    const latency = 0.06 + (0.015 * ((k * 7919) % 10)) / 10;
    const fTs = strayAt('frames', k, 1, ts);
    const withPacket = tCap + latency >= firstPacketAt;
    // The first metrics packet of the run (k0) carries the stray samples and, with firstPacketEmpty, no sample at all.
    if (withPacket && firstSent === null) firstSent = k;
    const k0 = firstSent ?? -1;
    const empty = o.firstPacketEmpty === true && k === k0;
    if (withPacket && keepTrace && !empty) traceSamples++;
    if (withPacket) packets++;
    if (mock) {
      const tEmit = tCap + 0.04;
      add(tEmit, (seq, tArr) => ({ sample: { seq, k: 'f', tArrNs: tArr, tsCbUs: fTs, sent } }));
      if (!withPacket) continue;
      add(tEmit + 1e-6, (seq, tArr) => {
        const pts = frameMesh(base, tCap);
        return {
          sample: {
            seq,
            k: 'm',
            tArrNs: tArr,
            tsCbUs: strayAt('callback', k, k0 + 9, camUs(tEmit)),
            tr: keepTrace && !empty ? [[strayAt('trace', k, k0, ts), value]] : [],
            talk: covered || empty ? [] : [[strayAt('talk', k, k0, ts), 0]],
            g: covered || empty ? null : 0.12,
            hm: covered || empty ? null : 0.01,
            lm: covered || empty ? null : { ts: strayAt('landmarks', k, k0, ts), reset: 0, p: r.LANDMARKS.map((i) => [pts[i]!.x, pts[i]!.y]) },
          },
          arrSeq: true,
        };
      });
      continue;
    }
    add(tCap + 0.01, (seq, tArr, tWall) => ({
      sample: fixLongs(r.frameLine(seq, tArr, fTs, sent), o.longJson === true, T),
      raw: r.rawLine(seq, 'frameSentThrough', tArr, tWall, { tsCbUs: fTs, args: [sent, T(fTs)] }),
    }));
    if (!withPacket) continue;
    add(tCap + latency, (seq, tArr, tWall) => {
      const longs = o.longTimestamps || o.longJson;
      const stampFor = (stream: StrayStream) => {
        const us = strayAt(stream, k, k0, ts);
        return longs ? r.longLike(us) : us;
      };
      const when = (x: Obj, stream: StrayStream): Obj =>
        o.stampFieldMissing ? { ...x, timestampUs: stampFor(stream) } : { ...x, timestamp: stampFor(stream) };
      const sample = when({ [o.traceValueMissing ? 'val' : 'value']: value, stable: true }, 'trace');
      const mesh = frameMesh(base, tCap);
      const msg = empty
        ? { breathing: { rate: [when({ value: 15, stable: false }, 'trace')] } }
        : {
            breathing: o.traceFieldMissing ? { upper_trace: keepTrace ? [sample] : [] } : { upperTrace: keepTrace ? [sample] : [] },
            face: covered
              ? { talking: [], landmarks: [] }
              : {
                  talking: [when({ detected: false, stable: true }, 'talk')],
                  landmarks: [
                    when(
                      { value: o.pointsAsArrays ? mesh.map((q) => [q.x, q.y]) : mesh, stable: true, reset: k === k0 + (o.firstPacketEmpty ? 1 : 0) },
                      'landmarks',
                    ),
                  ],
                },
          };
      const tsCb = strayAt('callback', k, k0 + 9, ts + 20_000);
      const cbStamp = longs ? r.longLike(tsCb) : tsCb;
      const out = r.reduce(state, msg, { seq, tArrNs: tArr, tsCbUs: cbStamp });
      state = out.state;
      packetNo++;
      if (o.tapLog !== false && probesDone < 2 && (packetNo === 1 || out.line['lm'])) {
        probesDone = out.line['lm'] ? 2 : 1;
        probeLines.push(`packet ${packetNo}: ${JSON.stringify({ ...r.probeMetrics(msg), tsCbType: r.typeName(cbStamp) })}`);
      }
      const buf = Buffer.alloc(12);
      buf.writeUInt32LE(k, 0);
      buf.writeDoubleLE(camUs(tRun), 4);
      return {
        sample: fixLongs(out.line, o.longJson === true, T),
        raw: r.rawLine(seq, 'metrics', tArr, tWall, { tsCbUs: tsCb, b64: buf.toString('base64') }),
        arrSeq: true,
      };
    });
  }
  for (let s = START_S + 1; s < tEnd; s += 1) {
    const stats = { p50Ms: 0.3, p99Ms: 1.8, maxMs: 4.2 };
    loops.push({ t: s, line: mock ? { k: 'l', tArrNs: hr(s), ...stats } : r.loopLine(hr(s), { ...stats, n: 98 }) });
  }

  // Seq numbers in arrival order, as tap gives them.
  callbacks.sort((a, b) => a.t - b.t || a.order - b.order);
  const sampleRows: { t: number; line: Obj }[] = [];
  const rawLines: string[] = [];
  const arr: { n: number; k: 'arr'; seq: number }[] = [];
  callbacks.forEach((c, i) => {
    const seq = i + 1;
    const w = c.write(seq, hr(c.t), wallMs(c.t));
    if (w.sample) sampleRows.push({ t: c.t, line: w.sample });
    if (w.raw) rawLines.push(w.raw);
    if (w.arrSeq) arr.push({ n: nOf(c.t + 0.003), k: 'arr', seq });
  });
  sampleRows.push(...loops);
  sampleRows.sort((a, b) => a.t - b.t);

  const stamps = [...keptMarks.map((m) => ({ n: nOf(m.t), k: 'mark', what: 'step', name: m.name })), ...arr].sort((a, b) => a.n - b.n);
  const events: Obj[] = [{ n: nOf(0.5), e: 'consent', by: 'host', at: utc(0.5) }];
  if (running) events.push({ n: nOf(tRun), e: 'tap', by: 'host', status: 'running' });
  if (err !== null && err.atS <= tEnd) {
    const fields = { code: err.code, name: r.errorName(err.code), message: 'synthetic SDK error' };
    events.push({ n: nOf(err.atS + 0.01), e: 'sdk_error', by: 'host', ...fields, ...(restart ? { action: 'reset_restart' } : {}) });
  }
  for (const ev of o.events ?? []) events.push({ n: nOf(ev.atS), e: ev.e, by: 'host', ...ev.fields });
  events.sort((a, b) => (a['n'] as number) - (b['n'] as number));

  const jsonl = (rows: readonly unknown[]) => rows.map((x) => JSON.stringify(x)).join('\n') + (rows.length ? '\n' : '');
  writeFileSync(join(dir, 'samples.jsonl'), jsonl(sampleRows.map((x) => x.line)));
  writeFileSync(join(dir, 'stamps.jsonl'), jsonl(stamps));
  writeFileSync(join(dir, 'events.jsonl'), jsonl(events));
  if (!mock) {
    let gz = gzipSync(rawLines.map((l) => `${l}\n`).join(''));
    if (o.cutRawBytes) gz = gz.subarray(0, Math.max(0, gz.length - o.cutRawBytes));
    writeFileSync(join(dir, 'sdk_raw.jsonl.gz'), gz);
  }
  if (!mock && o.tapLog !== false) {
    const readiness = {
      ready: 'checkDeviceReadiness(): ready (camera and network checks passed)',
      failed: 'tap: checkDeviceReadiness() failed: the camera is busy',
      timeout: 'tap: checkDeviceReadiness() did not settle in 30 s',
    }[o.readiness ?? 'ready'];
    const log = [
      'tap: cameras (copy one name into settings.env as COPYHOLDER_CAMERA_NAME=...):',
      ...CAMERAS,
      ...r.enumReport(r.DRY_API),
      readiness,
      ...(o.sdkLogLines ?? []),
      ...probeLines,
    ];
    writeFileSync(join(dir, 'tap.log'), `${log.join('\n')}\n`);
  }
  if (o.audio !== false) writeFileSync(join(dir, 'audio.wav'), encodeStereoFloatWav(new Float32Array(480), new Float32Array(480)));
  const manifest = {
    schema: 'session/1',
    id,
    kind: 'smoke',
    started_utc: utc(0),
    app_commit: null,
    tree_clean: null,
    plan_commitment: null,
    sdk: { version: null, metrics: ['CHEST_BREATHING', 'BREATHING_RATE', 'FACE_LANDMARKS', 'TALKING'], launcher: 'node' },
    machine: 'test machine',
    camera: { name: CAMERAS[0], requested: [1280, 720, 30] },
    audio: { microphone: null, output: null, sample_rate: SYNTH_RATE_HZ, mic_flags_off: true, output_gain: null, settings: null },
    mode: 'smoke',
    scenario: 'smoke',
    pack: null,
    tap: mock ? 'mock' : 'real',
    dry: o.dry === true,
    consent_utc: utc(0.5),
    ended_utc: utc(tEnd + 0.5),
    files: {},
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    dir,
    id,
    steps: new Map(keptMarks.map((m) => [m.name, m.t])),
    runningS: running ? tRun : null,
    packets,
    traceSamples,
  };
}

/** A tap line with its camera times as JSON Longs, when the writer does not convert them. */
function fixLongs(line: Obj, longJson: boolean, T: (us: number) => unknown): Obj {
  if (!longJson) return line;
  const out: Obj = { ...line };
  const conv = (v: unknown) => (typeof v === 'number' ? T(v) : v);
  if (out['tsCbUs'] !== undefined) out['tsCbUs'] = conv(out['tsCbUs']);
  for (const key of ['tr', 'talk']) {
    const list = out[key];
    if (Array.isArray(list)) out[key] = list.map((p: unknown) => (Array.isArray(p) ? [conv(p[0]), ...p.slice(1)] : p));
  }
  const lm = out['lm'];
  if (lm && typeof lm === 'object') out['lm'] = { ...(lm as Obj), ts: conv((lm as Obj)['ts']) };
  return out;
}
