// What the live view of a take shows (spec 15.1, 15.2), as plain data: the chest trace on Deck's
// sample clock, normalised by its running 10th to 90th percentile; D1 fires; the spans while the
// narrator is stopped, by cause; the narrator and microphone levels; the trace samples per second the
// page receives; whether D1 is active; and the stops of the take by cause for its summary. No DOM and
// no timers: web/ui/live-view.ts draws it.
import { SAMPLE_RATE_HZ } from '../scenarios/format.ts';
import type { FromDeck, FromWorker, TapState } from './messages.ts';

/** The lanes show the last 12 s. */
export const LANE_SECONDS = 12;
/** The trace is normalised by its 10th and 90th percentiles over the last 30 s. */
export const NORM_SECONDS = 30;
export const NORM_LOW_PCT = 10;
export const NORM_HIGH_PCT = 90;
/** Trace samples per second are counted over the last 5 s (a shorter span when the trace is younger). */
export const RATE_SECONDS = 5;
/** Data older than this is dropped. */
const KEEP_SECONDS = Math.max(LANE_SECONDS, NORM_SECONDS, RATE_SECONDS) + 5;

export type StopCause = 'chest' | 'voice' | 'key';
export type DetectorShown = 'not_yet' | 'active' | 'not_active' | 'off';

export interface TracePoint {
  /** Position on Deck's sample clock. */
  n: number;
  /** Value times the sign of the run as now known. */
  v: number;
}

export interface FireMark {
  n: number;
  v: number;
  theta: number;
}

export interface StopSpan {
  cause: StopCause;
  n0: number;
  /** Where the narrator went on (resume) or the reading ended; null while it is stopped. */
  n1: number | null;
}

export interface LevelPoint {
  /** End of the level's window on Deck's sample clock. */
  n: number;
  ch0Db: number;
  ch1Db: number;
}

export interface SdkShown {
  tap: TapState;
  ok: boolean;
  note?: string;
}

/** The p-th percentile (0-100) of values, by linear interpolation between order statistics. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const at = (Math.min(100, Math.max(0, p)) / 100) * (s.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return s[lo]! + (s[hi]! - s[lo]!) * (at - lo);
}

/**
 * Value mapped so that the running 10th percentile is 0 and the 90th is 1 (the trace lane draws 0 to 1
 * with room above and below). A flat trace maps to 0.5.
 */
export function normalise(v: number, low: number, high: number): number {
  if (!Number.isFinite(low) || !Number.isFinite(high) || high - low <= 1e-12) return 0.5;
  return (v - low) / (high - low);
}

/** Stop cause of a Deck state message: only the stopped states carry one (spec 6.4). */
export function stoppedCause(s: string, cause: unknown): StopCause | null {
  if (s !== 'hold_wait' && s !== 'listening') return null;
  return cause === 'chest' || cause === 'voice' || cause === 'key' ? cause : null;
}

/** While the SDK runs without the readiness of spec 7.1 and without a code that is not kOk to name. */
export const SDK_WAITING_TEXT = 'waiting for kOk';

/**
 * The SDK part of the info line: the name of the status code while it is not kOk (or that the /tap
 * socket closed); kOk only while the worker's readiness holds (Running with kOk held 5 s, spec 7.1,
 * web/lib/sdk-ready.ts); 'waiting for kOk' while the SDK runs without it (no validationStatus yet,
 * processingStatus not Running, or kOk not held 5 s yet); else the tap state.
 */
export function sdkStatusText(sdk: SdkShown | null): string {
  if (sdk === null) return 'not running';
  if (sdk.note) return sdk.note;
  if (sdk.tap === 'stopped') return 'not running';
  if (sdk.tap === 'starting') return 'starting';
  return sdk.ok ? 'kOk' : SDK_WAITING_TEXT;
}

/** "SmartSpectra SDK 3.5.0 · 30 samples/s · kOk" (spec 15.1, 15.2). */
export function infoLine(version: string | null, samplesPerSecond: number, sdk: SdkShown | null): string {
  const v = version ?? 'version unknown';
  return `SmartSpectra SDK ${v} · ${Math.round(samplesPerSecond)} samples/s · ${sdkStatusText(sdk)}`;
}

/** The detector line under the lanes (spec 7.4). */
export function detectorText(shown: DetectorShown): string {
  switch (shown) {
    case 'active':
      return 'chest detector: active';
    case 'not_active':
      return 'chest detector: not active';
    case 'off':
      return 'chest detector: off in this run';
    default:
      return 'chest detector: not active yet';
  }
}

export class LiveModel {
  readonly trace: TracePoint[] = [];
  readonly fires: FireMark[] = [];
  readonly stops: StopSpan[] = [];
  readonly levels: LevelPoint[] = [];
  /** Packets' trace sample counts at their arrival, for samples per second. */
  private readonly counts: Array<{ n: number; count: number }> = [];
  private sign: 1 | -1 = 1;
  private levelMessages = 0;
  private latest = 0;
  private detector: DetectorShown = 'not_yet';
  private stepName: string | null = null;
  sdk: SdkShown | null = null;

  /** levelWindowSamples: the window Deck sums each level message over (processorOptions). */
  constructor(private readonly levelWindowSamples: number) {}

  /** The last sample Deck is known to have reached. */
  get latestN(): number {
    return this.latest;
  }

  get currentStep(): string | null {
    return this.stepName;
  }

  get detectorShown(): DetectorShown {
    return this.detector;
  }

  /** The cause of the stop going on now, or null while the narrator is not stopped. */
  get badge(): StopCause | null {
    const last = this.stops[this.stops.length - 1];
    return last !== undefined && last.n1 === null ? last.cause : null;
  }

  /** Stops of this take by cause, counted on the page from Deck's state messages. */
  stopCounts(): Record<StopCause, number> {
    const out: Record<StopCause, number> = { chest: 0, voice: 0, key: 0 };
    for (const s of this.stops) out[s.cause] += 1;
    return out;
  }

  private seen(n: number): void {
    if (Number.isFinite(n) && n > this.latest) this.latest = n;
  }

  /** A message of Deck to the page. */
  deck(msg: FromDeck): void {
    switch (msg.k) {
      case 'step':
        this.seen(msg.n);
        this.stepName = msg.name;
        break;
      case 'click':
      case 'cue':
        this.seen(msg.n);
        break;
      case 'state':
        this.seen(msg.n);
        this.onState(msg.n, msg.s, msg.cause);
        break;
      case 'level':
        // Deck counts its level windows from sample 0, so the k-th message ends at k windows.
        this.levelMessages += 1;
        this.addLevel(this.levelMessages * this.levelWindowSamples, msg.ch0Db, msg.ch1Db);
        break;
      case 'done':
        this.seen(msg.n);
        this.closeStop(msg.n);
        break;
      default:
        break;
    }
  }

  /** A message of the worker to the page. Returns true for the live view's own messages. */
  worker(msg: FromWorker): boolean {
    switch (msg.k) {
      case 'trace':
        this.addTrace(msg.n, msg.sign, msg.count, msg.pts);
        return true;
      case 'fire':
        this.seen(msg.n);
        this.fires.push({ n: msg.n, v: msg.v, theta: msg.theta });
        this.prune();
        return true;
      case 'armed':
        if (this.detector !== 'off') this.detector = msg.on ? 'active' : this.detector === 'not_yet' ? 'not_yet' : 'not_active';
        return true;
      case 'sdk':
        this.sdk = { tap: msg.tap, ok: msg.ok, ...(msg.note ? { note: msg.note } : {}) };
        return false;
      default:
        return false;
    }
  }

  /** The deep breaths gave no sign: D1 never stops the narrator in this run (spec 7.11). */
  signFailed(): void {
    this.detector = 'off';
  }

  private onState(n: number, s: string, cause: unknown): void {
    const c = stoppedCause(s, cause);
    const open = this.badge !== null;
    if (c !== null && !open) this.stops.push({ cause: c, n0: n, n1: null });
    else if (c === null && open) this.closeStop(n);
  }

  private closeStop(n: number): void {
    const last = this.stops[this.stops.length - 1];
    if (last !== undefined && last.n1 === null) last.n1 = Math.max(last.n0, n);
  }

  addLevel(n: number, ch0Db: number, ch1Db: number): void {
    this.seen(n);
    this.levels.push({ n, ch0Db, ch1Db });
    this.prune();
  }

  /**
   * One packet's trace at its arrival sample n. Its points spread back from n by their camera time
   * before the packet's newest point. A new sign of the run flips what is stored, so the trace on
   * screen keeps one direction.
   */
  addTrace(n: number, sign: 1 | -1, count: number, pts: ReadonlyArray<readonly [number, number]>): void {
    this.seen(n);
    if (sign !== this.sign) {
      for (const p of this.trace) p.v = -p.v;
      this.sign = sign;
    }
    this.counts.push({ n, count });
    let newest = Number.NEGATIVE_INFINITY;
    for (const [t] of pts) if (t > newest) newest = t;
    for (const [t, v] of pts) {
      if (!Number.isFinite(v)) continue;
      this.trace.push({ n: n - ((newest - t) * SAMPLE_RATE_HZ) / 1e6, v });
    }
    this.prune();
  }

  /**
   * Trace samples per second the page received over the last RATE_SECONDS up to sample `now`, by
   * arrival sample. A trace younger than that is divided by its own age (at least 1 s).
   */
  samplesPerSecond(now: number = this.latest): number {
    const span = RATE_SECONDS * SAMPLE_RATE_HZ;
    const from = now - span;
    let sum = 0;
    for (const c of this.counts) if (c.n > from && c.n <= now) sum += c.count;
    const oldest = this.counts[0];
    if (sum === 0 || oldest === undefined) return 0;
    const covered = Math.max(SAMPLE_RATE_HZ, Math.min(span, now - oldest.n));
    return (sum * SAMPLE_RATE_HZ) / covered;
  }

  /** The running 10th and 90th percentiles of the trace over the last NORM_SECONDS up to `now`. */
  traceRange(now: number = this.latest): { low: number; high: number } {
    const from = now - NORM_SECONDS * SAMPLE_RATE_HZ;
    const vals = this.trace.filter((p) => p.n > from && p.n <= now).map((p) => p.v);
    return { low: percentile(vals, NORM_LOW_PCT), high: percentile(vals, NORM_HIGH_PCT) };
  }

  /** Lines of the summary of this take (spec 15.2): the stops by cause. */
  summaryLines(): string[] {
    const c = this.stopCounts();
    const lines = [`CHEST stops: ${c.chest}`, `VOICE stops: ${c.voice}`];
    if (c.key > 0) lines.push(`KEY stops: ${c.key}`);
    return lines;
  }

  private prune(): void {
    const from = this.latest - KEEP_SECONDS * SAMPLE_RATE_HZ;
    dropBefore(this.trace, from);
    dropBefore(this.counts, from);
    dropBefore(this.levels, from);
    dropBefore(this.fires, from);
  }
}

/** Drops the leading items with n before `from` (items are in n order, or nearly). */
function dropBefore(items: Array<{ n: number }>, from: number): void {
  let k = 0;
  while (k < items.length && items[k]!.n < from) k += 1;
  if (k > 0) items.splice(0, k);
}
