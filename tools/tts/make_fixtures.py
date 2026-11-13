"""Writes the committed fixtures that words.test.ts checks words.ts against.

  uv run --project tools/tts python tools/tts/make_fixtures.py

fixtures/selftest.timings.json  tts.py rendering of the selftest phrase (needs the model)
fixtures/selftest.sound.json    level of every 5 ms frame of that rendering, whole dBFS, so tests
                                can hold the word times against the sound without the WAV
fixtures/selftest.words.json    words.py numbering of the selftest phrase
fixtures/words-cases.json       words.py numbering of edge cases: abbreviations, quotes, dashes,
                                numbers, line breaks, Unicode spaces

Rerun after any change to words.py, words.ts, the selftest phrase or the pinned engine.
--words-only skips the render, so it runs with a plain python3 too.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from words import split_passage_words  # noqa: E402

FIXTURES = HERE / "fixtures"

CASES = [
    "Mr. Smith went to Washington. He arrived at 3.30 p.m. and left.",
    "The U.S. Army is big. e.g. this one. etc. and so on.",
    "Wait... Then it rained. Wait\N{HORIZONTAL ELLIPSIS} Then it rained.",
    '"Hello!" she said. "Hello!" She said.',
    "Is it? (Yes.) No! [Really.] Fine.",
    "Line one\nLine two.\r\nLine three.\n\nPara two.\rOld Mac line.",
    "end!Next one. end.Next one. end?next one.",
    "It costs 5 dollars. 5 apples were there. Version 2. 3 more.",
    "He said \N{LEFT DOUBLE QUOTATION MARK}Stop.\N{RIGHT DOUBLE QUOTATION MARK} Then left. "
    "He said \N{LEFT SINGLE QUOTATION MARK}Stop.\N{RIGHT SINGLE QUOTATION MARK} Then left.",
    "  Leading spaces. Trailing spaces.   ",
    "1. First item\n2. Second item\n- third item\n* fourth item",
    "A well-known, state-of-the-art tool \N{EM DASH} really \N{EM DASH} from the 1990s; "
    "it's 10% off at $5.20, isn't it?",
    "Numbers: 1,500 and 3.14 and 2026-11-12 at 7:30 p.m. \N{HORIZONTAL ELLIPSIS} and so on.",
    "Tabs\tand\N{NO-BREAK SPACE}non-breaking\N{EM SPACE}spaces\N{IDEOGRAPHIC SPACE}here.",
    "Emoji \N{GRINNING FACE} here. Caf\N{LATIN SMALL LETTER E WITH ACUTE} and cafe\N{COMBINING ACUTE ACCENT} both.",
    "Hi!, he said. Hi!: he said. Hi! - he said. Hi!\N{EM DASH}he said.",
    "Stop\N{LINE SEPARATOR}Go.\N{PARAGRAPH SEPARATOR}Next\x85line.",
    "R & D \N{EM DASH} and / or \N{EM DASH} 50 % ... !!",
    "It cost 10% more & less + 5 = done; he is 6'2\" tall. Try #1 at item#3, C++ and R&D.",
    "Wait!; he said. Stop!) and go. \"Done.\" then more. Go.) Then (more).",
    "",
    "   ",
    "\N{EM DASH} ... !!",
]


def words_of(text: str) -> list[list]:
    return [[w.text, w.sentence_index] for w in split_passage_words(text)]


def dump(path: Path, key: str, items: list) -> None:
    """ASCII JSON with one item per line."""
    rows = ",\n".join("    " + json.dumps(x, ensure_ascii=True, separators=(", ", ": ")) for x in items)
    path.write_text(f'{{\n  "source": "tools/tts/words.py",\n  "{key}": [\n{rows}\n  ]\n}}\n', encoding="utf-8")


def main(argv: list[str]) -> int:
    FIXTURES.mkdir(exist_ok=True)
    selftest = json.loads((HERE / "selftest.json").read_text(encoding="utf-8"))
    dump(FIXTURES / "selftest.words.json", "words", words_of(selftest["text"]))
    dump(FIXTURES / "words-cases.json", "cases", [{"text": t, "words": words_of(t)} for t in CASES])
    if "--words-only" in argv:
        return 0
    import numpy as np

    import tts

    with tts.stdout_to_stderr():
        narrator = tts.Narrator()
    with tempfile.TemporaryDirectory(prefix="copyholder-tts-") as tmp:
        wav = Path(tmp) / "selftest.wav"
        tts.render_files(narrator, selftest["text"], wav, FIXTURES / "selftest.timings.json")
        samples = np.frombuffer(wav.read_bytes()[tts.WAV_HEADER_BYTES:], dtype="<f4")
    levels = [round(v) for v in tts.frame_levels_db(samples)]
    rows = ",\n".join("    " + ", ".join(str(v) for v in levels[i:i + 40]) for i in range(0, len(levels), 40))
    (FIXTURES / "selftest.sound.json").write_text(
        '{\n  "source": "tools/tts/tts.py frame_levels_db of the selftest render",\n'
        f'  "frameMs": 5,\n  "levelsDb": [\n{rows}\n  ]\n}}\n', encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
