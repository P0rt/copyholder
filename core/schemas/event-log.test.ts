// A whole events.jsonl against its record kind (spec 8.1, 10.2, 10.7): which stops and fires
// a kind can have, chest stops after a fire, resumes after a stop.
import { describe, expect, it } from 'vitest';
import { eventLogProblems, parseJsonl, toJsonlLine, toJsonlText, validateEventLine, type EventLine } from './index.ts';
import { exampleEvents } from './examples.ts';

const keyHold: EventLine = { n: 9000000, e: 'hold', cause: 'key', nCmd: 9000000, nSilent: 9000384, word: 12 };
const voiceHold: EventLine = { n: 9100000, e: 'hold', cause: 'voice', nCmd: 9100000, nSilent: 9100384, word: 20 };
const resume: EventLine = { n: 9200000, e: 'resume', word: 20, why: 'timeout' };

describe('eventLogProblems', () => {
  it('a numbers session: fire, chest stop at the same sample, resume, armed (spec 8.1 example)', () => {
    expect(eventLogProblems('numbers', exampleEvents())).toEqual([]);
    expect(eventLogProblems('numbers', [...exampleEvents(), voiceHold, resume])).toEqual([]);
  });

  it('the day-1 gate has no fire, hold or resume lines (spec 8.1)', () => {
    const armedOnly = exampleEvents().filter((e) => e.e === 'armed');
    expect(eventLogProblems('gate', armedOnly)).toEqual([]);
    expect(eventLogProblems('gate', exampleEvents())).toEqual([
      'events.jsonl line 1: no "fire" lines in the day-1 gate: the narrator does not stop there (spec 8.1)',
      'events.jsonl line 2: no "hold" lines in the day-1 gate: the narrator does not stop there (spec 8.1)',
      'events.jsonl line 3: no "resume" lines in the day-1 gate: the narrator does not stop there (spec 8.1)',
    ]);
  });

  it('the space bar stops only in the space-bar block; the listening run only by the audio safety', () => {
    expect(eventLogProblems('spacebar', [keyHold, { ...resume, why: 'voice_off' }, voiceHold, resume])).toEqual([]);
    expect(eventLogProblems('numbers', [keyHold])).toEqual([
      'events.jsonl line 1: a numbers record stops only by chest or voice, not by key (spec 6.4, 10.2, 10.7)',
    ]);
    expect(eventLogProblems('pilot', [voiceHold, resume])).toEqual([]);
    expect(eventLogProblems('pilot', exampleEvents().slice(0, 2))).toEqual([
      'events.jsonl line 1: no live detector in a pilot record, so no "fire" line (spec 10.2, 10.7)',
      'events.jsonl line 2: a pilot record stops only by voice, not by chest (spec 6.4, 10.2, 10.7)',
    ]);
  });

  it('a chest stop needs a fire at its nCmd before it; a resume needs a stop', () => {
    const [fire, hold, res] = exampleEvents();
    if (fire === undefined || hold === undefined || res === undefined) throw new Error('example has 4 lines');
    expect(eventLogProblems('demo', [hold, fire, res])).toEqual([
      'events.jsonl line 1: chest stop at nCmd 8640000 without a detector "fire" line at that sample before it',
    ]);
    expect(eventLogProblems('rehearsal', [res])).toEqual(['events.jsonl line 1: "resume" without a "hold" before it']);
    // A recording that ends during a stop leaves a hold without its resume: allowed.
    expect(eventLogProblems('numbers', [fire, hold])).toEqual([]);
  });

  it('other events never matter here; works on parsed files', () => {
    const lines: EventLine[] = [
      { n: null, e: 'consent', by: 'host', at: '2026-11-17T17:02:11Z' },
      { n: 480000, e: 'preflight_ok' },
      ...exampleEvents(),
      { n: 9000000, e: 'blur' },
    ];
    const parsed = parseJsonl(toJsonlText(lines, 'events.jsonl'), validateEventLine, { file: 'events.jsonl' });
    expect(parsed.errors).toEqual([]);
    expect(eventLogProblems('numbers', parsed.rows)).toEqual([]);
    expect(eventLogProblems('doctor', parsed.rows)).toEqual([]);
  });

  it('names the lines of the file when parseJsonl dropped a broken one', () => {
    const [fire, hold, res] = exampleEvents();
    if (fire === undefined || hold === undefined || res === undefined) throw new Error('example has 4 lines');
    // Line 2 is cut short, so the rows are lines 1, 3 and 4 of the file.
    const text = `${toJsonlLine(res, 'events.jsonl')}\n{"n":12,"e":\n${toJsonlLine(hold, 'events.jsonl')}\n${toJsonlLine(res, 'events.jsonl')}\n`;
    const parsed = parseJsonl(text, validateEventLine, { file: 'events.jsonl' });
    expect(parsed.lineNumbers).toEqual([1, 3, 4]);
    expect(eventLogProblems('numbers', parsed.rows, parsed.lineNumbers)).toEqual([
      'events.jsonl line 1: "resume" without a "hold" before it',
      'events.jsonl line 3: chest stop at nCmd 8640000 without a detector "fire" line at that sample before it',
    ]);
    // Without the line numbers, row k is line k + 1.
    expect(eventLogProblems('numbers', parsed.rows)[1]).toMatch(/^events\.jsonl line 2: chest stop/);
    expect(() => eventLogProblems('numbers', parsed.rows, [1, 3])).toThrow('eventLogProblems: 2 line numbers for 3 events');
  });
});
