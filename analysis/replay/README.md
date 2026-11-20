# npm run replay: recompute a gate verdict from its published set

`npm run replay` reads a published day-1 gate set, `data/<id>/` (spec 8.7), recomputes the
numbers of its verdict with stage B's own functions (`analysis/gate/score.ts` `scoreGate` and what
it calls) and compares each one with the set's `verdict.json`. It needs no camera, no API key and
no session folder: everything it reads is in the set as `npm run pack` writes it.

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
| 0 | verified: the verdict and the five row outcomes of every set are recomputed and match without a condition, and no recomputed value differs; the last line names any other value a set leaves not recomputable, which stays unchecked |
| 1 | a recomputed value differs from the set, a set is refused, or an output asked for is not written (see "Table and figure") |
| 2 | usage: an unknown option, an option without its value or given twice, no set named, the same set named twice, or a path inside `gate/` or `sample/` |
| 3 | no recomputed value differs, but the verdict or a row outcome of a set is not recomputable from it (a set without `verdict.json` has none), or matches only under a condition the set does not show. With `--json`, `--svg` or `--png`, which need the verdict and the cues of every set, a set without `verdict.json` or `marks.jsonl` ends the run with 1 instead |

Pack writes `marks.jsonl` and `g_resets.json` into every gate set, and `sniff_onsets.json` into
one with its verdict (see below), so a set as pack writes it is verified (exit 0) when stage B's
verdict follows from it, with every value of `verdict.json` checked, and the sniff block of
`calib.json` checked against the recount. A set without `sniff_onsets.json` is verified as well,
but `best_case_ms` and `d1_on_sniffs_ms` of row 4 stay unchecked, and the last line names them;
the other numbers of row 4 then come from the sniff block of `calib.json`, as stage B copies
them, and nothing checks that block. A set without `marks.jsonl`, as an earlier pack wrote it,
ends with exit 3: its verdict needs the cue and step marks. So does the set of a recording that
never reached its verdict: it has no `verdict.json` to recompute.

## What it reads

Ten files of the set, each checked with its validator from `core/schemas`. Replay reads the
files of the set folder only: a file that leads out of it through a link is refused. It never
reads or writes inside `gate/` or `sample/`: a set folder, `--params`, `--json`, `--svg` and
`--png` there are a usage error.

| File | What replay takes from it |
|---|---|
| `manifest.json` | id and pack; it must be a gate record of pack A, B or C, with the id and pack of `verdict.json` |
| `stream.jsonl` | the detector inputs and the arrival `nArr` of each packet (`core/detector` `parseStream`): what stage B reads from `detector_in.jsonl` and the `arr` lines of `stamps.jsonl`; a file without a packet is refused |
| `onsets.json` | the replies, their automatic onsets and the blind hand marks |
| `calib.json` | L_rt and its rule, the trace sign, the sniff lag block of row 4, checked against the recount from `sniff_onsets.json` |
| `clock_report.json` | the onset P90 the label step wrote, checked against the hand marks |
| `verdict.json` | the values to compare, and `params_sha256` and `tuning` to find the params |
| `verdict.md` | checked against the text stage B writes from `verdict.json` (`analysis/gate/verdict-text.ts`) |
| `marks.jsonl` | the cue and step marks: the `"mark"` lines of `stamps.jsonl`; a set without it still replays (see below) |
| `g_resets.json` | the packets stage B read as reset frames of G; a set without it still replays (see "Readings") |
| `sniff_onsets.json` | the sample numbers of the sniffs stage B heard in `audio.wav` channel 0, from which replay recounts row 4; a set without it still replays (see below) |

A set with `verdict.json` but without `verdict.md`, `stream.jsonl`, `onsets.json`, `calib.json` or
`clock_report.json` is refused as not whole, and so is a set with `verdict.md` but without
`verdict.json`.

A set without `verdict.json` is the set of a recording that never reached its verdict: pack writes
it without the verdict files when the recording does not count or its stage B has not run (PREREG
sections 7 and 11), and pack A's set of such a recording ends at the step mark of the objection
block, without `onsets.json`, while part B is held back (PREREG section 7.5). Replay reads each file
of such a set that it reads in any set, with the same checks (`g_resets.json` against
`stream.jsonl`, the labels hash and the onset P90 where `onsets.json` is there), prints the
verdict as not recomputable with that reason, scores nothing, and exits 3 when nothing differs.

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

A line per set counts the statuses, and the last line gives the outcome of the exit code; on exit 0
it names every value a set leaves not recomputable.

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
  and the outcome, as stage B copies and grades them; with `sniff_onsets.json` replay recounts
  the sniff lag as stage B does (`analysis/replay/sniffs.ts` `sniffRecountFrom`), which gives
  `best_case_ms`, `d1_on_sniffs_ms`, the grade on the unrounded medians, every number of the row
  when `calib.json` has no sniff block, and the block a line below checks `calib.json` against;
- `misses`, `other`, `manual_changes` and `verdict`.

More lines check other files of the set:

- `labels_sha256` of `onsets.json` against the hash of its labels and hand marks, as stage B
  checks it. Stage B refuses an `onsets.json` without the hash (`analysis/gate/inputs.ts`
  `requireLabelsHash`), so in a set with `verdict.json` a null hash reads DIFFERS, with a note.
  In a set without `verdict.json` null is what the onsets step writes before the label step, and
  it stands while no event holds a label or a hand mark;
- the onset P90 of `clock_report.json` (stage B reads it there) against the hand marks;
- with `sniff_onsets.json`, the sniff block of `calib.json` (`calib.json sniff_lag_ms`) against
  the block the clocks step writes for the recounted lag (`analysis/clocks/compute.ts`
  `calibSniffLagBlock`), null where the recount measures no lag (no A_ref). Stage B copies the
  numbers of the block into row 4 and grades the row on them, and when its own recount differs it
  only says so in a note; this line ties those numbers to the recording. A `calib.json` without a
  sniff block reads as null, so it differs beside a recount that measures a lag: the clocks step
  writes the block whenever it measures one. Each block prints as the first 8 hex digits of the
  SHA-256 of its JSON; when `calib.json` holds a block the recount does not give, a note gives
  both;
- `verdict.md` against the text stage B writes from `verdict.json`; a note quotes the first line
  that differs. Where a median of row 4 sits on a threshold, stage B may add that it graded the
  medians before rounding: with `sniff_onsets.json` replay knows whether it did and takes only
  that text, and without the file it takes either.

## What it cannot recompute, and why

| Value | Needs | Why it is not in the set |
|---|---|---|
| everything that depends on the cues or the blocks: `events`, the five row outcomes, rows 1, 2, 3 and 5, `misses`, `other`, `manual_changes`, `verdict`; with them stage A's `tuning` and the in-sample rates | the cue and step marks: lines `{"k":"mark","what":"cue"}` and `{"k":"mark","what":"step"}` of `stamps.jsonl` (`analysis/gate/view.ts` `gateLayout`, `scoredCues`) | `stamps.jsonl` is never published (spec 8.7); `stream.jsonl` keeps only the `nArr` of its `arr` lines, and `events.jsonl` holds no marks. `marks.jsonl` carries them |
| every value that needs the cues, when `marks.jsonl` has no step mark after the cues | the end of the scored block, which stage B then takes from the last stamp of `stamps.jsonl` or its last audio chunk (`gateLayout`) | `stamps.jsonl` is never published |
| values of G (row 5, `in_sample_lips_per_min`, `manual_changes`, `verdict`) when `stream.jsonl` has packets with `g` null and the readings give them differently | `lm` of each `"m"` line of `samples.jsonl` (`analysis/rivals` `gResetSeqs`): a reset frame restarts G's baseline, a packet without a landmark frame does not | `samples.jsonl` is never published. `g_resets.json` carries the answer |
| `rows.sniff_lag.best_case_ms`, `rows.sniff_lag.d1_on_sniffs_ms`, when the set has no `sniff_onsets.json` | the sniff onsets stage B finds in `audio.wav` channel 0 after the `sniff_<i>` step marks (`analysis/clocks/compute.ts` `recountSniffLag`) | replay reads no audio, and `audio.wav` is published only with `pack --with-audio`. `sniff_onsets.json` carries the onsets |
| all of row 4 when `calib.json` has no `sniff_lag_ms` and the set has no `sniff_onsets.json` | the same recount | as above |
| the grade of row 4 (and `verdict`) when a median of `calib.json` is 150.0 (hi) or 350.0 (lo) and the set has no `sniff_onsets.json` | the unrounded medians of the recount | `calib.json` holds them to 0.1 ms |
| `other`, when `verdict.json` has none and replay computes one | whether stage B ran with `--no-other` (spec 14.4) | the set does not say |

## Readings

Where the set leaves something open, replay scores every case it can tell apart, a reading, and
compares the set with each:

- G: `live/reduce.cjs` writes `g` null on a reset frame and on a packet without a landmark frame.
  Without `g_resets.json`, replay scores two readings: every packet with `g` null a reset frame,
  and none. With one such packet these are the only cases; with more, a mix of them is not scored
  (assumption: a value both extremes give alike is the one stage B found).
- Row 4, for a set without `sniff_onsets.json`: at a threshold, the grade of the medians before
  rounding on both sides of it; without a sniff block, every grade. With the file replay grades
  row 4 as stage B does.

A value every reading gives alike is checked as any other. Values the readings give differently
must all come from one reading at once: then each reads `MATCH if <that reading>`, which is not
verified (exit 3). When no one reading gives them all, they read `DIFFERS` if the readings cover
every case (one packet with `g` null, or row 4 alone), and otherwise "not recomputable from the
set", since a mix of the readings could give them.

## marks.jsonl, g_resets.json and sniff_onsets.json

Pack writes the first two into every gate set and `sniff_onsets.json` into one with its verdict
(`analysis/pack.ts` `marksJsonl`, `gResetsJson` and `sniffOnsetsJson`), and `core/schemas` lists
them in `PUBLISHED_FILES` with their validators, `validateMarkLine`, `validateGResets` and
`validateSniffOnsets`, as files of the gate set only; a headstart set gets none of them. A set an
earlier pack wrote may lack them: replay still reads it, and every value that needs them is not
recomputable from it or is scored under each reading.

- `marks.jsonl` holds the `"mark"` lines of `stamps.jsonl` as they are, in file order: step names,
  cue numbers and sample numbers, no text and no times of words. Its validator takes exactly the
  three lines Deck writes: a step mark with `n`, `k`, `what` and `name`, a cue mark with `n`, `k`,
  `i`, `what` and `on`, and a key mark with `n`, `k` and `what`, each with no other field, and
  step names of lowercase letters, digits and `_`, so no text can ride along. Each line must be
  as `JSON.stringify` writes its fields, as Deck writes it: with a key given twice `JSON.parse`
  keeps one value, and the other would be published without any check reading it, so pack
  refuses a recording with such a mark line, and `validatePublishedFolder` and replay refuse such
  a line in `marks.jsonl` (`core/schemas` `inexactJsonlLines`). Where pack holds
  part B back, the file holds the marks before the step mark of the objection block, the ones
  stage A reads. Replay refuses a line the validator refuses, and marks that do not fit
  `onsets.json`: cue numbers that do not rise in time order, a reply whose cue has no mark, a reply
  that ends before the mark of its cue or begins more than 10 s after it.
- `g_resets.json` is `{"schema":"g-resets/1","seqs":[...]}`: the packets stage B read as reset
  frames of G, in ascending order. Pack finds them as stage B does, `gResetSeqs` on the lines of
  `detector_in.jsonl` and `samples.jsonl`, and keeps the packets of the published `stream.jsonl`
  (where part B is held back, the ones stage A reads). Pack refuses a recording whose
  `samples.jsonl` flags a reset frame on a packet with a `g` value, and leaves the file out, with a
  note, when `samples.jsonl` has a broken line that is not a last line a crash cut short. Replay
  refuses a seq that is no packet of `stream.jsonl` with `g` null.
- `sniff_onsets.json` is `{"schema":"sniff-onsets/1","onsets":[...]}`: the sample number of the
  onset of each sniff stage B heard in `audio.wav` channel 0, in prompt order. Pack finds them as
  stage B does: it loads the recording as stage B loads it, lays it out with
  `analysis/gate/view.ts` `gateLayout` and runs `recountSniffLag` with the L_rt block and the trace
  sign of `calib.json`. It writes the file only when the recount from the set gives what
  `recountSniffLag` gives on the recording; otherwise, or when stage B's layout of the recording
  fails, it leaves the file out with a note. Replay recounts from the set as stage B recounts from
  the recording (`analysis/replay/sniffs.ts`): A_ref from the trace that arrived during the
  listening step, whose span the step marks of `marks.jsonl` give, the packets and arrivals of
  `stream.jsonl`, and L_rt and the trace sign of `calib.json`. It refuses onsets that do not each
  lie within 2 s after the mark of a sniff step of their own, in prompt order, since stage B
  searches each sniff there.

Beyond those checks all three are trusted as published, like `stream.jsonl`: nothing else in the
set ties them to the recording.

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
Chrome of `--chrome <path>` or `PW_CHROMIUM_PATH`, else Playwright's own Chromium, which
`npx playwright install chromium` installs. Without a Chrome that starts, replay writes no PNG
and exits 1.

All three need the verdict and the cues of every set: when a set has no `verdict.json` or no
`marks.jsonl`, replay writes none of them and exits 1.

## Tests

`analysis/replay/pack-replay.test.ts` runs the chain a clone relies on: synthetic recordings made
to look as host leaves a real one (the real tap and its SDK in `manifest.json`, every recording
file hashed by the record step of `ledger.jsonl`), scored by stages A and B, packed by `npm run
pack`, and replayed from `data/<id>/` alone. It shows that pack A, whose row 5 turns on which
packets with `g` null were reset frames, and pack B, scored with the params the retune froze under
`gate-retune`, each with five sniffs whose best case and D1 on sniffs replay recounts from
`sniff_onsets.json` and whose sniff block in `calib.json` the recount gives, are verified (exit
0), and pack A is not without its `g_resets.json` (exit 3); that one changed number of
`verdict.json` exits 1, `best_case_ms` and `d1_on_sniffs_ms` among them; that without
`sniff_onsets.json` those two stay unchecked and the last line names them (exit 0), and that a
`sniff_onsets.json` whose onsets do not fit the sniff step marks, or that is not valid, is
refused; that the sniff block of `calib.json` changed together with row 4 of `verdict.json`,
both medians 0.1 ms later or past the KILL threshold with the verdict KILL, and `verdict.md`
written anew, exits 1 on the `calib.json` line while row 4 and the verdict match; that a set
whose blind labels were taken out of `onsets.json`, and the onset P90 out of `clock_report.json`,
`verdict.json` and `verdict.md`, exits 1 on the labels hash, and so does one whose `onsets.json`
holds no event and no hash; that the set of a pack A held back at the objection block exits 3
with no value differing, and so does the set of a pack B without a verdict whose `onsets.json`
holds no event and no labels hash; and that `--json`, `--svg` and `--png` write the table and the
figure of two packed sets.

`analysis/replay/replay.test.ts` scores synthetic recordings (`analysis/gate/synth.ts`) with
stages A and B as `analysis/gate.test.ts` does and publishes them as pack does: `stream.jsonl`
from `detector_in.jsonl` and `stamps.jsonl`, the other files copied, the unpublished ones left
out, with or without `marks.jsonl`, `g_resets.json` and `sniff_onsets.json`. On those sets it
shows that:

- with `marks.jsonl` and without `sniff_onsets.json`, every value matches but the two recounts of
  row 4, stage A's tuning included, `params_sha256` reads as an input, and replay exits 0 with a
  last line that names the two, also for a recording whose params stage A of the next recording
  overwrote;
- with `sniff_onsets.json`, on a recording with five sniffs and no sniff block in `calib.json`,
  every number of row 4 is recounted and every value of `verdict.json` matches, but the
  `calib.json` line differs, as the clocks step writes the block of a lag it measures (exit 1);
  with that block the set is verified (exit 0); without the file row 4 is not recomputable and no
  line checks the block (exit 3), and a `sniff_onsets.json` without one of its onsets recounts
  values that differ (exit 1);
- without `marks.jsonl` replay exits 3, also when `verdict.json` was changed, `tuning` is an
  input when replay rebuilt the params with it, and `--json` and `--svg` are refused;
- a set without `verdict.json` and `verdict.md` has its files checked, nothing differs, and replay
  exits 3, also beside a verified set and without `onsets.json`; `--json` is refused, and so are a
  `g_resets.json` that names a packet with `g` set and one without `stream.jsonl`;
- a changed count, row outcome or verdict word, a `k` stage A did not find (also with
  `params_sha256` set to match it), a `run` or `exploratory` stage B never writes, and a changed
  or added line of `verdict.md` each read DIFFERS, and replay exits 1;
- one changed hand mark makes the labels hash and the onset P90 differ;
- params with another hash are refused after every place replay looks, and the params are found
  under `gate-retune` and rebuilt without the tags;
- an empty `stream.jsonl`, a set with `verdict.md` but without `verdict.json`, a set with
  `verdict.json` but without `verdict.md` or `onsets.json`, a folder that does not exist, a
  `marks.jsonl` with a line that is not a mark, a mark line with a key given twice or marks of
  another recording, a file that leads
  out of the set folder and a `g_resets.json` that names a packet with `g` set are each refused
  with the file named, and the other sets are still replayed;
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
- the `calib.json` line takes the block the clocks step writes for the recounted lag, and null
  for a missing block or a lag without A_ref; at a threshold of row 4, `verdict.md` is taken only
  in the wording the recount gives, and in either wording without the recount;
- the table has one row per cue with the counts of the recomputed verdict, the check before
  writing names rows that do not add up, and the SVG has one circle per valid objection in each
  row; options, the data folder, a set named twice and paths inside `gate/` or `sample/` are
  usage errors.

`analysis/replay/figure.test.ts` checks the figure on a table made by hand, and draws the PNG
(1200 px wide) when a Chrome starts; without one that test is skipped, as in `tools/video`.

```sh
PW_CHROMIUM_PATH=/usr/bin/google-chrome npx vitest run analysis/replay --maxWorkers 2
```
