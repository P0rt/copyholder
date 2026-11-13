// label (spec 7.6, 8.1, 8.5, 9.5): the ledger steps `onsets` and `label` of one recording.
// First the automatic voice onsets go into onsets.json (step `onsets`, nobody looks at anything).
// Then the blind label page opens: every cue of the gate (all 14, spec 9.5), one at a time in a
// random order, channel 0 only. When the last item is saved, the hand marks and their hash go into
// onsets.json, the onset error into clock_report.json, and the step `label` with both hashes into
// the ledger, before anything joins the detectors' answers (stage_a needs `label` in the ledger).
// One run at a time holds label.lock. A second run needs --exploratory: it writes
// label-exploratory-<k>.json and a ledger note, and leaves the confirmatory files alone.
//
//   npx tsx analysis/label.ts <id> [--exploratory] [--no-open]
//   exit 0 saved, 1 refused or crashed, 130 stopped before the last mark

import { randomInt } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LEDGER_ORDERS,
  validateClockReport,
  validateOnsets,
  type ClockReport,
  type LedgerKind,
  type OnsetEvent,
  type Onsets,
} from '../core/schemas/index.ts';
import { CLOCK_REPORT_FILE } from './clocks.ts';
import {
  LedgerRefusal,
  appendLedgerNote,
  noteLines,
  readJsonFile,
  readLedger,
  refusalFor,
  stepLines,
  writeJsonFile,
  type LedgerStamp,
  type LedgerState,
} from './clocks/ledger-io.ts';
import { openLabelPage, type PageOpener } from './label/chrome.ts';
import { cueEventId, gateCues, gateOnsetEvents, noDipCount } from './label/gate-onsets.ts';
import { acquireLabelLock } from './label/lock.ts';
import {
  applyMarks,
  isNoReply,
  labelsSha256,
  marksText,
  onsetErrorBlock,
  onsetsAcceptLabelOrder,
  shuffledOrder,
  splitMarks,
  windowSamples,
  withLabelOrder,
  type LabelItem,
  type LabelMark,
} from './label/marks.ts';
import { startLabelServer, type LabelServer } from './label/server.ts';
import { SessionVariantNotBuilt, sessionOnsetEvents } from './label/session-onsets.ts';
import { channel0Window } from './label/window.ts';
import { gitShortCommit } from './lib/git.ts';
import { appendLedgerStep, sha256Hex, utcSeconds } from './lib/ledger.ts';
import { REPO_ROOT } from './lib/paths.ts';
import { SessionLoadError, loadSession, type LoadedSession } from './lib/session.ts';
import { gatePackOf, gateSteps, type GateSteps } from './lib/steps.ts';

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_STOPPED = 130;

export const ONSETS_FILE = 'onsets.json';
/** Ledger note holding the seed and the order when onsets.json cannot hold them (see marks.ts). */
export const ORDER_NOTE = 'label_order';
/** Ledger note holding the marks of cues the automatic search found no voice for (onsets.json has no event for them). */
export const NO_EVENT_NOTE = 'label_without_auto_event';
/** Ledger note of an exploratory label run (spec 8.5: marked, never confirmatory). */
export const EXPLORATORY_NOTE = 'label_exploratory';

export interface LabelOptions {
  exploratory?: boolean;
}

export interface LabelDeps {
  out?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  commit?: () => string | null;
  repoRoot?: string;
  /** Seed of the random order; default a random 32-bit number. */
  seed?: () => number;
  /** Opens the page; default Chrome on macOS, else the address is printed. */
  openPage?: PageOpener | null;
  /** Fixed server token (tests). */
  token?: string;
  /** Called once the page server listens (tests drive the page from here). */
  onServer?: (server: LabelServer) => void;
  /** Stops the run before the last mark: nothing of the labels is written. */
  signal?: AbortSignal;
}

export interface LabelRun {
  code: number;
  lines: string[];
  refused?: string;
  /** onsets.json as written last. */
  onsets?: Onsets;
  /** Hashes of the ledger step `label` (or of the exploratory file). */
  outSha256?: Record<string, string>;
  exploratoryFile?: string;
  /** Marks of cues without an automatic event (ledger note NO_EVENT_NOTE). */
  withoutEvent?: LabelMark[];
}

type LabelPlan = { gate: GateSteps } | { gate: null };

function labelPlan(session: LoadedSession): LabelPlan | { refuse: string } {
  if (session.kind !== 'gate') return { gate: null };
  const pack = session.manifest.pack ?? gatePackOf(String(session.manifest['scenario'] ?? ''));
  return pack === null ? { refuse: 'the gate recording names no pack in manifest.json' } : { gate: gateSteps(pack) };
}

interface AutomaticPart {
  events: OnsetEvent[];
  /** Page items: every cue of the gate, with or without an event; every reply in sessions. */
  items: LabelItem[];
  summary: string;
}

/** Automatic events and the page items (gate: one per cue, its window hanging on the cue). */
function automaticEvents(session: LoadedSession, plan: LabelPlan): AutomaticPart {
  if (plan.gate) {
    const r = gateOnsetEvents(session, plan.gate);
    const items = r.cues.map((c): LabelItem => ({ id: cueEventId(c.cue.i), anchor: c.cue.n, hasEvent: c.event !== null }));
    const before = r.cues.filter((c) => c.beganBeforeCue).length;
    return {
      events: r.events,
      items,
      summary: `${r.cues.length} cue(s), ${r.events.length} with voice within 10 s after the dot (${before} of them already going at the dot); no_dip on ${noDipCount(r.events)} event(s)`,
    };
  }
  // HOOK: the session variant of spec 7.6 (analysis/label/session-onsets.ts), not built yet.
  const found = sessionOnsetEvents(session);
  const events = found.map((f) => f.event);
  return {
    events,
    items: found.map((f): LabelItem => ({ id: f.event.id, anchor: f.searchFrom, hasEvent: true })),
    summary: `${found.length} replies; no_dip on ${noDipCount(events)} event(s)`,
  };
}

function hasLabelStep(kind: LedgerKind): boolean {
  return LEDGER_ORDERS[kind].includes('label');
}

function readValid<T>(dir: string, name: string, validate: (v: unknown) => string[]): T {
  const v = readJsonFile(dir, name);
  if (v === null) throw new LedgerRefusal(`${name} is missing`);
  const problems = validate(v);
  if (problems.length > 0) throw new LedgerRefusal(`${name} is not valid: ${problems.slice(0, 3).join('; ')}`);
  return v as T;
}

type Out = (line: string) => void;

interface RunContext {
  session: LoadedSession;
  plan: LabelPlan;
  deps: LabelDeps;
  out: Out;
  lines: string[];
  stampNow: () => LedgerStamp;
  refuse: (why: string) => LabelRun;
}

/** Runs the label step of one loaded session. */
export async function runLabel(session: LoadedSession, opts: LabelOptions = {}, deps: LabelDeps = {}): Promise<LabelRun> {
  const lines: string[] = [];
  const out = (l: string): void => {
    lines.push(l);
    (deps.out ?? ((x: string) => console.log(x)))(l);
  };
  const refuse = (why: string): LabelRun => {
    out(`LABEL DID NOT RUN for ${session.id}: ${why}`);
    return { code: EXIT_REFUSED, lines, refused: why };
  };
  const now = deps.now ?? (() => new Date());
  const stampNow = (): LedgerStamp => ({
    utc: utcSeconds(now()),
    commit: (deps.commit ?? (() => gitShortCommit(deps.repoRoot ?? REPO_ROOT)))(),
  });

  const plan = labelPlan(session);
  if ('refuse' in plan) return refuse(plan.refuse);
  // One run at a time, from before the step onsets to the end (spec 8.5).
  const lock = acquireLabelLock(session.dir, utcSeconds(now()));
  if ('refused' in lock) return refuse(lock.refused);
  const ctx: RunContext = { session, plan, deps, out, lines, stampNow, refuse };
  try {
    let ledger: LedgerState;
    try {
      ledger = readLedger(session.dir, session.kind);
    } catch (e) {
      if (e instanceof LedgerRefusal) return refuse(e.message);
      throw e;
    }
    const confirmed = stepLines(ledger, 'label');
    if (opts.exploratory) {
      if (confirmed.length === 0) {
        return refuse('--exploratory is for runs after the confirmatory label run; run npm run label -- <id> without it first (spec 8.5)');
      }
      try {
        return await runExploratory(ctx, ledger);
      } catch (e) {
        if (e instanceof LedgerRefusal) return refuse(e.message);
        throw e;
      }
    }
    if (confirmed.length > 0) {
      return refuse(
        `the labels are already saved (ledger line ${confirmed[0]!.i + 1}). A second run needs --exploratory: its marks go to their own file and never into onsets.json or clock_report.json (spec 8.5)`,
      );
    }
    return await runConfirmatory(ctx, ledger);
  } finally {
    lock.release();
  }
}

async function runConfirmatory(ctx: RunContext, ledger: LedgerState): Promise<LabelRun> {
  const { session, plan, deps, out, lines, stampNow, refuse } = ctx;
  const notNow = refusalFor(ledger, 'onsets');
  if (notNow !== null) return refuse(notNow);
  const blind = hasLabelStep(ledger.kind);
  let report: ClockReport | null = null;
  if (blind) {
    try {
      report = readValid<ClockReport>(session.dir, CLOCK_REPORT_FILE, validateClockReport);
    } catch (e) {
      if (e instanceof LedgerRefusal) return refuse(`${e.message}: run npm run clocks -- ${session.id} first`);
      throw e;
    }
  }

  // ---- step onsets ----
  let auto: AutomaticPart;
  try {
    auto = automaticEvents(session, plan);
  } catch (e) {
    if (e instanceof SessionVariantNotBuilt) return refuse(e.message);
    throw e;
  }
  const onsets: Onsets = { schema: 'onsets/1', labels_sha256: null, events: auto.events };
  const onsetsSha = writeJsonFile(session.dir, ONSETS_FILE, onsets, validateOnsets);
  const step = appendLedgerStep(session.dir, ledger.kind, 'onsets', { ...stampNow(), outSha256: { [ONSETS_FILE]: onsetsSha } });
  if (!step.appended) throw new Error(`ledger step onsets not appended: ${step.reason}`);
  out(`Automatic onsets of ${session.id}: ${auto.summary}. Wrote ${ONSETS_FILE}; ledger step onsets appended.`);
  if (!blind) {
    out(`A ${session.kind} record has no blind labelling (spec 8.5): done.`);
    return { code: EXIT_OK, lines, onsets, outSha256: { [ONSETS_FILE]: onsetsSha } };
  }

  // ---- step label ----
  const seed = (deps.seed ?? (() => randomInt(0, 2 ** 32)))();
  const order = shuffledOrder(auto.items.map((i) => i.id), seed);
  const rate = session.sampleRateHz;
  let saved: { onsets: Onsets; outSha256: Record<string, string>; hash: string; withoutEvent: LabelMark[] } | null = null;

  const finish = (marks: LabelMark[]): string => {
    const { eventMarks, withoutEvent } = splitMarks(auto.items, marks);
    const hash = labelsSha256(eventMarks, sha256Hex);
    const final = withLabelOrder(applyMarks(onsets, eventMarks, hash), seed, order);
    // The ledger must still allow `label`: nothing ran in between and no other run saved labels.
    const now = readLedger(session.dir, session.kind);
    const other = stepLines(now, 'label');
    if (other.length > 0) throw new LedgerRefusal(`another run saved labels meanwhile (ledger line ${other[0]!.i + 1}); these marks are not saved`);
    const why = refusalFor(now, 'label');
    if (why !== null) throw new LedgerRefusal(why);
    const newReport: ClockReport = { ...report!, onset: onsetErrorBlock(final, rate) };
    const problems = [...validateOnsets(final), ...validateClockReport(newReport)];
    if (problems.length > 0) throw new Error(`the label files would be invalid: ${problems.join('; ')}`);
    const stamp = stampNow();
    const outSha256 = {
      [ONSETS_FILE]: writeJsonFile(session.dir, ONSETS_FILE, final, validateOnsets),
      [CLOCK_REPORT_FILE]: writeJsonFile(session.dir, CLOCK_REPORT_FILE, newReport, validateClockReport),
    };
    if (!onsetsAcceptLabelOrder()) {
      appendLedgerNote(session.dir, now.kind, ORDER_NOTE, `seed ${seed}; order ${order.join(' ')}; labels_sha256 ${hash}`, stamp);
    }
    if (withoutEvent.length > 0) {
      appendLedgerNote(session.dir, now.kind, NO_EVENT_NOTE, `blind marks of cues the automatic search found no voice for: ${marksText(withoutEvent)}`, stamp);
    }
    const r = appendLedgerStep(session.dir, now.kind, 'label', { ...stamp, outSha256 });
    if (!r.appended) throw new LedgerRefusal(`ledger step label not appended: ${r.reason}`);
    saved = { onsets: final, outSha256, hash, withoutEvent };
    return `${marks.length} mark(s) saved; their hash is in the ledger.`;
  };

  const byId = new Map(auto.items.map((i) => [i.id, i]));
  const done = await labelOnPage(session, order.map((id) => byId.get(id)!), false, finish, deps, out);
  if (done === 'stopped') {
    out(`Stopped before the last mark: no labels were saved. ${ONSETS_FILE} holds the automatic onsets; run npm run label -- ${session.id} again.`);
    return { code: EXIT_STOPPED, lines, onsets };
  }
  if (done !== 'saved') return refuse(done.refused);
  const s = saved as { onsets: Onsets; outSha256: Record<string, string>; hash: string; withoutEvent: LabelMark[] } | null;
  if (s === null) throw new Error('the label page finished without saving');
  const block = onsetErrorBlock(s.onsets, rate);
  out(`Labels saved: ${s.onsets.events.length} event(s), labels_sha256 ${s.hash}. Ledger step label appended.`);
  if (s.withoutEvent.length > 0) {
    const speech = s.withoutEvent.filter((m) => !isNoReply(m)).length;
    out(
      `Cues without an automatic event: ${s.withoutEvent.length}; your marks give a sound at ${speech} of them (ledger note ${NO_EVENT_NOTE}; onsets.json has no event to hold them).`,
    );
  }
  out(
    `Onset error: P90 of |auto - manual| ${block.p90_abs_auto_minus_manual_ms === null ? 'none' : `${block.p90_abs_auto_minus_manual_ms.toFixed(1)} ms`} over ${block.events} speech event(s); soft first sounds ${block.soft_first_sounds}. Written to ${CLOCK_REPORT_FILE}.`,
  );
  return { code: EXIT_OK, lines, onsets: s.onsets, outSha256: s.outSha256, withoutEvent: s.withoutEvent };
}

/**
 * Serves the page for the items in display order and waits until the last mark is saved (then
 * `finish` has run), the run is stopped, or a save is refused for good. With no items, `finish`
 * runs at once. A save that fails otherwise leaves the marks on the page to save again.
 */
async function labelOnPage(
  session: LoadedSession,
  items: readonly LabelItem[],
  exploratory: boolean,
  finish: (marks: LabelMark[]) => string,
  deps: LabelDeps,
  out: Out,
): Promise<'saved' | 'stopped' | { refused: string }> {
  if (items.length === 0) {
    out('No event to label.');
    try {
      finish([]);
    } catch (e) {
      if (e instanceof LedgerRefusal) return { refused: e.message };
      throw e;
    }
    return 'saved';
  }
  const w = windowSamples(session.sampleRateHz);
  const server = await startLabelServer({
    items,
    audio: (item) => channel0Window(session, item.anchor - w.before, w.length),
    sampleRateHz: session.sampleRateHz,
    exploratory,
    onFinish: finish,
    retryable: (e) => !(e instanceof LedgerRefusal),
    onFinishError: (e, retry) =>
      out(
        `The labels were not saved: ${e.message.split('\n')[0]}.${retry ? ' The marks stay on the page: fix the cause and press Save again, or Ctrl-C to stop.' : ''}`,
      ),
    ...(deps.token !== undefined ? { token: deps.token } : {}),
  });
  try {
    out(`Label page for ${items.length} item(s) at ${server.url}`);
    const opener = deps.openPage === undefined ? openLabelPage : deps.openPage;
    if (opener) out(opener(server.url).how);
    out('Mark every item on the page; this command waits until the last one is saved (Ctrl-C stops it without saving).');
    deps.onServer?.(server);
    const stopped = new Promise<'stopped'>((resolve) => {
      if (deps.signal?.aborted) resolve('stopped');
      deps.signal?.addEventListener('abort', () => resolve('stopped'), { once: true });
    });
    const saved = server.finished.then(
      () => 'saved' as const,
      (e: unknown) => {
        if (e instanceof LedgerRefusal) return { refused: e.message };
        throw e;
      },
    );
    return await Promise.race([saved, stopped]);
  } finally {
    await server.close();
  }
}

/** A label run after the confirmatory one (spec 8.5): its own file and a ledger note, nothing else. */
async function runExploratory(ctx: RunContext, ledger: LedgerState): Promise<LabelRun> {
  const { session, plan, deps, out, lines, stampNow } = ctx;
  const onsets = readValid<Onsets>(session.dir, ONSETS_FILE, validateOnsets);
  const eventIds = new Set(onsets.events.map((e) => e.id));
  let items: LabelItem[];
  if (plan.gate) {
    const cues = gateCues(session, plan.gate);
    const cueIds = new Set(cues.map((c) => cueEventId(c.i)));
    const stray = onsets.events.filter((e) => !cueIds.has(e.id));
    if (stray.length > 0) throw new LedgerRefusal(`event ${stray[0]!.id} of ${ONSETS_FILE} has no cue in the recording`);
    items = cues.map((c) => ({ id: cueEventId(c.i), anchor: c.n, hasEvent: eventIds.has(cueEventId(c.i)) }));
  } else {
    try {
      items = sessionOnsetEvents(session).map((f) => ({ id: f.event.id, anchor: f.searchFrom, hasEvent: eventIds.has(f.event.id) }));
    } catch (e) {
      if (e instanceof SessionVariantNotBuilt) throw new LedgerRefusal(e.message);
      throw e;
    }
  }
  const k = noteLines(ledger, EXPLORATORY_NOTE).length + 1;
  const file = `label-exploratory-${k}.json`;
  const seed = (deps.seed ?? (() => randomInt(0, 2 ** 32)))();
  const order = shuffledOrder(items.map((i) => i.id), seed);
  let sha: string | null = null;
  let block: ReturnType<typeof onsetErrorBlock> | null = null;
  const finish = (marks: LabelMark[]): string => {
    const { eventMarks } = splitMarks(items, marks);
    const hash = labelsSha256(eventMarks, sha256Hex);
    const relabelled = applyMarks(onsets, eventMarks, hash);
    block = onsetErrorBlock(relabelled, session.sampleRateHz);
    const hasEvent = new Map(items.map((i) => [i.id, i.hasEvent]));
    const body = {
      schema: 'label-exploratory/1',
      exploratory: true,
      run: k,
      seed,
      order,
      labels_sha256: hash,
      marks: [...marks].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0)).map((m) => ({ ...m, event: hasEvent.get(m.id) === true })),
      onset: block,
    };
    sha = writeJsonFile(session.dir, file, body, null);
    appendLedgerNote(session.dir, ledger.kind, EXPLORATORY_NOTE, `${file} sha256 ${sha}; labels_sha256 ${hash}; exploratory, not confirmatory`, stampNow());
    return `${marks.length} mark(s) saved as exploratory run ${k}.`;
  };
  out(`Exploratory label run ${k} of ${session.id}: ${ONSETS_FILE} and ${CLOCK_REPORT_FILE} stay as they are.`);
  const byId = new Map(items.map((i) => [i.id, i]));
  const done = await labelOnPage(session, order.map((id) => byId.get(id)!), true, finish, deps, out);
  if (done === 'stopped') {
    out('Stopped before the last mark: nothing was saved.');
    return { code: EXIT_STOPPED, lines };
  }
  if (done !== 'saved') throw new LedgerRefusal(done.refused);
  const b = block as ReturnType<typeof onsetErrorBlock> | null;
  out(
    `EXPLORATORY: wrote ${file}; P90 of |auto - manual| ${b?.p90_abs_auto_minus_manual_ms ?? 'none'} ms over ${b?.events ?? 0} speech event(s). Ledger note ${EXPLORATORY_NOTE} appended.`,
  );
  return { code: EXIT_OK, lines, exploratoryFile: file, outSha256: sha === null ? {} : { [file]: sha } };
}

/** CLI: npx tsx analysis/label.ts <id or folder> [--exploratory] [--no-open]. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const id = argv.find((a) => !a.startsWith('-'));
  const unknown = argv.filter((a) => a.startsWith('-') && a !== '--exploratory' && a !== '--no-open');
  if (id === undefined || unknown.length > 0) {
    console.log('Usage: npm run label -- <session id> [--exploratory] [--no-open]');
    return EXIT_REFUSED;
  }
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);
  try {
    const session = loadSession(id);
    const run = await runLabel(
      session,
      { exploratory: argv.includes('--exploratory') },
      { signal: controller.signal, ...(argv.includes('--no-open') ? { openPage: null } : {}) },
    );
    return run.code;
  } catch (e) {
    // A wrong id or a missing file is the user's to fix: the message alone. Anything else: the stack.
    if (!(e instanceof SessionLoadError)) console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    console.log(`LABEL DID NOT RUN: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return EXIT_REFUSED;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(e);
      process.exitCode = EXIT_REFUSED;
    },
  );
}
