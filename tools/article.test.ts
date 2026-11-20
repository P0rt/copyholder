// npm run article: the numbers of the post come from the result files, never typed by hand.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fillText, formatValue, leftovers, main, parseArgs, USAGE, valueAt } from './article.ts';

const confirm = {
  pooled: {
    h1: { stops_before_voice: { k: 9, n: 26, share: 0.346154, wilson95: [0.193, 0.536] }, test: { p_value: 0.000213 } },
    lead: { stops_before_voice: { median_ms: 241.5 } },
    h3: { p_holm: 0.5 },
  },
  params: { sha256: 'abcdef0123456789', theta_G: null },
  packs: [{ pack: 'B', counts: { valid: 13 } }, { pack: 'C', counts: { valid: 13 } }],
};

describe('filling the post', () => {
  it('fills dotted paths, array items and formats', () => {
    const r = fillText(
      'Stopped first in {{confirm.pooled.h1.stops_before_voice.k}} of {{ confirm.pooled.h1.stops_before_voice.n }} ({{confirm.pooled.h1.stops_before_voice.share|pct}}, 95% {{confirm.pooled.h1.stops_before_voice.wilson95.0|pct1}} to {{confirm.pooled.h1.stops_before_voice.wilson95.1|pct1}}); {{confirm.pooled.h1.test.p_value|p}}; lead {{confirm.pooled.lead.stops_before_voice.median_ms|int}} ms; pack {{confirm.packs.1.pack}} had {{confirm.packs.1.counts.valid}}; params {{confirm.params.sha256|short}}; Holm {{confirm.pooled.h3.p_holm|p}}.',
      { confirm },
    );
    expect(r.problems).toEqual([]);
    expect(r.filled).toBe(11);
    expect(r.text).toBe('Stopped first in 9 of 26 (35%, 95% 19.3% to 53.6%); p < 0.001; lead 242 ms; pack C had 13; params abcdef01; Holm p = 0.5.');
  });

  it('leaves a placeholder written by hand, and lists every path it cannot fill', () => {
    const r = fillText('{{TITLE}} {{confirm.params.theta_G}} {{confirm.pooled.h2.k}} {{confirm.pooled.h1}} {{confirm.packs.x}} {{confirm.pooled.h1.stops_before_voice.k|zz}} {{confirm.params.sha256|pct}}', { confirm });
    expect(r.text.startsWith('{{TITLE}} {{confirm.params.theta_G}}')).toBe(true);
    expect(r.filled).toBe(0);
    expect(r.problems).toEqual([
      'confirm.params.theta_G: null',
      'confirm.pooled.h2.k: missing',
      'confirm.pooled.h1: an object, not a value',
      'confirm.packs.x: missing',
      'confirm.pooled.h1.stops_before_voice.k|zz: unknown format zz',
      'confirm.params.sha256|pct: format pct needs a finite number, not "abcdef0123456789"',
    ]);
  });

  it('formats p-values with two significant digits and keeps whole numbers whole', () => {
    expect(formatValue(0.0312, 'p')).toEqual({ text: 'p = 0.031' });
    expect(formatValue(1, 'p')).toEqual({ text: 'p = 1' });
    expect(formatValue(0.000999, 'p')).toEqual({ text: 'p < 0.001' });
    expect(formatValue(2.345, 'd2')).toEqual({ text: '2.35' });
    expect(formatValue(14, undefined)).toEqual({ text: '14' });
    expect(formatValue([1], undefined)).toEqual({ error: 'an array, not a value' });
    expect(valueAt({ a: [{ b: 3 }] }, ['a', '0', 'b'])).toBe(3);
    expect(valueAt({ a: 1 }, ['toString'])).toBeUndefined();
  });

  it('finds the placeholders and comments left before publishing', () => {
    expect(leftovers('one\n{{TITLE}}\n<!-- [B] -->\nfine')).toEqual(['line 2: a placeholder is left: {{TITLE}}', 'line 3: a comment is left: <!-- [B] -->']);
  });
});

describe('npm run article', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, text: string): string => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, text);
    return f;
  };
  const data = file('confirm.json', JSON.stringify(confirm));

  it('writes the filled post, and with --final refuses what is left', () => {
    const draft = file('draft.md', '# {{TITLE}}\n\n{{confirm.pooled.h1.stops_before_voice.k}} of {{confirm.pooled.h1.stops_before_voice.n}}\n');
    const out = path.join(dir, 'post.md');
    const lines: string[] = [];
    const errs: string[] = [];
    expect(main([draft, out, '--data', `confirm=${data}`], (l) => lines.push(l), (l) => errs.push(l))).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toBe('# {{TITLE}}\n\n9 of 26\n');
    expect(lines[0]).toMatch(/^article: 2 value\(s\) filled from confirm; wrote /);
    fs.rmSync(out);
    expect(main([draft, out, '--data', `confirm=${data}`, '--final'], () => {}, (l) => errs.push(l))).toBe(1);
    expect(fs.existsSync(out)).toBe(false);
    expect(errs).toEqual(['article refused, nothing written: 1 problem(s)', '  line 1: a placeholder is left: # {{TITLE}}']);
  });

  it('refuses a missing value, a broken data file and a wrong command line', () => {
    const draft = file('draft2.md', '{{confirm.params.theta_G}}\n');
    const out = path.join(dir, 'post2.md');
    const errs: string[] = [];
    expect(main([draft, out, '--data', `confirm=${data}`], () => {}, (l) => errs.push(l))).toBe(1);
    expect(errs.slice(-1)).toEqual(['  confirm.params.theta_G: null']);
    expect(fs.existsSync(out)).toBe(false);
    const broken = file('broken.json', '{');
    expect(main([draft, out, '--data', `confirm=${broken}`], () => {}, (l) => errs.push(l))).toBe(1);
    expect(errs[errs.length - 1]).toMatch(/^article refused: data confirm \(.*broken\.json\): /);
    expect(main([draft, draft, '--data', `confirm=${data}`], () => {}, (l) => errs.push(l))).toBe(1);
    expect(errs[errs.length - 1]).toBe('article refused: the output would overwrite the draft');
    expect(main([draft], () => {}, (l) => errs.push(l))).toBe(2);
    expect(main([draft, out, '--data', 'nonsense'], () => {}, (l) => errs.push(l))).toBe(2);
    expect(errs.slice(-2)).toEqual([USAGE, USAGE]);
    expect(parseArgs(['a.md', 'b.md'], '/repo')?.data).toEqual({ confirm: '/repo/results/confirm.json' });
  });
});
