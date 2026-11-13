// Step ledger ledger.jsonl (spec 8.5): line format, SHA-256 hash chain, allowed step
// orders per record kind, the exploratory rule and note lines.
// The hash function is injected so this module stays pure: (text) => hex SHA-256 of the
// text's UTF-8 bytes, e.g. (s) => createHash('sha256').update(s, 'utf8').digest('hex').
// The same rules are in ledger-steps.json for CommonJS code (host); a test keeps them equal.

import { byKind, bool, int, lit, makeValidator, mapOf, obj, oneOf, str, type Spec, type Validator } from './check.ts';
import { HEX64, RELATIVE_FILE, commitOrNull, sha256Hex, snakeName, utcTime, type LedgerKind } from './common.ts';
import { splitJsonlLines, toJsonlLine } from './jsonl.ts';

export const LEDGER_STEPS = [
  'record', 'quickcheck', 'clocks', 'onsets', 'label', 'stage_a', 'stage_b', 'verdict',
  'score', 'review', 'reveal', 'receipt', 'pack',
] as const;
export type LedgerStep = (typeof LEDGER_STEPS)[number];

export const NOTE_STEP = 'note';

/** prev of the first line: 64 zeros. */
export const GENESIS_PREV = '0'.repeat(64);

/** Allowed step order per record kind (spec 8.5 table). */
export const LEDGER_ORDERS: Readonly<Record<LedgerKind, readonly LedgerStep[]>> = {
  gate: ['record', 'quickcheck', 'clocks', 'onsets', 'label', 'stage_a', 'stage_b', 'verdict', 'pack'],
  numbers: ['record', 'quickcheck', 'clocks', 'onsets', 'label', 'score', 'review', 'reveal', 'receipt', 'pack'],
  spacebar: ['record', 'quickcheck', 'clocks', 'onsets', 'label', 'score', 'review', 'reveal', 'receipt', 'pack'],
  rehearsal: ['record', 'quickcheck', 'clocks', 'onsets', 'label', 'score', 'review', 'reveal', 'receipt'],
  demo: ['record', 'quickcheck', 'clocks', 'onsets', 'score', 'reveal', 'receipt', 'pack'],
  pilot: ['record', 'quickcheck', 'onsets', 'reveal'],
};

/**
 * Steps written at most once as confirmatory lines: record, stage_a (k and theta_G are tuned
 * once, spec 7.4), stage_b and verdict (spec 8.5). Any other step may be re-run right after
 * itself (assumption).
 */
export const ONCE_STEPS: readonly LedgerStep[] = ['record', 'stage_a', 'stage_b', 'verdict'];

/** analyze:gate steps; after the confirmatory stage_b they must be exploratory (spec 8.5). */
export const EXPLORATORY_STEPS: readonly LedgerStep[] = ['stage_a', 'stage_b', 'verdict'];

/**
 * Files a confirmatory step must list in out_sha256 (spec 7.10, 8.5). Every step line lists at
 * least one file, its result; these steps list the named files, whose hashes later steps check:
 * the blind labels before detector answers join (label), the frozen params that release the
 * objection block (stage_a), the verdict (stage_b, verdict), the sealed score before review,
 * the review labels before reveal, the receipt. score.json.enc names the file in the sealed
 * folder (spec 8.2; assumption).
 */
export const REQUIRED_OUTPUTS: Readonly<Partial<Record<LedgerStep, readonly string[]>>> = {
  onsets: ['onsets.json'],
  label: ['clock_report.json', 'onsets.json'],
  stage_a: ['params/frozen.json'],
  stage_b: ['verdict.json'],
  verdict: ['verdict.json', 'verdict.md'],
  score: ['score.json.enc'],
  review: ['review.json'],
  receipt: ['receipt.json', 'receipt.txt'],
};

/** The file stage_b and verdict both list: the verdict is fixed by stage_b (spec 8.5). */
export const VERDICT_FILE = 'verdict.json';

/** Known `what` values of note lines: plan_seen (spec 8.5, 10.6), narrowed_claim (spec 8.4). */
export const NOTE_WHATS = ['plan_seen', 'narrowed_claim'] as const;

/** Key order of step lines and of note lines, as in the spec example. */
export const LEDGER_LINE_KEYS = ['i', 'step', 'utc', 'commit', 'out_sha256', 'exploratory', 'prev'] as const;
export const LEDGER_NOTE_KEYS = ['i', 'step', 'utc', 'commit', 'what', 'detail', 'prev'] as const;

/** (text) => SHA-256 of its UTF-8 bytes as 64 lowercase hex characters. */
export type HashFn = (text: string) => string;

export interface LedgerStepLine {
  i: number;
  step: LedgerStep;
  utc: string;
  /** Commit the step ran at; null only outside a git checkout (host convention, assumption). */
  commit: string | null;
  /** Files the step wrote, name -> SHA-256; keys sorted when written. */
  out_sha256: Record<string, string>;
  exploratory: boolean;
  prev: string;
}

export interface LedgerNoteLine {
  i: number;
  step: 'note';
  utc: string;
  commit: string | null;
  /** plan_seen, narrowed_claim, or another snake_case word. */
  what: string;
  detail?: string;
  prev: string;
}

export type LedgerLine = LedgerStepLine | LedgerNoteLine;

export function isNoteLine(line: LedgerLine): line is LedgerNoteLine {
  return line.step === NOTE_STEP;
}

const stepLineSpec: Spec = obj({
  required: {
    i: int({ min: 0 }),
    step: oneOf(LEDGER_STEPS),
    utc: utcTime,
    commit: commitOrNull,
    out_sha256: mapOf(sha256Hex, { key: RELATIVE_FILE, keyWhat: 'a relative file name' }),
    exploratory: bool,
    prev: sha256Hex,
  },
});

const noteLineSpec: Spec = obj({
  required: { i: int({ min: 0 }), step: lit(NOTE_STEP), utc: utcTime, commit: commitOrNull, what: snakeName, prev: sha256Hex },
  optional: { detail: str() },
});

const lineSpecs: Record<string, Spec> = Object.fromEntries([
  ...LEDGER_STEPS.map((s): [string, Spec] => [s, stepLineSpec]),
  [NOTE_STEP, noteLineSpec],
]);

export const validateLedgerLine: Validator<LedgerLine> = makeValidator(byKind('step', lineSpecs, 'step'));

/** Hashes one line and checks that the injected function returned hex SHA-256. */
export function hashLine(hash: HashFn, text: string): string {
  const h = hash(text);
  if (typeof h !== 'string' || !HEX64.test(h)) {
    throw new Error('ledger: the hash function must return a SHA-256 as 64 lowercase hex characters');
  }
  return h;
}

/** Known SHA-256 values of UTF-8 text: "abc" (FIPS 180-2) and "é" (two bytes c3 a9). */
const SHA256_VECTORS: readonly (readonly [string, string])[] = [
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['\u00e9', '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c'],
];

/**
 * Throws unless `hash` is SHA-256 of UTF-8 text in lowercase hex: a wrong function would
 * write a chain that no other program can check (live/lib/ledger.cjs, npm run verify).
 */
export function assertSha256(hash: HashFn): void {
  for (const [text, expected] of SHA256_VECTORS) {
    if (hashLine(hash, text) !== expected) {
      throw new Error('ledger: the hash function must be SHA-256 of the UTF-8 text, as lowercase hex');
    }
  }
}

/** Hash of the last line, i.e. the prev of the next line; 64 zeros for an empty ledger. */
export function ledgerHead(lines: readonly string[], hash: HashFn): string {
  const last = lines[lines.length - 1];
  return last === undefined ? GENESIS_PREV : hashLine(hash, last);
}

// ---- step order ------------------------------------------------------------------

interface OrderState {
  /** Index in the order of the last confirmatory step; -1 before the first. */
  pos: number;
  /** out_sha256 of the confirmatory stage_b once it is written: its verdict.json fixes the verdict. */
  stageB: Readonly<Record<string, string>> | null;
  /** The confirmatory verdict is written. */
  verdictDone: boolean;
}

function freshState(): OrderState {
  return { pos: -1, stageB: null, verdictDone: false };
}

interface Candidate {
  step: LedgerStep | typeof NOTE_STEP;
  exploratory: boolean;
  /** Files of a step line; undefined while not known (canAppendStep without out_sha256, nextStep). */
  outputs: Readonly<Record<string, string>> | undefined;
}

function candidateOf(line: LedgerLine): Candidate {
  return isNoteLine(line)
    ? { step: NOTE_STEP, exploratory: false, outputs: undefined }
    : { step: line.step, exploratory: line.exploratory, outputs: line.out_sha256 };
}

/** Why a step line's out_sha256 is not enough (spec 7.10, 8.5), or null; unknown outputs pass. */
function outputsProblem(st: OrderState, step: LedgerStep, c: Candidate): string | null {
  const out = c.outputs;
  if (out === undefined) return null;
  if (Object.keys(out).length === 0) {
    return `"${step}" lists no file in out_sha256: every step writes the SHA-256 of its result, and the next step does not start without it (spec 7.10)`;
  }
  if (c.exploratory) return null;
  for (const f of REQUIRED_OUTPUTS[step] ?? []) {
    if (!Object.hasOwn(out, f)) return `"${step}" must list the SHA-256 of ${f} in out_sha256 (spec 7.10, 8.5)`;
  }
  const fixed = st.stageB?.[VERDICT_FILE];
  if (step === 'verdict' && fixed !== undefined && out[VERDICT_FILE] !== fixed) {
    return `"verdict" must list the ${VERDICT_FILE} that stage_b wrote (${fixed.slice(0, 16)}...): the verdict comes from stage_b and does not change (spec 8.5)`;
  }
  return null;
}

/**
 * Applies one line to the order state; returns why it is not allowed, or null. The confirmatory
 * verdict follows the confirmatory stage_b, normally in the same run (spec 8.5, assumption).
 * When a run stopped between the two lines, the verdict may still come later, after notes and
 * exploratory lines only, and it must list the verdict.json hash stage_b wrote: it can complete
 * the ledger but not change the verdict.
 */
function admit(st: OrderState, kind: LedgerKind, c: Candidate): string | null {
  // Notes are transparent: they neither advance the order nor separate stage_b from verdict.
  if (c.step === NOTE_STEP) return null;
  const step = c.step;
  const order = LEDGER_ORDERS[kind];
  if (c.exploratory) {
    if (!EXPLORATORY_STEPS.includes(step)) {
      return `"${step}" cannot be exploratory: only the analyze:gate steps stage_a, stage_b and verdict can (spec 8.5)`;
    }
    if (kind !== 'gate') return `exploratory "${step}" in a ${kind} record: only the day-1 gate runs analyze:gate (spec 8.5)`;
    if (st.stageB === null) return `exploratory "${step}" before the confirmatory stage_b: only runs after it are exploratory (spec 8.5)`;
    return outputsProblem(st, step, c);
  }
  const idx = order.indexOf(step);
  if (idx < 0) return `step "${step}" is not in the ${kind} order ${order.join(' -> ')} (spec 8.5)`;
  if (st.stageB !== null && EXPLORATORY_STEPS.includes(step) && !(step === 'verdict' && !st.verdictDone)) {
    return `"${step}" after stage_b must be exploratory: stage_b runs once (spec 8.5)`;
  }
  if (idx === st.pos) {
    if (step === 'stage_a') {
      return 'step "stage_a" is written once: k and theta_G are tuned once, and its hash of params/frozen.json releases the objection block (spec 7.4, 7.10)';
    }
    if (ONCE_STEPS.includes(step)) return `step "${step}" is written once (spec 8.5)`;
  } else if (idx !== st.pos + 1) {
    const last = order[st.pos];
    const next = order[st.pos + 1];
    if (next === undefined) return `step "${step}" after "${String(last)}", the last ${kind} step`;
    if (last === undefined) return `step "${step}" out of order: a ${kind} ledger starts with "${next}"`;
    return `step "${step}" out of order: after "${last}" the next ${kind} step is "${next}"`;
  }
  // A line in its place but with missing files still advances the order, so each line names its own problem.
  const bad = outputsProblem(st, step, c);
  st.pos = idx;
  if (step === 'stage_b') st.stageB = c.outputs ?? {};
  if (step === 'verdict') st.verdictDone = true;
  return bad;
}

/** The order state after `records`, or the first problem with its line number. */
function replayOrder(records: readonly LedgerLine[], kind: LedgerKind): OrderState | string {
  const st = freshState();
  for (const r of records) {
    const err = admit(st, kind, candidateOf(r));
    if (err !== null) return `the ledger already breaks the ${kind} order at line ${r.i + 1}: ${err}`;
  }
  return st;
}

/** Order problems of parsed ledger lines for a record kind, each with its line number. */
export function checkStepOrder(records: readonly LedgerLine[], kind: LedgerKind): string[] {
  const st = freshState();
  const errors: string[] = [];
  for (const r of records) {
    const err = admit(st, kind, candidateOf(r));
    if (err !== null) errors.push(`ledger.jsonl line ${r.i + 1}: ${err}`);
  }
  return errors;
}

/**
 * Why `step` cannot be appended now, or null when it can. Commands call this before they
 * start: "every command checks that the previous step is recorded" (spec 8.5). Without
 * out_sha256 only the order is checked; appendLedger checks the files of the new line.
 */
export function canAppendStep(
  records: readonly LedgerLine[],
  kind: LedgerKind,
  step: LedgerStep | typeof NOTE_STEP,
  opts: { exploratory?: boolean; out_sha256?: Readonly<Record<string, string>> } = {},
): string | null {
  const st = replayOrder(records, kind);
  if (typeof st === 'string') return st;
  return admit(st, kind, { step, exploratory: opts.exploratory ?? false, outputs: step === NOTE_STEP ? undefined : opts.out_sha256 });
}

/**
 * The next confirmatory step, by the same rules as canAppendStep: null when the order is
 * complete or the ledger already breaks it.
 */
export function nextStep(records: readonly LedgerLine[], kind: LedgerKind): LedgerStep | null {
  const st = replayOrder(records, kind);
  if (typeof st === 'string') return null;
  const next = LEDGER_ORDERS[kind][st.pos + 1];
  if (next === undefined) return null;
  return admit({ ...st }, kind, { step: next, exploratory: false, outputs: undefined }) === null ? next : null;
}

/** Confirmatory (non-exploratory) lines of one step, in order. */
export function findSteps(records: readonly LedgerLine[], step: LedgerStep, opts: { exploratory?: boolean } = {}): LedgerStepLine[] {
  const want = opts.exploratory ?? false;
  return records.filter((r): r is LedgerStepLine => !isNoteLine(r) && r.step === step && r.exploratory === want);
}

// ---- the numbers batch: rules across ledgers (spec 8.5, 10.5, 7.9) ----------------------

/** Record kinds of the numbers batch: the numbers sessions and the space-bar block (spec 10.5). */
export const BATCH_KINDS: readonly LedgerKind[] = ['numbers', 'spacebar'];

/** Steps that run only after the last session and the space-bar block are recorded (spec 8.5, 10.5). */
export const AFTER_BATCH_STEPS: readonly LedgerStep[] = ['onsets', 'label', 'score', 'review', 'reveal', 'receipt'];

/** Steps every ledger of the batch holds before the first reveal (spec 7.9). */
export const BEFORE_REVEAL_STEPS: readonly LedgerStep[] = ['label', 'score', 'review'];

/** One ledger of the numbers batch, by session id. */
export interface BatchLedger {
  id: string;
  kind: LedgerKind;
  records: readonly LedgerLine[];
}

function utcMs(utc: string): number {
  return Date.parse(utc);
}

export interface BatchOptions {
  /** The space-bar block was cut (spec 14.4, item 8): the batch is the numbers sessions alone. */
  spacebarCut?: boolean;
}

/**
 * Order problems across the ledgers of the numbers batch: no step from onsets to receipt
 * before the last `record` of any of them (spec 8.5, 10.5), and no reveal while a ledger
 * lacks label, score or review (spec 7.9). Times are compared by `utc`; equal times pass.
 * The caller passes every recorded numbers session and the space-bar block: once a step from
 * onsets to receipt is written, a batch without a numbers session or without the space-bar
 * block (unless opts.spacebarCut) is a problem, since those steps wait for both.
 */
export function numbersBatchProblems(ledgers: readonly BatchLedger[], opts: BatchOptions = {}): string[] {
  const problems: string[] = [];
  let last: { id: string; utc: string } | null = null;
  for (const l of ledgers) {
    if (!BATCH_KINDS.includes(l.kind)) {
      problems.push(`${l.id}: a ${l.kind} record is not part of the numbers batch (numbers sessions and the space-bar block, spec 10.5)`);
      continue;
    }
    if (l.kind === 'spacebar' && opts.spacebarCut === true) {
      problems.push(`${l.id}: a space-bar block ledger, but the block is marked as cut (spec 14.4)`);
    }
    const rec = findSteps(l.records, 'record')[0];
    if (rec === undefined) problems.push(`${l.id}: ledger.jsonl has no "record" step`);
    else if (last === null || utcMs(rec.utc) > utcMs(last.utc)) last = { id: l.id, utc: rec.utc };
  }
  const batch = ledgers.filter((l) => BATCH_KINDS.includes(l.kind));
  const afterBatch = batch.some((l) => l.records.some((r) => !isNoteLine(r) && !r.exploratory && AFTER_BATCH_STEPS.includes(r.step)));
  if (afterBatch) {
    const recorded = (kind: LedgerKind): boolean => batch.some((l) => l.kind === kind && findSteps(l.records, 'record').length > 0);
    if (!recorded('numbers')) {
      problems.push('no numbers session ledger with a "record" step: steps from onsets to receipt run after the last session (spec 8.5, 10.5)');
    }
    if (opts.spacebarCut !== true && !recorded('spacebar')) {
      problems.push(
        'no space-bar block ledger with a "record" step: steps from onsets to receipt run after the last session and the space-bar block, ' +
          'and reveal checks the ledgers of all recorded sessions (spec 8.5, 10.5); pass spacebarCut when the block was cut (spec 14.4)',
      );
    }
  }
  if (last !== null) {
    const lastRecord = last;
    for (const l of batch) {
      for (const r of l.records) {
        if (isNoteLine(r) || !AFTER_BATCH_STEPS.includes(r.step) || r.exploratory) continue;
        if (utcMs(r.utc) < utcMs(lastRecord.utc)) {
          problems.push(
            `${l.id} ledger.jsonl line ${r.i + 1}: "${r.step}" at ${r.utc} ran before ${lastRecord.id} was recorded at ${lastRecord.utc}: ` +
              'steps from onsets to receipt run after the last session and the space-bar block (spec 8.5, 10.5)',
          );
        }
      }
    }
  }
  let firstReveal: { id: string; utc: string } | null = null;
  for (const l of batch) {
    for (const r of findSteps(l.records, 'reveal')) {
      if (firstReveal === null || utcMs(r.utc) < utcMs(firstReveal.utc)) firstReveal = { id: l.id, utc: r.utc };
    }
  }
  if (firstReveal !== null) {
    const reveal = firstReveal;
    for (const l of batch) {
      for (const step of BEFORE_REVEAL_STEPS) {
        const done = findSteps(l.records, step).some((r) => utcMs(r.utc) <= utcMs(reveal.utc));
        if (!done) {
          problems.push(
            `${l.id}: no "${step}" before the first reveal (${reveal.id} at ${reveal.utc}): ` +
              'reveal needs label, score and review in every ledger of the batch (spec 7.9)',
          );
        }
      }
    }
  }
  return problems;
}

/**
 * SHA-256 of params/frozen.json from the confirmatory stage_a, or null before it (spec 8.5:
 * pack --part B). Throws LedgerError when the ledger holds more than one confirmatory stage_a:
 * k and theta_G are tuned once (spec 7.4), so a second hash would be a re-tune made after the
 * objection block was released.
 */
export function stageAParamsHash(records: readonly LedgerLine[]): string | null {
  const lines = findSteps(records, 'stage_a');
  if (lines.length > 1) {
    throw new LedgerError([
      `ledger.jsonl holds ${lines.length} confirmatory stage_a lines (lines ${lines.map((l) => l.i + 1).join(', ')}): stage A runs once (spec 7.4, 8.5)`,
    ]);
  }
  return lines[0]?.out_sha256['params/frozen.json'] ?? null;
}

// ---- verify and append --------------------------------------------------------------

export interface LedgerVerification {
  ok: boolean;
  /** Readable problems, each with its line number. */
  errors: string[];
  /** Valid lines in file order. */
  records: LedgerLine[];
  /** Hash of the last line: the prev of the next line, and ledger_head of receipt and results. */
  head: string;
}

export interface VerifyOptions {
  /** Also check the step order of this record kind. */
  kind?: LedgerKind;
  /** Recorded head (receipt ledger_head) that must match the last line. */
  head?: string;
}

/**
 * Checks every line's format, its index i, and the chain: prev of line k is the SHA-256 of
 * line k-1, 64 zeros for the first. Editing any line breaks the chain below it (spec 8.5);
 * editing the last line shows only against a recorded head.
 */
export function verifyLedger(lines: readonly string[], hash: HashFn, opts: VerifyOptions = {}): LedgerVerification {
  assertSha256(hash);
  const errors: string[] = [];
  const records: LedgerLine[] = [];
  let expectedPrev = GENESIS_PREV;
  lines.forEach((text, idx) => {
    const lineNo = idx + 1;
    const at = `ledger.jsonl line ${lineNo}`;
    let value: unknown;
    let parsed = true;
    try {
      value = JSON.parse(text);
    } catch (e) {
      parsed = false;
      errors.push(`${at}: not valid JSON (${(e as Error).message})`);
    }
    if (parsed) {
      const problems = validateLedgerLine(value);
      if (problems.length > 0) {
        for (const p of problems) errors.push(`${at}: ${p}`);
      } else {
        const line = value as LedgerLine;
        if (line.i !== idx) errors.push(`${at}: i is ${line.i}, expected ${idx}: a line was removed, added or moved`);
        if (line.prev !== expectedPrev) {
          errors.push(
            idx === 0
              ? `${at}: prev must be 64 zeros on the first line`
              : `${at}: prev does not match the SHA-256 of line ${lineNo - 1}: line ${lineNo - 1} or a line above it was changed`,
          );
        }
        records.push(line);
      }
    }
    expectedPrev = hashLine(hash, text);
  });
  const head = expectedPrev;
  if (opts.head !== undefined && opts.head !== head) {
    errors.push(`ledger.jsonl: head ${head.slice(0, 16)}... does not match the recorded ${opts.head.slice(0, 16)}...: the last line was changed, or lines were added or removed`);
  }
  if (opts.kind !== undefined && records.length === lines.length) errors.push(...checkStepOrder(records, opts.kind));
  return { ok: errors.length === 0, errors, records, head };
}

/** verifyLedger on the text of ledger.jsonl. */
export function verifyLedgerText(text: string, hash: HashFn, opts: VerifyOptions = {}): LedgerVerification {
  return verifyLedger(splitJsonlLines(text), hash, opts);
}

/** Thrown by appendLedger; `problems` lists every reason. */
export class LedgerError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join('\n'));
    this.name = 'LedgerError';
    this.problems = problems;
  }
}

export interface StepFields {
  utc: string;
  commit: string | null;
  out_sha256?: Record<string, string>;
  exploratory?: boolean;
}

export interface NoteFields {
  utc: string;
  commit: string | null;
  what: string;
  detail?: string;
}

export interface AppendOptions {
  /** Record kind (manifest.json `kind`): the step order is checked when given. */
  kind?: LedgerKind;
}

const STEP_FIELD_NAMES = new Set(['utc', 'commit', 'out_sha256', 'exploratory']);
const NOTE_FIELD_NAMES = new Set(['utc', 'commit', 'what', 'detail']);

/**
 * Builds the next ledger line: i and prev are computed, the existing lines are verified
 * first. Returns the line without its newline; append `line + "\n"` to ledger.jsonl.
 * Throws LedgerError when the ledger is broken, a field is wrong or (with opts.kind) the
 * step is not allowed now.
 */
export function appendLedger(lines: readonly string[], step: LedgerStep, fields: StepFields, hash: HashFn, opts?: AppendOptions): string;
export function appendLedger(lines: readonly string[], step: typeof NOTE_STEP, fields: NoteFields, hash: HashFn, opts?: AppendOptions): string;
export function appendLedger(
  lines: readonly string[],
  step: LedgerStep | typeof NOTE_STEP,
  fields: StepFields | NoteFields,
  hash: HashFn,
  opts: AppendOptions = {},
): string {
  const existing = verifyLedger(lines, hash, opts.kind !== undefined ? { kind: opts.kind } : {});
  if (!existing.ok) throw new LedgerError(['ledger.jsonl is broken, nothing appended:', ...existing.errors]);
  const allowed = step === NOTE_STEP ? NOTE_FIELD_NAMES : STEP_FIELD_NAMES;
  const extra = Object.keys(fields).filter((k) => !allowed.has(k));
  if (extra.length > 0) throw new LedgerError([`unexpected field(s) for a "${step}" line: ${extra.join(', ')}`]);

  const i = lines.length;
  const prev = existing.head;
  let record: LedgerLine;
  if (step === NOTE_STEP) {
    const f = fields as NoteFields;
    record = { i, step: NOTE_STEP, utc: f.utc, commit: f.commit, what: f.what, prev };
    if (f.detail !== undefined) record.detail = f.detail;
  } else {
    const f = fields as StepFields;
    record = { i, step, utc: f.utc, commit: f.commit, out_sha256: sortedOutputs(f.out_sha256 ?? {}), exploratory: f.exploratory ?? false, prev };
  }
  const problems = validateLedgerLine(record);
  if (problems.length > 0) throw new LedgerError(problems.map((p) => `new "${step}" line: ${p}`));
  if (opts.kind !== undefined) {
    const st = replayOrder(existing.records, opts.kind);
    const err = typeof st === 'string' ? st : admit(st, opts.kind, candidateOf(record));
    if (err !== null) throw new LedgerError([err]);
  }
  return toJsonlLine(record, 'ledger.jsonl');
}

/** out_sha256 with its file names sorted, as live/lib/ledger.cjs writes it: same content, same line, same hash. */
function sortedOutputs(out: Readonly<Record<string, string>>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(out).sort()) {
    Object.defineProperty(sorted, k, { value: out[k], enumerable: true, writable: true, configurable: true });
  }
  return sorted;
}
