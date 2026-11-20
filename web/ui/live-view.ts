// The live view of a take (spec 15.1, 15.2), shown only by plans with `liveView` (headstart): the LIVE
// label, the SDK line (version, trace samples per second, SDK status), three lanes over the last 12 s
// (the chest trace with D1 fires and the spans while the narrator is stopped, the narrator level, the
// microphone level), whether the chest detector is active, a large CHEST or VOICE while the narrator
// is stopped, the summary of the take, and the square that flashes on every click (spec 15.4).
// It draws what Deck and the worker report; nothing here times the run (spec 6.1).
import { DEEP_BREATH_SIGN_ERROR } from '../lib/deep-breath-sign.ts';
import { SAMPLE_RATE_HZ } from '../scenarios/format.ts';
import { detectorText, infoLine, LANE_SECONDS, LiveModel, normalise, type StopCause } from './live-model.ts';
import type { FromDeck, FromWorker } from './messages.ts';
import { h } from './view.ts';

/** The flash square stays white this long after a click message (spec 15.4; display only). */
export const FLASH_MS = 100;
/** The extrapolated clock never runs further than this past Deck's last report. */
const MAX_AHEAD_S = 0.25;
/** Level lanes span this many dB up to 0 dBFS. */
const LEVEL_FLOOR_DB = -80;

const CAUSE_LABEL: Record<StopCause, string> = { chest: 'CHEST', voice: 'VOICE', key: 'KEY' };

export interface LiveViewOptions {
  sdkVersion: string | null;
  /** Samples per Deck level message (processorOptions.levelWindowSamples). */
  levelWindowSamples: number;
  /** AudioContext.currentTime, only to move the lanes smoothly between Deck's reports. */
  clockS?: () => number;
  log?: (message: string, data?: unknown) => void;
}

export interface LiveView {
  /** The panel for the run screen. */
  panel: HTMLElement;
  model: LiveModel;
  /** A Deck message (all of them; the controller gets them too). */
  deck(msg: FromDeck): void;
  /** A worker message; true when the live view took it (the controller then never sees it). */
  worker(msg: FromWorker): boolean;
  /** Draws one frame now (tests call it; the animation calls it on every frame). */
  draw(): void;
  /** Ends the animation; the last frame stays. */
  stop(): void;
}

interface Palette {
  text: string;
  muted: string;
  line: string;
  fire: string;
  narrator: string;
  mic: string;
  cause: Record<StopCause, string>;
}

function palette(doc: Document): Palette {
  const css = doc.defaultView?.getComputedStyle(doc.documentElement);
  const v = (name: string, fallback: string) => css?.getPropertyValue(name).trim() || fallback;
  return {
    text: v('--text', '#d8d5cd'),
    muted: v('--muted', '#8b8a85'),
    line: v('--line', '#34383b'),
    fire: v('--live-fire', '#e6e2d8'),
    narrator: v('--live-narrator', '#9fb0c2'),
    mic: v('--live-mic', '#9fb59a'),
    cause: { chest: v('--live-chest', '#d39a5c'), voice: v('--live-voice', '#7fa8d6'), key: v('--live-key', '#b49ad6') },
  };
}

/** Creates the panel and the flash square (fixed, top left), and starts drawing. */
export function createLiveView(doc: Document, opts: LiveViewOptions): LiveView {
  const model = new LiveModel(opts.levelWindowSamples);
  const info = h(doc, 'span', { class: 'live-info', id: 'live-info', text: infoLine(opts.sdkVersion, 0, null) });
  const canvas = h(doc, 'canvas', { class: 'live-lanes', id: 'live-lanes', attrs: { 'aria-label': 'Chest trace, narrator and microphone over the last 12 seconds' } });
  const badge = h(doc, 'div', { class: 'live-badge', id: 'live-badge', hidden: true });
  const detector = h(doc, 'span', { class: 'live-detector', id: 'live-detector', text: detectorText('not_yet') });
  const signNote = h(doc, 'p', { class: 'live-sign', id: 'live-sign', hidden: true });
  const summaryList = h(doc, 'div', { class: 'live-summary-lines' });
  const summary = h(doc, 'div', { class: 'live-summary', id: 'live-summary', hidden: true }, [summaryList]);
  const panel = h(doc, 'div', { class: 'live', id: 'live' }, [
    h(doc, 'div', { class: 'live-head' }, [h(doc, 'span', { class: 'live-tag', id: 'live-tag', text: 'LIVE' }), info]),
    h(doc, 'div', { class: 'live-stage' }, [canvas, badge]),
    h(doc, 'div', { class: 'live-foot' }, [detector, h(doc, 'span', { class: 'live-legend', text: 'Lanes: chest trace, narrator, microphone. Shaded: narrator stopped.' })]),
    signNote,
    summary,
  ]);
  const flash = doc.getElementById('flash') ?? doc.body.appendChild(h(doc, 'div', { class: 'flash', id: 'flash', attrs: { 'aria-hidden': 'true' } }));

  const colors = palette(doc);
  const win = doc.defaultView;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  let frame: number | null = null;
  let stopped = false;
  /** Deck's last reported sample and the audio clock when it came, for the smooth lanes. */
  let anchor = { n: 0, clockS: opts.clockS?.() ?? 0 };

  const flashOnce = () => {
    flash.classList.add('on');
    if (flashTimer !== null) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flash.classList.remove('on');
      flashTimer = null;
    }, FLASH_MS);
  };

  const nowN = (): number => {
    const latest = model.latestN;
    if (latest !== anchor.n) anchor = { n: latest, clockS: opts.clockS?.() ?? 0 };
    if (!opts.clockS) return latest;
    const ahead = Math.min(MAX_AHEAD_S, Math.max(0, opts.clockS() - anchor.clockS));
    return latest + ahead * SAMPLE_RATE_HZ;
  };

  /** Texts change a few times per second at most: the DOM is touched only when one does. */
  const setText = (el: HTMLElement, text: string) => {
    if (el.textContent !== text) el.textContent = text;
  };
  let summaryShown = '';
  const showTexts = () => {
    setText(info, infoLine(opts.sdkVersion, model.samplesPerSecond(), model.sdk));
    setText(detector, detectorText(model.detectorShown));
    detector.classList.toggle('active', model.detectorShown === 'active');
    const cause = model.badge;
    if (badge.hidden !== (cause === null)) badge.hidden = cause === null;
    setText(badge, cause === null ? '' : CAUSE_LABEL[cause]);
    if (badge.dataset.cause !== (cause ?? '')) badge.dataset.cause = cause ?? '';
    const inSummary = model.currentStep === 'summary';
    if (summary.hidden !== !inSummary) summary.hidden = !inSummary;
    if (inSummary) {
      const lines = model.summaryLines();
      const key = lines.join('\n');
      if (key !== summaryShown) {
        summaryShown = key;
        summaryList.replaceChildren(...lines.map((line) => h(doc, 'p', { text: line })));
      }
    }
  };

  const draw = () => {
    showTexts();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = win?.devicePixelRatio ?? 1;
    const cssW = canvas.clientWidth || 960;
    const cssH = canvas.clientHeight || 300;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const now = nowN();
    const span = LANE_SECONDS * SAMPLE_RATE_HZ;
    const x = (n: number) => cssW * (1 - (now - n) / span);
    const gap = 10;
    const traceH = Math.round(cssH * 0.46);
    const levelH = Math.round((cssH - traceH - 2 * gap) / 2);
    const lanes = { trace: { y: 0, h: traceH }, narrator: { y: traceH + gap, h: levelH }, mic: { y: traceH + 2 * gap + levelH, h: levelH } };

    // Spans while the narrator is stopped, across the lanes, by cause.
    for (const s of model.stops) {
      const x0 = x(s.n0);
      const x1 = x(s.n1 ?? now);
      if (x1 < 0 || x0 > cssW) continue;
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = colors.cause[s.cause];
      ctx.fillRect(Math.max(0, x0), 0, Math.min(cssW, x1) - Math.max(0, x0), cssH);
      ctx.globalAlpha = 1;
    }
    // Lane frames and labels.
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = colors.muted;
    for (const [label, lane] of [['chest trace', lanes.trace], ['narrator', lanes.narrator], ['microphone', lanes.mic]] as const) {
      ctx.strokeRect(0.5, lane.y + 0.5, cssW - 1, lane.h - 1);
      ctx.fillText(label, 8, lane.y + 16);
    }
    // D1 fires: a full-height mark in the trace lane.
    ctx.strokeStyle = colors.fire;
    ctx.lineWidth = 2;
    for (const f of model.fires) {
      const fx = x(f.n);
      if (fx < 0 || fx > cssW) continue;
      ctx.beginPath();
      ctx.moveTo(fx, lanes.trace.y + 2);
      ctx.lineTo(fx, lanes.trace.y + lanes.trace.h - 2);
      ctx.stroke();
    }
    // The chest trace, normalised by its running 10th to 90th percentile over 30 s.
    const range = model.traceRange();
    ctx.strokeStyle = colors.text;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (const p of model.trace) {
      const px = x(p.n);
      if (px < -4 || px > cssW + 4) continue;
      const u = Math.min(1.3, Math.max(-0.3, normalise(p.v, range.low, range.high)));
      const py = lanes.trace.y + lanes.trace.h * (0.85 - 0.7 * u);
      if (started) ctx.lineTo(px, py);
      else {
        ctx.moveTo(px, py);
        started = true;
      }
    }
    ctx.stroke();
    // Narrator (Deck channel 1) and microphone (channel 0) levels.
    const levelLane = (lane: { y: number; h: number }, color: string, pick: (l: { ch0Db: number; ch1Db: number }) => number) => {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      const w = Math.max(1, (opts.levelWindowSamples / span) * cssW);
      for (const l of model.levels) {
        const lx = x(l.n);
        if (lx < -w || lx > cssW + w) continue;
        const u = Math.min(1, Math.max(0, (pick(l) - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB));
        const bh = (lane.h - 4) * u;
        ctx.fillRect(lx - w, lane.y + lane.h - 2 - bh, w, bh);
      }
      ctx.globalAlpha = 1;
    };
    levelLane(lanes.narrator, colors.narrator, (l) => l.ch1Db);
    levelLane(lanes.mic, colors.mic, (l) => l.ch0Db);
  };

  const loop = () => {
    if (stopped) return;
    draw();
    frame = win?.requestAnimationFrame(loop) ?? null;
  };
  frame = win?.requestAnimationFrame(loop) ?? null;

  return {
    panel,
    model,
    deck(msg) {
      model.deck(msg);
      if (msg.k === 'click') flashOnce();
    },
    worker(msg) {
      if (msg.k === 'error' && msg.message === DEEP_BREATH_SIGN_ERROR) {
        // Shown for the rest of the run, not as a note that the next step clears (spec 7.11).
        model.signFailed();
        signNote.hidden = false;
        signNote.textContent = msg.message;
        opts.log?.('trace sign', msg.message);
        return true;
      }
      return model.worker(msg);
    },
    draw,
    stop() {
      if (stopped) return;
      draw();
      stopped = true;
      if (frame !== null) win?.cancelAnimationFrame(frame);
      frame = null;
    },
  };
}
