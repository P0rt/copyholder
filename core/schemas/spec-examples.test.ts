// Every example of spec section 8 parses and validates (spec 13.4, row "Схемы").
// The examples are quoted from the spec. Only what the spec itself marks as left out is
// filled in: "…" elisions become well-formed hex, and placeholders like <Mac model>
// are given in English. Wrapped lines of one JSONL row are joined.
import { describe, expect, it } from 'vitest';
import {
  parseJson,
  parseJsonl,
  toJsonText,
  toJsonlLine,
  validateAudioEnv,
  validateCalib,
  validateClockReport,
  validateDetectorInLine,
  validateEventLine,
  validateFreezeManifest,
  validateFrozenParams,
  validateLedgerLine,
  validateManifest,
  validateOnsets,
  validateResults,
  validateSampleLine,
  validateSdkRawLine,
  validateSealedPlan,
  validateStampLine,
  type JsonlFile,
  type OrderedJsonFile,
  type Validator,
} from './index.ts';

let counter = 0;
/** Distinct lowercase hex of the given length. */
function hexFill(len: number): string {
  counter += 1;
  const unit = counter.toString(16).padStart(8, '0');
  return unit.repeat(Math.ceil(len / 8)).slice(0, len);
}

/** Fills the spec's elisions: "sha256:…", "…", "9f2c…a935", "5b0e…(64 hex)". */
function fillElisions(text: string): string {
  return text
    .replace(/"sha256:…"/g, () => `"sha256:${hexFill(64)}"`)
    .replace(/"([0-9a-f]*)…([0-9a-f]*)(?:\(64 hex\))?"/g, (_m, pre: string, post: string) => {
      return `"${pre}${hexFill(64 - pre.length - post.length)}${post}"`;
    });
}

/** Joins a JSONL row the spec wrapped over two lines ("…,\n \"talk\"…"). */
const joinWrapped = (text: string): string => text.replace(/\n /g, '');

// ---- spec 8.1 --------------------------------------------------------------------

const MANIFEST = `{"schema":"session/1","id":"s1","kind":"numbers","started_utc":"2026-11-17T17:02:11Z",
 "app_commit":"3f2c9ab","tree_clean":true,"plan_commitment":"9f2c41d7…d4f6a935",
 "sdk":{"version":"3.5.0","metrics":["CHEST_BREATHING","BREATHING_RATE","FACE_LANDMARKS","TALKING"],"launcher":"node"},
 "machine":"<Mac model>","camera":{"name":"<name from availableCameras()>","requested":[1280,720,30]},
 "audio":{"microphone":"<name from the system>","sample_rate":48000,"mic_flags_off":true,"output_gain":0.35},
 "files":{"audio.wav":"sha256:…","detector_in.jsonl":"sha256:…"}}`;

const STAMPS = `{"n":0,"k":"chunk","frames":9600}
{"n":384000,"k":"click","i":3}
{"n":2880000,"k":"mark","what":"step","name":"opening"}
{"n":8640000,"k":"arr","seq":5417}
{"n":8640000,"k":"hold","cause":"chest","seq":5417,"nSilent":8640384,"word":57}
{"n":8640000,"k":"state","s":"hold_wait"}
{"n":8659200,"k":"voice","on":true}
{"n":8774400,"k":"resume","word":57}
{"n":8790000,"k":"ignored","what":"hold","seq":5431,"s":"listening"}
`;

const SDK_RAW = `{"seq":5417,"kind":"metrics","tArrNs":"812345678901234","tWallMs":1794935111190,"tsCbUs":1794935111156789,"b64":"…"}
`;

const SAMPLES = `{"seq":5417,"k":"m","tArrNs":"812345678901234","tsCbUs":1794935111156789,"tr":[[1794935111123456,-0.4000000059604645]],
 "talk":[[1794935111123456,0]],"g":0.031746031746031744,"hm":0.0021,"lm":{"ts":1794935111123456,"reset":0,"p":[[640.2,402.1],[640.6,409.8]]}}
`;

const DETECTOR_IN = `{"k":"batch","seq":5417,"tr":[[1794935111123456,-0.4000000059604645]],"talk":[[1794935111123456,0]],"g":0.031746031746031744,"hm":0.0021}
{"k":"val","seq":5418,"code":0}
{"k":"voice","n":8659200,"on":true}
{"k":"state","n":8659200,"s":"listening"}
`;

const EVENTS = `{"n":8640000,"e":"fire","det":"D1","seq":5417,"v":2.3125,"theta":1.875}
{"n":8640000,"e":"hold","cause":"chest","nCmd":8640000,"nSilent":8640384,"word":57}
{"n":8774400,"e":"resume","word":57,"why":"voice_off"}
{"n":8966400,"e":"armed","det":"D1","on":true}
`;

const CALIB = `{"schema":"calib/1","L_rt_ms":{"A":23.4,"B":23.6,"spread":[0.3,0.2],"rule":"mean","used":23.5},
 "polarity":{"sign":1,"breaths_agree":3},"A_ref":0.84,
 "camera_clock":{"offset_ms":[41,47],"slope_ppm":38,"ok":true},
 "sniff_lag_ms":{"n":5,"lo_median":148,"hi_median":171.5},
 "leak_db_over_floor":2.9,"output_gain":0.35}`;

const ONSETS = `{"schema":"onsets/1","labels_sha256":"0be2…","events":[
 {"id":"o07","kind":"objection","label":"speech","voiced_ms":640,"floor_db":-57.9,
  "auto":{"n_v":8656704,"n_a":8657664,"breath":[8626560,8651424],"flags":[]},
  "manual":{"n_v":8656944,"blind":true}}]}`;

const CLOCK_REPORT = `{"schema":"clock-report/1","audio_valid":true,"trace_valid":true,
 "chain":{"L_rt_ms":[23.4,23.6],"spread_ms":[0.3,0.2],"quantum_ms":2.7,"stops":11,"stops_match_ch1":11,"nCmd_minus_nArr":0},
 "onset":{"p90_abs_auto_minus_manual_ms":12.5,"events":8,"soft_first_sounds":5},
 "hard":{"chunks_contiguous":true,"sample_rate":48000,"mic_flags_off":true,"device_events":0,"visibility_events":0,
  "trace_rate_median":29.7,"sdk_errors":0,"tap_lost":0},
 "warn":{"not_sent_share":0.004,"tap_loop_p99_ms":3.1,"status_ok_share":0.97,"window_warnings":0}}`;

// ---- spec 8.3, 8.4, 8.5, 8.6, 8.7 -----------------------------------------------------

const PLAN = `{"schema":"sealed-plan/1","session_id":"s1","salt":"5b0e…(64 hex)","created_utc":"2026-11-16T20:12:40Z",
 "draft":{"sha256":"c1a7…","word_count":1184,"days_since_last_read":21},
 "planter":{"master_seed":1839201177,"proposer_model":"gemma3:12b","proposer_digest":"sha256:…","judge_model":"gemma3:12b",
  "judge_digest":"sha256:…","ollama_version":"…","params_sha256":"…","prompts_sha256":"…"},
 "narrator":{"engine":"kokoro-82m","voice":"af_heart","nominal_wpm":155,"measured_wpm_x10":1524,"licence":"Apache-2.0"},
 "passages":[{"passage_id":"opening","original_text_sha256":"…","planted_text_sha256":"…","audio_sha256":"…",
   "duration_ms":75200,"word_count":194,"error_count":0},{"passage_id":"p1","…":"…","error_count":3}],
 "errors":[{"error_id":"s1-e1","passage_id":"p1","sentence_index":4,"class_requested":"number","class_planted":"number",
   "original_sentence":"It took about 40 minutes.","planted_sentence":"It took about 4 minutes.","original_span":"40",
   "replacement":"4","char_start":14,"char_end":16,"word_start":3,"word_end":3,"span_start_ms":21340,"span_end_ms":21620,
   "sentence_end_ms":22410,"wrong_at_span":true,"attempts":2,
   "judge":{"relation":"contradiction","more_likely_original_correct":"yes"}}]}`;

const FROZEN = `{"schema":"params/1",
 "d1":{"grid_hz":30,"L":5,"M":2,"k":2.5,"theta_clamp":[1.3,3.0],"min_rise_A":0.15,"min_rise_ms":200,"arm_breaths":10,
  "refractory_ms":2000,"rearm_ms":4000},
 "hold":{"H_ms":1500,"ramp_frames":384,"audio_pause_ms":250},
 "g":{"theta_G":0.0275,"frames":2,"baseline_s":10},
 "vad":{"highpass_hz":150,"hop_ms":5,"over_floor_db":15,"periodicity":0.5,"on_ms":[30,50],"off_ms":1200},
 "tuned":{"k":{"step":"stage_a","criterion_met":true,"rehearsal_step_up":false},"theta_G":{"step":"stage_a"}}}`;

const FREEZE = `{"schema":"freeze/1","tag":"freeze-1","prereg_sha256":"…","params_sha256":"77c0…","scoring_rules_sha256":"a41d…","prompts_sha256":"…",
 "planter":{"model":"gemma3:12b","digest":"sha256:…","ollama_version":"…"},
 "plans":[
  {"id":"s1","role":"numbers","plan_commitment":"9f2c…a935","draft_sha256":"c1a7…","audio_sha256":["…","…","…","…"],"state":"sealed"},
  {"id":"s2","role":"numbers","…":"…"},{"id":"s3","role":"numbers","…":"…"},{"id":"r1","role":"reserve","…":"…"},
  {"id":"k1","role":"spacebar","…":"…"},
  {"id":"demo-1","role":"demo","…":"…"},{"id":"demo-2","role":"demo","…":"…"},{"id":"demo-3","role":"demo","…":"…"}]}`;

const LEDGER = `{"i":4,"step":"label","utc":"2026-11-14T09:12:40Z","commit":"1a2b3c4","out_sha256":{"onsets.json":"…","clock_report.json":"…"},"exploratory":false,"prev":"…"}
`;

const RESULTS = `{"schema":"results/1",
 "commits":{"gate_prereg_short":"1a2b3c4","freeze_1_short":"9d41e07","params_sha256_short":"77c0a1b2","plans":{"s1":"used","r1":"unused"}},
 "setup":{"sdk_version":"3.5.0","machine":"<Mac model>","camera":"<name>","planter_model":"gemma3:12b","narrator":"Kokoro-82M, af_heart","min_days_since_last_read":16},
 "timing":{"L_rt_min_ms":23.1,"L_rt_max_ms":24.0,"sniff_n":5,"sniff_lag_lo_ms":148,"sniff_lag_hi_ms":171.5,"onset_abs_diff_p90_ms":12.5},
 "gate":{"verdict":"BETWEEN","valid":13,"hits":6,"lead_ms_median_hits":230},
 "sessions":{"count":3,"objections":21,"matched":17,"hits":5,"misses":12,"misses_no_inbreath":8,"misses_inbreath_present":4,
  "wilson_low_pct":13,"wilson_high_pct":53,"chance_used_pct":7.4,"false_holds":14,"active_min":13.2,"false_holds_per_min":1.1},
 "planted":{"total":27,"presented":27,"caught":17,"caught_late":2,"by_class":{"negation":{"caught":6,"presented":7}}},
 "review":{"unplanted_finds":4},
 "rivals":{"chest":{"n":9,"stop_after_span_onset_ms_median":1420},"lips":{"hits":4,"false_per_min":0.9},"talking_flag":{"hits":1},
  "audio_250":{"delay_after_voice_ms":281.5},"space_bar":{"n":8,"stop_after_span_onset_ms_median":980}},
 "paired":{"chest_vs_lips":{"n":17,"wins":7,"losses":4,"ties":6,"p_holm":0.55},"chest_vs_audio250":{"wins":6,"losses":11,"p_holm":0.93}},
 "detector":{"k":2.5}}`;

const AUDIO_ENV = `{"schema":"audio-env/1","step_ms":10,"mic_db":[-58.2,-57.9,-31.4],"narrator_db":[-22.5,-21.8,-90.0]}`;

/** The elided passage and plan objects, written out in full (the spec shows "…":"…"). */
const PASSAGE_REST =
  '"original_text_sha256":"…","planted_text_sha256":"…","audio_sha256":"…","duration_ms":110400,"word_count":286';
const PLAN_REST = '"plan_commitment":"…","draft_sha256":"…","audio_sha256":["…","…","…","…"],"state":"sealed"';

function jsonl<T>(text: string, validate: Validator<T>, file: JsonlFile): T[] {
  const parsed = parseJsonl(fillElisions(joinWrapped(text)), validate, { file });
  expect(parsed.errors).toEqual([]);
  return parsed.rows;
}

function json<T>(text: string, validate: Validator<T>, file: string): T {
  const parsed = parseJson(fillElisions(text), validate, { file });
  expect(parsed.errors).toEqual([]);
  expect(parsed.value).not.toBeNull();
  return parsed.value as T;
}

/** toJsonlLine gives back the example line byte for byte: the spec's key order. */
function expectSameLines(text: string, file: JsonlFile, validate: Validator<unknown>): void {
  const lines = fillElisions(joinWrapped(text)).trimEnd().split('\n');
  for (const line of lines) {
    const value = JSON.parse(line) as object;
    expect(validate(value)).toEqual([]);
    expect(toJsonlLine(value, file)).toBe(line);
  }
}

/**
 * toJsonText restores the example's key order even when every record object was built in
 * reverse order. Maps keyed by file name (manifest `files`) keep their insertion order.
 * (JSON.stringify of the parsed example differs from its text only in "3.0" -> "3".)
 */
function expectSameJson(text: string, file: OrderedJsonFile): void {
  const example = JSON.parse(fillElisions(text)) as unknown;
  const reversed = JSON.parse(JSON.stringify(example), (k, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v) || k === 'files') return v;
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).reverse());
  }) as object;
  expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(example));
  expect(toJsonText(reversed, file)).toBe(`${JSON.stringify(example)}\n`);
}

describe('spec 8.1 session folder examples', () => {
  it('manifest.json', () => {
    const m = json(MANIFEST, validateManifest, 'manifest.json');
    expect(m.kind).toBe('numbers');
    expect(m.plan_commitment).toMatch(/^9f2c41d7[0-9a-f]{48}d4f6a935$/);
    expectSameJson(MANIFEST, 'manifest.json');
  });

  it('stamps.jsonl: one line per kind k, in the spec key order', () => {
    const rows = jsonl(STAMPS, validateStampLine, 'stamps.jsonl');
    expect(rows.map((r) => r.k)).toEqual(['chunk', 'click', 'mark', 'arr', 'hold', 'state', 'voice', 'resume', 'ignored']);
    expectSameLines(STAMPS, 'stamps.jsonl', validateStampLine);
    // Without a file name the order is guessed; stamps lines come out the same.
    for (const line of STAMPS.trimEnd().split('\n')) expect(toJsonlLine(JSON.parse(line) as object)).toBe(line);
  });

  it('sdk_raw.jsonl.gz line', () => {
    jsonl(SDK_RAW, validateSdkRawLine, 'sdk_raw.jsonl');
    expectSameLines(SDK_RAW, 'sdk_raw.jsonl', validateSdkRawLine);
  });

  it('samples.jsonl: the example shows 2 of the 16 points, so it fails until all 16 are there', () => {
    const line = joinWrapped(SAMPLES).trimEnd();
    expect(validateSampleLine(JSON.parse(line))).toEqual(['lm.p: expected 16 items, got 2']);
    const full = JSON.parse(line) as { lm: { p: number[][] } };
    full.lm.p = Array.from({ length: 16 }, (_, i) => [640.2 + i, 402.1 + i]);
    expect(validateSampleLine(full)).toEqual([]);
    // Key order of the example.
    const two = JSON.parse(line) as object;
    expect(toJsonlLine(two, 'samples.jsonl')).toBe(line);
    expect(toJsonlLine(two)).toBe(line);
  });

  it('detector_in.jsonl', () => {
    const rows = jsonl(DETECTOR_IN, validateDetectorInLine, 'detector_in.jsonl');
    expect(rows.map((r) => r.k)).toEqual(['batch', 'val', 'voice', 'state']);
    expectSameLines(DETECTOR_IN, 'detector_in.jsonl', validateDetectorInLine);
  });

  it('events.jsonl', () => {
    const rows = jsonl(EVENTS, validateEventLine, 'events.jsonl');
    expect(rows.map((r) => r.e)).toEqual(['fire', 'hold', 'resume', 'armed']);
    expectSameLines(EVENTS, 'events.jsonl', validateEventLine);
    for (const line of EVENTS.trimEnd().split('\n')) expect(toJsonlLine(JSON.parse(line) as object)).toBe(line);
  });

  // Spec 8.1 shows sniff_lag_ms as it was before PREREG §4 put the count of sniffs without an
  // arrival beside n. The file needs it (and the bound field) for verdict.json to copy it, so the
  // example as printed fails here until spec 8.1 adds no_arrival and median_over_ms to it.
  it('calib.json: the example has no count of sniffs without an arrival (PREREG §4), so it fails until spec 8.1 adds it', () => {
    expect(validateCalib(JSON.parse(CALIB))).toEqual([
      'sniff_lag_ms.no_arrival: missing: the found sniffs whose trace never arrived are counted beside n (PREREG §4)',
      'sniff_lag_ms.median_over_ms: missing: null, or the bound of medians that fall on sniffs without an arrival (PREREG §4)',
    ]);
    expectSameJson(CALIB, 'calib.json');
    // The count beside n, and no bound: all five sniffs arrived.
    const full = CALIB.replace('{"n":5,', '{"n":5,"no_arrival":0,').replace('"hi_median":171.5}', '"hi_median":171.5,"median_over_ms":null}');
    const c = json(full, validateCalib, 'calib.json');
    expect(c.L_rt_ms?.used).toBe(23.5);
    expect(c.sniff_lag_ms).toEqual({ n: 5, no_arrival: 0, lo_median: 148, hi_median: 171.5, median_over_ms: null });
    expectSameJson(full, 'calib.json');
  });

  it('onsets.json', () => {
    const o = json(ONSETS, validateOnsets, 'onsets.json');
    expect(o.events[0]?.auto.n_v).toBe(8656704);
    expectSameJson(ONSETS, 'onsets.json');
  });

  it('clock_report.json', () => {
    json(CLOCK_REPORT, validateClockReport, 'clock_report.json');
    expectSameJson(CLOCK_REPORT, 'clock_report.json');
  });
});

describe('spec 8.3 to 8.7 examples', () => {
  it('plan.json (sealed-plan/1): two of four passages and one of nine errors shown', () => {
    const text = fillElisions(PLAN.replace('"…":"…"', PASSAGE_REST));
    const plan = JSON.parse(text) as { errors: Record<string, unknown>[] };
    // As printed, p1 says 3 errors and lists 1: the check notices.
    expect(validateSealedPlan(plan).join('\n')).toContain('error_count adds up to 3, errors lists 1');
    // Two more errors of p1, copies with their own ids, complete the passage.
    const first = plan.errors[0] as Record<string, unknown>;
    plan.errors.push({ ...first, error_id: 's1-e2' }, { ...first, error_id: 's1-e3' });
    expect(validateSealedPlan(plan)).toEqual([]);
  });

  it('params/frozen.json', () => {
    const p = json(FROZEN, validateFrozenParams, 'params/frozen.json');
    expect(p.d1.k).toBe(2.5);
    expectSameJson(FROZEN, 'params/frozen.json');
  });

  it('freeze_manifest.json, every plan written out', () => {
    const f = json(FREEZE.replaceAll('"…":"…"', PLAN_REST), validateFreezeManifest, 'freeze_manifest.json');
    expect(f.plans.map((p) => p.id)).toEqual(['s1', 's2', 's3', 'r1', 'k1', 'demo-1', 'demo-2', 'demo-3']);
    expectSameJson(FREEZE.replaceAll('"…":"…"', PLAN_REST), 'freeze_manifest.json');
  });

  it('ledger.jsonl line', () => {
    const [line] = jsonl(LEDGER, validateLedgerLine, 'ledger.jsonl');
    expect(line?.step).toBe('label');
    expectSameLines(LEDGER, 'ledger.jsonl', validateLedgerLine);
  });

  it('results.json (part of the keys)', () => {
    json(RESULTS, validateResults, 'results.json');
  });

  it('audio_env.json', () => {
    json(AUDIO_ENV, validateAudioEnv, 'audio_env.json');
    expectSameJson(AUDIO_ENV, 'audio_env.json');
  });
});
