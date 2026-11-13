'use strict';
// What host tells the page after analysis/quickcheck.ts ran (spec 7.12; docs/protocol.md
// {t:'quickcheck', ok, text}). quickcheck prints its verdict as the last stdout line: GOOD RECORDING
// or RE-RECORD NOW: <reason>, and for doctor and smoke recordings DOCTOR OK / DOCTOR FAIL: ... or
// SMOKE OK / SMOKE FAIL: .... Its exit code says the same in every case: 0 pass, 2 fail, 1 crash.

const EXIT_PASS = 0;
const EXIT_FAIL = 2;
const MAX_TEXT = 1000;

/**
 * {ok, text}: ok from the exit code (true for 0, false for 2, null for a crash, a kill or no code),
 * text the last non-empty stdout line (null when there is none).
 */
function quickcheckVerdict(exitCode, stdoutText) {
  const lines = String(stdoutText ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const text = lines.length > 0 ? lines[lines.length - 1].slice(0, MAX_TEXT) : null;
  const ok = exitCode === EXIT_PASS ? true : exitCode === EXIT_FAIL ? false : null;
  return { ok, text };
}

module.exports = { EXIT_PASS, EXIT_FAIL, quickcheckVerdict };
