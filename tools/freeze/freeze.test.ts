// npm run freeze (spec 8.4, 13.6, 14.2) against a temporary repository with a bare remote and a
// stand-in ots command. Nothing is ever stamped for real here.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleFreezeManifest } from '../../core/schemas/examples.ts';
import type { RepoView } from './git.ts';
import { OTS_ENV, OTS_MAGIC, otsCommand, otsProofProblem } from './ots.ts';
import { buildGatePreregParams, frozenParamsText } from './params.ts';
import { runFreeze } from './run.ts';
import { appCommitProblems, sameJson, TAG_SPECS, tagMessage, vadAgreementProblems } from './tags.ts';
import { makeTempRepo, type TempRepo } from './test-repo.ts';

const sha = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');
/** Cue lists of the two packs of the fixture (gate/pack-<X>/cues.json, docs/protocol.md). */
const CUES: Record<string, string> = { '0': '[15000,33000]\n', A: '[17000,34500,52000]\n' };
/** The voice detector values of a doctor run (spec 7.3: gate-prereg comes after doctor). */
const DOCTOR = { id: 'doctor-1', periodicity: 0.5, floorDb: -60.5 };

interface PreregOpts {
  /** Pack -> text of its SHA-256 cell; default the hashes of CUES. */
  cues?: Record<string, string>;
  floor?: string;
  periodicity?: string;
  /** APP_COMMIT as written; default the placeholder. */
  app?: string;
  extra?: string;
}

function preregText(o: PreregOpts = {}): string {
  const cues = o.cues ?? Object.fromEntries(Object.entries(CUES).map(([p, t]) => [p, `\`${sha(t)}\``]));
  return [
    '# Preregistration',
    '',
    `The tagged commit differs from \`${o.app ?? '{{APP_COMMIT}}'}\` only in \`PREREG.md\` and \`PREREG.md.ots\`.`,
    '',
    '## Voice detector',
    '',
    '| Parameter | Value |',
    '|---|---|',
    '| High-pass, hop | 150 Hz, 5 ms |',
    `| Noise floor | ${o.floor ?? '-60.5'} dB, measured by \`npm run doctor\` |`,
    `| Periodicity threshold | ${o.periodicity ?? '0.50'} |`,
    '',
    '### 7.1 Packs, cues and cue-list hashes',
    '',
    '| Pack | SHA-256 of `cues.json` |',
    '|---|---|',
    ...Object.entries(cues).map(([pack, cell]) => `| ${pack} | ${cell} |`),
    '',
    o.extra ?? '',
    '## Placeholders',
    '',
    '| Name | Value and source |',
    '|---|---|',
    '| `CUES_SHA256_A` | SHA-256 of the exact bytes of `gate/pack-A/cues.json` |',
    '| `APP_COMMIT` | the commit of the app, filled in last |',
    '',
  ].join('\n');
}

interface Fixture extends TempRepo {
  /** APP_COMMIT: the last commit of the app before PREREG.md was filled in. */
  app: string;
  /** Rewrites PREREG.md (APP_COMMIT kept) and commits it alone. */
  setPrereg(o?: PreregOpts): void;
  /** Changes app files and commits them, then fills PREREG.md with the new APP_COMMIT. */
  appChange(files: Record<string, string | null>, o?: PreregOpts): void;
  freeze(...argv: string[]): { code: number; out: string };
}

function makeFixture(): Fixture {
  const repo = makeTempRepo('copyholder-freeze-');
  repo.write('params/frozen.json', frozenParamsText(buildGatePreregParams(DOCTOR).params));
  for (const [p, t] of Object.entries(CUES)) {
    repo.write(`gate/pack-${p}/cues.json`, t);
    repo.write(`gate/pack-${p}/listen.txt`, 'Text.\n');
  }
  repo.write('analysis/gate.ts', 'export {};\n');
  repo.write('PREREG.md', preregText());
  const fx: Fixture = {
    ...repo,
    app: repo.commitAll('Gate analysis, params and packs'),
    setPrereg(o = {}) {
      repo.write('PREREG.md', preregText({ app: fx.app, ...o }));
      repo.commitAll('PREREG.md');
    },
    appChange(files, o = {}) {
      for (const [rel, text] of Object.entries(files)) repo.write(rel, text);
      fx.app = repo.commitAll('App change');
      fx.setPrereg(o);
    },
    freeze(...argv) {
      const lines: string[] = [];
      const code = runFreeze(argv, { repoDir: repo.work, env: repo.env, log: (l) => lines.push(l) });
      return { code, out: lines.join('\n') };
    },
  };
  fx.setPrereg();
  repo.git(['push', '--quiet', '-u', 'origin', 'main']);
  return fx;
}

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture();
});
afterEach(() => {
  fx.remove();
});

const remoteTag = (tag = 'gate-prereg'): string => fx.git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]);

function expectNothingDone(): void {
  expect(fx.otsCalls()).toEqual([]);
  expect(existsSync(join(fx.work, 'PREREG.md.ots'))).toBe(false);
  expect(fx.git(['tag', '--list'])).toBe('');
  expect(remoteTag()).toBe('');
}

function expectRefused(r: { code: number; out: string }, pattern: RegExp): void {
  expect(r.code, r.out).toBe(1);
  expect(r.out).toMatch(pattern);
  expect(r.out).toMatch(/FREEZE REFUSED gate-prereg/);
  expectNothingDone();
}

describe('npm run freeze -- gate-prereg: refusals', () => {
  it('refuses a dirty tree, before any stamp', () => {
    fx.write('PREREG.md', `${fx.read('PREREG.md').toString('utf8')}\nOne more line.\n`);
    expectRefused(fx.freeze('gate-prereg'), /working tree is not clean/);
  });

  it('refuses an untracked file too', () => {
    fx.write('analysis/new-step.ts', 'export {};\n');
    expectRefused(fx.freeze('gate-prereg'), /not clean.*analysis\//);
  });

  it('refuses when PREREG.md has no cue-list row for a pack folder', () => {
    fx.setPrereg({ cues: { '0': `\`${sha(CUES['0']!)}\`` } });
    expectRefused(fx.freeze('gate-prereg'), new RegExp(`PREREG\\.md has no row for pack A in its cue-list hash table; gate/pack-A/cues\\.json has SHA-256 ${sha(CUES['A']!)}`));
  });

  it('refuses a cues.json whose bytes differ from the hash in PREREG.md (spec 9.2)', () => {
    const rerendered = '[17000,34500,52500]\n';
    fx.appChange({ 'gate/pack-A/cues.json': rerendered });
    expectRefused(fx.freeze('gate-prereg'), new RegExp(`PREREG\\.md line \\d+ lists ${sha(CUES['A']!)} for pack A, but gate/pack-A/cues\\.json has SHA-256 ${sha(rerendered)}`));
  });

  it('refuses a pack without cues.json', () => {
    fx.appChange({ 'gate/pack-A/cues.json': null });
    expectRefused(fx.freeze('gate-prereg'), /gate\/pack-A\/cues\.json does not exist: render pack A and write its cue list first/);
  });

  it('refuses a cues.json that is not committed (ignored by git)', () => {
    fx.write('.gitignore', 'gate/pack-A/cues.json\n');
    fx.git(['rm', '--cached', '--quiet', 'gate/pack-A/cues.json']);
    fx.appChange({});
    expect(existsSync(join(fx.work, 'gate/pack-A/cues.json'))).toBe(true);
    expectRefused(fx.freeze('gate-prereg'), /not every frozen file is committed: .*gate\/pack-A\/cues\.json/);
  });

  it('refuses a pack.json that lists another cues.json hash, in the format host reads', () => {
    fx.appChange({ 'gate/pack-A/pack.json': JSON.stringify({ files: { 'cues.json': { sha256: sha('another cue list') } } }) });
    expectRefused(fx.freeze('gate-prereg'), /gate\/pack-A\/pack\.json lists [0-9a-f]{64} for cues\.json, but gate\/pack-A\/cues\.json has SHA-256 [0-9a-f]{64}: host would refuse to serve it/);
  });

  it('refuses a row with a placeholder or two hashes, and a row for a pack without a folder', () => {
    fx.setPrereg({ cues: { '0': '`{{CUES_SHA256_0}}`', A: `\`${sha(CUES['A']!)}\` or \`${sha('x')}\``, C: `\`${sha('c')}\`` } });
    const r = fx.freeze('gate-prereg');
    expect(r.out).toMatch(/still holds the placeholder of pack 0; gate\/pack-0\/cues\.json has SHA-256/);
    expect(r.out).toMatch(/holds 2 SHA-256 values for pack A, expected one/);
    expect(r.out).toMatch(/has a cue-list row for pack C, but gate\/pack-C\/ does not exist/);
    expectRefused(r, /placeholder\(s\): \{\{CUES_SHA256_0\}\}/);
  });

  it('refuses params/frozen.json with k or theta_G, and a missing one', () => {
    const tuned = { ...buildGatePreregParams(DOCTOR).params } as Record<string, unknown>;
    tuned['d1'] = { ...(tuned['d1'] as object), k: 2.5 };
    fx.appChange({ 'params/frozen.json': frozenParamsText(tuned) });
    let r = fx.freeze('gate-prereg');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/d1\.k is set/);
    fx.appChange({ 'params/frozen.json': null });
    r = fx.freeze('gate-prereg');
    expectRefused(r, /params\/frozen\.json does not exist/);
  });

  it('refuses params/frozen.json without the floor of a doctor run (spec 7.3)', () => {
    fx.appChange({ 'params/frozen.json': frozenParamsText(buildGatePreregParams(null).params) });
    expectRefused(fx.freeze('gate-prereg'), /params\/frozen\.json: vad\.floor_db is missing: .*npx tsx tools\/freeze\/frozen\.ts/);
  });

  it('refuses voice detector values in PREREG.md that params/frozen.json does not hold (spec 8.4)', () => {
    fx.setPrereg({ floor: '-58.3', periodicity: '0.60' });
    const r = fx.freeze('gate-prereg');
    expect(r.out).toMatch(/PREREG\.md gives the noise floor -58\.3 dB, but params\/frozen\.json has vad\.floor_db -60\.5/);
    expectRefused(r, /PREREG\.md gives the periodicity threshold 0\.6, but params\/frozen\.json has vad\.periodicity 0\.5/);
  });

  it('refuses a placeholder left outside the Placeholders section', () => {
    fx.setPrereg({ extra: 'Noise floor: {{VAD_FLOOR_DB}} dB.\n' });
    expectRefused(fx.freeze('gate-prereg'), /placeholder\(s\): \{\{VAD_FLOOR_DB\}\}/);
  });

  it('refuses an APP_COMMIT that is missing or that HEAD has moved past', () => {
    fx.setPrereg({ app: '{{APP_COMMIT}}' });
    expectRefused(fx.freeze('gate-prereg'), /PREREG\.md names no commit of this repository: APP_COMMIT names/);
    fx.setPrereg();
    fx.write('analysis/gate.ts', 'export const changed = true;\n');
    fx.commitAll('analysis changed after APP_COMMIT was filled in');
    expectRefused(fx.freeze('gate-prereg'), new RegExp(`HEAD differs from APP_COMMIT ${fx.app} in analysis/gate\\.ts, not only in PREREG\\.md`));
  });

  it('refuses when HEAD is behind origin/main after a fetch', () => {
    const other = join(fx.root, 'other');
    fx.git(['clone', '--quiet', fx.remote, other], fx.root);
    fx.git(['config', 'user.name', 'Freeze Test'], other);
    fx.git(['config', 'user.email', 'freeze-test@example.invalid'], other);
    writeFileSync(join(other, 'later.txt'), 'pushed from elsewhere\n');
    fx.git(['add', 'later.txt'], other);
    fx.git(['commit', '--quiet', '-m', 'later'], other);
    fx.git(['push', '--quiet', 'origin', 'main'], other);
    expectRefused(fx.freeze('gate-prereg'), /HEAD is not equal to or ahead of origin\/main: run git pull --ff-only/);
  });

  it('refuses another branch than main: the Mac records from origin/main (spec 14.1)', () => {
    fx.git(['checkout', '--quiet', '-b', 'work-branch']);
    expectRefused(fx.freeze('gate-prereg'), /the freeze runs on main, not on work-branch: .*git checkout main && git merge --ff-only work-branch/);
    expect(fx.git(['branch', '--list', '--remotes'])).not.toMatch(/work-branch/);
  });

  it('refuses an unknown tag with the usage line', () => {
    const r = fx.freeze('gate-prereg2');
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/^Usage: npm run freeze -- <gate-prereg\|gate-retune\|freeze-1>/);
  });

  it('leaves nothing behind when ots fails', () => {
    fx.env['STUB_OTS_FAIL'] = '1';
    const head = fx.git(['rev-parse', 'HEAD']);
    const r = fx.freeze('gate-prereg');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ots stamp failed, so nothing was committed or tagged/);
    expect(fx.otsCalls()).toEqual([['stamp', 'PREREG.md']]);
    expect(existsSync(join(fx.work, 'PREREG.md.ots'))).toBe(false);
    expect(fx.git(['rev-parse', 'HEAD'])).toBe(head);
    expect(fx.git(['status', '--porcelain'])).toBe('');
    expect(remoteTag()).toBe('');
  });
});

describe('npm run freeze -- gate-prereg: the freeze', () => {
  it('--check runs every check and changes nothing', () => {
    const head = fx.git(['rev-parse', 'HEAD']);
    const r = fx.freeze('gate-prereg', '--check');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/FREEZE READY gate-prereg/);
    expect(r.out).toContain(sha(fx.read('PREREG.md')));
    expect(r.out).toContain(`${sha(CUES['A']!)}  gate/pack-A/cues.json`);
    expect(fx.git(['rev-parse', 'HEAD'])).toBe(head);
    expectNothingDone();
  });

  it('stamps PREREG.md, commits the .ots, tags with every hash and pushes both to main', () => {
    fx.appChange({ 'gate/pack-A/pack.json': JSON.stringify({ files: { 'cues.json': `sha256:${sha(CUES['A']!)}`, 'listen.wav': null } }) });
    const preregBytes = fx.read('PREREG.md');
    const paramsBytes = fx.read('params/frozen.json');
    const before = fx.git(['rev-parse', 'HEAD']);

    const r = fx.freeze('gate-prereg');
    expect(r.code, r.out).toBe(0);
    expect(fx.otsCalls()).toEqual([['stamp', 'PREREG.md']]);

    // The .ots commit: one new commit on top, adding only PREREG.md.ots, by the repository's author.
    const head = fx.git(['rev-parse', 'HEAD']);
    expect(fx.git(['rev-parse', 'HEAD~1'])).toBe(before);
    expect(fx.git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).toBe('PREREG.md.ots');
    expect(fx.git(['log', '-1', '--format=%an <%ae>'])).toBe('Freeze Test <freeze-test@example.invalid>');
    const proof = new Uint8Array(fx.read('PREREG.md.ots'));
    expect(otsProofProblem(proof, new Uint8Array(preregBytes))).toBeNull();

    // The annotated tag lists the SHA-256 of PREREG.md, params/frozen.json and every cue list, by path.
    expect(fx.git(['cat-file', '-t', 'gate-prereg'])).toBe('tag');
    const message = fx.git(['for-each-ref', '--format=%(contents)', 'refs/tags/gate-prereg']);
    expect(message).toContain(`${sha(preregBytes)}  PREREG.md`);
    expect(message).toContain(`${sha(paramsBytes)}  params/frozen.json`);
    expect(message).toContain(`${sha(CUES['0']!)}  gate/pack-0/cues.json`);
    expect(message).toContain(`${sha(CUES['A']!)}  gate/pack-A/cues.json`);

    // Both reached the remote: main at the .ots commit and the tag pointing to it.
    expect(fx.git(['rev-parse', 'main'], fx.remote)).toBe(head);
    expect(fx.git(['rev-parse', 'gate-prereg^{commit}'], fx.remote)).toBe(head);
    expect(fx.git(['cat-file', '-t', 'gate-prereg'], fx.remote)).toBe('tag');
    expect(fx.git(['show', 'main:PREREG.md.ots'], fx.remote).length).toBeGreaterThan(0);

    // The hash to publish, with one plain sentence (spec 14.2); pack.json of pack 0 is only noted.
    expect(r.out).toMatch(/FREEZE OK gate-prereg/);
    expect(r.out).toContain(`SHA-256 of PREREG.md: ${sha(preregBytes)}`);
    expect(r.out).toContain('Publish this SHA-256 of PREREG.md before you start the day-1 gate recording.');
    expect(r.out).toMatch(/Note: gate\/pack-0\/pack\.json does not exist yet/);
    expect(r.out).not.toMatch(/Note: gate\/pack-A/);

    // A second run finds the tag on the remote and changes nothing.
    const again = fx.freeze('gate-prereg');
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/already on origin.*nothing to do/);
    expect(again.out).toContain(`SHA-256 of PREREG.md: ${sha(preregBytes)}`);
    expect(fx.otsCalls()).toHaveLength(1);
    expect(fx.git(['rev-parse', 'HEAD'])).toBe(head);
  });

  it('prints the hash of the stored bytes again on a later run, also for bytes that are not UTF-8', () => {
    const text = Buffer.from(preregText({ app: fx.app, extra: 'Café notes.\n' }), 'latin1');
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(text)).toThrow();
    fx.write('PREREG.md', text);
    fx.commitAll('PREREG.md in Latin-1');
    const first = fx.freeze('gate-prereg');
    expect(first.code, first.out).toBe(0);
    expect(first.out).toContain(`SHA-256 of PREREG.md: ${sha(text)}`);
    const again = fx.freeze('gate-prereg');
    expect(again.out).toMatch(/nothing to do/);
    expect(again.out).toContain(`SHA-256 of PREREG.md: ${sha(text)}`);
  });

  it('a push that failed is finished by the next run, without a second stamp', () => {
    const hook = join(fx.remote, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "remote is read-only for now" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const first = fx.freeze('gate-prereg');
    expect(first.code).toBe(1);
    expect(first.out).toMatch(/git push failed .*run npm run freeze -- gate-prereg again/);
    const head = fx.git(['rev-parse', 'HEAD']);
    expect(fx.git(['rev-parse', 'gate-prereg^{commit}'])).toBe(head);
    expect(remoteTag()).toBe('');

    rmSync(hook);
    const second = fx.freeze('gate-prereg');
    expect(second.code, second.out).toBe(0);
    expect(fx.otsCalls()).toHaveLength(1);
    expect(fx.git(['rev-parse', 'gate-prereg^{commit}'], fx.remote)).toBe(head);
    expect(fx.git(['rev-parse', 'main'], fx.remote)).toBe(head);
  });

  it('a run that stopped after its commit tags and pushes that commit', () => {
    // As if the earlier run committed the stamp and then stopped before the tag.
    const stub = JSON.parse(fx.env[OTS_ENV]!) as string[];
    spawnSync(stub[0]!, [stub[1]!, 'stamp', 'PREREG.md'], { cwd: fx.work, env: { ...fx.env, STUB_OTS_LOG: '' } });
    fx.git(['add', 'PREREG.md.ots']);
    fx.git(['commit', '--quiet', '-m', 'freeze gate-prereg: OpenTimestamps stamp of PREREG.md (spec 8.4)']);
    const head = fx.git(['rev-parse', 'HEAD']);
    const r = fx.freeze('gate-prereg');
    expect(r.code, r.out).toBe(0);
    expect(fx.otsCalls()).toEqual([]);
    expect(fx.git(['rev-parse', 'gate-prereg^{commit}'], fx.remote)).toBe(head);
    expect(fx.git(['rev-parse', 'main'], fx.remote)).toBe(head);
  });

  it('refuses a tag that is on the remote at another commit', () => {
    fx.git(['tag', '-a', '-m', 'early', 'gate-prereg']);
    fx.git(['push', '--quiet', 'origin', 'refs/tags/gate-prereg']);
    fx.git(['tag', '-d', 'gate-prereg']);
    const r = fx.freeze('gate-prereg');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/already on origin .*tags never move/);
    expect(fx.otsCalls()).toEqual([]);
  });
});

describe('the same path for gate-retune and freeze-1', () => {
  function tunedParams(step: 'stage_a' | 'retune', k = 3.0): string {
    const p = buildGatePreregParams(DOCTOR).params as unknown as Record<string, Record<string, unknown>>;
    return frozenParamsText({
      ...p,
      d1: { ...p['d1'], k },
      g: { ...p['g'], theta_G: 0.0275 },
      tuned: { k: { step, criterion_met: true, rehearsal_step_up: false }, theta_G: { step } },
    });
  }

  const SCORING_RULES = `${JSON.stringify({
    catch_open_after_span_start_ms: 200,
    catch_close_after_span_end_ms: 5000,
    late_close_after_span_end_ms: 12000,
    objection_merge_gap_ms: 1000,
    min_voiced_ms: 250,
    min_gap_ms: 4000,
    W_ms: 1500,
  })}\n`;

  function writeManifest(over: Record<string, unknown> = {}): void {
    const manifest = {
      ...exampleFreezeManifest(),
      prereg_sha256: sha(fx.read('PREREG.md')),
      params_sha256: sha(fx.read('params/frozen.json')),
      scoring_rules_sha256: existsSync(join(fx.work, 'scoring_rules.json')) ? sha(fx.read('scoring_rules.json')) : sha('none'),
      ...over,
    };
    fx.write('freeze_manifest.json', `${JSON.stringify(manifest)}\n`);
  }

  function freezeGatePrereg(): void {
    const r = fx.freeze('gate-prereg');
    expect(r.code, r.out).toBe(0);
  }

  it('gate-retune stamps params/retune.json, a copy of the tuned params/frozen.json', () => {
    fx.write('params/frozen.json', tunedParams('retune'));
    fx.write('params/retune.json', `${JSON.stringify(JSON.parse(tunedParams('retune')), null, 2)}\n`);
    fx.commitAll('bounded retune');
    const r = fx.freeze('gate-retune');
    expect(r.code, r.out).toBe(0);
    expect(fx.otsCalls()).toEqual([['stamp', 'params/retune.json']]);
    const head = fx.git(['rev-parse', 'HEAD']);
    expect(fx.git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).toBe('params/retune.json.ots');
    expect(fx.git(['rev-parse', 'gate-retune^{commit}'], fx.remote)).toBe(head);
    const message = fx.git(['for-each-ref', '--format=%(contents)', 'refs/tags/gate-retune']);
    expect(message).toContain(`${sha(fx.read('params/retune.json'))}  params/retune.json`);
    expect(r.out).toContain('Publish this SHA-256 of params/retune.json before you record the next pack.');
    expect(r.out).toMatch(/Note: no gate-prereg tag on origin or in this clone: PREREG\.md was not compared/);
  });

  it('gate-retune refuses a copy that differs from params/frozen.json', () => {
    fx.write('params/frozen.json', tunedParams('retune'));
    fx.write('params/retune.json', tunedParams('stage_a'));
    fx.commitAll('mismatched copy');
    const r = fx.freeze('gate-retune');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/params\/retune\.json must be a copy of params\/frozen\.json/);
    expect(fx.otsCalls()).toEqual([]);
  });

  it('gate-retune refuses a PREREG.md edited after gate-prereg, and another voice detector (spec 7.12, 13.6)', () => {
    freezeGatePrereg();
    const tagged = sha(fx.read('PREREG.md'));
    fx.write('PREREG.md', `${fx.read('PREREG.md').toString('utf8')}\nA rule added after the tag.\n`);
    const p = JSON.parse(tunedParams('retune')) as Record<string, Record<string, unknown>>;
    const moved = frozenParamsText({ ...p, vad: { ...p['vad'], periodicity: 0.6 } });
    fx.write('params/frozen.json', moved);
    fx.write('params/retune.json', moved);
    fx.commitAll('retune with an edited PREREG.md');
    const r = fx.freeze('gate-retune', '--check');
    expect(r.code).toBe(1);
    expect(r.out).toContain(`PREREG.md changed after the tag gate-prereg: SHA-256 ${sha(fx.read('PREREG.md'))} now, ${tagged} under the tag`);
    expect(r.out).toMatch(/the vad block of params\/frozen\.json differs from its copy under gate-prereg/);
    expect(r.out).toMatch(/FREEZE NOT READY gate-retune/);
  });

  it('freeze-1 checks the hashes freeze_manifest.json lists, scoring_rules.json among them', () => {
    fx.write('params/frozen.json', tunedParams('stage_a'));
    fx.write('scoring_rules.json', SCORING_RULES);
    writeManifest();
    fx.commitAll('freeze manifest');
    const ready = fx.freeze('freeze-1', '--check');
    expect(ready.code, ready.out).toBe(0);
    expect(ready.out).toContain(`${sha(SCORING_RULES)}  scoring_rules.json`);
    expect(ready.out).toMatch(/Note: prompts_sha256 is taken from freeze_manifest\.json as listed/);

    writeManifest({ params_sha256: sha('old params'), scoring_rules_sha256: sha('old rules') });
    fx.commitAll('stale manifest');
    const stale = fx.freeze('freeze-1', '--check');
    expect(stale.code).toBe(1);
    expect(stale.out).toMatch(/params_sha256 of freeze_manifest\.json is [0-9a-f]{64}, not the SHA-256 of params\/frozen\.json/);
    expect(stale.out).toMatch(/scoring_rules_sha256 of freeze_manifest\.json is [0-9a-f]{64}, not the SHA-256 of scoring_rules\.json/);
  });

  it('freeze-1 refuses a missing or invalid scoring_rules.json', () => {
    fx.write('params/frozen.json', tunedParams('stage_a'));
    writeManifest();
    fx.commitAll('no scoring rules');
    expect(fx.freeze('freeze-1', '--check').out).toMatch(/scoring_rules\.json does not exist/);
    fx.write('scoring_rules.json', SCORING_RULES.replace('"W_ms":1500', '"W_ms":1000'));
    writeManifest();
    fx.commitAll('bad scoring rules');
    const r = fx.freeze('freeze-1', '--check');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/scoring_rules\.json: .*W_ms/);
  });

  it('freeze-1 refuses PREREG.md edited after gate-prereg and retune.json edited after gate-retune', () => {
    freezeGatePrereg();
    fx.write('params/frozen.json', tunedParams('retune'));
    fx.write('params/retune.json', tunedParams('retune'));
    fx.commitAll('bounded retune');
    expect(fx.freeze('gate-retune').code).toBe(0);
    const retuneTagged = sha(fx.read('params/retune.json'));

    fx.write('PREREG.md', `${fx.read('PREREG.md').toString('utf8')}\nEdited.\n`);
    fx.write('params/frozen.json', tunedParams('retune', 3.5));
    fx.write('params/retune.json', tunedParams('retune', 3.5));
    fx.write('scoring_rules.json', SCORING_RULES);
    writeManifest();
    fx.commitAll('manifest over edited files');
    const r = fx.freeze('freeze-1', '--check');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/PREREG\.md changed after the tag gate-prereg: SHA-256 [0-9a-f]{64} now, [0-9a-f]{64} under the tag/);
    expect(r.out).toContain(`params/retune.json changed after the tag gate-retune: SHA-256 ${sha(fx.read('params/retune.json'))} now, ${retuneTagged} under the tag`);
  });
});

describe('PREREG.md against params/frozen.json and git (unit)', () => {
  const view = (o: { commits?: Record<string, string>; ancestor?: boolean; changed?: string[] }): RepoView => ({
    dir: '/nowhere',
    head: 'f'.repeat(40),
    tagCommit: () => null,
    blobAt: () => null,
    resolveCommit: (n) => o.commits?.[n] ?? null,
    isAncestor: () => o.ancestor ?? true,
    changedPaths: () => o.changed ?? ['PREREG.md'],
  });
  const app = 'a'.repeat(40);

  it('APP_COMMIT: one commit, earlier than HEAD, which differs from it only in PREREG.md and its stamp', () => {
    const text = (name: string): string => `differs from \`${name}\` only in PREREG.md; at \`${name}\` the code`;
    expect(appCommitProblems(text('abc1234'), view({ commits: { abc1234: app } }))).toEqual([]);
    expect(appCommitProblems(text('abc1234'), view({ commits: { abc1234: app }, changed: ['PREREG.md', 'PREREG.md.ots'] }))).toEqual([]);
    expect(appCommitProblems(text('abc1234'), view({ commits: { abc1234: app }, ancestor: false }))[0]).toMatch(/is not an earlier commit of HEAD/);
    expect(appCommitProblems(`\`abc1234\` and \`def5678\``, view({ commits: { abc1234: app, def5678: 'b'.repeat(40) } }))[0]).toMatch(/names 2 commits \(abc1234, def5678\)/);
    expect(appCommitProblems(text('abc1234'), view({}))[0]).toMatch(/names no commit/);
    expect(appCommitProblems(text('abc1234'), view({ commits: { abc1234: app }, changed: ['PREREG.md', 'params/frozen.json'] }))[0]).toMatch(/in params\/frozen\.json, not only in PREREG\.md/);
  });

  it('voice detector rows match to the precision doctor prints', () => {
    const frozen = { vad: { floor_db: -60.5, periodicity: 0.55 } };
    expect(vadAgreementProblems(preregText({ floor: '-60.46', periodicity: '0.55' }), frozen)).toEqual([]);
    expect(vadAgreementProblems(preregText({ floor: '−60.5', periodicity: '0.554' }), frozen)).toEqual([]);
    expect(vadAgreementProblems(preregText({ floor: '-60.6', periodicity: '0.55' }), frozen)).toHaveLength(1);
    expect(vadAgreementProblems(preregText({ floor: '-60.5', periodicity: '0.56' }), frozen)).toHaveLength(1);
    // A placeholder is reported by the placeholder check, not here.
    expect(vadAgreementProblems(preregText({ floor: '{{VAD_FLOOR_DB}}', periodicity: '{{VAD_PERIODICITY}}' }), frozen)).toEqual([]);
  });
});

describe('ots helpers', () => {
  it('takes the command from the environment as JSON or words', () => {
    expect(otsCommand({})).toEqual(['uvx', '--from', 'opentimestamps-client', 'ots']);
    expect(otsCommand({ [OTS_ENV]: '["/usr/bin/node", "/a b/stub.mjs"]' })).toEqual(['/usr/bin/node', '/a b/stub.mjs']);
    expect(otsCommand({ [OTS_ENV]: ' ots  --no-cache ' })).toEqual(['ots', '--no-cache']);
    expect(() => otsCommand({ [OTS_ENV]: '[1]' })).toThrow(/JSON array/);
  });

  it('accepts only a proof of exactly the stamped bytes', () => {
    const file = new TextEncoder().encode('rules\n');
    const digest = createHash('sha256').update(file).digest();
    const proof = Uint8Array.from([...OTS_MAGIC, 0x01, 0x08, ...digest, 0xf0]);
    expect(OTS_MAGIC).toHaveLength(31);
    expect(otsProofProblem(proof, file)).toBeNull();
    expect(otsProofProblem(proof, new TextEncoder().encode('rules, edited\n'))).toMatch(/other bytes/);
    expect(otsProofProblem(new TextEncoder().encode('not a proof at all, just some text of some length'), file)).toMatch(/not an OpenTimestamps proof/);
  });
});

describe('tag message', () => {
  it('has the title, one sha256sum-style line per hash and the .ots note', () => {
    const msg = tagMessage(TAG_SPECS['gate-prereg'], [
      { hash: 'a'.repeat(64), what: 'PREREG.md' },
      { hash: 'b'.repeat(64), what: 'gate/pack-A/cues.json' },
    ]);
    expect(msg.split('\n')).toEqual([
      'gate-prereg: rules and parameters fixed before the day-1 gate recording (spec 8.4)',
      '',
      'SHA-256:',
      `${'a'.repeat(64)}  PREREG.md`,
      `${'b'.repeat(64)}  gate/pack-A/cues.json`,
      '',
      'PREREG.md.ots holds the OpenTimestamps stamp of PREREG.md.',
      '',
    ]);
  });

  it('compares JSON values without regard to key order', () => {
    expect(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
  });
});
