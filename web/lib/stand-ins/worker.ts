// Stand-in for web/worker.ts, for page tests only (vite --mode standins). No sockets: it plays host
// and tap for the page, following docs/protocol.md "Main thread <-> worker". The /api/config JSON
// may carry `standin: {sdk: 'auto' | 'manual', verdict: {ok, text}}`:
// - sdk 'auto' (default): after the consent frame, the camera starts and at once runs with kOk held;
//   'manual': the test sends {k:'standin_sdk', tap, ok, note?} to this worker, which passes it on.
//   With consentText 'mic' there is no camera and no sdk message.
// - verdict: the quickcheck line sent after `closed` (default GOOD RECORDING).
// It checks the Deck channel with one 'pkt' (seq 0, which the real Deck accepts too) and lists what it
// received on {k:'standin_report'}.
import type { FromWorker, ToWorker } from '../../ui/messages.ts';

interface WorkerScope {
  onmessage: ((e: MessageEvent<ToWorker | StandInControl>) => void) | null;
  postMessage(msg: unknown): void;
}
type StandInControl =
  | { k: 'standin_sdk'; tap: 'starting' | 'running' | 'stopped'; ok: boolean; note?: string }
  | { k: 'standin_report' };

interface StandInOptions {
  sdk?: 'auto' | 'manual';
  verdict?: { ok: boolean | null; text: string | null };
}

const scope = globalThis as unknown as WorkerScope;

const received: string[] = [];
let deck: MessagePort | null = null;
let deckPortOk = false;
let camera = true;
let options: StandInOptions = {};

function post(msg: FromWorker | { k: 'standin'; what: string; detail?: unknown }): void {
  scope.postMessage(msg);
}

scope.onmessage = (e) => {
  const msg = e.data;
  received.push(msg.k === 'event' ? `event:${msg.e}` : msg.k);
  switch (msg.k) {
    case 'init': {
      camera = msg.config.consentText !== 'mic'; // microphone-only modes run no SDK (spec 12.2)
      const raw = (msg.config as { standin?: unknown }).standin;
      options = typeof raw === 'object' && raw !== null ? (raw as StandInOptions) : {};
      deck = msg.port;
      deck.onmessage = (ev: MessageEvent<{ k: string; line?: { k?: string; seq?: number } }>) => {
        if (ev.data.k === 'stamp' && ev.data.line?.k === 'arr' && ev.data.line.seq === 0) deckPortOk = true;
      };
      deck.postMessage({ k: 'pkt', seq: 0, hold: false });
      break;
    }
    case 'consent':
      if (!camera) break;
      post({ k: 'sdk', tap: 'starting', ok: false });
      if (options.sdk !== 'manual') post({ k: 'sdk', tap: 'running', ok: true });
      break;
    case 'standin_sdk':
      post({ k: 'sdk', tap: msg.tap, ok: msg.ok, ...(msg.note ? { note: msg.note } : {}) });
      break;
    case 'standin_report':
      post({ k: 'standin', what: 'report', detail: { received: received.slice(), deckPortOk } });
      break;
    case 'end':
      if (camera) post({ k: 'sdk', tap: 'stopped', ok: false });
      post({ k: 'closed' });
      post({ k: 'quickcheck', ok: options.verdict?.ok ?? true, text: options.verdict ? options.verdict.text : 'GOOD RECORDING' });
      break;
    default:
      break;
  }
};
