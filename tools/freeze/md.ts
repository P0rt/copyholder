// Markdown tables of PREREG.md as the freeze reads them (spec 8.4): pipe tables outside code fences.
// Pure: text in, rows out.

export interface MdRow {
  cells: string[];
  /** Line number in the text, counted from 1. */
  line: number;
}

export interface MdTable {
  header: string[];
  rows: MdRow[];
}

const FENCE = /^\s*(```|~~~)/;
const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const SHA256_IN_TEXT = /(?<![0-9A-Fa-f])[0-9A-Fa-f]{64}(?![0-9A-Fa-f])/g;

/** The cells of a table line (`| a | b |`), trimmed; null for a line that is not a table row. */
export function splitRow(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith('|') || t.length < 2) return null;
  const inner = t.endsWith('|') ? t.slice(1, -1) : t.slice(1);
  return inner.split('|').map((c) => c.trim());
}

/** Every pipe table with a header and a separator line, outside fenced code blocks. */
export function markdownTables(text: string): MdTable[] {
  const lines = text.split('\n');
  const out: MdTable[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const header = splitRow(line);
    const next = lines[i + 1];
    if (header === null || next === undefined || !next.includes('-') || !SEPARATOR.test(next)) continue;
    const rows: MdRow[] = [];
    let j = i + 2;
    for (; j < lines.length; j += 1) {
      const cells = splitRow(lines[j]!);
      if (cells === null) break;
      rows.push({ cells, line: j + 1 });
    }
    out.push({ header, rows });
    i = j - 1;
  }
  return out;
}

/** A cell's text without code, bold or italic marks. */
export function plainCell(cell: string): string {
  return cell.replace(/[`*_]/g, '').trim();
}

/** Lowercase 64-hex values in a text, in order, repeats kept. */
export function sha256sIn(text: string): string[] {
  return Array.from(text.matchAll(SHA256_IN_TEXT), (m) => m[0].toLowerCase());
}

/** True when the text still holds a {{NAME}} placeholder. */
export function hasPlaceholder(text: string): boolean {
  return /\{\{[A-Za-z0-9_]+\}\}/.test(text);
}

/** The first decimal number of a text (a Unicode minus counts as "-"), or null. */
export function firstNumber(text: string): number | null {
  const m = /(?<![\w.])-?\d+(?:\.\d+)?/.exec(text.replace(/−/g, '-'));
  return m ? Number(m[0]) : null;
}
