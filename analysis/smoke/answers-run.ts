// Smoke questions 7 to 10 (spec 7.12): the 2 s lens cover (spec 15.2), tap's event loop and the
// watchdog of host (spec 7.2), the credit balance pauses (spec 11.5) and Insights uploads in the
// SDK log (spec 12.1).

import { tapLoopP99Ms, type SampleLine } from '../../core/clock/index.ts';
import { median } from '../../core/stats/index.ts';
import { windowRate } from './answers-time.ts';
import { findStep, lineSamples, SMOKE_STEPS, stepAt, type SmokeContext } from './context.ts';
import { finite, fmtMs, fmtPerS, fmtS, r1, r3, redactLogText } from './numbers.ts';
import { validationName } from './reduce-adapter.ts';
import { errorLabel, isRunningName, processingLineName, sdkErrorsSeen, type Answer } from './sdk-events.ts';
import { consoleNote } from './tap-output.ts';

/** host's watchdog: 3 s without an SDK packet while Running is tap_lost (spec 7.2; live/host.cjs TAP_SILENCE_MS). */
export const WATCHDOG_SILENCE_MS = 3000;
/** Planned credit use per camera minute: nominal 2.0, and 2.4 as one participant reported (spec 11.1). */
export const CREDITS_PER_MIN_LOW = 2.0;
export const CREDITS_PER_MIN_HIGH = 2.4;
const LENS_AFTER_S = 5;
const LENS_COVER_S = 2;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ---- 7. Lens cover -------------------------------------------------------------------------

interface CodeAt {
  code: number;
  name: string;
  n: number;
}

function validationCodesInOrder(ctx: SmokeContext): CodeAt[] {
  const out: CodeAt[] = [];
  for (const l of ctx.byKind.v) {
    const n = lineSamples(ctx, l);
    if (n === null || !isNum(l.code)) continue;
    out.push({ code: l.code, name: typeof l.name === 'string' ? l.name : validationName(l.code), n });
  }
  return out.sort((a, b) => a.n - b.n);
}

/** Longest gap between consecutive SDK packets, ms on tap's clock, with the sample number where it ended. */
export function longestPacketGap(ctx: SmokeContext, fromN = -Infinity, toN = Infinity): { ms: number; endN: number | null } | null {
  const pts = ctx.packets
    .filter((p): p is typeof p & { relNs: number } => p.relNs !== null)
    .map((p) => ({ rel: p.relNs, n: p.nArr ?? (ctx.tapToSamples ? ctx.tapToSamples.toSamples(p.relNs) : null) }))
    .sort((a, b) => a.rel - b.rel);
  let best: { ms: number; endN: number | null } | null = null;
  for (let i = 1; i < pts.length; i++) {
    const end = pts[i]!;
    if (end.n !== null && (end.n < fromN || end.n > toN)) continue;
    const ms = (end.rel - pts[i - 1]!.rel) / 1e6;
    if (best === null || ms > best.ms) best = { ms, endN: end.n };
  }
  return best;
}

export function answerLens(ctx: SmokeContext): Answer {
  const rate = ctx.sampleRateHz;
  const cover = findStep(ctx.steps, SMOKE_STEPS.lensCover);
  if (cover === null) {
    return {
      n: 7,
      title: 'Lens cover',
      lines: ['Lens cover: no lens_cover step mark in stamps.jsonl: the run ended before it, or Deck stamps are missing.'],
      data: { covered: false },
    };
  }
  const coverEndN = cover.endN ?? cover.n + LENS_COVER_S * rate;
  const uncover = findStep(ctx.steps, SMOKE_STEPS.lensUncover);
  const afterEndN = uncover?.endN ?? coverEndN + LENS_AFTER_S * rate;
  const codes = validationCodesInOrder(ctx);
  const before = codes.filter((c) => c.n < cover.n).pop() ?? null;
  const inWindow = codes.filter((c) => c.n >= cover.n && c.n < afterEndN);
  const changes: CodeAt[] = [];
  let prev = before?.code ?? null;
  for (const c of inWindow) {
    if (c.code !== prev) changes.push(c);
    prev = c.code;
  }
  const firstNotOk = inWindow.find((c) => c.code !== 0) ?? null;
  const notOkAfterUncover = firstNotOk !== null;
  const okBack = notOkAfterUncover ? (codes.find((c) => c.n >= Math.max(coverEndN, firstNotOk.n) && c.code === 0) ?? null) : null;
  const ms = (n: number, from: number) => ((n - from) / rate) * 1000;
  const processing = ctx.byKind.s
    .map((l: SampleLine) => ({ name: processingLineName(l), n: lineSamples(ctx, l) }))
    .filter((x): x is { name: string; n: number } => x.name !== null && x.n !== null && x.n >= cover.n && x.n < afterEndN);
  const errors = sdkErrorsSeen(ctx).filter((e) => e.atS !== null && e.atS * rate >= cover.n && e.atS * rate < afterEndN + 2 * rate);
  const traceCover = windowRate(ctx, 'cover', cover.name, SMOKE_STEPS.lensUncover, cover.n, coverEndN);
  const gap = longestPacketGap(ctx, cover.n, afterEndN);

  const lines: string[] = [];
  const at = (n: number) => fmtS(n / rate);
  lines.push(
    `Lens covered at ${at(cover.n)} for ${fmtS((coverEndN - cover.n) / rate)}; status before: ${before ? `${before.code} ${before.name}` : 'none yet'}.`,
  );
  if (changes.length === 0) {
    lines.push(`validationStatus: no change from the cover to ${LENS_AFTER_S} s after uncovering${inWindow.length === 0 ? ' (no validationStatus line in that window)' : ''}.`);
  } else {
    lines.push(`validationStatus: ${changes.map((c) => `${c.code} ${c.name} at ${c.n >= coverEndN ? `+${fmtMs(ms(c.n, coverEndN))} after uncovering` : `+${fmtMs(ms(c.n, cover.n))}`}`).join(', ')}.`);
  }
  if (okBack) lines.push(`kOk again ${fmtMs(ms(okBack.n, coverEndN))} after uncovering.`);
  else if (notOkAfterUncover) lines.push('kOk did not come back in the logged lines.');
  if (processing.length > 0) lines.push(`processingStatus in the window: ${processing.map((p) => p.name).join(', ')}.`);
  lines.push(
    errors.length === 0
      ? 'SDK error event during or after the cover: none.'
      : `SDK error event during or after the cover: ${errors.map((e) => errorLabel(e)).join('; ')}. The demo signal check keeps only the deep breath (spec 15.2).`,
  );
  if (traceCover !== null) lines.push(`Trace while covered: ${traceCover.samples} samples (mean ${fmtPerS(traceCover.meanPerS)}).`);
  if (gap !== null) lines.push(`Longest packet gap from the cover to ${LENS_AFTER_S} s after: ${fmtMs(gap.ms)} (watchdog ${WATCHDOG_SILENCE_MS} ms).`);
  return {
    n: 7,
    title: 'Lens cover',
    lines,
    data: {
      covered: true,
      cover_start_s: r3(cover.n / rate),
      cover_s: r3((coverEndN - cover.n) / rate),
      status_before: before && { code: before.code, name: before.name },
      validation_changes: changes.map((c) => ({ code: c.code, name: c.name, ms_after_cover: r1(ms(c.n, cover.n)) })),
      ok_back_ms_after_uncover: okBack ? r1(ms(okBack.n, coverEndN)) : null,
      processing_statuses: processing.map((p) => p.name),
      errors: errors.map((e) => ({ code: e.code, name: e.name, message: e.message })),
      trace_samples_while_covered: traceCover?.samples ?? null,
      trace_mean_per_s_while_covered: r1(traceCover?.meanPerS),
      longest_packet_gap_ms: r1(gap?.ms),
    },
  };
}

// ---- 8. Event loop and watchdog ------------------------------------------------------------

function loopValues(lines: readonly SampleLine[], key: 'p50' | 'max'): number[] {
  return finite(lines.map((l) => (key === 'p50' ? (l.p50Ms ?? l.p50_ms) : (l.maxMs ?? l.max_ms))));
}

/** Longest silence host's watchdog would measure while Running (spec 7.2, live/host.cjs watchTap). */
export interface HostSilence {
  /** 'pulses': host's rule replayed from Running and tap's 1 s pulses; 'packets': from the packets alone. */
  method: 'pulses' | 'packets';
  ms: number;
  /** tap clock (ns from the earliest tArrNs) where the silence ended. */
  endRelNs: number;
  /** What it started from: the Running status or the last pulse (or packet) before it. */
  from: 'running' | 'pulse' | 'packet';
}

/** Where host stops watching: the scenario's end mark on tap's clock, else the last tap line. */
function watchEndRelNs(ctx: SmokeContext): number | null {
  const end = findStep(ctx.steps, SMOKE_STEPS.end);
  if (end !== null && ctx.tapToSamples !== null) return ctx.tapToSamples.toRelNs(end.n);
  const rels = finite([...ctx.byKind.l, ...ctx.byKind.m, ...ctx.byKind.s].map((l) => ctx.clock.relNs(l.tArrNs)));
  return rels.length > 0 ? Math.max(...rels) : null;
}

/**
 * host's watchdog replayed (live/host.cjs): Running starts the clock, a pulse that reports packets
 * resets it, and 3 s of silence while Running is tap_lost. tap writes its `l` line in the same
 * once-a-second tick as the pulse (live/tap.cjs everySecond), so the `l` lines are the pulse times
 * and the packets between two of them are that pulse's count. method 'pulses' needs `l` lines;
 * without them, 'packets' measures from Running and each packet (host sees up to 1 s more).
 */
export function hostSilence(ctx: SmokeContext): HostSilence | null {
  const statuses = ctx.byKind.s
    .map((l) => ({ t: ctx.clock.relNs(l.tArrNs), running: isRunningName(processingLineName(l)) }))
    .filter((x): x is { t: number; running: boolean } => x.t !== null);
  const packets = finite(ctx.packets.map((p) => p.relNs)).sort((a, b) => a - b);
  const pulseTimes = finite(ctx.byKind.l.map((l) => ctx.clock.relNs(l.tArrNs))).sort((a, b) => a - b);
  const end = watchEndRelNs(ctx);
  if (end === null || !statuses.some((x) => x.running)) return null;
  const method: HostSilence['method'] = pulseTimes.length > 0 ? 'pulses' : 'packets';
  type Ev = { t: number; kind: 'status'; running: boolean } | { t: number; kind: 'reset' } | { t: number; kind: 'end' };
  const events: Ev[] = statuses.map((x) => ({ t: x.t, kind: 'status' as const, running: x.running }));
  if (method === 'pulses') {
    let k = 0;
    for (const t of pulseTimes) {
      let count = 0;
      while (k < packets.length && packets[k]! < t) {
        count++;
        k++;
      }
      if (count > 0) events.push({ t, kind: 'reset' });
    }
  } else {
    for (const t of packets) events.push({ t, kind: 'reset' });
  }
  events.push({ t: end, kind: 'end' });
  // At one time: a status first (host hears of Running before the pulse that follows it), the end last.
  const order = { status: 0, reset: 1, end: 2 };
  events.sort((a, b) => a.t - b.t || order[a.kind] - order[b.kind]);
  let running = false;
  let last: number | null = null;
  let lastFrom: HostSilence['from'] = 'running';
  let best: HostSilence | null = null;
  const consider = (t: number) => {
    if (!running || last === null) return;
    const ms = (t - last) / 1e6;
    if (best === null || ms > best.ms) best = { method, ms, endRelNs: t, from: lastFrom };
  };
  for (const ev of events) {
    if (ev.t > end) break;
    if (ev.kind === 'status') {
      if (ev.running && !running) {
        running = true;
        last = ev.t;
        lastFrom = 'running';
      } else if (!ev.running && running) {
        consider(ev.t);
        running = false;
      }
    } else if (ev.kind === 'reset') {
      consider(ev.t);
      last = ev.t;
      lastFrom = method === 'pulses' ? 'pulse' : 'packet';
    } else {
      consider(ev.t);
    }
  }
  return best;
}

/** Pulses come once a second, so host may see a packet up to this much later than tap (method 'packets'). */
const PULSE_PERIOD_MS = 1000;
/** live/host.cjs checks the silence every 200 ms (WATCH_EVERY_MS); closer to the rule than this is a toss-up. */
const HOST_CHECK_MS = 200;

/**
 * Would host's watchdog fire: true, false, or null when the silence is within one check period of
 * the rule (pulse timing and IPC delay decide). Without `l` lines the pulses are not known, so
 * host's silence lies within one pulse period of the packet silence.
 */
export function watchdogWouldFire(silence: Pick<HostSilence, 'method' | 'ms'>): boolean | null {
  const slack = silence.method === 'pulses' ? 0 : PULSE_PERIOD_MS;
  if (silence.ms - slack > WATCHDOG_SILENCE_MS + HOST_CHECK_MS) return true;
  if (silence.ms + slack < WATCHDOG_SILENCE_MS - HOST_CHECK_MS) return false;
  return null;
}

export function answerWatchdog(ctx: SmokeContext): Answer {
  const l = ctx.byKind.l;
  const p50 = loopValues(l, 'p50');
  const max = loopValues(l, 'max');
  const p99 = tapLoopP99Ms(ctx.coreSamples);
  const gap = longestPacketGap(ctx);
  const stepOfRel = (rel: number | null): { atS: number | null; step: string | null } => {
    if (rel === null || ctx.tapToSamples === null) return { atS: null, step: null };
    const n = ctx.tapToSamples.toSamples(rel);
    return { atS: n / ctx.sampleRateHz, step: stepAt(ctx.steps, n)?.name ?? 'before the first step' };
  };
  const gapStep = gap?.endN != null ? (stepAt(ctx.steps, gap.endN)?.name ?? 'before the first step') : null;
  const rel = finite(ctx.packets.map((p) => p.relNs)).sort((a, b) => a - b);
  const gaps = rel.slice(1).map((r, i) => (r - rel[i]!) / 1e6);
  const runningLine = ctx.byKind.s.find((s) => isRunningName(processingLineName(s)));
  const runningRel = runningLine ? ctx.clock.relNs(runningLine.tArrNs) : null;
  const firstAfter = runningRel === null ? null : (rel.find((r) => r >= runningRel) ?? null);
  const firstPacketMs = runningRel !== null && firstAfter !== null ? (firstAfter - runningRel) / 1e6 : null;
  const tapLost = ctx.folder.events.filter((e) => e.e === 'tap_lost').length;
  const silence = hostSilence(ctx);
  const silenceAt = stepOfRel(silence?.endRelNs ?? null);
  const fires: boolean | null = silence === null ? null : watchdogWouldFire(silence);

  const lines: string[] = [];
  lines.push(
    l.length === 0
      ? 'tap event loop: no `l` line in samples.jsonl.'
      : `tap event loop over ${l.length} s: per-second p50 median ${fmtMs(median(p50))}, p99 ${fmtMs(p99)} (P99 of the per-second P99), max ${fmtMs(max.length ? Math.max(...max) : null)}.`,
  );
  if (gap === null) {
    lines.push('Packet gaps: fewer than two packets.');
  } else {
    const where = gap.endN === null ? '' : ` ending at ${fmtS(gap.endN / ctx.sampleRateHz)} (step ${gapStep})`;
    lines.push(`Longest gap between SDK packets: ${fmtMs(gap.ms)}${where}; p99 ${fmtMs(quantile99(gaps))}, median ${fmtMs(median(gaps))}.`);
  }
  if (firstPacketMs !== null) lines.push(`First packet ${fmtMs(firstPacketMs)} after Running.`);
  const rule = `${WATCHDOG_SILENCE_MS} ms without a packet while Running is tap_lost (spec 7.2)`;
  if (silence === null) {
    const samplesPresent = ctx.folder.inputs.some((i) => i.file === 'samples.jsonl' && i.present);
    const why = runningLine ? 'no tap time for the end of the run' : samplesPresent ? 'no processingStatus line in samples.jsonl says Running' : 'samples.jsonl is missing';
    lines.push(`Watchdog: ${rule}; cannot replay it: ${why}.`);
  } else {
    const where = silenceAt.atS === null ? '' : ` ending at ${fmtS(silenceAt.atS)} (step ${silenceAt.step})`;
    const from = silence.from === 'running' ? 'counted from Running' : silence.from === 'pulse' ? 'counted from the last pulse with packets' : 'counted from the last packet';
    const verdict =
      fires === true
        ? 'host WOULD fire tap_lost on this run'
        : fires === false
          ? `it would not fire (margin ${fmtMs(WATCHDOG_SILENCE_MS - silence.ms)})`
          : silence.method === 'pulses'
            ? `it MAY fire: within host's ${HOST_CHECK_MS} ms check period of the rule, so pulse timing decides`
            : `it MAY fire: host sees packets once a second, up to ${PULSE_PERIOD_MS} ms later`;
    lines.push(
      silence.method === 'pulses'
        ? `Watchdog: ${rule}. Replayed from Running and tap's 1 s pulses (the \`l\` lines): longest silence host would see ${fmtMs(silence.ms)}${where}, ${from}: ${verdict}.`
        : `Watchdog: ${rule}. No \`l\` lines, so from Running and the packets: longest silence ${fmtMs(silence.ms)}${where}, ${from}: ${verdict}.`,
    );
  }
  if (tapLost > 0) lines.push(`host wrote ${tapLost} tap_lost event${tapLost > 1 ? 's' : ''}.`);
  return {
    n: 8,
    title: 'Event loop and watchdog',
    lines,
    data: {
      loop_seconds: l.length,
      loop_p50_median_ms: r1(median(p50)),
      loop_p99_ms: r1(p99),
      loop_max_ms: r1(max.length ? Math.max(...max) : null),
      longest_packet_gap_ms: r1(gap?.ms),
      longest_gap_end_s: gap?.endN != null ? r3(gap.endN / ctx.sampleRateHz) : null,
      longest_gap_step: gapStep,
      packet_gap_p99_ms: r1(quantile99(gaps)),
      packet_gap_median_ms: r1(median(gaps)),
      watchdog_ms: WATCHDOG_SILENCE_MS,
      host_silence_ms: r1(silence?.ms),
      host_silence_method: silence?.method ?? null,
      host_silence_from: silence?.from ?? null,
      host_silence_end_s: r3(silenceAt.atS),
      host_silence_step: silenceAt.step,
      watchdog_margin_ms: silence === null ? null : r1(WATCHDOG_SILENCE_MS - silence.ms),
      watchdog_would_fire: fires,
      first_packet_after_running_ms: r1(firstPacketMs),
      tap_lost_events: tapLost,
    },
  };
}

function quantile99(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const h = (s.length - 1) * 0.99;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, s.length - 1);
  return s[lo]! + (h - lo) * (s[hi]! - s[lo]!);
}

// ---- 9. Credits ----------------------------------------------------------------------------

/** Balances read on the developer portal before and after the run, typed in later (spec 11.5); either may be null. */
export interface CreditBalances {
  before: number | null;
  after: number | null;
}

export const NO_BALANCES: CreditBalances = { before: null, after: null };

/** "100,94.6" in the order before, after; a blank stays null. */
export function parseCreditBalances(text: string): CreditBalances | string {
  const parts = text.split(',').map((s) => s.trim());
  if (parts.length > 2) {
    return 'give two balances, before and after the run: the smoke run has no balance pauses, so the price of checkDeviceReadiness() and of a 5 s run cannot be read';
  }
  const vals: (number | null)[] = [];
  for (const p of parts) {
    if (p === '') vals.push(null);
    else if (/^\d+(\.\d+)?$/.test(p)) vals.push(Number(p));
    else return `"${p}" is not a credit balance`;
  }
  return { before: vals[0] ?? null, after: vals[1] ?? null };
}

const hhmmss = (us: number | null): string | null => (us === null ? null : `${new Date(Math.round(us / 1000)).toISOString().slice(11, 19)} UTC`);

/**
 * Question 9. The SDK has no balance call: you read it on the portal (spec 11.5). The price of
 * checkDeviceReadiness() and of a run stopped after 5 s (spec 11.5 item 4) needs balance pauses,
 * which web/scenarios/smoke.ts does not have (a gap for the scenario and tap owners). So the
 * report reads two balances, before and after, and says that only the whole run is measured.
 */
export function answerCredits(ctx: SmokeContext, balances: CreditBalances): Answer {
  const walls = finite(ctx.folder.raw.map((r) => r.tWallMs));
  const firstMs = walls.length ? Math.min(...walls) : null;
  const lastMs = walls.length ? Math.max(...walls) : null;
  let minutes = firstMs !== null && lastMs !== null ? (lastMs - firstMs) / 60000 : null;
  let span = 'first to last SDK callback';
  if (minutes === null) {
    const a = Date.parse(String(ctx.folder.manifest?.['consent_utc'] ?? ''));
    const b = Date.parse(String(ctx.folder.manifest?.['ended_utc'] ?? ''));
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
      minutes = (b - a) / 60000;
      span = 'consent to end in manifest.json';
    }
  }
  const b = balances;
  const total = b.before !== null && b.after !== null ? Math.round((b.before - b.after) * 1000) / 1000 : null;
  const perMin = total !== null && minutes !== null && minutes > 0 ? total / minutes : null;

  const lines: string[] = [];
  if (minutes !== null) {
    lines.push(
      `Camera on about ${r1(minutes)} min (${span}${firstMs !== null ? `, ${hhmmss(firstMs * 1000)} to ${hhmmss(lastMs! * 1000)}` : ''}): about ${r1(minutes * CREDITS_PER_MIN_LOW)} to ${r1(minutes * CREDITS_PER_MIN_HIGH)} credits at ${CREDITS_PER_MIN_LOW} to ${CREDITS_PER_MIN_HIGH} per minute (spec 11.1).`,
    );
  } else {
    lines.push('Camera time: unknown (no sdk_raw.jsonl.gz wall times and no consent and end times in manifest.json).');
  }
  lines.push(
    'Balance pauses: none. web/scenarios/smoke.ts has no pause step and no run stopped after 5 s, so the price of checkDeviceReadiness() and of that short run (spec 11.5 item 4) is not measured; only the whole run is, from the balances before and after it.',
  );
  lines.push(
    `The SDK has no balance call: read the balance on the developer portal (physiology.presagetech.com; refresh the page first), before the run${firstMs !== null ? ` (it started ${hhmmss(firstMs * 1000)})` : ''} and after it (spec 11.5).`,
  );
  if (b.before !== null || b.after !== null) {
    const show = (x: number | null) => (x === null ? '?' : String(x));
    lines.push(
      `Balance: before ${show(b.before)}, after ${show(b.after)}; the run cost ${show(total)} credits${perMin !== null ? `, ${r1(perMin)} per camera minute` : ''}.`,
    );
  } else {
    lines.push(`Type the two balances in later (optional): npx tsx analysis/smoke.ts ${ctx.folder.id} --credits <before>,<after>`);
  }
  return {
    n: 9,
    title: 'Credits',
    lines,
    data: {
      camera_minutes: r3(minutes),
      camera_span: minutes === null ? null : span,
      first_callback_utc: firstMs === null ? null : new Date(firstMs).toISOString(),
      last_callback_utc: lastMs === null ? null : new Date(lastMs).toISOString(),
      planned_credits: minutes === null ? null : [r1(minutes * CREDITS_PER_MIN_LOW), r1(minutes * CREDITS_PER_MIN_HIGH)],
      pauses: [],
      not_measured: ['checkDeviceReadiness()', 'run stopped after 5 s'],
      balance: { before: b.before, after: b.after },
      cost: { total },
      credits_per_camera_minute: r3(perMin),
    },
  };
}

/** Balances kept in an earlier smoke_report.json, so a re-run without --credits keeps them. */
export function balancesFromReport(report: Record<string, unknown> | null): CreditBalances {
  const q = report?.['questions'];
  const q9 = q && typeof q === 'object' ? (q as Record<string, unknown>)['q9_credits'] : null;
  const bal = q9 && typeof q9 === 'object' ? (q9 as Record<string, unknown>)['balance'] : null;
  if (!bal || typeof bal !== 'object') return NO_BALANCES;
  const o = bal as Record<string, unknown>;
  const v = (k: string) => (isNum(o[k]) ? (o[k] as number) : null);
  return { before: v('before'), after: v('after') };
}

// ---- 10. Insights --------------------------------------------------------------------------

/** What counts as a line about sending data (spec 12.1): Insights, uploads, snapshots, telemetry, remote URLs. */
export const UPLOAD_PATTERNS: readonly { label: string; re: RegExp }[] = [
  { label: 'insight', re: /insight/i },
  { label: 'upload', re: /upload/i },
  { label: 'snapshot', re: /snapshot/i },
  { label: 'telemetry', re: /telemetry/i },
  { label: 'send', re: /\bsend(?:s|ing)?\b|\bsent\b/i },
  { label: 'remote URL', re: /\bhttps?:\/\/(?!127\.0\.0\.1|localhost)/i },
];

export function answerInsights(ctx: SmokeContext): Answer {
  const candidates: { where: string; text: string }[] = ctx.tap.logLines
    .filter((l) => !/frameSentThrough/.test(l.text))
    .map((l) => ({ where: `${l.file}:${l.lineNo}`, text: l.text }));
  let rawTexts = 0;
  for (const r of ctx.folder.raw) {
    const texts: string[] = [];
    if (r.kind === 'error' && typeof r.args?.[1] === 'string') texts.push(r.args[1] as string);
    if (r.kind === 'validationStatus' && typeof r.args?.[2] === 'string' && r.args[2] !== '') texts.push(r.args[2] as string);
    if (!['metrics', 'validationStatus', 'processingStatus', 'frameSentThrough', 'error'].includes(r.kind) && r.args) {
      texts.push(JSON.stringify(r.args));
    }
    for (const t of texts) {
      rawTexts++;
      candidates.push({ where: `sdk_raw.jsonl.gz seq ${r.seq ?? '?'} (${r.kind})`, text: t });
    }
  }
  const matches = candidates
    .map((c) => ({ ...c, labels: UPLOAD_PATTERNS.filter((p) => p.re.test(c.text)).map((p) => p.label) }))
    .filter((c) => c.labels.length > 0);
  const answered = ctx.tap.textLines > 0;
  const logs = ctx.folder.textLogs.map((t) => t.file);
  const searched = [
    ...(answered ? [`${logs.join(', ')} (${ctx.tap.textLines} lines of this run, ${ctx.tap.logLines.length} of them not tap's or host's own)`] : []),
    ...(rawTexts > 0 ? [`sdk_raw.jsonl.gz (${rawTexts} messages and hints)`] : []),
  ];
  const skipped = ctx.tap.skipped;
  const left = [
    skipped.reportLines > 0 ? `${skipped.reportLines} lines of an earlier smoke report` : null,
    skipped.quickcheckLines > 0 ? `${skipped.quickcheckLines} lines after "Running the quick check..."` : null,
    skipped.otherRuns.length > 0 ? `the runs of ${skipped.otherRuns.join(', ')}` : null,
  ].filter((x): x is string => x !== null);
  const lines: string[] = [];
  if (!answered) {
    lines.push(
      `Insights: cannot be answered (${consoleNote(ctx.tap, 'no line of this run in the text logs')})${rawTexts > 0 ? `; only ${rawTexts} SDK messages and hints in sdk_raw.jsonl.gz were searched` : ''}. The SDK logs at kInfo to tap's console (spec 7.1).`,
    );
  } else {
    lines.push(`Searched: ${searched.join(', ')}; tap asks for logLevel kInfo in smoke (spec 7.1).${left.length > 0 ? ` Left out: ${left.join('; ')}.` : ''}`);
  }
  if (matches.length > 0) {
    lines.push(`Lines about sending data (${matches.length}): ${matches.slice(0, 5).map((m) => `${m.where} [${m.labels.join(', ')}] "${redactLogText(m.text, 160)}"`).join('; ')}${matches.length > 5 ? '; ...' : ''}.`);
  } else if (answered) {
    lines.push('No logged line mentions Insights, an upload, a snapshot, telemetry, sending or a remote URL.');
  }
  lines.push('The data text on the consent screen stays either way (spec 12.1).');
  return {
    n: 10,
    title: 'Insights',
    lines,
    data: {
      answered,
      searched,
      left_out: { report_lines: skipped.reportLines, quickcheck_lines: skipped.quickcheckLines, other_runs: skipped.otherRuns },
      matches: matches.slice(0, 20).map((m) => ({ where: m.where, labels: m.labels, text: redactLogText(m.text, 300) })),
      match_count: matches.length,
    },
  };
}
