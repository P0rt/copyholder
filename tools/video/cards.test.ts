// Title cards and joining (spec 15.2): cards.json read with every problem listed, the card
// command line (drawtext, or one PNG picture per card overlaid), and the concat command that fits
// every clip to one size, rate and sound format.

import { describe, expect, it } from 'vitest';
import { CARD_PICTURE_INPUT, cardFontSize, cardLines, cardsPlan, cardsText, parseCards, parseFps, parseSize, type CardsCommand } from './cards.ts';
import { concatArgs, concatTarget } from './concat.ts';
import type { MediaInfo } from './ffmpeg.ts';

describe('parseCards', () => {
  it('reads a list of cards or an object with size and fps', () => {
    const list = parseCards('[{"text": "Line one\\nLine two", "seconds": 4}, {"lines": ["Only line"], "seconds": 2.5, "fontSize": 90}]');
    expect(list).toEqual({
      cards: [
        { lines: ['Line one', 'Line two'], seconds: 4 },
        { lines: ['Only line'], seconds: 2.5, fontSize: 90 },
      ],
      size: null,
      fpsText: null,
    });
    const obj = parseCards('﻿{"size": "1280x720", "fps": "30000/1001", "cards": [{"text": "A", "seconds": 1}]}');
    expect(obj.size).toEqual([1280, 720]);
    expect(obj.fpsText).toBe('30000/1001');
    expect(cardsText(list)).toBe('Line one\nLine two\nOnly line');
  });

  it('lists every problem at once', () => {
    let message = '';
    try {
      parseCards('{"size": "1281x720", "fps": 500, "cards": [{"text": "  ", "seconds": 2}, {"text": "B", "seconds": 0}, 7, {"text": "C", "seconds": 1, "fontSize": 3}]}');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.split('\n').slice(1).map((l) => l.trim())).toEqual([
      'size: expected "WIDTHxHEIGHT" with even numbers, like "1920x1080"',
      'fps: expected a frame rate from 5 to 240, like 60 or "30000/1001"',
      'card 1: "text" (a string) or "lines" (strings) with some text is needed',
      'card 2: "seconds" must be a number above 0 and at most 600',
      'card 3: expected an object with "text" (or "lines") and "seconds"',
      'card 4: "fontSize" must be a whole number of pixels from 8 to 400',
    ]);
  });

  it('refuses bad JSON, an empty list and more than 10 minutes of cards', () => {
    expect(() => parseCards('{')).toThrow(/not valid JSON/);
    expect(() => parseCards('[]')).toThrow(/the list is empty/);
    expect(() => parseCards('{"cards": 3}')).toThrow(/expected a list of cards/);
    expect(() => parseCards(JSON.stringify(Array.from({ length: 3 }, () => ({ text: 'x', seconds: 250 }))))).toThrow(/750 s in all, more than 600 s/);
  });

  it('reads sizes and frame rates', () => {
    expect(parseSize('1920x1080')).toEqual([1920, 1080]);
    expect(parseSize(' 1280 × 720 ')).toEqual([1280, 720]);
    for (const bad of ['1921x1080', '8x8', '1920', '7682x100']) expect(parseSize(bad)).toBeNull();
    expect(parseFps(60)).toBe('60');
    expect(parseFps(' 30000/1001 ')).toBe('30000/1001');
    for (const bad of ['0', '300', 'abc', '60/0']) expect(parseFps(bad)).toBeNull();
  });
});

describe('cards', () => {
  it('sizes the text to fit the frame', () => {
    expect(cardFontSize({ lines: ['Short'], seconds: 1 }, 1920, 1080)).toBe(68);
    expect(cardFontSize({ lines: ['x'.repeat(80)], seconds: 1 }, 1920, 1080)).toBe(38);
    expect(cardFontSize({ lines: Array.from({ length: 20 }, () => 'y'), seconds: 1 }, 1920, 1080)).toBe(36);
    expect(cardFontSize({ lines: ['Big'], seconds: 1, fontSize: 120 }, 1920, 1080)).toBe(120);
  });

  it('draws each line of each card while the card shows, over silence', () => {
    const spec = parseCards('[{"text": "First card\\n\\nthird line", "seconds": 4}, {"text": "Second card", "seconds": 3}]');
    const plan = cardsPlan({
      spec,
      size: [1280, 720],
      fpsText: '30',
      font: '/f.ttf',
      out: '/out/cards.mp4',
      caps: { libx264: true, videotoolbox: false, yAlign: true },
      progress: false,
    });
    expect(plan.totalS).toBe(7);
    expect(plan.files).toEqual([
      { name: 'card1-1.txt', text: 'First card' },
      { name: 'card1-3.txt', text: 'third line' },
      { name: 'card2-1.txt', text: 'Second card' },
    ]);
    const at = (flag: string, from = 0): string | undefined => plan.args[plan.args.indexOf(flag, from) + 1];
    expect(plan.args.filter((a, i) => plan.args[i - 1] === '-i')).toEqual(['color=c=black:s=1280x720:r=30:d=7', 'anullsrc=r=48000:cl=stereo']);
    const filter = at('-filter_complex') as string;
    expect(filter.startsWith('[0:v]format=yuv420p,drawtext=fontfile=/f.ttf:textfile=card1-1.txt:expansion=none:fontcolor=white:fontsize=45:x=(w-tw)/2:y=')).toBe(true);
    expect(filter).toContain(':y_align=font:enable=gte(t\\,0)*lt(t\\,4)');
    expect(filter).toContain('textfile=card2-1.txt');
    expect(filter).toContain('enable=gte(t\\,4)*lt(t\\,7)');
    expect(filter.endsWith('[v]')).toBe(true);
    expect(plan.args.filter((a, i) => plan.args[i - 1] === '-map')).toEqual(['[v]', '1:a']);
    expect(at('-t')).toBe('7');
    expect(at('-c:v')).toBe('libx264');
    expect(at('-c:a')).toBe('aac');
    expect(plan.args[plan.args.length - 1]).toBe('/out/cards.mp4');
  });

  it('places the lines alike for drawtext and PNG: one size, 1.35 lines apart, centred in height', () => {
    const [first, second] = parseCards('[{"text": "First card\\n\\nthird line", "seconds": 4}, {"text": "Second card", "seconds": 3}]').cards;
    // 45 px (720 / 16), 61 px apart; the blank second line keeps its place and is not drawn.
    expect(cardLines(first!, 1280, 720)).toEqual([
      { index: 0, text: 'First card', size: 45, top: 277 },
      { index: 2, text: 'third line', size: 45, top: 399 },
    ]);
    expect(cardLines(second!, 1280, 720)).toEqual([{ index: 0, text: 'Second card', size: 45, top: 338 }]);
  });
});

describe('cards as PNG pictures', () => {
  const spec = parseCards('[{"text": "First card\\n\\nthird line", "seconds": 4}, {"text": "Second card", "seconds": 3}]');
  const command = (captions: CardsCommand['captions']): CardsCommand => ({
    spec,
    size: [1280, 720],
    fpsText: '30',
    font: '/f.ttf',
    out: '/out/cards.mp4',
    caps: { libx264: true, videotoolbox: false, yAlign: true },
    progress: false,
    captions,
  });
  const held = 'eof_action=repeat:shortest=0:repeatlast=1:format=yuv420';

  it('draws each card as one picture of the frame size and lays it over the black while the card shows', () => {
    const plan = cardsPlan(command('png'));
    expect(plan.totalS).toBe(7);
    expect(plan.files).toEqual([]);
    expect(plan.images).toEqual([
      {
        kind: 'card',
        name: 'card1.png',
        width: 1280,
        height: 720,
        lines: [
          { text: 'First card', size: 45, top: 277 },
          { text: 'third line', size: 45, top: 399 },
        ],
      },
      { kind: 'card', name: 'card2.png', width: 1280, height: 720, lines: [{ text: 'Second card', size: 45, top: 338 }] },
    ]);
    const inputs = plan.args.filter((a, i) => plan.args[i - 1] === '-i');
    expect(inputs).toEqual(['color=c=black:s=1280x720:r=30:d=7', 'anullsrc=r=48000:cl=stereo', 'card1.png', 'card2.png']);
    expect(inputs.indexOf('card1.png')).toBe(CARD_PICTURE_INPUT);
    // Each picture is read at the frame rate of the cards, so the overlay keeps their time base.
    for (const name of ['card1.png', 'card2.png']) expect(plan.args.slice(plan.args.indexOf(name) - 3, plan.args.indexOf(name))).toEqual(['-framerate', '30', '-i']);
    expect((plan.args[plan.args.indexOf('-filter_complex') + 1] as string).split(';')).toEqual([
      '[0:v]format=yuv420p[c0]',
      `[c0][2:v]overlay=x=0:y=0:${held}:enable=gte(t\\,0)*lt(t\\,4)[c1]`,
      `[c1][3:v]overlay=x=0:y=0:${held}:enable=gte(t\\,4)*lt(t\\,7)[v]`,
    ]);
  });

  it('maps, times and encodes the same as drawtext', () => {
    const png = cardsPlan(command('png')).args;
    const text = cardsPlan(command('drawtext')).args;
    expect(cardsPlan(command(undefined)).args).toEqual(text);
    // Without the picture inputs and the filter graph, the two command lines are the same.
    const rest = (args: readonly string[]): string[] => {
      const kept: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-framerate') {
          i += 3;
          continue;
        }
        kept.push(args[i - 1] === '-filter_complex' ? '<graph>' : (args[i] as string));
      }
      return kept;
    };
    expect(rest(png)).toEqual(rest(text));
    expect(png.filter((a, i) => png[i - 1] === '-map')).toEqual(['[v]', '1:a']);
    expect(png[png.indexOf('-t') + 1]).toBe('7');
  });

  it('draws the cards with drawtext at the same tops as the pictures', () => {
    const filter = cardsPlan(command('drawtext')).args.find((a, i, all) => all[i - 1] === '-filter_complex') as string;
    const ys = [...filter.matchAll(/textfile=(card\d-\d\.txt):.*?:y=(\d+):/g)].map((m) => [m[1], Number(m[2])]);
    expect(ys).toEqual([
      ['card1-1.txt', 277],
      ['card1-3.txt', 399],
      ['card2-1.txt', 338],
    ]);
  });
});

describe('concat', () => {
  const clip = (file: string, over: Partial<MediaInfo> = {}): MediaInfo => ({
    file,
    width: 1920,
    height: 1080,
    fpsText: '60/1',
    fps: 60,
    duration: 4.5,
    hasAudio: true,
    ...over,
  });

  it('takes the size and rate of the first clip, made even', () => {
    expect(concatTarget(clip('a.mp4', { width: 1441, height: 901 }))).toEqual({ width: 1440, height: 900, fpsText: '60/1', fps: 60 });
    expect(() => concatTarget(clip('a.mp4', { fpsText: '' }))).toThrow(/no readable frame rate/);
  });

  it('takes --size and --fps over the first clip, and asks for --fps only when the first clip has no readable rate', () => {
    const noRate = clip('a.mov', { fpsText: '', fps: Number.NaN, width: 1441, height: 901 });
    expect(concatTarget(noRate, { size: null, fpsText: '30' })).toEqual({ width: 1440, height: 900, fpsText: '30', fps: 30 });
    expect(concatTarget(noRate, { size: [1280, 720], fpsText: '30000/1001' })).toEqual({ width: 1280, height: 720, fpsText: '30000/1001', fps: 30000 / 1001 });
    expect(concatTarget(clip('b.mp4'), { size: [1280, 720], fpsText: null })).toEqual({ width: 1280, height: 720, fpsText: '60/1', fps: 60 });
    expect(() => concatTarget(noRate, { size: [1280, 720], fpsText: null })).toThrow('a.mov: no readable frame rate; give --fps');
  });

  it('fits every clip without stretching, keeps sound and picture the same length, and gives silence to a silent clip', () => {
    const inputs = [clip('cards.mp4', { duration: 7, hasAudio: false, width: 1280, height: 720, fpsText: '30', fps: 30 }), clip('take.mp4')];
    const args = concatArgs(inputs, 'final.mp4', { width: 1920, height: 1080, fpsText: '60/1', fps: 60 }, { libx264: true, videotoolbox: false }, false);
    const at = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
    expect(args.filter((a, i) => args[i - 1] === '-i')).toEqual(['cards.mp4', 'take.mp4', 'anullsrc=r=48000:cl=stereo']);
    expect(args[args.indexOf('anullsrc=r=48000:cl=stereo') - 3]).toBe('-t');
    expect(args[args.indexOf('anullsrc=r=48000:cl=stereo') - 2]).toBe('7');
    expect((at('-filter_complex') as string).split(';')).toEqual([
      '[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=fps=60/1,format=yuv420p,trim=duration=7,setpts=PTS-STARTPTS[v0]',
      '[2:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=7,asetpts=PTS-STARTPTS[a0]',
      '[1:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=fps=60/1,format=yuv420p,trim=duration=4.5,setpts=PTS-STARTPTS[v1]',
      '[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=4.5,asetpts=PTS-STARTPTS[a1]',
      '[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]',
    ]);
    expect(args.filter((a, i) => args[i - 1] === '-map')).toEqual(['[v]', '[a]']);
    expect(at('-c:v')).toBe('libx264');
    expect(at('-ar')).toBe('48000');
    expect(args[args.length - 1]).toBe('final.mp4');
  });

  it('needs two clips with a readable length', () => {
    const target = { width: 1920, height: 1080, fpsText: '60', fps: 60 };
    const caps = { libx264: true, videotoolbox: false };
    expect(() => concatArgs([clip('a.mp4')], 'o.mp4', target, caps, false)).toThrow(/at least two clips/);
    expect(() => concatArgs([clip('a.mp4'), clip('b.mp4', { duration: Number.NaN })], 'o.mp4', target, caps, false)).toThrow(/b\.mp4: its length cannot be read/);
  });
});
