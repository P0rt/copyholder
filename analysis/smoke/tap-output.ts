// What tap prints and sends in smoke mode (live/tap.cjs, spec 7.12): the camera list, the camera
// it chose, the checkDeviceReadiness() verdict, the first-frame probe and the enum checks. tap
// writes them to its console and to host over fork IPC, not to a session file, so they are looked
// for in every place a run may have kept them: a text log in the session folder (tap.cjs console
// lines, host's "Cameras found:" line), IPC-shaped objects in any other JSONL file or in
// events.jsonl, and decoded messages in sdk_raw.jsonl.gz. The camera list and an enum check that
// tap.log redacted come from the IPC messages when there are any (host's tap_* events).
//
// A saved console holds more than this run: host echoes the quick check, that is this report,
// and a log may hold earlier runs. Only the lines of this session's run are read: from host's
// "Recording folder:" line of this session to its "Running the quick check..." line, without
// any block of an earlier smoke report.

import { basename } from 'node:path';
import { probeDecodedMessage, type FirstFrameProbe } from './reduce-adapter.ts';
import type { JsonObject, SessionFolder } from './read.ts';

export interface Sourced<T> {
  value: T;
  /** File (and line) it came from. */
  source: string;
}

export interface CameraChoice {
  name: string | null;
  requested: number[] | null;
  metrics: string[] | null;
}

export interface Readiness {
  verdict: string | null;
  reason: string | null;
  /** tap could not get a verdict: the call threw, timed out or gave an SDK error. */
  failed: boolean;
}

export interface EnumCheck {
  /** ProcessingStatus, ValidationCode or SmartSpectraErrorCode. */
  label: string;
  matches: boolean;
  /** "name=code" pairs of reduce.cjs that the SDK enum does not have, as tap prints them. */
  differences: string[];
}

/** A probe of one decoded packet; `packet` is tap's packet count when the console line names it. */
export interface PacketProbe extends FirstFrameProbe {
  packet: number | null;
}

export interface LogLine {
  file: string;
  lineNo: number;
  text: string;
}

export interface TapSmokeOutput {
  cameras: Sourced<string[]> | null;
  camera: Sourced<CameraChoice> | null;
  readiness: Sourced<Readiness> | null;
  /** tap probes packet 1 and the first packet with landmarks (live/tap.cjs, spec 7.12 questions 2 and 4). */
  probes: Sourced<PacketProbe>[];
  enums: Sourced<EnumCheck>[];
  /** Lines of this run in the text logs that are neither tap's nor host's own lines: SDK log candidates. */
  logLines: LogLine[];
  /** Where the search looked. */
  searched: string[];
  /** tap's console or its IPC messages were found in the folder. */
  consoleFound: boolean;
  /** Lines of this run read from text logs (tap's console as saved). */
  textLines: number;
  /** What the text logs held besides this run (left out). */
  skipped: { reportLines: number; quickcheckLines: number; otherRunLines: number; otherRuns: string[] };
  /** Session folders named by a log that names no run of this session (its lines were read anyway). */
  foreignRuns: string[];
}

const ENUM_LABELS = ['ProcessingStatus', 'ValidationCode', 'SmartSpectraErrorCode'];
const ENUM_RE = new RegExp(`^(${ENUM_LABELS.join('|')}): (matches reduce\\.cjs|differs from reduce\\.cjs: (.*))$`);
/** tap's console.log line of the verdict (live/tap.cjs startSdk). */
const READINESS_RE = /^checkDeviceReadiness\(\): (.*?) \((.*)\)\s*$/;
/** tap's say() lines when checkDeviceReadiness() throws, times out, or gives an SDK error (live/tap.cjs). */
const READINESS_FAILED_RE = /^tap: (checkDeviceReadiness\(\) failed: .*)$/;
const READINESS_TIMEOUT_RE = /^tap: (checkDeviceReadiness\(\) did not settle .*)$/;
const READINESS_SDK_ERROR_RE = /^tap: (SDK error .* from checkDeviceReadiness\(\).*)$/;
/** `packet <n>: {probe}` (live/tap.cjs); `first frame: {probe}` of an earlier tap. */
const PROBE_RE = /(?:^|\s)(?:packet (\d+)|first frame): (\{.*\})\s*$/;
const CAMERAS_HEADER = 'tap: cameras (';
const HOST_CAMERAS_RE = /^Cameras found: (.*)\.$/;
/** A glog-style or bracketed log line, never a camera name. */
const LOG_LINE_RE = /^([IWEF]\d{4} |\[|\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2})/;

/** host's lines that delimit one run in its console (live/host.cjs). */
const RUN_START_RE = /^Recording folder: (.+?)\s*$/;
const RUN_END_RE = /^Running the quick check\.\.\.\s*$/;
/** This report's own first and last lines (analysis/smoke.ts), as host echoes them. */
const REPORT_START_RE = /^Smoke report for \S/;
const REPORT_END_RE = /^SMOKE (OK|FAIL)\b/;
/** host's own console lines (live/host.cjs say(), live/lib/sdk-codes.cjs) and npm's script banner. */
const HOST_LINE_RE =
  /^(Copyholder: |Opening Chrome at |Opening the page in |Open this address in |Waiting for "I agree, start"|Put the exact name of the camera|Camera running\.|Consent given\.|Recording finished\.|Saved to |Saving failed: |Stopping |Stopped\.|Note: the repository has local changes|Audio blocks are missing|Audio could not be stored|Internal error: |Narrator file |Page request failed: |The (SDK|camera|page|stand-in|quick check|files recorded|network connection|Presage server|recording) |Check SMARTSPECTRA_API_KEY|> )/;

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function numberList(v: unknown): number[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'number') ? (v as number[]) : null;
}

function stringList(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}

function isProbe(v: unknown): v is FirstFrameProbe {
  if (v === null || typeof v !== 'object') return false;
  const o = v as JsonObject;
  return Array.isArray(o['fields']) && typeof o['tsType'] === 'string' && typeof o['points'] === 'number';
}

/** Probes that saw at least one trace sample, talking sample or landmark frame. */
export function probesWithSamples<T extends { value: FirstFrameProbe }>(probes: readonly T[]): T[] {
  return probes.filter((p) => p.value.tr + p.value.talk + p.value.frames > 0);
}

/** `fallback` when tap's console was found, else a pointer to the note at the top of the report. */
export function consoleNote(tap: Pick<TapSmokeOutput, 'consoleFound'>, fallback: string): string {
  return tap.consoleFound ? fallback : "tap's console is not in the session folder: see the note at the top";
}

/** An IPC message of tap ({t: ...}) found in a JSON object: the object itself, `msg`/`ipc`, or e = 'tap_<t>'. */
export function ipcMessageOf(o: JsonObject): JsonObject | null {
  if (typeof o['t'] === 'string') return o;
  for (const key of ['msg', 'ipc']) {
    const inner = o[key];
    if (inner && typeof inner === 'object' && typeof (inner as JsonObject)['t'] === 'string') return inner as JsonObject;
  }
  const e = o['e'];
  if (typeof e === 'string') {
    const m = /^(?:tap_)?(cameras|camera|readiness|probe|enums)$/.exec(e);
    if (m) return { ...o, t: m[1] };
  }
  return null;
}

/** Keeps a probe unless the same probe already came from another source (console and IPC repeat it). */
function addProbe(out: TapSmokeOutput, p: PacketProbe, source: string): void {
  const same = (q: PacketProbe) =>
    q.tr === p.tr && q.talk === p.talk && q.frames === p.frames && q.points === p.points && q.tsType === p.tsType &&
    (q.packet === null || p.packet === null || q.packet === p.packet);
  if (out.probes.some((q) => same(q.value))) return;
  if (out.probes.length < 8) out.probes.push({ value: p, source });
}

/**
 * Keeps the first verdict of checkDeviceReadiness(). A failure or timeout counts only until a later
 * line says more: tap keeps waiting after its 30 s note, so a verdict may follow (live/tap.cjs).
 */
function setReadiness(out: TapSmokeOutput, value: Readiness, source: string): void {
  if (out.readiness === null || out.readiness.value.failed) out.readiness = { value, source };
}

/** Folds one IPC-shaped object into the output; the first source of each kind wins. Returns whether it was tap's. */
function takeIpc(out: TapSmokeOutput, m: JsonObject, source: string): boolean {
  switch (m['t']) {
    case 'cameras': {
      const list = Array.isArray(m['list']) ? (m['list'] as unknown[]) : [];
      const names = list.map((c) => (c && typeof c === 'object' ? strOrNull((c as JsonObject)['name']) : null) ?? '(no name)');
      out.cameras ??= { value: names, source };
      return true;
    }
    case 'camera':
      out.camera ??= {
        value: { name: strOrNull(m['name']), requested: numberList(m['requested']), metrics: stringList(m['metrics']) },
        source,
      };
      return true;
    case 'readiness':
      setReadiness(out, { verdict: strOrNull(m['verdict']), reason: strOrNull(m['reason']), failed: strOrNull(m['verdict']) === null }, source);
      return true;
    case 'probe':
      if (isProbe(m)) addProbe(out, { ...m, packet: typeof m['packet'] === 'number' ? m['packet'] : null }, source);
      return true;
    case 'enums': {
      const checks = Array.isArray(m['checks']) ? (m['checks'] as unknown[]) : [];
      for (const c of checks) {
        if (!c || typeof c !== 'object') continue;
        const label = strOrNull((c as JsonObject)['label']);
        const diff = stringList((c as JsonObject)['differences']) ?? [];
        if (label && !out.enums.some((x) => x.value.label === label)) {
          out.enums.push({ value: { label, matches: diff.length === 0, differences: diff }, source });
        }
      }
      return true;
    }
    default:
      return false;
  }
}

/** Does a "Recording folder: <path>" line name this session? */
function namesSession(folder: string, keys: readonly string[]): boolean {
  const base = basename(folder.replace(/[\\/]+$/, ''));
  return keys.includes(base);
}

/**
 * The lines of one text log that belong to this session's run: the segments after host's
 * "Recording folder:" line for this session (all segments when no line names a folder, or none
 * names this one), up to "Running the quick check...", without blocks of an earlier smoke report.
 */
export function runLines(
  file: string,
  lines: readonly string[],
  sessionKeys: readonly string[],
): { lines: LogLine[]; reportLines: number; quickcheckLines: number; otherRunLines: number; otherRuns: string[]; foreignRuns: string[] } {
  const segments: { folder: string | null; lines: LogLine[] }[] = [];
  let current: { folder: string | null; lines: LogLine[] } | null = null;
  let inReport = false;
  let afterRun = false;
  let reportLines = 0;
  let quickcheckLines = 0;
  lines.forEach((raw, idx) => {
    const text = raw.replace(/\s+$/, '');
    if (inReport) {
      reportLines++;
      if (REPORT_END_RE.test(text)) inReport = false;
      return;
    }
    if (REPORT_START_RE.test(text)) {
      inReport = true;
      reportLines++;
      return;
    }
    const start = RUN_START_RE.exec(text);
    if (start) {
      current = { folder: start[1]!, lines: [] };
      segments.push(current);
      afterRun = false;
      return;
    }
    if (RUN_END_RE.test(text)) {
      afterRun = true;
      return;
    }
    if (afterRun) {
      if (text.trim() !== '') quickcheckLines++;
      return;
    }
    if (current === null) {
      current = { folder: null, lines: [] };
      segments.push(current);
    }
    current.lines.push({ file, lineNo: idx + 1, text });
  });
  const named = segments.filter((s) => s.folder !== null);
  const mine = named.filter((s) => namesSession(s.folder!, sessionKeys));
  const chosen = mine.length > 0 ? mine : segments;
  const left = segments.filter((s) => !chosen.includes(s));
  return {
    lines: chosen.flatMap((s) => s.lines),
    reportLines,
    quickcheckLines,
    otherRunLines: left.reduce((k, s) => k + s.lines.length, 0),
    otherRuns: [...new Set(left.filter((s) => s.folder !== null).map((s) => s.folder!))],
    foreignRuns: mine.length > 0 ? [] : [...new Set(named.map((s) => s.folder!))],
  };
}

/** What a text log gives that tap's IPC messages say better: weighed after them (cameraListOf, redacted enums). */
interface TextFallbacks {
  /** Camera lists from the text: host's "Cameras found:" line, tap's header and names. */
  cameras: Sourced<string[]>[];
  /** Enum lines whose differences tap.log redacted (live/lib/tap-log.cjs): tap_enums keeps them whole. */
  enums: Sourced<EnumCheck>[];
}

/** host's tap.log redaction mark (live/lib/tap-log.cjs). */
const REDACTED = '[redacted]';

/**
 * Reads tap's and host's console lines of this run (formats of live/tap.cjs and live/host.cjs).
 * Camera lists and redacted enum lines are returned instead of taken: tap_cameras and tap_enums
 * in events.jsonl, which host writes from tap's IPC messages, say the same without the console's
 * order and redaction. tap prints the camera header on stderr and the names on stdout, and host
 * tees the two pipes into tap.log as they come, so the header may follow the names; a header that
 * comes after a line tap prints after the names (an enum check, the readiness verdict, a probe)
 * opens no block.
 */
function takeTextLog(out: TapSmokeOutput, lines: readonly LogLine[]): TextFallbacks {
  const later: TextFallbacks = { cameras: [], enums: [] };
  let cameraBlock: string[] | null = null;
  let cameraBlockWhere = '';
  let pastNames = false;
  const closeCameraBlock = () => {
    if (cameraBlock && cameraBlock.length > 0) later.cameras.push({ value: cameraBlock, source: cameraBlockWhere });
    cameraBlock = null;
  };
  for (const { file, lineNo, text: line } of lines) {
    const where = `${file}:${lineNo}`;
    if (line.startsWith(CAMERAS_HEADER)) {
      closeCameraBlock();
      if (!pastNames) {
        cameraBlock = [];
        cameraBlockWhere = where;
      }
      continue;
    }
    const pr = PROBE_RE.exec(line);
    if (pr) {
      try {
        const p: unknown = JSON.parse(pr[2]!);
        if (isProbe(p)) addProbe(out, { ...p, packet: pr[1] ? Number(pr[1]) : null }, where);
        closeCameraBlock();
        pastNames = true;
        continue;
      } catch {
        // a cut line: no probe from it
      }
    }
    const rd = READINESS_RE.exec(line);
    if (rd) {
      setReadiness(out, { verdict: rd[1] ?? null, reason: rd[2] ?? null, failed: false }, where);
      closeCameraBlock();
      pastNames = true;
      continue;
    }
    const rf = READINESS_FAILED_RE.exec(line) ?? READINESS_TIMEOUT_RE.exec(line) ?? READINESS_SDK_ERROR_RE.exec(line);
    if (rf) {
      setReadiness(out, { verdict: null, reason: rf[1]!, failed: true }, where);
      closeCameraBlock();
      continue;
    }
    const en = ENUM_RE.exec(line);
    if (en) {
      const label = en[1]!;
      const diff = en[3] ? en[3].split(',').map((s) => s.trim()).filter(Boolean) : [];
      const check = { value: { label, matches: !en[3], differences: diff }, source: where };
      if (diff.some((d) => d.includes(REDACTED))) later.enums.push(check);
      else if (!out.enums.some((x) => x.value.label === label)) out.enums.push(check);
      closeCameraBlock();
      pastNames = true;
      continue;
    }
    const hc = HOST_CAMERAS_RE.exec(line);
    if (hc) {
      const names = [...hc[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
      if (names.length > 0) later.cameras.push({ value: names, source: where });
      closeCameraBlock();
      continue;
    }
    if (cameraBlock !== null) {
      // tap prints one camera name per line right after its header (live/tap.cjs showCameras).
      if (line !== '' && !line.startsWith('tap:') && !LOG_LINE_RE.test(line) && !HOST_LINE_RE.test(line) && cameraBlock.length < 32) {
        cameraBlock.push(line);
        continue;
      }
      closeCameraBlock();
    }
    if (line.trim() !== '' && !line.startsWith('tap:') && !HOST_LINE_RE.test(line)) out.logLines.push({ file, lineNo, text: line });
  }
  closeCameraBlock();
  return later;
}

/**
 * The camera list: from tap's 'cameras' IPC message (host's tap_cameras event) when there is one,
 * with the console's first list as its source when that list has the same names in the same order;
 * the console's first list when no message came.
 */
function cameraListOf(ipc: Sourced<string[]> | null, text: readonly Sourced<string[]>[]): Sourced<string[]> | null {
  const first = text[0] ?? null;
  if (ipc === null) return first;
  const same = first !== null && first.value.length === ipc.value.length && first.value.every((name, i) => name === ipc.value[i]);
  return same ? first : ipc;
}

/** Enum checks in the order tap prints them (ProcessingStatus, ValidationCode, SmartSpectraErrorCode), others after. */
function enumOrder(a: Sourced<EnumCheck>, b: Sourced<EnumCheck>): number {
  const rank = (x: Sourced<EnumCheck>) => {
    const i = ENUM_LABELS.indexOf(x.value.label);
    return i < 0 ? ENUM_LABELS.length : i;
  };
  return rank(a) - rank(b);
}

/** Collects tap's smoke output from everything the folder holds. */
export function tapSmokeOutput(folder: SessionFolder): TapSmokeOutput {
  const out: TapSmokeOutput = {
    cameras: null,
    camera: null,
    readiness: null,
    probes: [],
    enums: [],
    logLines: [],
    searched: [],
    consoleFound: false,
    textLines: 0,
    skipped: { reportLines: 0, quickcheckLines: 0, otherRunLines: 0, otherRuns: [] },
    foreignRuns: [],
  };
  const keys = [...new Set([folder.id, basename(folder.dir)])];
  const textCameras: Sourced<string[]>[] = [];
  const redactedEnums: Sourced<EnumCheck>[] = [];
  for (const log of folder.textLogs) {
    out.searched.push(log.file);
    const run = runLines(log.file, log.lines, keys);
    out.skipped.reportLines += run.reportLines;
    out.skipped.quickcheckLines += run.quickcheckLines;
    out.skipped.otherRunLines += run.otherRunLines;
    out.skipped.otherRuns.push(...run.otherRuns);
    out.foreignRuns.push(...run.foreignRuns);
    const nonEmpty = run.lines.filter((l) => l.text.trim() !== '').length;
    out.textLines += nonEmpty;
    if (nonEmpty > 0) out.consoleFound = true;
    const later = takeTextLog(out, run.lines);
    textCameras.push(...later.cameras);
    redactedEnums.push(...later.enums);
  }
  for (const f of folder.otherJsonl) {
    out.searched.push(f.file);
    f.rows.forEach((o, i) => {
      const m = ipcMessageOf(o);
      if (m && takeIpc(out, m, `${f.file}:${i + 1}`)) out.consoleFound = true;
    });
  }
  out.searched.push('events.jsonl');
  folder.events.forEach((ev, i) => {
    const m = ipcMessageOf(ev as unknown as JsonObject);
    if (m && takeIpc(out, m, `events.jsonl:${i + 1}`)) out.consoleFound = true;
  });
  // tap's IPC message decides the camera list: the console's stays only where it says the same
  // (its line is then the source shown) or where no message came. Redacted enum lines likewise.
  out.cameras = cameraListOf(out.cameras, textCameras);
  for (const c of redactedEnums) if (!out.enums.some((x) => x.value.label === c.value.label)) out.enums.push(c);
  out.enums.sort(enumOrder);
  // tap's camera names that reached tap.log before their header are no SDK log lines.
  const cameraNames = new Set(out.cameras?.value ?? []);
  if (cameraNames.size > 0) out.logLines = out.logLines.filter((l) => !cameraNames.has(l.text));
  // A tap version that logs decoded messages: probe the first one and the first with landmarks,
  // through the accessors of reduce.cjs (probeMetrics).
  const decoded = folder.raw.filter((r) => r.kind === 'metrics' && r.decoded !== null);
  if (decoded.length > 0) {
    out.searched.push('sdk_raw.jsonl.gz (decoded messages)');
    const first = decoded[0]!;
    addProbe(out, { ...probeDecodedMessage(first.decoded), packet: 1 }, `sdk_raw.jsonl.gz seq ${first.seq ?? '?'}`);
    const withFrames = decoded.findIndex((r) => probeDecodedMessage(r.decoded).frames > 0);
    if (withFrames > 0) {
      const r = decoded[withFrames]!;
      addProbe(out, { ...probeDecodedMessage(r.decoded), packet: withFrames + 1 }, `sdk_raw.jsonl.gz seq ${r.seq ?? '?'}`);
    }
  }
  // The camera tap chose is also in manifest.json (spec 8.1).
  const cam = folder.manifest?.['camera'];
  if (out.camera === null && cam && typeof cam === 'object') {
    const c = cam as JsonObject;
    const sdk = folder.manifest?.['sdk'];
    const metrics = sdk && typeof sdk === 'object' ? stringList((sdk as JsonObject)['metrics']) : null;
    out.camera = { value: { name: strOrNull(c['name']), requested: numberList(c['requested']), metrics }, source: 'manifest.json' };
  }
  return out;
}
