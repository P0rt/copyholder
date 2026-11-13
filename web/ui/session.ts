// Starts the audio side of a run, only with a consent token (spec 12.2): the AudioContext, the
// microphone, Deck, the worker and the channel between them, then the hello and consent frames.
// Order and settings follow spec 7.3. Dependencies are passed in so tests can check the gating.
import type { PageConfig } from './config.ts';
import { assertConsent, type Consent } from './consent.ts';
import { deviceName, micConstraints, pickDeviceId, rowsAreLabelled, type DeviceRow } from './devices.ts';
import type { HelloSettings, ToDeck, ToWorker } from './messages.ts';

export interface SinkAudioContextOptions extends AudioContextOptions {
  sinkId?: string;
}

/** AudioContext features newer than the TypeScript DOM library. */
interface SinkAudioContext extends AudioContext {
  readonly sinkId?: string | object;
  setSinkId?: (id: string) => Promise<void>;
}

export interface MediaDevicesLike {
  enumerateDevices(): Promise<DeviceRow[]>;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export interface SessionDeps {
  mediaDevices: MediaDevicesLike;
  createAudioContext(options: SinkAudioContextOptions): AudioContext;
  /** addModule() of the Deck worklet and new AudioWorkletNode(ctx, 'deck', DECK_NODE_OPTIONS). */
  createDeckNode(ctx: AudioContext): Promise<AudioWorkletNode>;
  createWorker(): Worker;
  userAgent: string;
  log?: (message: string, data?: unknown) => void;
}

export interface Session {
  ctx: AudioContext;
  stream: MediaStream;
  track: MediaStreamTrack;
  deck: AudioWorkletNode;
  worker: Worker;
  settings: HelloSettings;
  toDeck(msg: ToDeck, transfer?: Transferable[]): void;
  toWorker(msg: ToWorker, transfer?: Transferable[]): void;
  /** Turns the microphone off at once (Stop, end of the scenario). */
  stopMicrophone(): void;
  readonly microphoneOn: boolean;
  /** Microphone off, graph disconnected, AudioContext closed; the worker stays for host's last messages. */
  closeAudio(): Promise<void>;
  /** Ends the worker (after host's quickcheck line, or when the page gives up on it). */
  terminateWorker(): void;
  /** Both of the above. */
  close(): Promise<void>;
}

export const CONTEXT_OPTIONS: AudioContextOptions = { sampleRate: 48_000, latencyHint: 'interactive' };

function stopAll(stream: MediaStream | null): void {
  for (const t of stream?.getTracks() ?? []) t.stop();
}

function createContext(deps: SessionDeps, sinkId: string | undefined): { ctx: AudioContext; sinkInConstructor: boolean } {
  if (sinkId) {
    try {
      return { ctx: deps.createAudioContext({ ...CONTEXT_OPTIONS, sinkId }), sinkInConstructor: true };
    } catch (err) {
      deps.log?.('sinkId not accepted by the AudioContext constructor; using the system output', String(err));
    }
  }
  return { ctx: deps.createAudioContext({ ...CONTEXT_OPTIONS }), sinkInConstructor: false };
}

/**
 * Opens the microphone with deviceId exact. host listens on a new port each run, so the page is a new
 * origin without a stored grant: before the first grant the rows carry no names, the page opens the
 * default input, then picks the named or default device from the rows the grant reveals and reopens
 * on it (spec 7.3: one exact device). Whatever fails after the first grant stops that stream first:
 * the microphone never stays on behind an error screen (spec 12.2).
 */
export async function openMicrophone(md: MediaDevicesLike, rows: DeviceRow[], want: string | undefined): Promise<MediaStream> {
  const first = pickDeviceId(rows, 'audioinput', want);
  const stream = await md.getUserMedia({ audio: micConstraints(first), video: false });
  if (rowsAreLabelled(rows, 'audioinput')) return stream;
  let better: string;
  try {
    better = pickDeviceId(await md.enumerateDevices(), 'audioinput', want);
  } catch (err) {
    stopAll(stream);
    throw err;
  }
  const opened = stream.getAudioTracks()[0]?.getSettings().deviceId;
  if (better === first || better === opened) return stream;
  stopAll(stream);
  return md.getUserMedia({ audio: micConstraints(better), video: false });
}

async function applySink(ctx: SinkAudioContext, rows: DeviceRow[], want: string | undefined, inConstructor: boolean, sinkId: string | undefined) {
  if (!want) return { name: deviceName(rows, 'audiooutput', 'default'), sinkId: '', accepted: true };
  const id = sinkId ?? pickDeviceId(rows, 'audiooutput', want);
  if (!inConstructor && typeof ctx.setSinkId === 'function') {
    try {
      await ctx.setSinkId(id);
    } catch {
      // not accepted: the system output plays, and its name is checked instead (spec 7.3)
    }
  }
  const accepted = ctx.sinkId === id;
  return { name: deviceName(rows, 'audiooutput', accepted ? id : 'default'), sinkId: accepted ? id : '', accepted };
}

export async function startSession(consent: Consent, config: PageConfig, deps: SessionDeps): Promise<Session> {
  assertConsent(consent); // nothing below runs without 'I agree, start'
  const log = deps.log ?? (() => {});
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  try {
    const rowsBefore = await deps.mediaDevices.enumerateDevices();
    const sinkBefore = config.devices.output && rowsAreLabelled(rowsBefore, 'audiooutput') ? pickDeviceId(rowsBefore, 'audiooutput', config.devices.output) : undefined;
    const made = createContext(deps, sinkBefore);
    ctx = made.ctx;
    stream = await openMicrophone(deps.mediaDevices, rowsBefore, config.devices.input);
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('the microphone stream has no audio track');
    const rows = await deps.mediaDevices.enumerateDevices();
    const output = await applySink(ctx as SinkAudioContext, rows, config.devices.output, made.sinkInConstructor, sinkBefore);
    const settings: HelloSettings = {
      ...track.getSettings(),
      label: track.label,
      contextSampleRate: ctx.sampleRate,
      baseLatency: typeof ctx.baseLatency === 'number' ? ctx.baseLatency : null,
      outputLatency: typeof ctx.outputLatency === 'number' ? ctx.outputLatency : null,
      output,
    };
    log('microphone settings', settings);

    const deck = await deps.createDeckNode(ctx);
    const source = ctx.createMediaStreamSource(stream);
    source.connect(deck);
    deck.connect(ctx.destination);

    const worker = deps.createWorker();
    const channel = new MessageChannel();
    const toDeck = (msg: ToDeck, transfer: Transferable[] = []) => deck.port.postMessage(msg, transfer);
    const toWorker = (msg: ToWorker, transfer: Transferable[] = []) => worker.postMessage(msg, transfer);
    toDeck({ k: 'port', port: channel.port1 }, [channel.port1]);
    toWorker({ k: 'init', config: config.raw, port: channel.port2 }, [channel.port2]);
    toWorker({ k: 'hello', ua: deps.userAgent, settings });
    toWorker({ k: 'consent', at: consent.at });
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});

    const liveStream = stream;
    const liveCtx = ctx;
    let micOn = true;
    const closeAudio = async () => {
      micOn = false;
      stopAll(liveStream);
      source.disconnect();
      deck.disconnect();
      if (liveCtx.state !== 'closed') await liveCtx.close();
    };
    return {
      ctx,
      stream,
      track,
      deck,
      worker,
      settings,
      toDeck,
      toWorker,
      stopMicrophone() {
        micOn = false;
        stopAll(liveStream);
      },
      get microphoneOn() {
        return micOn;
      },
      closeAudio,
      terminateWorker() {
        worker.terminate();
      },
      async close() {
        worker.terminate();
        await closeAudio();
      },
    };
  } catch (err) {
    stopAll(stream);
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
    throw err;
  }
}
