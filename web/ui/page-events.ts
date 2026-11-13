// Window and device events of spec 7.3, sent to the worker for events.jsonl, and the screen wake lock.
// Hard: hidden page, devicechange, track ended, track muted. blur and resize only warn.
import type { PageEvent } from './messages.ts';

export interface PageEventTargets {
  win: EventTarget & { innerWidth: number; innerHeight: number };
  doc: EventTarget & { visibilityState: DocumentVisibilityState };
  mediaDevices: EventTarget;
  track: EventTarget;
}

/** Subscribes to the events; returns the unsubscribe function. */
export function watchPageEvents(t: PageEventTargets, send: (ev: PageEvent) => void): () => void {
  const subs: Array<[EventTarget, string, EventListener]> = [
    [t.doc, 'visibilitychange', () => send({ e: 'visibilitychange', state: t.doc.visibilityState, hard: t.doc.visibilityState === 'hidden' })],
    [t.win, 'blur', () => send({ e: 'blur', hard: false })],
    [t.win, 'resize', () => send({ e: 'resize', w: t.win.innerWidth, h: t.win.innerHeight, hard: false })],
    [t.mediaDevices, 'devicechange', () => send({ e: 'devicechange', hard: true })],
    [t.track, 'ended', () => send({ e: 'track_ended', hard: true })],
    [t.track, 'mute', () => send({ e: 'track_mute', hard: true })],
  ];
  for (const [target, type, fn] of subs) target.addEventListener(type, fn);
  return () => {
    for (const [target, type, fn] of subs) target.removeEventListener(type, fn);
  };
}

interface WakeLockLike {
  request(type: 'screen'): Promise<{ release(): Promise<void> }>;
}

/** Keeps the screen awake (spec 7.3) and asks again when the page becomes visible; returns release. */
export function holdWakeLock(wakeLock: WakeLockLike | undefined, doc: EventTarget & { visibilityState: DocumentVisibilityState }, log: (m: string) => void): () => void {
  if (!wakeLock) {
    log('navigator.wakeLock is not available');
    return () => {};
  }
  let sentinel: { release(): Promise<void> } | null = null;
  let done = false;
  const ask = () => {
    wakeLock.request('screen').then(
      (s) => {
        if (done) void s.release();
        else sentinel = s;
      },
      (err: unknown) => log(`wake lock refused: ${String(err)}`),
    );
  };
  const onVisible = () => {
    if (doc.visibilityState === 'visible' && !done) ask();
  };
  doc.addEventListener('visibilitychange', onVisible);
  ask();
  return () => {
    done = true;
    doc.removeEventListener('visibilitychange', onVisible);
    if (sentinel) void sentinel.release();
  };
}
