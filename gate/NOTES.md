# Gate packs: design notes

> **Not for the participant before the day-1 recording** (spec 9.2, see `README.md`). These notes
> name no topic, word or cue time, but they describe how the planted errors are placed.

Everyone else: the texts are public (spec 7.7). There is no sealed plan for them; the only secret
is procedural, from the participant, until the recording is made.

## Files of a pack

- `listen.txt`: the listening passage, plain text without errors.
- `objections.txt`: the objection passage. Each planted error is marked
  `[[wrong phrase|right phrase]]`. The narrator speaks only the wrong phrase; the right phrase is
  never spoken and only documents the fix.
- `listen.predicted.json`, `objections.predicted.json` (`gate-predicted/1`): the SHA-256 of the
  spoken text and its word timings (`timings/1`, as `tools/tts` writes them), from
  `gate/predict_timings.py`.
- `objections.spoken.txt`: the text `npm run tts` renders, the markup replaced by the wrong
  phrase (`--spoken`).
- After the render: `listen.wav`, `listen.timings.json`, `objections.wav`,
  `objections.timings.json`. The WAV files are stored as 16-bit PCM, mono, 48 kHz (see "Audio").
  After the build: `cues.json` and `pack.json`.

No other file belongs in a pack folder, in particular no second, readable copy of the cue list;
the checker refuses one. Every line of a passage is one paragraph and one Kokoro segment, and
ends with a period.

## Word timings: computed, not estimated

The first version estimated times from a fixed words-a-minute tempo. Real renders read gate prose
at 184 to 215 words a minute, so the cues sat at the limits of spec 9.2 (review 1).

`tools/tts/tts.py` takes every word time from Kokoro's own models, by the rule
`copyholder-times/1` (`engine.timeRule`, `tools/tts/README.md` "Times"): the duration model
(`pred_dur`, in units of 25 ms) places the words, and next to punctuation and at chunk edges the
edge moves onto the pause in Kokoro's predicted energy curve, which is computed before the
vocoder. The vocoder only turns all this into sound. `gate/predict_timings.py` runs the render of
`tts.py` itself with the vocoder replaced by silence of the same length, so it gives the word
timings of a full render of the same text with the same lock, in about a minute for all packs. A
full render of a neutral 133-word passage (`fixtures/render/`, the WAV file not committed)
matches its prediction in every word time and in its sample count; a test keeps that record. The
texts were tuned on these exact timings.

13 November, after the change of `tools/tts` to `copyholder-times/1`: the fixture was rendered
again and still equals its prediction to the millisecond (133 words, same sample count), so the
predictor stayed as it is; the fixture files and every `*.predicted.json` were made again. Each
of the eight pack renders equals its prediction in every word time. Under the new word edges two
rules failed on pack C: the placement rule between B and C (5 of 13 intervals differed by 1 s or
more) and the design room of one interval. One paragraph of pack C's objection passage changed
by one word added and one word removed, which moves one cue and passes every rule with the 1.5 s
of room unchanged; pack C was predicted, rendered and checked again.

13 November, later: one error of pack A's objection passage shared its fact with the example
error that spec 9.2 quotes (review 11). It was replaced by another error in the same sentence,
with the same kind of change. Pack A was predicted, rendered, checked and built again with
`gate/render-packs.ts --force A`; its listening clip came out byte for byte the same, its
objection clip runs 296.95 s, and every rule passes with the 1.5 s of room. The real cues of A
differ from those of B in 13 of 14 times and 8 of 13 intervals, from those of C in 13 and 6
(B and C: 12 and 6, unchanged). Only the objection files, `cues.json` and `pack.json` of pack A
changed; packs 0, B and C did not.

Kokoro chooses its style vector from the phoneme length of each chunk, so a small edit in a long
paragraph can move every later word by a second or more. Run the predictor after every edit; the
checker refuses timings of another text (the SHA-256 of the spoken text).

## Cue rules (spec 9.2, 9.4)

A cue starts at the end (`endMs`) of the last word of the wrong phrase. The rules of spec 9.2:
first cue at 15 s or later, 16 to 24 s between cues, last cue at 265 s or earlier, timed from the
start of the objection clip. After the last cue the passage reads on for at least 10 s, the voice
window of spec 9.4 and 9.6 (assumption).

On the predicted timings every limit keeps 1.5 s of room: first cue at 16.5 s or later, 17.5 to
22.5 s between cues, last cue at 263.5 s or earlier, and 11.5 s of reading after it. The build
checks the real timings against the limits of spec 9.2 themselves.

Clip lengths, one-sided on the real render: the listening clip at most 180 s and the objection
clip at most 300 s, the blocks of spec 9.3 (pack 0: 30 s and 60 s, assumption). A longer clip
would stretch its block (`web/scenarios/gate.ts`). The predicted clips stay in 170 to 178.5 s and
288 to 298.5 s (pack 0: 26 to 28.5 s and 46 to 58.5 s). Pack 0 runs about 27 s and 52 s.

## Placement (spec 9.2, 7.8; review 3)

- Packs A, B and C place their cues differently, not as one rhythm shifted: between any two of
  them, at least 12 of the 14 cue times differ by 2 s or more and at least 6 of the 13 intervals
  differ by 1 s or more. The intervals of each pack spread over at least 3 s. Checked on the
  predicted cues, and again on the real cues at the build.
- No error is the last word of its paragraph, where the narrator pauses longest. At most a third
  of the errors end their sentence. None is in the first or the last sentence of a passage.
- In A, B and C at least two paragraphs hold two errors, and at least two paragraphs before the
  last error hold none, so a paragraph break does not tell what comes.

## Text rules

- Letters, spaces, periods and commas only, with a space after every period and comma. No
  digits, apostrophes, hyphens, quotes or abbreviations. The checker numbers the words as
  `splitPassageWords` of `tools/tts/words.ts` does: word *i* of the spoken text is word *i* of
  `timings.json`.
- Sentences of at most 30 words. Neutral expository prose: nothing about breathing, the body,
  health, feelings, the listener or the recording, and no living people.
- Each substitution swaps one or two words for one or two words, one per sentence, with at least
  two words before it in a sentence of 8 to 30 words (spec 7.8 item 4 allows 8 to 40). It
  contradicts a plain everyday fact, so a correction of three to five words always exists.
- The wrong word sounds different from the right one (spec 7.8): another first letter, or an edit
  distance of at least half the word. No teen and ty numbers, and numbers at least 2 apart. The
  right word is not spoken within 50 words of the error, and no word is changed twice in a pack.
- No error repeats an example error that the spec quotes (spec 9.2, table, row A; copied into
  `SPEC_EXAMPLES`, since the spec is not in the repository) or that a document the participant
  reads quotes in straight or curly double quotes or guillemets: the Markdown files of the
  repository root (`PREREG.md`, `README.md`, ...), `docs/*.md` and every `README.md` up to three
  folders deep (review 11). An error repeats an example when its changed words, the unchanged
  words of its phrase and the two words on either side share two content words with the example
  (lower case, a plural s dropped, function words ignored), so the same fact with another number
  counts too.
- None of the banned words of spec 13.6 in any text file of this folder (`gate/level/` belongs to
  `doctor` and is checked there): the lists and the matcher of `lint:words`.

## Rules across packs (spec 9.2; review 9)

A participant who heard pack 0 and pack A should not recognise an error of B or C. Across packs:
a wrong word appears in one pack only, no pair returns reversed, the unchanged word of a phrase
(the noun of a count) appears in one pack only, the two words before a wrong phrase differ, and
each class of fact (weekdays, months, seasons, times of day, directions) is changed in one pack
only. No two passages share a run of eight words.

## Audio

- `npm run tts` writes 32-bit float WAV files. A pack stores each clip as 16-bit PCM, mono,
  48 kHz, with the same sample count, converted as the `doctor` level sample is
  (`gate/level/wav16.ts`): every sample times 32768, rounded and clamped. That halves the size in
  git, about 143 MB for the four packs instead of about 285 MB. The page decodes both formats
  alike (`web/ui/wav.ts`), host serves the bytes that `pack.json` names
  (`live/lib/narrator.cjs`), and the build refuses a pack WAV file in any other format.
- `doctor` sets the volume with `gate/level/level.wav`, so a pack clip should play at its
  loudness. `gate/render-packs.ts` compares the RMS of each whole clip with the RMS of
  `level.wav`. Within 3 dB the clip is stored as it is. Further away, every sample is scaled by
  one gain towards the RMS of `level.wav`, as far as a peak of -1 dBFS allows. A clip whose peak
  would clip at 16 bits (`PCM16_CLIP_DBFS`, 20 log10(32767.5/32768) dBFS) always gets at least
  the cut to a peak of -1 dBFS, also within 3 dB (review 17). A clip that still lies more than
  3 dB away is refused, and so is a clip with a sample that is not a number (it counts as
  clipped). No stored clip has a clipped sample.
- In `doctor`, host serves `gate/level/level.wav` itself: its doctor source reads `gate/level/`
  (`resolvePaths().levelDir`, `live/lib/paths.cjs`) before `sample/` (`live/host.cjs`,
  `live/lib/narrator.cjs`). A test reads it through `narrator.cjs` as host does and compares it
  byte for byte (review 14).
- 13 November: `level.wav` has an RMS of -25.55 dBFS and a peak of -6.31 dBFS. The eight clips
  lie at -25.89 to -25.57 dBFS RMS, at most 0.34 dB from it, with peaks of -6.01 to -0.91 dBFS
  and no clipped sample. No clip needed a gain, so every stored clip is the plain 16-bit
  conversion of its render. The same holds after the new objection clip of pack A.

## Build outputs (spec 9.2; review 4 and 7)

- `cues.json`: a JSON array of cue start times in ms from the start of the objection clip
  (`docs/protocol.md`). `PREREG.md` 7.1 takes it as the stored cue list of spec 9.2 and records
  the SHA-256 of its exact bytes (assumption there: no separate encoded copy). Spec 9.2 asks for
  the cue list to be kept as an unreadable block; `cues.json` is plain JSON that the page fetches
  as it is. Encoding it changes the page, `docs/protocol.md` and `PREREG.md` together, so it is
  left to a decision across those modules (review 15, open). Until then the rule of `README.md`
  holds: the participant opens nothing in this folder.
- Once `PREREG.md` holds a pack's cue hash (its row no longer holds `{{CUES_SHA256_X}}`, read as
  `tools/freeze` reads the table), `--build`, `gate/render-packs.ts` and the checker refuse a
  `cues.json` with other bytes. A rebuild after the `gate-prereg` tag leaves `cues.json` byte for
  byte the same or changes nothing (spec 9.2, 13.6; review 12). `--prereg <file>` reads another
  `PREREG.md`.
- `pack.json` (`gate-pack/1`): `files` maps each served file (`cues.json`, both WAV files, both
  timings files) to its SHA-256, in the form host reads (`live/lib/narrator.cjs`); `spoken`
  holds the SHA-256 of the text each clip was rendered from.
- `--build` writes both only for a rendered pack without any problem, text rules included. The
  real word times must match the prediction within 50 ms (`--tolerance-ms`), which also ties the
  render to the current text, since `timings.json` carries no text. Each WAV file must match its
  timings in rate, channels and length, and be 16-bit PCM (see "Audio"). A problem of the folder
  as a whole, such as a banned word in this file, blocks every pack.
- Later runs of the checker verify `pack.json` against the files and the texts, so an edit after
  the build, even of one wrong word, is reported.
- `gate/render-packs.ts` runs steps 3 to 7 of `README.md` for the packs it is given (all four by
  default). It renders each passage with `npm run tts` in a temporary folder outside `gate/`, one
  at a time; the render input of the objection passage is written there too. Both 16-bit clips
  and their timings are then checked there with every check of the build (`checkRealPacks`: the
  prediction within the tolerance, the cue rules and clip lengths of spec 9.2, the WAV format,
  the placement against the other packs' installed renders, the cue hashes of `PREREG.md`). Only
  when all pass are they moved into the pack folder, each through a dot file and a rename, and the
  build writes `cues.json` and `pack.json`; a refused render leaves the pack folder byte for byte
  as it was (review 12). A render that exits with 128 or more was stopped by a signal
  (`tools/tts/run.ts`: 128 plus the signal number, 130 for Ctrl+C): the run stops there, renders
  no other passage or pack, installs and builds nothing, and exits with that code (review 13). It skips
  a pack that is built and current unless `--force`: `pack.json` exists, the checker reports no
  problem of the pack or the folder, both WAV files are 16-bit PCM, mono, 48 kHz, and both
  timings files come from the engine of the prediction and match it within the tolerance. It
  renders nothing for a pack whose texts or predicted timings have a problem. `--convert` renders
  nothing: it stores the float WAV files that `npm run tts` wrote into the pack folders as 16-bit
  PCM, then builds and checks.

## Blind output (spec 9.2; review 5)

The checker and the predictor print pack numbers, counts, clip lengths, rule names, OK or FAIL and
hashes. `--show-text` adds the words behind each problem and the predicted cue times.
`gate/render-packs.ts` has no such option: it prints pack numbers, passage kinds, clip lengths,
levels, gains, sizes, OK or FAIL and hashes, and calls `npm run tts` without `--show-text`.

A blind message names the rule only. The kind of word behind a problem (teen and ty, numbers less
than 2 apart, the class of fact), the example an error repeats and the words themselves are in
the detail, which only `--show-text` prints (review 16).

## Assumptions

- 1.5 s of room on the predicted timings; 50 ms default agreement between render and prediction.
- At least 10 s of reading after the last cue (voice window, spec 9.4 and 9.6).
- Clip ranges as above; pack 0 at most 30 s and 60 s on the real render.
- The placement thresholds (12 of 14 cues by 2 s, 6 of 13 intervals by 1 s, a 3 s spread), the
  paragraph rules and the cross-pack rules are this module's reading of "another cue layout" and
  "another text" (spec 9.2).
- `cues.json` is the stored cue list (`PREREG.md` 7.1); `objections.spoken.txt` is the render
  input of the objection passage.
- Two shared content words make an error a repeat of a published example; the documents the
  participant reads are those listed above (review 11).
- Pack clips are stored as 16-bit PCM like the level sample. A clip plays at the loudness of
  `level.wav` when the RMS of the whole clip lies within 3 dB of the RMS of `level.wav`; a clip
  outside that range gets one gain, with its peak at or below -1 dBFS. No current clip needed one.
- `gate/level/level.timings.json` was made again on 13 November with `gate/level/render.ts`: the
  old file came from the rule before `copyholder-times/1`, which the current sound check of
  `tools/tts/timings.ts` refuses. `level.wav` came out byte for byte the same.

## Tests

```sh
npx vitest run gate/check-texts.test.ts gate/render-packs.test.ts
npx tsc --noEmit -p tsconfig.json
```

The root `vitest.config.ts` and `tsconfig.json` include `gate/`. The local configs
(`--config gate/vitest.config.ts`, `-p gate/tsconfig.json`) still work. The tests of
`render-packs.ts` replace `npm run tts` with a fake render, which finds the predicted timings of
the text it is given, and work on a copy of the texts and predictions in a temporary folder; one
test checks the committed packs themselves.

CI logs are public, so no test file of `gate/` holds pack content (review 10). The rule tests use
made-up passages; anything pack-specific (a substitution to quote, a word to ban, a word to move)
is taken from the pack files at run time, and assertions on the real packs compare counts, hashes
and blind lines only. A guard test reads the packs and fails when a test file of `gate/` shares
with a pack text a `[[...]]` markup, a run of five words (as spoken or as corrected) or a rare
content word: five letters or more, in the texts of one pack only, and in none of this module's
code and docs. It prints counts only; whoever may read the packs finds the words privately.

Reviews 10 to 17 are the second review of the packs: 10 no pack content in tests, 11 published
examples, 12 check before install and the cue hashes of `PREREG.md`, 13 a stopped render, 14 the
level sample in `doctor`, 15 the readable `cues.json` (open), 16 blind messages, 17 the cut of a
clipping peak.
