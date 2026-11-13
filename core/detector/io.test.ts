import { describe, expect, it } from 'vitest';
import { formatDetectorInLine, nArrMapFromStamps, parseDetectorIn, parseDetectorInLine, parseStream } from './io.ts';

// The detector_in.jsonl and stamps.jsonl examples of spec 8.1.
const DETECTOR_IN = [
  '{"k":"batch","seq":5417,"tr":[[1794935111123456,-0.4000000059604645]],"talk":[[1794935111123456,0]],"g":0.031746031746031744,"hm":0.0021}',
  '{"k":"val","seq":5418,"code":0}',
  '{"k":"voice","n":8659200,"on":true}',
  '{"k":"state","n":8659200,"s":"listening"}',
];

const STAMPS = [
  { n: 0, k: 'chunk', frames: 9600 },
  { n: 384000, k: 'click', i: 3 },
  { n: 8640000, k: 'arr', seq: 5417 },
  { n: 8640000, k: 'hold', cause: 'chest', seq: 5417, nSilent: 8640384, word: 57 },
  { n: 8641000, k: 'arr', seq: 5417 },
  { n: 8642000, k: 'arr', seq: 5418 },
];

describe('detector_in.jsonl (spec 8.1)', () => {
  it('reads the spec examples and writes them back unchanged', () => {
    const inputs = parseDetectorIn(DETECTOR_IN.join('\n') + '\n\n');
    expect(inputs.map((r) => r.k)).toEqual(['batch', 'val', 'voice', 'state']);
    expect(inputs.map(formatDetectorInLine)).toEqual(DETECTOR_IN);
    const b = inputs[0]!;
    if (b.k !== 'batch') throw new Error('expected a batch');
    // Values come back exactly as written: no rounding (spec 8.1).
    expect(b.tr[0]![1]).toBe(-0.4000000059604645);
    expect(b.g).toBe(0.031746031746031744);
  });

  it('keeps g and hm null on a reset frame and drops unknown fields', () => {
    const r = parseDetectorInLine('{"k":"batch","seq":1,"tr":[],"g":null,"hm":null,"lm":{"p":[[1,2]]}}');
    expect(r).toEqual({ k: 'batch', seq: 1, tr: [], g: null, hm: null });
  });

  it('rejects malformed lines with the reason', () => {
    expect(() => parseDetectorInLine('{"k":"batch"')).toThrow(/not JSON/);
    expect(() => parseDetectorInLine('[1,2]')).toThrow(/not an object/);
    expect(() => parseDetectorInLine('{"k":"m","seq":1}')).toThrow(/unknown k/);
    expect(() => parseDetectorInLine('{"k":"batch","tr":[]}')).toThrow(/seq/);
    expect(() => parseDetectorInLine('{"k":"batch","seq":1,"tr":[[1]]}')).toThrow(/tr/);
    expect(() => parseDetectorInLine('{"k":"batch","seq":1,"tr":[],"talk":[1]}')).toThrow(/talk/);
    expect(() => parseDetectorInLine('{"k":"batch","seq":1,"tr":[],"g":"x"}')).toThrow(/g must be/);
    expect(() => parseDetectorInLine('{"k":"val","seq":1}')).toThrow(/code/);
    expect(() => parseDetectorInLine('{"k":"voice","n":1,"on":1}')).toThrow(/voice/);
    expect(() => parseDetectorInLine('{"k":"state","n":1}')).toThrow(/state/);
  });
});

describe('arrival samples', () => {
  it('maps seq to nArr from stamps.jsonl arr lines; the first stamp of a seq wins', () => {
    const m = nArrMapFromStamps(STAMPS);
    expect([...m]).toEqual([
      [5417, 8640000],
      [5418, 8642000],
    ]);
  });

  it('reads stream.jsonl: detector inputs plus the nArr of each packet (spec 8.7)', () => {
    const text = [
      '{"k":"batch","seq":7,"nArr":96000,"tr":[[1794935111123456,0.5]],"talk":[],"g":null,"hm":null}',
      '{"k":"batch","seq":8,"nArr":null,"tr":[[1794935111156789,0.6]],"talk":[],"g":null,"hm":null}',
      '{"k":"val","seq":9,"nArr":97536,"code":1}',
      '{"k":"voice","n":98000,"on":true}',
      '',
    ].join('\n');
    const { inputs, nArrBySeq } = parseStream(text);
    expect(inputs.map((r) => r.k)).toEqual(['batch', 'batch', 'val', 'voice']);
    expect(inputs[0]).toEqual({ k: 'batch', seq: 7, tr: [[1794935111123456, 0.5]], talk: [], g: null, hm: null });
    expect([...nArrBySeq]).toEqual([
      [7, 96000],
      [9, 97536],
    ]);
    expect(() => parseStream('{"k":"batch","seq":1,"nArr":"x","tr":[]}')).toThrow(/nArr/);
  });
});
