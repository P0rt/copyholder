// The tag gate-retune beyond params/retune.json (PREREG.md section 11): "npm run freeze --
// gate-retune freezes them together with the pooled analysis code below, and the tag is pushed
// before pack B is recorded". The pooled analysis code is every module npm run confirm loads: the
// import closure of analysis/confirm.ts inside the repository, test files aside, found by following
// its imports, so stage B's scoring (analysis/gate), analysis/lib and the core modules are in it.
// npm run confirm compares each of those files byte for byte with its copy under the tag, and the
// time git gives the tag with the start of each recording of pack B and C. A difference does not
// stop the numbers: they are computed and marked not confirmatory, with the reasons. The push
// itself leaves no time in the clone; the tag's own time stands for it.

import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../lib/paths.ts';
import { RETUNE_TAG } from '../gate/frozen.ts';
import type { ConfirmDeps } from './deps.ts';

/** The entry module of npm run confirm, as a repository path. */
export const CONFIRM_ENTRY = 'analysis/confirm.ts';

// ---- the modules of a source file ------------------------------------------------------------

/** A token of the module scan: a name, the value of a string literal, a punctuation character, or anything else. */
export interface ScanToken {
  kind: 'name' | 'string' | 'punct' | 'other';
  text: string;
}

const NAME_START = /[A-Za-z_$]/;
const NAME_PART = /[A-Za-z0-9_$]/;
/** Names after which a slash starts a regular expression literal, not a division. */
const REGEX_AFTER_NAMES = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
/** Punctuation after which a slash starts a regular expression literal, not a division. */
const REGEX_AFTER_PUNCT = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/**
 * The tokens of a TypeScript or JavaScript source that the module scan needs: names, the values of
 * string literals and of template literals without substitutions, and punctuation. Comments are
 * skipped; numbers and regular expression literals become 'other'; the code inside a template
 * substitution is scanned as code, and a template with substitutions becomes a '`' token. A quoted
 * string or a regular expression literal ends at the end of its line at the latest, so a slash
 * taken for the wrong one spoils one line, never the rest of the file.
 */
export function scanTokens(text: string): ScanToken[] {
  const out: ScanToken[] = [];
  const n = text.length;
  /** For each template literal whose substitution is being scanned, the brace depth outside it. */
  const templates: number[] = [];
  let depth = 0;
  let i = text.startsWith('#!') ? text.indexOf('\n') + 1 || n : 0;

  const regexMayStart = (): boolean => {
    const p = out[out.length - 1];
    if (p === undefined) return true;
    if (p.kind === 'name') return REGEX_AFTER_NAMES.has(p.text);
    if (p.kind === 'punct') return REGEX_AFTER_PUNCT.has(p.text);
    return false;
  };

  /**
   * Scans template text from `from` up to its closing backtick or its next substitution. Returns
   * the index after the backtick or after '${', whether a substitution follows, and the text.
   */
  const templateText = (from: number): { end: number; substitution: boolean; value: string } => {
    let value = '';
    let j = from;
    while (j < n) {
      const c = text[j]!;
      if (c === '\\') {
        value += text[j + 1] ?? '';
        j += 2;
      } else if (c === '`') {
        return { end: j + 1, substitution: false, value };
      } else if (c === '$' && text[j + 1] === '{') {
        return { end: j + 2, substitution: true, value };
      } else {
        value += c;
        j += 1;
      }
    }
    return { end: n, substitution: false, value };
  };

  /** After the opening '${' of a substitution: the code inside it is scanned next. */
  const enterSubstitution = (): void => {
    templates.push(depth);
    depth = 0;
  };

  while (i < n) {
    const c = text[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === ' ' || c === '﻿') {
      i += 1;
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? n : end;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === "'" || c === '"') {
      let value = '';
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') {
        if (text[j] === '\\') {
          value += text[j + 1] ?? '';
          j += 2;
        } else {
          value += text[j];
          j += 1;
        }
      }
      out.push({ kind: 'string', text: value });
      i = j < n && text[j] === c ? j + 1 : j;
    } else if (c === '`') {
      const t = templateText(i + 1);
      i = t.end;
      if (t.substitution) {
        out.push({ kind: 'punct', text: '`' });
        enterSubstitution();
      } else {
        out.push({ kind: 'string', text: t.value });
      }
    } else if (c === '}' && templates.length > 0 && depth === 0) {
      // The end of a substitution: the template goes on.
      depth = templates.pop()!;
      const t = templateText(i + 1);
      i = t.end;
      if (t.substitution) enterSubstitution();
      else out.push({ kind: 'punct', text: '`' });
    } else if (c === '/' && regexMayStart()) {
      // A regular expression literal up to its closing slash outside a class, on this line.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && text[j] !== '\n') {
        const d = text[j]!;
        if (d === '\\') j += 2;
        else {
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) {
            closed = true;
            break;
          }
          j += 1;
        }
      }
      if (closed) {
        j += 1;
        while (j < n && NAME_PART.test(text[j]!)) j += 1;
        out.push({ kind: 'other', text: text.slice(i, j) });
        i = j;
      } else {
        out.push({ kind: 'punct', text: '/' });
        i += 1;
      }
    } else if (NAME_START.test(c)) {
      let j = i + 1;
      while (j < n && NAME_PART.test(text[j]!)) j += 1;
      out.push({ kind: 'name', text: text.slice(i, j) });
      i = j;
    } else if (c >= '0' && c <= '9') {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(text[j]!)) j += 1;
      out.push({ kind: 'other', text: text.slice(i, j) });
      i = j;
    } else {
      if (c === '{') depth += 1;
      else if (c === '}') depth = Math.max(0, depth - 1);
      out.push({ kind: 'punct', text: c });
      i += 1;
    }
  }
  return out;
}

/**
 * The module specifiers a source names, each once, in order: import and export declarations
 * (`import x from`, `import './a.ts'`, `import type`, `export * from`, `export * as x from`,
 * `export { x } from`, `export type { X } from`), `import x = require(...)`, and `import(...)` with
 * a string; with `requires` (a .cjs file) also `require(...)` with a string.
 */
export function moduleSpecifiers(text: string, requires = false): string[] {
  const t = scanTokens(text);
  const out = new Set<string>();
  const is = (k: number, kind: ScanToken['kind'], value?: string): boolean => {
    const x = t[k];
    return x !== undefined && x.kind === kind && (value === undefined || x.text === value);
  };
  /** The specifier after an import or export clause that starts at token `k`: names, braces, commas and stars up to `from '<specifier>'`. */
  const clauseFrom = (k: number): string | null => {
    for (let j = k; j < t.length; j++) {
      if (is(j, 'name', 'from') && is(j + 1, 'string')) return t[j + 1]!.text;
      if (is(j, 'name') || is(j, 'punct', '{') || is(j, 'punct', '}') || is(j, 'punct', ',') || is(j, 'punct', '*')) continue;
      return null;
    }
    return null;
  };
  /** `require('<specifier>')` at token `k`, or null. */
  const requireAt = (k: number): string | null =>
    is(k, 'name', 'require') && is(k + 1, 'punct', '(') && is(k + 2, 'string') && is(k + 3, 'punct', ')') ? t[k + 2]!.text : null;

  for (let k = 0; k < t.length; k++) {
    if (t[k]!.kind !== 'name' || is(k - 1, 'punct', '.')) continue;
    const word = t[k]!.text;
    if (word === 'import') {
      if (is(k + 1, 'punct', '(')) {
        // import('./a.ts'), or with options: import('./a.json', { with: { type: 'json' } })
        if (is(k + 2, 'string') && (is(k + 3, 'punct', ')') || is(k + 3, 'punct', ','))) out.add(t[k + 2]!.text);
      } else if (is(k + 1, 'string')) {
        out.add(t[k + 1]!.text);
      } else if (!is(k + 1, 'punct', '.')) {
        const spec = clauseFrom(k + 1);
        if (spec !== null) out.add(spec);
        // import x = require('./a.ts') and import type x = require('./a.ts')
        const at = is(k + 1, 'name', 'type') && is(k + 2, 'name') ? k + 2 : k + 1;
        if (is(at, 'name') && is(at + 1, 'punct', '=')) {
          const req = requireAt(at + 2);
          if (req !== null) out.add(req);
        }
      }
    } else if (word === 'export') {
      if (is(k + 1, 'punct', '*') || is(k + 1, 'punct', '{') || (is(k + 1, 'name', 'type') && (is(k + 2, 'punct', '{') || is(k + 2, 'punct', '*')))) {
        const spec = clauseFrom(k + 1);
        if (spec !== null) out.add(spec);
      }
    } else if (requires && word === 'require') {
      const req = requireAt(k);
      if (req !== null) out.add(req);
    }
  }
  return [...out];
}

// ---- the import closure ---------------------------------------------------------------------

/** Extensions tried after a specifier that names no file as it is. */
const RESOLVE_EXTENSIONS = ['.ts', '.cjs', '.mjs', '.js', '.json'];
/** Files whose imports are followed; a .json file imports nothing. */
const SOURCE_FILE = /\.(ts|cjs|mjs|js)$/;
/** Test files, which npm run confirm never loads. */
const TEST_FILE = /\.test\.ts$/;

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The existing file a relative specifier of `from` names: the path as it is, the path with one of
 * .ts, .cjs, .mjs, .js and .json, a .js name for its .ts source, or an index file of a folder.
 * Null when there is none.
 */
export function resolveSpecifier(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec);
  const candidates = [base, ...RESOLVE_EXTENSIONS.map((e) => base + e)];
  const js = /\.(c|m)?js$/.exec(base);
  if (js !== null) candidates.push(`${base.slice(0, -js[0].length)}.${js[1] ?? ''}ts`);
  candidates.push(...RESOLVE_EXTENSIONS.map((e) => path.join(base, `index${e}`)));
  return candidates.find(isFile) ?? null;
}

/** A relative specifier: one that names a file of the repository, not node: or a package. */
function isRelative(spec: string): boolean {
  return spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../');
}

/** `file` as a repository path with forward slashes; null when it lies outside `root` or in node_modules. */
function inRepository(file: string, root: string): string | null {
  const rel = path.relative(root, file);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  return parts.includes('node_modules') ? null : parts.join('/');
}

/**
 * The import closure of `entry` (a repository path) in the repository at `root`: the entry and
 * every file it reaches through static relative specifiers of import and export declarations,
 * import() with a string, and require() with a string in .cjs files, each resolved to an existing
 * file (resolveSpecifier). node: and package specifiers, files outside the repository or in
 * node_modules, and test files (*.test.ts) are left out. Repository paths, sorted.
 */
export function importClosure(entry: string, root: string = REPO_ROOT): string[] {
  const seen = new Map<string, string>();
  const queue = [path.resolve(root, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const rel = inRepository(file, root);
    if (rel === null) continue;
    seen.set(file, rel);
    if (!SOURCE_FILE.test(file)) continue;
    for (const spec of moduleSpecifiers(fs.readFileSync(file, 'utf8'), file.endsWith('.cjs'))) {
      if (!isRelative(spec)) continue;
      const target = resolveSpecifier(file, spec);
      if (target === null || TEST_FILE.test(target) || seen.has(target)) continue;
      queue.push(target);
    }
  }
  return [...seen.values()].sort();
}

/** The pooled analysis code that gate-retune freezes: every module npm run confirm loads (importClosure of analysis/confirm.ts). */
export function confirmCodeFiles(root: string = REPO_ROOT): string[] {
  return importClosure(CONFIRM_ENTRY, root);
}

/** Each file (a repository path) that is not under the tag, or differs from its copy there byte for byte; empty when all match. */
export function codeDifferences(files: readonly string[], tagBytes: ConfirmDeps['tagBytes'], root: string = REPO_ROOT): string[] {
  const out: string[] = [];
  for (const file of files) {
    const tagged = tagBytes(RETUNE_TAG, file);
    if (tagged === null) out.push(`${file} is not under the tag ${RETUNE_TAG}`);
    else if (!tagged.equals(fs.readFileSync(path.join(root, ...file.split('/'))))) out.push(`${file} differs from its copy under the tag ${RETUNE_TAG}`);
  }
  return out;
}

// ---- the tag before the recordings ------------------------------------------------------------

/** A recording of pack B or C, by its start (manifest.json started_utc). */
export interface RecordingStart {
  pack: string;
  id: string;
  startedUtc: string;
}

export interface RetuneTagFacts {
  tag: string;
  /** When git says the tag was made; null when it could not be read. */
  tagTime: string | null;
  recordings: RecordingStart[];
  /** The pooled analysis code compared with the tag, as repository paths: every module npm run confirm loads. */
  codeFiles: string[];
  codeDifferences: string[];
  /** Why the numbers are not confirmatory; empty when they are. */
  problems: string[];
}

/**
 * The conditions of section 11 on the tag gate-retune that params/retune.json alone does not show:
 * the pooled analysis code, every module npm run confirm loads, is the copy under the tag, and the
 * tag came before each recording.
 */
export function retuneTagFacts(recordings: readonly RecordingStart[], deps: Pick<ConfirmDeps, 'tagBytes' | 'tagTime'>, root: string = REPO_ROOT): RetuneTagFacts {
  const files = confirmCodeFiles(root);
  const differences = codeDifferences(files, deps.tagBytes, root);
  const code = `the pooled analysis code (${files.length === 1 ? '1 file' : `${files.length} files`}, every module npm run confirm loads)`;
  const problems = differences.map((d) => `${code} is not the code frozen with the parameters: ${d}`);
  const tagTime = deps.tagTime(RETUNE_TAG);
  if (tagTime === null) {
    problems.push(`the time of the tag ${RETUNE_TAG} could not be read from git, so it is not shown to come before the recordings`);
  } else {
    for (const r of recordings) {
      if (!(Date.parse(tagTime) < Date.parse(r.startedUtc))) {
        problems.push(`the tag ${RETUNE_TAG} (${tagTime}) is not earlier than the start of pack ${r.pack} (${r.id}) at ${r.startedUtc}: the parameters were not frozen before that pack was recorded`);
      }
    }
  }
  return { tag: RETUNE_TAG, tagTime, recordings: [...recordings], codeFiles: files, codeDifferences: differences, problems };
}
