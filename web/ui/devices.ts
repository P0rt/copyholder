// Microphone and output device choice (spec 7.3, 5.2). Pure functions over enumerateDevices() rows.

export interface DeviceRow {
  kind: string;
  deviceId: string;
  groupId: string;
  label: string;
}

const ALIASES = new Set(['default', 'communications']);

/** Microphone constraints of spec 7.3: one exact device, mono, all three processing stages off. */
export function micConstraints(deviceId: string): MediaTrackConstraints {
  return {
    deviceId: { exact: deviceId },
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
}

/** True when the rows carry ids and labels, which browsers show only after a microphone grant. */
export function rowsAreLabelled(rows: readonly DeviceRow[], kind: string): boolean {
  return rows.some((d) => d.kind === kind && d.deviceId !== '' && d.label !== '');
}

/**
 * Device id to open. With `want`, the first real device whose name contains it; without, the real
 * device behind the system default ('default' shares its groupId). Falls back to 'default'.
 * Throws when `want` is given, the rows are labelled and no device matches.
 */
export function pickDeviceId(rows: readonly DeviceRow[], kind: 'audioinput' | 'audiooutput', want?: string): string {
  const all = rows.filter((d) => d.kind === kind);
  const real = all.filter((d) => d.deviceId !== '' && !ALIASES.has(d.deviceId));
  if (want) {
    const hit = real.find((d) => d.label.toLowerCase().includes(want.toLowerCase()));
    if (hit) return hit.deviceId;
    if (rowsAreLabelled(rows, kind)) {
      const names = real.map((d) => d.label).join(', ') || 'none';
      throw new Error(`No ${kind === 'audioinput' ? 'microphone' : 'output'} named like "${want}". Found: ${names}.`);
    }
    return 'default';
  }
  const def = all.find((d) => d.deviceId === 'default');
  if (def && def.groupId) {
    const same = real.find((d) => d.groupId === def.groupId);
    if (same) return same.deviceId;
  }
  if (def) return 'default';
  return real[0]?.deviceId ?? 'default';
}

/** Human name of a device id ('default' resolves to the default row's label). */
export function deviceName(rows: readonly DeviceRow[], kind: string, deviceId: string | undefined): string {
  const id = deviceId || 'default';
  const row = rows.find((d) => d.kind === kind && d.deviceId === id);
  return row?.label || (id === 'default' ? 'system default' : id);
}

export interface MicCheck {
  label: string;
  ok: boolean;
  /** A failed hard check makes doctor fail (spec 7.12); a failed soft check only warns. */
  hard: boolean;
  value: string;
  want: string;
}

function onOff(v: unknown): string {
  if (v === false) return 'off';
  if (v === true) return 'on';
  return v === undefined ? 'unknown' : String(v);
}

const RATE_HZ = 48_000;

function hz(rate: number | undefined): string {
  return typeof rate === 'number' && Number.isFinite(rate) ? `${rate} Hz` : 'unknown';
}

/**
 * Microphone checks of spec 7.12. Hard: the three processing stages off; the AudioContext and the
 * microphone track both at 48 000 Hz, as the terminal doctor requires (analysis/doctor.ts
 * sample_rate). The page sets the context rate itself, so the track rate is the one that tells
 * whether the input runs at 48 kHz in Audio MIDI Setup (spec 5.2); a track without a rate fails.
 * Soft: one channel; Deck's input takes one channel and mixes a stereo track down (spec 7.3).
 */
export function micChecks(settings: MediaTrackSettings, contextSampleRateHz: number): MicCheck[] {
  const channels = settings.channelCount;
  const trackRateHz = settings.sampleRate;
  return [
    { label: 'Echo cancellation', ok: settings.echoCancellation === false, hard: true, value: onOff(settings.echoCancellation), want: 'off' },
    { label: 'Noise suppression', ok: settings.noiseSuppression === false, hard: true, value: onOff(settings.noiseSuppression), want: 'off' },
    { label: 'Auto gain', ok: settings.autoGainControl === false, hard: true, value: onOff(settings.autoGainControl), want: 'off' },
    { label: 'Channels', ok: channels === undefined || channels === 1, hard: false, value: String(channels ?? 'unknown'), want: '1, Deck mixes them to one' },
    {
      label: 'Sample rate',
      ok: contextSampleRateHz === RATE_HZ && trackRateHz === RATE_HZ,
      hard: true,
      value: `audio context ${hz(contextSampleRateHz)}, microphone ${hz(trackRateHz)}`,
      want: `${RATE_HZ} Hz for both; set the input to ${RATE_HZ} Hz in Audio MIDI Setup`,
    },
  ];
}
