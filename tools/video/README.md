# Demo video: `npm run video`

`npm run video` puts the demo video together on the Mac (spec 15.2-15.4). It cuts the live take out
of a screen recording without sound, lays the app's own two-channel recording under the picture and
lines the two up by the click flashes. It also renders title cards and joins clips into one video.
It runs ffmpeg and ffprobe, and Chrome to draw the captions and the cards when that ffmpeg cannot
draw text itself.

## Before the take

1. Install ffmpeg, which brings ffprobe: `brew install ffmpeg`. Homebrew's ffmpeg has no drawtext
   filter (it is built without libfreetype), so Chrome draws the captions and the title cards as
   PNG pictures, headless, and ffmpeg lays them over the video (`--captions`, below). Tell
   `npm run video` where Chrome is, once per terminal:

   ```sh
   export PW_CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
   ```

   or pass `--chrome <path>` with each command (the app folder `/Applications/Google Chrome.app`
   does as well). The Playwright tests of this repository read the same variable. Without either,
   Playwright's own Chromium is started, where it is installed. An ffmpeg with drawtext
   (`ffmpeg -hide_banner -filters | grep drawtext` prints a line) writes the text itself and needs
   no Chrome.
2. Put the Chrome window of the take in the top-left corner of the screen: maximised, or full
   screen. The page draws its sync square 16 px from its own top-left corner, black, and white for
   100 ms at every click (loop check A, the three demo clicks, loop check B). `npm run video` looks
   for it in the top-left 400 x 400 px of the recording. Keep other windows off it and do not
   scroll the page.

## Recording the screen

1. Press Cmd+Shift+5.
2. Choose **Record Entire Screen**.
3. Under **Options**, set **Microphone** to **None**. The sound of the video is the app's own
   recording, never the screen recording's (spec 15.4). Pick the folder under **Save to**.
4. Click **Record** before you start the take with `npm run headstart`, so the recording runs
   before loop check A (spec 15.4, 15.5).
5. During the take, touch neither the recording controls nor other windows. A page that is hidden
   even once fails the clock check (spec 6.3).
6. Stop after loop check B, once the `quickcheck` line is printed: the stop button in the menu bar,
   or Cmd+Ctrl+Esc.

The recording lands as `Screen Recording <date> at <time>.mov`. Keep it one piece: no pause.

A rehearsal without the camera and the key, `npm run headstart -- --tap mock`, runs the same way
and can end with `npm run video -- <session id> --screen <recording.mov> --rehearsal` making a trial
video from it. Its chest trace is synthetic, so it is no demo take: without `--rehearsal` the
command refuses it, and with `--rehearsal` the top caption reads `REHEARSAL · not a take` in place
of `LIVE · take k of n`.

## Cutting the take

```sh
npm run video -- headstart-3 --screen ~/Desktop/"Screen Recording 2026-11-20 at 10.15.32.mov" --take 1/2
```

- `headstart-3` is the session folder in `sessions/`. Without it, the newest headstart (or demo)
  session is used.
- The video goes to `video/<session id>.mp4`, or to `--out <file.mp4>`. Git ignores `.mp4` files;
  the video never goes into git (spec 13.4, 15.4).
- `--take k/n` writes `LIVE · take k of n` (spec 15.3).

What the command prints, in order:

1. When Chrome draws the captions: which Chrome, and why. It draws them before the frames are read,
   so a Chrome that does not start stops the command at once, with one line that says how to name
   it. Then the square it found, and how many flashes.
2. The offset between the two clocks (recording time = session time + offset) and, for every click,
   the flash that goes with it and the residual in ms. It refuses when the residuals spread over
   more than 2 frames of the recording, or when the flashes do not follow the clicks. A missing or
   an extra flash is listed and does not stop it.
3. L_rt and where it comes from: `clock_report.json`, `calib.json`, or measured on the loop checks
   of `audio.wav` (a headstart session has no clock report). `--lrt-ms <ms>` sets it.
4. The cut, in session time and in recording time, and the gains of the two sound channels.
5. The file it wrote.

`--align-only` stops after the offset table and lists the steps of `stamps.jsonl` with their
session times: use it to check a recording before the cut, and to pick `--from` and `--to`.

### Which part

By default the cut opens with the three demo clicks, 3 s before the text, and ends where the prompt
of loop check B starts, after the summary and the signal check (spec 15.1, 15.2). Without loop
check B it runs to the end of the recording. `--from` and `--to` take session seconds (`95.5`),
minutes and seconds (`1:35.5`) or a step name from the printout (`--to summary`). The cut is one
piece: no splice, no change of speed (spec 15.1).

D1 arms only after some breaths of reading, so it is seldom active at the clicks. When it is not, a
note says when it became active. The cut stays where it is, with the sync clicks in it; spec 15.1
would start the segment where D1 became active, and the note gives the `--from` for that.

### Picture, captions and sound

- Picture: at each instant, the frame the screen showed then, at the recording's frame rate (or
  `--fps`) and size (or `--height <px>`), H.264.
- Captions: `LIVE · take k of n` at the top right for the whole cut (with `--take`), and
  `Sound: the app's own recording, aligned to the picture by the clicks` at the bottom for the first
  5 s (spec 15.2, 15.4), white on a box of black at 60 %. The font is Helvetica or Arial on the
  Mac, DejaVu Sans or Liberation Sans on Linux, or `--font <file>`. ffmpeg's drawtext writes them
  when that ffmpeg has it. Otherwise Chrome draws each caption as a PNG picture at the same font
  size, with the same box, and ffmpeg lays it over the picture for the same time and in the same
  place, within a pixel or two: Chrome measures and draws the letters a little differently from
  drawtext. Every frame keeps its time, so the alignment does not change. When Chrome cannot read
  the font file, or none is found, a sans-serif font of the system draws them, and the command
  says so.
- Sound: channel 0 (the microphone) and channel 1 (the narrator as played) moved L_rt later, so
  both lie on the microphone's time scale and the gap between the narrator's silence and your voice
  is the one you heard in the headset (spec 6.3, 15.4). Each channel is brought to the same speech
  level and the sum peaks at -1 dBFS, so nothing clips. AAC, 48 kHz, stereo.

The alignment is good to about one frame of the screen recording, plus the time the page takes to
draw a flash, which is not known (spec 15.4). No number of the article is taken from the video.

## Title cards

`cards.json` is a list of cards, or an object with `size`, `fps` and `cards`. A card has `text`
(lines split at `\n`) or `lines`, its `seconds`, and an optional `fontSize` in pixels.

```json
{
  "size": "1920x1080",
  "fps": 60,
  "cards": [
    { "text": "Summary of this take", "seconds": 4 },
    { "lines": ["One person, one setup."], "seconds": 3 }
  ]
}
```

```sh
npm run video -- --cards video/captions/cards.json --out video/cards.mp4 --like video/headstart-3.mp4
```

White text on black, centred, each card for its own seconds, over silence. As with the captions,
drawtext writes the lines, or Chrome draws each card as one picture of the whole frame with the
lines in the same places, within a pixel or two. `--like <clip>` takes the size and frame rate of
that clip; `--size WxH` and `--fps <rate>` set them; without any of these the file's own `size`
and `fps` apply, else 1920 x 1080 at 30 fps. The card texts must pass the banned-word list of
`npm run lint:words` (spec 13.6, 15.6), or nothing is drawn. Keep the file in `video/captions/`:
`npm run lint:words` checks that folder as well.

## Joining

```sh
npm run video -- --concat video/headstart-3.mp4 video/cards.mp4 --out video/final.mp4
```

The clips play one after another in the order given. Each is fitted into the size and frame rate of
the first clip (or `--size`, `--fps`) without stretching, with black bars where the shapes differ.
Its sound becomes 48 kHz stereo AAC and is padded or cut to the length of its picture, so later
clips do not drift; a clip without sound gets silence. When the frame rate of the first clip cannot
be read, the command asks for `--fps`. The whole video must stay under 3 minutes (spec 15, 17.5);
the command says so when a file it writes is longer.

## Other options

- `--square x,y,w,h`: where the square is, in pixels of the recording, when it is not found in the
  top-left corner (read the numbers off a still frame, for example in Preview).
- `--max-spread-frames <n>`: the largest residual spread taken, in frames (default 2).
- `--ffmpeg <path>`, `--ffprobe <path>`, or the variables `COPYHOLDER_FFMPEG` and
  `COPYHOLDER_FFPROBE`: the programs to run.
- `--captions auto|drawtext|png`: what draws the captions and the title cards. `auto` (the
  default) takes ffmpeg's drawtext when that ffmpeg has it, and Chrome when it does not; `drawtext`
  refuses an ffmpeg without it; `png` always takes Chrome. `--align-only` draws nothing and needs
  neither.
- `--chrome <path>`: the Chrome or Chromium that draws the PNG pictures. Without it, the variable
  `PW_CHROMIUM_PATH`, else Playwright's own Chromium.
- `--keep-temp`: keep the temporary folder: the sound mix, and the caption and card texts, or the
  PNG pictures with the pages Chrome drew them from.

Paths are taken from the folder you ran `npm run` in; `~/` is your home folder.

Exit codes: 0 done; 1 refused or failed, with one line `VIDEO DID NOT RUN: ...` that says why;
2 wrong usage.

## Tests

`npx vitest run tools/video` runs the tests. The ones in `media.test.ts` make tiny screen recordings
(320 x 240) with ffmpeg and matching session folders in a temporary folder: one at 30 fps, one at an
uneven frame rate as macOS records the screen, and one whose first frame is at 1.3 s. A whole cut of
each must show every flash on its click in the cut's own sound, in each caption mode the machine
has: drawtext where ffmpeg has it, Chrome's pictures where a Chrome starts. So on the Mac, whose
ffmpeg has no drawtext, they run with Chrome; where both modes run, every frame and every flash must
stay where drawtext mode has them. The cut and the cards are also made with `--captions png`, and
with an ffmpeg that hides its drawtext filter, each caption where and while it belongs, and white
test pictures must land on the very pixels of drawtext's boxes. `textpng.test.ts` reads the pictures
Chrome draws back pixel by pixel. They are skipped where ffmpeg and ffprobe are not installed; the
Chrome tests also where no Chrome or Chromium starts (`PW_CHROMIUM_PATH`, else Playwright's own).
