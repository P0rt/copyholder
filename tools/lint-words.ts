// lint:words (spec 13.6): banned words in public texts and interface strings.
// Substring match, case-insensitive. Exact phrases in tools/words/allow.txt are exempt.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

export function loadList(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

export interface Hit {
  file: string;
  line: number;
  word: string;
  text: string;
}

export function scanText(text: string, banned: string[], allowed: string[], file = '<text>'): Hit[] {
  const hits: Hit[] = [];
  const lines = text.split('\n');
  lines.forEach((raw, i) => {
    let line = raw;
    for (const phrase of allowed) {
      while (line.includes(phrase)) line = line.replace(phrase, ' '.repeat(phrase.length));
    }
    const lower = line.toLowerCase();
    for (const word of banned) {
      if (lower.includes(word.toLowerCase())) hits.push({ file, line: i + 1, word, text: raw.trim() });
    }
  });
  return hits;
}

// Files the spec lists: README, PRIVACY.md, TERMS.md, article/, docs/, interface strings, video captions.
// PREREG.md is public too, so it is checked as well.
const TOP_FILES = ['README.md', 'PRIVACY.md', 'TERMS.md', 'PREREG.md'];
const DIRS = ['article', 'docs', 'web/ui', 'web/scenarios', 'video/captions'];
const WEB_FILES = ['web/index.html', 'web/main.ts'];
const EXT = /\.(md|txt|html|ts|json|srt|vtt)$/;

function walk(dir: string, out: string[]): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

export function targetFiles(root = ROOT): string[] {
  const files: string[] = [];
  for (const f of [...TOP_FILES, ...WEB_FILES]) if (existsSync(join(root, f))) files.push(join(root, f));
  for (const d of DIRS) walk(join(root, d), files);
  return files;
}

function main(): void {
  const banned = loadList(join(ROOT, 'tools/words/banned.txt'));
  const allowed = loadList(join(ROOT, 'tools/words/allow.txt'));
  const hits: Hit[] = [];
  const files = targetFiles();
  for (const f of files) {
    const rel = relative(ROOT, f).split(sep).join('/');
    hits.push(...scanText(readFileSync(f, 'utf8'), banned, allowed, rel));
  }
  for (const h of hits) console.log(`${h.file}:${h.line}: "${h.word}" in: ${h.text.slice(0, 120)}`);
  if (hits.length > 0) {
    console.log(`lint:words: ${hits.length} banned word(s) in ${files.length} files`);
    process.exit(1);
  }
  console.log(`lint:words: OK, ${files.length} files checked`);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) main();
