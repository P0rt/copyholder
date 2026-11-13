# Day-1 gate packs

> **Participant: do not open anything in this folder before the day-1 recording** (spec 9.2).
> Do not read, play or search its files, and do not ask for a summary of them. This README is
> the only file here that is safe to read: it names no topic, no word and no time. The recording
> only measures what it should if you hear the passages for the first time, on camera. If you
> opened a file by mistake, say so before recording.

Pack 0 is the short probe (`npm run gate -- --pack 0`) and pack A is the gate
(`npm run gate -- --pack A`). Pack B serves the one re-recording on content; pack C replaces B
when B went to a technical re-recording (spec 9.2, 9.4).

## Build the audio and the cue lists

Run these commands from the repository root, in this order, on the machine that renders: the
cloud, or the Mac if Kokoro does not install in the cloud (spec 9.2, 14). Their output names no
word of the passages and no cue time: only pack numbers, counts, clip lengths, levels, OK or
FAIL and hashes. `--show-text` prints the words and the cue times: never use it where the
participant can see the screen before the recording.

1. Word timings from Kokoro's own models, without audio (about a minute; on the machine that
   renders, so that the build can compare its render with them):

   ```sh
   OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 uv run --locked --project tools/tts python gate/predict_timings.py
   ```

2. Check the texts and the cues on those timings. It must end with
   `OK: 4 packs pass every rule.`

   ```sh
   npx tsx gate/check-texts.ts
   ```

3. Write the text the narrator speaks for each objection passage (`objections.spoken.txt`):

   ```sh
   npx tsx gate/check-texts.ts --spoken
   ```

4. Render every pack, for X = 0, A, B and C, one render at a time (each takes about half as long
   as its clip):

   ```sh
   OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 npm run tts -- gate/pack-X/listen.txt gate/pack-X/listen.wav gate/pack-X/listen.timings.json
   OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 npm run tts -- gate/pack-X/objections.spoken.txt gate/pack-X/objections.wav gate/pack-X/objections.timings.json
   ```

5. Store the audio as 16-bit PCM WAV files (mono, 48 kHz, the same sample count), as the doctor
   level sample is stored. `npm run tts` writes 32-bit float, twice the size in git, and the build
   refuses it. A clip whose RMS lies more than 3 dB from `gate/level/level.wav`, the sample
   `doctor` sets the volume with, is scaled to its RMS with one gain, its peak at or below
   -1 dBFS. A clip whose peak would clip at 16 bits is always cut to a peak of -1 dBFS, and
   refused if that cut leaves it more than 3 dB from `level.wav`. This command also runs steps 6
   and 7:

   ```sh
   npx tsx gate/render-packs.ts --convert
   ```

6. Build. For every rendered pack without a problem this writes `cues.json`, the cue list the
   page fetches (a JSON array of cue start times in ms, `docs/protocol.md`), and `pack.json`,
   the files host may serve with their SHA-256 (`live/lib/narrator.cjs`):

   ```sh
   npx tsx gate/check-texts.ts --build
   ```

   It prints `pack X: built; cues.json SHA-256 <hash>`. That hash goes into `PREREG.md` as
   `{{CUES_SHA256_X}}` before the `gate-prereg` tag (spec 9.2, 8.4). A pack with a problem gets
   no `cues.json` and no `pack.json`; fix the cause, render it again and build again.

   Once `PREREG.md` holds a pack's hash, every later build, `gate/render-packs.ts` and the checker
   refuse a `cues.json` with other bytes: a rebuild after the tag leaves `cues.json` byte for byte
   the same, or fails and changes nothing (spec 9.2, 13.6). `--prereg <file>` reads another
   `PREREG.md`.

7. Run `npx tsx gate/check-texts.ts` once more. It now also checks `pack.json` and `cues.json`
   against the files and the texts. Commit the pack folders. After the tag nothing in this
   folder changes.

If the build reports word times that differ from the prediction, the timings were computed on
another machine or from another text: run step 1 on the machine that renders, then steps 2 to 6.
`--tolerance-ms <n>` (default 50) sets the largest difference the build accepts.

### Steps 3 to 7 in one command

```sh
npx tsx gate/render-packs.ts            # every pack; or name some: npx tsx gate/render-packs.ts B C
npx tsx gate/render-packs.ts --force A  # render pack A again even if it is built and current
```

Run steps 1 and 2 first. It renders one passage at a time in a temporary folder outside `gate/`
and stores the 16-bit clips there. Before anything goes into the pack folder, the new clips and
timings are checked there with every check of the build: the prediction, the cue rules and clip
lengths of spec 9.2, the WAV format, the placement against the other packs and the hashes of
`PREREG.md`. A render that fails one is not installed, and the pack folder stays byte for byte as
it was. Then it builds and checks the folder.

It skips a pack that is built and current: `pack.json` matches the files and the texts, the
checker reports no problem, the WAV files are 16-bit and both timings files equal the prediction.
It renders nothing for a pack whose texts or predicted timings have a problem. A render stopped
by a signal, such as Ctrl+C (exit code 128 or more), stops the whole run: no other passage or
pack is rendered, nothing is installed or built, and the command exits with that code.

## Files of a pack folder

`listen.txt`, `objections.txt`, `listen.predicted.json`, `objections.predicted.json`,
`objections.spoken.txt`, `listen.wav`, `listen.timings.json`, `objections.wav`,
`objections.timings.json`, `cues.json` and `pack.json`. The checker refuses any other file.

The design of the texts, the rules the checker enforces and the assumptions behind them are in
`NOTES.md`. It is not safe for the participant to read before the recording.

The texts are released under CC0 (spec 13.6).
