# npm run replay: recompute a gate verdict from its published set

`npm run replay` reads a published day-1 gate set, `data/<id>/` (spec 8.7), recomputes the
numbers of its verdict with stage B's own functions (`analysis/gate/score.ts` `scoreGate` and what
it calls) and compares each one with the set's `verdict.json`. It needs no camera, no API key and
no session folder.

```sh
npm run replay -- gate-a                                  # data/gate-a/ (COPYHOLDER_DATA_DIR, else data/ under the repository root)
npm run replay -- gate-a gate-b gate-c                    # several sets
npm run replay -- path/to/gate-a                          # a set in another folder
npm run replay -- gate-a --params path/to/frozen.json     # the params stage B scored with
npm run replay -- gate-a gate-b gate-c --json replay.json --svg replay.svg --png replay.png
PW_CHROMIUM_PATH=/usr/bin/google-chrome npm run replay -- gate-a --png replay.png
```

Exit codes:

| Code | When |
|---|---|
| 0 | verified: the verdict and the five row outcomes of every set are recomputed and match without a condition, and no recomputed value differs |
| 1 | a recomputed value differs from the set, or a set or an output is refused |
| 2 | usage: an unknown option, an option without its value, the same set named twice, or a path inside `gate/` or `sample/` |
| 3 | no recomputed value differs, but the verdict or a row outcome of a set is not recomputable from it, or matches only under a condition the set does not show |

A set exactly as pack writes it on main ends with exit 3: its verdict needs the cue and step marks,
which no published file holds (see `marks.jsonl` below). Exit 0 needs a set with `marks.jsonl`.

## What it reads

Seven files of the set, each checked with its validator from `core/schemas`, and two optional
files when the set has them. Replay reads the files of the set folder only: a file that leads
out of it through a link is refused. It never reads or writes inside `gate/` or `sample/`: a set
folder, `--params`, `--json`, `--svg` and `--png` there are a usage error.

| File | What replay takes from it |
|---|---|
| `manifest.json` | id and pack; it must be a gate record of pack A, B or C, with the id and pack of `verdict.json` |
| `stream.jsonl` | the detector inputs and the arrival `nArr` of each packet (`core/detector` `parseStream`): what stage B reads from `detector_in.jsonl` and the `arr` lines of `stamps.jsonl`; a file without a packet is refused |
| `onsets.json` | the replies, their automatic onsets and the blind hand marks |
| `calib.json` | L_rt and its rule, the trace sign, the sniff lag block of row 4 |
| `clock_report.json` | the onset P90 the label step wrote, checked against the hand marks |
| `verdict.json` | the values to compare, and `params_sha256` and `tuning` to find the params |
| `verdict.md` | checked against the text stage B writes from `verdict.json` (`analysis/gate/verdict-text.ts`) |
| `marks.jsonl` (optional) | the cue and step marks: the `"mark"` lines of `stamps.jsonl` |
| `g_resets.json` (optional) | the packets stage B read as reset frames of G |

A set without `verdict.json` is refused with the reason pack leaves it out (the recording does not
count, or its stage B has not run). A set with `verdict.json` but without `verdict.md` or
`onsets.json` is refused as not whole.

### The params

The params are the file whose SHA-256 `verdict.json` holds, hashed as stage B hashes it. Replay
looks in this order and stops at the first file that gives the hash:

1. the file named with `--params`, else `params/retune.json` and then `params/frozen.json`;
2. `params/retune.json` under the tag `gate-retune` (packs B and C, when the working copy lost it);
3. the file stage A wrote, rebuilt: `params/frozen.json` under the tag `gate-prereg` with `k`,
   `criterion_met` and `theta_G` of `verdict.json`. Without the tag (a copy of the repository
   without git), a params file at hand without `k`, `theta_G` and `tuned` stands in for the
   tagged copy, as stage A checks the two are equal.

Stage A of each later pack writes `params/frozen.json` anew, so for an earlier pack step 3 is the
usual one. When nothing gives the hash, replay refuses the set and lists every place it tried with
the first 8 hex digits of its hash.

## What it prints

Per set: where the params come from, notes, then one line per value with its name, the recomputed
value, the value in the set and a status:

| Status | Meaning |
|---|---|
| `MATCH` | recomputed, and equal to the set |
| `MATCH if <condition>` | the readings of the set give different values, and the one the set holds comes from the reading named; the set does not show that reading (see "Readings" below) |
| `DIFFERS` | recomputed, and not equal to the set |
| `not recomputable from the set: <why>` | the value needs a file the set does not hold; the reason names it. Never skipped, never a difference |
| `an input of the replay: <why>` | replay takes the value from the set to find what stage B scored with, so it is no result: `params_sha256` always, and `tuning` when replay rebuilt the params with it |

A line per set counts the statuses, and the last line gives the outcome of the exit code.

## What it recomputes

- `run` and `exploratory`: stage B writes `verdict.json` on its confirmatory run, run 1, and never
  on an exploratory one (the ledger refuses an exploratory `stage_b` before the confirmatory one);
- `tuning` (`k`, `criterion_met`, `theta_G`): where the params hold stage A's tuning (`tuned`
  names `stage_a` for `k` and `theta_G`), replay runs stage A's tuning again on the listening
  block (`analysis/gate/tune.ts` `tuneStageA`, on the inputs before the objections mark). On pack
  A, the recording stage A tunes on, that tuning must give the values of `verdict.json`. Packs B
  and C are scored with pack A's params once the retune froze them (PREREG §11): there `tuning`
  counts as recomputed only where tuning again gives the values of the params (a pack recorded as
  the gate after a lost pack A, PREREG §7.4); otherwise it is checked against the params and a
  note gives what tuning again gives. Params of the retune are checked against the params;
- `clock`: L_rt A and B, their difference and rule from `calib.json`, and the onset P90 from the
  hand marks of `onsets.json`;
- the valid objections: `events` (`cued`, `valid`, `armed`, `audible_inbreath`), and a note for
  each cue without one, with stage B's reason;
- D1 (chest) and G (lips) stops, each with its own stop model, counted in a note;
- `rows.hits`, `rows.lead`, `rows.false_holds` (with the in-sample rates of the listening
  block), `rows.chest_vs_lips` and their outcomes;
- `rows.sniff_lag`: `n`, `no_arrival`, the medians and their bound as `calib.json` holds them,
  and the outcome;
- `misses`, `other`, `manual_changes` and `verdict`.

Three more lines check other files of the set: `labels_sha256` of `onsets.json` against its
labels and hand marks (stage B refuses labels that do not give it), the onset P90 of
`clock_report.json` (stage B reads it there) against the hand marks, and `verdict.md` against the
text stage B writes from `verdict.json`; a note quotes the first line that differs.

## What it cannot recompute, and why

| Value | Needs | Why it is not in the set |
|---|---|---|
| everything that depends on the cues or the blocks: `events`, the five row outcomes, rows 1, 2, 3 and 5, `misses`, `other`, `manual_changes`, `verdict`; with them stage A's `tuning` and the in-sample rates | the cue and step marks: lines `{"k":"mark","what":"cue"}` and `{"k":"mark","what":"step"}` of `stamps.jsonl` (`analysis/gate/view.ts` `gateLayout`, `scoredCues`) | `stamps.jsonl` is never published (spec 8.7); `stream.jsonl` keeps only the `nArr` of its `arr` lines, and `events.jsonl` holds no marks. `marks.jsonl` carries them |
| every value that needs the cues, when `marks.jsonl` has no step mark after the cues | the end of the scored block, which stage B then takes from the last stamp of `stamps.jsonl` or its last audio chunk (`gateLayout`) | `stamps.jsonl` is never published |
| values of G (row 5, `in_sample_lips_per_min`, `manual_changes`, `verdict`) when `stream.jsonl` has packets with `g` null and the readings give them differently | `lm` of each `"m"` line of `samples.jsonl` (`analysis/rivals` `gResetSeqs`): a reset frame restarts G's baseline, a packet without a landmark frame does not | `samples.jsonl` is never published. `g_resets.json` carries the answer |
| `rows.sniff_lag.best_case_ms`, `rows.sniff_lag.d1_on_sniffs_ms` | the sniff onsets stage B finds in `audio.wav` channel 0 after the `sniff_<i>` step marks, placed by the chunk stamps of `stamps.jsonl` (`analysis/clocks/compute.ts` `recountSniffLag`) | `stamps.jsonl` is never published, and replay reads no audio |
| all of row 4 when `calib.json` has no `sniff_lag_ms` | the same recount, with the arrivals of `samples.jsonl` | as above; `samples.jsonl` is never published |
| the grade of row 4 (and `verdict`) when a median of `calib.json` is 150.0 (hi) or 350.0 (lo) | the unrounded medians of the recount | `calib.json` holds them to 0.1 ms |
| `other`, when `verdict.json` has none and replay computes one | whether stage B ran with `--no-other` (spec 14.4) | the set does not say |

## Readings

Where the set leaves something open, replay scores every case it can tell apart, a reading, and
compares the set with each:

- G: `live/reduce.cjs` writes `g` null on a reset frame and on a packet without a landmark frame.
  Without `g_resets.json`, replay scores two readings: every packet with `g` null a reset frame,
  and none. With one such packet these are the only cases; with more, a mix of them is not scored
  (assumption: a value both extremes give alike is the one stage B found).
- Row 4: at a threshold, the grade of the medians before rounding on both sides of it; without a
  sniff block, every grade.

A value every reading gives alike is checked as any other. Values the readings give differently
must all come from one reading at once: then each reads `MATCH if <that reading>`, which is not
verified (exit 3). When no one reading gives them all, they read `DIFFERS` if the readings cover
every case (one packet with `g` null, or row 4 alone), and otherwise "not recomputable from the
set", since a mix of the readings could give them.

## marks.jsonl and g_resets.json

On main, pack publishes neither file; both are an assumption of replay, and `core/schemas`
`checkPublishedNames` reports them as "not part of data/<id>/" until `PUBLISHED_FILES` lists them
and pack writes them.

- `marks.jsonl` holds the `"mark"` lines of `stamps.jsonl` as they are, in file order: step names,
  cue numbers and sample numbers, no text and no times of words. Replay refuses a line that is not
  a mark, and marks that do not fit `onsets.json`: cue numbers that do not rise in time order, a
  reply whose cue has no mark, a reply that ends before the mark of its cue or begins more than
  10 s after it.
- `g_resets.json` is `{"schema":"g-resets/1","seqs":[...]}`: the packets stage B read as reset
  frames of G (`gResetSeqs` on `samples.jsonl`), in ascending order. Replay refuses a seq that is
  no packet of `stream.jsonl` with `g` null.

Beyond those checks both are trusted as published, like `stream.jsonl`: nothing else in the set
ties them to the recording.

## Table and figure

`--json <file>` writes the table `replay-table/2`: one row per cue of the scored block, set after
set, with pack, id, cue number, whether it holds a valid objection or why not, the voice onset
and the onset of the manual line (the hand mark, or the voice onset where the mark has no first
sound), for the chest and for the lips the earliest stop within 1500 ms before to 500 ms after
the voice onset with its lead, hit or miss, armed, audible in-breath (valid objections only, as
stage B counts them), and the false stops (`rows.ts` `isFalseStop`) whose fire lies between this
cue and the next. Times are ms from the step mark that starts the objection block; a lead is
t_v - t_s, positive when the stop came before the voice, as stage B signs it. A lips cell the
readings of G place differently is null, with `lips_why`; each set's summary says where its reset
frames come from (`g_resets`) and lists those cues (`lips_unknown`). Only times and counts: no
text of the pack and nothing of the narrator. Before writing, replay checks that the rows add up
to the recomputed verdict (cues, valid objections, hits, armed objections, audible in-breaths and
the false stops of row 3); a table that does not is not written.

`--svg <file>` and `--png <file>` draw every valid objection of all sets: one dot per objection
in the chest row and in the lips row, at t_s - t_v from -1500 to +500 ms (left of 0 the narrator
went silent before the voice; the caption says that stage B's lead is the same value with the
sign turned), objections without a stop in that window in the "no stop" column, and n in each
row's label. The lips row leaves out the cues whose lips stop the readings of G place
differently, and the footnote names them. The SVG is plain, on a white box, without fonts or
scripts; the PNG is that SVG drawn by headless Chrome at twice its size, 1200 px wide, with the
Chrome of `--chrome <path>` or `PW_CHROMIUM_PATH`, else Playwright's own Chromium.

All three need the cues of every set: without `marks.jsonl` replay writes none of them and exits 1.

## Tests

`analysis/replay/replay.test.ts` scores synthetic recordings (`analysis/gate/synth.ts`) with
stages A and B as `analysis/gate.test.ts` does and publishes them as pack does: `stream.jsonl`
from `detector_in.jsonl` and `stamps.jsonl`, the other files copied, the unpublished ones left
out. On those sets it shows that:

- with `marks.jsonl`, every value matches but the two recounts of row 4, stage A's tuning
  included, `params_sha256` reads as an input, and replay exits 0, also for a recording whose
  params stage A of the next recording overwrote;
- without `marks.jsonl` replay exits 3, also when `verdict.json` was changed, `tuning` is an
  input when replay rebuilt the params with it, and `--json` and `--svg` are refused;
- a changed count, row outcome or verdict word, a `k` stage A did not find (also with
  `params_sha256` set to match it), a `run` or `exploratory` stage B never writes, and a changed
  or added line of `verdict.md` each read DIFFERS, and replay exits 1;
- one changed hand mark makes the labels hash and the onset P90 differ;
- params with another hash are refused after every place replay looks, and the params are found
  under `gate-retune` and rebuilt without the tags;
- an empty `stream.jsonl`, a set without `verdict.json`, `verdict.md` or `onsets.json`, a folder
  that does not exist, a `marks.jsonl` with a line that is not a mark or marks of another
  recording, a file that leads out of the set folder and a `g_resets.json` that names a packet
  with `g` set are each refused with the file named, and the other sets are still replayed;
- with one packet with `g` null, the counts of row 5 the readings give differently match under
  the reading that gives them, the verdict both readings give alike is verified (exit 0), and a
  changed verdict, outcome or pair of row 5 counts reads DIFFERS; with fourteen, the verdict
  matches only under a condition (exit 3) and counts neither reading gives are not recomputable;
  with `g_resets.json` every value is verified; the table and the figure leave out only the lips
  stops the readings place differently;
- pack B scored with pack A's params keeps `tuning` checked against the params and a changed `k`
  differs; a pack B tuned as the gate gets its tuning recomputed; params of the retune keep theirs;
- after stage B with `--no-other`, `other` reads not recomputable and replay exits 0; without
  `sniff_lag_ms` in `calib.json` every number of row 4 does and the verdict matches only under a
  condition; at a threshold of row 4 the grade matches only under a condition, and a grade no side
  gives differs; without the step marks after the cues, the values that need the cues are not
  recomputable while stage A and the in-sample rates are;
- the table has one row per cue with the counts of the recomputed verdict, the check before
  writing names rows that do not add up, and the SVG has one circle per valid objection in each
  row; options, the data folder, a set named twice and paths inside `gate/` or `sample/` are
  usage errors.

`analysis/replay/figure.test.ts` checks the figure on a table made by hand, and draws the PNG
(1200 px wide) when a Chrome starts; without one that test is skipped, as in `tools/video`.

```sh
PW_CHROMIUM_PATH=/usr/bin/google-chrome npx vitest run analysis/replay --maxWorkers 2
```
