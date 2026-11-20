// The pooled analysis code that the tag gate-retune freezes (PREREG.md section 11): every module
// npm run confirm loads, found by following its imports, test files aside, and compared byte for
// byte with its copy under the tag. The module scan on sources, the import closure on a folder of
// its own, and the comparison in a temporary git repository with a tag made as npm run freeze makes
// it (annotated).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTempRepo, type TempRepo } from '../../tools/freeze/test-repo.ts';
import { gitTagBytes, gitTagTime } from './deps.ts';
import { CONFIRM_ENTRY, codeDifferences, importClosure, moduleSpecifiers, resolveSpecifier, retuneTagFacts } from './tag.ts';

describe('the modules a source names', () => {
  it('reads every form of import and export declaration, import() with a string, and import x = require()', () => {
    const text = [
      "import a from './a.ts';",
      "import { b, c as d } from './b.ts';",
      "import * as e from './e.ts';",
      "import type { F } from './f.ts';",
      "import './side.ts';",
      "import g, { h } from './g.ts';",
      "import data from './data.json' with { type: 'json' };",
      "export * from './star.ts';",
      "export * as ns from './ns.ts';",
      "export { x } from './x.ts';",
      "export { y as z, default as w } from './y.ts';",
      "export type { T } from './t.ts';",
      "export type * from './tstar.ts';",
      "const m = await import('./dyn.ts');",
      "const j = await import('./dyn.json', { with: { type: 'json' } });",
      'const k = `${await import("./in-substitution.ts")}`;',
      'import fs from "node:fs";',
      "import l = require('./l.ts');",
      "import type n = require('./n.ts');",
      "import again from './a.ts';",
    ].join('\n');
    expect(moduleSpecifiers(text)).toEqual([
      './a.ts',
      './b.ts',
      './e.ts',
      './f.ts',
      './side.ts',
      './g.ts',
      './data.json',
      './star.ts',
      './ns.ts',
      './x.ts',
      './y.ts',
      './t.ts',
      './tstar.ts',
      './dyn.ts',
      './dyn.json',
      './in-substitution.ts',
      'node:fs',
      './l.ts',
      './n.ts',
    ]);
  });

  it('skips what only looks like an import: comments, strings, template text, regular expressions, methods, and require() outside .cjs files', () => {
    const text = [
      '#!/usr/bin/env node',
      "// import a from './line-comment.ts';",
      "/* export * from './block-comment.ts'; */",
      'const s = "import b from \'./string.ts\'";',
      "const t = `import c from './template.ts'`;",
      "const u = `${x} import('./template-tail.ts')`;",
      "const re = /import d from '.\\/regex.ts'/g;",
      "const ratio = total / count / 2; // import e from './after-division.ts'",
      "obj.import('./method.ts');",
      "const v = require('./require.ts');",
      'const w = import(name);',
      "import real from './real.ts';",
    ].join('\n');
    expect(moduleSpecifiers(text)).toEqual(['./real.ts']);
    expect(moduleSpecifiers("const a = require('./a.cjs');\nconst b = require(name);\nconst c = require('./c.cjs' + suffix);", true)).toEqual(['./a.cjs']);
  });
});

describe('the import closure of an entry module', () => {
  /** A folder holding the repository `root` and a file outside it. */
  let base: string;
  let root: string;

  /** Writes a file of the folder `root`. */
  const put = (rel: string, text: string): void => {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-closure-'));
    root = path.join(base, 'repo');
    fs.writeFileSync(path.join(base, 'outside.ts'), 'export default 1;\n');
    put(
      'analysis/main.ts',
      [
        "import { a } from './lib/a.ts';",
        "import type { T } from './types.ts';",
        "export * from './re.ts';",
        "import fs from 'node:fs';",
        "import pkg from 'pkg';",
        "import './lib/a.test.ts';",
        "import data from './data.json' with { type: 'json' };",
        "const d = await import('./dyn.ts');",
        "import outside from '../../outside.ts';",
        "import vendored from '../node_modules/pkg/index.js';",
      ].join('\n'),
    );
    put('analysis/lib/a.ts', "export { b } from './b.js';\n");
    put('analysis/lib/b.ts', "import c from '../c.cjs';\nimport { i } from './sub';\nexport const b = 1;\n");
    put('analysis/lib/sub/index.ts', 'export const i = 1;\n');
    put('analysis/c.cjs', "const d = require('./d.cjs');\nmodule.exports = d;\n");
    put('analysis/d.cjs', 'module.exports = 2;\n');
    put('analysis/types.ts', 'export interface T { x: number }\n');
    put('analysis/re.ts', "export { a } from './lib/a.ts';\n");
    put('analysis/dyn.ts', 'export const d = 1;\n');
    put('analysis/data.json', '{}\n');
    put('analysis/lib/a.test.ts', "import '../never.ts';\n");
    put('analysis/never.ts', 'export {};\n');
    put('analysis/unused.ts', 'export {};\n');
    put('node_modules/pkg/index.js', 'module.exports = 1;\n');
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('follows every import to an existing file, sorted by repository path, and leaves out node:, packages, node_modules, test files and files outside the repository', () => {
    expect(importClosure('analysis/main.ts', root)).toEqual(
      [
        'analysis/c.cjs',
        'analysis/d.cjs',
        'analysis/data.json',
        'analysis/dyn.ts',
        'analysis/lib/a.ts',
        'analysis/lib/b.ts',
        'analysis/lib/sub/index.ts',
        'analysis/main.ts',
        'analysis/re.ts',
        'analysis/types.ts',
      ].sort(),
    );
  });

  it('resolves a specifier as it is, with an extension, a .js name to its .ts source, or a folder to its index file', () => {
    const from = path.join(root, 'analysis', 'lib', 'b.ts');
    expect(resolveSpecifier(from, '../c.cjs')).toBe(path.join(root, 'analysis', 'c.cjs'));
    expect(resolveSpecifier(from, '../dyn')).toBe(path.join(root, 'analysis', 'dyn.ts'));
    expect(resolveSpecifier(from, './a.js')).toBe(path.join(root, 'analysis', 'lib', 'a.ts'));
    expect(resolveSpecifier(from, './sub')).toBe(path.join(root, 'analysis', 'lib', 'sub', 'index.ts'));
    expect(resolveSpecifier(from, './missing.ts')).toBeNull();
  });

  it('finds every module of npm run confirm in this repository, and no test file', () => {
    const files = importClosure(CONFIRM_ENTRY);
    expect(files).toEqual(expect.arrayContaining(['analysis/confirm.ts', 'analysis/confirm/run.ts', 'analysis/gate/score.ts', 'core/detector.ts']));
    expect(files.filter((f) => f.endsWith('.test.ts'))).toEqual([]);
  });
});

describe('the pooled code against its copy under the tag gate-retune, in a git repository', () => {
  let repo: TempRepo;
  /** When the tag was made, as its tagger date. */
  const TAGGED = '2026-11-20T21:00:00Z';
  const tagBytes = (tag: string, file: string): Buffer | null => gitTagBytes(tag, file, repo.work);
  const closure = (): string[] => importClosure(CONFIRM_ENTRY, repo.work);
  const differences = (): string[] => codeDifferences(closure(), tagBytes, repo.work);

  beforeAll(() => {
    repo = makeTempRepo('copyholder-confirm-tag-');
    // analysis/confirm.ts loads run.ts, which loads score.ts: score.ts is reached only through two imports.
    repo.write('analysis/confirm.ts', "import { run } from './confirm/run.ts';\nrun();\n");
    repo.write('analysis/confirm/run.ts', "import { score } from '../gate/score.ts';\nexport function run(): number {\n  return score();\n}\n");
    repo.write('analysis/gate/score.ts', 'export function score(): number {\n  return 1;\n}\n');
    repo.write('analysis/confirm/run.test.ts', "import { run } from './run.ts';\n");
    repo.write('analysis/other.ts', 'export {};\n');
    repo.commitAll('the pooled code');
    // An annotated tag, as npm run freeze makes it, with its tagger date.
    const r = spawnSync('git', ['tag', '-a', 'gate-retune', '-m', 'gate-retune'], { cwd: repo.work, env: { ...repo.env, GIT_COMMITTER_DATE: TAGGED }, encoding: 'utf8' });
    expect(r.status).toBe(0);
  });

  afterAll(() => {
    repo.remove();
  });

  /** Runs `f` with the work tree changed by `change`, then puts every file back as committed. */
  const changed = (change: () => void, f: () => void): void => {
    try {
      change();
      f();
    } finally {
      repo.git(['checkout', '--', '.']);
      repo.git(['clean', '-fdq']);
    }
  };

  it('passes when every module is the copy under the tag, and reads the tag time from git', () => {
    expect(closure()).toEqual(['analysis/confirm.ts', 'analysis/confirm/run.ts', 'analysis/gate/score.ts']);
    expect(differences()).toEqual([]);
    expect(Date.parse(gitTagTime('gate-retune', repo.work) ?? '')).toBe(Date.parse(TAGGED));
    const t = retuneTagFacts([{ pack: 'B', id: 'gate-b', startedUtc: '2026-11-21T09:00:00Z' }], { tagBytes, tagTime: (tag) => gitTagTime(tag, repo.work) }, repo.work);
    expect(t).toMatchObject({ codeFiles: closure(), codeDifferences: [], problems: [] });
  });

  it('catches a change of one byte in a module reached only through two imports', () => {
    changed(
      () => repo.write('analysis/gate/score.ts', 'export function score(): number {\n  return 2;\n}\n'),
      () => {
        expect(differences()).toEqual(['analysis/gate/score.ts differs from its copy under the tag gate-retune']);
        const t = retuneTagFacts([], { tagBytes, tagTime: () => TAGGED }, repo.work);
        expect(t.problems).toEqual([
          'the pooled analysis code (3 files, every module npm run confirm loads) is not the code frozen with the parameters: analysis/gate/score.ts differs from its copy under the tag gate-retune',
        ]);
      },
    );
  });

  it('leaves out a changed test file and a module confirm does not load', () => {
    changed(
      () => {
        repo.write('analysis/confirm/run.test.ts', "import { run } from './run.ts';\nrun();\n");
        repo.write('analysis/confirm/new.test.ts', "import { run } from './run.ts';\n");
        repo.write('analysis/other.ts', 'export const changed = true;\n');
      },
      () => {
        expect(closure()).toEqual(['analysis/confirm.ts', 'analysis/confirm/run.ts', 'analysis/gate/score.ts']);
        expect(differences()).toEqual([]);
      },
    );
  });

  it('catches a new module that confirm imports, which is not under the tag', () => {
    changed(
      () => {
        repo.write('analysis/confirm/extra.ts', 'export const extra = 1;\n');
        repo.write('analysis/confirm/run.ts', "import { score } from '../gate/score.ts';\nimport { extra } from './extra.ts';\nexport function run(): number {\n  return score() + extra;\n}\n");
      },
      () => {
        expect(differences()).toEqual([
          'analysis/confirm/extra.ts is not under the tag gate-retune',
          'analysis/confirm/run.ts differs from its copy under the tag gate-retune',
        ]);
      },
    );
  });

  it('takes every module for not under the tag when the tag is missing', () => {
    expect(codeDifferences(closure(), (_tag, file) => gitTagBytes('no-such-tag', file, repo.work), repo.work)).toEqual(
      closure().map((f) => `${f} is not under the tag gate-retune`),
    );
    expect(gitTagTime('no-such-tag', repo.work)).toBeNull();
  });
});
