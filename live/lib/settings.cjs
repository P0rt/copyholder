'use strict';
// Non-secret settings host reads besides the camera and metric set (spec 13.6: settings.env, the environment
// wins). host never reads .env. Names are working names (assumption, spec 7.1).
//   COPYHOLDER_MIC_NAME     part of the microphone's name, any case (spec 5.1, 5.2); empty: the system default
//   COPYHOLDER_OUTPUT_NAME  part of the output device's name, any case; empty: the system default
//   COPYHOLDER_PORT         the page's port on 127.0.0.1; empty: DEFAULT_PORT; 0: one the system picks
const { hostSetting } = require('./repo-info.cjs');

/**
 * A fixed port keeps the page's origin, so Chrome remembers the microphone grant in its own profile
 * (live/lib/chrome.cjs) from one run to the next. When it is busy, host takes one the system picks.
 */
const DEFAULT_PORT = 47811;
const MAX_NAME = 200;
/** Errors of listen() after which host falls back to a port the system picks. */
const PORT_FALLBACK_CODES = Object.freeze(['EADDRINUSE', 'EACCES']);

/**
 * The port to listen on: {port, note}. note is a line for the terminal when the setting is not a port
 * (DEFAULT_PORT is used then), else null.
 */
function parsePort(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s === '') return { port: DEFAULT_PORT, note: null };
  const v = Number(s);
  if (/^\d+$/.test(s) && Number.isSafeInteger(v) && v >= 0 && v <= 65535) return { port: v, note: null };
  return { port: DEFAULT_PORT, note: `COPYHOLDER_PORT=${s.slice(0, 40)} is not a port number (0-65535); using ${DEFAULT_PORT}.` };
}

function portSetting(env, repoRoot) {
  return parsePort(hostSetting(env, repoRoot, 'COPYHOLDER_PORT'));
}

function deviceName(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s === '' ? null : s.slice(0, MAX_NAME);
}

/**
 * /api/config `devices` (docs/protocol.md; web/ui/config.ts): {input?, output?}, each a part of the device
 * name the page picks, case-insensitive. A key is left out when its setting is empty.
 */
function deviceSettings(env, repoRoot) {
  const out = {};
  const input = deviceName(hostSetting(env, repoRoot, 'COPYHOLDER_MIC_NAME'));
  const output = deviceName(hostSetting(env, repoRoot, 'COPYHOLDER_OUTPUT_NAME'));
  if (input !== null) out.input = input;
  if (output !== null) out.output = output;
  return out;
}

module.exports = { DEFAULT_PORT, PORT_FALLBACK_CODES, parsePort, portSetting, deviceSettings };
