# Sample text for `npm run headstart`

> **Participant of a demo take: do not open the texts, `plan.json` or the WAV files in this folder
> before the take, and do not play the clips** (PREREG.md §11, spec 7.11). This README is the only
> file here that is safe to read: it names no topic, no word and no time. A take shows the
> mechanism best when you hear the passages for the first time, on camera. If you opened a file by
> mistake, say so before the take.

## What it is

The public sample text of the live demo mode: a short personal blog draft in plain spoken English,
on an everyday topic that anyone can follow without special knowledge. The narrator voice
(`tools/tts`: Kokoro-82M, voice `af_heart`, speed 1.0) reads it back as if it were the
participant's own draft. Some of its words are planted errors: obvious slips that anyone hears at
once and can correct aloud in three to five words. The participant has not seen the text and says
each correction aloud (spec 1, 15.1).

| Clip | Length | Planted errors |
|---|---|---|
| `opening` | about 60 s | none: the chest detector learns ordinary breaths while the narrator reads it (spec 7.4) |
| `p1` | about 55 s | 3 |
| `p2` | about 45 s | 2 |

The changed words of each planted error close their sentence, with at most one word after them.
Each planted error starts at least 8 s into its passage and at least 12 s after the one before it
ends. The kinds vary: a number, a negation, a swapped fact. `tools/sample/plan.ts` holds these
rules, and `tools/sample/sample.test.ts` checks the stored files against them.

## How headstart uses it

`npm run headstart` (PREREG.md §11, Demo takes; spec 7.11) serves this folder to the page through
the narrator allow list of host (`live/lib/narrator.cjs`, list `sample`; `COPYHOLDER_SAMPLE_DIR`
moves the folder): `opening.wav`, `p1.wav`, `p2.wav` and `timings.json`, and `p3.wav` if the folder
had one (it has none). Nothing else here is ever served: not `plan.json`, not the texts, not this
README. The page plays the opening, then `p1` and `p2`, and takes the word times of a clip from
`timings.json` only when its `audioSha256` matches the clip it fetched (`docs/protocol.md`).

## Not blind

The plan is public: `plan.json` lists every planted error with its words and times, and the texts
lie next to it. So the sample is not blind (spec 7.11): its plan is in an open repository and no
seal is shown or checked. A take on it shows the narrator stopping on a fast rise of the chest trace
or on the voice. It is not confirmatory and has no sealed plan (PREREG.md §11): no number of the
study comes from it.

A demo take may come before gate packs B and C are recorded, so the sample shares nothing with the
gate packs (spec 9.2): no sentence and no run of eight words, as read or as corrected, and no
planted fact (no planted error shares two content words with a pack substitution, the rule
`gate/check-texts.ts` applies to published examples). `tools/sample/sample.test.ts` checks this
the way `tools/freeze/level-sample.test.ts` checks the doctor sample: it prints counts and file
names only, never a word of a pack.

## Files

| File | What it holds |
|---|---|
| `texts/opening.txt`, `texts/p1.txt`, `texts/p2.txt` | The texts as the narrator reads them, planted errors included: UTF-8, one paragraph per line, only letters, spaces, periods and commas |
| `opening.wav`, `p1.wav`, `p2.wav` | The clips: 16-bit PCM WAV, mono, 48 kHz, stored as the gate packs store theirs (`gate/README.md` step 5): the sample count of the render, at the loudness of the doctor sample `gate/level/level.wav` (RMS within 3 dB) |
| `timings.json` | Start and end of every word of every clip by word number, with its sentence number and no text: one `timings-set/1` file (`tools/tts/README.md`) with the SHA-256 of each WAV as stored here |
| `plan.json` | The public plan, schema `sample-plan/1` (below) |

## `plan.json`

`passages` lists each clip: `passage_id`, `text_file` with its `text_sha256`, `audio_file` with its
`audio_sha256` (as in `timings.json`), `duration_ms`, `word_count`, `sentence_count` and
`error_count`. `errors` lists each planted error in reading order:

| Field | Meaning |
|---|---|
| `error_id` | `sample-e1`, `sample-e2`, ... |
| `passage_id` | `p1` or `p2` |
| `class` | `number`, `negation` or `swapped_fact` |
| `sentence_index` | Number of the sentence in its passage, from 0, as `timings.json` counts sentences |
| `replacement` | The changed words, as the narrator reads them |
| `original_span` | What is right: the words the sentence should hold instead |
| `planted_sentence`, `original_sentence` | The sentence as the narrator reads it, and as it should be |
| `word_start`, `word_end` | First and last changed word (inclusive): word numbers of `timings.json`, from 0 |
| `span_start_ms`, `span_end_ms` | Start of `word_start` and end of `word_end`, in ms from the first sample of the clip |
| `sentence_end_ms` | End of the last word of the sentence |

The names follow the sealed plan of spec 8.3 where they mean the same thing. Unlike a sealed plan,
this one has no salt, no planter fields and no seal.

## Build it again

`error_id`, `passage_id`, `class`, `sentence_index`, `replacement` and `original_span` are written
by hand; the build adds everything else. After a change to a text or to the narrator engine:

1. Render each text with the narrator voice, one at a time, into a folder outside the repository,
   on a machine with the TTS environment (`tools/tts/README.md`). Its messages name words by
   number, never by text.

   ```sh
   OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 npm run tts -- sample/texts/opening.txt <dir>/opening.wav <dir>/opening.timings.json
   OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 npm run tts -- sample/texts/p1.txt <dir>/p1.wav <dir>/p1.timings.json
   OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 npm run tts -- sample/texts/p2.txt <dir>/p2.wav <dir>/p2.timings.json
   ```

2. Store them:

   ```sh
   npm run sample:build -- --from <dir>
   ```

   It checks every render against its text, stores the 16-bit clips, joins the word timings over
   the stored clips with `npm run tts -- --set`, writes `plan.json` and checks every rule of
   `tools/sample/plan.ts` and the banned words in a temporary folder; on any problem nothing here
   changes. It ends with `SAMPLE OK` or `SAMPLE FAIL`. Its output, also on failure, gives clip
   lengths, levels, counts, rules and error ids, and no word of the texts and no time inside a
   clip. With `--show-text` (here, and with `npm run tts` in step 1) it adds the words, word
   numbers and times behind each problem: the texts are public, but use it only where the
   participant of a demo take cannot see the screen.

3. Check: `npx vitest run tools/sample tests/live/narrator-sample.test.ts`. A failure there prints
   no word and no time inside a clip either.

The voice reads about 3.2 words per second here, pauses included (Kokoro 0.9.4 on Linux,
20 November 2026), so a clip of 60 s takes about 190 words.

`npm run lint:words` checks this README only, because it prints the line of every hit; the build
and `tools/sample/sample.test.ts` check the texts and `plan.json` for banned words by file and
line (spec 13.6).

## Licence

The texts and `plan.json` are released under CC0 1.0 (spec 13.6), and so are `timings.json` and the
clips rendered from them. The voice is Kokoro-82M, whose weights are under Apache-2.0
(`tools/tts/README.md`).
