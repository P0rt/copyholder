# Narrator voice: `tools/tts`

Renders an English passage into the narrator's voice: one WAV file (mono, 48 kHz, 32-bit float)
and one `timings.json` with the start and end of every word (spec 7.7). The engine is
Kokoro-82M with the voice `af_heart` at speed 1.0. All narrator audio is rendered in advance;
nothing is synthesized while the camera runs.

The tool is Python 3.12 in its own environment, managed by [uv](https://docs.astral.sh/uv/).
`npm run tts` (script `tsx tools/tts/run.ts`) calls uv for you.

## Setup

1. Install uv once:
   - macOS with Homebrew: `brew install uv`
   - macOS or Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`
2. From the repository root, run the selftest:

   ```sh
   npm run tts -- --selftest
   ```

   The first run creates `tools/tts/.venv` from `uv.lock` (about 360 MB of downloads on Linux,
   230 MB on a Mac; 1.3 GB on disk; uv fetches Python 3.12 if the machine has none) and
   downloads the model weights (328 MB, see below). It ends with one line:
   `TTS SELFTEST OK <words> <ms>`.

Supported machines:

| Machine | PyTorch |
|---|---|
| Mac with Apple silicon, macOS 14 or newer | wheels from PyPI |
| Linux x86_64 | CPU-only wheels from `https://download.pytorch.org/whl/cpu`, so no CUDA packages |

`uv.lock` is universal: one file for both machines. `required-environments` in
`pyproject.toml` makes `uv lock` fail if a pinned package loses its wheels for either machine.
`run.ts` passes `--locked`, so a render never changes the lock. `tools/tts/.venv` stays out of
git (`.gitignore`).

## Commands

```sh
npm run tts -- <in.txt> <out.wav> <out.timings.json>
npm run tts -- - <out.wav> <out.timings.json> < in.txt              # passage on stdin
npm run tts -- --selftest
npm run tts -- --show-text <in.txt> <out.wav> <out.timings.json>   # public texts only
npm run tts -- --set <timings.json> opening opening.wav opening.timings.json p1 p1.wav p1.timings.json ...
```

Without npm, from the repository root:

```sh
uv run --project tools/tts python tools/tts/tts.py <in.txt|-> <out.wav> <out.timings.json>
uv run --project tools/tts python tools/tts/tts.py --selftest
```

- **Input:** UTF-8 text, one paragraph per line: do not hard-wrap paragraphs. `-` reads the
  passage from stdin, so a draft never needs a plaintext file. A line break ends a sentence for
  `words.ts` (`Intl.Segmenter`) and a voice segment for `tts.py`. Inside a line, any run of
  whitespace counts as one space. Text in the form `[text](target)` is refused: the English
  front end would read it as pronunciation markup.
- **Render:** prints `TTS OK <n> words <m> sentences <ms> ms (load .., render .. = .. x real time)`
  and exits 0. On failure it prints `TTS FAIL: <reason>` on one line to stderr and
  exits 1. Before it writes anything, `tts.py` checks the word times against the sound (see
  **Times**). `run.ts` passes uv's exit code through (128 + n after signal n), then checks that
  `timings.json` numbers the same words as `words.ts` and describes the WAV that was written:
  32-bit float, one channel, 48 000 Hz, `durationSamples` samples.
- **Messages name words by number, never by text,** because `npm run plant` renders sealed drafts
  (spec 7.8, 8.2). A line number in a message is the line of the input file, counted from 1;
  CRLF counts as one line break, and so do CR, LF, NEL, LS and PS alone, so blank lines count
  too. `--show-text` adds the text to error messages; use it for public texts only.
- **Selftest:** renders the fixed phrase in `selftest.json` (31 words, about 10.6 s) into a
  temporary folder and checks: WAV header and decoded audio (IEEE float, 1 channel, 48 000 Hz,
  32 bit); `durationSamples` and `durationMs` against the WAV; word count equal to the count
  `words.ts` gives for the phrase (stored with it); sentence numbers; `startMs < endMs` for every
  word; no word starting before the previous one ends; last `endMs` not after the end of the
  audio; word times against the sound; duration within 7 to 14 s; peak level.
- **One selftest line:** `npm run tts -- --selftest` prints exactly one line on stdout,
  `TTS SELFTEST OK <n words> <duration ms>` or `TTS SELFTEST FAIL: <reason>`, and exits 0 or 1
  (doctor reads it, spec 7.7). `run.ts` reads the stdout of uv and `tts.py` and sends every
  other line to stderr. When uv fails before `tts.py` prints its line (a stale `uv.lock`, no
  network on the first sync), it prints `TTS SELFTEST FAIL: uv exited with code <n> before the
  selftest printed its result`; after a signal, `TTS SELFTEST FAIL: stopped by <SIGNAL>`.
- **uv missing:** `run.ts` prints how to install it and exits 127 (the selftest prints
  `TTS SELFTEST FAIL: uv not found` and exits 1). Set `UV=/path/to/uv` if uv lives somewhere
  unusual. Only an executable file counts: a folder or a file without the execute bit named
  `uv` is skipped, and the search goes on.
- **Ctrl+C:** while uv runs, `run.ts` leaves SIGINT and SIGTERM to uv and Python and returns
  their exit code. It stops ignoring them when the child exits or cannot start.

## Drafts stay private

`npm run plant` renders the user's own draft with planted errors, and the user must not hear it
before the reveal (spec 7.7, 7.8, 16 risk 19). So:

- `tts.py` and `run.ts` write every output with mode 0600, through a temporary file in the
  same folder, so other users of the machine cannot read it.
- Pass the planted text on stdin (`-`), not as a file.
- The planter should render into a private temporary folder (`mkdtemp`, mode 0700), seal the
  WAV and `timings.json` into the sealed folder (AES-256-GCM, spec 8.2) right away, and delete
  the plaintext outputs after sealing, also when sealing fails.

## The WAV file

RIFF/WAVE with a `fmt ` chunk (format 3, IEEE float; 1 channel; 48 000 Hz; 32 bit), a `fact`
chunk and the `data` chunk. There is no `PEAK` chunk or any other dated metadata, so the bytes
depend only on the samples. Kokoro produces 24 kHz; soxr (quality VHQ) doubles the rate without
delay, so native sample `n` is output sample `2n` (a unit test checks this). The torch seed is
fixed at 0: the same machine and lock give the same bytes. Another CPU or PyTorch build may
differ in the last bits of the samples.

## `timings.json`

```json
{
  "schema": "timings/1",
  "wordRule": "copyholder-words/1",
  "sampleRateHz": 48000,
  "durationSamples": 508800,
  "durationMs": 10600,
  "wordCount": 31,
  "sentenceCount": 3,
  "engine": {
    "name": "kokoro", "kokoroVersion": "0.9.4", "misakiVersion": "0.9.4", "torchVersion": "2.15.0+cpu",
    "modelRepo": "hexgrad/Kokoro-82M", "modelRevision": "f3ff3571791e39611d31c381e3a41a3af07b4987",
    "modelFile": "kokoro-v1_0.pth", "modelLicence": "Apache-2.0", "voice": "af_heart", "speed": 1.0,
    "langCode": "a", "seed": 0, "nativeRateHz": 24000, "resampler": "soxr 1.1.0 VHQ",
    "timeRule": "copyholder-times/1"
  },
  "correctedChunks": 0,
  "words": [
    {"index": 0, "startMs": 313, "endMs": 425, "sentenceIndex": 0},
    {"index": 1, "startMs": 425, "endMs": 950, "sentenceIndex": 0}
  ]
}
```

(`engine` is shown on fewer lines than the tool writes; `words` is cut after two entries.)

| Field | Meaning |
|---|---|
| `schema`, `wordRule` | Format version and word numbering rule. `timings.ts` refuses other values |
| `durationSamples`, `durationMs` | Length of the WAV at 48 kHz, and the same in ms |
| `wordCount`, `sentenceCount` | Number of entries in `words`; last `sentenceIndex` + 1 |
| `engine` | Package versions, model repository and revision, voice, speed, seed, resampler, and `timeRule`: how the word edges were placed (see **Times**; files rendered before the rule have none) |
| `correctedChunks` | Kokoro chunks where kokoro's own word times are off and the recomputed ones were used (see below) |
| `words[k].index` | Word number `k`, counted from 0, as `words.ts` numbers the passage |
| `words[k].startMs`, `endMs` | Start and end of the word in whole ms from the first sample of the WAV |
| `words[k].sentenceIndex` | Number of the sentence that holds the word, counted from 0 |

There is no text in the file: no words, no passage (spec 7.7, 8.2). `timings.ts` parses and
checks the file: `sampleRateHz` must be 48 000, word 0 must be in sentence 0, sentence numbers
grow by at most one per word, and a file without words has `sentenceCount` 0.

**Words.** `splitPassageWords` in `words.ts` defines them, and `words.py` mirrors it for the
Python side. A word is a maximal run of non-whitespace characters that holds at least one
letter or digit (Unicode `L` or `N`). Punctuation stays with its word (`aloud,` is one word);
runs without a letter or digit (`—`, `...`, `&`) are not words. Sentences come from
`Intl.Segmenter('en', { granularity: 'sentence' })`, as in the planter (spec 7.8). A word
belongs to the sentence that holds its first character, and sentence numbers count only
sentences with words in them. A symbol standing alone is no word, but the voice may read it
aloud (`&` "and", `%` "percent", `+` "plus", `=` "equals"). That would be speech without a word
number, which the player would skip on a resume (spec 6.4), so `tts.py` stops with
`line <n>: a symbol after word <k> (sentence <s>) is read aloud but is no word; spell it out or
remove it`. The planter's normalization (spec 7.8 step 1) spells such symbols out.

**Times.** Times are whole ms, rounded half up from 48 kHz samples. For every word
`startMs < endMs`, and no word starts before the previous one ends. Kokoro reads a passage in
tokens that do not always match these words: `It's` is `It` + `'s`, `$5.20` is `$` + `5.20`.
`tts.py` matches every token back to the text, gives it to the word that contains it, and takes
the span of all its tokens. Punctuation tokens are pauses, not words. A symbol token read aloud
inside a word (a `%` split off `10%`) widens that word. It stops with an error when a token
cannot be matched, a token with a letter or digit falls across two words, a word gets no
sound, or a symbol is read aloud between words.

All times come from kokoro itself (spec 7.7), by the rule `copyholder-times/1`
(`engine.timeRule`):

1. **Phoneme durations.** Kokoro's duration model gives every phoneme a number of 25 ms frames,
   and the vocoder turns frame `k` of a chunk into native samples `600k` to `600(k+1)`. A token
   spans its phonemes; each space between two tokens is split between them, so words inside a
   phrase touch. Kokoro's own `start_ts` and `end_ts` start every token 3 frames (75 ms) early;
   `tts.py` does not.
2. **Pauses.** The duration model gives most of a pause to the last phoneme before the
   punctuation: in the selftest phrase the `m` of `time.` gets 18 frames (450 ms). Kokoro also
   predicts an energy curve `N`, two values per frame, before the vocoder runs; where `N` is
   below 0 the audio stays under about -55 dBFS, while the release burst of a final stop keeps
   `N` above 0. Where punctuation lies between two words, the pause is the longest run of
   `N < 0` (at least 25 ms) from the start of the last phoneme of the first word to the end of
   the first phoneme of the next: the first word ends where the pause starts, the next word
   starts where it ends. Without such a run the two words meet in the middle of the
   punctuation. The first word of a chunk starts after the pause that opens it, and the last
   word ends where the closing pause starts. Every word keeps at least 12.5 ms.
3. **Sound check.** Before it writes anything, `tts.py` measures the rendered audio in 5 ms
   frames (RMS; a frame at -50 dBFS or louder is sound). It stops when sound lies more than
   100 ms from every word, or when a word next to a pause holds more than 100 ms of silence
   after its last sound or before its first. `soundProblems` in `timings.ts` is the same check.

Because the times come from the duration model and `N`, and not from the audio, the vocoder
does not change them: `gate/predict_timings.py`, which replaces the vocoder with silence, gives
the same times as a real render.

On the selftest phrase, the 6 word ends before a pause lie 5 to 23 ms after the last sound,
and the 6 word starts after a pause 2 to 17 ms before the first sound (fixture test in
`timings.test.ts`, with 50 ms slack). Gaps between words are left only at punctuation: 125 and
162 ms at the commas, 200 ms at the colon, 488 and 500 ms at the full stops. On a 92 s passage
(289 words) the 31 word ends before a pause lie a median 15 ms (max 55 ms) after the sound, the
starts a median 5 ms (max 17 ms) before it, and no sound lies outside every word. Kokoro's own
times put a median 365 ms of silence at the end of a word before a full stop and 205 ms before a
comma or colon, and start every word about 75 ms early.

**Where the times come from.** Kokoro 0.9.4 computes `start_ts` and `end_ts` for each token
from the predicted phoneme durations (`KPipeline.join_timestamps`). `tts.py` repeats that
arithmetic without the 3-frame lead, adds the start of each chunk in the joined audio, and stops
if a value, with the lead put back, differs from kokoro's own. Kokoro's numbers are off in two
cases: phoneme characters that the model's vocabulary drops, and tokens with no phonemes that
are followed by a space. There `tts.py` uses its own numbers and counts the chunk in
`correctedChunks`.

## One `timings.json` for several clips: `timings-set/1`

The sealed folder keeps one `timings.json` next to `opening`, `p1`, `p2` and `p3` (spec 8.2),
and `sample/` uses the same layout. That file is a `timings-set/1` document:

```json
{
  "schema": "timings-set/1",
  "passages": [
    {
      "passageId": "opening",
      "audioSha256": "<SHA-256 of opening.wav, 64 lowercase hex digits>",
      "timings": { "schema": "timings/1", "...": "the clip's timings.json as tts.py wrote it" }
    },
    { "passageId": "p1", "audioSha256": "...", "timings": { "...": "..." } }
  ]
}
```

- `passageId` is the clip's file name without `.wav`: a lowercase letter, then up to 31
  lowercase letters, digits, `_` or `-`. Each id appears once.
- `audioSha256` is the SHA-256 of the clip's plain WAV bytes, the bytes host serves (in the
  sealed folder: before encryption). A timings entry cannot be paired with another WAV unnoticed.
- No other fields, so no text can travel in the file.

`npm run tts -- --set <out.json> <id> <wav> <timings> ...` builds it: it checks each
`timings.json` and that its WAV has the same rate, one channel and `durationSamples` samples,
hashes the WAV, writes the set with mode 0600 and prints `TTS SET OK <n> passages`.
`makeTimingsSet` and `timingsSetJson` in `timings.ts` do the same in code. A reader calls
`timingsForClip(json, 'p1.wav')`: a `timings/1` file is the clip's own, a set gives the entry
for that clip, or null.

## Model, licences and caches

| Item | Value |
|---|---|
| Model | Kokoro-82M, `hexgrad/Kokoro-82M` on Hugging Face |
| Revision | `f3ff3571791e39611d31c381e3a41a3af07b4987`, fixed in `tts.py` and written to `timings.json` |
| Files | `config.json` (2 KB), `kokoro-v1_0.pth` (327 MB), `voices/af_heart.pt` (0.5 MB) |
| Weights licence | Apache-2.0 (model card) |
| Voice | `af_heart`, American English, speed 1.0 |
| Python packages | `kokoro` 0.9.4 and `misaki` 0.9.4 (Apache-2.0); spaCy model `en_core_web_sm` 3.8.0 (MIT); soxr (LGPL-2.1 or later); for words outside its dictionary, misaki falls back to espeak-ng (GPL-3.0) through `espeakng-loader` |

None of these files is in the repository. The spaCy model is pinned in `pyproject.toml` as a
wheel URL with its hash in `uv.lock`, so nothing is fetched at run time.

The weights go to the Hugging Face cache on the first run: `~/.cache/huggingface/hub` on macOS
and Linux, or `$HF_HOME/hub` (or `$HF_HUB_CACHE`) when set. Later runs read them from there and
make no network requests; `HF_HUB_OFFLINE=1` works. uv keeps its downloads in `~/.cache/uv`, the
environment lives in `tools/tts/.venv`.

## Tests

```sh
npx vitest run tools/tts
uv run --project tools/tts python -m unittest discover -s tools/tts -p "test_*.py"
```

- `words.test.ts` checks `words.ts` against fixtures that `words.py` and `tts.py` wrote: the
  selftest phrase, its rendered `timings.json`, and edge cases (abbreviations, quotes, numbers,
  line breaks, Unicode spaces). It also checks `words.ts` with property tests.
- `timings.test.ts` checks `timings.ts`, `timings-set/1` and the WAV helpers. It runs the sound
  check on the committed selftest render (`fixtures/selftest.sound.json`: the level of every
  5 ms frame) and shows that kokoro's own times would fail it.
- `run.test.ts` checks `run.ts`: the one selftest line for every way uv can end, stdin, `--set`,
  the uv search, and child processes with a stand-in uv.
- `test_tts.py` checks the token time arithmetic against kokoro's `join_timestamps`, line
  numbers, the matching of tokens to text, the lone-symbol error, the pause placement, the sound
  check, the resampler alignment, the WAV header, file modes and stdin. `python.test.ts` runs it
  with `python3` inside `npx vitest run tools/tts`, so `npm test` and CI run it too; it skips
  without Python 3.10 or newer. Parts that need packages from the uv environment (kokoro,
  numpy, soxr) skip themselves under a plain `python3`.

After a change to `words.py`, `words.ts`, the selftest phrase, the time rule or the pinned
engine, write the fixtures again (`selftest.words.json`, `words-cases.json`,
`selftest.timings.json`, `selftest.sound.json`):

```sh
uv run --project tools/tts python tools/tts/make_fixtures.py
```

## Measured in the cloud container

Linux x86_64, 4 CPUs shared with other jobs, Python 3.12.3, uv 0.11.32, 12 November 2026.
Python ran with `OMP_NUM_THREADS=2`, so PyTorch used 2 threads.

| Step | Result |
|---|---|
| `uv sync --locked` with empty caches | 13 to 20 s (two runs); 96 packages |
| Downloads | about 360 MB on Linux (PyTorch CPU wheel 210 MB); from the wheel sizes in `uv.lock`, about 230 MB on a Mac (PyTorch 139 MB) |
| Environment on disk | 1.3 GB |
| Weights download | 328 MB; selftest with an empty Hugging Face cache: 29 s |
| Model load | about 6.4 s per run |
| Render | 0.43 to 0.59 x real time; the selftest phrase (10.6 s of speech) in 4.8 to 5.2 s |
| Selftest, warm | about 13 s from start to the result line |
| Repeat render | same machine and lock: byte-identical WAV and `timings.json` |

Word times of the selftest phrase against the sound: see **Times** above. A render with the
sound check and the energy capture takes as long as before.
