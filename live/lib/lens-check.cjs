'use strict';
// Whether the signal check of a headstart take covers the lens (spec 15.2): "smoke tries the covered
// lens in advance (spec 7.12, question 7); if that raises an SDK error event, the signal check keeps
// only the deep breath". An SDK error ends the recording (live/host.cjs onSdkError), so a take that
// covered the lens on such a setup would lose loop check B. The answer goes to the page as /api/config
// `lensCheck` (docs/protocol.md). settings.env COPYHOLDER_LENS_CHECK wins: `off` leaves the lens out,
// `on` keeps it; empty: the newest smoke_report.json that reached the lens step decides, and without
// one the lens stays in.
const fs = require('node:fs');
const path = require('node:path');

const SMOKE_REPORT_FILE = 'smoke_report.json'; // analysis/smoke/report.ts SMOKE_REPORT_FILE
const LENS_QUESTION = 'q7_lens_cover'; // analysis/smoke/report.ts QUESTION_KEYS
const SETTING = 'COPYHOLDER_LENS_CHECK';

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * The lens answer of the newest smoke run (highest smoke-<n>) whose smoke_report.json reached the lens
 * step: {id, errors} with the SDK errors seen during or after the cover (analysis/smoke/answers-run.ts
 * answerLens). Null when no smoke run has one.
 */
function smokeLensAnswer(sessionsDir) {
  const runs = [];
  for (const name of listDirs(sessionsDir)) {
    const m = /^smoke-(\d+)$/.exec(name);
    if (m) runs.push({ n: Number(m[1]), id: name });
  }
  runs.sort((a, b) => b.n - a.n);
  for (const run of runs) {
    const report = readJson(path.join(sessionsDir, run.id, SMOKE_REPORT_FILE));
    const q = report && report.questions && typeof report.questions === 'object' ? report.questions[LENS_QUESTION] : null;
    if (!q || typeof q !== 'object' || q.covered !== true) continue;
    return { id: run.id, errors: Array.isArray(q.errors) ? q.errors.length : 0 };
  }
  return null;
}

/**
 * {lens, why} for a headstart take. `setting` is COPYHOLDER_LENS_CHECK as host reads it (the
 * environment, else settings.env): 'off' or 'on' in any case; anything else defers to smoke.
 */
function headstartLensCheck(sessionsDir, setting) {
  const s = typeof setting === 'string' ? setting.trim().toLowerCase() : '';
  if (s === 'off') return { lens: false, why: `${SETTING}=off` };
  if (s === 'on') return { lens: true, why: `${SETTING}=on` };
  const smoke = smokeLensAnswer(sessionsDir);
  if (smoke === null) return { lens: true, why: 'no smoke report with the lens step' };
  if (smoke.errors > 0) return { lens: false, why: `${smoke.id}: the covered lens raised an SDK error` };
  return { lens: true, why: `${smoke.id}: no SDK error on the covered lens` };
}

module.exports = { SETTING, smokeLensAnswer, headstartLensCheck };
