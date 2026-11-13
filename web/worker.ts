// Module Web Worker (spec 6.1, 7.3): /tap and /session client, step() on every input, events.jsonl.
// The hold goes to Deck on the direct MessagePort, never through the main thread. All logic lives in
// WorkerCore (web/lib/worker-core.ts); this file is the shell.

import type { MainToWorker, WorkerToMain } from './lib/messages.ts';
import { WorkerCore, type SocketLike } from './lib/worker-core.ts';

interface WorkerScope {
  postMessage(msg: unknown): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

const scope = self as unknown as WorkerScope;

const core = new WorkerCore({
  postToMain: (msg: WorkerToMain) => scope.postMessage(msg),
  openSocket: (url: string): SocketLike => new WebSocket(url) as unknown as SocketLike,
  // Bounds the wait for Deck's last block when the audio thread is gone; nothing recorded depends on it.
  later: (ms, fn) => {
    setTimeout(fn, ms);
  },
});

scope.onmessage = (ev: MessageEvent) => core.onMainMessage(ev.data as MainToWorker);
