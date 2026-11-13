// The blind label page in Chromium (spec 4.5, 7.6, 8.1, 9.5): `label` serves a synthetic gate
// recording with four cues: a cough 8.5 s after dot 1, nothing after dot 2, a reply 6 s after dot 3
// and one 1.2 s after dot 4. The test marks each sound by clicking the pictures (the whole window,
// the 1 s view, the 20 ms view, then single samples with the arrow keys), picks the kind by
// clicking, answers "No reply" for dot 2, and checks onsets.json, clock_report.json and the ledger.
// On the way: no page without the token, a reload keeps the saved marks, Back revisits one.
// Run: PW_CHROMIUM_PATH=<chrome> npx playwright test tests/e2e/label.spec.ts

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { readLedger } from '../../analysis/clocks/ledger-io.ts';
import { EXIT_OK, NO_EVENT_NOTE, ORDER_NOTE, runLabel, type LabelRun } from '../../analysis/label.ts';
import { makeGateFolder, withVoices } from '../../analysis/label/fixture.ts';
import { labelsSha256, onsetsAcceptLabelOrder, onsetsLabelsSha256, shuffledOrder, windowSamples, type LabelMark } from '../../analysis/label/marks.ts';
import type { LabelServer } from '../../analysis/label/server.ts';
import { sha256Hex } from '../../analysis/lib/ledger.ts';
import { loadSession } from '../../analysis/lib/session.ts';
import { validateClockReport, validateOnsets, verifyLedger, type ClockReport, type OnsetLabel, type Onsets } from '../../core/schemas/index.ts';

test.use({ launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH || undefined } });

const R = 48_000;
const MS = R / 1000;
const W = windowSamples(R);
/** Half width of the zoom view (label.js ZOOM_HALF_MS = 20). */
const ZOOM_HALF = 20 * MS;
const SEED = 1234;
const IDS = ['o01', 'o02', 'o03', 'o04'];
/** What the person hears after each dot: a sound (seconds after the dot, its kind) or nothing. */
const HEARD: Record<string, { afterS: number; label: OnsetLabel } | null> = {
  o01: { afterS: 8.5, label: 'cough' },
  o02: null,
  o03: { afterS: 6, label: 'speech' },
  o04: { afterS: 1.2, label: 'speech' },
};

const readJson = <T>(dir: string, name: string): T => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as T;

async function shownOffset(page: Page): Promise<number> {
  const v = await page.locator('#readout').getAttribute('data-offset');
  if (v === null) throw new Error('the page shows no mark');
  return Number(v);
}

/**
 * Places the mark on sample `target` of the shown window: a click on the whole window, a click on
 * the 1 s view around that mark, a click on the zoom view (20 ms each side of the mark), then
 * single samples with the arrow keys.
 */
async function markSample(page: Page, target: number): Promise<void> {
  const overview = page.locator('#overview');
  const ob = await overview.boundingBox();
  if (ob === null) throw new Error('no overview picture');
  await overview.click({ position: { x: ((target + 0.5) / W.length) * ob.width, y: 60 } });
  await expect(page.locator('#readout')).toHaveAttribute('data-offset', /^\d+$/);
  const detail = page.locator('#detail');
  await expect(detail).toHaveAttribute('data-span', String(R));
  const from = Number(await detail.getAttribute('data-from'));
  expect(target).toBeGreaterThanOrEqual(from);
  expect(target).toBeLessThan(from + R);
  const db = await detail.boundingBox();
  if (db === null) throw new Error('no detail picture');
  await detail.click({ position: { x: ((target - from + 0.5) / R) * db.width, y: 50 } });
  let mark = await shownOffset(page);
  expect(Math.abs(target - mark)).toBeLessThan(ZOOM_HALF);
  const zoom = page.locator('#zoom');
  const zb = await zoom.boundingBox();
  if (zb === null) throw new Error('no zoom picture');
  await zoom.click({ position: { x: ((target - mark + ZOOM_HALF + 0.5) / (2 * ZOOM_HALF)) * zb.width, y: 60 } });
  mark = await shownOffset(page);
  for (let d = target - mark; d !== 0; d -= Math.sign(d)) await page.keyboard.press(d > 0 ? 'ArrowRight' : 'ArrowLeft');
  await expect(page.locator('#readout')).toHaveAttribute('data-offset', String(target));
}

test('labels a late reply, a late cough and a silent cue by clicking, and writes onsets.json', async ({ page }) => {
  test.setTimeout(180_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'label-e2e-'));
  const stop = new AbortController();
  let run: Promise<LabelRun> | null = null;
  try {
    const { dir, truth } = makeGateFolder(root, {
      id: 'gate-e2e',
      narrationS: 80,
      replies: 4,
      edit: (data, t) =>
        withVoices(
          data,
          t,
          IDS.flatMap((id, k) => {
            const h = HEARD[id];
            return h ? [{ at: Math.round(t.cues[k]! + h.afterS * R), durS: 0.8 }] : [];
          }),
        ),
    });
    /** The true first sound after the dot of an item, as an offset in its window; null: none. */
    const targetOf = (id: string): number | null => {
      const h = HEARD[id];
      return h ? Math.round(h.afterS * R) + W.before : null;
    };
    const kindOf = (id: string): string => HEARD[id]?.label ?? 'none';

    let serverUp!: (s: LabelServer) => void;
    const up = new Promise<LabelServer>((resolve) => (serverUp = resolve));
    run = runLabel(
      loadSession(dir),
      {},
      {
        out: () => undefined,
        now: () => new Date('2026-11-13T19:00:00Z'),
        commit: () => 'abc1234',
        seed: () => SEED,
        openPage: null,
        onServer: (s) => serverUp(s),
        signal: stop.signal,
      },
    );
    const server = await Promise.race([
      up,
      run.then((r) => {
        throw new Error(`label ended before the page opened: ${r.refused ?? r.lines.join(' / ')}`);
      }),
    ]);

    // The automatic search found voice after dots 1, 3 and 4; the page shows all four cues.
    const auto = readJson<Onsets>(dir, 'onsets.json');
    expect(auto.events.map((e) => e.id)).toEqual(['o01', 'o03', 'o04']);
    const order = shuffledOrder(IDS, SEED);

    // No token, no page.
    const base = `http://127.0.0.1:${server.port}/`;
    const bare = await page.goto(base);
    expect(bare?.status()).toBe(403);
    expect(await page.locator('body').innerText()).toContain('Forbidden');

    const pageErrors: string[] = [];
    const paths: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(`${m.text()} (${m.location().url})`);
    });
    page.on('request', (r) => paths.push(new URL(r.url()).pathname));

    await page.goto(server.url);
    const counter = page.locator('#counter');
    const readout = page.locator('#readout');
    const status = page.locator('#status');

    /** Marks the shown item as the person would and saves it. */
    const label = async (id: string): Promise<void> => {
      const target = targetOf(id);
      if (target !== null) await markSample(page, target);
      await page.locator(`#kind-${kindOf(id)}`).click();
      await expect(page.locator(`#kind-${kindOf(id)}`)).toHaveAttribute('aria-checked', 'true');
      await page.locator('#save').click();
    };

    // ---- item 1: saving needs a kind first ----
    await expect(counter).toHaveText(/^Event 1 of 4 · 0 saved$/);
    await expect(readout).toHaveText('No mark yet');
    await page.locator('#save').click();
    await expect(status).toHaveText('Pick the kind of sound, or No reply.');
    await label(order[0]!);
    await expect(counter).toHaveText(/^Event 2 of 4 · 1 saved$/);

    // ---- a reload (the cookie, no token in the address) comes back to the first unmarked item ----
    await page.goto(base);
    await expect(counter).toHaveText(/^Event 2 of 4 · 1 saved$/);
    await expect(readout).toHaveText('No mark yet');

    // ---- item 2 ----
    await label(order[1]!);
    await expect(counter).toHaveText(/^Event 3 of 4 · 2 saved$/);

    // ---- Back shows item 2 as saved; saving it again goes on to item 3 ----
    await page.locator('#back').click();
    await expect(counter).toHaveText(/^Event 2 of 4 · 2 saved$/);
    await expect(status).toHaveText('This event is saved; a new mark replaces it.');
    const second = targetOf(order[1]!);
    if (second === null) await expect(readout).toHaveText('No mark yet');
    else await expect(readout).toHaveAttribute('data-offset', String(second));
    await expect(page.locator(`#kind-${kindOf(order[1]!)}`)).toHaveAttribute('aria-checked', 'true');
    await page.locator('#save').click();
    await expect(counter).toHaveText(/^Event 3 of 4 · 2 saved$/);

    // ---- items 3 and 4 ----
    await label(order[2]!);
    await expect(counter).toHaveText(/^Event 4 of 4 · 3 saved$/);
    await label(order[3]!);
    await expect(page.locator('#done')).toBeVisible();
    await expect(page.locator('#done-message')).toHaveText('4 mark(s) saved; their hash is in the ledger.');

    const result = await run;
    expect(result.code).toBe(EXIT_OK);

    // ---- onsets.json: blind hand marks on the exact samples, the labels, a hash it gives again ----
    const onsets = readJson<Onsets>(dir, 'onsets.json');
    expect(validateOnsets(onsets)).toEqual([]);
    const marks: LabelMark[] = auto.events.map((e) => {
      const k = IDS.indexOf(e.id);
      return { id: e.id, label: HEARD[e.id]!.label, n_v: truth.cues[k]! + Math.round(HEARD[e.id]!.afterS * R) };
    });
    expect(onsets.labels_sha256).toBe(labelsSha256(marks, sha256Hex));
    expect(onsetsLabelsSha256(onsets, sha256Hex)).toBe(onsets.labels_sha256);
    for (const e of onsets.events) {
      const m = marks.find((x) => x.id === e.id)!;
      expect(e.label).toBe(m.label);
      expect(e.manual).toEqual({ n_v: m.n_v, blind: true });
      expect(Math.abs(e.auto.n_v - m.n_v!)).toBeLessThanOrEqual(5 * MS);
    }

    // ---- clock_report.json: the onset error over the two speech replies ----
    const report = readJson<ClockReport>(dir, 'clock_report.json');
    expect(validateClockReport(report)).toEqual([]);
    expect(report.onset?.events).toBe(2);
    expect(report.onset?.p90_abs_auto_minus_manual_ms).toBeLessThanOrEqual(5);

    // ---- the ledger ends with onsets, (the order note,) the note on dot 2, label ----
    const ledger = readLedger(dir, 'gate');
    expect(verifyLedger(ledger.lines, sha256Hex, { kind: 'gate' }).ok).toBe(true);
    const steps = ledger.records.map((r) => (r.step === 'note' ? `note:${r.what}` : r.step));
    const tail = ['onsets', ...(onsetsAcceptLabelOrder() ? [] : [`note:${ORDER_NOTE}`]), `note:${NO_EVENT_NOTE}`, 'label'];
    expect(steps.slice(-tail.length)).toEqual(tail);
    expect(steps.slice(0, 3)).toEqual(['record', 'quickcheck', 'clocks']);
    const note = ledger.records.find((r) => r.step === 'note' && r.what === NO_EVENT_NOTE) as { detail?: string };
    expect(note.detail).toBe('blind marks of cues the automatic search found no voice for: o02 no reply');

    // ---- the page asked for nothing but its files, the windows and the marks ----
    const allowed = /^\/(label\.js|label\.css|favicon\.ico|api\/state|api\/audio\/[0-3]|api\/mark|api\/finish)?$/;
    expect(paths.filter((p) => !allowed.test(p))).toEqual([]);
    expect(paths).toContain('/api/finish');
    expect(pageErrors).toEqual([]);
  } finally {
    stop.abort();
    if (run) await run.catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
