// The command line of npm run video (spec 13.3, 15.2-15.4): options, wrong usage, the refusals
// that come before ffmpeg runs, and the choice between drawtext and PNG captions.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../analysis/lib/paths.ts';
import { loadList } from '../lint-words.ts';
import { captionMode, findFont, findFontOrNone, NO_DRAWTEXT_HINT, parseCaptionChoice, VideoError } from './ffmpeg.ts';
import type { MatchResult } from './match.ts';
import { cardWordProblems, EXIT_OK, EXIT_REFUSED, EXIT_USAGE, main, matchLines, parseArgs, shownTake, userPath, type VideoArgs } from './run.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-run-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function run(args: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await main(args, { out: (l) => lines.push(l), env: { PATH: process.env['PATH'], COPYHOLDER_SESSIONS_DIR: tmp }, cwd: tmp, progress: false });
  return { code, lines };
}

describe('parseArgs', () => {
  it('reads a session, values in both spellings and switches', () => {
    const a = parseArgs(['headstart-2', '--screen', 'rec.mov', '--take=1/2', '--align-only', '--lrt-ms', '31.5']) as VideoArgs;
    expect(a.session).toBe('headstart-2');
    expect(a.values).toEqual({ screen: 'rec.mov', take: '1/2', 'lrt-ms': '31.5' });
    expect([...a.flags]).toEqual(['align-only']);
  });

  it('takes the clips after --concat up to the next option', () => {
    const a = parseArgs(['--concat', 'cards.mp4', 'take.mp4', 'end.mp4', '--out', 'final.mp4']) as VideoArgs;
    expect(a.concat).toEqual(['cards.mp4', 'take.mp4', 'end.mp4']);
    expect(a.values.out).toBe('final.mp4');
    expect(a.session).toBeNull();
    expect((parseArgs(['--concat=cards.mp4', 'take.mp4']) as VideoArgs).concat).toEqual(['cards.mp4', 'take.mp4']);
  });

  it('tells a bare --concat from no --concat', () => {
    expect((parseArgs(['--concat', '--out', 'final.mp4']) as VideoArgs).concat).toEqual([]);
    expect((parseArgs(['--concat=', '--out', 'final.mp4']) as VideoArgs).concat).toEqual([]);
    expect((parseArgs(['headstart-2', '--screen', 'rec.mov']) as VideoArgs).concat).toBeNull();
  });

  it('reads --captions and --chrome', () => {
    const a = parseArgs(['--cards', 'c.json', '--captions', 'png', '--chrome=/Applications/Google Chrome.app', '--out', 'c.mp4']) as VideoArgs;
    expect(a.values).toEqual({ cards: 'c.json', captions: 'png', chrome: '/Applications/Google Chrome.app', out: 'c.mp4' });
    expect(parseArgs(['x', '--captions'])).toEqual({ error: '--captions needs a value' });
  });

  it('names an unknown option, a missing value and a second session', () => {
    expect(parseArgs(['--speed', '2'])).toEqual({ error: 'Unknown option --speed' });
    expect(parseArgs(['x', '--screen'])).toEqual({ error: '--screen needs a value' });
    expect(parseArgs(['--screen', '--take', '1/2'])).toEqual({ error: '--screen needs a value' });
    expect(parseArgs(['a', 'b'])).toEqual({ error: 'One session at a time: a and b' });
  });

  it('takes ~ as the home folder and other paths from where npm was run', () => {
    expect(userPath('~/Movies/rec.mov', '/repo')).toBe(path.join(os.homedir(), 'Movies/rec.mov'));
    expect(userPath('rec.mov', '/Users/me/Desktop')).toBe('/Users/me/Desktop/rec.mov');
    expect(userPath('/abs/rec.mov', '/x')).toBe('/abs/rec.mov');
  });
});

describe('main', () => {
  it('prints the usage and exits 2 on wrong usage', async () => {
    const bad = await run(['--speed', '2']);
    expect(bad.code).toBe(EXIT_USAGE);
    expect(bad.lines[0]).toBe('Unknown option --speed');
    expect(bad.lines[1]).toMatch(/^Usage:/);
    const two = await run(['headstart-2', '--cards', 'c.json']);
    expect(two.code).toBe(EXIT_USAGE);
    expect(two.lines[0]).toBe('Pick one of: a session with --screen, --cards, or --concat.');
    const help = await run(['--help']);
    expect(help.code).toBe(EXIT_OK);
    expect(help.lines.join('\n')).toContain('The take and the cards: [--captions auto|drawtext|png] [--chrome <path>]');
  });

  it('reads --captions before ffmpeg runs, for the take and for the cards', async () => {
    fs.writeFileSync(path.join(tmp, 'rec.mov'), '');
    fs.writeFileSync(path.join(tmp, 'plain.json'), JSON.stringify([{ text: 'A plain card', seconds: 2 }]));
    // --ffmpeg names no program: a run that reached ffmpeg would say so instead.
    const refused = ['VIDEO DID NOT RUN: --captions chrome: expected auto, drawtext or png'];
    expect((await run(['headstart-2', '--screen', 'rec.mov', '--captions', 'chrome', '--ffmpeg', '/no/such/ffmpeg'])).lines).toEqual(refused);
    expect((await run(['--cards', 'plain.json', '--out', 'cards.mp4', '--captions', 'chrome', '--ffmpeg', '/no/such/ffmpeg'])).lines).toEqual(refused);
  });

  it('needs the screen recording, and a file that exists', async () => {
    const noScreen = await run(['headstart-2']);
    expect(noScreen.code).toBe(EXIT_REFUSED);
    expect(noScreen.lines).toEqual(['VIDEO DID NOT RUN: --screen <recording.mov> is needed: the screen recording of the take (tools/video/README.md)']);
    const missing = await run(['headstart-2', '--screen', 'nothing.mov']);
    expect(missing.lines).toEqual([`VIDEO DID NOT RUN: --screen ${path.join(tmp, 'nothing.mov')}: no such file`]);
    const noTake = await run(['--screen', 'nothing.mov']);
    expect(noTake.lines).toEqual(['VIDEO DID NOT RUN: No session given and no headstart or demo recording found: npm run video -- <session id> --screen <recording.mov>']);
  });

  it('refuses cards with banned words before anything is drawn', async () => {
    const word = loadList(path.join(REPO_ROOT, 'tools', 'words', 'banned.txt')).find((w) => /^[a-z]+$/.test(w)) as string;
    fs.writeFileSync(path.join(tmp, 'cards.json'), JSON.stringify([{ text: `A take\nwith ${word} in it`, seconds: 2 }]));
    const r = await run(['--cards', 'cards.json', '--out', 'cards.mp4']);
    expect(r.code).toBe(EXIT_REFUSED);
    expect(r.lines.join('\n')).toContain(`the cards hold banned words (spec 13.6, 15.6):\n  line 2: "${word}" in: with ${word} in it`);
    expect(cardWordProblems('A live take\nof the app')).toEqual([]);
    const notMp4 = await run(['--cards', 'cards.json', '--out', 'cards.mov']);
    expect(notMp4.lines).toEqual([`VIDEO DID NOT RUN: --out ${path.join(tmp, 'cards.mov')}: the video is written as .mp4`]);
  });

  it('needs two clips to join and will not write over one', async () => {
    fs.writeFileSync(path.join(tmp, 'a.mp4'), '');
    expect((await run(['--concat', 'a.mp4', '--out', 'f.mp4'])).lines).toEqual(['VIDEO DID NOT RUN: --concat needs at least two clips']);
    expect((await run(['--concat', 'a.mp4', 'a.mp4', '--out', 'a.mp4'])).lines).toEqual([`VIDEO DID NOT RUN: --out ${path.join(tmp, 'a.mp4')} would overwrite an input`]);
  });

  it('takes a bare --concat as the joining mode', async () => {
    const bare = await run(['--concat', '--out', 'f.mp4']);
    expect(bare.code).toBe(EXIT_REFUSED);
    expect(bare.lines).toEqual(['VIDEO DID NOT RUN: --concat needs at least two clips']);
    const both = await run(['--concat', '--cards', 'c.json']);
    expect(both.code).toBe(EXIT_USAGE);
    expect(both.lines[0]).toBe('Pick one of: a session with --screen, --cards, or --concat.');
  });

  it('reads --size and --fps of a join before any clip is opened', async () => {
    fs.writeFileSync(path.join(tmp, 'a.mp4'), '');
    fs.writeFileSync(path.join(tmp, 'b.mp4'), '');
    // The clips are empty files: ffprobe would refuse them, so these lines come before it runs.
    expect((await run(['--concat', 'a.mp4', 'b.mp4', '--fps', '2', '--out', 'f.mp4'])).lines).toEqual([
      'VIDEO DID NOT RUN: --fps 2: expected a frame rate from 5 to 240',
    ]);
    expect((await run(['--concat', 'a.mp4', 'b.mp4', '--size', '1919x1080', '--out', 'f.mp4'])).lines).toEqual([
      'VIDEO DID NOT RUN: --size 1919x1080: expected WIDTHxHEIGHT with even numbers, like 1920x1080',
    ]);
  });
});

describe('a run with the mock tap', () => {
  it('is refused without --rehearsal, and any run with it is captioned as a rehearsal', () => {
    expect(() => shownTake({ k: 1, n: 2 }, 'mock', false, 'headstart-4')).toThrow(VideoError);
    expect(() => shownTake(null, 'mock', false, 'headstart-4')).toThrow(/headstart-4 ran with the mock tap.*--rehearsal/);
    expect(shownTake(null, 'mock', true, 'headstart-4')).toEqual({ k: 1, n: 1, rehearsal: true });
    expect(shownTake({ k: 2, n: 3 }, 'real', true, 'headstart-5')).toEqual({ k: 2, n: 3, rehearsal: true });
    expect(shownTake({ k: 2, n: 3 }, 'real', false, 'headstart-5')).toEqual({ k: 2, n: 3 });
    expect(shownTake(null, null, false, 'headstart-5')).toBeNull();
    expect((parseArgs(['--rehearsal']) as VideoArgs).flags.has('rehearsal')).toBe(true);
  });
});

describe('the caption mode', () => {
  it('takes drawtext where the ffmpeg has it and PNG pictures where it does not', () => {
    expect(captionMode('auto', { drawtext: true })).toBe('drawtext');
    expect(captionMode('auto', { drawtext: false })).toBe('png');
    expect(captionMode('drawtext', { drawtext: true })).toBe('drawtext');
    expect(captionMode('png', { drawtext: true })).toBe('png');
    expect(captionMode('png', { drawtext: false })).toBe('png');
  });

  it('refuses --captions drawtext with an ffmpeg without drawtext', () => {
    expect(() => captionMode('drawtext', { drawtext: false })).toThrow(VideoError);
    expect(() => captionMode('drawtext', { drawtext: false })).toThrow(NO_DRAWTEXT_HINT);
    expect(NO_DRAWTEXT_HINT).toContain('--captions png');
  });

  it('reads auto, drawtext and png in any case, and nothing else', () => {
    expect(parseCaptionChoice('auto')).toBe('auto');
    expect(parseCaptionChoice(' PNG ')).toBe('png');
    expect(parseCaptionChoice('DrawText')).toBe('drawtext');
    for (const bad of ['', 'chrome', 'pngs', 'draw text']) expect(parseCaptionChoice(bad)).toBeNull();
  });

  it('finds the font for the pictures, or none, where drawtext needs one', () => {
    const only = (...files: string[]) => (p: string): boolean => files.includes(p);
    const both = only('/System/Library/Fonts/Helvetica.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
    expect(findFontOrNone(undefined, 'darwin', both)).toBe('/System/Library/Fonts/Helvetica.ttc');
    expect(findFontOrNone(undefined, 'linux', both)).toBe('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
    expect(findFont(undefined, 'linux', both)).toBe('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
    // No font file: Chrome takes a sans-serif font of the system; drawtext cannot.
    expect(findFontOrNone(undefined, 'darwin', only())).toBeNull();
    expect(() => findFont(undefined, 'darwin', only())).toThrow(/^No font file found .*--font <file\.ttf>\.$/);
    // A --font that is not there is refused in both modes.
    expect(findFontOrNone('/my/font.ttf', 'linux', only('/my/font.ttf'))).toBe('/my/font.ttf');
    expect(() => findFontOrNone('/my/font.ttf', 'linux', both)).toThrow('--font /my/font.ttf: no such file');
    expect(() => findFont('/my/font.ttf', 'linux', both)).toThrow('--font /my/font.ttf: no such file');
  });
});

describe('matchLines', () => {
  it('prints every click with its flash and residual', () => {
    const m: MatchResult = {
      offsetS: 7.3217,
      pairs: [
        { click: { n: 480_000, label: 'loop A 1' }, clickS: 10, flashS: 17.3333, residualS: 0.0116 },
        { click: { n: 1_932_000, label: 'demo 1' }, clickS: 40.25, flashS: 47.5667, residualS: -0.005 },
      ],
      missed: [{ n: 1_970_400, label: 'demo 2' }],
      outside: 10,
      extra: [63.5],
      spreadS: 0.0166,
      limitS: 1 / 30,
      votes: { matched: 2, missed: 1 },
      runnerUp: null,
    };
    expect(matchLines(m, 1 / 60)).toEqual([
      'Offset: recording time = session time + 7.322 s (median over 2 clicks).',
      '  click           session      flash   residual',
      '  loop A 1       0:10.000   0:17.333   +11.6 ms',
      '  demo 1         0:40.250   0:47.567    -5.0 ms',
      '  demo 2       no flash near 0:48.372 of the recording',
      '  10 click(s) fall outside the screen recording.',
      '  1 flash(es) belong to no click: 1:03.500',
      'Residual spread 16.6 ms; the limit is 33.3 ms (2 frames of 16.7 ms).',
    ]);
  });
});
