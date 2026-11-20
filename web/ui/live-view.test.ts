// The live view as the page builds it (spec 15.1, 15.2, 15.4), on a small stand-in document: the
// badge while the narrator is stopped, the detector line, D1 fire marks on the trace lane, the SDK
// line and the flash square. Vitest runs in Node without a DOM, so the stand-in has only what
// web/ui/live-view.ts and h() of web/ui/view.ts use; drawing goes to a recording 2D context.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEEP_BREATH_SIGN_ERROR } from '../lib/deep-breath-sign.ts';
import { SAMPLE_RATE_HZ } from '../scenarios/format.ts';
import { LIVE_VIEW_LEVEL_WINDOW_SAMPLES } from './deck-options.ts';
import { LANE_SECONDS } from './live-model.ts';
import { createLiveView, FLASH_MS, type LiveView } from './live-view.ts';

const N = (seconds: number) => Math.round(seconds * SAMPLE_RATE_HZ);
/** Colours live-view.ts falls back to when the page has no CSS variables (the stand-in has none). */
const FIRE = '#e6e2d8';
const CHEST = '#d39a5c';
const VOICE = '#7fa8d6';
/** The canvas size the view assumes when the element reports none. */
const W = 960;
const H = 300;

class FakeClassList {
  private readonly names = new Set<string>();
  add(...names: string[]): void {
    for (const n of names) this.names.add(n);
  }
  remove(...names: string[]): void {
    for (const n of names) this.names.delete(n);
  }
  toggle(name: string, force?: boolean): boolean {
    const on = force ?? !this.names.has(name);
    if (on) this.names.add(name);
    else this.names.delete(name);
    return on;
  }
  contains(name: string): boolean {
    return this.names.has(name);
  }
  set(text: string): void {
    this.names.clear();
    for (const n of text.split(/\s+/)) if (n) this.names.add(n);
  }
  toString(): string {
    return [...this.names].join(' ');
  }
}

interface Stroke {
  style: string;
  width: number;
  path: Array<[number, number]>;
}

interface Fill {
  style: string;
  alpha: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A 2D context that records the last frame: clearRect starts a new one. */
class FakeContext {
  globalAlpha = 1;
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  font = '';
  strokes: Stroke[] = [];
  fills: Fill[] = [];
  private path: Array<[number, number]> = [];
  setTransform(): void {}
  clearRect(): void {
    this.strokes = [];
    this.fills = [];
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.fills.push({ style: this.fillStyle, alpha: this.globalAlpha, x, y, w, h });
  }
  strokeRect(): void {}
  fillText(): void {}
  beginPath(): void {
    this.path = [];
  }
  moveTo(x: number, y: number): void {
    this.path.push([x, y]);
  }
  lineTo(x: number, y: number): void {
    this.path.push([x, y]);
  }
  stroke(): void {
    this.strokes.push({ style: this.strokeStyle, width: this.lineWidth, path: [...this.path] });
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly classList = new FakeClassList();
  id = '';
  hidden = false;
  width = 300;
  height = 150;
  readonly clientWidth = 0;
  readonly clientHeight = 0;
  private ownText = '';
  private ctx: FakeContext | null = null;
  constructor(readonly tagName: string) {}
  get className(): string {
    return this.classList.toString();
  }
  set className(text: string) {
    this.classList.set(text);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }
  set textContent(text: string) {
    this.children.length = 0;
    this.ownText = text;
  }
  append(...nodes: Array<FakeElement | string>): void {
    for (const n of nodes) {
      if (typeof n !== 'string') this.appendChild(n);
      else {
        const t = new FakeElement('#text');
        t.textContent = n;
        this.appendChild(t);
      }
    }
  }
  appendChild(node: FakeElement): FakeElement {
    this.children.push(node);
    return node;
  }
  replaceChildren(...nodes: FakeElement[]): void {
    this.textContent = '';
    for (const n of nodes) this.appendChild(n);
  }
  getContext(kind: string): FakeContext | null {
    if (this.tagName !== 'canvas' || kind !== '2d') return null;
    this.ctx ??= new FakeContext();
    return this.ctx;
  }
  /** This element or the first one below it with the id. */
  find(id: string): FakeElement | null {
    if (this.id === id) return this;
    for (const c of this.children) {
      const hit = c.find(id);
      if (hit) return hit;
    }
    return null;
  }
}

class FakeWindow {
  devicePixelRatio = 1;
  readonly frames = new Map<number, () => void>();
  readonly cancelled: number[] = [];
  private nextId = 1;
  getComputedStyle(): { getPropertyValue(name: string): string } {
    return { getPropertyValue: () => '' };
  }
  requestAnimationFrame(fn: () => void): number {
    const id = this.nextId++;
    this.frames.set(id, fn);
    return id;
  }
  cancelAnimationFrame(id: number): void {
    this.frames.delete(id);
    this.cancelled.push(id);
  }
  /** Runs the frames asked for so far, as the browser would on the next refresh. */
  refresh(): void {
    const due = [...this.frames.entries()];
    this.frames.clear();
    for (const [, fn] of due) fn();
  }
}

class FakeDocument {
  readonly body = new FakeElement('body');
  readonly documentElement = new FakeElement('html');
  readonly defaultView = new FakeWindow();
  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }
  getElementById(id: string): FakeElement | null {
    return this.body.find(id);
  }
}

interface Page {
  doc: FakeDocument;
  view: LiveView;
  panel: FakeElement;
  el(id: string): FakeElement;
  ctx(): FakeContext;
}

function page(opts: { sdkVersion?: string | null; flash?: FakeElement } = {}): Page {
  const doc = new FakeDocument();
  if (opts.flash) doc.body.appendChild(opts.flash);
  const view = createLiveView(doc as unknown as Document, {
    sdkVersion: opts.sdkVersion === undefined ? '3.5.0' : opts.sdkVersion,
    levelWindowSamples: LIVE_VIEW_LEVEL_WINDOW_SAMPLES,
  });
  const panel = view.panel as unknown as FakeElement;
  const el = (id: string): FakeElement => {
    const hit = panel.find(id) ?? doc.body.find(id);
    if (!hit) throw new Error(`no element #${id}`);
    return hit;
  };
  return { doc, view, panel, el, ctx: () => el('live-lanes').getContext('2d') as FakeContext };
}

/** x of sample n on the lanes while Deck's latest report is `latest` (web/ui/live-view.ts draw). */
function laneX(n: number, latest: number): number {
  return W * (1 - (latest - n) / (LANE_SECONDS * SAMPLE_RATE_HZ));
}

describe('live view on the page (spec 15.1, 15.2)', () => {
  let p: Page;

  beforeEach(() => {
    vi.useFakeTimers();
    p = page();
  });

  afterEach(() => {
    p.view.stop();
    vi.useRealTimers();
  });

  it('builds the LIVE label, the SDK line, the lanes, the detector line and the flash square', () => {
    expect(p.el('live').className).toBe('live');
    expect(p.el('live-tag').textContent).toBe('LIVE');
    expect(p.el('live-info').textContent).toBe('SmartSpectra SDK 3.5.0 · 0 samples/s · not running');
    expect(p.el('live-lanes').tagName).toBe('canvas');
    expect(p.el('live-detector').textContent).toBe('chest detector: not active yet');
    expect(p.el('live-badge').hidden).toBe(true);
    expect(p.el('live-summary').hidden).toBe(true);
    expect(p.el('live-sign').hidden).toBe(true);
    // The square is fixed on the page itself, not in the panel (web/styles.css .flash).
    const flash = p.doc.getElementById('flash');
    expect(flash?.className).toBe('flash');
    expect(flash?.attributes.get('aria-hidden')).toBe('true');
    expect(p.panel.find('flash')).toBeNull();
    // The view draws on every screen refresh until stop().
    expect(p.doc.defaultView.frames.size).toBe(1);
    p.doc.defaultView.refresh();
    expect(p.doc.defaultView.frames.size).toBe(1);
  });

  it('keeps a flash square the page already has', () => {
    const own = new FakeElement('div');
    own.id = 'flash';
    own.className = 'flash';
    const q = page({ flash: own });
    q.view.deck({ k: 'click', n: N(1), i: 0, block: 'A' });
    expect(own.classList.contains('on')).toBe(true);
    expect(q.doc.body.children.filter((c) => c.id === 'flash')).toHaveLength(1);
    q.view.stop();
  });

  it('the SDK line: version, trace samples per second and kOk only while the readiness holds', () => {
    for (let k = 0; k < 90; k++) {
      p.view.worker({ k: 'trace', n: N(k / 30 + 0.1), sign: 1, count: 1, pts: [[1e15 + Math.round((k * 1e6) / 30), 0]] });
    }
    expect(p.view.worker({ k: 'sdk', tap: 'running', ok: false })).toBe(false);
    p.view.draw();
    expect(p.el('live-info').textContent).toBe('SmartSpectra SDK 3.5.0 · 30 samples/s · waiting for kOk');
    p.view.worker({ k: 'sdk', tap: 'running', ok: true });
    p.view.draw();
    expect(p.el('live-info').textContent).toBe('SmartSpectra SDK 3.5.0 · 30 samples/s · kOk');
    p.view.worker({ k: 'sdk', tap: 'running', ok: false, note: 'kNoFaceFound' });
    p.view.draw();
    expect(p.el('live-info').textContent).toBe('SmartSpectra SDK 3.5.0 · 30 samples/s · kNoFaceFound');
    const unknown = page({ sdkVersion: null });
    expect(unknown.el('live-info').textContent).toBe('SmartSpectra SDK version unknown · 0 samples/s · not running');
    unknown.view.stop();
  });

  it('the detector line follows D1 activity from the worker', () => {
    expect(p.view.worker({ k: 'armed', n: N(70), on: true })).toBe(true);
    p.view.draw();
    expect(p.el('live-detector').textContent).toBe('chest detector: active');
    expect(p.el('live-detector').classList.contains('active')).toBe(true);
    p.view.worker({ k: 'armed', n: N(75), on: false });
    p.view.draw();
    expect(p.el('live-detector').textContent).toBe('chest detector: not active');
    expect(p.el('live-detector').classList.contains('active')).toBe(false);
  });

  it('a CHEST stop: the fire mark on the trace lane, the badge and the shaded span while stopped', () => {
    p.view.deck({ k: 'state', n: N(60), s: 'narrating', cause: null });
    p.view.worker({ k: 'armed', n: N(65), on: true });
    expect(p.view.worker({ k: 'fire', n: N(70), v: 3.1, theta: 2.2 })).toBe(true);
    p.view.deck({ k: 'state', n: N(70.01), s: 'hold_wait', cause: 'chest' });
    p.view.deck({ k: 'level', ch0Db: -60, ch1Db: -20 });
    p.view.draw();
    const badge = p.el('live-badge');
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('CHEST');
    expect(badge.dataset.cause).toBe('chest');
    const latest = p.view.model.latestN;
    expect(latest).toBe(N(70.01));
    // One full-height mark in the trace lane at the fire's sample.
    const marks = p.ctx().strokes.filter((s) => s.style === FIRE);
    const fx = laneX(N(70), latest);
    expect(marks).toEqual([{ style: FIRE, width: 2, path: [[fx, 2], [fx, Math.round(H * 0.46) - 2]] }]);
    // The stop is shaded in its cause's colour from its start to now, across the lanes.
    const spans = p.ctx().fills.filter((f) => f.style === CHEST);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ alpha: 0.22, y: 0, h: H });
    expect(spans[0]!.x).toBeCloseTo(laneX(N(70.01), latest), 6);

    // The user speaks: still the chest stop. Then the narrator goes on and the badge goes.
    p.view.deck({ k: 'state', n: N(71), s: 'listening', cause: 'chest' });
    p.view.draw();
    expect(badge.textContent).toBe('CHEST');
    p.view.deck({ k: 'state', n: N(73), s: 'resume', cause: null });
    p.view.draw();
    expect(badge.hidden).toBe(true);
    expect(badge.textContent).toBe('');
    expect(badge.dataset.cause).toBe('');
    // The fire mark stays on the lane until it scrolls out (12 s).
    expect(p.ctx().strokes.filter((s) => s.style === FIRE)).toHaveLength(1);
    p.view.deck({ k: 'step', n: N(70 + LANE_SECONDS + 1), name: 'p2', text: '' });
    p.view.draw();
    expect(p.ctx().strokes.filter((s) => s.style === FIRE)).toEqual([]);
  });

  it('a VOICE stop shows VOICE; the summary counts the stops by cause', () => {
    p.view.deck({ k: 'state', n: N(80), s: 'narrating', cause: null });
    p.view.deck({ k: 'state', n: N(82), s: 'listening', cause: 'voice' });
    p.view.draw();
    expect(p.el('live-badge').textContent).toBe('VOICE');
    expect(p.el('live-badge').dataset.cause).toBe('voice');
    expect(p.ctx().fills.filter((f) => f.style === VOICE)).toHaveLength(1);
    p.view.deck({ k: 'state', n: N(84), s: 'resume', cause: null });
    p.view.deck({ k: 'state', n: N(90), s: 'hold_wait', cause: 'chest' });
    p.view.deck({ k: 'state', n: N(92), s: 'resume', cause: null });
    p.view.deck({ k: 'step', n: N(100), name: 'summary', text: 'Summary of this take' });
    p.view.draw();
    const summary = p.el('live-summary');
    expect(summary.hidden).toBe(false);
    expect(summary.children[0]!.children.map((c) => c.textContent)).toEqual(['CHEST stops: 1', 'VOICE stops: 1']);
    p.view.deck({ k: 'step', n: N(110), name: 'signal_in', text: 'Breathe in' });
    p.view.draw();
    expect(summary.hidden).toBe(true);
  });

  it('the flash square turns white for 100 ms on every click of every block (spec 15.4)', () => {
    const flash = p.doc.getElementById('flash')!;
    expect(flash.classList.contains('on')).toBe(false);
    p.view.deck({ k: 'click', n: N(10), i: 0, block: 'A' });
    expect(flash.classList.contains('on')).toBe(true);
    vi.advanceTimersByTime(FLASH_MS - 1);
    expect(flash.classList.contains('on')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(flash.classList.contains('on')).toBe(false);
    // A click while the square is still white keeps it white for 100 ms from that click.
    p.view.deck({ k: 'click', n: N(60), i: 0, block: 'demo' });
    vi.advanceTimersByTime(60);
    p.view.deck({ k: 'click', n: N(60.8), i: 1, block: 'demo' });
    vi.advanceTimersByTime(60);
    expect(flash.classList.contains('on')).toBe(true);
    vi.advanceTimersByTime(40);
    expect(flash.classList.contains('on')).toBe(false);
    p.view.deck({ k: 'click', n: N(200), i: 9, block: 'B' });
    expect(flash.classList.contains('on')).toBe(true);
    // Other Deck messages never flash it.
    vi.advanceTimersByTime(FLASH_MS);
    p.view.deck({ k: 'cue', n: N(201), on: true });
    p.view.deck({ k: 'state', n: N(202), s: 'narrating', cause: null });
    expect(flash.classList.contains('on')).toBe(false);
  });

  it('no sign from the deep breaths: the note stays and the detector line says off', () => {
    expect(p.view.worker({ k: 'error', message: DEEP_BREATH_SIGN_ERROR })).toBe(true);
    p.view.worker({ k: 'armed', n: N(90), on: true });
    p.view.draw();
    expect(p.el('live-sign').hidden).toBe(false);
    expect(p.el('live-sign').textContent).toBe(DEEP_BREATH_SIGN_ERROR);
    expect(p.el('live-detector').textContent).toBe('chest detector: off in this run');
    // Other errors stay with the run controller.
    expect(p.view.worker({ k: 'error', message: 'worker: /tap closed before the end of the run' })).toBe(false);
  });

  it('stop() draws the last frame and asks for no more', () => {
    const win = p.doc.defaultView;
    p.view.stop();
    expect(win.frames.size).toBe(0);
    expect(win.cancelled).toHaveLength(1);
    p.view.stop();
    expect(win.cancelled).toHaveLength(1);
  });
});
