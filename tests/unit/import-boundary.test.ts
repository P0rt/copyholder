import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Spec 13.4, "import boundary": outside live/ nothing imports the SDK or Electron;
// inside live/ only tap.cjs loads the SDK.
const ROOT = join(import.meta.dirname, '..', '..');
const SKIP = new Set(['node_modules', '.git', 'sessions', 'dist', 'test-results', 'playwright-report']);
const CODE = /\.(c|m)?(j|t)sx?$/;
const SDK = /(require\(\s*|from\s+|import\(\s*)['"]@smartspectra\//;
const ELECTRON = /(require\(\s*|from\s+|import\(\s*)['"]electron['"]/;

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (CODE.test(name)) out.push(p);
  }
  return out;
}

describe('import boundary', () => {
  const files = walk(ROOT, []).map((p) => relative(ROOT, p).split(sep).join('/'));

  it('nothing outside live/ imports the SDK or Electron', () => {
    const bad = files
      .filter((f) => !f.startsWith('live/') && f !== 'tests/unit/import-boundary.test.ts')
      .filter((f) => {
        const src = readFileSync(join(ROOT, f), 'utf8');
        return SDK.test(src) || ELECTRON.test(src);
      });
    expect(bad).toEqual([]);
  });

  it('inside live/ only tap.cjs loads the SDK', () => {
    const bad = files
      .filter((f) => f.startsWith('live/') && f !== 'live/tap.cjs')
      .filter((f) => SDK.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(bad).toEqual([]);
  });
});
