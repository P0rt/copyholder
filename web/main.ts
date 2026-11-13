/// <reference types="vite/client" />
// Copyholder page (spec 7.3, 12.2). Order: /api/config, the consent screen, the instruction, then,
// only after consent and Start, the AudioContext, the microphone, Deck, the worker and the consent
// frame. The main thread draws what Deck reports; Deck keeps the time (spec 6.1).
import deckUrl from './deck.worklet.ts?worker&url';
import workerUrl from './worker.ts?worker&url';
import { scenarioFor, type ScenarioPlan } from './scenarios/index.ts';
import type { Step } from './scenarios/format.ts';
import { apiUrl, parseConfig, type PageConfig } from './ui/config.ts';
import { liveConsentText, micConsentText } from './ui/consent.ts';
import { deckNodeOptions } from './ui/deck-options.ts';
import { nearestLevelDb, OUTPUT_LEVELS_DB, startLevel } from './ui/levels.ts';
import { DECK_NODE_OPTIONS, DECK_PROCESSOR_NAME, type FailReason, type FromDeck, type FromWorker } from './ui/messages.ts';
import { loadPlanAssets, type PlanAssets } from './ui/narrator.ts';
import { holdWakeLock, watchPageEvents } from './ui/page-events.ts';
import { FailureLatch, processorErrorText, RunController } from './ui/run.ts';
import { startSession, type Session } from './ui/session.ts';
import { createPageView, type PageView } from './ui/view.ts';

function log(message: string, data?: unknown): void {
  console.info(`[copyholder] ${message}`, data ?? '');
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function goFullScreen(): void {
  if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {});
}

async function readConfig(): Promise<PageConfig> {
  const res = await fetch(apiUrl('/api/config', location.search));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseConfig(await res.json());
}

async function main(): Promise<void> {
  const view = createPageView(document);
  let config: PageConfig;
  try {
    config = await readConfig();
  } catch (err) {
    view.message('Cannot start', `The run configuration could not be read (${errText(err)}). Open this page with the terminal command.`, 'error');
    return;
  }
  const plan = scenarioFor(config);
  if (typeof plan === 'string') {
    view.message('Cannot start', plan, 'error');
    return;
  }

  const text = config.consentText === 'mic' ? micConsentText(config.sessionId) : liveConsentText(config.sessionId, config.facePreview);
  // goFullScreen runs inside the click: full screen needs the user's gesture (spec 7.3).
  const consent = await view.consent(text, goFullScreen);
  if (!consent) {
    view.message('Cancelled', 'Nothing was turned on and nothing was recorded. Close this window and stop the command in the terminal.');
    return;
  }

  // The narrator loads while the instruction is read; the camera and the microphone stay off until Start.
  const loading: Promise<{ assets: PlanAssets; steps: Step[] }> = loadPlanAssets(plan, config.narrator, (u) => fetch(u), location.search).then(
    (assets) => ({ assets, steps: plan.build(assets) }),
  );
  view.dotVisible(true);
  try {
    await view.instruction(plan.instruction, loading);
  } catch (err) {
    view.message('Cannot start', errText(err), 'error');
    return;
  }
  goFullScreen();
  const { assets, steps } = await loading;
  const level = startLevel(config.calib?.output_gain);
  log(`output level ${level.db} dB (${level.source})`);
  // Deck's voice detector runs on the parameters analysis uses after the run (docs/protocol.md).
  const deck = deckNodeOptions(config, level.gain);
  log(`voice detector parameters: ${deck.vadSource}`);
  // processorerror can fire before the run screen exists; the latch keeps it for the controller (spec 12.2).
  const deckFailure = new FailureLatch();

  let session: Session;
  try {
    session = await startSession(consent, config, {
      mediaDevices: navigator.mediaDevices,
      createAudioContext: (options) => new AudioContext(options),
      createDeckNode: async (ctx) => {
        await ctx.audioWorklet.addModule(deckUrl);
        const node = new AudioWorkletNode(ctx, DECK_PROCESSOR_NAME, { ...DECK_NODE_OPTIONS, processorOptions: deck.options });
        // The attribute, not addEventListener('processorerror'): Chromium dispatches the failure as an
        // ErrorEvent of type 'error', which only the onprocessorerror handler receives.
        node.onprocessorerror = (e) => deckFailure.fire(processorErrorText(e));
        return node;
      },
      createWorker: () => new Worker(workerUrl, { type: 'module', name: 'copyholder-worker' }),
      userAgent: navigator.userAgent,
      log,
    });
  } catch (err) {
    view.message('Cannot start', `The microphone or the audio did not start: ${errText(err)}`, 'error');
    return;
  }
  run(view, session, plan, steps, assets, level.gain, deckFailure);
}

/** The message after a failure the page found itself (spec 12.2). */
function failureText(reason: FailReason, detail: string): string {
  const what =
    reason === 'deck_error'
      ? `Deck, the audio part of this page, stopped with an error (${detail}). Nothing is recorded after this point, so the app ended the recording.`
      : `The connection to the terminal app was lost (${detail}), so the app ended the recording.`;
  return `${what} The files stay in the session folder. The terminal shows what happened.`;
}

function run(view: PageView, session: Session, plan: ScenarioPlan, steps: Step[], assets: PlanAssets, gain: number, deckFailure: FailureLatch): void {
  const screen = view.run({ meters: plan.meters, devicePanel: plan.devicePanel, levelsDb: OUTPUT_LEVELS_DB });
  screen.devices(session.settings);
  const releaseWakeLock = holdWakeLock(navigator.wakeLock, document, log);
  const unwatch = watchPageEvents({ win: window, doc: document, mediaDevices: navigator.mediaDevices, track: session.track }, (ev) =>
    session.toWorker({ k: 'event', ...ev }),
  );
  // Space bar to Deck, which stamps nKey itself (spec 7.3); only the key mode uses it (spec 6.5).
  const onKey = (e: KeyboardEvent) => {
    if (e.code !== 'Space' || e.repeat) return;
    e.preventDefault();
    session.toDeck({ k: 'key' });
  };
  if (plan.deckMode === 'key') window.addEventListener('keydown', onKey);

  let localDone = false;
  const stopLocal = () => {
    if (localDone) return;
    localDone = true;
    unwatch();
    releaseWakeLock();
    window.removeEventListener('keydown', onKey);
    session.stopMicrophone();
    controller.microphoneOff();
  };

  const controller = new RunController(
    steps,
    screen,
    { toDeck: (m) => session.toDeck(m), toWorker: (m) => session.toWorker(m) },
    {
      done: () => {
        stopLocal();
        view.dotVisible(false);
        screen.note('The quick check of the recording runs in the terminal.');
      },
      aborted: (reason) => {
        stopLocal();
        view.dotVisible(false);
        view.message('Recording stopped', `The app ended the recording: ${reason}. The files stay in the session folder.`, 'error');
      },
      // Deck's processor failed or the worker lost /session: end like Stop, with the reason (spec 12.2).
      failed: (reason, detail) => {
        stopLocal();
        view.dotVisible(false);
        view.message('Recording stopped', failureText(reason, detail), 'error');
      },
      // The worker sent its last frame. It stays open for host's quickcheck line, unless /session is gone.
      closed: () => {
        void session.closeAudio();
        if (controller.endedBy === 'session_lost') session.terminateWorker();
      },
      // The verdict also comes after Stop or an abort; it then goes under that message (spec 9.3).
      verdict: (ok, text) => {
        if (text) view.verdict(ok, text);
        session.terminateWorker();
      },
      log,
    },
    nearestLevelDb(gain),
    () => session.ctx.currentTime,
  );

  session.deck.port.onmessage = (e: MessageEvent<FromDeck>) => controller.handleDeck(e.data);
  session.worker.onmessage = (e: MessageEvent<FromWorker>) => controller.handleWorker(e.data);
  session.worker.onerror = (e) => {
    log('worker failed', e.message);
    screen.note(`The worker failed: ${e.message}`);
  };
  screen.onWaitButton(() => controller.pressWaitButton());
  screen.onLevel((db) => controller.chooseLevel(db));
  view.onStop(() => {
    controller.stop();
    stopLocal();
    view.dotVisible(false);
    view.message('Stopped', 'The microphone is off and the camera stops now. The files stay in the session folder.');
  });

  session.toDeck({ k: 'gain', value: gain });
  for (const clip of assets.clips) {
    log(`narrator ${clip.name}: ${clip.seconds.toFixed(1)} s`);
    session.toDeck({ k: 'load', name: clip.name, pcm: clip.pcm, timings: clip.timings }, [clip.pcm.buffer]);
  }
  session.toDeck({ k: 'scenario', steps });
  deckFailure.listen((detail) => controller.deckFailed(detail));
}

void main();
