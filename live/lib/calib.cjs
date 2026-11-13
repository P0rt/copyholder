'use strict';
// Calibration the page gets as GET /api/config `calib` (spec 8.1, 10.4): L_rt, leak and output gain
// from calib.json of the doctor recordings, the trace sign from the gate recording with the verdict.
const fs = require('node:fs');
const path = require('node:path');

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

/** calib.json of every doctor-<n> folder that has one, oldest (lowest n) first. */
function doctorCalibs(sessionsDir) {
  const out = [];
  for (const name of listDirs(sessionsDir)) {
    const m = /^doctor-(\d+)$/.exec(name);
    if (!m) continue;
    const calib = readJson(path.join(sessionsDir, name, 'calib.json'));
    if (calib) out.push({ n: Number(m[1]), id: name, calib });
  }
  return out.sort((a, b) => a.n - b.n);
}

/** calib.json of the gate recording that has verdict.json (the newest verdict wins), or null. */
function verdictGateCalib(sessionsDir) {
  let best = null;
  for (const name of listDirs(sessionsDir)) {
    if (!name.startsWith('gate-')) continue;
    const verdict = path.join(sessionsDir, name, 'verdict.json');
    if (!fs.existsSync(verdict)) continue;
    const calib = readJson(path.join(sessionsDir, name, 'calib.json'));
    const t = fs.statSync(verdict).mtimeMs;
    if (calib && (best === null || t > best.t)) best = { t, id: name, calib };
  }
  return best && { id: best.id, calib: best.calib };
}

/**
 * {calib, sources}: the doctor calib.json files merged oldest first, so every field comes from the
 * latest doctor run that wrote it (`doctor --level` writes only the gain and the leak, spec 5.2), plus
 * `polarity` of the gate recording with the verdict (spec 8.1). calib is null when neither exists.
 */
function pageCalib(sessionsDir) {
  const doctors = doctorCalibs(sessionsDir);
  const gate = verdictGateCalib(sessionsDir);
  if (doctors.length === 0 && !(gate && gate.calib.polarity)) {
    return { calib: null, sources: { doctor: [], gate: gate ? gate.id : null } };
  }
  const calib = { schema: 'calib/1' };
  for (const d of doctors) Object.assign(calib, d.calib);
  delete calib.polarity; // the sign comes only from the gate recording with the verdict
  if (gate && gate.calib.polarity !== undefined) calib.polarity = gate.calib.polarity;
  calib.schema = 'calib/1';
  return { calib, sources: { doctor: doctors.map((d) => d.id), gate: gate ? gate.id : null } };
}

/** output_gain of a calib object when the page would use it ((0, 1], web/ui/levels.ts), else null. */
function usableGain(calib) {
  const g = calib && calib.output_gain;
  return typeof g === 'number' && Number.isFinite(g) && g > 0 && g <= 1 ? g : null;
}

/**
 * GET /api/config `detector` for the worker's step() (spec 7.4, 8.4): the parsed params/frozen.json
 * ({} when it does not exist yet: the detector's preliminary values), the trace sign s from the gate
 * recording with the verdict (1 before it), and the variant (D3 only when the frozen file names it).
 */
function detectorSetup(frozenParamsFile, calib) {
  const params = readJson(frozenParamsFile) ?? {};
  const sign = calib && calib.polarity && (calib.polarity.sign === 1 || calib.polarity.sign === -1) ? calib.polarity.sign : 1;
  const named = params.variant ?? (params.d1 && typeof params.d1 === 'object' ? params.d1.variant : undefined);
  return { params, sign, variant: named === 'D3' ? 'D3' : 'D1' };
}

module.exports = { doctorCalibs, verdictGateCalib, pageCalib, usableGain, detectorSetup };
