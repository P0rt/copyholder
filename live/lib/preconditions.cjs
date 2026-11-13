'use strict';
// Checks before a recording starts (spec 8.3, 8.5, 10.4, 14.1). Each returns a refusal text or null.
const fs = require('node:fs');
const path = require('node:path');

const HEX64 = /^(?:sha256:)?([0-9a-f]{64})$/;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function folders(sessionsDir) {
  try {
    return fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/** The plan seal from commitment.txt (64 hex characters, public, spec 8.2-8.3), or null. */
function readCommitment(dir) {
  try {
    const m = HEX64.exec(fs.readFileSync(path.join(dir, 'commitment.txt'), 'utf8').trim().toLowerCase());
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Whether a recording played sealed sound: manifest.json narrator.first_sealed_n, the sample where
 * Deck first narrated after preflight_ok (host sets it from the stamps). Fetching the clips or
 * timings.json does not spend a text (spec 10.4, 11.5). A manifest written before that field
 * existed counts as heard once any sealed file was served (the stricter old rule).
 */
function sealedSoundPlayed(manifest) {
  const nar = manifest && manifest.narrator;
  if (!nar || typeof nar !== 'object') return false;
  if (Object.hasOwn(nar, 'first_sealed_n')) return typeof nar.first_sealed_n === 'number';
  return Array.isArray(nar.sealed_served) && nar.sealed_served.length > 0;
}

/**
 * Id of a recording that already played sealed sound of `plan`, or null: a text is heard once
 * (spec 7.8). An attempt stopped before the first sealed sound did not spend it (spec 10.4).
 */
function planHeardIn(sessionsDir, plan) {
  for (const name of folders(sessionsDir).sort()) {
    const m = readJson(path.join(sessionsDir, name, 'manifest.json'));
    if (m && m.plan === plan && sealedSoundPlayed(m)) return name;
  }
  return null;
}

/** First of demo-1, demo-2, demo-3 not heard yet (spec 13.3), or null. */
function firstUnheardDemo(sessionsDir) {
  for (const plan of ['demo-1', 'demo-2', 'demo-3']) {
    if (planHeardIn(sessionsDir, plan) === null) return plan;
  }
  return null;
}

/**
 * After the freeze-1 tag (freeze_manifest.json exists) a numbers session, the space bar block and a
 * demo take start only with a plan seal listed there (spec 8.3 point 3).
 */
function freezeRefusal(freezeManifestFile, commitment) {
  if (!fs.existsSync(freezeManifestFile)) return null;
  const fm = readJson(freezeManifestFile);
  if (!fm || !Array.isArray(fm.plans)) return 'freeze_manifest.json cannot be read, so this recording cannot start.';
  if (commitment === null) return 'This plan has no seal (commitment.txt), so this recording cannot start.';
  const listed = fm.plans.some((p) => {
    const m = p && typeof p.plan_commitment === 'string' ? HEX64.exec(p.plan_commitment.toLowerCase()) : null;
    return m !== null && m[1] === commitment;
  });
  return listed ? null : "This plan's seal is not in freeze_manifest.json, so this recording cannot start.";
}

/** After the first reveal of a numbers session, `session` does not start again (spec 8.5, assumption there). */
function revealRefusal(sessionsDir) {
  for (const name of folders(sessionsDir).sort()) {
    const m = readJson(path.join(sessionsDir, name, 'manifest.json'));
    if (!m || m.kind !== 'numbers') continue;
    let text = '';
    try {
      text = fs.readFileSync(path.join(sessionsDir, name, 'ledger.jsonl'), 'utf8');
    } catch {
      continue;
    }
    const revealed = text.split('\n').some((l) => {
      try {
        return JSON.parse(l).step === 'reveal';
      } catch {
        return false;
      }
    });
    if (revealed) return `Session ${name} is already revealed, so no new numbers session can start.`;
  }
  return null;
}

/** Recordings start only on a clean git tree that is not behind origin/main (spec 14.1). */
function gitRefusal(git) {
  if (git.commit === null) return 'This folder is not a git clone (or git is missing), so this recording cannot start.';
  if (git.treeClean !== true) return 'The repository has local changes. Run git status, undo or commit them, then start again.';
  if (git.behind === true) return 'This copy is behind GitHub. Run git pull --ff-only and npm ci, then start again.';
  return null;
}

module.exports = {
  readCommitment, sealedSoundPlayed, planHeardIn, firstUnheardDemo, freezeRefusal, revealRefusal, gitRefusal,
};
