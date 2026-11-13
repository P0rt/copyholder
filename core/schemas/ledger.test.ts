// Step ledger ledger.jsonl (spec 8.5): hash chain, tamper detection, step orders per record
// kind, the exploratory rule, note lines, and the CommonJS copy ledger-steps.json.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import ledgerSteps from './ledger-steps.json' with { type: 'json' };
import {
  EXPLORATORY_STEPS,
  GENESIS_PREV,
  LEDGER_LINE_KEYS,
  LEDGER_NOTE_KEYS,
  LEDGER_ORDERS,
  LEDGER_STEPS,
  LedgerError,
  NOTE_STEP,
  NOTE_WHATS,
  ONCE_STEPS,
  REQUIRED_OUTPUTS,
  AFTER_BATCH_STEPS,
  BATCH_KINDS,
  BEFORE_REVEAL_STEPS,
  appendLedger,
  assertSha256,
  numbersBatchProblems,
  canAppendStep,
  checkStepOrder,
  findSteps,
  ledgerHead,
  nextStep,
  stageAParamsHash,
  validateLedgerLine,
  verifyLedger,
  verifyLedgerText,
  type HashFn,
  type LedgerKind,
  type LedgerLine,
  type BatchLedger,
  type LedgerStep,
  type StepFields,
} from './index.ts';

const sha256: HashFn = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const H = (c: string): string => c.repeat(64);
const UTC = '2026-11-14T09:12:40Z';
const COMMIT = '1a2b3c4';
const PARAMS = { 'params/frozen.json': H('7') };

/**
 * Fields of a step: the files REQUIRED_OUTPUTS names for it (params/frozen.json as PARAMS, the
 * rest H('a'), so verdict lists the verdict.json stage_b wrote), else <step>.json.
 */
function fieldsFor(step: LedgerStep, extra: Partial<StepFields> = {}): StepFields {
  const names = REQUIRED_OUTPUTS[step] ?? [`${step}.json`];
  const out = Object.fromEntries(names.map((n) => [n, PARAMS[n as keyof typeof PARAMS] ?? H('a')]));
  return { utc: UTC, commit: COMMIT, out_sha256: out, ...extra };
}

/** Builds a ledger by appending the given steps (strings) or note lines. */
function build(steps: readonly (LedgerStep | { note: string } | { step: LedgerStep; exploratory: true })[], kind?: LedgerKind): string[] {
  const lines: string[] = [];
  for (const s of steps) {
    const opts = kind !== undefined ? { kind } : {};
    if (typeof s === 'string') lines.push(appendLedger(lines, s, fieldsFor(s), sha256, opts));
    else if ('note' in s) lines.push(appendLedger(lines, NOTE_STEP, { utc: UTC, commit: COMMIT, what: s.note }, sha256, opts));
    else lines.push(appendLedger(lines, s.step, fieldsFor(s.step, { exploratory: true }), sha256, opts));
  }
  return lines;
}

const parse = (lines: readonly string[]): LedgerLine[] => lines.map((l) => JSON.parse(l) as LedgerLine);

describe('ledger line format (spec 8.5)', () => {
  it('the first line has prev = 64 zeros, every next line the SHA-256 of the line before', () => {
    const lines = build(['record', 'quickcheck', 'clocks']);
    const rows = parse(lines);
    expect(rows.map((r) => r.i)).toEqual([0, 1, 2]);
    expect(rows[0]?.prev).toBe(GENESIS_PREV);
    expect(GENESIS_PREV).toBe('0'.repeat(64));
    expect(rows[1]?.prev).toBe(sha256(lines[0] ?? ''));
    expect(rows[2]?.prev).toBe(sha256(lines[1] ?? ''));
    const v = verifyLedger(lines, sha256);
    expect(v).toMatchObject({ ok: true, errors: [] });
    expect(v.head).toBe(sha256(lines[2] ?? ''));
    expect(ledgerHead(lines, sha256)).toBe(v.head);
    expect(ledgerHead([], sha256)).toBe(GENESIS_PREV);
  });

  it('writes the spec example key order, out_sha256 names sorted, as live/lib/ledger.cjs does', () => {
    const line = appendLedger([], 'record', { utc: UTC, commit: COMMIT, out_sha256: { 'onsets.json': H('b'), 'clock_report.json': H('c') } }, sha256);
    expect(line).toBe(
      `{"i":0,"step":"record","utc":"${UTC}","commit":"${COMMIT}","out_sha256":{"clock_report.json":"${H('c')}","onsets.json":"${H('b')}"},"exploratory":false,"prev":"${GENESIS_PREV}"}`,
    );
    expect(Object.keys(JSON.parse(line) as object)).toEqual([...LEDGER_LINE_KEYS]);
    const note = appendLedger([line], NOTE_STEP, { utc: UTC, commit: COMMIT, what: 'plan_seen', detail: 'saw p2 before reveal' }, sha256);
    expect(Object.keys(JSON.parse(note) as object)).toEqual([...LEDGER_NOTE_KEYS]);
    expect(note).toBe(
      `{"i":1,"step":"note","utc":"${UTC}","commit":"${COMMIT}","what":"plan_seen","detail":"saw p2 before reveal","prev":"${sha256(line)}"}`,
    );
  });

  it('accepts the null commit host writes outside a git checkout', () => {
    const line = appendLedger([], 'record', { utc: UTC, commit: null }, sha256);
    expect(line).toContain('"commit":null');
    expect(verifyLedger([line], sha256).ok).toBe(true);
  });

  it('lines written by host (live/lib/ledger.cjs) verify here, byte for byte the same', () => {
    const hostFile = new URL('../../live/lib/ledger.cjs', import.meta.url);
    if (!existsSync(hostFile)) return; // host module not present in this checkout
    const host = createRequire(import.meta.url)(hostFile.pathname) as {
      formatLedgerLine?: (e: { i: number; step: string; utc: string; commit: string | null; outSha256: Record<string, string>; exploratory?: boolean; prev: string }) => string;
    };
    if (typeof host.formatLedgerLine !== 'function') return;
    const out = { 'manifest.json': H('d'), 'audio.wav': H('e') };
    const hostLine = host.formatLedgerLine({ i: 0, step: 'record', utc: UTC, commit: COMMIT, outSha256: out, prev: GENESIS_PREV });
    expect(appendLedger([], 'record', { utc: UTC, commit: COMMIT, out_sha256: out }, sha256)).toBe(hostLine);
    const next = appendLedger([hostLine], 'quickcheck', fieldsFor('quickcheck'), sha256, { kind: 'gate' });
    expect(verifyLedger([hostLine, next], sha256, { kind: 'gate' }).ok).toBe(true);
  });

  it('verifyLedgerText reads a file with a final newline or CRLF endings', () => {
    const lines = build(['record', 'quickcheck']);
    expect(verifyLedgerText(`${lines.join('\n')}\n`, sha256).ok).toBe(true);
    expect(verifyLedgerText(lines.join('\r\n'), sha256).ok).toBe(true);
    expect(verifyLedgerText('', sha256)).toMatchObject({ ok: true, head: GENESIS_PREV, records: [] });
  });

  it('validates the fields of each line with readable messages', () => {
    const good = JSON.parse(build(['record'])[0] ?? '') as Record<string, unknown>;
    expect(validateLedgerLine(good)).toEqual([]);
    expect(validateLedgerLine({ ...good, step: 'publish' })).toEqual([
      expect.stringMatching(/^step: unknown step "publish" \(expected one of record, quickcheck, .*note\)$/),
    ]);
    expect(validateLedgerLine({ ...good, prev: 'abc' })).toEqual(['prev: expected a SHA-256 as 64 lowercase hex characters, got "abc"']);
    expect(validateLedgerLine({ ...good, utc: '2026-11-14 09:12:40' })).toEqual([
      'utc: expected a UTC time like "2026-11-17T17:02:11Z", got "2026-11-14 09:12:40"',
    ]);
    expect(validateLedgerLine({ ...good, out_sha256: { '/Users/x/onsets.json': H('a') } })).toEqual([
      'out_sha256["/Users/x/onsets.json"]: unexpected key (expected a relative file name)',
    ]);
    expect(validateLedgerLine({ ...good, exploratory: 'no' })).toEqual(['exploratory: expected true or false, got "no"']);
    const { exploratory: _e, ...missing } = good;
    expect(validateLedgerLine(missing)).toEqual(['exploratory: missing']);
    expect(validateLedgerLine({ ...good, extra: 1 })).toEqual(['extra: unexpected field']);
    expect(validateLedgerLine({ i: 0, step: 'note', utc: UTC, commit: COMMIT, what: 'Plan seen!', prev: GENESIS_PREV })).toEqual([
      'what: expected a snake_case name, got "Plan seen!"',
    ]);
  });

  it('refuses a hash function that is not SHA-256 of UTF-8 text in lowercase hex', () => {
    expect(() => appendLedger([], 'record', fieldsFor('record'), () => 'not-a-hash')).toThrow(/64 lowercase hex/);
    expect(() => verifyLedger(build(['record']), (s) => sha256(s).toUpperCase())).toThrow(/64 lowercase hex/);
    const latin1: HashFn = (s) => createHash('sha256').update(s, 'latin1').digest('hex');
    expect(() => verifyLedger([], latin1)).toThrow('ledger: the hash function must be SHA-256 of the UTF-8 text, as lowercase hex');
    expect(() => assertSha256((s) => sha256(`${s}\n`))).toThrow(/must be SHA-256/);
    expect(() => assertSha256(sha256)).not.toThrow();
  });
});

describe('tamper detection (spec 8.5: editing any line breaks the chain below it)', () => {
  const FULL = build(LEDGER_ORDERS.numbers, 'numbers');

  it('an edited line shows on the next line; the last line shows against the recorded head', () => {
    const head = verifyLedger(FULL, sha256).head;
    const edited = [...FULL];
    edited[3] = (edited[3] ?? '').replace(H('a'), H('b'));
    const v = verifyLedger(edited, sha256);
    expect(v.ok).toBe(false);
    expect(v.errors).toEqual([
      'ledger.jsonl line 5: prev does not match the SHA-256 of line 4: line 4 or a line above it was changed',
    ]);
    const last = [...FULL];
    last[last.length - 1] = (last[last.length - 1] ?? '').replace('"pack"', '"pack" ');
    expect(verifyLedger(last, sha256).ok).toBe(true);
    const withHead = verifyLedger(last, sha256, { head });
    expect(withHead.ok).toBe(false);
    expect(withHead.errors[0]).toMatch(/^ledger\.jsonl: head [0-9a-f]{16}\.\.\. does not match the recorded [0-9a-f]{16}\.\.\./);
  });

  it('a removed, inserted or swapped line is found', () => {
    const removed = FULL.filter((_, i) => i !== 2);
    expect(verifyLedger(removed, sha256).errors).toEqual([
      'ledger.jsonl line 3: i is 3, expected 2: a line was removed, added or moved',
      'ledger.jsonl line 3: prev does not match the SHA-256 of line 2: line 2 or a line above it was changed',
      ...verifyLedger(removed, sha256).errors.slice(2),
    ]);
    const swapped = [...FULL];
    [swapped[4], swapped[5]] = [swapped[5] ?? '', swapped[4] ?? ''];
    expect(verifyLedger(swapped, sha256).ok).toBe(false);
    const inserted = [...FULL.slice(0, 3), FULL[2] ?? '', ...FULL.slice(3)];
    expect(verifyLedger(inserted, sha256).ok).toBe(false);
    const truncated = FULL.slice(0, -1);
    expect(verifyLedger(truncated, sha256, { head: verifyLedger(FULL, sha256).head }).ok).toBe(false);
  });

  it('any change to any one line is caught (property)', () => {
    const head = verifyLedger(FULL, sha256).head;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: FULL.length - 1 }),
        fc.nat(),
        fc.string({ minLength: 1, maxLength: 3 }),
        (lineIdx, pos, insert) => {
          const original = FULL[lineIdx] ?? '';
          const at = pos % original.length;
          const changed = original.slice(0, at) + insert + original.slice(at);
          fc.pre(changed !== original);
          const lines = [...FULL];
          lines[lineIdx] = changed;
          const v = verifyLedger(lines, sha256, { head });
          expect(v.ok).toBe(false);
          if (lineIdx < FULL.length - 1) {
            expect(v.errors.some((e) => e.startsWith(`ledger.jsonl line ${lineIdx + 2}: prev does not match`))).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('appendLedger refuses to extend a broken ledger', () => {
    const broken = [...FULL.slice(0, 3)];
    broken[1] = (broken[1] ?? '').replace('"quickcheck"', '"clocks"');
    expect(() => appendLedger(broken, 'clocks', fieldsFor('clocks'), sha256)).toThrow(LedgerError);
    try {
      appendLedger(broken, 'clocks', fieldsFor('clocks'), sha256);
    } catch (e) {
      expect((e as LedgerError).problems[0]).toBe('ledger.jsonl is broken, nothing appended:');
      expect((e as LedgerError).problems).toContain(
        'ledger.jsonl line 3: prev does not match the SHA-256 of line 2: line 2 or a line above it was changed',
      );
    }
    expect(() => appendLedger([], 'record', { ...fieldsFor('record'), what: 'x' } as StepFields, sha256)).toThrow(
      'unexpected field(s) for a "record" line: what',
    );
    expect(() => appendLedger([], 'record', { utc: 'yesterday', commit: COMMIT }, sha256)).toThrow(/new "record" line: utc: expected a UTC time/);
  });
});

describe('step orders (spec 8.5 table)', () => {
  it('every kind accepts its own full order and ends with nothing next', () => {
    for (const kind of Object.keys(LEDGER_ORDERS) as LedgerKind[]) {
      const lines = build(LEDGER_ORDERS[kind], kind);
      expect(verifyLedger(lines, sha256, { kind })).toMatchObject({ ok: true, errors: [] });
      expect(nextStep(parse(lines), kind)).toBeNull();
    }
    expect(LEDGER_ORDERS.rehearsal).toEqual(LEDGER_ORDERS.numbers.filter((s) => s !== 'pack'));
    expect(LEDGER_ORDERS.spacebar).toEqual(LEDGER_ORDERS.numbers);
  });

  it('no step can run ahead: each command checks the step before it (property)', () => {
    const kinds = Object.keys(LEDGER_ORDERS) as LedgerKind[];
    fc.assert(
      fc.property(fc.constantFrom(...kinds), fc.nat(), fc.constantFrom(...LEDGER_STEPS), (kind, cut, step) => {
        const order = LEDGER_ORDERS[kind];
        const done = order.slice(0, cut % (order.length + 1));
        const records = parse(build(done, kind));
        const expected = order[done.length];
        const last = done[done.length - 1];
        const reason = canAppendStep(records, kind, step);
        const isRerun = step === last && !ONCE_STEPS.includes(step);
        if (step === expected || isRerun) expect(reason).toBeNull();
        else expect(reason).not.toBeNull();
      }),
      { numRuns: 300 },
    );
  });

  it('gives a readable reason for a skipped, foreign or late step', () => {
    const rec = parse(build(['record', 'quickcheck']));
    expect(canAppendStep(rec, 'numbers', 'label')).toBe('step "label" out of order: after "quickcheck" the next numbers step is "clocks"');
    expect(canAppendStep([], 'gate', 'quickcheck')).toBe('step "quickcheck" out of order: a gate ledger starts with "record"');
    expect(canAppendStep(rec, 'pilot', 'score')).toBe('step "score" is not in the pilot order record -> quickcheck -> onsets -> reveal (spec 8.5)');
    expect(canAppendStep(rec, 'gate', 'score')).toMatch(/^step "score" is not in the gate order/);
    const done = parse(build(LEDGER_ORDERS.demo, 'demo'));
    expect(canAppendStep(done, 'demo', 'review')).toMatch(/^step "review" is not in the demo order/);
    expect(canAppendStep(done, 'demo', 'reveal')).toBe('step "reveal" after "pack", the last demo step');
    expect(nextStep(rec, 'numbers')).toBe('clocks');
    expect(nextStep(parse(build(['record', 'quickcheck'])), 'pilot')).toBe('onsets');
  });

  it('a step may be re-run right after itself, except record, stage_a, stage_b and verdict', () => {
    expect(verifyLedger(build(['record', 'quickcheck', 'quickcheck', 'clocks', 'clocks'], 'numbers'), sha256, { kind: 'numbers' }).ok).toBe(true);
    expect(ONCE_STEPS).toEqual(['record', 'stage_a', 'stage_b', 'verdict']);
    expect(canAppendStep(parse(build(['record'])), 'numbers', 'record')).toBe('step "record" is written once (spec 8.5)');
    const afterA = parse(build(['record', 'quickcheck', 'clocks', 'onsets', 'label', 'stage_a'], 'gate'));
    expect(canAppendStep(afterA, 'gate', 'stage_a')).toMatch(/^step "stage_a" is written once: k and theta_G are tuned once/);
    const afterB = parse(build(['record', 'quickcheck', 'clocks', 'onsets', 'label', 'stage_a', 'stage_b'], 'gate'));
    expect(canAppendStep(afterB, 'gate', 'stage_b')).toBe('"stage_b" after stage_b must be exploratory: stage_b runs once (spec 8.5)');
    expect(canAppendStep(parse(build(['record', 'quickcheck', 'clocks'])), 'numbers', 'quickcheck')).toBe(
      'step "quickcheck" out of order: after "clocks" the next numbers step is "onsets"',
    );
  });

  it('checkStepOrder names the line of each problem', () => {
    const lines = build(['record', 'quickcheck', 'clocks', 'onsets', 'label', 'score'], 'numbers');
    expect(checkStepOrder(parse(lines), 'demo')).toEqual([
      'ledger.jsonl line 5: step "label" is not in the demo order record -> quickcheck -> clocks -> onsets -> score -> reveal -> receipt -> pack (spec 8.5)',
    ]);
    const v = verifyLedger(lines, sha256, { kind: 'pilot' });
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toBe('ledger.jsonl line 3: step "clocks" is not in the pilot order record -> quickcheck -> onsets -> reveal (spec 8.5)');
    expect(checkStepOrder(parse(build(['record', 'onsets'])), 'pilot')).toEqual([
      'ledger.jsonl line 2: step "onsets" out of order: after "record" the next pilot step is "quickcheck"',
    ]);
  });

  it('appendLedger with a kind refuses a step out of order', () => {
    const lines = build(['record', 'quickcheck'], 'gate');
    expect(() => appendLedger(lines, 'stage_a', fieldsFor('stage_a'), sha256, { kind: 'gate' })).toThrow(
      'step "stage_a" out of order: after "quickcheck" the next gate step is "clocks"',
    );
  });
});

describe('day-1 gate: stage A outputs, stage B once, exploratory runs (spec 8.5, 9.5)', () => {
  const UP_TO_A: LedgerStep[] = ['record', 'quickcheck', 'clocks', 'onsets', 'label', 'stage_a'];

  it('stage_a must list the SHA-256 of params/frozen.json; pack --part B reads it back', () => {
    const before = build(['record', 'quickcheck', 'clocks', 'onsets', 'label'], 'gate');
    expect(() => appendLedger(before, 'stage_a', { utc: UTC, commit: COMMIT, out_sha256: { 'notes.json': H('1') } }, sha256, { kind: 'gate' })).toThrow(
      '"stage_a" must list the SHA-256 of params/frozen.json in out_sha256 (spec 7.10, 8.5)',
    );
    expect(REQUIRED_OUTPUTS.stage_a).toEqual(['params/frozen.json']);
    expect(stageAParamsHash(parse(before))).toBeNull();
    expect(stageAParamsHash(parse(build(UP_TO_A, 'gate')))).toBe(H('7'));
  });

  it('stage_a is written once: a re-tune after the objection block was released is refused (spec 7.4, 7.10)', () => {
    const afterA = build(UP_TO_A, 'gate');
    const retune: StepFields = { utc: UTC, commit: COMMIT, out_sha256: { 'params/frozen.json': H('b') } };
    const once =
      'step "stage_a" is written once: k and theta_G are tuned once, and its hash of params/frozen.json releases the objection block (spec 7.4, 7.10)';
    expect(canAppendStep(parse(afterA), 'gate', 'stage_a', { out_sha256: retune.out_sha256 ?? {} })).toBe(once);
    expect(() => appendLedger(afterA, 'stage_a', retune, sha256, { kind: 'gate' })).toThrow(once);
    // Before stage_b no run is exploratory, so stage A cannot be re-run under another name either.
    expect(canAppendStep(parse(afterA), 'gate', 'stage_a', { exploratory: true })).toBe(
      'exploratory "stage_a" before the confirmatory stage_b: only runs after it are exploratory (spec 8.5)',
    );
    // The review probe: record..label, stage_a(7777...), stage_a(bbbb...) written without the order check.
    const twice = [...afterA, appendLedger(afterA, 'stage_a', retune, sha256)];
    const v = verifyLedger(twice, sha256, { kind: 'gate' });
    expect(v.ok).toBe(false);
    expect(v.errors).toEqual([`ledger.jsonl line 7: ${once}`]);
    expect(() => stageAParamsHash(v.records)).toThrow(LedgerError);
    expect(() => stageAParamsHash(v.records)).toThrow('ledger.jsonl holds 2 confirmatory stage_a lines (lines 6, 7): stage A runs once (spec 7.4, 8.5)');
  });

  it('verdict follows the confirmatory stage_b and lists the verdict.json stage_b wrote', () => {
    const afterB = build([...UP_TO_A, 'stage_b'], 'gate');
    expect(canAppendStep(parse(afterB), 'gate', 'verdict')).toBeNull();
    expect(nextStep(parse(afterB), 'gate')).toBe('verdict');
    // A note line between them changes nothing: notes are transparent.
    const noted = build([...UP_TO_A, 'stage_b', { note: 'narrowed_claim' }], 'gate');
    expect(canAppendStep(parse(noted), 'gate', 'verdict')).toBeNull();
    // The verdict comes from stage_b: another verdict.json is refused.
    const other = { 'verdict.json': H('b'), 'verdict.md': H('c') };
    expect(canAppendStep(parse(afterB), 'gate', 'verdict', { out_sha256: other })).toBe(
      `"verdict" must list the verdict.json that stage_b wrote (${H('a').slice(0, 16)}...): the verdict comes from stage_b and does not change (spec 8.5)`,
    );
    expect(canAppendStep(parse(afterB), 'gate', 'verdict', { out_sha256: { 'verdict.json': H('a'), 'verdict.md': H('c') } })).toBeNull();
    const records = parse(build([...UP_TO_A, 'stage_b'], 'gate'));
    const stageB = records[records.length - 1] as LedgerLine;
    expect(checkStepOrder([...parse(build(UP_TO_A, 'gate')), { ...stageB, i: 6, step: 'verdict' } as LedgerLine], 'gate')).toEqual([
      'ledger.jsonl line 7: step "verdict" out of order: after "stage_a" the next gate step is "stage_b"',
    ]);
  });

  it('a run that stopped after stage_b: exploratory runs, then the verdict with the hash stage_b wrote, then pack', () => {
    const stopped = build(
      [...UP_TO_A, 'stage_b', { step: 'stage_a', exploratory: true }, { note: 'narrowed_claim' }, { step: 'stage_b', exploratory: true }, { step: 'verdict', exploratory: true }],
      'gate',
    );
    expect(verifyLedger(stopped, sha256, { kind: 'gate' })).toMatchObject({ ok: true, errors: [] });
    const records = parse(stopped);
    // nextStep and canAppendStep agree: the confirmatory verdict is still to come.
    expect(nextStep(records, 'gate')).toBe('verdict');
    expect(canAppendStep(records, 'gate', 'verdict')).toBeNull();
    expect(canAppendStep(records, 'gate', 'pack')).toBe('step "pack" out of order: after "stage_b" the next gate step is "verdict"');
    expect(canAppendStep(records, 'gate', 'verdict', { out_sha256: { 'verdict.json': H('e'), 'verdict.md': H('e') } })).toMatch(
      /^"verdict" must list the verdict\.json that stage_b wrote/,
    );
    const done = [...stopped];
    done.push(appendLedger(done, 'verdict', fieldsFor('verdict'), sha256, { kind: 'gate' }));
    expect(nextStep(parse(done), 'gate')).toBe('pack');
    expect(canAppendStep(parse(done), 'gate', 'verdict')).toBe('"verdict" after stage_b must be exploratory: stage_b runs once (spec 8.5)');
    done.push(appendLedger(done, 'pack', fieldsFor('pack'), sha256, { kind: 'gate' }));
    expect(verifyLedger(done, sha256, { kind: 'gate' })).toMatchObject({ ok: true, errors: [] });
    expect(nextStep(parse(done), 'gate')).toBeNull();
    expect(findSteps(parse(done), 'verdict')).toHaveLength(1);
  });

  it('nextStep answers null on a ledger that already breaks the order', () => {
    const records = parse(build(['record', 'quickcheck']));
    const broken = [records[0], { ...records[1], step: 'clocks' }] as LedgerLine[];
    expect(canAppendStep(broken, 'gate', 'onsets')).toMatch(/^the ledger already breaks the gate order at line 2: step "clocks" out of order/);
    expect(nextStep(broken, 'gate')).toBeNull();
  });

  it('after stage_b every analyze:gate line is exploratory and changes nothing', () => {
    const steps = [
      ...UP_TO_A, 'stage_b', 'verdict',
      { step: 'stage_a', exploratory: true }, { step: 'stage_b', exploratory: true }, { step: 'verdict', exploratory: true },
      'pack',
      { step: 'stage_b', exploratory: true },
    ] as const;
    const lines = build(steps, 'gate');
    expect(verifyLedger(lines, sha256, { kind: 'gate' }).ok).toBe(true);
    const records = parse(lines);
    expect(findSteps(records, 'stage_b')).toHaveLength(1);
    expect(findSteps(records, 'stage_b', { exploratory: true })).toHaveLength(2);
    expect(stageAParamsHash(records)).toBe(H('7'));
    const done = parse(build([...UP_TO_A, 'stage_b', 'verdict'], 'gate'));
    expect(canAppendStep(done, 'gate', 'stage_a')).toBe('"stage_a" after stage_b must be exploratory: stage_b runs once (spec 8.5)');
    expect(canAppendStep(done, 'gate', 'verdict')).toBe('"verdict" after stage_b must be exploratory: stage_b runs once (spec 8.5)');
    expect(nextStep(records, 'gate')).toBeNull();
  });

  it('exploratory only after stage_b, only for analyze:gate steps, only in the gate record', () => {
    const upToA = parse(build(UP_TO_A, 'gate'));
    expect(canAppendStep(upToA, 'gate', 'stage_b', { exploratory: true })).toBe(
      'exploratory "stage_b" before the confirmatory stage_b: only runs after it are exploratory (spec 8.5)',
    );
    const afterB = parse(build([...UP_TO_A, 'stage_b', 'verdict'], 'gate'));
    expect(canAppendStep(afterB, 'gate', 'pack', { exploratory: true })).toBe(
      '"pack" cannot be exploratory: only the analyze:gate steps stage_a, stage_b and verdict can (spec 8.5)',
    );
    expect(canAppendStep(parse(build(['record'])), 'numbers', 'stage_a', { exploratory: true })).toBe(
      'exploratory "stage_a" in a numbers record: only the day-1 gate runs analyze:gate (spec 8.5)',
    );
    expect(EXPLORATORY_STEPS).toEqual(['stage_a', 'stage_b', 'verdict']);
  });
});

describe('outputs: every step writes the SHA-256 of its result (spec 7.10, 8.5)', () => {
  const NO_FILE = 'lists no file in out_sha256: every step writes the SHA-256 of its result, and the next step does not start without it (spec 7.10)';

  it('a step line with an empty out_sha256 is refused by canAppendStep, appendLedger and verifyLedger', () => {
    const rec = build(['record'], 'numbers');
    expect(canAppendStep(parse(rec), 'numbers', 'quickcheck', { out_sha256: {} })).toBe(`"quickcheck" ${NO_FILE}`);
    expect(canAppendStep(parse(rec), 'numbers', 'quickcheck', { out_sha256: { 'quickcheck.json': H('1') } })).toBeNull();
    // Without out_sha256 only the order is checked; the files are checked when the line is written.
    expect(canAppendStep(parse(rec), 'numbers', 'quickcheck')).toBeNull();
    expect(() => appendLedger(rec, 'quickcheck', { utc: UTC, commit: COMMIT }, sha256, { kind: 'numbers' })).toThrow(`"quickcheck" ${NO_FILE}`);
    // Exploratory lines list their files too.
    const done = parse(build(['record', 'quickcheck', 'clocks', 'onsets', 'label', 'stage_a', 'stage_b', 'verdict'], 'gate'));
    expect(canAppendStep(done, 'gate', 'stage_a', { exploratory: true, out_sha256: {} })).toBe(`"stage_a" ${NO_FILE}`);
    expect(canAppendStep(done, 'gate', 'stage_a', { exploratory: true, out_sha256: { 'frozen.exploratory-2.json': H('1') } })).toBeNull();
  });

  it('the review probe: a numbers ledger from record to pack with {} on every line does not verify', () => {
    const lines: string[] = [];
    for (const step of LEDGER_ORDERS.numbers) lines.push(appendLedger(lines, step, { utc: UTC, commit: COMMIT, out_sha256: {} }, sha256));
    expect(verifyLedger(lines, sha256).ok).toBe(true); // the format alone allows it
    const v = verifyLedger(lines, sha256, { kind: 'numbers' });
    expect(v.ok).toBe(false);
    // Each line names its own problem: a line in its place still advances the order.
    expect(v.errors).toEqual(LEDGER_ORDERS.numbers.map((step, i) => `ledger.jsonl line ${i + 1}: "${step}" ${NO_FILE}`));
  });

  it('the steps whose hashes later steps check list their named files', () => {
    expect(REQUIRED_OUTPUTS).toEqual({
      onsets: ['onsets.json'],
      label: ['clock_report.json', 'onsets.json'],
      stage_a: ['params/frozen.json'],
      stage_b: ['verdict.json'],
      verdict: ['verdict.json', 'verdict.md'],
      score: ['score.json.enc'],
      review: ['review.json'],
      receipt: ['receipt.json', 'receipt.txt'],
    });
    for (const kind of ['gate', 'numbers', 'demo'] as const) {
      const order = LEDGER_ORDERS[kind];
      order.forEach((step, k) => {
        const before = parse(build(order.slice(0, k), kind));
        const names = REQUIRED_OUTPUTS[step] ?? [];
        for (const f of names) {
          const out: Record<string, string> = { 'other.txt': H('a') };
          for (const n of names) if (n !== f) out[n] = H('a');
          expect(canAppendStep(before, kind, step, { out_sha256: out })).toBe(`"${step}" must list the SHA-256 of ${f} in out_sha256 (spec 7.10, 8.5)`);
        }
        expect(canAppendStep(before, kind, step, { out_sha256: fieldsFor(step).out_sha256 ?? {} })).toBeNull();
      });
    }
    // The spec example line of label lists both files.
    const label = appendLedger(build(['record', 'quickcheck', 'clocks', 'onsets'], 'gate'), 'label', fieldsFor('label'), sha256, { kind: 'gate' });
    expect(Object.keys((JSON.parse(label) as LedgerLine & { out_sha256: object }).out_sha256)).toEqual(['clock_report.json', 'onsets.json']);
  });
});

describe('note lines (spec 8.5, 10.6)', () => {
  it('plan_seen and other notes stand anywhere and do not advance the order', () => {
    const lines = build([{ note: 'plan_seen' }, 'record', 'quickcheck', { note: 'plan_seen' }, 'clocks'], 'numbers');
    const v = verifyLedger(lines, sha256, { kind: 'numbers' });
    expect(v.ok).toBe(true);
    expect(nextStep(v.records, 'numbers')).toBe('onsets');
    expect(v.records.filter((r) => r.step === NOTE_STEP).map((r) => (r as { what: string }).what)).toEqual(['plan_seen', 'plan_seen']);
    expect(NOTE_WHATS).toContain('plan_seen');
  });
});

describe('ledger-steps.json: the same rules for CommonJS code (host)', () => {
  it('matches the TypeScript constants', () => {
    expect(ledgerSteps.steps).toEqual([...LEDGER_STEPS]);
    expect(ledgerSteps.orders).toEqual(LEDGER_ORDERS);
    expect(ledgerSteps.once).toEqual([...ONCE_STEPS]);
    expect(ledgerSteps.exploratory.steps).toEqual([...EXPLORATORY_STEPS]);
    expect(ledgerSteps.required_outputs).toEqual(REQUIRED_OUTPUTS);
    expect(ledgerSteps.note.step).toBe(NOTE_STEP);
    expect(ledgerSteps.note.whats).toEqual([...NOTE_WHATS]);
    expect(ledgerSteps.line.keys).toEqual([...LEDGER_LINE_KEYS]);
    expect(ledgerSteps.line.note_keys).toEqual([...LEDGER_NOTE_KEYS]);
    expect(ledgerSteps.line.first_prev).toBe(GENESIS_PREV);
    expect(ledgerSteps.batch.kinds).toEqual([...BATCH_KINDS]);
    expect(ledgerSteps.batch.after_last_record).toEqual([...AFTER_BATCH_STEPS]);
    expect(ledgerSteps.batch.before_first_reveal).toEqual([...BEFORE_REVEAL_STEPS]);
  });

  it('can be loaded with require() from CommonJS', () => {
    const req = createRequire(import.meta.url);
    const json = req('./ledger-steps.json') as typeof ledgerSteps;
    expect(json.orders.gate).toEqual(LEDGER_ORDERS.gate);
  });
});

describe('the numbers batch across ledgers (spec 8.5, 10.5, 7.9)', () => {
  const at = (day: number, h: number, m = 0): string =>
    `2026-11-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

  /** A ledger of one record kind from [step, utc] pairs, appended with the order checked. */
  function timed(id: string, kind: LedgerKind, steps: readonly (readonly [LedgerStep, string])[]): BatchLedger {
    const lines: string[] = [];
    for (const [step, utc] of steps) lines.push(appendLedger(lines, step, fieldsFor(step, { utc }), sha256, { kind }));
    return { id, kind, records: parse(lines) };
  }

  /** Between sessions only quickcheck and clocks; the rest after the last recording (spec 10.5). */
  const recorded = (day: number, h: number): (readonly [LedgerStep, string])[] => [
    ['record', at(day, h)], ['quickcheck', at(day, h, 5)], ['clocks', at(day, h, 10)],
  ];
  const afterBatch: (readonly [LedgerStep, string])[] = [
    ['onsets', at(18, 12)], ['label', at(18, 12, 20)], ['score', at(18, 12, 30)], ['review', at(18, 12, 40)],
    ['reveal', at(18, 13)], ['receipt', at(18, 13, 30)], ['pack', at(18, 14)],
  ];

  function batch(): BatchLedger[] {
    return [
      timed('s1', 'numbers', [...recorded(17, 17), ...afterBatch]),
      timed('s2', 'numbers', [...recorded(17, 19), ...afterBatch]),
      timed('s3', 'numbers', [...recorded(18, 10), ...afterBatch]),
      timed('k1', 'spacebar', [...recorded(18, 11), ...afterBatch]),
    ];
  }

  it('accepts the order of spec 10.5', () => {
    expect(numbersBatchProblems(batch())).toEqual([]);
    expect(BATCH_KINDS).toEqual(['numbers', 'spacebar']);
  });

  it('no step from onsets to receipt before the last session and the space-bar block are recorded', () => {
    const early = timed('s1', 'numbers', [...recorded(17, 17), ['onsets', at(17, 18)], ['label', at(17, 18, 30)]]);
    const [, s2, s3, k1] = batch();
    if (s2 === undefined || s3 === undefined || k1 === undefined) throw new Error('batch of four');
    expect(numbersBatchProblems([early, s2, s3, k1])).toEqual([
      's1 ledger.jsonl line 4: "onsets" at 2026-11-17T18:00:00Z ran before k1 was recorded at 2026-11-18T11:00:00Z: steps from onsets to receipt run after the last session and the space-bar block (spec 8.5, 10.5)',
      's1 ledger.jsonl line 5: "label" at 2026-11-17T18:30:00Z ran before k1 was recorded at 2026-11-18T11:00:00Z: steps from onsets to receipt run after the last session and the space-bar block (spec 8.5, 10.5)',
      's1: no "score" before the first reveal (s2 at 2026-11-18T13:00:00Z): reveal needs label, score and review in every ledger of the batch (spec 7.9)',
      's1: no "review" before the first reveal (s2 at 2026-11-18T13:00:00Z): reveal needs label, score and review in every ledger of the batch (spec 7.9)',
    ]);
  });

  it('reveal needs label, score and review in every ledger of the batch (spec 7.9)', () => {
    const [s1, s2, s3] = batch();
    if (s1 === undefined || s2 === undefined || s3 === undefined) throw new Error('batch of four');
    const k1 = timed('k1', 'spacebar', [...recorded(18, 11), ['onsets', at(18, 12)], ['label', at(18, 12, 20)], ['score', at(18, 12, 30)]]);
    expect(numbersBatchProblems([s1, s2, s3, k1])).toEqual([
      'k1: no "review" before the first reveal (s1 at 2026-11-18T13:00:00Z): reveal needs label, score and review in every ledger of the batch (spec 7.9)',
    ]);
    // A review written only after the first reveal does not count: labels do not change after it.
    const late = timed('k1', 'spacebar', [...recorded(18, 11), ['onsets', at(18, 12)], ['label', at(18, 12, 20)], ['score', at(18, 12, 30)], ['review', at(18, 13, 5)]]);
    expect(numbersBatchProblems([s1, s2, s3, late])).toHaveLength(1);
  });

  it('only numbers sessions and the space-bar block form the batch; each needs its record line', () => {
    const gate = timed('gate-a', 'gate', recorded(14, 18));
    const empty: BatchLedger = { id: 's9', kind: 'numbers', records: [] };
    expect(numbersBatchProblems([...batch(), gate, empty])).toEqual([
      'gate-a: a gate record is not part of the numbers batch (numbers sessions and the space-bar block, spec 10.5)',
      's9: ledger.jsonl has no "record" step',
      's9: no "label" before the first reveal (s1 at 2026-11-18T13:00:00Z): reveal needs label, score and review in every ledger of the batch (spec 7.9)',
      's9: no "score" before the first reveal (s1 at 2026-11-18T13:00:00Z): reveal needs label, score and review in every ledger of the batch (spec 7.9)',
      's9: no "review" before the first reveal (s1 at 2026-11-18T13:00:00Z): reveal needs label, score and review in every ledger of the batch (spec 7.9)',
    ]);
  });

  it('steps from onsets on need a numbers session and the space-bar block in the batch, unless the block was cut', () => {
    const [s1, s2, s3, k1] = batch();
    if (s1 === undefined || s2 === undefined || s3 === undefined || k1 === undefined) throw new Error('batch of four');
    const noBlock =
      'no space-bar block ledger with a "record" step: steps from onsets to receipt run after the last session and the space-bar block, ' +
      'and reveal checks the ledgers of all recorded sessions (spec 8.5, 10.5); pass spacebarCut when the block was cut (spec 14.4)';
    // The review probe: one numbers ledger from record to reveal.
    expect(numbersBatchProblems([s1])).toEqual([noBlock]);
    expect(numbersBatchProblems([s1, s2, s3])).toEqual([noBlock]);
    expect(numbersBatchProblems([s1, s2, s3], { spacebarCut: true })).toEqual([]);
    expect(numbersBatchProblems([k1])).toEqual([
      'no numbers session ledger with a "record" step: steps from onsets to receipt run after the last session (spec 8.5, 10.5)',
    ]);
    expect(numbersBatchProblems(batch(), { spacebarCut: true })).toEqual(['k1: a space-bar block ledger, but the block is marked as cut (spec 14.4)']);
    // Between sessions nothing waits for the block yet.
    expect(numbersBatchProblems([timed('s1', 'numbers', recorded(17, 17))])).toEqual([]);
  });

  it('equal times pass; notes stand anywhere', () => {
    const same = timed('s1', 'numbers', [['record', at(18, 11)], ['quickcheck', at(18, 11)], ['clocks', at(18, 11)], ['onsets', at(18, 11)]]);
    const k1 = timed('k1', 'spacebar', recorded(18, 11));
    expect(numbersBatchProblems([same, k1])).toEqual([]);
    const lines = build([{ note: 'plan_seen' }, 'record'], 'numbers');
    expect(numbersBatchProblems([{ id: 's1', kind: 'numbers', records: parse(lines) }])).toEqual([]);
  });
});
