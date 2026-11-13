'use strict';
// CLI parsing and the mode table of live/host.cjs (spec 6.5, 13.3).

// kind: manifest.json `kind` (core/schemas/common.ts RECORD_KINDS).
// tap: which tap a mode forks by default (null: no tap, spec 6.5).
// consent: consent screen text of the page, 'live' (camera and microphone), 'mic' (microphone only,
//   spec 12.2) or 'replay' (live-from: neither runs; the recording stands in for both, spec 6.5).
// narrator: where narrator files come from (live/lib/narrator.cjs).
// counts: the recording starts only on a clean, current git tree (spec 14.1, assumption there); live-from
//   and live-sim are development runs that never feed numbers (spec 6.5), except the pilot listening;
//   headstart runs on a judge's computer (spec 6.5), which may hold a downloaded copy, not a clone.
const MODES = Object.freeze({
  gate: { kind: 'gate', tap: 'real', consent: 'live', narrator: 'gate', counts: true },
  doctor: { kind: 'doctor', tap: null, consent: 'mic', narrator: 'doctor', counts: true },
  smoke: { kind: 'smoke', tap: 'real', consent: 'live', narrator: 'none', counts: true },
  session: { kind: 'numbers', tap: 'real', consent: 'live', narrator: 'sealed', counts: true },
  rehearsal: { kind: 'rehearsal', tap: 'real', consent: 'live', narrator: 'sealed', counts: true },
  demo: { kind: 'demo', tap: 'real', consent: 'live', narrator: 'sealed', counts: true },
  spacebar: { kind: 'spacebar', tap: null, consent: 'mic', narrator: 'sealed', counts: true },
  headstart: { kind: 'headstart', tap: 'real', consent: 'live', narrator: 'sample', counts: false },
  'live-from': { kind: 'live_from', tap: 'mock', consent: 'replay', narrator: 'replay', counts: false },
  'live-sim': { kind: 'live_sim', tap: 'mock', consent: 'mic', narrator: 'sealed', counts: false },
});

const MODE_NAMES = Object.freeze(Object.keys(MODES));

// The listening without camera is `live:sim --plan pilot` (spec 10.2, 13.3); it has its own step order (spec 8.5).
const PILOT_PLAN = 'pilot';

// Day-1 packs: A, spares B and C, the short probe 0 (spec 9.4, 13.3).
const GATE_PACKS = Object.freeze(['A', 'B', 'C', '0']);

const USAGE =
  'Usage: node live/host.cjs --mode <' + MODE_NAMES.join('|') + '> ' +
  '[--pack A] [--id <id>] [--plan <id>] [--from <id>] [--tap real|mock] [--no-open] [--level]';

// Folder and plan names: core/schemas/common.ts SESSION_ID (lower case, digits, '-', '_').
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function isSafeId(s) {
  return typeof s === 'string' && ID_RE.test(s);
}

/**
 * Parses argv (without node and script). Returns {opts, error}.
 * A positional argument means: the plan in sealed modes, the source recording in live-from,
 * the folder id elsewhere (so `npm run session -- s1` and `npm run live:from -- gate-a` work).
 */
function parseHostArgs(argv) {
  const o = { mode: null, pack: null, id: null, plan: null, from: null, tap: null, open: true, level: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : null;
    const value = () => {
      if (inline !== null) return inline;
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return null;
      i += 1;
      return v;
    };
    switch (flag) {
      case '--mode': o.mode = value(); break;
      case '--pack': o.pack = value(); break;
      case '--id': o.id = value(); break;
      case '--plan': o.plan = value(); break;
      case '--from': o.from = value(); break;
      case '--tap': o.tap = value(); break;
      case '--no-open': o.open = false; break;
      case '--level': o.level = true; break;
      case '--help': case '-h': return { opts: null, error: USAGE };
      default:
        if (a.startsWith('-')) return { opts: null, error: `Unknown option ${a}. ${USAGE}` };
        positional.push(a);
    }
  }
  if (!o.mode || !MODES[o.mode]) return { opts: null, error: `Choose a mode. ${USAGE}` };
  const m = MODES[o.mode];
  if (positional.length > 1) return { opts: null, error: `Too many arguments: ${positional.join(' ')}. ${USAGE}` };
  const pos = positional[0] ?? null;
  if (pos !== null) {
    if (m.narrator === 'sealed') o.plan = o.plan ?? pos;
    else if (o.mode === 'live-from') o.from = o.from ?? pos;
    else o.id = o.id ?? pos;
  }
  if (o.tap !== null && o.tap !== 'real' && o.tap !== 'mock') return { opts: null, error: '--tap takes real or mock.' };
  const names = 'lower-case letters, digits, - and _';
  if (o.id !== null && !isSafeId(o.id)) return { opts: null, error: `Not a valid recording name: ${o.id} (use ${names}).` };
  if (o.plan !== null && !isSafeId(o.plan)) return { opts: null, error: `Not a valid plan name: ${o.plan} (use ${names}).` };
  if (o.from !== null && !isSafeId(o.from)) return { opts: null, error: `Not a valid recording name: ${o.from} (use ${names}).` };
  if (o.mode === 'gate') {
    if (o.pack === null) return { opts: null, error: 'Name the pack, for example: npm run gate -- --pack A' };
    o.pack = o.pack.toUpperCase();
    if (!GATE_PACKS.includes(o.pack)) return { opts: null, error: `Not a pack: ${o.pack}. The packs are A, B, C and 0.` };
  } else if (o.pack !== null) {
    return { opts: null, error: '--pack works only with --mode gate.' };
  }
  if (o.mode === 'session' && o.plan === null) {
    return { opts: null, error: 'Name the session, for example: npm run session -- s1' };
  }
  if (o.mode === 'live-from' && o.from === null) {
    return { opts: null, error: 'Name the recording to replay, for example: npm run live:from -- gate-a' };
  }
  if (o.plan !== null && m.narrator !== 'sealed') return { opts: null, error: '--plan works only with session, rehearsal, demo, spacebar and live-sim.' };
  if (o.from !== null && o.mode !== 'live-from') return { opts: null, error: '--from works only with --mode live-from.' };
  if (o.mode === 'rehearsal') o.plan = o.plan ?? 'rehearsal';
  if (o.mode === 'spacebar') o.plan = o.plan ?? 'k1';
  if (o.mode === 'live-sim') o.plan = o.plan ?? PILOT_PLAN;
  if (o.level && o.mode !== 'doctor') return { opts: null, error: '--level works only with --mode doctor.' };
  // Which tap runs. Modes without a tap ignore --tap (spec 6.5: doctor and spacebar run without one);
  // live-from always replays through the mock tap.
  if (m.tap === null) o.tap = null;
  else if (o.mode === 'live-from') o.tap = 'mock';
  else o.tap = o.tap ?? m.tap;
  return { opts: o, error: null };
}

/** manifest.json `kind` of a run: the mode's kind, or 'pilot' for live-sim on the pilot plan (spec 8.5, 10.2). */
function kindFor(opts) {
  if (opts.mode === 'live-sim' && opts.plan === PILOT_PLAN) return 'pilot';
  return MODES[opts.mode].kind;
}

/** Whether this run needs a clean, current git tree (spec 14.1). */
function needsCleanTree(opts) {
  return MODES[opts.mode].counts || kindFor(opts) === 'pilot';
}

/** Scenario name the page runs (GET /api/config; web/scenarios/index.ts). */
function scenarioName(opts) {
  switch (opts.mode) {
    case 'gate': return `gate-${opts.pack}`;
    case 'doctor': return opts.level ? 'doctor-level' : 'doctor';
    default: return opts.mode;
  }
}

module.exports = {
  MODES, MODE_NAMES, GATE_PACKS, PILOT_PLAN, USAGE, isSafeId, parseHostArgs, kindFor, needsCleanTree, scenarioName,
};
