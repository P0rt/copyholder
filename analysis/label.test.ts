// label (spec 4.2, 4.5, 7.6, 8.1, 8.5, 9.5): automatic onsets against the generator truth, the
// blind marks and their hash, the page server's token and save rules, the run lock, onsets.json and
// the ledger order (label after clocks, the labels hash in the ledger before stage_a can join any
// detector answer), every cue on the page, and the exploratory rule.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionData } from '../core/clock/index.ts';
import { computeFeatures, resolveOnsetConfig, type OnsetConfig } from '../core/onset/index.ts';
import {
  canAppendStep,
  validateClockReport,
  validateOnsets,
  verifyLedger,
  type ClockReport,
  type LedgerLine,
  type Manifest,
  type OnsetEvent,
  type OnsetLabel,
  type Onsets,
} from '../core/schemas/index.ts';
import { makeSyntheticSession } from '../tests/synthetic/session.ts';
import { runClocks } from './clocks.ts';
import { readLedger } from './clocks/ledger-io.ts';
import { EXIT_OK, EXIT_REFUSED, EXIT_STOPPED, EXPLORATORY_NOTE, NO_EVENT_NOTE, ORDER_NOTE, runLabel, type LabelDeps, type LabelRun } from './label.ts';
import { chromeOpenArgs } from './label/chrome.ts';
import { makeGateFolder, withCleanReplies, withVoices, type GateFolder } from './label/fixture.ts';
import { CUE_SEARCH_MS, cueEventId, gateCues, gateOnsetEvents, noDipCount, previousReplyEnd, replyKind } from './label/gate-onsets.ts';
import { checkRequest } from './label/guard.ts';
import { LOCK_FILE, acquireLabelLock, processAlive } from './label/lock.ts';
import {
  NO_REPLY,
  NO_REPLY_LABEL,
  SOFT_FIRST_SOUND_MIN_LEAD_MS,
  WINDOW_AFTER_MS,
  WINDOW_BEFORE_MS,
  applyMarks,
  isSoftFirstSound,
  labelsSha256,
  markFromPage,
  marksText,
  onsetErrorBlock,
  onsetsAcceptLabelOrder,
  onsetsLabelsSha256,
  pageMarkOf,
  shuffledOrder,
  splitMarks,
  windowSamples,
  withLabelOrder,
  type LabelItem,
  type LabelMark,
} from './label/marks.ts';
import { startLabelServer, type LabelServer } from './label/server.ts';
import { channel0Window } from './label/window.ts';
import { inMemorySession, writeSessionFolder } from './lib/fixtures.ts';
import { appendLedgerStep, sha256Hex } from './lib/ledger.ts';
import { loadSession } from './lib/session.ts';
import { gateSteps } from './lib/steps.ts';

const R = 48_000;
const MS = R / 1000;
const W = windowSamples(R);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'label-test-'));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const GATE = gateSteps('A');
const SEED = 42;
const IDS3 = ['o01', 'o02', 'o03'];

function gateManifest(data: SessionData): Manifest {
  return { schema: 'session/1', id: 'gate-a', kind: 'gate', pack: 'A', scenario: 'gate-A', audio: { settings: data.micSettings } } as unknown as Manifest;
}

const eventsOf = (data: SessionData): ReturnType<typeof gateOnsetEvents> => gateOnsetEvents(inMemorySession(data, gateManifest(data)), GATE);

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** A raw HTTP request to the label server, with every header under the test's control. */
function request(port: number, pathName: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathName, method: o.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...o.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** Opens the page as Chrome would and returns the cookie header to send afterwards. */
async function pageCookie(server: LabelServer): Promise<string> {
  const first = await request(server.port, `/?token=${server.token}`);
  expect(first.status).toBe(200);
  const set = first.headers['set-cookie']?.[0];
  if (!set) throw new Error('no cookie');
  return set.split(';')[0]!;
}

async function postJson(server: LabelServer, cookie: string, route: string, body: unknown): Promise<Answer> {
  return request(server.port, route, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: `http://127.0.0.1:${server.port}` },
    body: JSON.stringify(body),
  });
}

const jsonOf = <T = Record<string, unknown>>(a: Answer): T => JSON.parse(a.body.toString('utf8')) as T;

async function pageState(server: LabelServer, cookie: string): Promise<Record<string, unknown>> {
  return jsonOf(await request(server.port, '/api/state', { headers: { cookie } }));
}

/** What the page posts for one item: a sound type ("none" for no reply) and the offset in its window. */
interface PageMark {
  label: string;
  offset: number | null;
}

/**
 * Marks every item over HTTP as the page would, then finishes: `choose` gets the item id (the
 * test knows the order from the seed and the ids of the items in cue order).
 */
function driver(choose: (id: string) => PageMark, seed: number, ids: readonly string[]) {
  return (server: LabelServer): void => {
    void (async () => {
      const cookie = await pageCookie(server);
      const state = await pageState(server, cookie);
      const order = shuffledOrder(ids, seed);
      expect(state['count']).toBe(order.length);
      for (let pos = 0; pos < order.length; pos++) {
        const r = await postJson(server, cookie, '/api/mark', { pos, ...choose(order[pos]!) });
        if (r.status !== 200) throw new Error(`mark ${pos}: ${r.status} ${r.body.toString('utf8')}`);
      }
      await postJson(server, cookie, '/api/finish', {});
    })().catch((e: unknown) => {
      throw e;
    });
  };
}

/** Window offset of sample n on the page item of cue k (1-based). */
const offsetAt = (folder: Pick<GateFolder, 'truth'>, k: number, n: number): number => n - (folder.truth.cues[k - 1]! - W.before);

/** Speech on the generator's true onset of every reply. */
const truthChoice =
  (folder: Pick<GateFolder, 'truth'>) =>
  (id: string): PageMark => {
    const k = Number(id.slice(1));
    return { label: 'speech', offset: offsetAt(folder, k, folder.truth.voiceOnsets[k - 1]!) };
  };

const onsetsOf = (dir: string): Onsets => JSON.parse(fs.readFileSync(path.join(dir, 'onsets.json'), 'utf8')) as Onsets;
const reportOf = (dir: string): ClockReport => JSON.parse(fs.readFileSync(path.join(dir, 'clock_report.json'), 'utf8')) as ClockReport;
const fileText = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), 'utf8');
const deps = (extra: Partial<LabelDeps> = {}): LabelDeps => ({
  out: () => undefined,
  now: () => new Date('2026-11-13T18:30:00Z'),
  commit: () => 'abc1234',
  seed: () => SEED,
  openPage: null,
  ...extra,
});

const stepName = (r: LedgerLine): string => (r.step === 'note' ? `note:${r.what}` : r.step);
/** Ledger lines one confirmatory label run adds: the order note stands before `label` while onsets.json cannot hold the order. */
const labelTail = (...notes: string[]): string[] => [
  'onsets',
  ...(onsetsAcceptLabelOrder() ? [] : [`note:${ORDER_NOTE}`]),
  ...notes.map((n) => `note:${n}`),
  'label',
];
const stepsSince = (dir: string, from: number): string[] => readLedger(dir, 'gate').records.slice(from).map(stepName);

// ---- automatic onsets ------------------------------------------------------------------------------

/** Generator replies (tests/synthetic signals.ts addVoiceReply) open with a 15 ms raised-cosine attack. */
const GENERATOR_ATTACK_S = 0.015;

/**
 * The truth for t_v of a reply without a sharp start: where the generator's 15 ms attack crosses
 * the walk-back threshold of spec 7.6. The end of the first energy window whose power, the reply's
 * steady band power (60-160 ms after its start) times the mean squared attack envelope over the
 * window plus the floor, reaches the event's threshold N + max(6 dB, 3 s_N). A sample number.
 */
function attackCrossingSample(ch0: Float32Array, nT: number, floorDb: number, thresholdDb: number, cfg: OnsetConfig): number {
  const track = computeFeatures(ch0, 0, nT + 60 * MS, nT + 160 * MS, cfg);
  let p = 0;
  for (let k = 0; k < track.count; k++) p += 10 ** (track.energyDb[k]! / 10);
  const pFloor = 10 ** (floorDb / 10);
  const pVoice = Math.max(0, p / track.count - pFloor);
  const env2 = (n: number): number => {
    const t = n / R;
    if (t <= 0) return 0;
    if (t >= GENERATOR_ATTACK_S) return 1;
    return (0.5 - 0.5 * Math.cos((Math.PI * t) / GENERATOR_ATTACK_S)) ** 2;
  };
  for (let end = 1; end < 30 * MS; end++) {
    let s = 0;
    for (let n = end - cfg.winE; n < end; n++) s += env2(n);
    if (10 * Math.log10((pVoice * s) / cfg.winE + pFloor) >= thresholdDb) return nT + end;
  }
  return Number.NaN;
}

describe('automatic onsets of the gate (ledger step onsets)', () => {
  const made = makeSyntheticSession({ scenario: 'gate', narrationS: 24, replies: 3, seed: 5 });

  it('match the generator truth within 5 ms on clean replies', () => {
    for (const seed of [5, 8]) {
      const m = seed === 5 ? made : makeSyntheticSession({ scenario: 'gate', narrationS: 24, replies: 3, seed });
      const r = eventsOf(withCleanReplies(m.session, m.truth, seed));
      expect(r.events).toHaveLength(3);
      r.events.forEach((e, i) => {
        expect(Math.abs(e.auto.n_v - m.truth.voiceOnsets[i]!)).toBeLessThanOrEqual(5 * MS);
        expect(e.auto.n_v).toBeLessThanOrEqual(e.auto.n_a);
        expect(e).toMatchObject({ id: cueEventId(i + 1), cue: i + 1, label: null, manual: null });
        expect(e.voiced_ms).toBeGreaterThan(600);
      });
      // Replies 4 s apart end 3.2 s before the next one begins: continuations (spec 4.2).
      expect(r.events.map((e) => e.kind)).toEqual(['objection', 'continuation', 'continuation']);
      expect(validateOnsets({ schema: 'onsets/1', labels_sha256: null, events: r.events })).toEqual([]);
    }
  });

  it('replies more than 4 s after the previous one are objections', () => {
    const m = makeSyntheticSession({ scenario: 'gate', narrationS: 40, replies: 3, seed: 6 });
    const r = eventsOf(withCleanReplies(m.session, m.truth, 6));
    expect(r.events.map((e) => e.kind)).toEqual(['objection', 'objection', 'objection']);
  });

  it("land within 5 ms of where the generator's 15 ms attack crosses the walk-back threshold", () => {
    const cfg = resolveOnsetConfig();
    for (const seed of [5, 7, 9]) {
      const m = seed === 5 ? made : makeSyntheticSession({ scenario: 'gate', narrationS: 24, replies: 3, seed });
      const r = eventsOf(m.session);
      expect(r.events).toHaveLength(3);
      r.cues.forEach((c, i) => {
        const nT = m.truth.voiceOnsets[i]!;
        const cross = attackCrossingSample(m.session.ch0, nT, c.onset!.floorDb, c.onset!.thresholdDb, cfg);
        // The crossing lies inside the attack ...
        expect(cross - nT).toBeGreaterThan(0);
        expect(cross - nT).toBeLessThan(GENERATOR_ATTACK_S * R);
        // ... and the reference finds it within the 5 ms of spec 7.6.
        expect(Math.abs(c.event!.auto.n_v - cross)).toBeLessThanOrEqual(5 * MS);
      });
    }
  });

  it('search once from each cue: a cue with no voice within 10 s gives no event', () => {
    const extra = made.truth.listeningEnd! - 8 * R;
    const stamps = [...made.session.stamps, { n: extra, k: 'mark', what: 'cue', on: true }].sort((p, q) => p.n - q.n);
    const data = { ...made.session, stamps };
    const s = inMemorySession(data, gateManifest(data));
    expect(gateCues(s, GATE)).toHaveLength(4);
    const r = gateOnsetEvents(s, GATE);
    expect(r.cues).toHaveLength(4);
    expect(r.cues[0]!.event).toBeNull();
    expect(r.events.map((e) => e.cue)).toEqual([2, 3, 4]);
  });

  it('find replies up to 10 s after the dot, and the page window holds them (spec 4.5)', () => {
    const m = makeSyntheticSession({ scenario: 'gate', narrationS: 80, replies: 3, seed: 5 });
    const at = [1.2, 6, 8.5].map((s, i) => Math.round(m.truth.cues[i]! + s * R));
    const r = eventsOf(withVoices(m.session, m.truth, at.map((a) => ({ at: a, durS: 0.8 }))));
    expect(r.events.map((e) => e.id)).toEqual(IDS3);
    r.events.forEach((e, i) => {
      expect(Math.abs(e.auto.n_v - at[i]!)).toBeLessThanOrEqual(5 * MS);
      expect(e.kind).toBe('objection');
      // The blind page shows the whole search range: the true first sound is a mark it takes,
      // whatever the kind of sound.
      const item: LabelItem = { id: e.id, anchor: m.truth.cues[i]!, hasEvent: true };
      expect(markFromPage(item, { label: 'cough', offset: at[i]! - (item.anchor - W.before) }, R)).toEqual({ id: e.id, label: 'cough', n_v: at[i] });
    });
  });

  it('a reply that only paused at the dot began before it (spec 4.2, 4.5)', () => {
    const m = makeSyntheticSession({ scenario: 'gate', narrationS: 80, replies: 3, seed: 6 });
    const c = m.truth.cues;
    const early = Math.round(c[1]! - 0.7 * R);
    const r = eventsOf(
      withVoices(m.session, m.truth, [
        { at: Math.round(c[0]! + 1.2 * R), durS: 0.8 },
        // 0.6 s of voice that ends 0.1 s before dot 2, then voice again 0.4 s after it: one reply.
        { at: early, durS: 0.6 },
        { at: Math.round(c[1]! + 0.4 * R), durS: 0.8 },
        { at: Math.round(c[2]! + 1.2 * R), durS: 0.8 },
      ]),
    );
    expect(r.cues.map((x) => x.beganBeforeCue)).toEqual([false, true, false]);
    const o02 = r.cues[1]!.event!;
    expect(o02.auto.n_v).toBeLessThan(c[1]!);
    expect(Math.abs(o02.auto.n_v - early)).toBeLessThanOrEqual(5 * MS);
    expect(o02.n_end!).toBeGreaterThan(c[1]! + R);
    expect(validateOnsets({ schema: 'onsets/1', labels_sha256: null, events: r.events })).toEqual([]);
  });

  it('a remark between cues is the previous reply of the 4.0 s rule (spec 4.2)', () => {
    const m = makeSyntheticSession({ scenario: 'gate', narrationS: 40, replies: 3, seed: 6 });
    const v = m.truth.voiceOnsets;
    const replies = v.map((at) => ({ at, durS: 0.8 }));
    expect(eventsOf(withVoices(m.session, m.truth, replies)).events.map((e) => e.kind)).toEqual(['objection', 'objection', 'objection']);
    // 0.8 s that ends 2.5 s before the reply to cue 2.
    const remark = Math.round(v[1]! - 3.3 * R);
    const r = eventsOf(withVoices(m.session, m.truth, [...replies, { at: remark, durS: 0.8 }]));
    expect(r.events.map((e) => e.kind)).toEqual(['objection', 'continuation', 'objection']);
    expect(r.replies.some(([a, b]) => Math.abs(a - remark) <= 50 * MS && b < v[1]!)).toBe(true);
  });

  it("take the floor and the previous reply from channel 0 alone, not from Deck's voice edges (spec 7.6)", () => {
    const data = withCleanReplies(made.session, made.truth, 5);
    expect(data.stamps.some((s) => s.k === 'voice')).toBe(true);
    const base = eventsOf(data);
    const noEdges = eventsOf({ ...data, stamps: data.stamps.filter((s) => s.k !== 'voice') });
    const moved = eventsOf({ ...data, stamps: data.stamps.map((s) => (s.k === 'voice' ? { ...s, n: s.n - R } : s)).sort((p, q) => p.n - q.n) });
    expect(noEdges.events).toEqual(base.events);
    expect(moved.events).toEqual(base.events);
  });

  it('count the events flagged no_dip (spec 7.6: the number is printed)', () => {
    const e = (flags: string[]): Pick<OnsetEvent, 'auto'> => ({ auto: { n_v: 0, n_a: 0, breath: null, flags } });
    expect(noDipCount([e([]), e(['no_dip']), e(['no_dip']), e([])])).toBe(2);
    expect(noDipCount([])).toBe(0);
  });

  it('kinds follow spec 4.2; the previous reply is the last that ended before the start', () => {
    const reading = [[0, 100 * R]] as const;
    expect(replyKind(10 * R, 400, null, reading, R)).toBe('objection');
    expect(replyKind(10 * R, 200, null, reading, R)).toBe('other');
    expect(replyKind(120 * R, 400, null, reading, R)).toBe('other');
    expect(replyKind(10 * R, 400, 7 * R, reading, R)).toBe('continuation');
    expect(replyKind(10 * R, 400, 6 * R, reading, R)).toBe('objection');
    const replies = [
      [1 * R, 2 * R],
      [5 * R, 9 * R],
      [9.5 * R, 11 * R],
    ] as const;
    expect(previousReplyEnd(10 * R, replies)).toBe(9 * R);
    expect(previousReplyEnd(1.5 * R, replies)).toBeNull();
  });
});

// ---- marks ------------------------------------------------------------------------------------------

describe('blind marks', () => {
  const event = (id: string, nV: number, auto: Partial<OnsetEvent['auto']> = {}): OnsetEvent => ({
    id,
    kind: 'objection',
    label: null,
    voiced_ms: 600,
    floor_db: -60,
    auto: { n_v: nV, n_a: nV + 2000, breath: null, flags: [], ...auto },
    manual: null,
  });
  const onsets: Onsets = { schema: 'onsets/1', labels_sha256: null, events: [event('o01', 100_000), event('o02', 300_000), event('o03', 500_000)] };

  it('random order: a permutation fixed by the seed', () => {
    const ids = ['o01', 'o02', 'o03', 'o04', 'o05', 'o06'];
    const a = shuffledOrder(ids, 7);
    expect([...a].sort()).toEqual(ids);
    expect(shuffledOrder(ids, 7)).toEqual(a);
    expect(new Set([1, 2, 3, 4, 5].map((s) => shuffledOrder(ids, s).join(' '))).size).toBeGreaterThan(1);
  });

  it('the window runs from 1 s before the dot to past the 10 s search (spec 4.5)', () => {
    expect(WINDOW_BEFORE_MS).toBe(1000);
    expect(WINDOW_AFTER_MS).toBeGreaterThanOrEqual(CUE_SEARCH_MS + 500);
    expect(W).toEqual({ before: R, after: 11 * R, length: 12 * R });
  });

  it('a mark is a whole sample inside the window, or no reply', () => {
    const item: LabelItem = { id: 'o01', anchor: 10 * R, hasEvent: true };
    expect(markFromPage(item, { label: 'speech', offset: 1000 }, R)).toEqual({ id: 'o01', label: 'speech', n_v: 10 * R - W.before + 1000 });
    // 9 s after the dot: a late cough is marked like any other sound.
    expect(markFromPage(item, { label: 'cough', offset: W.before + 9 * R }, R)).toEqual({ id: 'o01', label: 'cough', n_v: 19 * R });
    expect(markFromPage(item, { label: 'speech', offset: W.length - 1 }, R)).toMatchObject({ n_v: 10 * R - W.before + W.length - 1 });
    // No reply: the non-speech label `other` without a first sound (spec 4.2: never an objection).
    expect(NO_REPLY_LABEL).toBe('other');
    expect(markFromPage(item, { label: NO_REPLY, offset: null }, R)).toEqual({ id: 'o01', label: 'other', n_v: null });
    const bad: Array<{ label: unknown; offset: unknown }> = [
      { label: 'speech', offset: 10.5 },
      { label: 'speech', offset: W.length },
      { label: 'speech', offset: -1 },
      { label: 'speech', offset: null },
      { label: 'yawn', offset: 5 },
      { label: null, offset: null },
      { label: NO_REPLY, offset: 5 },
    ];
    for (const body of bad) expect(typeof markFromPage(item, body, R)).toBe('string');
    expect(markFromPage({ id: 'o09', anchor: 100, hasEvent: true }, { label: 'speech', offset: 0 }, R)).toMatch(/before the recording/);
  });

  it('the page gets a saved mark back as it sent it', () => {
    const item: LabelItem = { id: 'o01', anchor: 10 * R, hasEvent: true };
    for (const body of [
      { label: 'speech', offset: 1234 },
      { label: 'throat', offset: W.before + 7 * R },
      { label: NO_REPLY, offset: null },
    ]) {
      const m = markFromPage(item, body, R);
      if (typeof m === 'string') throw new Error(m);
      expect(pageMarkOf(item, m, R)).toEqual(body);
    }
  });

  it('the labels hash covers the published marks only, so onsets.json alone gives it again (spec 8.1, 8.6)', () => {
    const marks: LabelMark[] = [
      { id: 'o02', label: 'speech', n_v: 299_000 },
      { id: 'o01', label: 'cough', n_v: 99_500 },
      { id: 'o03', label: 'other', n_v: null },
    ];
    const h = labelsSha256(marks, sha256Hex);
    expect(h).toBe(
      sha256Hex(
        JSON.stringify({
          schema: 'labels/2',
          marks: [
            { id: 'o01', label: 'cough', n_v: 99_500 },
            { id: 'o02', label: 'speech', n_v: 299_000 },
            { id: 'o03', label: 'other', n_v: null },
          ],
        }),
      ),
    );
    expect(labelsSha256([...marks].reverse(), sha256Hex)).toBe(h);
    expect(labelsSha256([{ ...marks[0]!, n_v: 299_001 }, marks[1]!, marks[2]!], sha256Hex)).not.toBe(h);
    expect(labelsSha256([marks[0]!, { ...marks[1]!, label: 'laugh' }, marks[2]!], sha256Hex)).not.toBe(h);
    // Anyone holding the published onsets.json gets the same hash: no seed, order or ledger needed.
    const published = JSON.parse(JSON.stringify(applyMarks(onsets, marks, h))) as Onsets;
    expect(published.labels_sha256).toBe(h);
    expect(onsetsLabelsSha256(published, sha256Hex)).toBe(h);
    expect(onsetsLabelsSha256(onsets, sha256Hex)).toBeNull();
  });

  it('onsets.json gets labels, blind hand marks and the hash; the report gets P90 and soft first sounds', () => {
    const lead = SOFT_FIRST_SOUND_MIN_LEAD_MS * MS;
    const five: Onsets = {
      ...onsets,
      events: [
        event('o01', 100_000), // a clear voiced attack: t_a 41.7 ms after t_v
        event('o02', 300_000, { flags: ['no_dip'] }), // inhale noise runs into the voice
        event('o03', 500_000, { n_a: 500_000 + lead }), // a breathy start 50 ms before t_a
        event('o04', 700_000),
        event('o05', 900_000),
      ],
    };
    const marks: LabelMark[] = [
      { id: 'o01', label: 'speech', n_v: 100_000 - 21 * MS }, // the hand mark alone 21 ms earlier: not soft
      { id: 'o02', label: 'speech', n_v: 300_000 - 5 * MS },
      { id: 'o03', label: 'speech', n_v: 500_000 + 2 * MS },
      { id: 'o04', label: 'laugh', n_v: 699_000 },
      { id: 'o05', label: 'other', n_v: null }, // no reply
    ];
    const final = applyMarks(five, marks, 'a'.repeat(64));
    expect(validateOnsets(final)).toEqual([]);
    expect(final.events.map((e) => e.manual)).toEqual(marks.map((m) => ({ n_v: m.n_v, blind: true })));
    expect(final.events.map((e) => e.label)).toEqual(['speech', 'speech', 'speech', 'laugh', 'other']);
    expect(final.events.map((e) => isSoftFirstSound(e, R))).toEqual([false, true, true, false, false]);
    // Speech with a hand mark: |d| = 21, 5 and 2 ms; type-7 P90 = 5 + 0.8 * 16 = 17.8 ms.
    expect(onsetErrorBlock(final, R)).toEqual({ p90_abs_auto_minus_manual_ms: 17.8, events: 3, soft_first_sounds: 2 });
    expect(() => applyMarks(five, marks.slice(0, 4), 'a'.repeat(64))).toThrow(/o05/);
    expect(() => applyMarks(five, [...marks, { id: 'o09', label: 'speech', n_v: 5 }], 'a'.repeat(64))).toThrow(/o09/);
  });

  it('splits off the marks of cues without an automatic event and writes them as words', () => {
    const items: LabelItem[] = [
      { id: 'o01', anchor: R, hasEvent: true },
      { id: 'o02', anchor: 20 * R, hasEvent: false },
      { id: 'o03', anchor: 40 * R, hasEvent: false },
    ];
    const marks: LabelMark[] = [
      { id: 'o03', label: 'other', n_v: null },
      { id: 'o01', label: 'speech', n_v: 2 * R },
      { id: 'o02', label: 'speech', n_v: 21 * R },
    ];
    const { eventMarks, withoutEvent } = splitMarks(items, marks);
    expect(eventMarks.map((m) => m.id)).toEqual(['o01']);
    expect(withoutEvent.map((m) => m.id)).toEqual(['o03', 'o02']);
    expect(marksText(withoutEvent)).toBe(`o02 speech n_v ${21 * R}; o03 no reply`);
    expect(() => splitMarks(items, [{ id: 'o07', label: 'speech', n_v: 1 }])).toThrow(/o07/);
  });

  it('puts the seed and the order into onsets.json only when its schema takes them', () => {
    const order = ['o03', 'o01', 'o02'];
    const withOrder = withLabelOrder(onsets, 77, order);
    if (onsetsAcceptLabelOrder()) {
      expect(withOrder).toMatchObject({ label_order: { seed: 77, order } });
      expect(validateOnsets(withOrder)).toEqual([]);
    } else {
      // core/schemas keeps onsets.json closed: the ledger note holds them (see the command test).
      expect(withOrder).toEqual(onsets);
      expect(validateOnsets({ ...onsets, label_order: { seed: 77, order } })).not.toEqual([]);
    }
  });
});

// ---- the page server --------------------------------------------------------------------------------

describe('label page server', () => {
  let server: LabelServer;
  let finished: LabelMark[] | null = null;
  const window0 = Float32Array.from({ length: W.length }, (_, i) => Math.sin(i / 10) * 0.1);
  beforeAll(async () => {
    server = await startLabelServer({
      items: [
        { id: 'o02', anchor: 20 * R, hasEvent: true },
        { id: 'o01', anchor: 10 * R, hasEvent: false },
      ],
      audio: () => window0,
      sampleRateHz: R,
      onFinish: (marks) => {
        finished = marks;
        return 'saved';
      },
    });
  });
  afterAll(async () => server.close());

  it('listens on 127.0.0.1 at a port the OS chose, with a 64-hex token in the address', () => {
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/?token=${server.token}`);
    expect(server.token).toMatch(/^[0-9a-f]{64}$/);
    expect(server.port).toBeGreaterThan(0);
  });

  it('rejects every request without the token', async () => {
    for (const route of ['/', '/label.js', '/label.css', '/api/state', '/api/audio/0']) {
      expect((await request(server.port, route)).status).toBe(403);
    }
    expect((await request(server.port, '/api/mark', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
  });

  it('rejects a wrong token, a foreign Host and a foreign Origin', async () => {
    expect((await request(server.port, `/?token=${'0'.repeat(64)}`)).status).toBe(403);
    expect((await request(server.port, '/api/state', { headers: { cookie: `ch_label_token=${'1'.repeat(64)}` } })).status).toBe(403);
    expect((await request(server.port, `/?token=${server.token}`, { headers: { host: `localhost:${server.port}` } })).status).toBe(403);
    expect((await request(server.port, `/?token=${server.token}`, { headers: { origin: 'http://evil.example' } })).status).toBe(403);
    // The guard on its own: a malformed URL is a bad request.
    expect(checkRequest({ url: '//', headers: { host: '127.0.0.1:1' } }, { token: 't', port: 1 }).status).not.toBe(200);
  });

  it('serves the page with the token, sets an HttpOnly cookie, and answers the cookie alone afterwards', async () => {
    const first = await request(server.port, `/?token=${server.token}`);
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toMatch(/text\/html/);
    expect(first.headers['content-security-policy']).toContain("script-src 'self'");
    expect(first.headers['set-cookie']?.[0]).toMatch(/HttpOnly; SameSite=Strict; Path=\//);
    const cookie = await pageCookie(server);
    expect((await request(server.port, '/label.js', { headers: { cookie } })).status).toBe(200);
    const state = await pageState(server, cookie);
    expect(state).toMatchObject({ count: 2, sampleRateHz: R, beforeSamples: W.before, afterSamples: W.after, done: false, marks: [null, null] });
    // Blind: the page learns positions only, never ids, cues, onsets or which items have an event.
    expect(JSON.stringify(state)).not.toMatch(/o0[12]|anchor|n_v|hasEvent/);
    const audio = await request(server.port, '/api/audio/1', { headers: { cookie } });
    expect(audio.status).toBe(200);
    expect(new Float32Array(audio.body.buffer, audio.body.byteOffset, audio.body.length / 4)).toEqual(window0);
    expect((await request(server.port, '/api/audio/2', { headers: { cookie } })).status).toBe(404);
    expect((await request(server.port, '/package.json', { headers: { cookie } })).status).toBe(404);
    // Chrome's own icon request gets an empty answer, still only with the token.
    const icon = await request(server.port, '/favicon.ico', { headers: { cookie } });
    expect([icon.status, icon.body.length]).toEqual([204, 0]);
    expect((await request(server.port, '/favicon.ico')).status).toBe(403);
  });

  it('takes JSON marks of whole samples, and finishes only when every item has one', async () => {
    const cookie = await pageCookie(server);
    expect((await request(server.port, '/api/mark', { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await postJson(server, cookie, '/api/mark', { pos: 0, label: 'speech', offset: 1.5 })).status).toBe(400);
    expect((await postJson(server, cookie, '/api/mark', { pos: 0, label: 'speech', offset: 1234 })).status).toBe(200);
    const early = await postJson(server, cookie, '/api/finish', {});
    expect(early.status).toBe(409);
    expect(early.body.toString('utf8')).toContain('2');
    expect((await postJson(server, cookie, '/api/mark', { pos: 1, label: NO_REPLY, offset: null })).status).toBe(200);
    expect((await pageState(server, cookie))['marks']).toEqual([
      { label: 'speech', offset: 1234 },
      { label: NO_REPLY, offset: null },
    ]);
    const done = await postJson(server, cookie, '/api/finish', {});
    expect(done.status).toBe(200);
    expect(await server.finished).toEqual([
      { id: 'o02', label: 'speech', n_v: 20 * R - W.before + 1234 },
      { id: 'o01', label: 'other', n_v: null },
    ]);
    expect(finished).not.toBeNull();
    expect((await pageState(server, cookie))['done']).toBe(true);
    const late = await postJson(server, cookie, '/api/mark', { pos: 0, label: 'cough', offset: 5 });
    expect(late.status).toBe(409);
    expect(late.body.toString('utf8')).toContain('already saved');
    expect((await postJson(server, cookie, '/api/finish', {})).status).toBe(409);
  });

  it('opens Chrome through /usr/bin/open as an app window with its own profile', () => {
    const args = chromeOpenArgs('http://127.0.0.1:1/?token=x', '/tmp/profile');
    expect(args.slice(0, 3)).toEqual(['-na', 'Google Chrome', '--args']);
    expect(args).toContain('--app=http://127.0.0.1:1/?token=x');
    expect(args).toContain('--user-data-dir=/tmp/profile');
  });
});

describe('label page server: a save that fails', () => {
  const window0 = new Float32Array(W.length);
  const items: LabelItem[] = [{ id: 'o01', anchor: 10 * R, hasEvent: true }];

  it('keeps the marks after an error the person can fix; Save again finishes', async () => {
    let calls = 0;
    const errors: Array<[string, boolean]> = [];
    const server = await startLabelServer({
      items,
      audio: () => window0,
      sampleRateHz: R,
      onFinish: () => {
        calls += 1;
        if (calls === 1) throw new Error('ENOSPC: no space left on device');
        return 'saved on the second try';
      },
      onFinishError: (e, retry) => errors.push([e.message, retry]),
    });
    try {
      const cookie = await pageCookie(server);
      expect((await postJson(server, cookie, '/api/mark', { pos: 0, label: 'speech', offset: 100 })).status).toBe(200);
      const failed = await postJson(server, cookie, '/api/finish', {});
      expect(failed.status).toBe(500);
      const body = jsonOf<{ ok: boolean; retry: boolean; error: string }>(failed);
      expect(body).toMatchObject({ ok: false, retry: true });
      expect(body.error).toMatch(/ENOSPC.*Your marks are kept/);
      expect(errors).toEqual([['ENOSPC: no space left on device', true]]);
      expect(await pageState(server, cookie)).toMatchObject({ done: false, marks: [{ label: 'speech', offset: 100 }] });
      // The person may still change a mark before saving again.
      expect((await postJson(server, cookie, '/api/mark', { pos: 0, label: 'speech', offset: 101 })).status).toBe(200);
      const ok = await postJson(server, cookie, '/api/finish', {});
      expect(ok.status).toBe(200);
      expect(jsonOf(ok)).toMatchObject({ ok: true, message: 'saved on the second try' });
      expect(await server.finished).toEqual([{ id: 'o01', label: 'speech', n_v: 10 * R - W.before + 101 }]);
    } finally {
      await server.close();
    }
  });

  it('ends the run after an error that saving again cannot fix', async () => {
    const server = await startLabelServer({
      items,
      audio: () => window0,
      sampleRateHz: R,
      onFinish: () => {
        throw new Error('another run saved labels meanwhile');
      },
      retryable: () => false,
    });
    try {
      const cookie = await pageCookie(server);
      await postJson(server, cookie, '/api/mark', { pos: 0, label: 'speech', offset: 100 });
      const failed = await postJson(server, cookie, '/api/finish', {});
      expect(failed.status).toBe(500);
      expect(jsonOf(failed)).toMatchObject({ ok: false, retry: false });
      await expect(server.finished).rejects.toThrow(/meanwhile/);
      const late = await postJson(server, cookie, '/api/mark', { pos: 0, label: 'speech', offset: 5 });
      expect(late.status).toBe(409);
      expect(late.body.toString('utf8')).toContain('ended without saving');
    } finally {
      await server.close();
    }
  });

  it('takes no mark while the marks are being saved', async () => {
    let entered!: () => void;
    let release!: () => void;
    const inFinish = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const server = await startLabelServer({
      items,
      audio: () => window0,
      sampleRateHz: R,
      onFinish: async () => {
        entered();
        await gate;
        return 'saved';
      },
    });
    try {
      const cookie = await pageCookie(server);
      await postJson(server, cookie, '/api/mark', { pos: 0, label: 'speech', offset: 100 });
      const finishing = postJson(server, cookie, '/api/finish', {});
      await inFinish;
      const during = await postJson(server, cookie, '/api/mark', { pos: 0, label: 'speech', offset: 5 });
      expect(during.status).toBe(409);
      expect(during.body.toString('utf8')).toContain('being saved');
      release();
      expect((await finishing).status).toBe(200);
      expect(await server.finished).toEqual([{ id: 'o01', label: 'speech', n_v: 10 * R - W.before + 100 }]);
    } finally {
      await server.close();
    }
  });
});

// ---- the run lock ----------------------------------------------------------------------------------------

describe('label lock (spec 8.5: one confirmatory labelling at a time)', () => {
  it('has one holder at a time; release frees it', () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 'lock-'));
    const a = acquireLabelLock(dir, '2026-11-13T18:30:00Z');
    if ('refused' in a) throw new Error(a.refused);
    expect(JSON.parse(fileText(dir, LOCK_FILE))).toEqual({ pid: process.pid, utc: '2026-11-13T18:30:00Z' });
    const b = acquireLabelLock(dir, '2026-11-13T18:31:00Z');
    expect(b).toEqual({ refused: `another label run (process ${process.pid}, started 2026-11-13T18:30:00Z) is labelling this recording: finish or stop it first` });
    a.release();
    a.release();
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);
    const c = acquireLabelLock(dir, '2026-11-13T18:32:00Z');
    if ('refused' in c) throw new Error(c.refused);
    c.release();
  });

  it('takes over the lock of a run that died, and refuses a lock that names no process', () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 'lock-'));
    fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 4_000_000, utc: '2026-11-13T17:00:00Z' }));
    const took = acquireLabelLock(dir, '2026-11-13T18:30:00Z', (pid) => pid !== 4_000_000);
    if ('refused' in took) throw new Error(took.refused);
    expect(JSON.parse(fileText(dir, LOCK_FILE))).toEqual({ pid: process.pid, utc: '2026-11-13T18:30:00Z' });
    took.release();
    fs.writeFileSync(path.join(dir, LOCK_FILE), 'not json');
    const refused = acquireLabelLock(dir, '2026-11-13T18:30:00Z');
    expect('refused' in refused && refused.refused).toMatch(/names no process/);
    expect(processAlive(process.pid)).toBe(true);
  });
});

// ---- the label command --------------------------------------------------------------------------------

describe('label command on a gate recording', () => {
  let folder: GateFolder;
  let ledgerBefore: string[] = [];
  let run: LabelRun;
  const seen: { first: Float32Array | null; locked: boolean } = { first: null, locked: false };
  /** Hand marks: 3 ms before the truth for o01, 1 ms after for o02, a cough for o03. */
  const choose = (id: string): PageMark => {
    const k = Number(id.slice(1));
    const truth = folder.truth.voiceOnsets[k - 1]!;
    if (id === 'o01') return { label: 'speech', offset: offsetAt(folder, k, truth - 3 * MS) };
    if (id === 'o02') return { label: 'speech', offset: offsetAt(folder, k, truth + 1 * MS) };
    return { label: 'cough', offset: offsetAt(folder, k, truth) };
  };
  const markOf = (id: string): LabelMark => {
    const c = choose(id);
    const k = Number(id.slice(1));
    return { id, label: c.label as OnsetLabel, n_v: folder.truth.cues[k - 1]! - W.before + c.offset! };
  };

  beforeAll(async () => {
    folder = makeGateFolder(ROOT, { id: 'gate-label', clean: true });
    ledgerBefore = readLedger(folder.dir, 'gate').lines;
    run = await runLabel(
      loadSession(folder.dir),
      {},
      deps({
        onServer: (server) => {
          void (async () => {
            seen.locked = fs.existsSync(path.join(folder.dir, LOCK_FILE));
            const cookie = await pageCookie(server);
            const audio = await request(server.port, '/api/audio/0', { headers: { cookie } });
            seen.first = new Float32Array(audio.body.buffer.slice(audio.body.byteOffset, audio.body.byteOffset + audio.body.length));
          })().then(() => driver(choose, SEED, IDS3)(server));
        },
      }),
    );
  }, 60_000);

  it('saves the labels and exits 0, holding the lock only while it runs', () => {
    expect(run.code).toBe(EXIT_OK);
    expect(onsetsOf(folder.dir).events.map((e) => e.id)).toEqual(IDS3);
    expect(run.withoutEvent).toEqual([]);
    expect(seen.locked).toBe(true);
    expect(fs.existsSync(path.join(folder.dir, LOCK_FILE))).toBe(false);
  });

  it('prints the cues, the events and how many are flagged no_dip (spec 7.6)', () => {
    const line = run.lines.find((l) => l.startsWith('Automatic onsets'));
    expect(line).toContain(
      `3 cue(s), 3 with voice within 10 s after the dot (0 of them already going at the dot); no_dip on ${noDipCount(onsetsOf(folder.dir).events)} event(s)`,
    );
  });

  it('writes a valid onsets.json with blind hand marks, labels, and a hash anyone can recompute from it', () => {
    const onsets = onsetsOf(folder.dir);
    expect(validateOnsets(onsets)).toEqual([]);
    expect(onsets.labels_sha256).toBe(labelsSha256(IDS3.map(markOf), sha256Hex));
    expect(onsetsLabelsSha256(onsets, sha256Hex)).toBe(onsets.labels_sha256);
    for (const e of onsets.events) {
      const m = markOf(e.id);
      expect(e.manual).toEqual({ n_v: m.n_v, blind: true });
      expect(e.label).toBe(m.label);
      expect(Math.abs(e.auto.n_v - folder.truth.voiceOnsets[e.cue! - 1]!)).toBeLessThanOrEqual(5 * MS);
    }
  });

  it('records the seed and the order: in onsets.json when its schema takes them, else in a ledger note with the exact seed', () => {
    const order = shuffledOrder(IDS3, SEED);
    const onsets = onsetsOf(folder.dir) as Onsets & { label_order?: unknown };
    const notes = readLedger(folder.dir, 'gate').records.filter((r) => r.step === 'note' && r.what === ORDER_NOTE);
    if (onsetsAcceptLabelOrder()) {
      expect(onsets.label_order).toEqual({ seed: SEED, order });
      expect(notes).toEqual([]);
    } else {
      expect(onsets.label_order).toBeUndefined();
      expect(notes).toHaveLength(1);
      expect((notes[0] as { detail?: string }).detail).toBe(`seed ${SEED}; order ${order.join(' ')}; labels_sha256 ${onsets.labels_sha256}`);
    }
  });

  it('serves channel 0 of the window, not channel 1', () => {
    const k = Number(shuffledOrder(IDS3, SEED)[0]!.slice(1));
    const start = folder.truth.cues[k - 1]! - W.before;
    const session = loadSession(folder.dir);
    expect(seen.first).toEqual(channel0Window(session, start, W.length));
    expect(seen.first).not.toEqual(Float32Array.from(session.ch1.subarray(start, start + W.length)));
  });

  it('adds the onset error to clock_report.json', () => {
    const report = reportOf(folder.dir);
    expect(validateClockReport(report)).toEqual([]);
    expect(report.onset).toEqual(onsetErrorBlock(onsetsOf(folder.dir), R));
    expect(report.onset!.events).toBe(2);
    expect(report.onset!.p90_abs_auto_minus_manual_ms).not.toBeNull();
  });

  it('writes onsets, then the label step with both hashes, before any step that joins detector answers', () => {
    const ledger = readLedger(folder.dir, 'gate');
    expect(verifyLedger(ledger.lines, sha256Hex, { kind: 'gate' }).ok).toBe(true);
    const added = ledger.records.slice(ledgerBefore.length);
    expect(added.map(stepName)).toEqual(labelTail());
    const label = added[added.length - 1]!;
    if (label.step === 'note') throw new Error('unexpected note');
    expect(label.out_sha256).toEqual({
      'onsets.json': sha256Hex(fs.readFileSync(path.join(folder.dir, 'onsets.json'))),
      'clock_report.json': sha256Hex(fs.readFileSync(path.join(folder.dir, 'clock_report.json'))),
    });
    // stage_a (the first step that joins detector answers) is refused until the label hash is in.
    const frozen = { out_sha256: { 'params/frozen.json': 'b'.repeat(64) } };
    const beforeLabel = ledger.records.slice(0, ledger.records.length - 1);
    expect(canAppendStep(beforeLabel, 'gate', 'stage_a', frozen)).not.toBeNull();
    expect(canAppendStep(ledger.records, 'gate', 'stage_a', frozen)).toBeNull();
  });

  it('refuses a second run without --exploratory and leaves every file as it is', async () => {
    const before = fileText(folder.dir, 'ledger.jsonl');
    const onsets = fileText(folder.dir, 'onsets.json');
    const again = await runLabel(loadSession(folder.dir), {}, deps());
    expect(again.code).toBe(EXIT_REFUSED);
    expect(again.refused).toMatch(/--exploratory/);
    expect(fileText(folder.dir, 'ledger.jsonl')).toBe(before);
    expect(fileText(folder.dir, 'onsets.json')).toBe(onsets);
    expect(fs.existsSync(path.join(folder.dir, LOCK_FILE))).toBe(false);
  });

  it('runs an exploratory relabelling into its own file and a ledger note only', async () => {
    const onsets = fileText(folder.dir, 'onsets.json');
    const report = fileText(folder.dir, 'clock_report.json');
    const ex = await runLabel(
      loadSession(folder.dir),
      { exploratory: true },
      deps({ seed: () => 7, onServer: driver(() => ({ label: 'speech', offset: W.before + 60 * MS }), 7, IDS3) }),
    );
    expect(ex.code).toBe(EXIT_OK);
    expect(ex.exploratoryFile).toBe('label-exploratory-1.json');
    const file = JSON.parse(fileText(folder.dir, ex.exploratoryFile!)) as { marks: Array<{ id: string; event: boolean }> } & Record<string, unknown>;
    expect(file).toMatchObject({ schema: 'label-exploratory/1', exploratory: true, run: 1, seed: 7, order: shuffledOrder(IDS3, 7) });
    expect(file.marks.map((m) => [m.id, m.event])).toEqual(IDS3.map((id) => [id, true]));
    expect(fileText(folder.dir, 'onsets.json')).toBe(onsets);
    expect(fileText(folder.dir, 'clock_report.json')).toBe(report);
    const last = readLedger(folder.dir, 'gate').records.at(-1)!;
    expect(last).toMatchObject({ step: 'note', what: EXPLORATORY_NOTE });
    expect((last as { detail?: string }).detail).toContain(sha256Hex(fs.readFileSync(path.join(folder.dir, ex.exploratoryFile!))));
  });
});

describe('one confirmatory label run at a time (spec 8.5)', () => {
  it('refuses a second run while the first page is open; the ledger gets one onsets and one label', async () => {
    const folder = makeGateFolder(ROOT, { id: 'gate-overlap', clean: true });
    const from = readLedger(folder.dir, 'gate').records.length;
    const got: { second?: LabelRun } = {};
    const first = await runLabel(
      loadSession(folder.dir),
      {},
      deps({
        onServer: (server) => {
          void runLabel(loadSession(folder.dir), {}, deps())
            .then((r) => {
              got.second = r;
            })
            .then(() => driver(truthChoice(folder), SEED, IDS3)(server));
        },
      }),
    );
    expect(first.code).toBe(EXIT_OK);
    expect(got.second?.code).toBe(EXIT_REFUSED);
    expect(got.second?.refused).toMatch(/^another label run \(process \d+, started 2026-11-13T18:30:00Z\) is labelling this recording/);
    expect(stepsSince(folder.dir, from)).toEqual(labelTail());
  });

  it('refuses to save after another writer appended label, and changes no file', async () => {
    const folder = makeGateFolder(ROOT, { id: 'gate-raced', clean: true });
    const kept: { onsets: string; report: string; finish: number | null } = { onsets: '', report: '', finish: null };
    const run = await runLabel(
      loadSession(folder.dir),
      {},
      deps({
        onServer: (server) => {
          // A run that ignored the lock saves its labels while this page is open.
          kept.onsets = fileText(folder.dir, 'onsets.json');
          kept.report = fileText(folder.dir, 'clock_report.json');
          const other = appendLedgerStep(folder.dir, 'gate', 'label', {
            utc: '2026-11-13T18:35:00Z',
            commit: null,
            outSha256: { 'onsets.json': sha256Hex(kept.onsets), 'clock_report.json': sha256Hex(kept.report) },
          });
          if (!other.appended) throw new Error(other.reason ?? 'not appended');
          driver(truthChoice(folder), SEED, IDS3)(server);
        },
      }),
    );
    expect(run.code).toBe(EXIT_REFUSED);
    expect(run.refused).toMatch(/another run saved labels meanwhile \(ledger line \d+\); these marks are not saved/);
    expect(fileText(folder.dir, 'onsets.json')).toBe(kept.onsets);
    expect(fileText(folder.dir, 'clock_report.json')).toBe(kept.report);
    expect(readLedger(folder.dir, 'gate').records.slice(-2).map(stepName)).toEqual(['onsets', 'label']);
    expect(fs.existsSync(path.join(folder.dir, LOCK_FILE))).toBe(false);
  });

  it('keeps the marks when a save fails for a reason the person can fix; Save again writes them once', async () => {
    const folder = makeGateFolder(ROOT, { id: 'gate-retry', clean: true });
    const from = readLedger(folder.dir, 'gate').records.length;
    // writeJsonFile writes onsets.json through this temporary name: a folder there makes the write fail.
    const blocker = path.join(folder.dir, `onsets.json.tmp-${process.pid}`);
    const answers: Array<{ status: number; body: Record<string, unknown> }> = [];
    let page: Promise<void> = Promise.resolve();
    const run = await runLabel(
      loadSession(folder.dir),
      {},
      deps({
        onServer: (server) => {
          page = (async () => {
            const cookie = await pageCookie(server);
            const order = shuffledOrder(IDS3, SEED);
            for (let pos = 0; pos < order.length; pos++) await postJson(server, cookie, '/api/mark', { pos, ...truthChoice(folder)(order[pos]!) });
            fs.mkdirSync(blocker);
            const failed = await postJson(server, cookie, '/api/finish', {});
            answers.push({ status: failed.status, body: jsonOf(failed) });
            fs.rmdirSync(blocker);
            const state = await pageState(server, cookie);
            expect(state['done']).toBe(false);
            expect((state['marks'] as unknown[]).every((m) => m !== null)).toBe(true);
            const ok = await postJson(server, cookie, '/api/finish', {});
            answers.push({ status: ok.status, body: jsonOf(ok) });
          })();
        },
      }),
    );
    // The command returns once the save went through; the page's last answer may come just after.
    await page;
    expect(answers.map((a) => a.status)).toEqual([500, 200]);
    expect(answers[0]!.body).toMatchObject({ ok: false, retry: true });
    expect(String(answers[0]!.body['error'])).toMatch(/EISDIR/);
    expect(run.code).toBe(EXIT_OK);
    expect(run.lines.join('\n')).toMatch(/The labels were not saved: EISDIR.*press Save again/);
    expect(stepsSince(folder.dir, from)).toEqual(labelTail());
    expect(onsetsLabelsSha256(onsetsOf(folder.dir), sha256Hex)).toBe(onsetsOf(folder.dir).labels_sha256);
  });
});

describe('every cue goes on the page, also one without an automatic event (spec 9.5)', () => {
  it('the mark of a cue the search found no voice for goes to a ledger note', async () => {
    // Replies to cues 1 and 3 only; cue 2 has no voice within 10 s (cues 13 s apart).
    const folder = makeGateFolder(ROOT, {
      id: 'gate-silent-cue',
      narrationS: 80,
      edit: (data, truth) => withVoices(data, truth, [truth.voiceOnsets[0]!, truth.voiceOnsets[2]!].map((at) => ({ at, durS: 0.8 }))),
    });
    const from = readLedger(folder.dir, 'gate').records.length;
    // The person hears something 2 s after dot 2 anyway.
    const heard = folder.truth.cues[1]! + 2 * R;
    const choose = (id: string): PageMark => (id === 'o02' ? { label: 'speech', offset: offsetAt(folder, 2, heard) } : truthChoice(folder)(id));
    const run = await runLabel(loadSession(folder.dir), {}, deps({ onServer: driver(choose, SEED, IDS3) }));
    expect(run.code).toBe(EXIT_OK);
    expect(run.lines.find((l) => l.startsWith('Automatic onsets'))).toContain('3 cue(s), 2 with voice within 10 s after the dot');
    const onsets = onsetsOf(folder.dir);
    expect(onsets.events.map((e) => [e.id, e.label])).toEqual([
      ['o01', 'speech'],
      ['o03', 'speech'],
    ]);
    expect(onsetsLabelsSha256(onsets, sha256Hex)).toBe(onsets.labels_sha256);
    expect(run.withoutEvent).toEqual([{ id: 'o02', label: 'speech', n_v: heard }]);
    const added = readLedger(folder.dir, 'gate').records.slice(from);
    expect(added.map(stepName)).toEqual(labelTail(NO_EVENT_NOTE));
    const note = added.find((r) => r.step === 'note' && r.what === NO_EVENT_NOTE) as { detail?: string };
    expect(note.detail).toBe(`blind marks of cues the automatic search found no voice for: o02 speech n_v ${heard}`);
    expect(run.lines.join('\n')).toContain('Cues without an automatic event: 1; your marks give a sound at 1 of them');
  });
});

describe('label command and the ledger order', () => {
  it('refuses before clocks and writes nothing', async () => {
    const { dir } = makeGateFolder(ROOT, { id: 'gate-early', through: 'quickcheck' });
    const before = fileText(dir, 'ledger.jsonl');
    const run = await runLabel(loadSession(dir), {}, deps());
    expect(run.code).toBe(EXIT_REFUSED);
    expect(run.refused).toMatch(/after "quickcheck" the next gate step is "clocks"/);
    expect(fs.existsSync(path.join(dir, 'onsets.json'))).toBe(false);
    expect(fileText(dir, 'ledger.jsonl')).toBe(before);
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);
  });

  it('--exploratory before the confirmatory run is refused', async () => {
    const { dir } = makeGateFolder(ROOT, { id: 'gate-ex-early' });
    const run = await runLabel(loadSession(dir), { exploratory: true }, deps());
    expect(run.code).toBe(EXIT_REFUSED);
    expect(run.refused).toMatch(/after the confirmatory/);
  });

  it('a stop before the last mark saves no labels; the next run starts over', async () => {
    const folder = makeGateFolder(ROOT, { id: 'gate-stop', clean: true });
    const { dir } = folder;
    const controller = new AbortController();
    const stopped = await runLabel(loadSession(dir), {}, deps({ signal: controller.signal, onServer: () => controller.abort() }));
    expect(stopped.code).toBe(EXIT_STOPPED);
    expect(readLedger(dir, 'gate').records.at(-1)!.step).toBe('onsets');
    expect(onsetsOf(dir).labels_sha256).toBeNull();
    expect(reportOf(dir).onset).toBeNull();
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);
    const again = await runLabel(loadSession(dir), {}, deps({ onServer: driver(truthChoice(folder), SEED, IDS3) }));
    expect(again.code).toBe(EXIT_OK);
    const steps = readLedger(dir, 'gate').records.filter((r) => r.step !== 'note').map((r) => r.step);
    expect(steps.slice(-3)).toEqual(['onsets', 'onsets', 'label']);
  });

  it('refuses session recordings until the session variant of spec 7.6 is built, writing nothing', async () => {
    const { session } = makeSyntheticSession({ narrationS: 16, replies: 2, seed: 3 });
    const dir = writeSessionFolder(ROOT, session, { id: 's9', kind: 'numbers' });
    expect(appendLedgerStep(dir, 'numbers', 'quickcheck', { utc: '2026-11-13T18:13:00Z', commit: null, outSha256: { 'quickcheck.json': sha256Hex('q') } }).appended).toBe(true);
    expect(runClocks(loadSession(dir), { out: () => undefined, commit: () => null }).refused).toBeUndefined();
    const before = fileText(dir, 'ledger.jsonl');
    const run = await runLabel(loadSession(dir), {}, deps());
    expect(run.code).toBe(EXIT_REFUSED);
    expect(run.refused).toMatch(/session variant .* not built yet/);
    expect(fs.existsSync(path.join(dir, 'onsets.json'))).toBe(false);
    expect(fileText(dir, 'ledger.jsonl')).toBe(before);
  });
});

describe('channel 0 window', () => {
  it('fills what was not recorded with zeros', () => {
    const { session } = makeSyntheticSession({ narrationS: 16, replies: 2, seed: 2, faults: { dropChunk: true } });
    const s = inMemorySession(session, gateManifest(session));
    const gap = s.layout.runs[1]!.n0 - 9600;
    const w = channel0Window(s, gap - 100, 200);
    expect(Array.from(w.subarray(100, 200)).every((x) => x === 0)).toBe(true);
    expect(Array.from(w.subarray(0, 100)).some((x) => x !== 0)).toBe(true);
    expect(Array.from(channel0Window(s, -50, 100).subarray(0, 50)).every((x) => x === 0)).toBe(true);
  });
});
