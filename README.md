# Copyholder

Copyholder is an experiment made for the DEV Presage SmartSpectra SDK Challenge (November 2026). A narrator voice reads a text aloud, and a few of its words are planted errors. When you catch one and draw breath to object, the narrator should go quiet on that in-breath, before your voice starts.

The breathing trace comes from the Presage SmartSpectra SDK, which reads it from the camera. The voice comes from a wired headset microphone. The app runs on a Mac as a local page in Chrome. Its only participant is the author. Copyholder is not a Presage product.

## How the claim is tested

The claim is that the chest trace stops the narrator before the voice more often than chance. The rules, thresholds and tests were written down before the data, in [PREREG.md](PREREG.md). Two git tags freeze them, and each is pushed before the first recording it governs:

- `gate-prereg` freezes `PREREG.md`, `params/frozen.json` (without the two values that stage A tunes) and the gate analysis code before the first gate recording.
- `gate-retune` freezes the parameters tuned on pack A (`params/frozen.json` and its copy `params/retune.json`) and the pooled analysis code before pack B is recorded.

`npm run freeze -- <tag>` stamps the tag's file with OpenTimestamps (`PREREG.md.ots`, `params/retune.json.ots`), commits the stamp, sets the tag and pushes the commit and the tag. The stamp dates the file, and a tag never moves.

Section 11 of PREREG.md, an amendment written on 20 November 2026 before any gate recording, replaced the numbers sessions of the first plan with two more gate packs, because the challenge deadline left no time for them. Pack 0, a short probe, and pack A are recorded as the day-1 gate; pack A gets the verdict, which is reported as written. Pack A then tunes the detector by a fixed rule (`npm run retune`), and `npm run freeze -- gate-retune` freezes the result before pack B is recorded. Packs B and C are recorded with those frozen parameters, and their valid objections, pooled, give the confirmatory numbers (`npm run confirm`).

## Results

There are no numbers yet. When packs B and C are recorded and analysed, this section will link `results/confirm.md`, which `npm run confirm` writes.

## Demo video

Coming after the demo take.

## Requirements

- A Mac with Apple silicon. The SDK's Node package, `@smartspectra/node-sdk` 3.5.0, has a macOS build for arm64 only (`@smartspectra/node-sdk-darwin-arm64`), and `host` opens Chrome through macOS. The package also has builds for Linux and Windows; they have not been tried here.
- Node.js 22.12 or newer. Node 24 is recommended.
- Google Chrome.
- A webcam.
- A wired headset. Bluetooth headsets give a 16 to 24 kHz microphone and add delay; the app records at 48 kHz.
- A Presage developer key from the [Presage developer portal](https://physiology.presagetech.com). The free tier's credits buy about 40 to 50 minutes of measuring: 1 credit is nominally 30 s, and section 11 of PREREG.md counts 2.0 to 2.4 credits per camera minute.
- Optional: [uv](https://docs.astral.sh/uv/), for the narrator voice (`npm run tts` and the voice self-test of `npm run doctor`, whose first run downloads about 560 MB) and for the OpenTimestamps stamps of `npm run freeze`.

## Setup

1. Clone this repository and open a terminal in its folder.
2. `npm ci` installs what the page, the analysis and the tests need.
3. `npm run setup:live` installs the SDK and the Electron fallback into `live/`.
4. Copy `.env.example` to `.env` and paste your key after `SMARTSPECTRA_API_KEY=`. `.env` stays out of git. In the app, only `live/tap.cjs` reads it.
5. Copy `settings.env.example` to `settings.env`. Set `COPYHOLDER_MIC_NAME` and `COPYHOLDER_OUTPUT_NAME` to part of your headset's names, for example `External Microphone` and `External Headphones` for a 3.5 mm headset on a MacBook. The file explains the other settings; ignore its `COPYHOLDER_FACE_PREVIEW`, which only the demo mode of the dropped first design reads.
6. `npm run cameras` lists the cameras the SDK sees. With more than one, put the exact name in `settings.env` as `COPYHOLDER_CAMERA_NAME`.
7. `npm run doctor` checks the sound chain without the camera, in about seven minutes: device names and microphone settings, two loop checks five minutes apart, the narrator level, three loud in-breaths and the narrator voice self-test. It writes `calib.json` and ends with `DOCTOR OK` or `DOCTOR FAIL`. `npm run doctor -- --level` only sets the volume, in about two minutes.
8. `npm run smoke` is the first camera run, about two minutes. It checks the SDK, the camera and the breathing trace, and writes `smoke_report.json`.

## Running

Each command builds the page, starts `host` on 127.0.0.1 and opens a Chrome window with the consent screen. Every recording goes into its own folder `sessions/<id>/`, and `host` runs the quick check when it ends.

- `npm run gate -- --pack 0` records the short probe (about three minutes). `npm run gate -- --pack A`, `--pack B` or `--pack C` records a gate pack (about ten minutes). The narrator never stops in these recordings: when the dot under the camera fills, you say the correction aloud, and the analysis finds afterwards where the detector would have stopped it. The folders are `gate-0`, `gate-a`, `gate-b` and `gate-c`; a second recording of a pack gets `-2`. If you are the participant, read only [gate/README.md](gate/README.md) in `gate/` before you record.
- `npm run headstart` records a demo take on the public sample text in `sample/` (about five minutes; see [sample/README.md](sample/README.md)). Three paced deep breaths set the sign of the chest trace. Then the narrator reads, and it stops on a fast rise of the chest trace or, as a safety stop, on your voice. The folders are `headstart-1`, `headstart-2` and so on. If you are the participant, read only [sample/README.md](sample/README.md) in `sample/` before the take, and do not play its clips.
- Without a camera and a key: `npm run headstart -- --tap mock` runs the headstart scenario with a synthetic chest trace from `live/mock-tap.cjs` instead of the SDK. It still uses the microphone and Chrome, and its `manifest.json` records `"tap": "mock"`. It is not a demo take, but its folder is numbered like one, and `take`, `pack` and `video` do not check for the mock tap. Never give its folder to them, always name the take when you run `npm run video` (without an id it takes the newest headstart folder), and delete the mock run's folder with `npm run purge -- <id> --force --yes`.

`package.json` still holds `session`, `rehearsal`, `demo`, `spacebar`, `live:from` and `live:sim`, the scripts of the dropped first design. They do not run: the page has no scenario for them.

`gate`, `doctor` and `smoke` record only from a git clone without local changes that is not behind `origin/main`; `host` says what to do otherwise. If the camera does not open in plain Node, run the same command through Electron, for example `npm run live:electron -- smoke` or `npm run live:electron -- gate --pack A`.

## Analysis

The commands in the order the plan uses them. Steps 1 to 5 run on each recording `<id>` of packs A, B and C. `analyze:gate` refuses pack 0, the probe, which quickcheck alone judges (PREREG.md section 7.4).

1. `npm run quickcheck -- <id>`: `host` runs it after every recording. It prints `GOOD RECORDING` or `RE-RECORD NOW: <reason>` and writes `quickcheck.json`.
2. `npm run clocks -- <id>`: writes the clock report, `clock_report.json`, and adds the loop delay and the camera clock to `calib.json`.
3. `npm run label -- <id>`: the automatic voice onsets go into `onsets.json`. Then the blind label page opens in Chrome, where you mark the start of your reply to each cue, one cue at a time in random order, hearing only the microphone channel.
4. `npm run analyze:gate -- --stage A <id>`: on pack A it tunes the detector on the recording up to 4:15 and writes `params/frozen.json`. After the tuning, on packs B and C, it only checks `params/frozen.json` against `params/retune.json`.
5. `npm run analyze:gate -- --stage B <id>`: opens the objection block once and writes the verdict, `verdict.md` and `verdict.json`.
6. `npm run retune -- <idA> [--write]`: pack A only, after stage B. It applies the tuning rule of section 11, writes `retune-report.json` and `retune-report.md`, and with `--write` the chosen parameters into `params/frozen.json` and `params/retune.json`.
7. `npm run freeze -- gate-retune`: stamps, tags and pushes the tuned parameters before pack B.
8. `npm run take -- <id> [<id> ...]`: the demo-take rule of section 11 on the headstart takes, given in recording order. It prints each take's chest stops and which take the rule publishes: that take alone gets a published set and the demo video. It reads only `stamps.jsonl` and `manifest.json`.
9. `npm run confirm -- <idB> [<idC>] [--dev <idA>]`: the pooled numbers of section 11 over packs B and C, with each pack's five rows, written to `results/confirm.json` and `results/confirm.md`. Without `<idC>` it gives the numbers of pack B alone, flagged, for the case of section 11 where pack C could not be recorded. `--dev` adds pack A's numbers, printed apart as development data.
10. `npm run pack -- <id> --devices-ok`: builds the published set `data/<id>/` of a recording. [PRIVACY.md](PRIVACY.md) lists its options and what the set holds.
11. `npm run video -- <id> --screen <recording.mov>`: puts the demo video together from a screen recording of the take and the take's own two-channel audio; see [tools/video/README.md](tools/video/README.md).
12. `npm run article -- <draft.md> <out.md> [--data <name>=<file.json> ...] [--final]`: fills the numbers of the post from the result files (`results/confirm.json` unless `--data` names another), so that no number in it is typed by hand. `--final` also refuses while a placeholder or an HTML comment is left.

Steps 1 to 5 add their lines to the recording's step log, `ledger.jsonl`, and each refuses to run before the step it needs.

`quickcheck`, `clocks`, `label`, `analyze:gate`, `retune` and `confirm` load `audio.wav` and `samples.jsonl` of every recording they read; `pack` and `video` load `audio.wav`; `take` reads only `stamps.jsonl` and `manifest.json`. When the AI assistant runs one of these commands on a recording, those files count as passed to it ([PRIVACY.md](PRIVACY.md)).

## Tests

- `npm test`: the type check, the unit tests (Vitest) and the browser tests (Playwright), without the slow and the real-time ones.
- `npm run test:e2e`: the browser tests alone.
- `npm run test:integration`: the whole live chain in real time: the real `host` with the mock tap, the built page in Chromium with a microphone fed from a file, and the quick check. It takes about ten minutes, plus the slow full `doctor` run it also includes (about six minutes and the narrator voice self-test).
- `npm run test:headstart`: `npm run headstart` end to end with the mock tap and a stand-in sample text, about three minutes.

The browser tests need Chromium: run `npx playwright install chromium`, or set `PW_CHROMIUM_PATH` to a Chrome or Chromium binary. No test needs a camera or a key.

## Repository map

| Path | What it holds |
|---|---|
| `live/` | `host.cjs`, the local page server and recorder; `tap.cjs`, the only code that loads the SDK; `mock-tap.cjs`, a stand-in without the SDK; the Electron fallback |
| `web/` | The page: consent, scenarios, Deck (the audio worklet that plays the narrator and records both channels) and the worker that runs the detector |
| `core/` | The detector, voice onsets, clocks, statistics and the file schemas |
| `analysis/` | quickcheck, clocks, label, analyze:gate, retune, confirm, take, pack and purge, and the doctor and smoke reports |
| `gate/` | The gate packs: texts, narrator audio and cue lists |
| `sample/` | The public sample text and clips of the demo takes |
| `params/` | The detector parameters: `frozen.json`, and `retune.json` after the tuning |
| `tools/` | The narrator voice (`tts`), `freeze`, `article`, the sample build, `lint-words` and the video tool |
| `tests/` | Unit, host and browser tests |
| `docs/protocol.md` | The messages and files between `host`, `tap` and the page |

## Consent and data

- The camera and the microphone turn on only after `I agree, start` on the consent screen. `Stop` turns both off at once.
- Camera frames are processed on the computer by the SDK. The app does not store or upload them.
- In every camera session the SDK itself sends derived measurements (such as breathing rate) with session identifiers to Presage in the United States. Presage passes them to its AI provider, Anthropic, to generate "Insights". This cannot currently be switched off. The app never requests an Insight.
- Every recording is saved in `sessions/<id>/` on the computer, outside git. The app uploads none of it.
- `npm run pack` builds a reduced set of a recording for publication: no face point coordinates, no raw SDK data and, by default, no audio.
- Measure only yourself. You must be 18 or older. SDK metrics are offered for general wellness and informational purposes only. SDK metrics have not been cleared by the FDA and may not be used for medical diagnosis or treatment. This app makes no diagnosis and no health claim.
- Details: [PRIVACY.md](PRIVACY.md). Terms of use: [TERMS.md](TERMS.md).

## Licenses

- Code: the MIT License, see [LICENSE](LICENSE).
- The texts the narrator reads, in `gate/` and `sample/`: CC0 1.0, as [TERMS.md](TERMS.md) says.
- The published data in `data/` and `results/`: the Copyholder data license, see [LICENSE-DATA](LICENSE-DATA). Anyone may copy, share, analyze and recompute them if they name the source and follow [TERMS.md](TERMS.md). It is not an open data license such as CC BY, because part of the data is output of the SDK and the Presage Terms of Service limit how that output is used.
- The SDK is not part of this repository: `npm run setup:live` installs it from npm under its own license. The narrator voice is Kokoro-82M, whose weights are under Apache-2.0.

## AI assistance

An AI coding assistant, Claude by Anthropic, working in a Claude Code cloud session, wrote the code in this repository and the texts the narrator reads, and drafted this README, PRIVACY.md and TERMS.md. It rendered the narrator audio of the gate packs and of the sample with Kokoro in its own cloud container. At the author's request it runs the app's commands on the author's Mac through a Claude Code Remote Control session, so the terminal output of those commands, and any file it reads on the Mac, reaches Anthropic's servers as part of that session. The author starts every camera run by typing the command in a terminal on the Mac. [PRIVACY.md](PRIVACY.md) lists which recording files the assistant has read.
