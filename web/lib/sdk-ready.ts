// "Waiting for kOk" (spec 7.1): ok while processingStatus is Running and validationStatus kOk
// (code 0) has held for 5 s. Time is the Deck sample clock as the worker last saw it (stamps and
// chunks), never a timer. The page shows `note` while it waits (docs/protocol.md {k:'sdk'}).
// A closed /tap socket ends it: no packet reaches the worker any more.

import type { TapState } from './messages.ts';
import { SDK_OK_HOLD_SAMPLES } from './units.ts';

export const VALIDATION_OK = 0;
/** processingStatus code of kRunning (live/lib/sdk-codes.cjs). */
export const PROCESSING_RUNNING = 3;
/** `note` once the /tap socket has closed. */
export const TAP_SOCKET_CLOSED_NOTE = 'tap socket closed';

/** processingStatus names arrive as 'kRunning' (tap) or 'Running'. */
export function isRunningStatus(name: unknown, code?: unknown): boolean {
  if (typeof name === 'string') return name.replace(/^k(?=[A-Z])/, '').toLowerCase() === 'running';
  return code === PROCESSING_RUNNING;
}

export interface SdkStatus {
  tap: TapState;
  ok: boolean;
  /** Name of the current validationStatus code when it is not kOk, or that the /tap socket closed. */
  note?: string;
}

export class SdkReadiness {
  private tap: TapState = 'stopped';
  private running = false;
  private code: number | null = null;
  private codeName: string | null = null;
  /** Sample where Running with kOk began; null while either is missing. */
  private okSince: number | null = null;
  private ok = false;
  private socketClosed = false;

  constructor(private readonly holdSamples: number = SDK_OK_HOLD_SAMPLES) {}

  /** host's {t:'tap', status}. */
  onTap(status: TapState): void {
    this.tap = status;
  }

  /** The /tap socket closed: never ok again. */
  onSocketClosed(): void {
    this.socketClosed = true;
    this.okSince = null;
    this.ok = false;
  }

  /** An `s` line of /tap at worker sample n. */
  onProcessing(name: unknown, code: unknown, n: number): void {
    this.running = isRunningStatus(name, code);
    this.restart(n);
  }

  /** A `v` line of /tap at worker sample n. */
  onValidation(code: number, name: unknown, n: number): void {
    this.code = code;
    this.codeName = typeof name === 'string' && name ? name : `code_${code}`;
    this.restart(n);
  }

  /** The worker's sample clock moved to n. */
  onClock(n: number): void {
    this.ok = this.okSince !== null && n - this.okSince >= this.holdSamples;
  }

  status(): SdkStatus {
    const out: SdkStatus = { tap: this.tap, ok: this.ok };
    if (this.socketClosed) out.note = TAP_SOCKET_CLOSED_NOTE;
    else if (this.code !== null && this.code !== VALIDATION_OK && this.codeName) out.note = this.codeName;
    return out;
  }

  private restart(n: number): void {
    const good = !this.socketClosed && this.running && this.code === VALIDATION_OK;
    if (!good) this.okSince = null;
    else if (this.okSince === null) this.okSince = n;
    this.onClock(n);
  }
}
