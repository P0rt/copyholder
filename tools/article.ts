// npm run article -- <draft.md> <out.md> [--data <name>=<file.json> ...] [--final]
//
// Fills the numbers of the post from the result files, so that no number in it is typed by hand.
// A placeholder is a dotted path in double braces whose first part names a data file, with an
// optional format after a bar: {{confirm.pooled.h1.stops_before_voice.k}},
// {{confirm.pooled.h1.stops_before_voice.wilson95.0|pct}}. A number in a path picks an array item.
// The data file confirm is results/confirm.json unless --data names another; --data adds more.
// Formats: pct (a share 0..1 as a whole percent, "35%"), pct1 (one decimal), int, d1, d2 (fixed
// decimals), p (a p-value with its sign, two significant digits: "p = 0.031", "p < 0.001"), short
// (first 8 characters).
// A placeholder whose first part names no data file (a sentence or a link written by hand) is left
// as it is. A path that is missing or null, or that ends on an object, refuses: nothing is written
// and every such path is listed. --final also refuses while any double brace or HTML comment is
// left, which is the last check before the post is published.
// Exit codes: 0 written, 1 refused, 2 usage.

import fs from 'node:fs';
import path from 'node:path';
import { isMainModule } from '../analysis/lib/cli.ts';
import { REPO_ROOT } from '../analysis/lib/paths.ts';

export const USAGE = 'usage: npm run article -- <draft.md> <out.md> [--data <name>=<file.json> ...] [--final]';

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w-]*)((?:\.[\w-]+)*)\s*(?:\|\s*([a-z0-9]+)\s*)?\}\}/g;

export const FORMATS = ['pct', 'pct1', 'int', 'd1', 'd2', 'p', 'short'] as const;
type Format = (typeof FORMATS)[number];

/** One value as the post prints it; a string is an error message. */
export function formatValue(v: unknown, fmt: string | undefined): { text: string } | { error: string } {
  if (v === undefined) return { error: 'missing' };
  if (v === null) return { error: 'null' };
  if (typeof v === 'object') return { error: Array.isArray(v) ? 'an array, not a value' : 'an object, not a value' };
  if (fmt === undefined) return { text: String(v) };
  if (!(FORMATS as readonly string[]).includes(fmt)) return { error: `unknown format ${fmt}` };
  const f = fmt as Format;
  if (f === 'short') return { text: String(v).slice(0, 8) };
  if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `format ${f} needs a finite number, not ${JSON.stringify(v)}` };
  switch (f) {
    case 'pct':
      return { text: `${Math.round(v * 100)}%` };
    case 'pct1':
      return { text: `${(v * 100).toFixed(1)}%` };
    case 'int':
      return { text: String(Math.round(v)) };
    case 'd1':
      return { text: v.toFixed(1) };
    case 'd2':
      return { text: v.toFixed(2) };
    case 'p':
      return { text: v < 0.001 ? 'p < 0.001' : `p = ${Number(v.toPrecision(2))}` };
  }
}

/** The value at a dotted path; undefined when any step is missing. */
export function valueAt(root: unknown, steps: readonly string[]): unknown {
  let cur: unknown = root;
  for (const s of steps) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(s)) return undefined;
      cur = cur[Number(s)];
    } else {
      if (!Object.hasOwn(cur, s)) return undefined;
      cur = (cur as Record<string, unknown>)[s];
    }
  }
  return cur;
}

export interface FillResult {
  text: string;
  filled: number;
  /** "confirm.pooled.x: missing", one per placeholder that could not be filled. */
  problems: string[];
}

/** Fills every placeholder whose first part names a data file; leaves the others. */
export function fillText(draft: string, data: Readonly<Record<string, unknown>>): FillResult {
  const problems: string[] = [];
  let filled = 0;
  const text = draft.replace(PLACEHOLDER, (whole, name: string, dotted: string, fmt: string | undefined) => {
    if (!Object.hasOwn(data, name)) return whole;
    const steps = dotted === '' ? [] : dotted.slice(1).split('.');
    const shown = `${name}${dotted}${fmt === undefined ? '' : `|${fmt}`}`;
    const r = formatValue(valueAt(data[name], steps), fmt);
    if ('error' in r) {
      problems.push(`${shown}: ${r.error}`);
      return whole;
    }
    filled++;
    return r.text;
  });
  return { text, filled, problems };
}

/** What --final refuses: double braces and HTML comments left in the text, with line numbers. */
export function leftovers(text: string): string[] {
  const out: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.includes('{{')) out.push(`line ${i + 1}: a placeholder is left: ${line.trim().slice(0, 100)}`);
    if (line.includes('<!--')) out.push(`line ${i + 1}: a comment is left: ${line.trim().slice(0, 100)}`);
  });
  return out;
}

export interface ArticleArgs {
  draft: string;
  out: string;
  data: Record<string, string>;
  final: boolean;
}

export function parseArgs(argv: readonly string[], root: string = REPO_ROOT): ArticleArgs | null {
  const files: string[] = [];
  const data: Record<string, string> = { confirm: path.join(root, 'results', 'confirm.json') };
  let final = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--final') final = true;
    else if (a === '--data') {
      const v = argv[++i];
      const m = v === undefined ? null : /^([A-Za-z_][\w-]*)=(.+)$/.exec(v);
      if (m === null) return null;
      data[m[1]!] = path.resolve(m[2]!);
    } else if (a.startsWith('-')) return null;
    else files.push(a);
  }
  if (files.length !== 2) return null;
  return { draft: path.resolve(files[0]!), out: path.resolve(files[1]!), data, final };
}

export function main(argv: readonly string[], out: (l: string) => void = (l) => process.stdout.write(`${l}\n`), err: (l: string) => void = (l) => process.stderr.write(`${l}\n`)): number {
  const args = parseArgs(argv);
  if (args === null) {
    err(USAGE);
    return 2;
  }
  if (path.resolve(args.draft) === path.resolve(args.out)) {
    err('article refused: the output would overwrite the draft');
    return 1;
  }
  const data: Record<string, unknown> = {};
  for (const [name, file] of Object.entries(args.data)) {
    try {
      data[name] = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      err(`article refused: data ${name} (${file}): ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  let draft: string;
  try {
    draft = fs.readFileSync(args.draft, 'utf8');
  } catch (e) {
    err(`article refused: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const r = fillText(draft, data);
  const problems = [...r.problems, ...(args.final ? leftovers(r.text) : [])];
  if (problems.length > 0) {
    err(`article refused, nothing written: ${problems.length} problem(s)`);
    for (const p of problems) err(`  ${p}`);
    return 1;
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, r.text);
  out(`article: ${r.filled} value(s) filled from ${Object.keys(args.data).join(', ')}; wrote ${args.out}`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
