# Synthetic sessions

`makeSyntheticSession(options)` in `session.ts` builds one recorded session in memory, with known truth and optional faults (spec 13.4). It is for tests only. The same seed always gives the same session.

```ts
import { makeSyntheticSession } from '../synthetic/session.ts';
import { clockCheck, hardFailures } from '../../core/clock/index.ts';

const { session, truth } = makeSyntheticSession({ faults: { lrtShiftMs: 20 } });
const report = clockCheck(session);
report.chain.rule; // 'void'
hardFailures(report); // ['L_rt of loop checks A and B differs by more than 15 ms']
```

`session` has the `SessionData` shape from `core/clock/types.ts`. Every stamps, samples and events line passes the line validators of `core/schemas` (a test checks it).

| Field | Content (spec 8.1) |
|---|---|
| `sampleRateHz` | 48000 |
| `ch0`, `ch1` | `audio.wav` channels: microphone and Deck output. Index `i` is the i-th recorded sample. It equals the sample number `n` unless a block was dropped. |
| `stamps` | `stamps.jsonl` lines in the order host writes them. Deck's stamps are in sample order: `click`, `mark` (`what: 'step'` with `name`, or `what: 'cue'` with `on`; Deck's cue marks also carry the cue index `i`, these leave it out, so readers number cues by order), `arr` for every packet, `hold`, `state`, `voice`, `resume`. A `chunk` stamp comes after the stamps of its block's samples. Blocks are 9600 samples from sample 0; the last one is 2400 samples. |
| `samples` | `samples.jsonl` lines in tap's arrival order, every one with `tArrNs`. `seq` counts the SDK callbacks in that order; `l` lines have none. Kinds: `s` (`kRunning`, code 3) first, `f` (`sent`) for every frame before its packet, `m` packets at 30 per second, `v` (`kOk`, code 0) once per second, `l` (`p50Ms`, `p99Ms`, `maxMs`, `n`) once per second, `e` with a fault only |
| `events` | `events.jsonl` lines sorted by `n`: `fire`, `hold`, `resume`, `armed`, `preflight_ok`, and the fault events in the shapes host and the page write. Host's lines carry `by: 'host'` and `n` = the end of the last stored block (`live/lib/session-store.cjs`) |
| `micSettings` | logged `getSettings()` plus what the page adds: 48 kHz, echo cancellation, noise suppression and auto gain off, `contextSampleRate` 48000 |

## Options

| Option | Default | Meaning |
|---|---|---|
| `seed` | 1 | PRNG seed |
| `scenario` | `'session'` | `'session'`: numbers session with live chest stops before each reply. `'gate'`: gate recording with 5 sniffs, a cue before each reply, no stops and no `armed` events |
| `lrtMs` | 23.4 | True L_rt of loop check A, ms. Each click also gets 0.08 ms of random delay jitter |
| `narrationS` | 30 | Narration length, s. In `'gate'` the first half is the listening block and the second half holds the objections |
| `replies` | 3 | Voice replies, 0.9 s each, spread over the narration (the objection half in `'gate'`). They must be at least 2.6 s apart, or the call throws a `RangeError` |
| `traceLagMs` | 100 | Delay of the trace behind the chest inside the SDK |
| `camera` | true | `false` gives no SDK lines and no `arr` stamps. Stops then have cause `voice` (audio insurance, 250 ms after `voice_on`). Check such a session with `clockCheck(session, { camera: false })` |
| `faults` | none | See below |

A full gate with 14 cues needs `narrationS` of about 80: `makeSyntheticSession({ scenario: 'gate', narrationS: 80, replies: 14 })`.

## Faults

Each fault changes only what it names: a session with an SDK error or a lost tap is not cut short, so the fault is caught on its own. Live host aborts the recording instead (spec 7.2).

| Fault | Effect | Clock check outcome |
|---|---|---|
| `lrtShiftMs: 7` | Loop check B runs through L_rt + 7 ms | rule `both`, still valid |
| `lrtShiftMs: 20` | Loop check B runs through L_rt + 20 ms | rule `void`, audio invalid |
| `dropChunk: true` | One block in the deep-breath step is missing from the audio and from the `chunk` stamps. Host's `audio_gap` event is added as host writes it when the next block arrives: `{n, e: 'audio_gap', by: 'host', expected, got, missing}` with `n` = `expected` = the lost block's n0, `got` = the next n0, `missing` 9600 | `chunks_contiguous` false, audio invalid |
| `traceRateHz: 15` | SDK frames, packets and trace samples at 15 per second | trace invalid |
| `sdkError: true` | One `e` line (code 5, `kNetworkError`) and one `sdk_error` event from host mid narration | trace invalid |
| `tapLost: true` | One `tap_lost` event from host (`why: 'silence'`) mid narration | trace invalid |
| `hardEvent` | `'hidden'` (`visibilitychange` hidden, then visible 1 s later), `'devicechange'`, `'track_ended'` or `'track_mute'`, mid narration, with `hard: true` as the page sends them | audio invalid |
| `micProcessing: true` | Echo cancellation and auto gain on in `micSettings` | audio invalid |
| `micSampleRateHz` | Microphone `sampleRate` in `micSettings` | audio invalid unless 48000 |
| `stopNotSilent: true` | The first live stop fades to 2 % and the narrator keeps reading | one stop not confirmed, audio invalid |

## Truth

`truth` holds what the generator put in. The most used fields:

- `lrtMs.A`, `lrtMs.B`, `lInMs`: the true path delays. A sound made at real time `t` lands in channel 0 at `n = (t + L_in) * 48000`.
- `clicks.A`, `clicks.B`: click starts in channel 1. `paBursts.start`, `paBursts.end`: 'pa' release bursts in channel 0. `lipOpeningsUs`: the true lip openings on the camera clock.
- `voiceOnsets` (`n_v` in channel 0), `replyDurationS`, `cues` (gate: the samples where the dot fills), `sniffOnsets` (gate).
- `stops`: `seq`, `cause`, `nCmd`, `nSilent`, `nResume` of each live stop.
- `steps`: first `mark` sample of each step name. The names follow `web/scenarios`: `loop_a_ready`, `loop_a`, `headset`, `breathe_normally` (gate), `deep_<i>_in`, `deep_<i>_out`, `sniff_<i>_wait`, `sniff_<i>` (gate), `rest_1` (gate), `pa_start_<i>_closed`, `pa_start_<i>`, `preflight` (session) or `rest_2` (gate), `opening` (session) or `listening` and `objections` (gate), `pa_end_<i>_closed`, `pa_end_<i>`, `loop_b_ready`, `loop_b`, `end`, with `i` from 1. A 'pa' block is 15 s from `pa_*_1_closed`.
- `narration`, `listeningEnd`: narrator playback span and the end of the gate listening block, as sample numbers.
- `cameraSlopePpm` (40), `minLatencyMs` (40), `traceLagMs`, `aRef` (P90 - P10 of plain breathing, 0.951, the A of spec 7.4), `sign` (+1).
- `droppedChunkN0`, `totalSamples` (recorded samples before any drop).

## The synthetic world

- Channel 1 is exact zeros wherever Deck is silent.
- The narrator is a speech-like voiced signal: syllables, words, phrases. It leaks into channel 0 at -40 dB, delayed by L_rt.
- Every click of both loop checks reaches channel 0 and is found: core/clock gives a check an L_rt only when all 10 of its clicks are found (spec 6.3). Clicks reach channel 0 through a model of an earcup pressed on the microphone. The model has a fractional delay, a reflection 1.3 ms later, a +6 dB resonance at 2.5 kHz and a 300 Hz high-pass. The noise floor of channel 0 is 0.0005 RMS.
- The camera clock runs 40 ppm slow against the audio clock. The measured slope depends on the seed and the length: over seeds 1-10 it lands within 16 ppm of 40 for the 95 s session of `narrationS: 16`, within 11 ppm for the default 109 s session, and within 5 ppm for gates of 127 s (`narrationS: 20`) and 187 s (full gate). Frame timestamps have 0.8 ms of jitter. The frame-to-tap latency is 40 ms plus an exponential tail with a 12 ms mean, with occasional 20-80 ms spikes. `nArr` is rounded up to the 128-sample quantum.
- The breathing trace is a 4.2 s sine of amplitude 0.5. Scripted steps blend into it: three deep breaths, sniffs, and an in-breath before each reply.
- The lip gap `g` is 0.035 at rest and 0.008 closed in the 'pa' blocks. Each 'pa' opens linearly to 0.16 in 90 ms, starting at the burst, 0.4 s after the `pa` prompt; prompts come every 3 s. The 16 face points match `g`.
- Each sniff starts 0.3 s after its `Sniff` prompt, after 1.5 s of exhaled stillness.
- Deck's narrator states: `narrating` at a passage start, `idle` at its end, and `hold_wait`, `listening`, `resume`, `narrating` around each stop.
- The scenario follows the step order of spec 9.3 and 10.4, but waits that nothing measures (earcup prompt, headset, rests, preflight) are shorter than in the real scenarios.
- Not generated: `detector_in.jsonl`, `manifest.json`, `sdk_raw.jsonl.gz`.

The onset finders of `core/onset` find every 'pa' burst and every sniff of a gate session where the generator put them (`clock-chain.test.ts`).

A default session (109 s) takes about 0.6 s to build, a full gate with 14 cues (187 s) about 0.8 s. Use a smaller `narrationS` in tests that build many.

`signals.ts` holds the signal helpers (seeded PRNG, earcup model, syllables, sniffs) for tests that need a single signal rather than a session.
