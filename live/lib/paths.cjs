'use strict';
// Where host finds things. Every path can be moved by an environment variable,
// so tests run against temporary folders (tests/live/).
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function fromEnv(env, name, fallback) {
  const v = env[name];
  return v ? path.resolve(v) : fallback;
}

/**
 * COPYHOLDER_SESSIONS_DIR  session folders (default sessions/, spec 8.1)
 * COPYHOLDER_WEB_DIST      built page (default web/dist, spec 7.2)
 * COPYHOLDER_GATE_DIR      gate packs (default gate/, spec 13.1) and doctor's volume sample in its level/
 * COPYHOLDER_SAMPLE_DIR    sample text for headstart (default sample/)
 * COPYHOLDER_SEALED_DIR    sealed folders (default ~/Library/Application Support/copyholder/sealed, spec 8.2)
 * COPYHOLDER_PARAMS_FILE   detector parameters for the page (default params/frozen.json, spec 8.4)
 * COPYHOLDER_QUICKCHECK_SCRIPT  quickcheck entry, relative to the repo root; 'off' skips it
 */
function resolvePaths(env = process.env) {
  const gateDir = fromEnv(env, 'COPYHOLDER_GATE_DIR', path.join(REPO_ROOT, 'gate'));
  return {
    repoRoot: REPO_ROOT,
    sessionsDir: fromEnv(env, 'COPYHOLDER_SESSIONS_DIR', path.join(REPO_ROOT, 'sessions')),
    webDist: fromEnv(env, 'COPYHOLDER_WEB_DIST', path.join(REPO_ROOT, 'web', 'dist')),
    gateDir,
    // doctor's 20 s volume sample level.wav (spec 7.7), rendered by gate/level/render.ts
    levelDir: path.join(gateDir, 'level'),
    sampleDir: fromEnv(env, 'COPYHOLDER_SAMPLE_DIR', path.join(REPO_ROOT, 'sample')),
    sealedRoot: fromEnv(env, 'COPYHOLDER_SEALED_DIR',
      path.join(os.homedir(), 'Library', 'Application Support', 'copyholder', 'sealed')),
    tapFile: path.join(REPO_ROOT, 'live', 'tap.cjs'),
    mockTapFile: path.join(REPO_ROOT, 'live', 'mock-tap.cjs'),
    livePackageJson: path.join(REPO_ROOT, 'live', 'package.json'),
    freezeManifest: path.join(REPO_ROOT, 'freeze_manifest.json'),
    frozenParams: fromEnv(env, 'COPYHOLDER_PARAMS_FILE', path.join(REPO_ROOT, 'params', 'frozen.json')),
    settingsEnv: path.join(REPO_ROOT, 'settings.env'),
    quickcheckScript: env.COPYHOLDER_QUICKCHECK_SCRIPT || 'analysis/quickcheck.ts',
    chromeProfile: path.join(os.homedir(), '.copyholder', 'chrome-profile'),
  };
}

/** Path for messages: relative to the repo root when inside it. */
function shownPath(p) {
  const rel = path.relative(REPO_ROOT, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
}

module.exports = { REPO_ROOT, resolvePaths, shownPath };
