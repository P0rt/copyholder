// The live take as one uncut piece (spec 15.1-15.4): which seconds go in, and the ffmpeg command
// line with its two captions, written by drawtext or overlaid as PNG pictures.

import { describe, expect, it } from 'vitest';
import { clickSchedule, type EventLine, type Stamp } from '../../core/clock/index.ts';
import { DEMO_CLICK_STARTS_MS } from '../../web/lib/clicks.ts';
import { escapeFilterValue, secondsArg, videoEncoderArgs, VideoError } from './ffmpeg.ts';
import {
  boxPad,
  captionFiles,
  captionImages,
  CLICK_BLOCK_LEAD_S,
  captionLayout,
  clock,
  cutArgs,
  cutFilter,
  cutFilterPng,
  drawtext,
  evenPlace,
  outputSize,
  overlay,
  parseTake,
  parseTimeArg,
  planCut,
  SOUND_LINE,
  takeCaption,
  type CutCommand,
  type CutInputs,
  type CutOutput,
} from './cut.ts';
import { clickGroups } from './session.ts';

const RATE = 48_000;

/** A headstart-like run: loop check A at 10 s, the demo clicks at 40 s, loop check B at 100 s, audio over 0-120 s. */
function session(events: EventLine[] = [], marks: Array<[number, string]> = MARKS): CutInputs['session'] {
  const stamps: Stamp[] = [];
  for (let n = 0; n < 120 * RATE; n += 48_000) stamps.push({ n, k: 'chunk', frames: 48_000 });
  for (const [s, name] of marks) stamps.push({ n: s * RATE, k: 'mark', what: 'step', name });
  clickSchedule().forEach((x, i) => stamps.push({ n: 10 * RATE + x, k: 'click', i }));
  DEMO_CLICK_STARTS_MS.forEach((ms, i) => stamps.push({ n: Math.round((40 + ms / 1000) * RATE), k: 'click', i }));
  clickSchedule().forEach((x, i) => stamps.push({ n: 100 * RATE + x, k: 'click', i }));
  return {
    sampleRateHz: RATE,
    layout: { runs: [{ n0: 0, n1: 120 * RATE, index0: 0 }] },
    stamps: stamps.sort((a, b) => a.n - b.n),
    events,
  } as CutInputs['session'];
}
const MARKS: Array<[number, string]> = [
  [4, 'loop_a_ready'],
  [9.5, 'loop_a'],
  [40, 'demo_clicks'],
  [43, 'opening'],
  [80, 'summary'],
  [90, 'signal_in'],
  [97, 'loop_b_ready'],
  [99.5, 'loop_b'],
];

function inputs(over: Partial<CutInputs> = {}): CutInputs {
  const s = over.session ?? session();
  return { session: s, groups: clickGroups(s.stamps, RATE), offsetS: 5, span: [0, 130], ...over };
}

describe('planCut', () => {
  it('starts with the demo click block, 3 s before the text, and ends where loop check B starts', () => {
    const p = planCut(inputs());
    expect(CLICK_BLOCK_LEAD_S).toBe(0.25);
    expect(p.nFrom).toBe(40 * RATE);
    expect(p.nTo).toBe(97 * RATE);
    expect(p.fromWhat).toBe('the demo clicks');
    expect(p.toWhat).toBe('step loop_b_ready, after the signal check');
    expect(p.durationS).toBeCloseTo(57, 9);
    expect(p.videoFromS).toBeCloseTo(45, 9);
    expect(p.seekS).toBeCloseTo(42, 9);
    expect(p.startAfterSeekS).toBeCloseTo(3, 9);
    expect(p.notes).toEqual([]);
  });

  it('ends with the recording when there is no loop check B', () => {
    const p = planCut(inputs({ session: session([], MARKS.filter(([, name]) => name !== 'loop_b_ready')) }));
    expect(p.nTo).toBe(120 * RATE);
    expect(p.toWhat).toBe('the end of the recording');
  });

  it('takes --from and --to as seconds, m:ss or step names', () => {
    const p = planCut(inputs({ from: parseTimeArg('0:36.5'), to: parseTimeArg('loop_b') }));
    expect(p.nFrom).toBe(36.5 * RATE);
    expect(p.nTo).toBe(99.5 * RATE);
    expect([p.fromWhat, p.toWhat]).toEqual(['--from', '--to']);
    expect(planCut(inputs({ from: parseTimeArg('opening') })).nFrom).toBe(43 * RATE);
    expect(() => planCut(inputs({ to: parseTimeArg('loop_c') }))).toThrow(
      /--to loop_c: no such number or step \(steps: loop_a_ready, loop_a, demo_clicks, opening, summary, signal_in, loop_b_ready, loop_b\)/,
    );
  });

  it('keeps the cut inside the screen recording and says so', () => {
    const p = planCut(inputs({ span: [47, 95] }));
    expect(p.nFrom).toBe(42 * RATE);
    expect(p.nTo).toBe(90 * RATE);
    expect(p.notes).toEqual([
      'The cut starts at 0:42.0 instead of 0:40.0: the screen recording begins there.',
      'The cut ends at 1:30.0 instead of 1:37.0: the screen recording ends there.',
    ]);
    expect(p.seekS).toBeCloseTo(44, 9);
  });

  it('refuses a cut of nothing', () => {
    expect(() => planCut(inputs({ from: { seconds: 50 }, to: { seconds: 50.2 } }))).toThrow(VideoError);
    expect(() => planCut(inputs({ span: [200, 300] }))).toThrow(/do not overlap/);
  });

  it('says when D1 was not active at the start, without moving it', () => {
    const on = (n: number, active: boolean): EventLine => ({ n, e: 'armed', det: 'D1', on: active });
    expect(planCut(inputs({ session: session([on(30 * RATE, true)]) })).notes).toEqual([]);
    const later = planCut(inputs({ session: session([on(50 * RATE, true)]) }));
    expect(later.nFrom).toBe(40 * RATE);
    expect(later.notes).toEqual(['D1 was not active at the start of the cut; it became active at 0:50.0, 10.0 s in (spec 15.1 would start there: --from 50.00).']);
    expect(planCut(inputs({ session: session([on(100 * RATE, true)]) })).notes).toEqual(['D1 was not active at any time in the cut (events.jsonl).']);
  });

  it('starts where both recordings begin when there are no demo clicks', () => {
    const s = session();
    const noDemo = { ...s, stamps: s.stamps.filter((x) => !(x.k === 'click' && x.n > 30 * RATE && x.n < 50 * RATE)) };
    const p = planCut(inputs({ session: noDemo, span: [7, 130] }));
    expect(p.nFrom).toBe(2 * RATE);
    expect(p.fromWhat).toBe('the start of both recordings');
    expect(p.notes[0]).toMatch(/No demo clicks/);
  });
});

describe('the command line', () => {
  const plan = planCut(inputs());
  const output: CutOutput = { fpsText: '60/1', fps: 60, width: 2880, height: 1800, scaleToHeight: null };
  const font = '/System/Library/Fonts/Helvetica.ttc';

  it('writes the take caption and the sound line as files', () => {
    expect(takeCaption({ k: 1, n: 2 })).toBe('LIVE · take 1 of 2');
    expect(takeCaption({ k: 1, n: 2, rehearsal: true })).toBe('REHEARSAL · not a take');
    expect(captionFiles({ k: 1, n: 2 })).toEqual([
      { name: 'take.txt', text: 'LIVE · take 1 of 2' },
      { name: 'sound.txt', text: "Sound: the app's own recording, aligned to the picture by the clicks" },
    ]);
    expect(captionFiles(null)).toEqual([{ name: 'sound.txt', text: SOUND_LINE }]);
  });

  it('cuts at the frame on screen at each instant and draws both captions', () => {
    const f = cutFilter(plan, output, font, { k: 1, n: 2 });
    const l = captionLayout(2880, 1800);
    expect(f).toBe(
      '[0:v]fps=fps=60/1:start_time=3:round=up,trim=duration=57,setpts=PTS-STARTPTS,format=yuv420p,' +
        `drawtext=fontfile=/System/Library/Fonts/Helvetica.ttc:textfile=take.txt:expansion=none:fontcolor=white:fontsize=${l.take}:` +
        `x=w-tw-${l.margin}:y=${l.margin}:box=1:boxcolor=black@0.6:boxborderw=${Math.round(l.take * 0.3)},` +
        `drawtext=fontfile=/System/Library/Fonts/Helvetica.ttc:textfile=sound.txt:expansion=none:fontcolor=white:fontsize=${l.sound}:` +
        `x=(w-tw)/2:y=h-th-${l.margin}:box=1:boxcolor=black@0.6:boxborderw=${Math.round(l.sound * 0.3)}:enable=lt(t\\,5)[v]`,
    );
    expect(l).toEqual({ take: 65, sound: 54, margin: 45 });
  });

  it('leaves the take caption out without --take, and scales or crops to an even size', () => {
    expect(cutFilter(plan, output, font, null)).not.toContain('take.txt');
    expect(cutFilter(plan, { ...output, scaleToHeight: 1080 }, font, null)).toContain(',scale=1728:1080:flags=lanczos,');
    expect(cutFilter(plan, { ...output, width: 1441, height: 901 }, font, null)).toContain(',crop=1440:900:0:0,');
    expect(outputSize({ width: 1441, height: 901, scaleToHeight: null })).toEqual([1440, 900]);
    expect(outputSize({ width: 2880, height: 1800, scaleToHeight: 1081 })).toEqual([1728, 1080]);
  });

  it('seeks, maps the mix, and encodes H.264 and AAC at 48 kHz without the source metadata', () => {
    const args = cutArgs({
      plan,
      output,
      screen: '/rec/Screen Recording.mov',
      mix: 'mix.wav',
      out: '/out/headstart-2.mp4',
      font,
      take: { k: 1, n: 2 },
      caps: { libx264: true, videotoolbox: true },
      progress: false,
    });
    const at = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
    expect(args.slice(0, 7)).toEqual(['-hide_banner', '-nostdin', '-y', '-v', 'error', '-nostats', '-ss']);
    expect(at('-ss')).toBe('42');
    expect(args.filter((a, i) => args[i - 1] === '-i')).toEqual(['/rec/Screen Recording.mov', 'mix.wav']);
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(at('-filter_complex')).toBe(cutFilter(plan, output, font, { k: 1, n: 2 }));
    expect(args.filter((a, i) => args[i - 1] === '-map')).toEqual(['[v]', '1:a']);
    expect(at('-t')).toBe('57');
    expect(at('-c:v')).toBe('libx264');
    expect(at('-pix_fmt')).toBe('yuv420p');
    expect(at('-c:a')).toBe('aac');
    expect(at('-ar')).toBe('48000');
    expect(at('-ac')).toBe('2');
    expect(at('-map_metadata')).toBe('-1');
    expect(at('-movflags')).toBe('+faststart');
    expect(args[args.length - 1]).toBe('/out/headstart-2.mp4');
    const fromStart = cutArgs({ plan: { ...plan, seekS: 0 }, output, screen: 's.mov', mix: 'm.wav', out: 'o.mp4', font, take: null, caps: { libx264: true, videotoolbox: false }, progress: true });
    expect(fromStart).not.toContain('-ss');
    expect(fromStart).toContain('-stats');
  });

  it('falls back to the hardware encoder and refuses without one', () => {
    expect(videoEncoderArgs({ libx264: false, videotoolbox: true }, 1920, 1080, 60)).toEqual(['-c:v', 'h264_videotoolbox', '-b:v', '8709k', '-pix_fmt', 'yuv420p']);
    expect(() => videoEncoderArgs({ libx264: false, videotoolbox: false }, 1920, 1080, 60)).toThrow(/no H.264 encoder/);
  });
});

describe('the captions as PNG pictures', () => {
  const plan = planCut(inputs());
  const output: CutOutput = { fpsText: '60/1', fps: 60, width: 2880, height: 1800, scaleToHeight: null };
  const font = '/System/Library/Fonts/Helvetica.ttc';
  const take = { k: 1, n: 2 };
  const picture = '[0:v]fps=fps=60/1:start_time=3:round=up,trim=duration=57,setpts=PTS-STARTPTS,format=yuv420p';
  const held = 'eof_action=repeat:shortest=0:repeatlast=1:format=yuv420';

  it('asks Chrome for the texts, font sizes and box padding of the drawtext captions', () => {
    const l = captionLayout(2880, 1800);
    expect(captionImages(take, 2880, 1800)).toEqual([
      { kind: 'caption', name: 'take.png', text: 'LIVE · take 1 of 2', size: l.take, pad: boxPad(l.take) },
      { kind: 'caption', name: 'sound.png', text: SOUND_LINE, size: l.sound, pad: boxPad(l.sound) },
    ]);
    expect([boxPad(l.take), boxPad(l.sound)]).toEqual([20, 16]);
    expect(captionImages(null, 2880, 1800).map((p) => p.name)).toEqual(['sound.png']);
    // The size of the output, not of the recording: --height scales the captions with it.
    expect(captionImages(take, ...outputSize({ ...output, scaleToHeight: 1080 }))[0]).toMatchObject({ size: captionLayout(1728, 1080).take });
  });

  it('overlays the take caption for the whole cut and the sound line while t < 5, on the picture of drawtext mode', () => {
    const f = cutFilterPng(plan, output, take);
    // Each picture first gets the transparent column and row evenPlace adds where its place is odd.
    const takePad = 'mod(floor(2880-iw-45+20)\\,2)';
    const takeRow = 'mod(floor(45-20)\\,2)';
    const soundPad = 'mod(floor((2880-iw)/2)\\,2)';
    const soundRow = 'mod(floor(1800-ih-45+16)\\,2)';
    expect(f).toBe(
      `${picture}[cut];` +
        `[2:v]format=rgba,pad=w=iw+${takePad}:h=ih+${takeRow}:x=${takePad}:y=${takeRow}:color=black@0[takepng];` +
        `[cut][takepng]overlay=x=W-w-45+20:y=45-20:${held}[take];` +
        `[3:v]format=rgba,pad=w=iw+${soundPad}:h=ih+${soundRow}:x=${soundPad}:y=${soundRow}:color=black@0[soundpng];` +
        `[take][soundpng]overlay=x=(W-w)/2:y=H-h-45+16:${held}:enable=lt(t\\,5)[v]`,
    );
    const drawn = cutFilter(plan, output, font, take);
    expect(drawn.startsWith(`${picture},drawtext=`)).toBe(true);
    expect(cutFilterPng(plan, output, null)).toBe(
      `${picture}[cut];` +
        `[2:v]format=rgba,pad=w=iw+${soundPad}:h=ih+${soundRow}:x=${soundPad}:y=${soundRow}:color=black@0[soundpng];` +
        `[cut][soundpng]overlay=x=(W-w)/2:y=H-h-45+16:${held}:enable=lt(t\\,5)[v]`,
    );
    expect(cutFilterPng(plan, { ...output, scaleToHeight: 1080 }, null)).toContain(',scale=1728:1080:flags=lanczos,format=yuv420p[cut];');
    // The pad works out the place on the output's own size (scaled, or cropped to even numbers).
    expect(cutFilterPng(plan, { ...output, scaleToHeight: 1080 }, null)).toContain(':h=ih+mod(floor(1080-ih-27+10)\\,2):');
    expect(cutFilterPng(plan, { ...output, width: 1441, height: 901 }, null)).toContain(',crop=1440:900:0:0,format=yuv420p[cut];');
    expect(cutFilterPng(plan, { ...output, width: 1441, height: 901 }, null)).toContain('pad=w=iw+mod(floor((1440-iw)/2)\\,2):');
    expect(overlay('0', '0')).toBe(`overlay=x=0:y=0:${held}`);
    expect(evenPlace('W-w-5', '7', 640, 360)).toBe(
      'format=rgba,pad=w=iw+mod(floor(640-iw-5)\\,2):h=ih+mod(floor(7)\\,2):x=mod(floor(640-iw-5)\\,2):y=mod(floor(7)\\,2):color=black@0',
    );
  });

  /**
   * Where ffmpeg puts the pixels of caption picture `input` (pw x ph) on a W x H frame: pad adds
   * the column and row its expressions ask for, then overlay takes its x and y with the picture's
   * new size and rounds them down to even numbers (yuv420), as the two filters do.
   */
  function landing(filter: string, input: number, W: number, H: number, pw: number, ph: number): [number, number] {
    const evaluate = (e: string, vars: Record<string, number>): number => {
      const mod = (a: number, b: number): number => a - b * Math.floor(a / b);
      const text = e.replace(/\\(.)/g, '$1');
      return new Function(...Object.keys(vars), 'mod', 'floor', `return ${text};`)(...Object.values(vars), mod, Math.floor) as number;
    };
    const pad = new RegExp(`\\[${input}:v\\]format=rgba,pad=w=iw\\+(.+?):h=ih\\+(.+?):x=(.+?):y=(.+?):color=black@0\\[(\\w+)\\]`).exec(filter);
    expect(pad).not.toBeNull();
    const [, addW, addH, padX, padY, label] = pad!;
    const own = { iw: pw, ih: ph };
    const [dx, dy] = [evaluate(padX!, own), evaluate(padY!, own)];
    expect([evaluate(addW!, own), evaluate(addH!, own)]).toEqual([dx, dy]);
    expect([0, 1]).toContain(dx);
    expect([0, 1]).toContain(dy);
    const over = new RegExp(`\\[\\w+\\]\\[${label}\\]overlay=x=([^:]+):y=([^:]+):`).exec(filter);
    expect(over).not.toBeNull();
    const padded = { W, H, w: pw + dx, h: ph + dy };
    const even = (v: number): number => Math.trunc(v) & ~1;
    return [even(evaluate(over![1]!, padded)) + dx, even(evaluate(over![2]!, padded)) + dy];
  }

  it('puts each box on the pixels of the box drawtext draws, at odd places too', () => {
    // A caption of text width tw and height th is a PNG of tw + 2 pad by th + 2 pad (drawtext's box).
    // Frames where the take box's top row (margin - pad) is odd (2880 x 1800) and even (3024 x 1964);
    // texts of every width mod 4 and both parities of height, so each place is odd and even.
    let oddPlaces = 0;
    for (const [W, H] of [[2880, 1800], [3024, 1964], [1728, 1080], [320, 240]] as const) {
      const l = captionLayout(W, H);
      const [tp, sp] = [boxPad(l.take), boxPad(l.sound)];
      const f = cutFilterPng(plan, { ...output, width: W, height: H }, take);
      for (let k = 0; k < 8; k++) {
        const [tw, th] = [Math.round(W / 5) + (k % 4), Math.round(H / 30) + (k >> 2)];
        // drawtext: x=w-tw-margin, y=margin; its box pad px further out.
        const takeBox: [number, number] = [W - tw - l.margin - tp, l.margin - tp];
        expect(landing(f, 2, W, H, tw + 2 * tp, th + 2 * tp)).toEqual(takeBox);
        // drawtext: x=(w-tw)/2, cut down to a whole pixel, y=h-th-margin.
        const soundBox: [number, number] = [Math.trunc((W - tw) / 2) - sp, H - th - l.margin - sp];
        expect(landing(f, 3, W, H, tw + 2 * sp, th + 2 * sp)).toEqual(soundBox);
        oddPlaces += [...takeBox, ...soundBox].filter((v) => v % 2 === 1).length;
      }
    }
    expect(oddPlaces).toBeGreaterThan(20);
    expect(captionLayout(2880, 1800).margin - boxPad(captionLayout(2880, 1800).take)).toBe(25);
    expect(captionLayout(3024, 1964).margin - boxPad(captionLayout(3024, 1964).take)).toBe(28);
  });

  it('gives the pictures as still inputs after the mix and maps, times and encodes as drawtext mode does', () => {
    const base: CutCommand = {
      plan,
      output,
      screen: '/rec/Screen Recording.mov',
      mix: 'mix.wav',
      out: '/out/headstart-2.mp4',
      font,
      take,
      caps: { libx264: true, videotoolbox: true },
      progress: false,
    };
    const drawn = cutArgs(base);
    expect(cutArgs({ ...base, captions: 'drawtext' })).toEqual(drawn);
    const png = cutArgs({ ...base, captions: 'png' });
    const inputs = (args: string[]): string[] => args.filter((_, i) => args[i - 1] === '-i');
    expect(inputs(png)).toEqual(['/rec/Screen Recording.mov', 'mix.wav', 'take.png', 'sound.png']);
    // One frame each, at the cut's frame rate: the pictures share its time base.
    expect(png.slice(png.indexOf('take.png') - 3, png.indexOf('sound.png') + 1)).toEqual(['-framerate', '60/1', '-i', 'take.png', '-framerate', '60/1', '-i', 'sound.png']);
    expect(png[png.indexOf('-filter_complex') + 1]).toBe(cutFilterPng(plan, output, take));
    // Leave out the two pictures and the filter: what is left is drawtext mode's command, item for item.
    const rest = (args: string[]): string[] => {
      const a = [...args];
      a.splice(a.indexOf('-filter_complex'), 2);
      for (const p of ['take.png', 'sound.png']) {
        const i = a.indexOf(p);
        if (i >= 0) a.splice(i - 3, 4);
      }
      return a;
    };
    expect(rest(png)).toEqual(rest(drawn));
    expect(png.filter((a, i) => png[i - 1] === '-map')).toEqual(['[v]', '1:a']);
    expect(inputs(cutArgs({ ...base, take: null, captions: 'png' }))).toEqual(['/rec/Screen Recording.mov', 'mix.wav', 'sound.png']);
  });
});

describe('text in a filtergraph', () => {
  it('escapes a value for both levels ffmpeg reads', () => {
    expect(escapeFilterValue('lt(t,5)')).toBe('lt(t\\,5)');
    expect(escapeFilterValue('/Fonts/My Font:1.ttf')).toBe('/Fonts/My Font\\\\:1.ttf');
    expect(escapeFilterValue("it's")).toBe("it\\\\\\'s");
    expect(escapeFilterValue('a[b];c')).toBe('a\\[b\\]\\;c');
  });

  it('reads the text from a file with expansion off', () => {
    const d = drawtext({ file: 'card1-1.txt', font: '/f.ttf', size: 40, x: '(w-tw)/2', y: '300', pad: 0, enable: 'gte(t,0)*lt(t,4)', yAlignFont: true });
    expect(d).toBe('drawtext=fontfile=/f.ttf:textfile=card1-1.txt:expansion=none:fontcolor=white:fontsize=40:x=(w-tw)/2:y=300:y_align=font:enable=gte(t\\,0)*lt(t\\,4)');
  });

  it('writes seconds without trailing zeros', () => {
    expect(secondsArg(2)).toBe('2');
    expect(secondsArg(1.5)).toBe('1.5');
    expect(secondsArg(0.1234567)).toBe('0.123457');
    expect(secondsArg(-1e-9)).toBe('0');
  });
});

describe('arguments', () => {
  it('reads takes, times and clocks', () => {
    expect(parseTake('1/2')).toEqual({ k: 1, n: 2 });
    expect(parseTake(' 2 / 2 ')).toEqual({ k: 2, n: 2 });
    for (const bad of ['0/2', '3/2', '1/10', '1', 'a/b']) expect(parseTake(bad)).toBeNull();
    expect(parseTimeArg('95.5')).toEqual({ seconds: 95.5 });
    expect(parseTimeArg('1:35.5')).toEqual({ seconds: 95.5 });
    expect(parseTimeArg('loop_b')).toEqual({ step: 'loop_b' });
    expect(clock(95.5)).toBe('1:35.500');
    expect(clock(5, 1)).toBe('0:05.0');
    expect(clock(-0.25)).toBe('-0:00.250');
  });

  it('rounds a clock before it splits off the minutes', () => {
    expect(clock(59.97, 1)).toBe('1:00.0');
    expect(clock(59.95, 1)).toBe('1:00.0');
    expect(clock(59.94, 1)).toBe('0:59.9');
    expect(clock(119.9996)).toBe('2:00.000');
    expect(clock(119.9994)).toBe('1:59.999');
    expect(clock(9.96, 1)).toBe('0:10.0');
    expect(clock(-59.97, 1)).toBe('-1:00.0');
    expect(clock(59.6, 0)).toBe('1:00');
    expect(clock(-0.0001)).toBe('0:00.000');
    expect(clock(3599.9999)).toBe('60:00.000');
  });
});
