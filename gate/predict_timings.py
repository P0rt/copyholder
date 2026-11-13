"""Word timings of the gate passages from Kokoro's duration predictor, without audio (spec 7.7, 9.2).

tools/tts/tts.py takes every word time from Kokoro's duration model (pred_dur); the
vocoder only turns them into sound. This script runs tts.py's own render with the vocoder
replaced by silence of the same length, so its timings equal those of a full render of the same
text with the same lock, at a small part of the cost. Writes, per passage of a pack,
gate/pack-<X>/<passage>.predicted.json: the SHA-256 of the spoken text and the timings/1
document. check-texts.ts checks the cue rules on these timings. Output names no words and no
cue times (only word counts and clip lengths), so it is safe to run blind.

From the repository root (OMP_NUM_THREADS=2 keeps PyTorch light):
  uv run --locked --project tools/tts python gate/predict_timings.py            every pack
  uv run --locked --project tools/tts python gate/predict_timings.py A 0        some packs
  uv run --locked --project tools/tts python gate/predict_timings.py --text <in.txt> <out.json>
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import time
from pathlib import Path

GATE = Path(__file__).resolve().parent
sys.path.insert(0, str(GATE.parent / "tools" / "tts"))

import tts  # noqa: E402  (tools/tts/tts.py)

PACKS = ("0", "A", "B", "C")
PASSAGES = ("listen", "objections")
SCHEMA = "gate-predicted/1"
NOTE = ("Word timings from Kokoro's duration predictor: tools/tts/tts.py with the vocoder replaced by "
        "silence (gate/predict_timings.py). A render of the same text gives the same timings.")
# Same markup as check-texts.ts: [[wrong phrase|right phrase]] speaks the wrong phrase.
MARKUP = re.compile(r"\[\[([^\[\]|]*)\|([^\[\]|]*)\]\]")
NATIVE_SAMPLES_PER_FRAME = 2 * tts.HALF_FRAME_SAMPLES_NATIVE  # one predicted duration unit, 25 ms


def spoken_text(raw: str) -> str:
    return MARKUP.sub(lambda m: m.group(1).strip(), raw)


def silent_narrator() -> "tts.Narrator":
    """tts.Narrator whose decoder returns silence of the length the real decoder would give."""
    import torch

    class SilentDecoder(torch.nn.Module):
        def forward(self, asr, f0_curve, n, s):  # noqa: ARG002 - same signature as kokoro's Decoder
            return torch.zeros(1, 1, asr.shape[-1] * NATIVE_SAMPLES_PER_FRAME)

    narrator = tts.Narrator()
    narrator.model.decoder = SilentDecoder()
    return narrator


def predicted_json(text: str, doc: dict) -> str:
    """Wrapper head, then the timings document as tts.py formats it, indented one level."""
    body = tts.timings_json(doc).rstrip("\n").replace("\n", "\n  ")
    head = {"schema": SCHEMA, "note": NOTE, "spokenSha256": hashlib.sha256(text.encode("utf-8")).hexdigest()}
    lines = [f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}," for k, v in head.items()]
    return "{\n" + "\n".join(lines) + f'\n  "timings": {body}\n}}\n'


def predict(narrator: "tts.Narrator", text: str, out: Path) -> dict:
    rendering = narrator.render(text)
    doc = tts.timings_document(rendering, narrator.engine())
    tts.write_atomic(out, predicted_json(text, doc).encode("utf-8"))
    return doc


def main(argv: list[str]) -> int:
    jobs: list[tuple[str, Path, Path]] = []
    if argv[:1] == ["--text"]:
        if len(argv) != 3:
            print("usage: predict_timings.py --text <in.txt> <out.json>", file=sys.stderr)
            return 2
        jobs.append((argv[1], Path(argv[1]), Path(argv[2])))
    else:
        packs = argv or list(PACKS)
        bad = [p for p in packs if p not in PACKS]
        if bad:
            print(f"unknown pack {bad[0]}: use 0, A, B or C", file=sys.stderr)
            return 2
        for p in packs:
            for passage in PASSAGES:
                folder = GATE / f"pack-{p}"
                jobs.append((f"pack {p} {passage}", folder / f"{passage}.txt", folder / f"{passage}.predicted.json"))
    try:
        with tts.stdout_to_stderr():
            narrator = silent_narrator()
        for label, src, out in jobs:
            t0 = time.monotonic()
            with tts.stdout_to_stderr():
                doc = predict(narrator, spoken_text(tts.read_passage(src)), out)
            print(f"PREDICT OK {label}: {doc['wordCount']} words, {doc['durationMs'] / 1000:.1f} s "
                  f"({time.monotonic() - t0:.1f} s)", flush=True)
    except (tts.TtsError, OSError, UnicodeDecodeError) as e:
        print(f"PREDICT FAIL: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
