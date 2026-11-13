'use strict';
// Timing contract between host and tap (spec 7.1, 7.2; docs/protocol.md), in one place so that
// host, the mock tap, live/tap.cjs and the Electron launcher agree on it.

/** tap tells host about its SDK packets this often: {t:'pulse', packets, last_ago_ms} (spec 7.1). */
const PULSE_EVERY_MS = 1000;

/** No SDK packet for this long while Running is tap_lost (spec 7.2; 3 s is an assumption smoke checks). */
const TAP_SILENCE_MS = 3000;

/**
 * After {t:'stop'} host waits this long for tap to exit, then kills it and records that (event
 * tap_killed, spec 7.2). tap divides it among the steps of its stop (await stopAsync(), the end of
 * samples.jsonl and sdk_raw.jsonl.gz, destroy()), so its whole stop ends inside it. 25 s: stopAsync()
 * may take several seconds (spec 7.1), and the first tap allowed 10 s each for stopAsync() and
 * destroy() plus 5 s for its files. COPYHOLDER_TAP_STOP_BUDGET_MS sets it for host and tap alike (tests).
 */
const TAP_STOP_BUDGET_MS = 25_000;

module.exports = { PULSE_EVERY_MS, TAP_SILENCE_MS, TAP_STOP_BUDGET_MS };
