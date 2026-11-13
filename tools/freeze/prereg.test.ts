// How the freeze reads PREREG.md (spec 8.4, 9.2): Markdown tables, the cue-list hash table, the
// voice detector rows, APP_COMMIT and the placeholders; also against the repository's own PREREG.md.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './frozen.ts';
import { firstNumber, markdownTables, plainCell, sha256sIn, splitRow } from './md.ts';
import {
  backtickedCommitNames,
  checkCueLists,
  cueHashRows,
  cueListPath,
  listGatePacks,
  packIdOfCell,
  packJsonCue,
  placeholdersLeft,
  preregVadValues,
} from './prereg.ts';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const H = { A: sha('a'), B: sha('b') };

describe('Markdown tables', () => {
  it('reads pipe tables with their line numbers, outside code fences', () => {
    const text = ['# T', '| a | b |', '|---|:--:|', '| 1 | `x` |', '| 2 | y |', '', '```', '| c | d |', '|---|---|', '| 3 | z |', '```', 'no | table'].join('\n');
    const tables = markdownTables(text);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.header).toEqual(['a', 'b']);
    expect(tables[0]!.rows).toEqual([
      { cells: ['1', '`x`'], line: 4 },
      { cells: ['2', 'y'], line: 5 },
    ]);
    expect(splitRow('not a row')).toBeNull();
    expect(plainCell(' **`pack-A`** ')).toBe('pack-A');
  });

  it('finds SHA-256 values and the first number of a cell', () => {
    expect(sha256sIn(`\`${H.A.toUpperCase()}\` ${'f'.repeat(65)} ${H.B}`)).toEqual([H.A, H.B]);
    expect(firstNumber('-58.3 dB, measured by `npm run doctor`')).toBe(-58.3);
    expect(firstNumber('−61.2 dB')).toBe(-61.2);
    expect(firstNumber('0.60 (raised by the in-breath test)')).toBe(0.6);
    expect(firstNumber('-58.3dB')).toBe(-58.3);
    expect(firstNumber('L2 norm, no value')).toBeNull();
  });
});

describe('the cue-list hash table', () => {
  it('takes the rows of the table with a Pack column and a SHA-256 column of the cue list', () => {
    const text = [
      '| Pack | Use |',
      '|---|---|',
      `| A | the gate, ${H.B} |`,
      '',
      '| Pack | SHA-256 of `cues.json` |',
      '|---|---|',
      `| 0 | \`${H.A}\` |`,
      `| **pack-A** | \`${H.B}\` |`,
      '| B | `{{CUES_SHA256_B}}` |',
      '| Total | n/a |',
    ].join('\n');
    expect(cueHashRows(text)).toEqual({
      tables: 1,
      rows: [
        { pack: '0', hashes: [H.A], placeholder: false, line: 7 },
        { pack: 'A', hashes: [H.B], placeholder: false, line: 8 },
        { pack: 'B', hashes: [], placeholder: true, line: 9 },
        { pack: 'Total', hashes: [], placeholder: false, line: 10 },
      ],
    });
    // Without a "cue" header, any Pack table with a SHA-256 column counts.
    expect(cueHashRows(['| Pack | SHA-256 |', '|---|---|', `| A | ${H.A} |`].join('\n')).rows).toEqual([{ pack: 'A', hashes: [H.A], placeholder: false, line: 3 }]);
    expect(cueHashRows('| Name | Value |\n|---|---|\n| A | x |').tables).toBe(0);
  });

  it('reads the pack id of a first cell', () => {
    expect(packIdOfCell('A')).toBe('A');
    expect(packIdOfCell('`pack-0`')).toBe('0');
    expect(packIdOfCell('Pack C')).toBe('C');
    expect(packIdOfCell('A and B')).toBeNull();
  });
});

describe('cue lists in a pack folder', () => {
  let dir: string;
  const write = (rel: string, text: string): void => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  const table = (rows: Record<string, string>): string =>
    ['| Pack | SHA-256 of `cues.json` |', '|---|---|', ...Object.entries(rows).map(([p, h]) => `| ${p} | \`${h}\` |`), ''].join('\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'copyholder-cues-'));
    write('gate/pack-A/cues.json', '[1,2]\n');
    write('gate/level/level.txt', 'not a pack\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('hashes cues.json and compares it with the row and with pack.json as host reads it', () => {
    const actual = sha('[1,2]\n');
    expect(listGatePacks(dir).map((p) => p.id)).toEqual(['A']);
    expect(cueListPath('A')).toBe('gate/pack-A/cues.json');
    expect(checkCueLists(dir, table({ A: actual }))).toEqual({
      problems: [],
      notes: ['gate/pack-A/pack.json does not exist yet: host serves no file of pack A until it does'],
      hashes: [{ path: 'gate/pack-A/cues.json', hash: actual }],
    });
    expect(checkCueLists(dir, table({ A: H.A })).problems).toEqual([`PREREG.md line 3 lists ${H.A} for pack A, but gate/pack-A/cues.json has SHA-256 ${actual}`]);
    expect(checkCueLists(dir, 'no table').problems[0]).toMatch(/PREREG\.md has no cue-list hash table/);

    const [pack] = listGatePacks(dir);
    write('gate/pack-A/pack.json', JSON.stringify({ blocks: [{ name: 'cues.json', sha256: actual }, { file: 'listen.wav' }] }));
    expect(packJsonCue(pack!)).toEqual({ exists: true, listed: true, hash: actual, problem: null });
    expect(checkCueLists(dir, table({ A: actual }))).toMatchObject({ problems: [], notes: [] });
    write('gate/pack-A/pack.json', JSON.stringify({ files: ['listen.wav', 'cues.json'] }));
    expect(checkCueLists(dir, table({ A: actual })).notes).toEqual(['gate/pack-A/pack.json lists cues.json without a SHA-256']);
    write('gate/pack-A/pack.json', JSON.stringify({ files: ['listen.wav'] }));
    expect(checkCueLists(dir, table({ A: actual })).notes[0]).toMatch(/does not list cues\.json: host will not serve the cue list of pack A/);
    write('gate/pack-A/pack.json', '{');
    expect(checkCueLists(dir, table({ A: actual })).problems[0]).toMatch(/gate\/pack-A\/pack\.json is not valid JSON/);
  });

  it('refuses two rows for one pack', () => {
    const actual = sha('[1,2]\n');
    expect(checkCueLists(dir, `${table({ A: actual })}\n${table({ A: actual })}`).problems[0]).toMatch(/has 2 rows for pack A in its cue-list hash table \(lines 3, 7\)/);
  });
});

describe('voice detector rows and APP_COMMIT', () => {
  const vadTable = (floor: string, periodicity: string): string =>
    ['| Parameter | Value |', '|---|---|', '| High-pass, hop | 150 Hz, 5 ms |', `| Noise floor | ${floor} dB, measured by \`npm run doctor\` |`, `| Periodicity threshold | ${periodicity} |`].join('\n');

  it('reads the floor and the threshold of the one table that has both rows', () => {
    expect(preregVadValues(vadTable('-58.3', '0.60'))).toEqual({ floorDb: -58.3, periodicity: 0.6, problems: [] });
    expect(preregVadValues(vadTable('{{VAD_FLOOR_DB}}', '{{VAD_PERIODICITY}}'))).toEqual({ floorDb: null, periodicity: null, problems: [] });
    expect(preregVadValues(vadTable('n/a', '0.5')).problems[0]).toMatch(/the row "Noise floor" holds no number/);
    expect(preregVadValues('| Noise floor | -60 |\n|---|---|').problems[0]).toMatch(/has no voice detector table/);
    expect(preregVadValues(`${vadTable('-1', '0.5')}\n\n${vadTable('-2', '0.5')}`).problems[0]).toMatch(/has 2 tables that look like its voice detector table/);
  });

  it('finds commit names in backticks only', () => {
    expect(backtickedCommitNames('at `1a2b3c4d` and `1a2b3c4d`, not 5e6f7a8b9c, not `xyz1234`, not `' + H.A + '`')).toEqual(['1a2b3c4d']);
  });

  it('ignores the Placeholders section and finds placeholders elsewhere, also in code blocks', () => {
    const text = ['# T', '```sh', '# not a heading {{IN_CODE}}', '```', '## Placeholders', '`{{LISTED}}`', '### Sub', '`{{STILL_LISTED}}`', '## Next', 'x {{LEFT}}'].join('\n');
    expect(placeholdersLeft(text)).toEqual([
      { name: '{{IN_CODE}}', line: 3 },
      { name: '{{LEFT}}', line: 10 },
    ]);
  });
});

// PREREG.md is written in parallel: these check only that the freeze can read its tables.
describe('the repository PREREG.md', () => {
  const prereg = readFileSync(join(REPO_ROOT, 'PREREG.md'), 'utf8');

  it('has one cue-list row for every gate pack folder', () => {
    const { rows, tables } = cueHashRows(prereg);
    expect(tables).toBe(1);
    const packs = listGatePacks(REPO_ROOT).map((p) => p.id);
    expect(packs.length).toBeGreaterThan(0);
    for (const id of packs) expect(rows.filter((r) => r.pack === id), `pack ${id}`).toHaveLength(1);
  });

  it('has the voice detector table the freeze compares with params/frozen.json', () => {
    expect(preregVadValues(prereg).problems).toEqual([]);
  });
});
