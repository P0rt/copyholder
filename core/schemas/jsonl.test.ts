// JSON/JSONL helpers and the precision rules of spec 8.1.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  isRound1,
  orderKeys,
  parseJson,
  parseJsonl,
  plusZero,
  round1,
  sampleToDetectorIn,
  splitJsonlLines,
  splitTruncatedTail,
  toJsonText,
  toJsonlLine,
  toJsonlText,
  validateDetectorInLine,
  validateStampLine,
  type DetBatch,
  type SampleLine,
} from './index.ts';

describe('round1: report values in ms and dB (spec 8.1)', () => {
  it('rounds half away from zero on the printed decimal', () => {
    expect(round1(23.45)).toBe(23.5);
    expect(round1(-23.45)).toBe(-23.5);
    expect(round1(0.15)).toBe(0.2);
    expect(round1(2.25)).toBe(2.3);
    expect(round1(23.44999)).toBe(23.4);
    expect(round1(0.1 + 0.2)).toBe(0.3);
    expect(round1(171.5)).toBe(171.5);
    expect(round1(-90)).toBe(-90);
  });

  it('never returns -0 and leaves non-finite input alone', () => {
    expect(Object.is(round1(-0.04), 0)).toBe(true);
    expect(Object.is(round1(-0), 0)).toBe(true);
    expect(round1(1e-7)).toBe(0);
    expect(round1(1e21)).toBe(1e21);
    expect(round1(Number.NaN)).toBeNaN();
    expect(round1(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it('isRound1 tells written report values from raw ones', () => {
    expect(isRound1(23.4)).toBe(true);
    expect(isRound1(-57.9)).toBe(true);
    expect(isRound1(640)).toBe(true);
    expect(isRound1(0.1 + 0.2)).toBe(false);
    expect(isRound1(23.45)).toBe(false);
    expect(isRound1(Number.NaN)).toBe(false);
  });

  it('is idempotent, within 0.05, and survives JSON', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), (x) => {
        const r = round1(x);
        expect(round1(r)).toBe(r);
        expect(isRound1(r)).toBe(true);
        expect(Math.abs(r - x)).toBeLessThanOrEqual(0.05 + 1e-9);
        expect(JSON.parse(JSON.stringify(r))).toBe(r);
      }),
    );
  });
});

describe('toJsonlLine', () => {
  it('writes detector values unrounded: a detector input reads back to the same number (spec 8.1)', () => {
    // Every double, -0 included: inputs are formed by sampleToDetectorIn, which turns -0 into 0.
    const finite = fc.double({ noNaN: true, noDefaultInfinity: true });
    const packet = (tr: [number, number][], g: number, hm: number): SampleLine =>
      ({ seq: 1, k: 'm', tArrNs: '1', tsCbUs: 1, tr, talk: [], g, hm }) as SampleLine;
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 2 ** 52 }), finite), { maxLength: 4 }), finite, finite, (tr, g, hm) => {
        const line = sampleToDetectorIn(packet(tr, g, hm)) as DetBatch;
        const back = JSON.parse(toJsonlLine(line, 'detector_in.jsonl')) as DetBatch;
        expect(back).toEqual(line);
        expect(back.tr.every(([t, v], i) => t === line.tr[i]?.[0] && Object.is(v, line.tr[i]?.[1]))).toBe(true);
        expect(Object.is(back.g, line.g)).toBe(true);
        expect(Object.is(back.hm, line.hm)).toBe(true);
      }),
    );
  });

  it('-0 is the one number JSON does not keep, so detector inputs never carry it (spec 8.1)', () => {
    expect(toJsonlLine({ k: 'batch', seq: 1, tr: [[5, -0]], talk: [], g: -0, hm: -0 }, 'detector_in.jsonl')).toBe(
      '{"k":"batch","seq":1,"tr":[[5,0]],"talk":[],"g":0,"hm":0}',
    );
    expect(Object.is(JSON.parse('-0'), -0)).toBe(true); // an SDK "-0.0" parses to -0
    const line = sampleToDetectorIn({ seq: 1, k: 'm', tArrNs: '1', tsCbUs: 1, tr: [[5, JSON.parse('-0.0') as number]], talk: [], g: -0, hm: -0 } as SampleLine) as DetBatch;
    expect(Object.is(line.tr[0]?.[1], 0)).toBe(true);
    expect(Object.is(line.g, 0)).toBe(true);
    expect(Object.is(line.hm, 0)).toBe(true);
    expect(Object.is(plusZero(-0), 0)).toBe(true);
    expect(plusZero(-1e-300)).toBe(-1e-300);
    expect(sampleToDetectorIn({ seq: 2, k: 'm', tArrNs: '1', tsCbUs: 1, tr: [], talk: [], g: null, hm: null } as SampleLine)).toMatchObject({ g: null, hm: null });
  });

  it('gives the same text whatever order the keys were set in', () => {
    const line = { n: 8640000, k: 'hold', cause: 'chest', seq: 5417, nSilent: 8640384, word: 57 };
    const expected = '{"n":8640000,"k":"hold","cause":"chest","seq":5417,"nSilent":8640384,"word":57}';
    const entries = Object.entries(line);
    fc.assert(
      fc.property(fc.shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length }), (shuffled) => {
        expect(toJsonlLine(Object.fromEntries(shuffled))).toBe(expected);
      }),
    );
  });

  it('orders nested objects too and keeps unknown keys after the known ones', () => {
    const lm = { p: [[1, 2]], reset: 0, ts: 5 };
    const line = { extra: 1, lm, hm: null, g: null, talk: [], tr: [], tsCbUs: 7, tArrNs: '9', k: 'm', seq: 3 };
    expect(toJsonlLine(line, 'samples.jsonl')).toBe(
      '{"seq":3,"k":"m","tArrNs":"9","tsCbUs":7,"tr":[],"talk":[],"g":null,"hm":null,"lm":{"ts":5,"reset":0,"p":[[1,2]]},"extra":1}',
    );
  });

  it('needs the file name for detector_in voice and state lines, which look like stamps', () => {
    const voice = { k: 'voice', n: 8659200, on: true };
    expect(toJsonlLine(voice, 'detector_in.jsonl')).toBe('{"k":"voice","n":8659200,"on":true}');
    expect(toJsonlLine(voice, 'stamps.jsonl')).toBe('{"n":8659200,"k":"voice","on":true}');
    expect(toJsonlLine(voice)).toBe('{"n":8659200,"k":"voice","on":true}');
    expect(toJsonlLine({ seq: 1, k: 'batch', tr: [], talk: [], g: null, hm: null })).toBe(
      '{"k":"batch","seq":1,"tr":[],"talk":[],"g":null,"hm":null}',
    );
  });

  it('refuses values JSON cannot hold exactly, naming the field', () => {
    expect(() => toJsonlLine({ k: 'batch', seq: 1, tr: [[1, Number.NaN]], talk: [], g: 0, hm: 0 })).toThrow(/tr\[0\]\[1\] is NaN/);
    expect(() => toJsonlLine({ n: 1, k: 'arr', seq: Number.POSITIVE_INFINITY })).toThrow(/seq is Infinity/);
    expect(() => toJsonlLine({ seq: 1, k: 'm', tArrNs: 812345678901234n })).toThrow(/tArrNs is a bigint/);
    expect(() => toJsonlLine({ n: 1, k: 'mark', list: [1, undefined] })).toThrow(/list\[1\] is undefined/);
    expect(() => toJsonlLine({ n: 1, k: 'mark', when: new Date(0) })).toThrow(/when is a Date/);
    expect(() => toJsonlLine({ k: 'batch', tr: new Float32Array(2) })).toThrow(/tr is a Float32Array/);
  });

  it('drops undefined properties like JSON.stringify and has no newline', () => {
    const text = toJsonlLine({ n: 1, k: 'mark', what: 'key', name: undefined, note: 'a\nb' });
    expect(text).toBe('{"n":1,"k":"mark","what":"key","note":"a\\nb"}');
    expect(text.includes('\n')).toBe(false);
  });

  it('copes with a "__proto__" key without touching prototypes', () => {
    const value = JSON.parse('{"n":1,"k":"chunk","__proto__":{"x":1}}') as object;
    const ordered = orderKeys(value, 'stamps.jsonl') as Record<string, unknown>;
    expect(Object.getPrototypeOf(ordered)).toBe(Object.prototype);
    expect(Object.hasOwn(ordered, '__proto__')).toBe(true);
    expect(toJsonlLine(value)).toBe('{"n":1,"k":"chunk","__proto__":{"x":1}}');
  });

  it('toJsonlText ends every line with a newline; toJsonText too', () => {
    expect(toJsonlText([{ n: 0, k: 'chunk', frames: 9600 }, { n: 9600, k: 'chunk', frames: 9600 }])).toBe(
      '{"n":0,"k":"chunk","frames":9600}\n{"n":9600,"k":"chunk","frames":9600}\n',
    );
    expect(toJsonText({ step_ms: 10, schema: 'audio-env/1' }, 'audio_env.json')).toBe('{"schema":"audio-env/1","step_ms":10}\n');
    expect(toJsonText({ b: 1, a: 2 }, null, 2)).toBe('{\n  "b": 1,\n  "a": 2\n}\n');
  });
});

describe('splitJsonlLines and parseJsonl', () => {
  it('handles the final newline, CRLF and a byte order mark', () => {
    expect(splitJsonlLines('')).toEqual([]);
    expect(splitJsonlLines('a\n')).toEqual(['a']);
    expect(splitJsonlLines('a\nb')).toEqual(['a', 'b']);
    expect(splitJsonlLines('﻿a\r\nb\r\n')).toEqual(['a', 'b']);
  });

  it('reports each problem with its line number and the file name', () => {
    const text = [
      '{"n":0,"k":"chunk","frames":9600}',
      '',
      '{"n":9600,"k":"chunk","frames":9600',
      '{"n":1.5,"k":"chunk","frames":9600}',
      '{"n":19200,"k":"chunk","frames":9600}',
    ].join('\n');
    const parsed = parseJsonl(text, validateStampLine, { file: 'stamps.jsonl' });
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.lineNumbers).toEqual([1, 5]);
    expect(parsed.errors[0]).toBe('stamps.jsonl line 2: empty line');
    expect(parsed.errors[1]).toMatch(/^stamps\.jsonl line 3: not valid JSON \(/);
    expect(parsed.errors[2]).toBe('stamps.jsonl line 4: n: expected a sample number (non-negative integer), got 1.5');
    expect(parsed.errors).toHaveLength(3);
  });

  it('splitTruncatedTail finds only a last line cut short: no newline and not valid JSON', () => {
    const whole = '{"n":0,"k":"chunk","frames":9600}\n{"n":9600,"k":"chunk","frames":9600}\n';
    expect(splitTruncatedTail(whole)).toEqual({ complete: whole, tail: null, tailLine: null });
    expect(splitTruncatedTail(`${whole}{"n":19200,"k":"ch`)).toEqual({ complete: whole, tail: '{"n":19200,"k":"ch', tailLine: 3 });
    // A whole last line without its newline is complete; so is an empty text.
    expect(splitTruncatedTail(whole.slice(0, -1)).tail).toBeNull();
    expect(splitTruncatedTail('').tail).toBeNull();
    // A file cut inside its first line, with a byte order mark.
    expect(splitTruncatedTail('\ufeff{"n":0')).toEqual({ complete: '', tail: '\ufeff{"n":0', tailLine: 1 });
    // A bad line in the middle is the parser's business, and so is trailing white space.
    const middle = `{"n":0,"k\n${whole}`;
    expect(splitTruncatedTail(middle)).toEqual({ complete: middle, tail: null, tailLine: null });
    expect(splitTruncatedTail(`${whole}  `).tail).toBeNull();
  });

  it('caps a flood of problems with a summary line', () => {
    const text = Array.from({ length: 30 }, () => '{"k":"val","seq":-1,"code":0}').join('\n');
    const parsed = parseJsonl(text, validateDetectorInLine, { file: 'detector_in.jsonl', maxErrors: 5 });
    expect(parsed.errors).toHaveLength(6);
    expect(parsed.errors[5]).toBe('detector_in.jsonl: ... 25 more problems');
  });

  it('parseJson returns null and the problems for a bad document', () => {
    const bad = parseJson('{"schema":"audio-env/1"', validateStampLine, { file: 'x.json' });
    expect(bad.value).toBeNull();
    expect(bad.errors[0]).toMatch(/^x\.json: not valid JSON/);
  });
});
