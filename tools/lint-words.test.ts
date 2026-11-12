import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadList, scanText } from './lint-words.ts';

const banned = loadList(join(import.meta.dirname, 'words/banned.txt'));
const allowed = loadList(join(import.meta.dirname, 'words/allow.txt'));

describe('lint:words', () => {
  it('finds banned words case-insensitively as substrings', () => {
    const hits = scanText('This is Accurate.\nWe are Monitoring you.', banned, allowed);
    expect(hits.map((h) => h.word)).toEqual(['accurate', 'monitoring']);
    expect(hits.map((h) => h.line)).toEqual([1, 2]);
  });

  it('exempts only the exact allowed phrases', () => {
    expect(scanText('Error kAuthenticationFailed: check the key.', banned, allowed)).toEqual([]);
    expect(scanText('We compare against ground truth.', banned, allowed)).toEqual([]);
    expect(scanText('The truth is out there.', banned, allowed)).toHaveLength(1);
    expect(scanText('authentication failed', banned, allowed)).toHaveLength(1);
  });

  it('accepts the consent screen disclaimer verbatim', () => {
    const text =
      'SDK metrics are offered for general wellness and informational purposes only. SDK metrics have not been cleared by the FDA and may not be used for medical diagnosis or treatment.';
    expect(scanText(text, banned, allowed)).toEqual([]);
  });
});
