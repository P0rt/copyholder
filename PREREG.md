# Copyholder pre-registration

The tag `gate-prereg` freezes this file before the day-1 gate recording; `PREREG.md.ots` dates it, and the file never changes after the tag [8.4]. The tagged commit differs from `{{APP_COMMIT}}` only in `PREREG.md` and `PREREG.md.ots`. At `{{APP_COMMIT}}` the gate analysis code and `params/frozen.json` (without `k` and `theta_G`) hold the same rules as code and numbers, and they settle any gate detail this file summarises or leaves open. A session detail left open here and settled by the code at `freeze-1` is listed in the `notes` field of `scoring_rules.json` and named in the article [8.4].

[9.6] is a section of the project's design specification and § a section of this file; *(assumption)* marks a value or rule with no measurement behind it, frozen like the rest. "The participant" is the one person recorded. Times are audio samples at 48 000 per second unless a unit is given.

## 1. Fixed before the data [7.4, 8.4, 14.4]

Fixed now: every definition, threshold, grid, check, rule and branch below, and all of `params/frozen.json` except `k` and `theta_G`. Computed per recording by fixed rules, not tuned: the trace sign `s`; D1's A, `med_q`, `s_q` and `theta`; `L_rt`; the onset floor `N`; `A_ref`. Detector parameters change only by three rules written here: stage A (§6.2), the bounded re-tune after `BETWEEN` (§7.7) and the `k` step after the rehearsal (§8). The sessions' catch-window bound follows the data by the rule of §3.3. No other detector parameter, threshold or scoring rule changes with the data. Also fixed in advance: after two failed planting dry runs only the classes `negation` and `number` remain, and the dry run picks the planting model and confirms its temperatures [7.8, 10.2]; warning thresholds, which decide nothing, come from the first runs [6.3].

Cuts allowed in advance narrow the scope and change no rule [14.4, 16]: D3, on the verdict day (the ladder of §7.7 then ends at rung 2); rival M, by 18 November; rivals T and M in the first gate verdict, which then follow with `--exploratory`; the third numbers session, by noon on 18 November; the spacebar block, by that evening. Fewer than three texts give two sessions *(assumption)*. No branch is written for a gate without a verdict (a `NOT EVALUABLE` content re-record, no pack left, or no camera by noon on Saturday); a pack made then has its cue-list hash fixed before its recording, not here [14.3, 18.3].

## 2. Tags [8.4, 13.6, 17.3]

`gate-prereg` freezes this file, `params/frozen.json` without `k` and `theta_G`, and the gate analysis code. `gate-retune`, set only after a bounded re-tune and before a next pack (§7.7), freezes the new `params/frozen.json`, its copy `params/retune.json`, and D3's code if the ladder reached it. `freeze-1`, before the first numbers session, freezes the full `params/frozen.json`, `scoring_rules.json`, the analysis and scoring code, the prompts and `freeze_manifest.json`. `npm run freeze -- <tag>` stamps `PREREG.md`, `params/retune.json` or `freeze_manifest.json` with OpenTimestamps. Tags never move, and each is pushed before the first recording it governs. After `freeze-1` a fix needs its own tagged commit, named in the article; a fix to analysis code makes the receipts print both results [10.3].

## 3. Definitions [4.1, 4.2, 6.3]

### 3.1 Time scale

Hypothesis [4.1]: before an objection the participant takes a quick in-breath, the breathing trace shows it before the voice, and the narrator goes quiet before the first sound.

`audio.wav` holds two channels at 48 000 Hz: 0 the participant's microphone, 1 the narrator after the output gain. Only `L_rt`, the sum of input and output latencies, is measured (§4); the lead needs nothing else:

```text
t_v  = n_v / 48000               voice onset, n_v in channel 0 (§5)
t_s  = nSilent / 48000 + L_rt    stop, on the microphone scale
lead = t_v - t_s
stop before the voice:  t_v - W <= t_s < t_v,  W = 1.5 s
```

`nSilent`, the first sample after the 8 ms (384-sample) fade, is `nCmd + 384` for a live stop (`nCmd`: the sample at which `Deck` starts the fade; `nCmd == nArr` for a live chest stop); `nArr + 384` for a detector computed after the recording; `n_v + delay * 48000 + 384` for A100, A250 and A500 (`delay` 0.1, 0.25 or 0.5 s; lead `-(delay + 0.008 + L_rt)` s); and `nKey + 384` for the spacebar (`nKey`: stamped by `Deck` on the `keydown` message). A detector fires at the `nArr` that `Deck` stamps on the SDK packet where its rule is first met, never at a sample's `ts`; stops are never sought in the audio content.

### 3.2 Utterances, objections and stops [4.2, 4.5, 6.4]

The trace detector is D1, or D3 if the bounded re-tune ends on D3 [4.4].

| Term | Definition |
|---|---|
| Utterance | Voiced segments of channel 0 by the onset reference (§5), pauses under 1.0 s merged |
| Objection | An utterance with at least 250 ms of voiced sound in total *(assumption; a 400 ms line is printed beside it)*, starting while the narrator reads or in a hold pause, at least 4.0 s after the previous utterance ended; words are not counted |
| Continuation | An utterance starting under 4.0 s after the previous one ended; in no denominator |
| Other utterance | Under 250 ms of voiced sound, or a start outside reading and hold pauses; kind `other`, in no denominator |
| Non-speech | Cough, laughter or throat clearing, marked blind (§5); not objections, and every share is also printed with them included |
| Voice onset `t_v` | Start of an objection's first speech sound by the onset reference (§5); the automatic value is confirmatory everywhere |
| Audible in-breath | A noise segment over 250 ms before `t_v` (§5); misses are split by it |
| No signal | From `t_v - 2 s` to `t_v` the trace has a gap over 100 ms between samples or one of the four inactivating `validationStatus` codes (§6.1) |
| Hold pause `H`; window `W` | Both 1.5 s. `H` runs 72 000 samples from `nSilent`; if the voice starts within it, the narrator waits for the utterance to end, otherwise it reads on |
| Lead | `t_v - t_s`, positive when the headphones fell silent first |
| Stop before the voice | A trace-detector stop with `t_v - W <= t_s < t_v`. Leads of 0-50 ms count and also get their own line; a separate count keeps only leads under 300 ms *(assumption: no voice answers silence faster, by third-party reaction-time data)* |
| Late stop | `t_v <= t_s <= t_v + 0.5 s`: neither a stop before the voice nor a false hold; the objection stays a miss |
| Miss | An objection with no trace-detector stop from `t_v - W` to `t_v` |
| False hold | A trace-detector stop with no objection starting within `W` after `t_s`, including one followed only by non-speech or by an utterance under 250 ms of voice |
| Audio safety stop | Cause `voice`: the narrator stops once the voice detector has reported voice for 250 ms with no stop. Its silence comes at least 288 ms (30 + 250 + 8) after the first voiced sound, so it is not a tested rule and has its own line; only cause `chest` gives a stop before the voice. Off in the gate; not the rival A250 |
| Active time | The narrator reads and the detector is active (§6.1), hold pauses, the participant's utterances and the periods after them excluded; `λ` is false holds per minute of it |
| Armed | `t_v - W` to `t_v` lies in active time, inactivity after a fire whose stop falls in that window or later not counted. An unarmed objection stays in every denominator; with no stop it is a miss flagged "detector was inactive" *(assumption: the flag means not armed)* |

### 3.3 Planted errors in sessions [4.2, 7.9, 10.2, 10.5]

| Term | Definition |
|---|---|
| Presented | Every word of the changed span was played, a word counting if at least 80% of it was output; a span cut by a stop is presented, with `interrupted: true` |
| Catch window | From the first start of the span's first word + 200 ms to the end of its last word + the bound (5 000 ms) |
| Caught | An objection starts in the catch window; the first one is matched to the error, by time only |
| Caught late | No objection in the window, and the first one after it starts at most 12 s after the span ends; not in the main share |
| Missed | Neither |
| Own find | An objection outside all catch windows that the participant labelled, before the reveal, as a real error in their own text |

The bound stays 5 000 ms unless one of the participant's delays in the camera-free listening [10.2] exceeded it; then it is the largest delay rounded up to a whole second, at most 8 s. An error's delay runs from the end of its span to the voice onset of the objection matched to it as caught or caught late under the 5 000 ms bound; an error without one has none *(assumption)*. `scoring_rules.json` holds `catch_open_after_span_start_ms` 200, `catch_close_after_span_end_ms` 5000 or the bound, `late_close_after_span_end_ms` 12000, `objection_merge_gap_ms` 1000, `min_voiced_ms` 250, `min_gap_ms` 4000 and `W_ms` 1500.

After each session the participant labels each own objection `real_error`, `false_alarm` or `unclear`, blind to the plan and the detector outputs; the labels' hash enters the step ledger before the reveal, and they never change after it.

## 4. Clocks, L_rt and void recordings [6.3, 7.12, 10.6]

**Loop check.** With an earcup on the microphone, `Deck` plays 10 clicks at unequal intervals over about 12 s; `L_rt` is the median click shift from channel 1 to channel 0 by cross-correlation. Check A follows the SDK's `Running`, check B precedes the SDK stop, both with the camera on.

| A and B differ by | Rule (`rule` in `calib.json`) |
|---|---|
| ≤ 3 ms | `mean`: the mean is used |
| > 3 ms, ≤ 15 ms | `both`: each lead is printed with A and with B, a stop is before the voice only if it is so with both, and the recording is flagged |
| > 15 ms | `void`: the recording's leads are invalid |

Under `both`, a rule that needs one number takes the larger `L_rt` *(assumption)*, for leads and for the sniff lag's upper bound. `npm run doctor`, with two loop checks 5 minutes apart on the recording equipment, confirms or changes 3 ms and 15 ms once, before this tag: {{LRT_THRESHOLDS_CONFIRMED}}. Changed values replace these numbers here and in quickcheck condition 2 (§7.4) before the tag; the 3 ms preflight tolerance against the `doctor` value [10.4] is a separate number.

**Void recordings**, the one list of hard conditions. A recording does not count if:

1. its audio has a gap;
2. rule `void` applies;
3. microphone processing (echo cancellation, noise suppression, automatic gain) is on, or the rate is not 48 000 Hz;
4. a hard window or device event happened: page hidden, `devicechange`, microphone track `ended` or `mute`;
5. the median trace rate is under 25 samples per second, or an SDK `error` or `tap_lost` event came;
6. in a session, channel 1 is not zeros from `nSilent` to the resume after some live stop;
7. in a numbers session or the rehearsal, D1 was active for less than half of the reading time.

Items 1-4 are the clock check. Rule `both`, `blur`, `resize`, the share of `frameSentThrough` with `false`, the `tap` event-loop delay and the share of `kOk` only warn.

**Sniff lag** (gate row 4) [6.3, 9.6], on five sniffs, each on the prompt `Sniff` 1.5 s after `Breathe out and wait`:

- A sniff is found when its sound start `n_sniff` is found in channel 0 (high-pass 1 kHz, 5 ms envelope, noise floor + 12 dB held 20 ms) within 2 s after the prompt *(assumption: 2 s)*; quickcheck condition 8 counts the same sniffs.
- Its arrival is the `nArr` of the first packet in which the trace has risen at least 0.15 `A_ref` above its median over the 500 ms before `n_sniff`, `A_ref` being the median amplitude of the listening block. With `lo = (nArr - n_sniff) / 48000` the true lag lies in `[lo, lo + L_rt]`.
- A found sniff with no arrival within 2 s, or with no trace sample in those 500 ms, has a lag over 2 000 ms and enters both medians above every measured value *(assumption)*. `n` counts all found sniffs, and those without an arrival are counted beside it; with no arrival at all, row 4 is `KILL`.
- Printed, not graded: the rise start by backward extrapolation (best case), and D1's fire lag by its fire rule alone, with the stage A `k` and the listening block's `med_q`, `s_q` and A *(assumption)*. The sniff lag never corrects a lead.

## 5. Voice onset, labels and the voice detector [7.3, 7.6, 7.12]

**Onset reference** [7.6], on channel 0 after the recording, blind to the detectors:

| Step | Rule |
|---|---|
| Features | After a high-pass at 80 Hz (4th order, forward and backward), in 10 ms windows at 1 ms steps: energy `E` (dB, 150 Hz-8 kHz) and periodicity `c`, the largest normalised autocorrelation at lags 2.5-12.5 ms in a 30 ms window |
| Floor | `N`, the median `E` from 10 s to 1 s before the search start while the narrator reads and the participant is silent; spread `s_N = 1.4826 * MAD` |
| Anchor `t_a` | The first moment at which `c >= 0.5` and `E >= N + 15 dB` hold in at least 40 of 60 consecutive windows; a window where both hold is voiced, for utterances *(assumption)* |
| Onset `t_v` | Back from `t_a` while `E >= N + max(6 dB, 3 * s_N)`, through dips up to 20 ms, at most 250 ms |
| Audible in-breath | A non-periodic segment above that threshold *(assumption: this threshold)* before `t_a`, longer than 250 ms, with its start and end written. `t_v` is then the start of the last segment separated from it by a dip of at least 6 dB for at least 20 ms; with no dip, `t_v = t_a`, flagged `no_dip` and counted |
| Search | Gate: from the dot cue. Sessions: all reading and hold-pause time, with `N` per anchor candidate from the windows 10 s to 1 s before it in which the narrator reads and no utterance runs |

**Blind labels** (`npm run label`, after the automatic onsets): in random order the participant marks each event's first sound on the waveform and spectrogram of channel 0 and types non-speech as `cough`, `laugh`, `throat` or `other`; the narrator channel, the trace, the stops, all detector marks and the automatic mark *(assumption)* are hidden. The labels' hash enters the step ledger before detector outputs are joined. They give the measured onset error and one sensitivity line; the others are all onsets 25 ms earlier, `t_a` instead of `t_v`, a 400 ms objection threshold, and shares with non-speech included.

**Voice detector**, live in `Deck`; the same pure function recomputes its edges after the recording. The edges drive the hold pause, the wait for an utterance's end, the audio safety stop and the detectors' voice conditions.

| Parameter | Value |
|---|---|
| High-pass, hop | 150 Hz, 5 ms |
| Voiced hop | energy ≥ noise floor + 15 dB and normalised autocorrelation ≥ periodicity threshold, on the signal decimated to 8 kHz, at lags 2.5-12.5 ms |
| Noise floor | {{VAD_FLOOR_DB}} dB, measured by `npm run doctor` |
| Periodicity threshold | {{VAD_PERIODICITY}} |
| `voice_on`, `voice_off` | 30 of the last 50 ms voiced; 1.2 s without a voiced hop |

All are assumptions, frozen by this tag after `doctor` has measured the floor; `freeze-1` only repeats them. `doctor` records 10 s with three loud in-breaths; if any switched the detector on, the periodicity threshold rises from 0.5 in steps of 0.05 to the first value without `voice_on`, at most 0.7 *(assumption)*. The SDK flag `talking` is only recorded and enters no activity condition.

## 6. Detectors [7.4, 7.5]

### 6.1 D1

D1 stops the narrator when the trace rises clearly steeper than on the participant's ordinary in-breaths. One pure function `step(state, input)`, fed the lines of `detector_in.jsonl` (SDK packets, `validationStatus` codes, voice edges, player states) in arrival order, edges and states taking effect from the next grid point, gives the same fires on the same samples live, in replay and in analysis.

| Part | Rule [7.4] |
|---|---|
| Grid | Samples, turned by the sign `s` so that an in-breath is a rise, go onto a 30 Hz grid by their `ts` with linear interpolation, a point being emitted when the first sample not earlier than it arrives; all D1 times run on this grid, and `stable` is not read |
| Usable sample | Usable trace, narrator reading, no stop, no voice, post-voice period over. A gap over 100 ms makes the points inside unusable; one over 500 ms empties the slope window and makes D1 inactive for 3 s, keeping the memory and A |
| Amplitude A | P90 - P10 of the usable samples of the last 30 s, none older than 120 s; at least 15 s needed |
| Slope `v` | Least-squares slope over `L` = 5 grid points, divided by A |
| Memory | The last 20 ordinary breaths, cleared when the narrator first starts reading. Breaths split at extrema differing by at least 0.25 A; one enters 2 s after its maximum if it started on a usable sample and no voice came; one that caused a false hold stays; recovery breaths after an utterance never enter, and the first full one closes the post-voice period |
| Threshold | `theta = med_q + k * s_q`, bounded to 1.3-3.0 `med_q`; `med_q` is the median of the memory breaths' largest slopes and `s_q = 1.4826 * MAD` of them |
| Fire | `v >= theta` on `M` = 2 consecutive grid points and a rise of at least 0.15 A within 200 ms |
| Active | ≥ 10 breaths in memory, A, a usable sample, the post-fire period (2.0 s, not before the stop ends) and the post-voice period (4.0 s after `voice_off` plus one full ordinary breath) over, and none of the `validationStatus` codes 1 `kNoFaceFound`, 2 `kMultipleFacesFound`, 7 `kChestNotVisible`, 12 (excessive motion) |

**Sign.** For each of the three paced deep breaths, `d` is the median trace over 0.5 s around the end of the inhale cue minus that around its start. The sign is defined if all three `d` agree, with a margin if the smallest `|d|` is at least a third of the largest *(assumption: method and margin)*. The gate sets it after the recording (quickcheck condition 9; disagreement with the sniffs only warns); a session's preflight needs the sign of the gate recording that gave the verdict *(assumption: that recording)*.

### 6.2 Grid of k and stage A [7.4, 9.5]

**Grid of `k`:** 1.5; 2.0; 2.5; 3.0; 3.5.

Stage A (`npm run analyze:gate -- --stage A`), the only tuning, reads the recording only up to 4:15 and runs `step()` over the listening block for each `k`; every fire there is false. It takes the smallest `k` with at most 1.0 fire per minute of active time (none qualifies without active time *(assumption)*), else `k = 3.5` flagged `criterion not met`; it then selects `theta_G` (§6.4), writes both into `params/frozen.json` and the file's hash into the step ledger. Only then does stage B open the objection block. The gate verdict uses this `k`.

### 6.3 D3 [7.4]

Built only if the bounded re-tune reaches rung 3 (§7.7). D3 fires whenever D1 does, and also when the current breath is early and `v >= med_q + 1.0 * s_q` on `M` consecutive points. A breath is early if at its onset at most 0.6 of the median onset-to-onset interval has passed since the previous onset, or if it started at least 0.25 A above the median trough level. A breath's onset is the first point with `v >= 0.35 * med_q` on three consecutive points after `v` fell to zero since the last maximum. Interval and trough level come from the memory breaths used for `med_q`; activity, periods and stops are D1's. 1.0, 0.6, 0.25 and 0.35 are fixed *(assumption)*; only `k`, `L` and `M`, shared with D1, are tuned.

### 6.4 Rivals and the grid of theta_G [7.5, 10.7]

Every detector computed after the recording (the rivals, and D1 in the gate) runs on the same events with its own stops (§3.1), hold pauses and 2.0 s post-fire period; its activity uses only facts no detector affects (voice edges, signal validity, the reading schedule), and live D1 stops are invisible to it.

| Rival | Rule |
|---|---|
| G, lips | `g`: the median of five `y` differences (lower minus upper point) over the distance between points 33 and 263, for the pairs (13, 14), (82, 87), (312, 317), (81, 178), (311, 402); `g0`: the median `g` over the preceding 10 s. G fires on `g - g0 >= theta_G` on two consecutive frames. After a frame flagged `reset`, `g0` rebuilds and G stays silent until it holds 1 s of frames *(assumption)*. Point numbers follow the MediaPipe face mesh named by the SDK documentation; their roles are an assumption |
| T | Fires on the first packet with `talking` true while T is active |
| M, head motion | Descriptive only: `hm`, the speed of point 1 (least squares over 5 frames) over the distance between points 33 and 263, above its median plus 4 spreads from the listening block (sessions: the calibration minute) *(assumption)* |
| A100, A250, A500 | A fixed delay after each objection's reference onset (§3.1); A250, the 250 ms rule, is the main rival |
| K, spacebar | A camera-free block on other texts: one text of three passages with 9 planted errors under one sealed plan, the audio safety stop on. Measures: the common measure (§6.5), the caught share, and the presses outside catch windows per minute; an objection spoken without a press is flagged `spoke without pressing` and left out of them |

**Grid of `theta_G`:** 0.0100 to 0.0600 in steps of 0.0025 (21 values). **Budget:** stage A takes the smallest value at which G's false fires in the listening block do not exceed the larger of D1's fire count there (at the chosen `k`) and D1's active minutes there, rounded down; if none does, 0.0600, flagged `criterion not met` *(assumption)*.

### 6.5 Paired comparisons [4.4, 7.5, 9.6, 10.7]

For gate row 5, H3 and H4. Stops from `t_v - W` to `t_v + 0.5 s` count, each detector's first if several *(assumption)*. A stop at least 33 ms earlier than the other wins, a detector without a stop loses to one with a stop, and anything else is a tie; ties are left out of the tests and counted. Printed beside each comparison: both false-fire rates on data outside tuning; an `exploratory` line with G's threshold set to give the chest's rate; and, on their own line, objections before which a live chest stop had already silenced the narrator. Chest, lips, the 250 ms rule and the spacebar share one common measure, the time from the start of the planted error to the stop; `lead_K` is printed only flagged `pressed, then spoke`. Keyboard latency is not subtracted: the published 15-60 ms range is printed beside K, and differences under 60 ms between K and another rule are not interpreted *(assumption)*.

## 7. The day-1 gate [9]

### 7.1 Packs, cues and cue-list hashes [9.1, 9.2]

One recording with pack A gives one verdict: `PASS` (continue), `BETWEEN` (between the thresholds), `KILL` (drop) or `NOT EVALUABLE`. The gate only records: no live detector, no audio safety stop, a narrator that never stops, planted errors written by hand without a sealed plan. D1 stops are virtual (§3.1); the worker still runs `step()` with preliminary parameters on each packet, to carry the live load, and discards the answer.

Pack 0 is a 90 s probe with 30 s of listening and two cues. Pack A has a 180 s listening block without errors and a 300 s objection block with 14 obvious planted errors ("a week has nine days"), each correctable in three to five words. Packs B and C are the same on other texts with other cue layouts; B serves the single content re-record, and C replaces B if B went to a technical re-record. The participant neither reads nor hears the packs beforehand and does not open `gate/`; `doctor` sets the volume on a 20 s sample from outside them. A cue is a grey dot under the lens that fills for 1.5 s at the end of a planted error. Cues are 16-24 s apart, the first at least 15 s and the last at most 265 s into the objection block; a cue's time is its stamped sample, when the dot starts to fill *(assumption)*.

Each pack's cue list is `gate/pack-<X>/cues.json`, the file served to the page: a JSON array of cue start times in ms from the start of the objection block, with no text (`docs/protocol.md`). It is the stored cue list of [9.2] *(assumption: no separate encoded copy)*. The SHA-256 of its exact bytes, in lowercase hex:

| Pack | SHA-256 of `cues.json` |
|---|---|
| 0 | `62edd2e6bc131ebfb9eb05e7659b8043aa828cfb643a6c9be5bd3d55ee586cd0` |
| A | `74d8c7d273d0391c892c9c5e380152857c6ae195f463cfbe6a9574ca844a6da4` |
| B | `cce1b5deb5eda8393d4e44ef72d957ae34e72f08b9ecf07d19f9916e6fb36b9c` |
| C | `62163f67c19ad70de82f75876bd195275b1835ea90231814a63e5868af9c2df6` |

### 7.2 On-screen instruction [9.2]

Shown before the start, verbatim:

```text
The recording takes about ten minutes. The narrator never stops.

1. Minute one: follow the prompts.
2. Three minutes: listen, stay silent.
3. Five minutes: 14 obvious mistakes. When the dot under the
   camera fills, say the correction aloud, three to five words.

Correct the narrator as you would correct a person.
Do not think about breathing.
If you did not catch what was wrong, say: "No, that was wrong."

Sit still, eyes on the dot.   [ Start ]
```

### 7.3 Scenario [7.1, 9.3, 9.4]

After the consent screen (`I agree, start`) and the instruction (`Start`) the participant touches neither keyboard nor mouse; Chrome is full screen and shows no trace. The camera runs from SDK start to SDK stop, both loop checks inside.

| Time | Step |
|---|---|
| Before 0:00 | SDK `Running` and `kOk` held for 5 s *(assumption: 5 s)*; loop check A; 8 s still with the headset on |
| 0:00-0:10 | Normal breathing (`Breathe normally`) |
| to 0:28 | Three paced deep breaths, 2 s in and 4 s out |
| to 0:50 | Five sniffs |
| 0:55-1:10 | Five "pa" syllables from closed lips |
| 1:15-4:15 | Listening block, in silence |
| 4:15-9:15 | Objection block: a spoken correction after each of the 14 cues |
| 9:15-9:30 | Five "pa" |
| Then | Loop check B, SDK stop, quickcheck |

After a missed cue the participant listens on; outside the cues they stay silent. Pack 0 (`npm run gate -- --pack 0`) runs the same path with three paced breaths, two "pa", two sniffs, 30 s of listening and two cues, to catch a technical fault before pack A is spent.

### 7.4 quickcheck [7.12, 9.4]

`host` runs quickcheck after every recording; it computes no detector and prints `GOOD RECORDING` or `RE-RECORD NOW: <reason>`. Hard conditions for packs A, B and C:

1. the audio is continuous and not shorter than the scenario;
2. both loop checks were found, and A and B differ by at most 15 ms;
3. all 14 dot cues are stamped;
4. the median rate of the breathing trace is at least 25 samples per second;
5. there is no SDK `error` event and no `tap_lost` event;
6. voice was found within 10 s after the cue for at least 12 cues;
7. in each block of "pa" syllables at least 4 of 5 were found;
8. at least 4 sniffs were found (§4);
9. the three paced deep breaths give one trace sign.

Items 3 and 4 of the void list (§4) are hard too, read from the logs. Pack 0 uses the same conditions with its own counts: both cues stamped, voice after both, both "pa" and both sniffs found. Rule `both` passes with a flag; warnings never fail a recording.

- A recording failed for a technical reason, with no detector computed, did not take place and does not spend the content re-record. Condition 6 is not technical: its failure means fewer than 12 valid objections, so the next recording is the content re-record (§7.5).
- After `RE-RECORD NOW`: remove the cause, repeat pack 0 until `GOOD RECORDING` *(assumption)*, and record again, on the same pack if the recording broke off before 4:15, otherwise on the next unused one, B then C.
- Numbers sessions and the rehearsal use conditions 1, 2, 4, 5 and 9 and items 3, 4 and 7 of §4 (D1's share from its on and off events in `events.jsonl`); a "pa" failure there voids nothing. Demo takes use the same without item 7; the spacebar block and the camera-free listening use conditions 1 and 2 and items 3 and 4.

### 7.5 Analysis order and valid objections [4.5, 8.5, 9.5, 9.6]

The step ledger `ledger.jsonl` enforces the order `record`, `quickcheck`, `clocks`, `onsets`, `label`, `stage_a`, `stage_b`, `verdict`, `pack`; no step starts without the previous step's hash. `npm run label` writes `onsets` and `label` for all 14 events (§5). Stage B (`npm run analyze:gate -- --stage B <id>`) opens the objection block once and writes `verdict.md` and `verdict.json`; any later `analyze:gate` run needs `--exploratory`, which marks its outputs as not confirmatory. `npm run pack` releases part B (the objection block) only after the stage A hash is in the ledger. The article names who ran the analysis.

**Valid objection.** Per cue only the first utterance after it counts. It is valid if it is an objection (§3.2), its automatic `t_v` is neither before the cue nor more than 10 s after it, and it is not "no signal"; a first utterance that is not an objection leaves the cue without one *(assumption)*. Fewer than 12 valid objections make the recording `NOT EVALUABLE`, and the next unused pack is recorded as the single content re-record.

### 7.6 Decision rules and verdict [9.6, 9.7]

| Row | `PASS` | `BETWEEN` | `KILL` |
|---|---|---|---|
| 1. Stops before the voice: valid objections with a virtual D1 stop before the voice, absolute count | ≥ 8 | 5-7 | < 5 |
| 2. Median lead over the stops before the voice | ≥ 200 ms | 100-199 ms | < 100 ms |
| 3. False holds per minute of active time, objection block only | ≤ 2 | > 2, up to 5 | > 5 |
| 4. Sniff lag: interval `[lo, lo + L_rt]`, medians over the sniffs found (§4) | median of upper bounds ≤ 150 ms | everything else | median of lower bounds > 350 ms |
| 5. Chest against lips: wins of D1 and G on valid objections (§6.5) | D1 wins minus G wins ≥ 3; or median lead difference (D1 minus G) ≥ 100 ms on ≥ 5 objections where both stops are before the voice | everything else | G has at least as many wins as D1; checked first |

**Verdict**, in this order: fewer than 12 valid objections give `NOT EVALUABLE`; any `KILL` row gives `KILL`; five `PASS` rows give `PASS`; anything else gives `BETWEEN`.

- Grades use the stage A `k` and `theta_G` and the automatic onsets; a row whose grade changes when the participant's blind manual onsets replace the automatic ones becomes `BETWEEN`.
- Row 1 is an absolute count: with 12 or 13 valid objections the thresholds stay 8 and 5.
- Row 2: `BETWEEN` runs from 100 ms to under 200 ms; the median over all stops from `t_v - W` to `t_v + 0.5 s` is printed beside it. With no stop before the voice, row 2 is `n/a`, graded `KILL` *(assumption)*.
- Row 3 counts D1's false holds in the objection block over its active minutes there; the listening-block rate is printed as `in-sample`, not graded.
- `verdict.md` (English, every number, convenient or not) and `verdict.json` hold the five rows with the lines §4 and §6.5 require, the counts of valid and armed objections, and the misses split by audible in-breath.

Forecast, not a rule [4.6, 9.9]: if 15-35% of objections get a stop before the voice, row 1 alone gives about 2% `PASS`, 26% `BETWEEN` and 72% `KILL`; so the `KILL` branch is written in advance.

### 7.7 Branches after the verdict [9.8, 18.3]

**`PASS`**: `params/frozen.json` enters `freeze-1` unchanged, except for the rehearsal step (§8).

**`BETWEEN`**: the `BETWEEN` row sets the action.

| `BETWEEN` row | Action |
|---|---|
| 1 | Split the misses by audible in-breath. If most have one: bounded re-tune. If most have none, or the groups are equal: narrowed claim |
| 2 | Narrowed claim |
| 3 | Bounded re-tune: `k` one grid step up. If `k` is already 3.5 there is no step: narrowed claim |
| 4 | Work goes on; the article prints the sniff lag next to every lead |
| 5 | Work goes on; the title and the receipt do not say that the chest beats the lips (the word `beats`) |
| two or more rows | Narrowed claim, a title without the effect, no re-tune |

The narrowed claim, *the narrator goes quiet before the voice on objections that begin with an in-breath*, is written in `verdict.md` and in the step ledger.

**Bounded re-tune**, on the same recording, at most 4 hours of work:

- Row 3: the step up is the whole re-tune, with no further condition; this `k` and the reselected `theta_G` are the new parameters.
- Row 1: a ladder. The next rung runs only if the previous one did not give `PASS` on all five rows on this recording, and the first rung that does sets the new parameters; if none does, the parameters stay, the claim is narrowed and no next pack is recorded *(assumption)*.
  1. `k` one step down, with stage A's limit of 1.0 fire per minute lifted (row 3 keeps false holds in check). At `k` = 1.5 there is no rung 1, and rungs 2 and 3 use the previous `k`.
  2. At rung 1's `k`, all nine pairs of slope window `L` in {4, 5, 7} and consecutive points `M` in {1, 2, 3}. Among pairs with `PASS` on all five rows the higher row 1 count wins; ties go to the lower row 3 rate, then `L` nearer 5, then `M` nearer 2, then the larger `M` *(assumption: `L` before `M`, and the last step)*.
  3. D3 (§6.3) at rung 1's `k`, with the `L` and `M` of the highest row 1 count among the nine pairs, ties broken as above.
- Any re-tune reselects `theta_G` by the budget of §6.4 on the same listening block, with the re-tuned detector's limit; each candidate parameter set gets its own `theta_G` *(assumption)*, which row 5 uses.
- After any re-tune the gate counts as "not passed, continued at own risk", and its 14 events become development data. A clean `PASS` can come only from the next pack, recorded with the new frozen parameters and judged by §7.6. The participant chooses whether to record it [18.3]; it is the single content re-record, which must be unspent, and there is no third attempt.
- New parameters go into `params/frozen.json`. Before a next pack, its copy `params/retune.json` is tagged and stamped by `npm run freeze -- gate-retune` and never changed, and stage A on that recording tunes nothing and only checks `params/frozen.json` against it. Without a next pack, `freeze-1` freezes the new parameters. A ladder that ends on D3 makes D3 the trace detector of the sessions.

**`KILL`**: the participant chooses on the day of the verdict.

| Option | Open when | What it is |
|---|---|---|
| Pretend Pulse, the default | any `KILL` | The fallback project, started the same day; it needs a count of in-breaths per 60 s block, not the moment of each in-breath |
| Copyholder with the lips detector G live | the only `KILL` row is row 5, and G itself passes rows 1-3 *(assumption: graded `PASS` in D1's place)* | The lips stop the narrator; the chest stays a measured rival |
| Copyholder null release | any `KILL` | A measured negative result on two sessions |

**Article title** [9.9]: with `PASS` a title with the effect stays possible; with `BETWEEN` it is narrowed or without the effect, by the row rules above; with `KILL` the chosen option sets the topic.

## 8. The k step after the rehearsal [10.2]

The rehearsal (`npm run rehearsal`) is a full camera session on a public text with a sealed plan, up to the receipt. If it has more than 2 false holds per minute of active time, `k` rises one grid step at `freeze-1`, recorded as `tuned.k.rehearsal_step_up` in `params/frozen.json`; at `k` = 3.5 there is no step, and the article says so in one sentence *(assumption)*. The rehearsal and the camera-free listening precede the freeze and are development data; their plans are not in `freeze_manifest.json` [8.4].

## 9. Numbers sessions [4.3-4.5, 4.7, 7.10, 10.4-10.7]

### 9.1 What is tested

Confirmatory data come only from the numbers sessions, with the trace detector frozen at `freeze-1`. The gate's objections (at most 14), the rehearsal and the demo takes are reported apart, never pooled.

- **H1, main:** among objections matched to a presented planted error, the share with a stop before the voice is above chance: exact binomial test, one-sided, α = 0.05, against the largest chance estimate (§9.2). Beside it: (1) the share counting only leads under 300 ms; (2) the share among all objections, those outside every catch window included; (3) the share without "no signal" objections.
- **Lead**, an estimate without a test: the median lead over the stops before the voice, with a 95% interval from order statistics (with 5 values or fewer no such interval exists, and the range is printed); beside it, the median over all stops from `t_v - W` to `t_v + 0.5 s`.
- **H3**, the chest stops the narrator earlier than the lips, and **H4**, earlier than the 250 ms rule: one-sided sign tests on the matched objections (§6.5), with Holm's correction for the two; H4 prints both false-hold rates, A250's zero by construction. The same pair counts over all objections are printed as a descriptive line.
- **Descriptive**, everything else: the `talking` flag, head motion, A100 and A500, audible in-breaths, the spacebar block, and habituation, per session the median of the largest `v` in the 1.5 s before `t_v` over objections on planted errors.

The receipt prints `r_prompt`, the share of trace stops outside all catch windows followed by speech within `W`; the session instruction says to stay silent if the narrator stops and no error was heard [10.4]. Shares carry 95% Wilson intervals and the sensitivity lines of §5; the caught share of presented planted errors is also printed by class, beside the counts caught late and missed. Every published number carries its n and the setup line: one person, one setup, the SDK version, the number of events.

### 9.2 Chance level [4.3]

Three estimates; the largest goes into the test, the receipt and the article.

1. **Poisson:** `p0 = 1 - exp(-λ * W / 60)`, `λ` per minute and `W` in seconds, with `λ` from the same sessions replaced by its one-sided 95% exact Poisson upper bound (32 false holds in 16 active minutes give a bound of 2.7 and `p0` = 6.5%).
2. **Circular shifts:** per session, all objection times shift round the active time by one random shift common to all, 10 000 times, keeping their gaps, after the objections are cut out of the time line from 3 s before the voice onset to the end of the post-voice period *(assumption)*. The share of shifted objections with a stop in `W` before them is pooled over sessions per shift; the estimate is its mean. The generator is seeded and the seed recorded *(assumption)*.
3. **Sentence ends** *(assumption: in-breaths and objections may both follow the narrator's phrases)*: after each sentence end with no objection within the catch-window bound *(assumption)*, a pseudo voice onset is placed at the participant's median response delay, from the end of the changed span to the voice onset over the caught errors of the same sessions *(assumption)*. Points whose `W` is not in active time (checked as for "armed") are dropped; the estimate is the share of the rest with a trace-detector stop in `W` before them.

A sensitivity line prints estimate 1 with the window set to that median delay.

### 9.3 Preflight, exclusions and order [4.5, 10.4-10.6]

Exclusions are decided from the logs before detector outputs are joined.

- **Preflight**, before any sealed audio: the trace sign with its margin equals the gate's (§6.1); the trace rate is at least 25 samples per second; loop check A is within 3 ms of the `doctor` value; the microphone processing flags are `false`; the narrator's leak into the microphone is at most the background plus 6 dB. A preflight failure is not a session, nor is an SDK `error` or `tap_lost` before the first sealed audio *(assumption)*.
- **A void session** (§4) stays listed and named with its reason, its passages are never played again, and it is replaced on the reserve text with the same scenario before the reveal. With one reserve, a second void session is not replaced, and the article reports two sessions and says so. Few objections, a weak share or fatigue void nothing.
- **A session stopped with `Stop`** is aborted: not in the numbers, not replaced, named in the article with its counts of `CHEST` stops and of utterances before the press.
- **A "no signal" objection** keeps its outcome in the main share, flagged; only line (3) of §9.1 leaves it out.
- **A plan seen by accident** before a session: its text is replaced by the reserve before recording. After the session but before the reveal: the session stays in the detector numbers, but its labels yield no own finds. Both go into the step ledger and the article; the one reserve covers both.
- **Order** [10.5]: between sessions only quickcheck, `npm run clocks` and the participant's labelling (`review`) run. After the last session and the spacebar block come `label`, `score`, `review`, `reveal`, `receipt` and `pack` in step-ledger order, then `npm run results`.

## 10. Demo takes: the take rule [15.3]

Written before the first take:

1. There are at most three takes: `demo-1`, `demo-2`, `demo-3`. Each has its own text and its own sealed plan, and all three plans are listed in `freeze_manifest.json`.
2. The first take that passed the clock check and contains at least one stop before the voice by the trace detector is published.
3. If there is no such take, the last take is published, whatever it contains.
4. The screen carries the caption `take k of n`. The receipt of every recorded take is published in its folder `data/<id>/`.
5. Filming ends after the first take that qualifies under point 2.
6. A take counts as recorded once its sealed audio has started playing. A preflight failure is not a take.

Point 2 is read from each take's clock report and receipt; the plan of a take never recorded is marked `unused` in `results.json`.

## Placeholders

Each placeholder in double braces above is replaced by its value before the tag, and the tag is set only when none is left; `npm run freeze -- gate-prereg` refuses otherwise. The names below are written without braces.

| Name | Value and source |
|---|---|
| `CUES_SHA256_0` | SHA-256 of the exact bytes of `gate/pack-0/cues.json`, lowercase hex: `shasum -a 256 gate/pack-0/cues.json` |
| `CUES_SHA256_A`, `CUES_SHA256_B`, `CUES_SHA256_C` | The same for `gate/pack-A/cues.json`, `gate/pack-B/cues.json` and `gate/pack-C/cues.json` |
| `VAD_FLOOR_DB` | The voice detector's noise floor in dB, from `npm run doctor` |
| `VAD_PERIODICITY` | The periodicity threshold: 0.5, or the value raised by the in-breath test of §5, at most 0.7, from `npm run doctor` |
| `LRT_THRESHOLDS_CONFIRMED` | "confirmed: 3 ms and 15 ms" or the changed values, with the `L_rt` of the two loop checks 5 minutes apart, from `npm run doctor`; changed values also replace the numbers in §4 and §7.4 |
| `APP_COMMIT` | The git commit of the app, the gate analysis code and `params/frozen.json` that this file describes, filled in last, in a commit that changes only `PREREG.md` |
