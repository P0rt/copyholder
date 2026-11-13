// Rows of the doctor device panel (spec 7.12: device names and microphone processing flags).
// Hard conditions fail doctor; the others only warn (spec 7.12: a refused sinkId warns). The rows
// follow the terminal doctor's rules (analysis/doctor.ts), so the panel and the verdict agree.
import { classifyMicrophone } from '../../analysis/lib/devices.ts';
import { micChecks } from './devices.ts';
import type { HelloSettings } from './messages.ts';

export interface DevicePanelRow {
  label: string;
  value: string;
  state: 'ok' | 'warn' | 'bad';
  want: string;
  /** Shown in place of "(should be <want>)" when the row is not ok. */
  detail?: string;
}

/**
 * The microphone by its name, with the classifier of the terminal doctor (spec 5.1, 7.12): a wired
 * or USB headset is ok; the built-in microphone (the last fallback of spec 5.1) and a name it cannot
 * judge are accepted with a warning; Bluetooth, a camera, a phone, a virtual device or no name fail.
 */
export function microphoneRow(label: string): DevicePanelRow {
  const mic = classifyMicrophone(label);
  const state = !mic.ok ? 'bad' : mic.verdict === 'headset' ? 'ok' : 'warn';
  return { label: 'Microphone', value: label || 'unknown', state, want: 'the wired headset microphone', detail: mic.reason };
}

export function deviceRowsForPanel(s: HelloSettings): DevicePanelRow[] {
  const output = s.output.accepted ? s.output.name : `${s.output.name}, the chosen output was not accepted`;
  return [
    microphoneRow(s.label),
    { label: 'Output', value: output, state: s.output.accepted ? 'ok' : 'warn', want: 'the chosen output' },
    ...micChecks(s, s.contextSampleRate).map((c) => ({
      label: c.label,
      value: c.value,
      state: c.ok ? ('ok' as const) : c.hard ? ('bad' as const) : ('warn' as const),
      want: c.want,
    })),
  ];
}

/** The text of a row's value cell. */
export function panelText(r: DevicePanelRow): string {
  if (r.state === 'ok') return r.value;
  return r.detail ?? `${r.value} (should be ${r.want})`;
}
