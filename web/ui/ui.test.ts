import { describe, expect, it } from 'vitest';
import { secondsToSamples } from '../scenarios/format.ts';
import { apiUrl, narratorPath, parseConfig, type PageConfig } from './config.ts';
import { assertConsent, consentPlainText, grantConsent, isConsent, liveConsentText, micConsentText, type Consent } from './consent.ts';
import { deviceRowsForPanel, microphoneRow, panelText } from './device-panel.ts';
import { micChecks, micConstraints, pickDeviceId, rowsAreLabelled, type DeviceRow } from './devices.ts';
import { dbToGain, DEFAULT_LEVEL_DB, nearestLevelDb, OUTPUT_LEVELS_DB, startLevel } from './levels.ts';
import type { HelloSettings } from './messages.ts';
import { holdWakeLock, watchPageEvents } from './page-events.ts';
import { openMicrophone, startSession, type MediaDevicesLike, type SessionDeps } from './session.ts';
import { causeOfState, formatClock, formatStatusLine } from './status.ts';
import { decodeNarratorWav, decodeWav, encodeWavPcm16 } from './wav.ts';

const S = secondsToSamples;

/**
 * Spec 12.2, the live consent screen, one paragraph per line as the screen shows it (the spec wraps
 * bullets for reading; tests/e2e/page.spec.ts checks the page against the wrapped text as printed).
 */
const SPEC_CONSENT_LIVE = `Before you start

Copyholder will turn on your camera and your microphone.

- Camera frames are processed on this computer by the SmartSpectra SDK. The app does not store or upload them.
- In every session the SDK itself sends derived measurements (such as breathing rate) with session identifiers to Presage in the United States. Presage passes them to its AI provider, Anthropic, to generate "Insights". This cannot currently be switched off. The app never requests an Insight and sends no prompt text.
- The SDK also sends app credentials, hashed device identifiers and usage records, and Presage's servers see the IP address.
- SDK telemetry is switched off (\`enableTelemetry: false\`). That does not switch off authentication, model delivery or the transfer above.
- Your microphone recording, the chest trace, face points and the SDK's raw messages, which include the full face mesh, are saved to the folder sessions/<id>/ on this computer. The app uploads none of it.
- Measure only yourself. You must be 18 or older.
- SDK metrics are offered for general wellness and informational purposes only. SDK metrics have not been cleared by the FDA and may not be used for medical diagnosis or treatment. This app makes no diagnosis and no health claim.

Privacy notice: PRIVACY.md. Terms of use: TERMS.md.

[ I agree, start ]   [ Cancel ]`;

/** Backticks become a monospace font on screen (spec 12.2). */
function onScreen(spec: string): string {
  return spec.replaceAll('`', '');
}

describe('consent screen (spec 12.2)', () => {
  it('shows the live text verbatim, with the session name for <id> and code in place of backticks', () => {
    const c = liveConsentText('s1');
    expect(consentPlainText(c)).toBe(onScreen(SPEC_CONSENT_LIVE).replace('<id>', 's1'));
    const telemetry = c.bullets[3] ?? [];
    expect(telemetry.filter((r) => r.code).map((r) => r.text)).toEqual(['enableTelemetry: false']);
  });

  it('adds the face-preview bullet right after the camera bullet in a demo take', () => {
    const c = liveConsentText('demo-1', true);
    expect(c.bullets).toHaveLength(8);
    expect(c.bullets[1]?.[0]?.text).toMatch(/^This take also turns on the built-in camera for a face preview/);
  });

  it('keeps only the microphone line and where the recording is saved in microphone-only modes', () => {
    const text = consentPlainText(micConsentText('doctor-2'));
    expect(text).toBe(
      [
        'Before you start',
        'This mode turns on your microphone only. The camera stays off and the SmartSpectra SDK does not run.',
        '- Your microphone recording is saved to the folder sessions/doctor-2/ on this computer. The app uploads none of it.',
        '[ I agree, start ]   [ Cancel ]',
      ].join('\n\n'),
    );
    expect(text).not.toMatch(/Presage|telemetry|FDA|camera frames/i);
  });

  it('accepts only a consent token minted by the agree handler', () => {
    const token = grantConsent('2026-11-13T19:00:00.000Z');
    expect(isConsent(token)).toBe(true);
    expect(Object.isFrozen(token)).toBe(true);
    const forged = { given: true, at: '2026-11-13T19:00:00.000Z' };
    expect(isConsent(forged)).toBe(false);
    expect(() => assertConsent(forged)).toThrow(/no consent/);
    expect(() => assertConsent(null)).toThrow(/no consent/);
  });
});

// ---------------------------------------------------------------- the session gate

interface Calls {
  log: string[];
  deck: unknown[];
  worker: unknown[];
}

function fakeDeps(calls: Calls, rows: DeviceRow[]): SessionDeps {
  const track = {
    label: 'Headset Microphone',
    stop: () => calls.log.push('track.stop'),
    getSettings: () => ({ deviceId: 'mic-1', echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, sampleRate: 48_000 }),
  };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  return {
    mediaDevices: {
      enumerateDevices: async () => {
        calls.log.push('enumerateDevices');
        return rows;
      },
      getUserMedia: async (c) => {
        calls.log.push(`getUserMedia ${JSON.stringify(c)}`);
        return stream as unknown as MediaStream;
      },
    },
    createAudioContext: (options) => {
      calls.log.push(`AudioContext ${JSON.stringify(options)}`);
      const node = { connect: () => {}, disconnect: () => {} };
      return {
        sampleRate: 48_000,
        baseLatency: 0.005,
        outputLatency: 0.02,
        state: 'running',
        destination: {},
        createMediaStreamSource: () => node,
        resume: async () => {},
        close: async () => {},
      } as unknown as AudioContext;
    },
    createDeckNode: async () => {
      calls.log.push('deck');
      return { port: { postMessage: (m: unknown) => calls.deck.push(m) }, connect: () => {}, disconnect: () => {} } as unknown as AudioWorkletNode;
    },
    createWorker: () => {
      calls.log.push('worker');
      return { postMessage: (m: unknown) => calls.worker.push(m), terminate: () => {} } as unknown as Worker;
    },
    userAgent: 'test-agent',
  };
}

const ROWS: DeviceRow[] = [
  { kind: 'audioinput', deviceId: 'default', groupId: 'g1', label: 'Default - Headset Microphone' },
  { kind: 'audioinput', deviceId: 'mic-1', groupId: 'g1', label: 'Headset Microphone' },
  { kind: 'audioinput', deviceId: 'mic-2', groupId: 'g2', label: 'MacBook Microphone' },
  { kind: 'audiooutput', deviceId: 'default', groupId: 'g1', label: 'Default - Headset' },
  { kind: 'audiooutput', deviceId: 'out-1', groupId: 'g1', label: 'Headset' },
];

const CONFIG: PageConfig = parseConfig({ mode: 'gate', sessionId: 'gate-a', scenario: 'gate-A', narrator: [], consentText: 'live', detector: { variant: 'D1' } });

describe('startSession: the consent flag gates the microphone and the SDK start (spec 12.2)', () => {
  it('touches nothing without a minted consent token', async () => {
    const calls: Calls = { log: [], deck: [], worker: [] };
    const forged = { given: true, at: 'x' } as unknown as Consent;
    await expect(startSession(forged, CONFIG, fakeDeps(calls, ROWS))).rejects.toThrow(/no consent/);
    expect(calls).toEqual({ log: [], deck: [], worker: [] });
  });

  it('opens audio in the order of spec 7.3 and sends port, init, hello and consent', async () => {
    const calls: Calls = { log: [], deck: [], worker: [] };
    const consent = grantConsent('2026-11-13T19:00:00.000Z');
    const session = await startSession(consent, CONFIG, fakeDeps(calls, ROWS));
    const exact = JSON.stringify({ audio: micConstraints('mic-1'), video: false });
    expect(calls.log).toEqual([
      'enumerateDevices',
      'AudioContext {"sampleRate":48000,"latencyHint":"interactive"}',
      `getUserMedia ${exact}`,
      'enumerateDevices',
      'deck',
      'worker',
    ]);
    expect((calls.deck[0] as { k: string }).k).toBe('port');
    expect(calls.worker.map((m) => (m as { k: string }).k)).toEqual(['init', 'hello', 'consent']);
    expect(calls.worker[0]).toMatchObject({ k: 'init', config: { detector: { variant: 'D1' } } });
    expect(calls.worker[2]).toEqual({ k: 'consent', at: '2026-11-13T19:00:00.000Z' });
    expect(session.settings).toMatchObject({ label: 'Headset Microphone', contextSampleRate: 48_000, echoCancellation: false, output: { accepted: true } });
    session.stopMicrophone();
    expect(session.microphoneOn).toBe(false);
    expect(calls.log.at(-1)).toBe('track.stop');
  });

  it('asks for the named devices and passes the output as sinkId', async () => {
    const calls: Calls = { log: [], deck: [], worker: [] };
    const config = { ...CONFIG, devices: { input: 'macbook', output: 'headset' } };
    await startSession(grantConsent('t'), config, fakeDeps(calls, ROWS));
    expect(calls.log[1]).toBe('AudioContext {"sampleRate":48000,"latencyHint":"interactive","sinkId":"out-1"}');
    expect(calls.log[2]).toContain('"exact":"mic-2"');
  });
});

describe('microphone and output choice (spec 7.3, 5.2)', () => {
  it('asks for one exact device, mono, with all three processing stages off', () => {
    expect(micConstraints('abc')).toEqual({ deviceId: { exact: 'abc' }, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  });

  it('picks the device behind the system default, a named one, or fails on a missing name', () => {
    expect(pickDeviceId(ROWS, 'audioinput')).toBe('mic-1');
    expect(pickDeviceId(ROWS, 'audioinput', 'MacBook')).toBe('mic-2');
    expect(pickDeviceId(ROWS, 'audiooutput', 'headset')).toBe('out-1');
    expect(() => pickDeviceId(ROWS, 'audioinput', 'USB')).toThrow(/No microphone named like "USB"/);
    const hidden = [{ kind: 'audioinput', deviceId: '', groupId: '', label: '' }];
    expect(rowsAreLabelled(hidden, 'audioinput')).toBe(false);
    expect(pickDeviceId(hidden, 'audioinput', 'USB')).toBe('default');
  });

  it('makes processing flags and 48 kHz hard; channel count and a refused output only warn (spec 7.12)', () => {
    const settings: HelloSettings = {
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false,
      channelCount: 2,
      label: 'Headset Microphone',
      contextSampleRate: 44_100,
      baseLatency: null,
      outputLatency: null,
      output: { name: 'MacBook Speakers', sinkId: '', accepted: false },
    };
    expect(deviceRowsForPanel(settings).map((r) => [r.label, r.state])).toEqual([
      ['Microphone', 'ok'],
      ['Output', 'warn'],
      ['Echo cancellation', 'ok'],
      ['Noise suppression', 'bad'],
      ['Auto gain', 'ok'],
      ['Channels', 'warn'],
      ['Sample rate', 'bad'],
    ]);
    const good = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, sampleRate: 48_000 };
    expect(micChecks(good, 48_000).every((c) => c.ok)).toBe(true);
  });

  it('wants 48 kHz on the microphone track too, as the terminal doctor does (spec 5.2, 7.12)', () => {
    const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
    const rate = (settings: MediaTrackSettings, contextHz: number) => micChecks(settings, contextHz).find((c) => c.label === 'Sample rate');
    expect(rate({ ...base, sampleRate: 48_000 }, 48_000)).toMatchObject({ ok: true, hard: true, value: 'audio context 48000 Hz, microphone 48000 Hz' });
    expect(rate({ ...base, sampleRate: 44_100 }, 48_000)).toMatchObject({ ok: false, hard: true, value: 'audio context 48000 Hz, microphone 44100 Hz' });
    expect(rate(base, 48_000)).toMatchObject({ ok: false, value: 'audio context 48000 Hz, microphone unknown' });
    expect(rate({ ...base, sampleRate: 48_000 }, 44_100)?.ok).toBe(false);
  });

  it('judges the microphone by name with the rules of the terminal doctor (spec 5.1, 7.12)', () => {
    const state = (label: string) => microphoneRow(label).state;
    expect(state('Headset Microphone')).toBe('ok');
    expect(state('Default - External Microphone (Built-in)')).toBe('ok');
    expect(state('USB Audio Device (0d8c:0014)')).toBe('ok');
    expect(state('MacBook Pro Microphone (Built-in)')).toBe('warn');
    expect(state('Fake Default Audio Input')).toBe('warn');
    expect(state('AirPods Pro')).toBe('bad');
    expect(state('FaceTime HD Camera')).toBe('bad');
    expect(state('BlackHole 2ch')).toBe('bad');
    expect(state('')).toBe('bad');
    const builtin = microphoneRow('MacBook Pro Microphone (Built-in)');
    expect(panelText(builtin)).toMatch(/built-in microphone, the fallback reference of spec 5.1/);
    expect(panelText(microphoneRow('Headset Microphone'))).toBe('Headset Microphone');
    expect(panelText(microphoneRow(''))).toBe('the page did not report a microphone name');
    expect(panelText({ label: 'Auto gain', value: 'on', state: 'bad', want: 'off' })).toBe('on (should be off)');
  });
});

// ---------------------------------------------------------------- the first grant on a new origin

const HIDDEN: DeviceRow[] = [
  { kind: 'audioinput', deviceId: '', groupId: '', label: '' },
  { kind: 'audiooutput', deviceId: '', groupId: '', label: '' },
];

/** Rows without names until the first getUserMedia, as on a new origin; 'default' opens mic-1. */
function newOrigin(log: string[]): MediaDevicesLike {
  let granted = false;
  return {
    enumerateDevices: async () => (granted ? ROWS : HIDDEN),
    getUserMedia: async (c) => {
      const id = ((c.audio as MediaTrackConstraints).deviceId as { exact: string }).exact;
      granted = true;
      log.push(`open ${id}`);
      const track = { label: id, stop: () => log.push(`stop ${id}`), getSettings: () => ({ deviceId: id === 'default' ? 'mic-1' : id }) };
      return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
    },
  };
}

describe('openMicrophone: one exact device, and no stream left on after a failure (spec 7.3, 12.2)', () => {
  it('keeps the first stream when the default input is the device it wants', async () => {
    const log: string[] = [];
    const stream = await openMicrophone(newOrigin(log), HIDDEN, undefined);
    expect(log).toEqual(['open default']);
    expect(stream.getAudioTracks()[0]?.getSettings().deviceId).toBe('mic-1');
  });

  it('reopens on the named device once the grant reveals the names, and stops the first stream', async () => {
    const log: string[] = [];
    const stream = await openMicrophone(newOrigin(log), HIDDEN, 'MacBook');
    expect(log).toEqual(['open default', 'stop default', 'open mic-2']);
    expect(stream.getAudioTracks()[0]?.getSettings().deviceId).toBe('mic-2');
  });

  it('stops the first stream when no device matches the name', async () => {
    const log: string[] = [];
    await expect(openMicrophone(newOrigin(log), HIDDEN, 'USB')).rejects.toThrow(/No microphone named like "USB"/);
    expect(log).toEqual(['open default', 'stop default']);
  });

  it('stops the first stream when the second enumerateDevices fails', async () => {
    const log: string[] = [];
    const md = newOrigin(log);
    const failing: MediaDevicesLike = {
      getUserMedia: (c) => md.getUserMedia(c),
      enumerateDevices: async () => {
        throw new Error('enumerateDevices failed');
      },
    };
    await expect(openMicrophone(failing, HIDDEN, 'MacBook')).rejects.toThrow(/enumerateDevices failed/);
    expect(log).toEqual(['open default', 'stop default']);
  });

  it('startSession: a missing input name leaves the microphone off and closes the audio context', async () => {
    const calls: Calls = { log: [], deck: [], worker: [] };
    const micLog: string[] = [];
    const deps = fakeDeps(calls, ROWS);
    const makeContext = deps.createAudioContext;
    const withClose: SessionDeps = {
      ...deps,
      mediaDevices: newOrigin(micLog),
      createAudioContext: (o) => Object.assign(makeContext(o), { close: async () => void calls.log.push('ctx.close') }),
    };
    const config = { ...CONFIG, devices: { input: 'USB' } };
    await expect(startSession(grantConsent('t'), config, withClose)).rejects.toThrow(/No microphone named like "USB"/);
    expect(micLog).toEqual(['open default', 'stop default']);
    expect(calls.log).toEqual(['AudioContext {"sampleRate":48000,"latencyHint":"interactive"}', 'ctx.close']);
    expect(calls.deck).toEqual([]);
    expect(calls.worker).toEqual([]);
  });
});

describe('status line (spec 7.3)', () => {
  it('prints "Passage 2 of 3    04:12    CHEST"', () => {
    expect(formatStatusLine('Passage 2 of 3', S(252.9), 'chest')).toBe('Passage 2 of 3    04:12    CHEST');
    expect(formatStatusLine('Passage 1 of 3', S(5), null)).toBe('Passage 1 of 3    00:05');
    expect(formatStatusLine('Opening', null, 'voice')).toBe('Opening    VOICE');
  });

  it('counts the clock in samples, rounded down, and shows a cause only while stopped', () => {
    expect(formatClock(S(59.999))).toBe('00:59');
    expect(formatClock(S(6000))).toBe('100:00');
    expect(formatClock(-5)).toBe('00:00');
    expect(causeOfState('hold_wait', 'key')).toBe('key');
    expect(causeOfState('listening', 'voice')).toBe('voice');
    expect(causeOfState('narrating', 'chest')).toBeNull();
    expect(causeOfState('resume', 'chest')).toBeNull();
  });
});

describe('window and device events (spec 7.3)', () => {
  it('sends each event with its hard flag and stops on unsubscribe', () => {
    const win = Object.assign(new EventTarget(), { innerWidth: 1440, innerHeight: 900 });
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
    const mediaDevices = new EventTarget();
    const track = new EventTarget();
    const sent: unknown[] = [];
    const off = watchPageEvents({ win, doc, mediaDevices, track }, (ev) => sent.push(ev));
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('blur'));
    win.dispatchEvent(new Event('resize'));
    mediaDevices.dispatchEvent(new Event('devicechange'));
    track.dispatchEvent(new Event('mute'));
    track.dispatchEvent(new Event('ended'));
    expect(sent).toEqual([
      { e: 'visibilitychange', state: 'hidden', hard: true },
      { e: 'blur', hard: false },
      { e: 'resize', w: 1440, h: 900, hard: false },
      { e: 'devicechange', hard: true },
      { e: 'track_mute', hard: true },
      { e: 'track_ended', hard: true },
    ]);
    off();
    win.dispatchEvent(new Event('blur'));
    expect(sent).toHaveLength(6);
  });

  it('holds a screen wake lock, asks again when the page is visible, and releases it', async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
    let requests = 0;
    let released = 0;
    const lock = { request: async () => ((requests += 1), { release: async () => void (released += 1) }) };
    const flush = () => new Promise((done) => setTimeout(done, 0));
    const release = holdWakeLock(lock, doc, () => {});
    await flush();
    doc.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(requests).toBe(2);
    release();
    expect(released).toBe(1);
    const logs: string[] = [];
    holdWakeLock(undefined, doc, (m) => logs.push(m))();
    expect(logs).toEqual(['navigator.wakeLock is not available']);
  });
});

describe('output level (spec 7.7)', () => {
  it('starts from calib.json output_gain, else the default notch', () => {
    expect(startLevel(0.35)).toEqual({ gain: 0.35, db: -9.1, source: 'calib' });
    expect(startLevel(null)).toEqual({ gain: dbToGain(DEFAULT_LEVEL_DB), db: DEFAULT_LEVEL_DB, source: 'default' });
    expect(startLevel(1.5).source).toBe('default');
    expect(nearestLevelDb(0.35)).toBe(-9);
    expect(OUTPUT_LEVELS_DB).toContain(DEFAULT_LEVEL_DB);
  });
});

describe('/api/config and narrator files', () => {
  it('normalises the config and keeps the raw JSON for the worker', () => {
    const raw = { mode: 'doctor', sessionId: 'doctor-1', scenario: 'doctor', narrator: ['level.wav', 3], calib: null, devices: { input: 'USB', output: '' }, kind: 'doctor' };
    const c = parseConfig(raw);
    expect(c).toMatchObject({ mode: 'doctor', consentText: 'mic', narrator: ['level.wav'], devices: { input: 'USB' }, facePreview: false, tapUrl: null });
    expect(c.raw).toBe(raw);
    expect(() => parseConfig('x')).toThrow();
    expect(apiUrl('/api/config', '?token=a b')).toBe('/api/config?token=a%20b');
    expect(apiUrl('/api/config', '')).toBe('/api/config');
    expect(narratorPath('listen.wav')).toBe('/api/narrator/listen.wav');
  });

  it('decodes mono 48 kHz WAV and rejects other rates and channel counts', () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 0.25]);
    const back = decodeNarratorWav(encodeWavPcm16(pcm), 'x.wav');
    expect([...back].map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 0.5, -0.5, 0.25]);
    expect(() => decodeNarratorWav(encodeWavPcm16(pcm, 44_100), 'x.wav')).toThrow(/48 000 Hz/);
    const stereo = encodeWavPcm16(pcm);
    new DataView(stereo).setUint16(22, 2, true);
    expect(decodeWav(stereo).channels).toBe(2);
    expect(() => decodeNarratorWav(stereo, 'x.wav')).toThrow(/mono/);
    expect(() => decodeWav(new ArrayBuffer(8))).toThrow(/RIFF/);
  });
});
