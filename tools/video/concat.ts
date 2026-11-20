// Joining clips (spec 15.2): the live take, the title cards and any other scenes, one after another,
// re-encoded once with the settings of the cut (H.264 + AAC, 48 kHz stereo). Every clip is fitted
// into the size and frame rate of the first (or of --size and --fps) without stretching, and its
// sound is padded or trimmed to its picture, so later clips do not drift; a clip without sound gets
// silence.

import {
  AUDIO_ENCODER_ARGS,
  encodeHead,
  MP4_ARGS,
  parseRational,
  secondsArg,
  videoEncoderArgs,
  VideoError,
  type FfmpegCaps,
  type MediaInfo,
} from './ffmpeg.ts';

export interface ConcatTarget {
  width: number;
  height: number;
  fpsText: string;
  fps: number;
}

/** --size and --fps as given on the command line; null (or left out) where one was not given. */
export interface ConcatGiven {
  size?: readonly [number, number] | null;
  fpsText?: string | null;
}

/**
 * Size and rate of the joined video: --size and --fps where given, else those of the first clip,
 * its size made even. Only a frame rate that is needed and missing is refused.
 */
export function concatTarget(first: MediaInfo, given: ConcatGiven = {}): ConcatTarget {
  const fpsText = given.fpsText ?? (first.fpsText || null);
  if (fpsText === null) throw new VideoError(`${first.file}: no readable frame rate; give --fps`);
  const [width, height] = given.size ?? [first.width - (first.width % 2), first.height - (first.height % 2)];
  return { width, height, fpsText, fps: parseRational(fpsText) };
}

/** ffmpeg arguments that join `inputs` into `out`. */
export function concatArgs(
  inputs: readonly MediaInfo[],
  out: string,
  target: ConcatTarget,
  caps: Pick<FfmpegCaps, 'libx264' | 'videotoolbox'>,
  progress: boolean,
): string[] {
  if (inputs.length < 2) throw new VideoError('--concat needs at least two clips');
  const { width: W, height: H, fpsText } = target;
  const args = [...encodeHead(progress)];
  for (const i of inputs) args.push('-i', i.file);
  const silent: number[] = [];
  const parts: string[] = [];
  const labels: string[] = [];
  inputs.forEach((info, k) => {
    if (!Number.isFinite(info.duration) || info.duration <= 0) throw new VideoError(`${info.file}: its length cannot be read`);
    const d = secondsArg(info.duration);
    parts.push(
      `[${k}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,` +
        `setsar=1,fps=fps=${fpsText},format=yuv420p,trim=duration=${d},setpts=PTS-STARTPTS[v${k}]`,
    );
    let audioIn = `${k}:a`;
    if (!info.hasAudio) {
      const idx = inputs.length + silent.length;
      silent.push(idx);
      args.push('-f', 'lavfi', '-t', d, '-i', 'anullsrc=r=48000:cl=stereo');
      audioIn = `${idx}:a`;
    }
    parts.push(`[${audioIn}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${d},asetpts=PTS-STARTPTS[a${k}]`);
    labels.push(`[v${k}][a${k}]`);
  });
  parts.push(`${labels.join('')}concat=n=${inputs.length}:v=1:a=1[v][a]`);
  args.push(
    '-filter_complex', parts.join(';'),
    '-map', '[v]',
    '-map', '[a]',
    ...videoEncoderArgs(caps, W, H, target.fps),
    ...AUDIO_ENCODER_ARGS,
    ...MP4_ARGS,
    out,
  );
  return args;
}
