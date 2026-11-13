// Sealed plan and freeze files (spec 8.2, 8.3, 8.4): plan.json (sealed-plan/1),
// freeze_manifest.json (freeze/1), and the sealed timings.json and texts.json.
// The seal itself (RFC 8785 + SHA-256) lives in core/seal, not here.

import {
  arrayOf, bool, fail, int, isPlainObject, jsonValue, lit, makeValidator, nullable, obj, oneOf, str,
  type Spec, type Validator,
} from './check.ts';
import { ERROR_CLASSES, HEX64, sessionId, sha256Hex, sha256Prefixed, utcTime, type ErrorClass } from './common.ts';

/** Every number in a plan is an integer (spec 8.3): ms, word and character indices. */
export const integersOnly: Spec = (v, p, out) => {
  const walk = (x: unknown, path: string): void => {
    if (typeof x === 'number') {
      if (!Number.isSafeInteger(x)) fail(out, path, `plan numbers are integers only (spec 8.3), got ${x}`);
    } else if (Array.isArray(x)) x.forEach((y, i) => walk(y, `${path}[${i}]`));
    else if (isPlainObject(x)) for (const [k, y] of Object.entries(x)) walk(y, path === '' ? k : `${path}.${k}`);
  };
  walk(v, p);
};

const nonNeg: Spec = int({ min: 0 });
const passageId: Spec = str({ pattern: /^(opening|p[1-9])$/, what: '"opening" or "p1".."p9"' });

export interface PlanPassage {
  passage_id: string;
  original_text_sha256: string;
  planted_text_sha256: string;
  audio_sha256: string;
  duration_ms: number;
  word_count: number;
  error_count: number;
}

export interface PlanError {
  error_id: string;
  passage_id: string;
  sentence_index: number;
  class_requested: ErrorClass;
  class_planted: ErrorClass;
  original_sentence: string;
  planted_sentence: string;
  original_span: string;
  replacement: string;
  char_start: number;
  char_end: number;
  word_start: number;
  word_end: number;
  span_start_ms: number;
  span_end_ms: number;
  sentence_end_ms: number;
  wrong_at_span: boolean;
  attempts: number;
  judge: { relation: string; more_likely_original_correct: string };
}

export interface SealedPlan {
  schema: 'sealed-plan/1';
  session_id: string;
  /** 32 random bytes as 64 hex. */
  salt: string;
  created_utc: string;
  draft: { sha256: string; word_count: number; days_since_last_read: number | null };
  planter: {
    master_seed: number;
    proposer_model: string;
    proposer_digest: string;
    judge_model: string;
    judge_digest: string;
    ollama_version: string;
    params_sha256: string;
    prompts_sha256: string;
  };
  narrator: { engine: string; voice: string; nominal_wpm: number; measured_wpm_x10: number; licence: string };
  passages: PlanPassage[];
  errors: PlanError[];
  /** Result of the optional "hunter" call (spec 7.8 step 11); form left to the planter (assumption). */
  hunter?: unknown;
}

export const validateSealedPlan: Validator<SealedPlan> = makeValidator((v, p, out) => {
  const before = out.length;
  obj({
    required: {
      schema: lit('sealed-plan/1'),
      session_id: sessionId,
      salt: sha256Hex,
      created_utc: utcTime,
      draft: obj({ required: { sha256: sha256Hex, word_count: nonNeg, days_since_last_read: nullable(nonNeg) } }),
      planter: obj({
        required: {
          master_seed: nonNeg,
          proposer_model: str(),
          proposer_digest: sha256Prefixed,
          judge_model: str(),
          judge_digest: sha256Prefixed,
          ollama_version: str(),
          params_sha256: sha256Hex,
          prompts_sha256: sha256Hex,
        },
      }),
      narrator: obj({
        required: { engine: str(), voice: str(), nominal_wpm: nonNeg, measured_wpm_x10: nonNeg, licence: str() },
      }),
      passages: arrayOf(
        obj({
          required: {
            passage_id: passageId,
            original_text_sha256: sha256Hex,
            planted_text_sha256: sha256Hex,
            audio_sha256: sha256Hex,
            duration_ms: nonNeg,
            word_count: nonNeg,
            error_count: nonNeg,
          },
        }),
        { min: 1 },
      ),
      errors: arrayOf(
        obj({
          required: {
            error_id: str({ pattern: /^[a-z0-9_-]+-e[0-9]+$/, what: 'an error id like "s1-e1"' }),
            passage_id: passageId,
            sentence_index: nonNeg,
            class_requested: oneOf(ERROR_CLASSES),
            class_planted: oneOf(ERROR_CLASSES),
            original_sentence: str(),
            planted_sentence: str(),
            original_span: str(),
            replacement: str(),
            char_start: nonNeg,
            char_end: nonNeg,
            word_start: nonNeg,
            word_end: nonNeg,
            span_start_ms: nonNeg,
            span_end_ms: nonNeg,
            sentence_end_ms: nonNeg,
            wrong_at_span: bool,
            attempts: int({ min: 1 }),
            judge: obj({ required: { relation: str(), more_likely_original_correct: str() } }),
          },
          check: (e, path, errs) => {
            const x = e as unknown as PlanError;
            if (x.char_end <= x.char_start) fail(errs, path, 'char_end must be after char_start');
            if (x.word_end < x.word_start) fail(errs, path, 'word_end must not be before word_start');
            if (x.span_end_ms < x.span_start_ms) fail(errs, path, 'span_end_ms must not be before span_start_ms');
            if (x.sentence_end_ms < x.span_end_ms) fail(errs, path, 'sentence_end_ms must not be before span_end_ms');
            if (x.original_sentence.slice(x.char_start, x.char_end) !== x.original_span) {
              fail(errs, path, 'original_span is not original_sentence[char_start, char_end)');
            }
          },
        }),
      ),
    },
    optional: { hunter: jsonValue },
    check: (o, path, errs) => {
      const plan = o as unknown as SealedPlan;
      const ids = new Set(plan.passages.map((x) => x.passage_id));
      if (ids.size !== plan.passages.length) fail(errs, path, 'passages: passage_id appears twice');
      const opening = plan.passages.find((x) => x.passage_id === 'opening');
      if (opening !== undefined && opening.error_count !== 0) fail(errs, path, 'the opening has no planted errors (spec 8.3)');
      const total = plan.passages.reduce((s, x) => s + x.error_count, 0);
      if (total !== plan.errors.length) fail(errs, path, `error_count adds up to ${total}, errors lists ${plan.errors.length}`);
      const errIds = new Set<string>();
      for (const e of plan.errors) {
        if (errIds.has(e.error_id)) fail(errs, path, `errors: error_id "${e.error_id}" appears twice`);
        errIds.add(e.error_id);
        if (!ids.has(e.passage_id)) fail(errs, path, `errors: ${e.error_id} names passage "${e.passage_id}" that is not in passages`);
      }
      for (const x of plan.passages) {
        const n = plan.errors.filter((e) => e.passage_id === x.passage_id).length;
        if (n !== x.error_count) fail(errs, path, `passage ${x.passage_id}: error_count ${x.error_count}, errors lists ${n}`);
      }
    },
  })(v, p, out);
  if (out.length === before) integersOnly(v, p, out);
});

// ---- the seal as text: commitment.txt and the screen before narration (spec 8.2, 8.3) ----

/**
 * The seal from the text of commitment.txt: 64 lowercase hex characters, or null. Surrounding
 * white space, upper case and a "sha256:" prefix are tolerated, as host reads it.
 */
export function parseCommitmentText(text: string): string | null {
  const m = /^(?:sha256:)?([0-9a-f]{64})$/.exec(text.trim().toLowerCase());
  return m?.[1] ?? null;
}

/** The 64 characters of a seal in four groups of 16 (screen before narration, receipt line "seal"). */
export function sealGroups(commitment: string): [string, string, string, string] {
  if (!HEX64.test(commitment)) throw new Error(`a seal is 64 lowercase hex characters, got ${JSON.stringify(commitment)}`);
  const g = (i: number): string => commitment.slice(16 * i, 16 * (i + 1));
  return [g(0), g(1), g(2), g(3)];
}

/**
 * The screen before narration (spec 8.3): "SEALED PLAN  <id>", then the 64 characters of the seal
 * in two lines of two groups. Three lines, no final newline.
 */
export function formatSealScreen(id: string, commitment: string): string {
  const [a, b, c, d] = sealGroups(commitment);
  return `SEALED PLAN  ${id}\n${a} ${b}\n${c} ${d}`;
}

// ---- freeze_manifest.json ----------------------------------------------------------

export const PLAN_ROLES = ['numbers', 'reserve', 'spacebar', 'demo'] as const;
export type PlanRole = (typeof PLAN_ROLES)[number];

export interface FreezePlan {
  id: string;
  role: PlanRole;
  plan_commitment: string;
  draft_sha256: string;
  /** Narrator audio of each passage, opening first. */
  audio_sha256: string[];
  state: 'sealed';
}

export interface FreezeManifest {
  schema: 'freeze/1';
  tag: 'freeze-1';
  prereg_sha256: string;
  params_sha256: string;
  scoring_rules_sha256: string;
  prompts_sha256: string;
  planter: { model: string; digest: string; ollama_version: string };
  plans: FreezePlan[];
}

/** At most three demo takes (spec 15.3). */
export const MAX_DEMO_PLANS = 3;

export const validateFreezeManifest: Validator<FreezeManifest> = makeValidator(
  obj({
    required: {
      schema: lit('freeze/1'),
      tag: lit('freeze-1'),
      prereg_sha256: sha256Hex,
      params_sha256: sha256Hex,
      scoring_rules_sha256: sha256Hex,
      prompts_sha256: sha256Hex,
      planter: obj({ required: { model: str(), digest: sha256Prefixed, ollama_version: str() } }),
      plans: arrayOf(
        obj({
          required: {
            id: sessionId,
            role: oneOf(PLAN_ROLES, 'numbers, reserve, spacebar or demo (pilot and rehearsal plans are not frozen, spec 8.4)'),
            plan_commitment: sha256Hex,
            draft_sha256: sha256Hex,
            audio_sha256: arrayOf(sha256Hex, { min: 1 }),
            state: lit('sealed'),
          },
        }),
        { min: 1 },
      ),
    },
    check: (o, p, out) => {
      const plans = (o as unknown as FreezeManifest).plans;
      const ids = new Set<string>();
      const seals = new Set<string>();
      for (const x of plans) {
        if (ids.has(x.id)) fail(out, p, `plans: id "${x.id}" appears twice`);
        if (seals.has(x.plan_commitment)) fail(out, p, `plans: plan_commitment of "${x.id}" appears twice`);
        ids.add(x.id);
        seals.add(x.plan_commitment);
      }
      const demos = plans.filter((x) => x.role === 'demo').length;
      if (demos > MAX_DEMO_PLANS) fail(out, p, `plans: ${demos} demo plans, at most ${MAX_DEMO_PLANS} (spec 15.3)`);
    },
  }),
);

// ---- sealed timings.json and texts.json ----------------------------------------------

/** One narrator word: number, start and end in integer ms from the first sample, sentence number. */
export interface WordTiming {
  index: number;
  startMs: number;
  endMs: number;
  sentenceIndex: number;
}

/**
 * timings.json of one narrator clip (spec 7.7, 8.2): start and end of every word in ms by word
 * number, and its sentence number, no text. The layout is the one tools/tts writes.
 */
export interface Timings {
  schema: 'timings/1';
  /** Word numbering rule, e.g. "copyholder-words/1". */
  wordRule: string;
  sampleRateHz: number;
  durationSamples: number;
  durationMs: number;
  wordCount: number;
  sentenceCount: number;
  /** TTS engine, model and voice facts. */
  engine: Record<string, unknown>;
  correctedChunks: number;
  words: WordTiming[];
}

const NO_TEXT = 'timings carry no text (spec 8.2)';

export const validateTimings: Validator<Timings> = makeValidator(
  obj({
    required: {
      schema: lit('timings/1'),
      wordRule: str({ pattern: /^[a-z0-9-]+\/[0-9]+$/, what: 'a word rule like "copyholder-words/1"' }),
      sampleRateHz: lit(48000),
      durationSamples: nonNeg,
      durationMs: nonNeg,
      wordCount: nonNeg,
      sentenceCount: nonNeg,
      engine: obj({ open: jsonValue, forbidden: { text: NO_TEXT } }),
      correctedChunks: nonNeg,
      words: arrayOf(
        obj({
          required: { index: nonNeg, startMs: nonNeg, endMs: nonNeg, sentenceIndex: nonNeg },
          forbidden: { text: NO_TEXT, word: NO_TEXT },
          check: (w, path, errs) => {
            if (!((w['startMs'] as number) < (w['endMs'] as number))) fail(errs, path, 'startMs must be before endMs');
          },
        }),
      ),
    },
    forbidden: { text: NO_TEXT, passage_text: NO_TEXT },
    check: (o, p, out) => {
      const t = o as unknown as Timings;
      const at = (i: number): string => `${p === '' ? '' : `${p}.`}words[${i}]`;
      if (t.words.length !== t.wordCount) fail(out, p, `wordCount is ${t.wordCount} but ${t.words.length} words are listed`);
      const ms = Math.floor((t.durationSamples * 1000 + t.sampleRateHz / 2) / t.sampleRateHz);
      if (t.durationMs !== ms) fail(out, p, `durationMs ${t.durationMs} does not match ${t.durationSamples} samples (${ms} ms)`);
      let prevEnd = 0;
      t.words.forEach((w, i) => {
        if (w.index !== i) fail(out, at(i), `index is ${w.index}, expected ${i}`);
        if (w.startMs < prevEnd) fail(out, at(i), `starts at ${w.startMs} ms, before the previous word ends at ${prevEnd} ms`);
        const prevSentence = i === 0 ? 0 : (t.words[i - 1] as WordTiming).sentenceIndex;
        if (w.sentenceIndex !== prevSentence && w.sentenceIndex !== prevSentence + 1) {
          fail(out, at(i), `jumps from sentence ${prevSentence} to ${w.sentenceIndex}`);
        }
        prevEnd = Math.max(prevEnd, w.endMs);
      });
      const last = t.words[t.words.length - 1];
      if (last !== undefined) {
        if (last.endMs > t.durationMs) fail(out, p, `the last word ends at ${last.endMs} ms, after the audio (${t.durationMs} ms)`);
        if (last.sentenceIndex + 1 !== t.sentenceCount) {
          fail(out, p, `sentenceCount is ${t.sentenceCount} but the last word is in sentence ${last.sentenceIndex}`);
        }
      }
    },
  }),
);

/** texts.json: original and planted text of the opening and passages (spec 8.2). Layout is an assumption. */
export interface Texts {
  schema: 'texts/1';
  session_id: string;
  passages: { passage_id: string; original: string; planted: string }[];
}

export const validateTexts: Validator<Texts> = makeValidator(
  obj({
    required: {
      schema: lit('texts/1'),
      session_id: sessionId,
      passages: arrayOf(obj({ required: { passage_id: passageId, original: str(), planted: str() } }), { min: 1 }),
    },
  }),
);
