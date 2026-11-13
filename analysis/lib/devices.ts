// Device names as Chrome reports them, judged by the rules of spec 5.1-5.2: a wired headset
// microphone (macOS "External Microphone", or a USB device), never Bluetooth. The built-in
// MacBook microphone with wired headphones is the last fallback reference of spec 5.1: accepted,
// with a warning. Names only: the page cannot see the jack.

export type MicVerdict = 'headset' | 'unknown' | 'builtin' | 'bluetooth' | 'webcam' | 'virtual' | 'missing';

export interface MicClass {
  verdict: MicVerdict;
  /** True for a microphone the doctor accepts: a headset, the built-in fallback, or a name it cannot judge. */
  ok: boolean;
  /** Plain words for the report. */
  reason: string;
}

/** What doctor prints when the built-in microphone is the reference (spec 5.1 fallback). */
export const BUILTIN_MIC_WARNING =
  'the built-in microphone is in use. Spec 5.1 allows it only as the last fallback, after the headset and a USB-C adapter with a 4-contact jack. ' +
  'If the headset is plugged in, choose its microphone in System Settings, Sound, Input and run npm run doctor again. ' +
  'If you go on with the built-in microphone: use it for every recording, wear wired headphones, press the earcup on the microphone hole of the case for the loop checks; ' +
  'voice onsets are coarser (20-30 ms instead of 10-20 ms) and a sniff may not rise above the noise';

/** Chrome prefixes the default device: "Default - MacBook Pro Microphone (Built-in)". */
export function stripDefaultPrefix(label: string): string {
  return label.replace(/^\s*(default|по умолчанию)\s*[-–—:]\s*/i, '').trim();
}

const BLUETOOTH = /bluetooth|airpods|beats|\bbt\b|bose|wh-1000|wf-1000|galaxy buds/i;
const PHONE = /iphone|ipad/i;
const WEBCAM = /webcam|camera|\bbrio\b|\bc9\d\d\b|facetime|studio display/i;
const VIRTUAL = /virtual|aggregate|blackhole|soundflower|loopback|zoom|teams|krisp|multi-output/i;
/** macOS names the 3.5 mm jack input "External Microphone (Built-in)": "(Built-in)" is the transport. */
const EXTERNAL = /external microphone|внешний микрофон|external mic/i;
const BUILTIN = /macbook|built-?in microphone|internal microphone|встроенн|\bimac\b|mac mini|mac studio/i;
const HEADSET = /headset|гарнитур|headphone|earphone|usb|\([0-9a-f]{4}:[0-9a-f]{4}\)/i;

/** Classifies the microphone name of manifest.json audio.microphone (hello settings label). */
export function classifyMicrophone(label: string | null | undefined): MicClass {
  if (typeof label !== 'string' || label.trim() === '') {
    return { verdict: 'missing', ok: false, reason: 'the page did not report a microphone name' };
  }
  const name = stripDefaultPrefix(label);
  if (BLUETOOTH.test(name)) return { verdict: 'bluetooth', ok: false, reason: `"${name}" is a Bluetooth device; Bluetooth audio is not allowed (spec 5.1)` };
  if (PHONE.test(name)) return { verdict: 'virtual', ok: false, reason: `"${name}" is a phone microphone, not the wired headset` };
  if (EXTERNAL.test(name)) return { verdict: 'headset', ok: true, reason: `"${name}" is the headset jack input` };
  if (WEBCAM.test(name)) return { verdict: 'webcam', ok: false, reason: `"${name}" is a camera microphone, not the headset` };
  if (VIRTUAL.test(name)) return { verdict: 'virtual', ok: false, reason: `"${name}" is a virtual or app device, not the headset` };
  if (BUILTIN.test(name)) return { verdict: 'builtin', ok: true, reason: `"${name}" is the built-in microphone, the fallback reference of spec 5.1` };
  if (HEADSET.test(name)) return { verdict: 'headset', ok: true, reason: `"${name}" is a wired or USB headset` };
  return { verdict: 'unknown', ok: true, reason: `"${name}" cannot be judged from its name; make sure it is the wired headset microphone` };
}

/** Output device problems (warnings only): Bluetooth or built-in speakers. Null when the name looks right or is unknown. */
export function outputWarning(name: string | null | undefined): string | null {
  if (typeof name !== 'string' || name.trim() === '') return 'the page did not report the output device';
  const n = stripDefaultPrefix(name);
  if (BLUETOOTH.test(n)) return `output "${n}" is Bluetooth; Bluetooth audio is not allowed (spec 5.1)`;
  if (/speakers?|динамик/i.test(n) && !EXTERNAL.test(n) && !HEADSET.test(n)) return `output "${n}" looks like speakers, not the headset`;
  return null;
}
