// Smoke questions 1 and 2 (spec 7.12): did the camera open in plain Node, and what came back from
// the SDK. When a field is missing, the answer names the reduce.cjs accessor that returned nothing.
// Face point coordinates never enter the report (spec 12.5): only counts and yes/no checks.

import { LANDMARK_IDS } from '../../core/schemas/precision.ts';
import type { SmokeContext } from './context.ts';
import { finitePairs } from './context.ts';
import { quoted } from './numbers.ts';
import { accessorPaths, type AccessorName } from './reduce-adapter.ts';
import { errorLabel, sdkErrorsSeen, type Answer } from './sdk-events.ts';
import { consoleNote, type PacketProbe, type Readiness, type Sourced } from './tap-output.ts';

const REQUESTED_DEFAULT: [number, number, number] = [1280, 720, 30];
/** Error codes that mean the metric set was refused (spec 7.1 table). */
const METRIC_REFUSED_CODES = [3, 13];
const INPUT_UNAVAILABLE = 7;
const MESH_POINTS = 478;

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);

/** [width, height, fps] the run asked for: manifest.json, else tap's camera message, else spec 7.1. */
export function requestedFormat(ctx: SmokeContext): [number, number, number] {
  const fromManifest = asObj(ctx.folder.manifest?.['camera'])?.['requested'];
  const fromTap = ctx.tap.camera?.value.requested;
  for (const r of [fromManifest, fromTap]) {
    if (Array.isArray(r) && r.length === 3 && r.every((x) => typeof x === 'number' && x > 0)) return r as [number, number, number];
  }
  return REQUESTED_DEFAULT;
}

export function launcherOf(ctx: SmokeContext): string | null {
  const l = asObj(ctx.folder.manifest?.['sdk'])?.['launcher'];
  return typeof l === 'string' ? l : null;
}

export function metricSetOf(ctx: SmokeContext): string[] | null {
  const m = asObj(ctx.folder.manifest?.['sdk'])?.['metrics'];
  if (Array.isArray(m) && m.every((x) => typeof x === 'string')) return m as string[];
  return ctx.tap.camera?.value.metrics ?? null;
}

// ---- 1. Start ------------------------------------------------------------------------------

/** tap's readiness verdict; else a readiness failure that reached host as an sdk_error event. */
export function readinessOf(ctx: SmokeContext): Sourced<Readiness> | null {
  if (ctx.tap.readiness !== null) return ctx.tap.readiness;
  const failed = sdkErrorsSeen(ctx).find((e) => e.message !== null && e.message.includes('checkDeviceReadiness()'));
  return failed ? { value: { verdict: null, reason: errorLabel(failed, 200), failed: true }, source: failed.sources.join(', ') } : null;
}

function readinessLine(readiness: Sourced<Readiness> | null, ctx: SmokeContext): string {
  if (readiness === null) return `checkDeviceReadiness(): unknown (${consoleNote(ctx.tap, "tap's console has no readiness line")}).`;
  const r = readiness.value;
  if (r.failed) return `checkDeviceReadiness(): NO VERDICT: ${r.reason ?? 'failed'} (${readiness.source}).`;
  return `checkDeviceReadiness(): ${r.verdict ?? 'null'} (${r.reason ?? 'no reason'}) (${readiness.source}).`;
}

export function answerStart(ctx: SmokeContext): Answer {
  const frameEvents = ctx.byKind.f.length;
  const packets = ctx.packets.length;
  const errors = sdkErrorsSeen(ctx);
  const inputUnavailable = errors.some((e) => e.code === INPUT_UNAVAILABLE);
  const samplesPresent = ctx.folder.inputs.some((i) => i.file === 'samples.jsonl' && i.present);
  // Without samples.jsonl, sdk_raw.jsonl.gz still shows frames and packets (live/tap.cjs logs every callback).
  const rawFrames = samplesPresent ? 0 : ctx.folder.raw.filter((r) => r.kind === 'frameSentThrough').length;
  const rawPackets = samplesPresent ? 0 : ctx.folder.raw.filter((r) => r.kind === 'metrics').length;
  const opened: boolean | null =
    frameEvents + packets + rawFrames + rawPackets > 0 ? true : samplesPresent || inputUnavailable ? false : null;
  const launcher = launcherOf(ctx);
  const camName = ctx.tap.camera?.value.name ?? null;
  const cameras = ctx.tap.cameras;
  const readiness = readinessOf(ctx);

  const lines: string[] = [];
  const how = launcher === 'electron' ? 'under Electron (live:electron)' : launcher === 'node' ? 'in plain Node' : 'launcher not recorded';
  if (opened === true && !samplesPresent) {
    lines.push(`Camera opened: yes, ${how}: ${rawFrames} frameSentThrough events and ${rawPackets} SDK packets in sdk_raw.jsonl.gz (samples.jsonl is missing).`);
  } else if (opened === true) {
    lines.push(`Camera opened: yes, ${how}: ${frameEvents} frameSentThrough events and ${packets} SDK packets arrived.`);
  } else if (opened === false) {
    const labels = [...new Set(errors.map((e) => errorLabel(e)))];
    const why =
      labels.length > 0
        ? `no frame arrived; ${errors.length > 1 ? 'errors' : 'error'}: ${labels.join('; ')}`
        : 'no frame and no packet arrived, and no error was logged';
    // A coded SDK error other than 7 has its own remedy (spec 7.1 table); anything else may be the camera permission of plain Node.
    const explained = errors.some((e) => e.code !== null && e.code !== INPUT_UNAVAILABLE);
    const retry =
      launcher === 'electron' || explained
        ? ''
        : ' If the camera does not open in plain Node, run it again with: npm run live:electron -- smoke (spec 6.7).';
    lines.push(`Camera opened: no (${how}): ${why}.${retry}`);
  } else {
    lines.push('Camera opened: unknown: samples.jsonl is missing and sdk_raw.jsonl.gz shows no frame and no packet.');
  }
  lines.push(
    camName === null
      ? 'Camera used: not recorded (manifest.json and tap output have no name).'
      : `Camera used: "${camName}" (${ctx.tap.camera!.source}).`,
  );
  lines.push(
    cameras === null
      ? `availableCameras(): unknown (${consoleNote(ctx.tap, "tap's console has no camera list")}).`
      : `availableCameras(): ${quoted(cameras.value)} (${cameras.source}).`,
  );
  lines.push(readinessLine(readiness, ctx));
  return {
    n: 1,
    title: 'Start',
    lines,
    data: {
      camera_opened: opened,
      launcher,
      frame_events: samplesPresent ? frameEvents : rawFrames,
      packets: samplesPresent ? packets : rawPackets,
      counted_in: samplesPresent ? 'samples.jsonl' : 'sdk_raw.jsonl.gz',
      input_unavailable_error: inputUnavailable,
      camera_name: camName,
      camera_name_source: ctx.tap.camera?.source ?? null,
      cameras: cameras?.value ?? null,
      cameras_source: cameras?.source ?? null,
      readiness: readiness
        ? { verdict: readiness.value.verdict, reason: readiness.value.reason, failed: readiness.value.failed, source: readiness.source }
        : null,
      requested: requestedFormat(ctx),
    },
  };
}

// ---- 2. Data -------------------------------------------------------------------------------

export interface StreamCounts {
  packets: number;
  packetsWithTrace: number;
  traceSamples: number;
  packetsWithTalk: number;
  talkSamples: number;
  talkingOn: number;
  packetsWithLandmarks: number;
  resetFrames: number;
  /** Kept points (16 per frame) and how many of them were null. */
  keptPoints: number;
  nullPoints: number;
  packetsWithG: number;
  packetsWithHm: number;
}

export function streamCounts(ctx: SmokeContext): StreamCounts {
  const c: StreamCounts = {
    packets: ctx.packets.length,
    packetsWithTrace: 0,
    traceSamples: 0,
    packetsWithTalk: 0,
    talkSamples: 0,
    talkingOn: 0,
    packetsWithLandmarks: 0,
    resetFrames: 0,
    keptPoints: 0,
    nullPoints: 0,
    packetsWithG: 0,
    packetsWithHm: 0,
  };
  const talkTs = new Set<number>();
  const traceTs = new Set<number>();
  for (const { line } of ctx.packets) {
    const tr = finitePairs(line.tr);
    if (tr.length > 0) c.packetsWithTrace++;
    for (const [ts] of tr) traceTs.add(ts);
    const talk = finitePairs(line.talk);
    if (talk.length > 0) c.packetsWithTalk++;
    for (const [ts, flag] of talk) {
      if (talkTs.has(ts)) continue;
      talkTs.add(ts);
      c.talkSamples++;
      if (flag === 1) c.talkingOn++;
    }
    const lm = line.lm;
    if (lm && Array.isArray(lm.p)) {
      c.packetsWithLandmarks++;
      if (lm.reset) c.resetFrames++;
      for (const p of lm.p) {
        c.keptPoints++;
        if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) c.nullPoints++;
      }
    }
    if (typeof line.g === 'number') c.packetsWithG++;
    if (typeof line.hm === 'number') c.packetsWithHm++;
  }
  c.traceSamples = traceTs.size;
  return c;
}

export interface FirstFrameCheck {
  source: string;
  /** 478 expected; null when only the 16 kept points are known. */
  meshPoints: number | null;
  y13BelowY14: boolean | null;
  x78BelowX308: boolean | null;
  units: 'pixels' | 'normalized' | 'unknown';
  insideRequestedFrame: boolean | null;
}

/** 'pixels' when any coordinate exceeds 2 (normalized ones stay within [-1, 1] or [0, 1]). */
function unitsOf(xs: readonly number[], ys: readonly number[]): FirstFrameCheck['units'] {
  const all = [...xs, ...ys].filter(Number.isFinite);
  if (all.length === 0) return 'unknown';
  return Math.max(...all.map(Math.abs)) > 2 ? 'pixels' : 'normalized';
}

function insideFrame(xs: readonly number[], ys: readonly number[], w: number, h: number): boolean | null {
  if (xs.length === 0 || ys.length === 0) return null;
  return xs.every((x) => x >= 0 && x <= w) && ys.every((y) => y >= 0 && y <= h);
}

/** The probe to judge the first frame by: the first one with landmarks, else the last one. */
export function frameProbe(probes: readonly Sourced<PacketProbe>[]): Sourced<PacketProbe> | null {
  return probes.find((p) => p.value.frames > 0) ?? probes[probes.length - 1] ?? null;
}

/** First-frame checks of spec 7.12 question 2, from tap's probe, else from the 16 kept points. */
export function firstFrameCheck(ctx: SmokeContext): FirstFrameCheck | null {
  const [w, h] = requestedFormat(ctx);
  const probe = frameProbe(ctx.tap.probes);
  if (probe !== null && probe.value.frames > 0) {
    const p = probe.value;
    const xs = p.xRange ?? [];
    const ys = p.yRange ?? [];
    return {
      source: `probe of packet ${p.packet ?? '?'} (${probe.source})`,
      meshPoints: p.points,
      y13BelowY14: p.lipsY13BelowY14,
      x78BelowX308: p.cornersX78BelowX308,
      units: unitsOf(xs, ys),
      insideRequestedFrame: insideFrame(xs, ys, w, h),
    };
  }
  const first = ctx.packets.find((p) => p.line.lm && Array.isArray(p.line.lm.p) && p.line.lm.p.length > 0);
  if (!first) return null;
  const pts = first.line.lm!.p;
  const at = (id: number): readonly [number, number] | null => {
    const q = pts[LANDMARK_IDS.indexOf(id)];
    return Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1]) ? q : null;
  };
  const below = (a: readonly [number, number] | null, b: readonly [number, number] | null, axis: 0 | 1) =>
    a && b ? a[axis] < b[axis] : null;
  const valid = pts.filter((q): q is readonly [number, number] => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1]));
  const xs = valid.map((q) => q[0]);
  const ys = valid.map((q) => q[1]);
  return {
    source: `first landmark frame of samples.jsonl (seq ${first.seq ?? '?'}, 16 kept points)`,
    meshPoints: null,
    y13BelowY14: below(at(13), at(14), 1),
    x78BelowX308: below(at(78), at(308), 0),
    units: unitsOf(xs, ys),
    insideRequestedFrame: insideFrame(xs, ys, w, h),
  };
}

/** ok: returned data; empty: proven to return nothing; suspect: one of a group returned nothing; unknown: cannot tell. */
export type AccessorStatus = 'ok' | 'empty' | 'suspect' | 'unknown';
/** The reduce.cjs accessors, and tap's decodeMetrics() call that comes before them. */
export type LayoutPart = AccessorName | 'decodeMetrics';

export interface AccessorFinding {
  accessor: LayoutPart;
  reads: string;
  status: AccessorStatus;
  evidence: string;
}

const DECODE_READS = 'decodeMetrics(buf) of @smartspectra/node-sdk/messages';
/** Timestamp types reduce.cjs toUs() converts (spec 7.1). */
const READABLE_TS_TYPES = ['number', 'Long', 'bigint', 'string'];
/** Parts that a missing trace can come from, root cause first. */
const TRACE_PARTS: readonly LayoutPart[] = ['decodeMetrics', 'chestSamples', 'stampOf', 'traceValue'];

/** Median size of the logged metrics buffers (sdk_raw.jsonl.gz), bytes; null without them. */
export function metricsBufferBytes(ctx: SmokeContext): number | null {
  const sizes = ctx.folder.raw.filter((r) => r.kind === 'metrics' && r.bufferBytes !== null).map((r) => r.bufferBytes!);
  if (sizes.length === 0) return null;
  const s = [...sizes].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/**
 * Which reduce.cjs accessors returned data (spec 7.12: the most useful output of the first run).
 * One accessor is named only when tap's probe of a decoded packet or the samples.jsonl lines prove
 * it; otherwise the candidates are marked 'suspect' together. talkingFlag and frameReset turn
 * every value into 0 or 1, so they are judged only when a 1 was seen.
 */
export function layoutFindings(
  ctx: SmokeContext,
  c: StreamCounts = streamCounts(ctx),
  paths: Readonly<Record<AccessorName, string>> = accessorPaths(),
): AccessorFinding[] {
  const out: AccessorFinding[] = [];
  const add = (accessor: LayoutPart, status: AccessorStatus, evidence: string) =>
    out.push({ accessor, reads: accessor === 'decodeMetrics' ? DECODE_READS : paths[accessor], status, evidence });
  const probes = ctx.tap.probes.map((p) => p.value);
  const sampled = probes.filter((p) => p.tr + p.talk + p.frames > 0);
  const probeNames = (list: readonly PacketProbe[]) =>
    `${list.length > 1 ? 'the probes of packets' : 'the probe of packet'} ${list.map((p) => p.packet ?? '?').join(' and ')}`;
  const probed = probes.length > 0 ? probeNames(probes) : '';
  const fields = [...new Set(probes.flatMap((p) => p.fields))];
  const fieldText = fields.length > 0 ? fields.join(', ') : 'none';
  const n = c.packets;
  const samplesFile = ctx.folder.inputs.find((i) => i.file === 'samples.jsonl');
  const lineless = !samplesFile?.present ? 'samples.jsonl is missing' : n === 0 ? 'no metrics packet in samples.jsonl' : null;
  const has = { trace: c.packetsWithTrace > 0, talk: c.packetsWithTalk > 0, lm: c.packetsWithLandmarks > 0 };
  const anyLines = has.trace || has.talk || has.lm;
  const ofPackets = (k: number) => `${k} of ${n} packets`;
  const bytes = metricsBufferBytes(ctx);
  const bytesText = bytes === null ? '' : bytes === 0 ? '; the SDK sent empty metrics buffers' : `; the SDK sent metrics buffers of ${bytes} bytes (median)`;
  const nothing = `no trace, talking or landmark sample in any of ${n} packets${bytesText}`;

  // decodeMetrics(): tap writes empty lines when it throws (live/tap.cjs); the probe then shows no field.
  if (anyLines || fields.length > 0) add('decodeMetrics', 'ok', anyLines ? 'the packets carry samples' : `${probed} shows fields ${fieldText}`);
  else if (probes.length > 0) add('decodeMetrics', 'empty', `${probed} shows an empty decoded message: decodeMetrics() threw or the SDK sent nothing (tap's console says which)${bytesText}`);
  else if (lineless) add('decodeMetrics', 'unknown', lineless);
  else add('decodeMetrics', 'suspect', nothing);

  // The three containers.
  const container = (accessor: AccessorName, inLines: boolean, inProbe: (p: PacketProbe) => number, what: string, packetsWith: number, found: string) => {
    if (inLines) add(accessor, 'ok', `${what} in ${ofPackets(packetsWith)}`);
    else if (probes.some((p) => inProbe(p) > 0)) add(accessor, 'ok', `${probed} found ${found}`);
    else if (fields.length > 0) {
      add(accessor, 'empty', `nothing in ${probed} (decoded fields: ${fieldText})${lineless ? `; ${lineless}` : ` and no line has a ${what} sample`}`);
    } else if (probes.length > 0) add(accessor, 'unknown', 'the decoded message was empty (see decodeMetrics)');
    else if (lineless) add(accessor, 'unknown', lineless);
    else add(accessor, 'suspect', anyLines ? `no ${what} sample in any of ${n} packets, while other samples arrive` : nothing);
  };
  container('chestSamples', has.trace, (p) => p.tr, 'trace', c.packetsWithTrace, 'trace samples');
  container('talkSamples', has.talk, (p) => p.talk, 'talking flag', c.packetsWithTalk, 'talking flag samples');
  container('landmarkFrames', has.lm, (p) => p.frames, 'landmark frame', c.packetsWithLandmarks, 'landmark frames');

  // stampOf: every kept sample went through it; the probe shows its type before toUs().
  const types = [...new Set(sampled.map((p) => p.tsType))];
  const unreadable = types.filter((t) => !READABLE_TS_TYPES.includes(t));
  if (anyLines) add('stampOf', 'ok', `timestamps read in ${ofPackets(Math.max(c.packetsWithTrace, c.packetsWithTalk, c.packetsWithLandmarks))}${types.length ? ` (probe type: ${types.join(', ')})` : ''}`);
  else if (unreadable.length > 0) add('stampOf', 'empty', `${probeNames(sampled)} sees samples whose timestamp is ${types.join(', ')}`);
  else if (sampled.length > 0 && lineless) add('stampOf', 'ok', `${probeNames(sampled)} reads ${types.join(', ')} timestamps`);
  else if (sampled.length > 0) add('stampOf', 'empty', `${probeNames(sampled)} sees samples with ${types.join(', ')} timestamps, but no line kept one: they are not finite after toUs()`);
  else if (probes.length > 0 || lineless) add('stampOf', 'unknown', lineless ?? 'no probed packet had a sample to read');
  else add('stampOf', 'suspect', nothing);

  // traceValue: a trace sample whose value is not a finite number is dropped.
  const traceProbes = probes.filter((p) => p.tr > 0 && READABLE_TS_TYPES.includes(p.tsType));
  if (c.traceSamples > 0) add('traceValue', 'ok', `${c.traceSamples} finite trace values`);
  else if (traceProbes.length > 0 && !lineless && anyLines) {
    add('traceValue', 'empty', `${probeNames(traceProbes)} sees trace samples with readable timestamps, but no line kept one: the value is not a finite number`);
  } else if (probes.length === 0 && !lineless && anyLines) add('traceValue', 'suspect', `no trace sample in any of ${n} packets, while other samples arrive`);
  else add('traceValue', 'unknown', 'no trace sample to read');

  add(
    'talkingFlag',
    c.talkingOn > 0 ? 'ok' : 'unknown',
    c.talkingOn > 0
      ? `flag 1 in ${c.talkingOn} of ${c.talkSamples} samples`
      : c.talkSamples > 0
        ? `flag 0 in all ${c.talkSamples} samples: expected, nobody talks in smoke, but a wrong field name gives 0 too`
        : 'no talking sample to read',
  );

  const framePts = probes.filter((p) => p.frames > 0).map((p) => p.points);
  const allNull = c.packetsWithLandmarks > 0 && c.keptPoints > 0 && c.nullPoints === c.keptPoints;
  if (framePts.some((k) => k === 0)) add('framePoints', 'empty', 'probe sees a landmark frame with 0 points');
  else if (framePts.length > 0) add('framePoints', 'ok', `${framePts.join(', ')} points in the probed frame`);
  else if (allNull) add('framePoints', 'suspect', `every one of the ${c.keptPoints} kept points is null`);
  else if (c.packetsWithLandmarks > 0) add('framePoints', 'ok', `${c.keptPoints - c.nullPoints} of ${c.keptPoints} kept points present`);
  else add('framePoints', 'unknown', 'no landmark frame to read');

  add(
    'frameReset',
    c.resetFrames > 0 ? 'ok' : 'unknown',
    c.resetFrames > 0
      ? `${c.resetFrames} frame${c.resetFrames === 1 ? '' : 's'} with reset`
      : c.packetsWithLandmarks > 0
        ? 'no frame had reset: a wrong field name gives 0 too'
        : 'no landmark frame to read',
  );

  const rangeless = probes.some((p) => p.frames > 0 && p.points > 0 && p.xRange === null);
  if (rangeless) add('pointXY', 'empty', 'probe frame has points but none has finite x and y');
  else if (framePts.some((k) => k > 0) && allNull) add('pointXY', 'empty', `probe frame has points, but all ${c.keptPoints} kept points are null`);
  else if (allNull) add('pointXY', 'suspect', `every one of the ${c.keptPoints} kept points is null`);
  else if (c.keptPoints > 0) add('pointXY', 'ok', `${c.nullPoints} of ${c.keptPoints} kept points null`);
  else add('pointXY', 'unknown', 'no point to read');
  return out;
}

/** "a", "a or b", "a, b or c". */
function orList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

const partName = (p: LayoutPart): string => (p === 'decodeMetrics' ? 'decodeMetrics()' : p);

/**
 * Why no trace sample arrived, for the verdict line: a missing file or packet, the accessor that a
 * probe or the lines prove empty, or the candidates when only they are known; '' when no part is to blame.
 */
export function traceMissingWhy(ctx: SmokeContext, findings: readonly AccessorFinding[] = layoutFindings(ctx)): string {
  const samplesFile = ctx.folder.inputs.find((i) => i.file === 'samples.jsonl');
  if (!samplesFile?.present) return 'samples.jsonl is missing';
  if (ctx.packets.length === 0) return 'no metrics packet arrived';
  const empty = findings.filter((f) => f.status === 'empty' && TRACE_PARTS.includes(f.accessor));
  if (empty.some((f) => f.accessor === 'decodeMetrics')) return "decodeMetrics() gave an empty message; tap's console says why";
  if (empty.length > 0) return `reduce.cjs ${empty.map((f) => f.accessor).join(' and ')} returned nothing`;
  const suspects = findings.filter((f) => f.status === 'suspect' && (TRACE_PARTS.includes(f.accessor) || ['talkSamples', 'landmarkFrames'].includes(f.accessor)));
  const traceSuspects = suspects.filter((f) => TRACE_PARTS.includes(f.accessor));
  if (traceSuspects.length === 0) return '';
  const names = (traceSuspects.some((f) => f.accessor === 'stampOf') ? suspects : traceSuspects).map((f) => partName(f.accessor));
  return `one of ${orList(names)} returned nothing; save tap's console as tap.log to tell which`;
}

/** Layout lines of question 2: proven empty accessors one by one, candidates grouped by their evidence. */
export function layoutLines(findings: readonly AccessorFinding[]): string[] {
  const lines: string[] = [];
  for (const f of findings.filter((x) => x.status === 'empty')) {
    lines.push(`Layout: ${partName(f.accessor)} (reads ${f.reads}) returned nothing: ${f.evidence}.`);
  }
  const groups = new Map<string, AccessorFinding[]>();
  for (const f of findings.filter((x) => x.status === 'suspect')) groups.set(f.evidence, [...(groups.get(f.evidence) ?? []), f]);
  for (const [evidence, group] of groups) {
    const names = group.map((f) => `${partName(f.accessor)} (reads ${f.reads})`);
    lines.push(
      `Layout: ${group.length > 1 ? `one of ${orList(names)}` : names[0]} returned nothing: ${evidence}. Without tap's probe the files cannot tell which: save tap's console as tap.log.`,
    );
  }
  const judged = findings.filter((f) => f.status === 'ok').length;
  const unknown = findings.filter((f) => f.status === 'unknown');
  if (lines.length === 0) {
    lines.push(
      judged === 0
        ? 'Layout: no packet and no probe, so the reduce.cjs accessors cannot be judged.'
        : `Layout: every part that could be judged returned data (${judged} of ${findings.length}).`,
    );
  }
  if (unknown.length > 0 && judged > 0) {
    lines.push(`Not judged: ${unknown.map((f) => `${partName(f.accessor)} (${f.evidence})`).join('; ')}.`);
  }
  return lines;
}

/** The reduce.cjs the lines were written with, as far as the report knows (analysis/smoke/report.ts reduceVersion). */
export interface ReduceVersionInfo {
  paths: Readonly<Record<AccessorName, string>>;
  /** Printed above the Layout lines when reduce.cjs changed since the session was first reported. */
  note: string | null;
}

export function answerData(ctx: SmokeContext, reduce: ReduceVersionInfo = { paths: accessorPaths(), note: null }): Answer {
  const c = streamCounts(ctx);
  const metricSet = metricSetOf(ctx);
  const errors = sdkErrorsSeen(ctx);
  const refused = errors.filter((e) => e.code !== null && METRIC_REFUSED_CODES.includes(e.code));
  const accepted: boolean | null = refused.length > 0 ? false : c.packets > 0 ? true : null;
  const frame = firstFrameCheck(ctx);
  const layout = layoutFindings(ctx, c, reduce.paths);
  const firstProbe = ctx.tap.probes[0] ?? null;
  const [w, h] = requestedFormat(ctx);

  const lines: string[] = [];
  const set = metricSet === null ? 'not recorded' : metricSet.join(', ');
  if (accepted === false) {
    lines.push(`Metric set ${set}: refused (${refused.map((e) => errorLabel(e)).join('; ')}). Next run: COPYHOLDER_METRICS=spare in settings.env (spec 7.1).`);
  } else if (accepted === true) {
    lines.push(`Metric set ${set}: accepted (no error 3 or 13; ${c.packets} packets arrived).`);
  } else {
    lines.push(`Metric set ${set}: unknown (no packet and no refusal).`);
  }
  lines.push(
    `Trace: in ${c.packetsWithTrace} of ${c.packets} packets, ${c.traceSamples} samples. ` +
      `Landmarks: in ${c.packetsWithLandmarks} packets (${c.keptPoints - c.nullPoints} of ${c.keptPoints} kept points present, ${c.resetFrames} reset frame${c.resetFrames === 1 ? '' : 's'}). ` +
      `Talking flag: in ${c.packetsWithTalk} packets, on in ${c.talkingOn} of ${c.talkSamples} samples.`,
  );
  if (frame === null) {
    lines.push('First frame: no landmark frame arrived and no probe was found.');
  } else {
    const yn = (b: boolean | null) => (b === null ? 'unknown' : b ? 'yes' : 'NO');
    const pts = frame.meshPoints === null ? '478 points: unknown (only the probe counts them)' : `${frame.meshPoints} points${frame.meshPoints === MESH_POINTS ? '' : ` (expected ${MESH_POINTS})`}`;
    const inside = frame.insideRequestedFrame === null ? '' : frame.insideRequestedFrame ? `, inside the requested ${w}x${h} frame` : `, NOT inside the requested ${w}x${h} frame`;
    lines.push(
      `First frame (${frame.source}): ${pts}; y[13] < y[14]: ${yn(frame.y13BelowY14)}; x[78] < x[308]: ${yn(frame.x78BelowX308)}; coordinates: ${frame.units}${inside}.`,
    );
  }
  if (firstProbe !== null) {
    lines.push(`Decoded message fields (${firstProbe.source}): ${firstProbe.value.fields.length ? firstProbe.value.fields.join(', ') : 'none'}.`);
  } else {
    lines.push(`Decoded message fields: unknown (${consoleNote(ctx.tap, "tap's console has no probe line")}).`);
  }
  if (reduce.note !== null) lines.push(reduce.note);
  lines.push(...layoutLines(layout));
  if (ctx.tap.enums.length === 0) {
    lines.push(`Enums: unknown (${consoleNote(ctx.tap, "tap's console has no enum check")}).`);
  } else {
    lines.push(
      `Enums: ${ctx.tap.enums
        .map((e) => (e.value.matches ? `${e.value.label} matches reduce.cjs` : `${e.value.label} DIFFERS from reduce.cjs: ${e.value.differences.join(', ')}`))
        .join('; ')}.`,
    );
  }
  return {
    n: 2,
    title: 'Data',
    lines,
    data: {
      metric_set: metricSet,
      metrics_accepted: accepted,
      metric_errors: refused.map((e) => ({ code: e.code, name: e.name, message: e.message })),
      packets: c.packets,
      packets_with_trace: c.packetsWithTrace,
      trace_samples: c.traceSamples,
      packets_with_landmarks: c.packetsWithLandmarks,
      landmark_reset_frames: c.resetFrames,
      kept_points: c.keptPoints,
      kept_points_null: c.nullPoints,
      packets_with_talk: c.packetsWithTalk,
      talk_samples: c.talkSamples,
      talking_on: c.talkingOn,
      packets_with_g: c.packetsWithG,
      packets_with_hm: c.packetsWithHm,
      first_frame: frame && {
        source: frame.source,
        mesh_points: frame.meshPoints,
        y13_below_y14: frame.y13BelowY14,
        x78_below_x308: frame.x78BelowX308,
        units: frame.units,
        inside_requested_frame: frame.insideRequestedFrame,
      },
      decoded_fields: firstProbe?.value.fields ?? null,
      probes: ctx.tap.probes.map((p) => ({
        source: p.source,
        packet: p.value.packet,
        fields: p.value.fields,
        ts_type: p.value.tsType,
        ts_cb_type: p.value.tsCbType ?? null,
        trace: p.value.tr,
        talk: p.value.talk,
        frames: p.value.frames,
        mesh_points: p.value.points,
      })),
      layout: layout.map((f) => ({ accessor: f.accessor, reads: f.reads, status: f.status, evidence: f.evidence })),
      enums: ctx.tap.enums.map((e) => ({ ...e.value, source: e.source })),
      share_packets_with_trace: c.packets > 0 ? Math.round((c.packetsWithTrace / c.packets) * 1000) / 1000 : null,
    },
  };
}
