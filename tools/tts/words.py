"""Word and sentence numbering of a narrator passage, mirroring tools/tts/words.ts (spec 7.7, 8.2).

A word is a maximal run of non-whitespace characters that holds at least one letter or digit.
Sentences follow Unicode UAX #29 sentence boundaries, the rules behind
Intl.Segmenter('en', {granularity: 'sentence'}) that words.ts and the planter use (spec 7.8).
A word belongs to the sentence that holds its first character; sentence numbers count only
sentences that hold at least one word start.

Offsets here are code point offsets (Python str), not UTF-16 as in words.ts.
Standard library only, so it runs without the uv environment.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

# Unicode White_Space, the same set as WHITESPACE_CLASS in words.ts.
WHITESPACE_CLASS = "\\t\\n\\x0b\\x0c\\r \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"
_RUN = re.compile(f"[^{WHITESPACE_CLASS}]+")
_SPACE = re.compile(f"[{WHITESPACE_CLASS}]")


@dataclass(frozen=True)
class PassageWord:
    index: int
    sentence_index: int
    text: str
    char_start: int  # code point offset, inclusive
    char_end: int  # code point offset, exclusive


def is_space(ch: str) -> bool:
    return _SPACE.match(ch) is not None


def is_word_char(ch: str) -> bool:
    """A letter or a digit: \\p{L} or \\p{N}."""
    return unicodedata.category(ch)[0] in "LN"


def is_word_run(run: str) -> bool:
    """True when the run holds at least one letter or digit."""
    return any(is_word_char(c) for c in run)


def split_passage_words(text: str) -> list[PassageWord]:
    """Splits a passage into the words timings.json numbers, in order."""
    starts = sentence_starts(text)
    words: list[PassageWord] = []
    seg = -1
    numbered_seg = -1
    sentence = -1
    for m in _RUN.finditer(text):
        if not is_word_run(m.group()):
            continue
        start = m.start()
        while seg + 1 < len(starts) and starts[seg + 1] <= start:
            seg += 1
        if seg != numbered_seg:
            sentence += 1
            numbered_seg = seg
        words.append(PassageWord(len(words), sentence, m.group(), start, m.end()))
    return words


def count_passage_words(text: str) -> int:
    return sum(1 for m in _RUN.finditer(text) if is_word_run(m.group()))


# --- UAX #29 sentence boundaries ---------------------------------------------------------
# Sentence_Break classes. The character sets cover the Basic Multilingual Plane punctuation
# that matters for prose; the rules are SB3 to SB11 of UAX #29 as ICU applies them.
# words.test.ts checks the result against Node's Intl.Segmenter on committed cases.

OTHER, CR, LF, SEP, EXTEND, FORMAT, SP, LOWER, UPPER, OLETTER, NUMERIC, ATERM, STERM, CLOSE, SCONTINUE = range(15)
_PARASEP = (SEP, CR, LF)


def _chars(*codes: int) -> frozenset[str]:
    return frozenset(chr(c) for c in codes)


def _ranges(*pairs: tuple[int, int]) -> frozenset[str]:
    return frozenset(chr(c) for a, b in pairs for c in range(a, b + 1))


_ATERM = _chars(0x002E, 0x2024, 0xFE52, 0xFF0E)
_STERM = _chars(0x0021, 0x003F, 0x0589, 0x06D4, 0x07F9, 0x0837, 0x0839, 0x166E, 0x1803, 0x1809,
                0x2E2E, 0x2E3C, 0x3002, 0xA4FF, 0xA6F3, 0xA6F7, 0xA92F, 0xABEB, 0xFF01, 0xFF1F,
                0xFF61) | _ranges(
    (0x061D, 0x061F), (0x0700, 0x0702), (0x083D, 0x083E), (0x0964, 0x0965), (0x104A, 0x104B),
    (0x1362, 0x1362), (0x1367, 0x1368), (0x1735, 0x1736), (0x17D4, 0x17D5), (0x1944, 0x1945),
    (0x1AA8, 0x1AAB), (0x1B4E, 0x1B4F), (0x1B5A, 0x1B5B), (0x1B5E, 0x1B5F), (0x1B7D, 0x1B7F),
    (0x1C3B, 0x1C3C), (0x1C7E, 0x1C7F), (0x203C, 0x203D), (0x2047, 0x2049), (0x2CF9, 0x2CFB),
    (0x2E53, 0x2E54), (0xA60E, 0xA60F), (0xA876, 0xA877), (0xA8CE, 0xA8CF), (0xA9C8, 0xA9C9),
    (0xAA5D, 0xAA5F), (0xAAF0, 0xAAF1), (0xFE56, 0xFE57))
_SCONTINUE = _chars(0x002C, 0x002D, 0x003A, 0x003B, 0x037E, 0x055D, 0x07F8, 0x1802, 0x1808, 0x3001,
                    0xFE13, 0xFE14, 0xFE55, 0xFE58, 0xFE63, 0xFF1A, 0xFF1B, 0xFF64) | _ranges(
    (0x060C, 0x060D), (0x2013, 0x2014), (0xFE10, 0xFE11), (0xFE31, 0xFE32), (0xFE50, 0xFE51),
    (0xFE54, 0xFE54), (0xFF0C, 0xFF0D))
_SP = _chars(0x0009, 0x000B, 0x000C, 0x0020, 0x00A0, 0x1680, 0x202F, 0x205F, 0x3000) | _ranges((0x2000, 0x200A))
# Line_Break=Quotation characters outside Ps, Pe, Pi and Pf.
_SEP = _chars(0x0085, 0x2028, 0x2029)
_JOINERS = _chars(0x200C, 0x200D)
_GERESH = chr(0x05F3)
_QUOTE = _chars(0x0022, 0x0027) | _ranges((0x275B, 0x2760), (0x2E00, 0x2E0D), (0x1F676, 0x1F678))


def _sb_class(ch: str) -> int:
    if ch == "\r":
        return CR
    if ch == "\n":
        return LF
    if ch in _SEP:
        return SEP
    if ch in _ATERM:
        return ATERM
    if ch in _STERM:
        return STERM
    cat = unicodedata.category(ch)
    if cat in ("Mn", "Me", "Mc") or ch in _JOINERS:
        return EXTEND
    if cat == "Cf":
        return FORMAT
    if ch in _SP:
        return SP
    if ch in _SCONTINUE:
        return SCONTINUE
    if (cat in ("Ps", "Pe", "Pi", "Pf") or ch in _QUOTE) and ch != _GERESH:
        return CLOSE
    if ch.islower():
        return LOWER
    if ch.isupper() or cat == "Lt":
        return UPPER
    if ch.isalpha() or ch == _GERESH or cat == "Nl":
        return OLETTER
    if cat == "Nd":
        return NUMERIC
    return OTHER


def sentence_starts(text: str) -> list[int]:
    """Start offsets of the sentence segments, as Intl.Segmenter('en') sentence granularity gives them."""
    if not text:
        return []
    cls = [_sb_class(c) for c in text]
    return [0] + [i for i in range(1, len(text)) if _is_break(cls, i)]


def _prev_base(cls: list[int], j: int) -> int:
    """Index of the last character at or before j that is not Extend or Format (SB5), or -1."""
    while j >= 0 and cls[j] in (EXTEND, FORMAT):
        j -= 1
    return j


def _is_break(cls: list[int], i: int) -> bool:
    before, after = cls[i - 1], cls[i]
    if before == CR and after == LF:  # SB3
        return False
    if before in _PARASEP:  # SB4
        return True
    if after in (EXTEND, FORMAT):  # SB5
        return False
    p = _prev_base(cls, i - 1)
    if p < 0 or cls[p] in _PARASEP:
        return False  # Extend or Format right after a paragraph break: no rule applies (SB998)
    prev = cls[p]
    if prev == ATERM and after == NUMERIC:  # SB6
        return False
    if prev == ATERM and after == UPPER:  # SB7
        q = _prev_base(cls, p - 1)
        if q >= 0 and cls[q] in (UPPER, LOWER):
            return False
    # Match SATerm Close* Sp* right before the boundary.
    k = p
    saw_sp = False
    while k >= 0 and cls[k] == SP:
        saw_sp = True
        k = _prev_base(cls, k - 1)
    while k >= 0 and cls[k] == CLOSE:
        k = _prev_base(cls, k - 1)
    if k < 0 or cls[k] not in (ATERM, STERM):
        return False  # SB998
    if cls[k] == ATERM:  # SB8: a lowercase letter follows before any letter, break or terminator
        m = i
        while m < len(cls) and cls[m] not in (OLETTER, UPPER, LOWER, SEP, CR, LF, ATERM, STERM):
            m += 1
        if m < len(cls) and cls[m] == LOWER:
            return False
    if after in (SCONTINUE, ATERM, STERM):  # SB8a
        return False
    if not saw_sp and after in (CLOSE, SP, SEP, CR, LF):  # SB9
        return False
    if after in (SP, SEP, CR, LF):  # SB10
        return False
    return True  # SB11
