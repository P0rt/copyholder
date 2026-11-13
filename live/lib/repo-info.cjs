'use strict';
// Facts for manifest.json (spec 8.1): app commit, clean tree, Mac model, SDK version and metrics.
// Git is only read here: rev-parse, status, merge-base.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// tap's own parser (pure), so host and tap read settings.env the same way: inline `# notes` go
const { parseEnvText } = require('../reduce.cjs');

function run(cmd, args, cwd) {
  try {
    const out = execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    });
    return { ok: true, out };
  } catch {
    return { ok: false, out: '' };
  }
}

/**
 * {commit, treeClean, behind}: short commit (7+ chars), whether `git status --porcelain` is empty,
 * and whether HEAD is behind the local origin/main ref (no fetch). Unknown values are null.
 */
function gitInfo(repoRoot) {
  const head = run('git', ['rev-parse', '--short=7', 'HEAD'], repoRoot);
  if (!head.ok) return { commit: null, treeClean: null, behind: null };
  const status = run('git', ['status', '--porcelain'], repoRoot);
  let behind = null;
  const remote = run('git', ['rev-parse', '--verify', '--quiet', 'origin/main'], repoRoot);
  const full = run('git', ['rev-parse', 'HEAD'], repoRoot);
  if (remote.ok && full.ok) {
    const same = remote.out.trim() === full.out.trim();
    const ancestor = run('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], repoRoot).ok;
    behind = !same && ancestor;
  }
  return {
    commit: head.out.trim() || null,
    treeClean: status.ok ? status.out.trim() === '' : null,
    behind,
  };
}

/** Mac model ("Mac14,2") on macOS, platform-arch elsewhere. Never the host name. */
function machineModel() {
  if (process.platform === 'darwin') {
    const r = run('/usr/sbin/sysctl', ['-n', 'hw.model'], process.cwd());
    if (r.ok && r.out.trim()) return r.out.trim();
  }
  return `${os.platform()}-${os.arch()}`;
}

const SDK_PACKAGE = '@smartspectra/node-sdk';

/** The SDK version pinned in live/package.json (spec 13.6), or null. */
function sdkVersionFrom(livePackageJson) {
  try {
    const pkg = JSON.parse(fs.readFileSync(livePackageJson, 'utf8'));
    const v = (pkg.dependencies && pkg.dependencies[SDK_PACKAGE]) ||
      (pkg.optionalDependencies && pkg.optionalDependencies[SDK_PACKAGE]) || null;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

// Requested metrics (spec 7.1). The spare set is the SDK's breathingMetrics group plus landmarks and
// talking; the names inside that group are known only after smoke, so it is recorded as one name.
const MAIN_METRICS = Object.freeze(['CHEST_BREATHING', 'BREATHING_RATE', 'FACE_LANDMARKS', 'TALKING']);
const SPARE_METRICS = Object.freeze(['BREATHING_METRICS', 'FACE_LANDMARKS', 'TALKING']);

/**
 * A non-secret setting as tap sees it: the environment wins (even when empty), then settings.env in the repo
 * root, parsed by tap's parseEnvText (spec 7.1, 13.6). host never reads .env: only tap holds the key.
 */
function hostSetting(env, repoRoot, name) {
  if (typeof env[name] === 'string') return env[name];
  try {
    return parseEnvText(fs.readFileSync(path.join(repoRoot, 'settings.env'), 'utf8'))[name] ?? '';
  } catch {
    return '';
  }
}

/** COPYHOLDER_METRICS (spec 7.1): 'spare' picks the spare metric set. */
function metricsSetting(env, repoRoot) {
  return hostSetting(env, repoRoot, 'COPYHOLDER_METRICS');
}

/** Metric names for manifest.json sdk.metrics. */
function requestedMetrics(setting) {
  return [...(setting === 'spare' ? SPARE_METRICS : MAIN_METRICS)];
}

module.exports = {
  MAIN_METRICS, SPARE_METRICS, gitInfo, machineModel, sdkVersionFrom, parseEnvText, hostSetting, metricsSetting,
  requestedMetrics,
};
