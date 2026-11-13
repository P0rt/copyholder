"""Copyholder narrator: English text to a mono 48 kHz float WAV plus word timings (spec 7.7, 8.2).

Engine: Kokoro-82M (kokoro 0.9.x), voice af_heart, speed 1.0, weights pinned to one revision.
Word numbering follows tools/tts/words.ts (mirrored in words.py); timings.json holds no text.

From the repository root:
  uv run --project tools/tts python tools/tts/tts.py <in.txt|-> <out.wav> <out.timings.json>
  uv run --project tools/tts python tools/tts/tts.py --selftest
or through npm: npm run tts -- <same arguments>. "-" reads the passage from stdin.

Messages name words by number only, never by text, because the planter renders sealed drafts
(spec 7.8, 8.2). --show-text adds the text to error messages for public passages.
"""

from __future__ import annotations

import argparse
import bisect
import contextlib
import json
import math
import os
import re
import struct
import sys
import tempfile
import time
import traceback
import unicodedata
import warnings
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path
from typing import Sequence

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from words import PassageWord, is_space, is_word_run, split_passage_words  # noqa: E402

MODEL_REPO = "hexgrad/Kokoro-82M"
MODEL_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"  # Hugging Face commit, 2025-04-10
CONFIG_FILE = "config.json"
MODEL_FILE = "kokoro-v1_0.pth"
VOICE = "af_heart"
VOICE_FILE = f"voices/{VOICE}.pt"
LANG_CODE = "a"  # American English
SPEED = 1.0
SEED = 0  # the vocoder draws noise; a fixed seed makes renders repeatable on one machine
MODEL_LICENCE = "Apache-2.0"

NATIVE_RATE_HZ = 24000  # Kokoro output rate (model card)
OUTPUT_RATE_HZ = 48000
UPSAMPLE = OUTPUT_RATE_HZ // NATIVE_RATE_HZ
HALF_FRAME_SAMPLES_NATIVE = 300  # kokoro durations count 25 ms frames; its timestamps count half-frames
MAX_PHONEMES = 510  # kokoro cuts a chunk beyond this

# Word times (spec 7.7: from kokoro itself). Kokoro's join_timestamps starts every token 3 frames
# before its place in the duration model; we use the duration model as it is. Its duration
# predictor gives most of a pause to the last phoneme before the punctuation, so next to
# punctuation and at chunk edges the word edge moves onto the pause in kokoro's predicted
# energy curve N (2 values per frame, computed before the vocoder). N below 0 is silence: the
# audio there stays under about -55 dBFS, while the release burst of a final stop ("talk,")
# keeps N above 0 (calibrated on the selftest phrase and a 92 s passage, README "Times").
KOKORO_LEAD_FRAMES = 3
PAUSE_ENERGY_BELOW = 0.0
MIN_PAUSE_HALF_FRAMES = 2  # 25 ms
TIME_RULE = "copyholder-times/1"  # the rule above; README "Times"

# Sound check of a full render: a 5 ms frame at or above -50 dBFS is sound. The slack is wide on
# purpose: soft endings ("breath,") reach 55 ms; the old error was 200 to 450 ms.
LOUD_DBFS = -50.0
SOUND_FRAME_SAMPLES = 240  # 5 ms at 48 kHz
SOUND_SLACK_MS = 100

SCHEMA = "timings/1"
WORD_RULE = "copyholder-words/1"  # tools/tts/words.ts
SELFTEST_FILE = HERE / "selftest.json"

# Same pattern misaki uses for its [text](phonemes) markup; such text would not reach the voice.
MISAKI_LINK = re.compile(r"\[([^\]]+)\]\(([^\)]*)\)")
# Paragraph separators of UAX #29 (CR, LF, NEL, LS, PS): each line becomes one kokoro segment.
LINE = re.compile("[^" + re.escape("\r\n" + chr(0x85) + chr(0x2028) + chr(0x2029)) + "]+")
LINE_BREAK = re.compile("\r\n|[" + re.escape("\r\n" + chr(0x85) + chr(0x2028) + chr(0x2029)) + "]")


class TtsError(Exception):
    """A failure whose message is safe to print: word and line numbers, no passage text."""


@dataclass(frozen=True)
class Segment:
    """One line of the passage as kokoro receives it: whitespace runs folded to one space."""

    line: int  # 1-based line number in the passage file
    text: str
    source: tuple[int, ...]  # source[k] = offset in the passage of text[k]


@dataclass(frozen=True)
class TokenTime:
    """A token's place in its chunk, in half-frames (12.5 ms) from the chunk start."""

    start: int  # kokoro's join_timestamps arithmetic without its lead: each space split in half
    end: int
    first_end: int  # end of the token's first phoneme
    last_start: int  # start of its last phoneme


@dataclass(frozen=True)
class WordTiming:
    index: int
    start_ms: int
    end_ms: int
    sentence_index: int


@dataclass
class Rendering:
    audio: "object"  # numpy float32 array at OUTPUT_RATE_HZ
    words: list[WordTiming]
    sentence_count: int
    corrected_chunks: int
    chunks: int
    duration_spans: list[tuple[int, int]]  # 48 kHz samples of each word from the durations alone
    pauses: int  # word edges moved onto a pause


# --- text to kokoro segments and back ------------------------------------------------------


def line_starts(text: str) -> list[int]:
    """Offsets where each line starts; CRLF is one break, as are lone CR, LF, NEL, LS and PS."""
    return [0] + [m.end() for m in LINE_BREAK.finditer(text)]


def passage_segments(text: str) -> list[Segment]:
    """Lines that hold at least one word, with single spaces and a map back to passage offsets."""
    segments: list[Segment] = []
    starts = line_starts(text)
    for m in LINE.finditer(text):
        line_no = bisect.bisect_right(starts, m.start())
        chars: list[str] = []
        source: list[int] = []
        gap = -1
        for k, ch in enumerate(m.group(), start=m.start()):
            if is_space(ch):
                if chars and gap < 0:
                    gap = k
                continue
            if gap >= 0:
                chars.append(" ")
                source.append(gap)
                gap = -1
            chars.append(ch)
            source.append(k)
        folded = "".join(chars)
        if not is_word_run(folded):
            continue
        if MISAKI_LINK.search(folded):
            raise TtsError(f"line {line_no} holds [text](target) markup, which the voice would not read; remove it")
        segments.append(Segment(line_no, folded, tuple(source)))
    return segments


def _match_token(text: str, cursor: int, token: str) -> tuple[int, int] | None:
    """Finds token at or after cursor; misaki may drop stray punctuation, never letters or digits."""
    i = cursor
    while i < len(text) and text[i] == " ":
        i += 1
    if text.startswith(token, i):
        return i, i + len(token)
    start, j = -1, i
    for ch in token:
        while j < len(text) and text[j] != ch and text[j] != " " and not is_word_run(text[j]):
            j += 1
        if j >= len(text) or text[j] != ch:
            return None
        if start < 0:
            start = j
        j += 1
    return (start, j) if start >= 0 else (i, i)


def align_tokens(segment: Segment, tokens: list, cursor: int) -> tuple[list[tuple[int, int]], int]:
    """Passage offsets [start, end) of each kokoro token, matched in order from cursor."""
    spans: list[tuple[int, int]] = []
    for n, tok in enumerate(tokens):
        hit = _match_token(segment.text, cursor, tok.text)
        if hit is None:
            raise TtsError(f"line {segment.line}: kokoro token {n} does not match the text")
        a, b = hit
        cursor = b
        start = segment.source[min(a, len(segment.source) - 1)]
        spans.append((start, segment.source[b - 1] + 1) if b > a else (start, start))
    return spans, cursor


# --- token and word times ---------------------------------------------------------------------


def token_half_frames(tokens: list, ps: str, pred_dur: list[int], vocab: dict) -> tuple[list[TokenTime | None], bool]:
    """Place of each token in half-frames from the chunk start, or None for a token without sound.

    Same arithmetic as KPipeline.join_timestamps in kokoro 0.9.4, without its 3-frame lead: the
    first token starts at the end of <bos>, each space is split half and half between its
    neighbours. Its index bookkeeping is fixed for two cases it gets wrong: phoneme characters the
    model vocabulary drops, and tokens without phonemes that carry a space. The second value tells
    whether the chunk holds such a case, where kokoro's own start_ts and end_ts are off.
    """
    full: list[str] = []
    parts: list[tuple[int, int, int | None]] = []
    for t in tokens:
        a = len(full)
        full.extend(t.phonemes or "")
        b = len(full)
        sp = None
        if t.whitespace:
            sp = len(full)
            full.append(" ")
        parts.append((a, b, sp))
    joined = "".join(full)
    stripped = joined.strip()
    if len(stripped) > MAX_PHONEMES:
        raise TtsError(f"a chunk has {len(stripped)} phonemes, more than kokoro's {MAX_PHONEMES}; it would be cut")
    if stripped != ps:
        raise TtsError("kokoro's phoneme string does not match its tokens")
    lead = len(joined) - len(joined.lstrip())
    end = lead + len(ps)
    index: list[int | None] = [None] * len(joined)
    k = 1  # pred_dur[0] is <bos>
    for p in range(lead, end):
        if joined[p] in vocab:
            index[p] = k
            k += 1
    if k + 1 != len(pred_dur):
        raise TtsError("kokoro's durations do not match its phonemes")

    def dur(p: int | None) -> int:
        return pred_dur[index[p]] if p is not None and index[p] is not None else 0

    anomalous = any(c not in vocab for c in ps) or any(t.whitespace and not t.phonemes for t in tokens)
    last_voiced = max((i for i, t in enumerate(tokens) if t.phonemes), default=-1)
    left = right = 2 * pred_dur[0]
    times: list[TokenTime | None] = []
    for i, (t, (a, b, sp)) in enumerate(zip(tokens, parts)):
        if sp is not None and lead <= sp < end:
            space = dur(sp)
        elif sp is not None and i == last_voiced:
            space = pred_dur[-1]  # trailing space stripped: kokoro counts <eos> in its place
        else:
            space = 0
        if not t.phonemes:
            if t.whitespace:  # kokoro moves the clock only for a space; "$" in "$5" leaves it
                left = right + space
                right = left + space
            times.append(None)
            continue
        start = left
        token_hf = 2 * sum(dur(p) for p in range(a, b))
        timed = [p for p in range(a, b) if index[p] is not None]
        first_end = right + (2 * dur(timed[0]) if timed else 0)
        last_start = right + token_hf - (2 * dur(timed[-1]) if timed else 0)
        left = right + token_hf + space
        right = left + space
        times.append(TokenTime(start, left, first_end, last_start))
    return times, anomalous


def kokoro_lead_half_frames(pred_dur: list[int]) -> int:
    """How far join_timestamps moves every time ahead of the duration model: 3 frames, at most <bos>."""
    return 2 * min(KOKORO_LEAD_FRAMES, pred_dur[0])


def check_against_kokoro(tokens: list, times: list[TokenTime | None], anomalous: bool, lead: int) -> None:
    """Our times, moved by kokoro's lead, must equal kokoro's own start_ts and end_ts wherever its
    bookkeeping holds."""
    if anomalous:
        return
    for t, tt in zip(tokens, times):
        theirs = None if t.start_ts is None else (t.start_ts, t.end_ts)
        ours = None if tt is None else ((tt.start - lead) / 80, (tt.end - lead) / 80)
        if theirs != ours:
            raise TtsError("word timing code disagrees with kokoro's join_timestamps; check the kokoro version")


def word_at(words: list[PassageWord], starts: list[int], span: tuple[int, int]) -> int | None:
    """Number of the word whose characters hold the whole span, or None."""
    k = bisect.bisect_right(starts, span[0]) - 1
    if k < 0 or not (words[k].char_start <= span[0] and span[1] <= words[k].char_end):
        return None
    return k


def word_index_at(words: list[PassageWord], starts: list[int], span: tuple[int, int]) -> int:
    k = word_at(words, starts, span)
    if k is None:
        raise TtsError(f"a kokoro token near offset {span[0]} lies outside every word")
    return k


def is_spoken(phonemes: str | None) -> bool:
    """True when the phonemes hold a speech sound; punctuation phonemes (",", ".", "—") are pauses."""
    return any(unicodedata.category(c)[0] == "L" for c in phonemes or "")


def where_between_words(words: list[PassageWord], starts: list[int], offset: int) -> str:
    """'after word k (sentence s)' or 'before word 0', for a passage offset outside every word."""
    k = bisect.bisect_right(starts, offset) - 1
    if k < 0:
        return "before word 0"
    return f"after word {k} (sentence {words[k].sentence_index})"


def chunk_word_spans(words: list[PassageWord], starts: list[int], segment: Segment, tokens: list,
                     spans: list[tuple[int, int]], times: list[TokenTime | None],
                     show_text: bool = False) -> dict[int, TokenTime]:
    """Place of each word of one chunk: the span of all its tokens, in half-frames, by word number.

    A token with a letter or digit belongs to a word and must be voiced. A symbol read aloud
    inside a word ("%" of "10%" if misaki splits it off) widens that word. A symbol read aloud
    between words ("&" alone) would be speech without a word number, so the render stops: such
    symbols must be spelled out (spec 7.8 step 1). Punctuation tokens are pauses, not words.
    """
    out: dict[int, TokenTime] = {}
    for tok, span, tt in zip(tokens, spans, times):
        if is_word_run(tok.text):
            w = word_index_at(words, starts, span)
            if tt is None:
                raise TtsError(f"word {w} (sentence {words[w].sentence_index}) has a part kokoro does not voice"
                               + (f": {tok.text!r}" if show_text else ""))
        elif tt is not None and is_spoken(tok.phonemes):
            found = word_at(words, starts, span)
            if found is None:
                raise TtsError(f"line {segment.line}: a symbol {where_between_words(words, starts, span[0])} is read aloud "
                               "but is no word; spell it out or remove it" + (f": {tok.text!r}" if show_text else ""))
            w = found
        else:
            continue
        cur = out.get(w)
        if cur is None:
            out[w] = tt
        else:  # tokens of one word come in order
            out[w] = TokenTime(min(cur.start, tt.start), max(cur.end, tt.end),
                               cur.first_end if cur.start <= tt.start else tt.first_end,
                               tt.last_start if tt.end >= cur.end else cur.last_start)
    return dict(sorted(out.items()))


def quiet_runs(quiet: Sequence[bool]) -> list[tuple[int, int]]:
    """Maximal runs [start, end) of True."""
    runs: list[tuple[int, int]] = []
    start = -1
    for h, q in enumerate(quiet):
        if q and start < 0:
            start = h
        elif not q and start >= 0:
            runs.append((start, h))
            start = -1
    if start >= 0:
        runs.append((start, len(quiet)))
    return runs


def longest_pause(runs: list[tuple[int, int]], window: tuple[int, int], bounds: tuple[int, int],
                  min_pause: int = MIN_PAUSE_HALF_FRAMES) -> tuple[int, int] | None:
    """The longest quiet run that meets the window, cut to bounds; None when shorter than min_pause."""
    best: tuple[int, int] | None = None
    for a, b in runs:
        if b <= window[0] or a >= window[1]:
            continue
        a, b = max(a, bounds[0]), min(b, bounds[1])
        if b - a >= min_pause and (best is None or b - a > best[1] - best[0]):
            best = (a, b)
    return best


def place_words_on_pauses(spans: list[TokenTime], quiet: Sequence[bool],
                          min_pause: int = MIN_PAUSE_HALF_FRAMES) -> tuple[list[tuple[int, int]], int]:
    """Start and end of each word of one chunk in half-frames, and the number of edges moved.

    Words with only a space between them touch where the duration model puts the boundary.
    Where punctuation lies between two words, the pause is the longest quiet run from the last
    phoneme of the first word to the first phoneme of the next; the first word ends where it
    starts and the next word starts where it ends. Without such a run the two words meet in the
    middle of the punctuation. The first word of the chunk starts after the pause that begins
    the chunk, the last word ends where the pause at its end begins. Every word keeps at least
    one half-frame.
    """
    runs = quiet_runs(quiet)
    out = [[s.start, s.end] for s in spans]
    moved = 0
    if not spans:
        return [], 0
    first = spans[0]
    pause = longest_pause(runs, (0, first.first_end), (0, first.end - 1), min_pause)
    if pause is not None:
        out[0][0] = pause[1]
        moved += 1
    for i in range(len(spans) - 1):
        left, right = spans[i], spans[i + 1]
        if left.end >= right.start:
            continue
        pause = longest_pause(runs, (left.last_start, right.first_end), (out[i][0] + 1, right.end - 1), min_pause)
        if pause is None:
            out[i][1] = out[i + 1][0] = (left.end + right.start) // 2
        else:
            out[i][1], out[i + 1][0] = pause
            moved += 2
    last = spans[-1]
    pause = longest_pause(runs, (last.last_start, len(quiet)), (out[-1][0] + 1, len(quiet)), min_pause)
    if pause is not None:
        out[-1][1] = pause[0]
        moved += 1
    return [(a, b) for a, b in out], moved


def half_frames_to_samples(offset_native: int, hf: int) -> int:
    """48 kHz sample of a half-frame boundary in a chunk that starts at native sample offset_native."""
    return UPSAMPLE * (offset_native + hf * HALF_FRAME_SAMPLES_NATIVE)


def widen(out: list[list[int] | None], w: int, a: int, b: int) -> None:
    cur = out[w]
    out[w] = [a, b] if cur is None else [min(cur[0], a), max(cur[1], b)]


# --- rendering --------------------------------------------------------------------------------


def quiet_libraries() -> None:
    warnings.filterwarnings("ignore", category=UserWarning, module=r"torch\.")
    warnings.filterwarnings("ignore", category=FutureWarning, module=r"torch\.")
    warnings.filterwarnings("ignore", category=FutureWarning, module=r"(kokoro|misaki|spacy|transformers)")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    try:
        from huggingface_hub.utils import logging as hf_logging

        hf_logging.set_verbosity_error()
    except Exception:  # noqa: BLE001 - only quiets a warning
        pass


def model_files() -> dict[str, str]:
    """Local paths of the pinned weights, downloaded once into the Hugging Face cache."""
    from huggingface_hub import hf_hub_download, try_to_load_from_cache

    paths = {}
    for key, name in (("config", CONFIG_FILE), ("model", MODEL_FILE), ("voice", VOICE_FILE)):
        cached = try_to_load_from_cache(MODEL_REPO, name, revision=MODEL_REVISION)
        paths[key] = cached if isinstance(cached, str) else hf_hub_download(MODEL_REPO, name, revision=MODEL_REVISION)
    return paths


def version_of(dist: str) -> str:
    try:
        return metadata.version(dist)
    except metadata.PackageNotFoundError:
        return "unknown"


class Narrator:
    def __init__(self) -> None:
        quiet_libraries()
        import torch
        from kokoro import KModel, KPipeline

        files = model_files()
        self.torch = torch
        self.model = KModel(repo_id=MODEL_REPO, config=files["config"], model=files["model"]).to("cpu").eval()
        self.pipeline = KPipeline(lang_code=LANG_CODE, repo_id=MODEL_REPO, model=self.model)
        self.voice = files["voice"]
        # Keep kokoro's predicted energy N of each chunk: it is computed before the vocoder.
        self._energy: list = []
        predictor = self.model.predictor
        f0n = predictor.F0Ntrain

        def f0n_kept(x, s):
            f0, n = f0n(x, s)
            self._energy.append(n.detach().cpu().reshape(-1).numpy())
            return f0, n

        predictor.F0Ntrain = f0n_kept

    def engine(self) -> dict:
        import soxr

        return {
            "name": "kokoro",
            "kokoroVersion": version_of("kokoro"),
            "misakiVersion": version_of("misaki"),
            "torchVersion": version_of("torch"),
            "modelRepo": MODEL_REPO,
            "modelRevision": MODEL_REVISION,
            "modelFile": MODEL_FILE,
            "modelLicence": MODEL_LICENCE,
            "voice": VOICE,
            "speed": SPEED,
            "langCode": LANG_CODE,
            "seed": SEED,
            "nativeRateHz": NATIVE_RATE_HZ,
            "resampler": f"soxr {soxr.__version__} VHQ",
            "timeRule": TIME_RULE,
        }

    def render(self, text: str, show_text: bool = False) -> Rendering:
        import numpy as np
        import soxr

        words = split_passage_words(text)
        if not words:
            raise TtsError("the passage has no words")
        starts = [w.char_start for w in words]
        segments = passage_segments(text)
        placed: list[list[int] | None] = [None] * len(words)
        durations: list[list[int] | None] = [None] * len(words)
        pieces = []
        offset = 0  # native samples before the current chunk
        cursors: dict[int, int] = {}
        corrected = chunks = pauses = 0
        self.torch.manual_seed(SEED)
        self._energy.clear()
        results = self.pipeline([s.text for s in segments], voice=self.voice, speed=SPEED, split_pattern=None)
        for r in results:
            seg = segments[r.text_index]
            audio = r.audio.detach().cpu().numpy().astype(np.float32)
            pred_dur = [int(d) for d in r.pred_dur.reshape(-1).tolist()]
            if len(audio) != sum(pred_dur) * 2 * HALF_FRAME_SAMPLES_NATIVE:
                raise TtsError("kokoro's audio length does not match its durations")
            if len(self._energy) != 1 or len(self._energy[0]) != 2 * sum(pred_dur):
                raise TtsError("kokoro's energy curve does not match its durations; check the kokoro version")
            quiet = (self._energy.pop() < PAUSE_ENERGY_BELOW).tolist()
            times, anomalous = token_half_frames(r.tokens, r.phonemes, pred_dur, self.model.vocab)
            check_against_kokoro(r.tokens, times, anomalous, kokoro_lead_half_frames(pred_dur))
            spans, cursors[r.text_index] = align_tokens(seg, r.tokens, cursors.get(r.text_index, 0))
            chunk_words = chunk_word_spans(words, starts, seg, r.tokens, spans, times, show_text)
            edges, moved = place_words_on_pauses(list(chunk_words.values()), quiet)
            for (w, tt), (a, b) in zip(chunk_words.items(), edges):
                widen(placed, w, half_frames_to_samples(offset, a), half_frames_to_samples(offset, b))
                widen(durations, w, half_frames_to_samples(offset, tt.start), half_frames_to_samples(offset, tt.end))
            pauses += moved
            corrected += int(anomalous)
            chunks += 1
            pieces.append(audio)
            offset += len(audio)
        missing = [w for w in words if placed[w.index] is None]
        if missing:
            first = missing[0]
            raise TtsError(f"{len(missing)} words got no sound from kokoro, first: word {first.index} (sentence {first.sentence_index})"
                           + (f": {first.text!r}" if show_text else ""))
        native = np.concatenate(pieces)
        audio48 = soxr.resample(native, NATIVE_RATE_HZ, OUTPUT_RATE_HZ, quality="VHQ").astype(np.float32)
        if len(audio48) != UPSAMPLE * len(native):
            raise TtsError(f"resampler returned {len(audio48)} samples, expected {UPSAMPLE * len(native)}")
        timings = [
            WordTiming(w.index, samples_to_ms(placed[w.index][0]), samples_to_ms(placed[w.index][1]), w.sentence_index)
            for w in words
        ]
        rendering = Rendering(audio48, timings, words[-1].sentence_index + 1, corrected, chunks,
                              [(d[0], d[1]) for d in durations], pauses)
        problems = check_timings(timings, samples_to_ms(len(audio48)))
        if problems:
            raise TtsError("implausible timings: " + "; ".join(problems[:3]))
        return rendering


def samples_to_ms(samples: int) -> int:
    """Rounds half up, in integers, so every program gets the same number (spec 8.3)."""
    return (samples * 1000 + OUTPUT_RATE_HZ // 2) // OUTPUT_RATE_HZ


def check_timings(words: list[WordTiming], duration_ms: int) -> list[str]:
    """Order checks shared by every render and the selftest."""
    problems = []
    prev_end = 0
    for k, w in enumerate(words):
        if w.index != k:
            problems.append(f"word {k} has index {w.index}")
        if not w.start_ms < w.end_ms:
            problems.append(f"word {k} starts at {w.start_ms} ms, not before its end {w.end_ms} ms")
        if w.start_ms < prev_end:
            problems.append(f"word {k} starts at {w.start_ms} ms, before word {k - 1} ends at {prev_end} ms")
        if k and w.sentence_index not in (words[k - 1].sentence_index, words[k - 1].sentence_index + 1):
            problems.append(f"word {k} jumps to sentence {w.sentence_index}")
        prev_end = max(prev_end, w.end_ms)
    if words and words[0].sentence_index != 0:
        problems.append("the first word is not in sentence 0")
    if words and words[-1].end_ms > duration_ms:
        problems.append(f"the last word ends at {words[-1].end_ms} ms, after the audio ({duration_ms} ms)")
    return problems


# --- sound check ------------------------------------------------------------------------------


def frame_levels_db(samples) -> list[float]:
    """Level of each whole 5 ms frame of 48 kHz audio in dBFS (RMS), floored at -120."""
    import numpy as np

    x = np.asarray(samples, dtype=np.float64)
    n = len(x) // SOUND_FRAME_SAMPLES
    rms = np.sqrt(np.mean(x[: n * SOUND_FRAME_SAMPLES].reshape(n, SOUND_FRAME_SAMPLES) ** 2, axis=1))
    return [max(-120.0, 20 * math.log10(v)) if v > 0 else -120.0 for v in rms.tolist()]


def sound_problems(levels_db: Sequence[float], words: list[WordTiming], frame_ms: int = 5,
                   loud_dbfs: float = LOUD_DBFS, slack_ms: int = SOUND_SLACK_MS) -> list[str]:
    """Word times against the sound of a full render (spec 6.4, 7.7). A frame at or above
    loud_dbfs is sound. No sound may lie farther than slack_ms from every word. A word next to a
    pause may hold at most slack_ms of silence after its last sound (pause after it) or before
    its first sound (pause before it). Words without sound frames are not judged here."""
    loud = [k for k, v in enumerate(levels_db) if v >= loud_dbfs]
    problems: list[str] = []
    if not words:
        return problems
    starts = [w.start_ms for w in words]
    for k in loud:
        a, b = k * frame_ms, (k + 1) * frame_ms
        i = bisect.bisect_right(starts, a) - 1  # the last word that starts at or before the frame
        if not any(w.start_ms - slack_ms < b and a < w.end_ms + slack_ms for w in words[max(0, i): i + 2]):
            problems.append(f"sound at {a} ms lies outside every word")
            break
    for k, w in enumerate(words):
        pause_before = k == 0 or words[k - 1].end_ms < w.start_ms
        pause_after = k + 1 == len(words) or words[k + 1].start_ms > w.end_ms
        if pause_after:
            # frames that start inside the word
            j = bisect.bisect_left(loud, -(-w.end_ms // frame_ms)) - 1
            if j >= 0 and loud[j] * frame_ms >= w.start_ms and w.end_ms - (loud[j] + 1) * frame_ms > slack_ms:
                problems.append(f"word {k} ends at {w.end_ms} ms, {w.end_ms - (loud[j] + 1) * frame_ms} ms after its sound")
        if pause_before:
            # frames that end inside the word
            j = bisect.bisect_left(loud, w.start_ms // frame_ms)
            if j < len(loud) and (loud[j] + 1) * frame_ms <= w.end_ms and loud[j] * frame_ms - w.start_ms > slack_ms:
                problems.append(f"word {k} starts at {w.start_ms} ms, {loud[j] * frame_ms - w.start_ms} ms before its sound")
    return problems


# --- output files -----------------------------------------------------------------------------

WAV_HEADER_BYTES = 56


def wav_bytes(samples) -> bytes:
    """Mono IEEE float32 WAV: RIFF, fmt (16 bytes, format 3), fact, data. No PEAK chunk, so the
    bytes depend on the samples only (libsndfile would stamp the time of writing)."""
    import numpy as np

    data = np.asarray(samples, dtype="<f4").tobytes()
    frames = len(data) // 4
    fmt = struct.pack("<HHIIHH", 3, 1, OUTPUT_RATE_HZ, OUTPUT_RATE_HZ * 4, 4, 32)
    body = (b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"fact" + struct.pack("<II", 4, frames)
            + b"data" + struct.pack("<I", len(data)) + data)
    return b"RIFF" + struct.pack("<I", len(body)) + body


def timings_document(rendering: Rendering, engine: dict) -> dict:
    samples = len(rendering.audio)
    return {
        "schema": SCHEMA,
        "wordRule": WORD_RULE,
        "sampleRateHz": OUTPUT_RATE_HZ,
        "durationSamples": samples,
        "durationMs": samples_to_ms(samples),
        "wordCount": len(rendering.words),
        "sentenceCount": rendering.sentence_count,
        "engine": engine,
        "correctedChunks": rendering.corrected_chunks,
        "words": [
            {"index": w.index, "startMs": w.start_ms, "endMs": w.end_ms, "sentenceIndex": w.sentence_index}
            for w in rendering.words
        ],
    }


def timings_json(doc: dict) -> str:
    """Two-space JSON with one word per line, so diffs of committed timings stay readable."""
    head = json.dumps({k: v for k, v in doc.items() if k != "words"}, indent=2, ensure_ascii=False)
    rows = ",\n".join("    " + json.dumps(w, separators=(", ", ": ")) for w in doc["words"])
    return head[: -len("\n}")] + ',\n  "words": [\n' + rows + "\n  ]\n}\n"


def write_atomic(path: Path, data: bytes) -> None:
    """Writes through a temporary file in the same folder. Mode 0600 (mkstemp): a planted draft's
    audio and timings are readable by their owner only until the planter seals them (spec 8.2)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def read_passage(path: Path) -> str:
    """UTF-8 passage from a file, or from stdin when the path is "-" (no plaintext draft on disk)."""
    data = sys.stdin.buffer.read() if str(path) == "-" else path.read_bytes()
    text = data.decode("utf-8")
    return text[1:] if text.startswith(chr(0xFEFF)) else text  # words.ts never sees a byte order mark


def render_files(narrator: Narrator, text: str, wav: Path, timings: Path, show_text: bool = False) -> dict:
    rendering = narrator.render(text, show_text=show_text)
    problems = sound_problems(frame_levels_db(rendering.audio), rendering.words)
    if problems:
        raise TtsError("word times do not match the sound: " + "; ".join(problems[:3]))
    doc = timings_document(rendering, narrator.engine())
    write_atomic(wav, wav_bytes(rendering.audio))
    write_atomic(timings, timings_json(doc).encode("utf-8"))
    return doc


# --- selftest ---------------------------------------------------------------------------------


def parse_wav_header(data: bytes) -> dict:
    """Minimal RIFF reader: format tag, channels, rate, bits and frames of a WAV file."""
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise TtsError("not a RIFF/WAVE file")
    pos, info, data_bytes = 12, {}, None
    while pos + 8 <= len(data):
        cid, size = data[pos:pos + 4], struct.unpack("<I", data[pos + 4:pos + 8])[0]
        if cid == b"fmt ":
            info["format"], info["channels"], info["rate"], _, info["block"], info["bits"] = struct.unpack(
                "<HHIIHH", data[pos + 8:pos + 24])
        elif cid == b"data":
            data_bytes = size
        pos += 8 + size + (size & 1)
    if "format" not in info or data_bytes is None or not info["block"]:
        raise TtsError("WAV file without fmt or data chunk")
    info["frames"] = data_bytes // info["block"]
    return info


def selftest() -> tuple[bool, str]:
    import numpy as np
    import soundfile as sf

    spec = json.loads(SELFTEST_FILE.read_text(encoding="utf-8"))
    text, expected_words = spec["text"], spec["wordCount"]
    words = split_passage_words(text)
    if len(words) != expected_words:
        return False, f"tokenizer gives {len(words)} words, selftest.json expects {expected_words}"
    narrator = Narrator()
    with tempfile.TemporaryDirectory(prefix="copyholder-tts-") as tmp:
        wav, tim = Path(tmp) / "selftest.wav", Path(tmp) / "selftest.timings.json"
        render_files(narrator, text, wav, tim)
        raw = wav.read_bytes()
        head = parse_wav_header(raw)
        info = sf.info(str(wav))
        audio, rate = sf.read(str(wav), dtype="float32")
        doc = json.loads(tim.read_text(encoding="utf-8"))
    if (head["format"], head["channels"], head["rate"], head["bits"]) != (3, 1, OUTPUT_RATE_HZ, 32):
        return False, f"WAV header is format {head['format']}, {head['channels']} ch, {head['rate']} Hz, {head['bits']} bit"
    if (info.format, info.subtype, info.channels, info.samplerate) != ("WAV", "FLOAT", 1, OUTPUT_RATE_HZ):
        return False, f"libsndfile reads {info.format}/{info.subtype}, {info.channels} ch, {info.samplerate} Hz"
    if audio.ndim != 1 or rate != OUTPUT_RATE_HZ or len(audio) != head["frames"]:
        return False, "decoded audio does not match the header"
    duration_ms = samples_to_ms(len(audio))
    if doc["durationMs"] != duration_ms or doc["durationSamples"] != len(audio) or doc["sampleRateHz"] != OUTPUT_RATE_HZ:
        return False, f"timings.json says {doc['durationMs']} ms, the WAV holds {duration_ms} ms"
    if doc["wordCount"] != expected_words or len(doc["words"]) != expected_words:
        return False, f"timings.json has {len(doc['words'])} words, expected {expected_words}"
    if doc["sentenceCount"] != spec["sentenceCount"]:
        return False, f"timings.json has {doc['sentenceCount']} sentences, expected {spec['sentenceCount']}"
    timing = [WordTiming(w["index"], w["startMs"], w["endMs"], w["sentenceIndex"]) for w in doc["words"]]
    if [w.sentence_index for w in timing] != [w.sentence_index for w in words]:
        return False, "sentence numbers differ from the tokenizer"
    problems = check_timings(timing, duration_ms) + sound_problems(frame_levels_db(audio), timing)
    if problems:
        return False, problems[0]
    if not spec["minDurationMs"] <= duration_ms <= spec["maxDurationMs"]:
        return False, f"duration {duration_ms} ms is outside {spec['minDurationMs']}..{spec['maxDurationMs']} ms"
    peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
    if not 0.05 <= peak <= 1.0:
        return False, f"peak level {peak:.3f} is outside 0.05..1.0"
    return True, f"{expected_words} {duration_ms}"


def one_line(detail: object) -> str:
    """Folds every run of whitespace, line breaks included, into one space."""
    return " ".join(str(detail).split())


# --- command line -----------------------------------------------------------------------------


@contextlib.contextmanager
def stdout_to_stderr():
    """Sends stdout to stderr, from Python and from C libraries alike, so the result line is the
    only thing on stdout."""
    sys.stdout.flush()
    saved = os.dup(1)
    try:
        os.dup2(2, 1)
        with contextlib.redirect_stdout(sys.stderr):
            yield
    finally:
        sys.stdout.flush()
        os.dup2(saved, 1)
        os.close(saved)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="tts.py", description="Render a passage with Kokoro: 48 kHz WAV plus word timings.")
    parser.add_argument("input", nargs="?", type=Path, help='UTF-8 text file, one paragraph per line; "-" reads stdin')
    parser.add_argument("wav", nargs="?", type=Path, help="output WAV: mono, 48 kHz, 32-bit float")
    parser.add_argument("timings", nargs="?", type=Path, help="output timings.json")
    parser.add_argument("--selftest", action="store_true", help="render a fixed 10 s phrase and check it")
    parser.add_argument("--show-text", action="store_true", help="put word text in error messages (public texts only)")
    args = parser.parse_args(argv)

    if args.selftest:
        if args.input or args.wav or args.timings:
            parser.error("--selftest takes no file arguments")
        try:
            with stdout_to_stderr():
                ok, detail = selftest()
        except Exception as e:  # noqa: BLE001 - one line on stdout whatever went wrong
            ok, detail = False, f"{type(e).__name__}: {e}"
        print(f"TTS SELFTEST OK {one_line(detail)}" if ok else f"TTS SELFTEST FAIL: {one_line(detail)}", flush=True)
        return 0 if ok else 1

    if not (args.input and args.wav and args.timings):
        parser.error("give <in.txt> <out.wav> <out.timings.json>, or --selftest")
    try:
        text = read_passage(args.input)
        t0 = time.monotonic()
        with stdout_to_stderr():
            narrator = Narrator()
            t1 = time.monotonic()
            doc = render_files(narrator, text, args.wav, args.timings, show_text=args.show_text)
        t2 = time.monotonic()
    except (TtsError, OSError, UnicodeDecodeError) as e:
        print(f"TTS FAIL: {one_line(e)}", file=sys.stderr)
        return 1
    except Exception as e:  # noqa: BLE001 - library messages may quote the passage
        if args.show_text:
            traceback.print_exc()
        tb = traceback.extract_tb(e.__traceback__)[-1]
        print(f"TTS FAIL: {type(e).__name__} at {Path(tb.filename).name}:{tb.lineno}"
              + ("" if args.show_text else " (details hidden; --show-text prints them, public texts only)"), file=sys.stderr)
        return 1
    seconds = doc["durationMs"] / 1000
    print(f"TTS OK {doc['wordCount']} words {doc['sentenceCount']} sentences {doc['durationMs']} ms "
          f"(load {t1 - t0:.1f} s, render {t2 - t1:.1f} s = {(t2 - t1) / seconds:.2f} x real time)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
