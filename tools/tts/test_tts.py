"""Unit tests for the pure parts of tts.py and words.py (no model needed).

  python3 -m unittest discover -s tools/tts -p "test_*.py"          (python.test.ts runs this)
  uv run --project tools/tts python -m unittest discover -s tools/tts -p "test_*.py"

The kokoro, numpy and soxr checks run only where those packages are installed; the rest runs
with a plain python3.
"""

from __future__ import annotations

import io
import os
import random
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import tts  # noqa: E402
from words import count_passage_words, sentence_starts, split_passage_words  # noqa: E402

VOCAB = {c: i for i, c in enumerate(" .,!?:;abcdefghijklmnopqrstuvwxyzAIOWY", start=1)}  # kokoro: config.json vocab
TT = tts.TokenTime


def tok(text: str, phonemes: str | None, whitespace: str = " ") -> SimpleNamespace:
    return SimpleNamespace(text=text, phonemes=phonemes, whitespace=whitespace, start_ts=None, end_ts=None)


def chunk(tokens: list[SimpleNamespace]) -> str:
    return "".join((t.phonemes or "") + (" " if t.whitespace else "") for t in tokens).strip()


def durations(ps: str, seed: int) -> list[int]:
    rng = random.Random(seed)
    n = sum(1 for c in ps if c in VOCAB)
    return [rng.randint(4, 20)] + [rng.randint(1, 9) for _ in range(n)] + [rng.randint(3, 15)]


class TokenTimes(unittest.TestCase):
    def test_plain_chunk_tiles_the_timeline_from_the_end_of_bos(self):
        tokens = [tok("Hello", "hAlO"), tok("world", "wArld", ""), tok(".", ".", "")]
        ps = chunk(tokens)
        pd = durations(ps, 1)
        times, anomalous = tts.token_half_frames(tokens, ps, pd, VOCAB)
        self.assertFalse(anomalous)
        self.assertEqual(times[0].start, 2 * pd[0])  # no 3-frame lead
        self.assertEqual(times[0].first_end, 2 * (pd[0] + pd[1]))
        self.assertEqual(times[0].last_start, 2 * sum(pd[:4]))
        self.assertEqual(times[0].end, 2 * sum(pd[:5]) + pd[5])  # half of the space
        self.assertEqual(times[0].end, times[1].start)
        self.assertEqual(times[1].end, times[2].start)
        self.assertEqual(times[1].last_start, 2 * sum(pd[:10]))  # "d" is pd[10]
        self.assertLessEqual(times[2].end, 2 * sum(pd))

    def test_matches_kokoro_join_timestamps_when_its_bookkeeping_holds(self):
        try:
            import torch
            from kokoro.pipeline import KPipeline
        except ImportError:
            self.skipTest("kokoro is not installed here")
        rng = random.Random(5)
        for seed in range(400):
            tokens = []
            for _ in range(rng.randint(1, 12)):
                if rng.random() < 0.2:
                    tokens.append(tok("$", "", ""))  # unvoiced, no space: "$" in "$5"
                word = "".join(rng.choice("abcdefgAIO") for _ in range(rng.randint(1, 6)))
                tokens.append(tok(word, word, rng.choice([" ", " ", ""])))
                if rng.random() < 0.3:
                    tokens.append(tok(",", ",", rng.choice([" ", ""])))
            ps = chunk(tokens)
            pd = durations(ps, seed)
            ours, anomalous = tts.token_half_frames(tokens, ps, pd, VOCAB)
            self.assertFalse(anomalous)
            KPipeline.join_timestamps(tokens, torch.tensor(pd))
            tts.check_against_kokoro(tokens, ours, anomalous, tts.kokoro_lead_half_frames(pd))  # raises on any difference

    def test_kokoro_lead_is_three_frames_or_all_of_bos(self):
        self.assertEqual(tts.kokoro_lead_half_frames([14, 1, 1]), 6)
        self.assertEqual(tts.kokoro_lead_half_frames([2, 1, 1]), 4)
        tokens = [tok("a", "a", "")]
        times = [TT(20, 24, 22, 20)]
        tokens[0].start_ts, tokens[0].end_ts = 14 / 80, 18 / 80
        tts.check_against_kokoro(tokens, times, False, 6)
        with self.assertRaises(tts.TtsError):
            tts.check_against_kokoro(tokens, times, False, 0)

    def test_unvoiced_token_without_space_takes_no_time(self):
        # "cost $5": "$" has no phonemes and no space; "5" starts where "cost" ends.
        tokens = [tok("cost", "kOst"), tok("$", "", ""), tok("5", "fIv", "")]
        ps = chunk(tokens)
        pd = durations(ps, 4)
        times, anomalous = tts.token_half_frames(tokens, ps, pd, VOCAB)
        self.assertFalse(anomalous)
        self.assertIsNone(times[1])
        self.assertEqual(times[2].start, times[0].end)
        self.assertEqual(times[2].end, times[0].end + pd[5] + 2 * sum(pd[6:9]))

    def test_unvoiced_token_with_space_does_not_shift_later_words(self):
        # "- item one": kokoro skips two durations for "-" and loses the last word.
        tokens = [tok("-", ""), tok("item", "ItAm"), tok("one", "wAn", "")]
        ps = chunk(tokens)
        pd = durations(ps, 2)
        times, anomalous = tts.token_half_frames(tokens, ps, pd, VOCAB)
        self.assertTrue(anomalous)
        self.assertIsNone(times[0])
        self.assertEqual(times[1].start, 2 * pd[0])
        item = sum(pd[1:5])
        self.assertEqual(times[1].end, times[1].start + 2 * item + pd[5])
        self.assertEqual(times[2].end, times[2].start + pd[5] + 2 * sum(pd[6:9]))

    def test_phonemes_outside_the_vocabulary_take_no_duration(self):
        tokens = [tok("[x]", "[ks]"), tok("y", "wI", "")]
        ps = chunk(tokens)
        pd = durations(ps, 3)
        self.assertEqual(len(pd), len(ps) - 2 + 2)  # "[" and "]" never reach the model
        times, anomalous = tts.token_half_frames(tokens, ps, pd, VOCAB)
        self.assertTrue(anomalous)
        self.assertEqual(times[0].end - times[0].start, 2 * (pd[1] + pd[2]) + pd[3])
        self.assertEqual(times[0].first_end, times[0].start + 2 * pd[1])  # "k", after the dropped "["
        self.assertEqual(times[0].last_start, times[0].start + 2 * pd[1])  # "s", before the dropped "]"

    def test_rejects_mismatched_inputs(self):
        tokens = [tok("a", "A", "")]
        with self.assertRaises(tts.TtsError):
            tts.token_half_frames(tokens, "A", [5, 3], VOCAB)  # durations for no phoneme
        with self.assertRaises(tts.TtsError):
            tts.token_half_frames(tokens, "B", [5, 3, 4], VOCAB)  # other phonemes
        with self.assertRaises(tts.TtsError):
            long = [tok("w", "a" * 511, "")]
            tts.token_half_frames(long, "a" * 511, [1] * 513, VOCAB)


class Segments(unittest.TestCase):
    def test_folds_whitespace_and_maps_back(self):
        text = "  Two  words\there.\n\n--\r\nNext\N{NO-BREAK SPACE}line"
        segs = tts.passage_segments(text)
        self.assertEqual([s.text for s in segs], ["Two words here.", "Next line"])
        for s in segs:
            for k, ch in enumerate(s.text):
                if ch != " ":
                    self.assertEqual(text[s.source[k]], ch)

    def test_lines_are_numbered_as_in_the_file(self):
        text = "One.\n\nTwo.\r\n\r\nThree.\rFour.\N{NEXT LINE}Five.\N{LINE SEPARATOR}Six.\N{PARAGRAPH SEPARATOR}\nSeven."
        self.assertEqual([s.line for s in tts.passage_segments(text)], [1, 3, 5, 6, 7, 8, 10])
        self.assertEqual(tts.line_starts("a\r\nb\n"), [0, 3, 5])

    def test_rejects_misaki_link_markup_with_its_file_line(self):
        with self.assertRaises(tts.TtsError) as e:
            tts.passage_segments("First paragraph.\n\n\n\nSay [this](/DIs/) now.")
        self.assertIn("line 5", str(e.exception))
        self.assertNotIn("this", str(e.exception))

    def test_aligns_tokens_and_tolerates_dropped_punctuation(self):
        seg = tts.passage_segments("He said: don't stop.")[0]
        spans, cursor = tts.align_tokens(seg, [tok("He", ""), tok("said", ""), tok(":", ""), tok("don't", ""), tok("stop", ""), tok(".", "")], 0)
        self.assertEqual(spans, [(0, 2), (3, 7), (7, 8), (9, 14), (15, 19), (19, 20)])
        self.assertEqual(cursor, len(seg.text))
        seg = tts.passage_segments("a'1 b")[0]
        spans, _ = tts.align_tokens(seg, [tok("a1", ""), tok("b", "")], 0)
        self.assertEqual(spans, [(0, 3), (4, 5)])
        with self.assertRaises(tts.TtsError):
            tts.align_tokens(seg, [tok("ab", "")], 0)


class WordSpans(unittest.TestCase):
    def collect(self, text: str, tokens: list, times: list, show_text: bool = False) -> dict:
        words = split_passage_words(text)
        seg = tts.passage_segments(text)[0]
        spans, _ = tts.align_tokens(seg, tokens, 0)
        return tts.chunk_word_spans(words, [w.char_start for w in words], seg, tokens, spans, times, show_text)

    def test_tokens_widen_their_word_and_punctuation_is_a_pause(self):
        # "It's" is read as "It" + "'s"; the comma after "so" is a pause, not part of the word.
        tokens = [tok("It", "ɪt", ""), tok("'s", "s"), tok("so", "sO", ""), tok(",", ",", " "), tok("ok", "OkA", "")]
        times = [TT(0, 4, 2, 2), TT(4, 6, 6, 4), TT(6, 10, 8, 8), TT(10, 30, 30, 10), TT(30, 40, 32, 36)]
        out = self.collect("It's so, ok", tokens, times)
        self.assertEqual(out, {0: TT(0, 6, 2, 4), 1: TT(6, 10, 8, 8), 2: TT(30, 40, 32, 36)})

    def test_spoken_symbol_inside_a_word_widens_it(self):
        tokens = [tok("10", "tˈɛn", ""), tok("%", "pəɹsˈɛnt"), tok("more", "mˈɔɹ", "")]
        out = self.collect("10% more", tokens, [TT(0, 8, 2, 6), TT(8, 20, 10, 18), TT(20, 30, 22, 28)])
        self.assertEqual(out, {0: TT(0, 20, 2, 18), 1: TT(20, 30, 22, 28)})

    def test_spoken_symbol_between_words_stops_without_text(self):
        tokens = [tok("R", "ɑɹ"), tok("&", "ænd"), tok("D", "di", "")]
        times = [TT(0, 8, 4, 4), TT(8, 20, 10, 18), TT(20, 30, 22, 28)]
        with self.assertRaises(tts.TtsError) as hidden:
            self.collect("R & D", tokens, times)
        self.assertEqual(str(hidden.exception),
                         "line 1: a symbol after word 0 (sentence 0) is read aloud but is no word; spell it out or remove it")
        with self.assertRaises(tts.TtsError) as shown:
            self.collect("R & D", tokens, times, show_text=True)
        self.assertIn("'&'", str(shown.exception))
        with self.assertRaises(tts.TtsError) as first:
            self.collect("& more", [tok("&", "ænd"), tok("more", "mˈɔɹ", "")], [TT(0, 8, 2, 6), TT(8, 20, 10, 18)])
        self.assertIn("a symbol before word 0", str(first.exception))

    def test_unvoiced_punctuation_between_words_is_fine(self):
        tokens = [tok("a", "ɐ"), tok("—", "—"), tok("b", "bi", "")]
        out = self.collect("a — b", tokens, [TT(0, 4, 4, 0), TT(4, 10, 10, 4), TT(10, 16, 12, 14)])
        self.assertEqual(sorted(out), [0, 1])

    def test_unvoiced_word_part_fails_without_text(self):
        tokens = [tok("say", "sA"), tok("xyz", "", "")]
        with self.assertRaises(tts.TtsError) as hidden:
            self.collect("say xyz", tokens, [TT(0, 4, 2, 2), None])
        self.assertIn("word 1 (sentence 0)", str(hidden.exception))
        self.assertNotIn("xyz", str(hidden.exception))
        with self.assertRaises(tts.TtsError) as shown:
            self.collect("say xyz", tokens, [TT(0, 4, 2, 2), None], show_text=True)
        self.assertIn("xyz", str(shown.exception))

    def test_is_spoken(self):
        self.assertTrue(tts.is_spoken("pəɹsˈɛnt"))
        for p in (",", ".", "—", "…", "“", "", None):
            self.assertFalse(tts.is_spoken(p))


def quiet_from(pattern: str) -> list[bool]:
    """'#' is sound, '.' is a quiet half-frame."""
    return [c == "." for c in pattern]


class Pauses(unittest.TestCase):
    def test_quiet_runs_and_longest_pause(self):
        q = quiet_from("..##...#.....##")
        self.assertEqual(tts.quiet_runs(q), [(0, 2), (4, 7), (8, 13)])
        runs = tts.quiet_runs(q)
        self.assertEqual(tts.longest_pause(runs, (3, 9), (0, 15)), (8, 13))
        self.assertEqual(tts.longest_pause(runs, (3, 6), (0, 15)), (4, 7))
        self.assertEqual(tts.longest_pause(runs, (3, 9), (0, 10)), (4, 7))  # cut to bounds: 8..10 is shorter
        self.assertIsNone(tts.longest_pause(runs, (14, 15), (0, 15)))
        self.assertIsNone(tts.longest_pause([(4, 5)], (0, 15), (0, 15)))  # shorter than 2 half-frames

    def test_touching_words_keep_the_duration_boundary(self):
        spans = [TT(4, 10, 6, 8), TT(10, 16, 12, 14)]
        q = quiet_from("....######.#####....")  # a short dip inside a phrase is no pause
        edges, moved = tts.place_words_on_pauses(spans, q)
        self.assertEqual(edges, [(4, 10), (10, 16)])
        self.assertEqual(moved, 2)  # the chunk start and end only

    def test_pause_on_the_last_phoneme_leaves_the_word(self):
        # "time. When": the last phoneme of "time" holds most of the pause, "." the rest.
        spans = [TT(2, 30, 4, 10), TT(34, 40, 36, 38)]
        q = quiet_from("..##########......................######..")
        edges, moved = tts.place_words_on_pauses(spans, q)
        self.assertEqual(edges, [(2, 12), (34, 40)])
        self.assertEqual(moved, 4)

    def test_release_burst_after_a_closure_stays_in_the_word(self):
        # "talk, before": vowel, closure, burst, then the pause.
        spans = [TT(0, 20, 2, 10), TT(30, 36, 32, 34)]
        q = quiet_from("############...##...........######")
        edges, _ = tts.place_words_on_pauses(spans, q)
        self.assertEqual(edges[0], (0, 17))
        self.assertEqual(edges[1][0], 28)

    def test_without_a_pause_the_words_meet_in_the_punctuation(self):
        spans = [TT(0, 10, 2, 8), TT(14, 20, 16, 18)]
        edges, moved = tts.place_words_on_pauses(spans, quiet_from("#" * 20))
        self.assertEqual(edges, [(0, 12), (12, 20)])
        self.assertEqual(moved, 0)

    def test_chunk_edges_move_onto_the_leading_and_trailing_silence(self):
        spans = [TT(6, 14, 8, 12)]
        edges, moved = tts.place_words_on_pauses(spans, quiet_from("........#####......."))
        self.assertEqual(edges, [(8, 13)])
        self.assertEqual(moved, 2)

    def test_every_word_keeps_at_least_one_half_frame(self):
        spans = [TT(0, 4, 1, 3), TT(6, 8, 7, 7), TT(10, 14, 11, 13)]
        edges, _ = tts.place_words_on_pauses(spans, quiet_from("#" + "." * 13))
        self.assertTrue(all(a < b for a, b in edges), edges)
        self.assertTrue(all(edges[i][1] <= edges[i + 1][0] for i in range(len(edges) - 1)), edges)

    def test_random_chunks_stay_ordered(self):
        rng = random.Random(11)
        for _ in range(300):
            spans, h = [], rng.randint(0, 6)
            for _w in range(rng.randint(1, 8)):
                n = rng.randint(1, 6)
                first, last = h + 2 * rng.randint(1, n), h + 2 * n - 2 * rng.randint(1, n)
                start, end = h, h + 2 * n
                spans.append(TT(start, end, min(first, end), max(last, start)))
                h = end + (rng.choice([0, 0, 2, 5]))
            q = [rng.random() < 0.5 for _ in range(h + rng.randint(0, 6))]
            edges, _ = tts.place_words_on_pauses(spans, q)
            for i, (a, b) in enumerate(edges):
                self.assertLess(a, b)
                if i:
                    self.assertLessEqual(edges[i - 1][1], a)
                if i and spans[i - 1].end >= spans[i].start:
                    self.assertEqual(edges[i - 1][1], a)  # touching words still touch


class SoundCheck(unittest.TestCase):
    W = tts.WordTiming

    def levels(self, sound: list[tuple[int, int]], total_ms: int) -> list[float]:
        """-20 dBFS inside the given ms ranges, -80 elsewhere, 5 ms frames."""
        return [-20.0 if any(a <= f * 5 < b for a, b in sound) else -80.0 for f in range(total_ms // 5)]

    def test_matching_words_pass(self):
        words = [self.W(0, 100, 400, 0), self.W(1, 400, 700, 0), self.W(2, 1200, 1500, 1)]
        self.assertEqual(tts.sound_problems(self.levels([(110, 690), (1210, 1490)], 2000), words), [])

    def test_a_word_holding_the_pause_is_found(self):
        words = [self.W(0, 100, 900, 0), self.W(1, 1200, 1500, 1)]
        found = tts.sound_problems(self.levels([(100, 600), (1200, 1500)], 2000), words)
        self.assertEqual(found, ["word 0 ends at 900 ms, 300 ms after its sound"])
        words = [self.W(0, 100, 400, 0), self.W(1, 600, 1500, 1)]
        found = tts.sound_problems(self.levels([(100, 400), (1000, 1500)], 2000), words)
        self.assertEqual(found, ["word 1 starts at 600 ms, 400 ms before its sound"])

    def test_sound_outside_every_word_is_found(self):
        words = [self.W(0, 100, 400, 0), self.W(1, 1200, 1500, 1)]
        found = tts.sound_problems(self.levels([(100, 400), (700, 800), (1200, 1500)], 2000), words)
        self.assertEqual(found, ["sound at 700 ms lies outside every word"])
        self.assertEqual(tts.sound_problems(self.levels([(100, 400), (700, 800), (1200, 1500)], 2000), words, slack_ms=400), [])

    def test_frame_levels(self):
        try:
            import numpy  # noqa: F401
        except ImportError:
            self.skipTest("numpy is not installed here")
        levels = tts.frame_levels_db([0.0] * 240 + [0.5] * 240 + [0.1] * 100)
        self.assertEqual(len(levels), 2)
        self.assertEqual(levels[0], -120.0)
        self.assertAlmostEqual(levels[1], -6.0206, places=3)


class Output(unittest.TestCase):
    def test_rounds_samples_to_whole_milliseconds_half_up(self):
        self.assertEqual([tts.samples_to_ms(n) for n in (0, 23, 24, 47, 48, 600, 48000)], [0, 0, 1, 1, 1, 13, 1000])

    def test_half_frames_to_samples(self):
        self.assertEqual(tts.half_frames_to_samples(0, 1), 600)
        self.assertEqual(tts.half_frames_to_samples(1000, 2), 2 * 1000 + 1200)

    def test_wav_header(self):
        try:
            import numpy  # noqa: F401
        except ImportError:
            self.skipTest("numpy is not installed here")
        data = tts.wav_bytes([0.0, 0.5, -0.5])
        self.assertEqual(len(data), tts.WAV_HEADER_BYTES + 12)
        info = tts.parse_wav_header(data)
        self.assertEqual((info["format"], info["channels"], info["rate"], info["bits"], info["frames"]), (3, 1, 48000, 32, 3))

    def test_resampler_keeps_time(self):
        # Word times map native sample n to output sample 2n: soxr must add no delay.
        try:
            import numpy as np
            import soxr
        except ImportError:
            self.skipTest("soxr is not installed here")
        x = np.zeros(24000, dtype=np.float32)
        x[1001] = 1.0
        y = soxr.resample(x, tts.NATIVE_RATE_HZ, tts.OUTPUT_RATE_HZ, quality="VHQ")
        self.assertEqual(len(y), 2 * len(x))
        self.assertEqual(int(np.argmax(np.abs(y))), 2002)
        tone = np.sin(2 * np.pi * 440 * np.arange(24000) / 24000).astype(np.float32)
        ideal = np.sin(2 * np.pi * 440 * np.arange(48000) / 48000)
        up = soxr.resample(tone, tts.NATIVE_RATE_HZ, tts.OUTPUT_RATE_HZ, quality="VHQ")
        self.assertLess(float(np.max(np.abs(up[4800:43200] - ideal[4800:43200]))), 1e-4)

    def test_check_timings(self):
        w = tts.WordTiming
        self.assertEqual(tts.check_timings([w(0, 10, 20, 0), w(1, 20, 30, 0), w(2, 40, 50, 1)], 60), [])
        self.assertEqual(len(tts.check_timings([w(0, 10, 20, 0), w(1, 15, 30, 0)], 60)), 1)
        self.assertEqual(len(tts.check_timings([w(0, 10, 70, 0)], 60)), 1)
        self.assertEqual(tts.check_timings([w(0, 10, 20, 1)], 60), ["the first word is not in sentence 0"])

    def test_timings_json_has_one_word_per_line(self):
        doc = {"schema": tts.SCHEMA, "words": [{"index": 0, "startMs": 1, "endMs": 2, "sentenceIndex": 0}]}
        out = tts.timings_json(doc)
        self.assertIn('\n    {"index": 0, "startMs": 1, "endMs": 2, "sentenceIndex": 0}\n', out)
        import json

        self.assertEqual(json.loads(out), doc)

    @unittest.skipIf(os.name != "posix", "file modes are POSIX")
    def test_outputs_are_private_to_their_owner(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sub" / "out.json"
            tts.write_atomic(path, b"{}")
            self.assertEqual(path.read_bytes(), b"{}")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(os.listdir(path.parent), ["out.json"])

    def test_reads_the_passage_from_stdin_or_a_file_without_bom(self):
        fake = SimpleNamespace(buffer=io.BytesIO("﻿Hello there.\n".encode("utf-8")))
        with mock.patch.object(sys, "stdin", fake):
            self.assertEqual(tts.read_passage(Path("-")), "Hello there.\n")
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "in.txt"
            p.write_bytes(b"One two.")
            self.assertEqual(tts.read_passage(p), "One two.")

    def test_one_line(self):
        self.assertEqual(tts.one_line("RuntimeError: bad\n  thing\r\nhere\t now "), "RuntimeError: bad thing here now")


class Words(unittest.TestCase):
    def test_words_and_sentences(self):
        words = split_passage_words("Mr. Smith left. \N{EM DASH} It's 3.30 p.m. now!")
        self.assertEqual([(w.text, w.sentence_index) for w in words],
                         [("Mr.", 0), ("Smith", 1), ("left.", 1), ("It's", 1), ("3.30", 1), ("p.m.", 1), ("now!", 1)])
        # An em dash after "left. " continues the sentence (UAX #29 SB8a), as in Intl.Segmenter.
        self.assertEqual(count_passage_words("a -- b ..."), 2)
        self.assertEqual(sentence_starts("One.\r\nTwo"), [0, 6])
        self.assertEqual(sentence_starts(""), [])


if __name__ == "__main__":
    unittest.main()
