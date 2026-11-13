// Binary files of spec section 8: the WAV formats of each audio file (8.1, 8.2, 8.7) and the
// layout of the sealed .enc files (8.2). Pure: callers read bytes or WAV headers themselves
// (analysis/lib/wav.ts, live/lib/wav.cjs); this file only says what is allowed.

import { SAMPLE_RATE_HZ } from './precision.ts';

export const WAV_FORMAT_PCM = 1;
export const WAV_FORMAT_IEEE_FLOAT = 3;

/** The fmt chunk fields that decide the format. */
export interface WavFormat {
  formatTag: number;
  channels: number;
  sampleRateHz: number;
  bitsPerSample: number;
}

export type WavEncoding = 'float32' | 'int16';

export interface WavExpectation {
  what: string;
  channels: number;
  sampleRateHz: number;
  encodings: readonly WavEncoding[];
  spec: string;
}

/**
 * Allowed WAV formats by file kind. Session audio: 2 channels, float32, 48 kHz, ch0 microphone,
 * ch1 narrator output (8.1). Narrator audio: mono 48 kHz, float32 as tools/tts writes it (8.2).
 * Published audio: both channels, 16 bit (8.7). Clips: channel 0 only; the sample format is
 * not fixed by the spec (assumption: float32 or 16 bit).
 */
export const WAV_FILES = {
  session: { what: 'audio.wav of a recording', channels: 2, sampleRateHz: SAMPLE_RATE_HZ, encodings: ['float32'], spec: '8.1' },
  narrator: { what: 'narrator audio', channels: 1, sampleRateHz: SAMPLE_RATE_HZ, encodings: ['float32'], spec: '8.2' },
  published: { what: 'audio.wav in data/<id>/', channels: 2, sampleRateHz: SAMPLE_RATE_HZ, encodings: ['int16'], spec: '8.7' },
  clip: { what: 'a clip in data/<id>/clips/', channels: 1, sampleRateHz: SAMPLE_RATE_HZ, encodings: ['float32', 'int16'], spec: '8.7' },
} as const satisfies Record<string, WavExpectation>;

export type WavKind = keyof typeof WAV_FILES;

/** float32 (IEEE float, 32 bit), int16 (PCM, 16 bit), or null for anything else. */
export function wavEncoding(f: Pick<WavFormat, 'formatTag' | 'bitsPerSample'>): WavEncoding | null {
  if (f.formatTag === WAV_FORMAT_IEEE_FLOAT && f.bitsPerSample === 32) return 'float32';
  if (f.formatTag === WAV_FORMAT_PCM && f.bitsPerSample === 16) return 'int16';
  return null;
}

/** Problems of a WAV format for a file kind; empty when it matches. */
export function checkWavFormat(kind: WavKind, f: WavFormat): string[] {
  const want: WavExpectation = WAV_FILES[kind];
  const problems: string[] = [];
  const at = `${want.what} (spec ${want.spec})`;
  if (f.channels !== want.channels) problems.push(`${at}: expected ${want.channels} channel(s), got ${f.channels}`);
  if (f.sampleRateHz !== want.sampleRateHz) problems.push(`${at}: expected ${want.sampleRateHz} Hz, got ${f.sampleRateHz}`);
  const enc = wavEncoding(f);
  if (enc === null || !want.encodings.includes(enc)) {
    const got = enc ?? `format ${f.formatTag}, ${f.bitsPerSample} bit`;
    problems.push(`${at}: expected ${want.encodings.join(' or ')} samples, got ${got}`);
  }
  return problems;
}

/** Length of a published clip: 1.5 s before t_v to 0.5 s after it (spec 8.7). */
export const CLIP_BEFORE_SAMPLES = 72_000;
export const CLIP_AFTER_SAMPLES = 24_000;

// ---- sealed folder (spec 8.2) ---------------------------------------------------------

/** AES-256-GCM file: 12-byte nonce, ciphertext, 16-byte tag (spec 8.2). */
export const ENC_NONCE_BYTES = 12;
export const ENC_TAG_BYTES = 16;
/** Key: 32 random bytes in the macOS keychain under this name (spec 8.2). */
export const SEAL_KEY_BYTES = 32;
export const SEAL_KEYCHAIN_NAME = 'copyholder-seal';

/** Files of sealed/<id>/ (spec 8.2). Only commitment.txt is plain text. */
export const SEALED_FOLDER_FILES = [
  'plan.json.enc', 'texts.json.enc', 'audio/opening.wav.enc', 'audio/p1.wav.enc', 'audio/p2.wav.enc',
  'audio/p3.wav.enc', 'timings.json.enc', 'score.json.enc', 'planter.log.enc', 'commitment.txt',
] as const;

/** The only sealed files host may decrypt, in memory, in live mode (spec 8.2). */
export const HOST_DECRYPTABLE = [
  'audio/opening.wav.enc', 'audio/p1.wav.enc', 'audio/p2.wav.enc', 'audio/p3.wav.enc', 'timings.json.enc',
] as const;

/** True for a sealed file host may read; plan, texts, score and the planter log never (spec 8.2). */
export function hostMayDecrypt(name: string): boolean {
  return (HOST_DECRYPTABLE as readonly string[]).includes(name.replace(/\\/g, '/'));
}

export interface EncParts {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
}

/** Splits the bytes of a .enc file into nonce, ciphertext and tag (views, no copy). Throws when too short. */
export function splitEncBytes(bytes: Uint8Array): EncParts {
  const min = ENC_NONCE_BYTES + ENC_TAG_BYTES;
  if (bytes.length < min) {
    throw new Error(`a .enc file holds a ${ENC_NONCE_BYTES}-byte nonce and a ${ENC_TAG_BYTES}-byte tag: ${bytes.length} bytes is too short (spec 8.2)`);
  }
  return {
    nonce: bytes.subarray(0, ENC_NONCE_BYTES),
    ciphertext: bytes.subarray(ENC_NONCE_BYTES, bytes.length - ENC_TAG_BYTES),
    tag: bytes.subarray(bytes.length - ENC_TAG_BYTES),
  };
}

/** The bytes of a .enc file from its parts (the reverse of splitEncBytes). */
export function joinEncParts(p: EncParts): Uint8Array {
  if (p.nonce.length !== ENC_NONCE_BYTES) throw new Error(`nonce must be ${ENC_NONCE_BYTES} bytes, got ${p.nonce.length}`);
  if (p.tag.length !== ENC_TAG_BYTES) throw new Error(`tag must be ${ENC_TAG_BYTES} bytes, got ${p.tag.length}`);
  const out = new Uint8Array(p.nonce.length + p.ciphertext.length + p.tag.length);
  out.set(p.nonce, 0);
  out.set(p.ciphertext, p.nonce.length);
  out.set(p.tag, p.nonce.length + p.ciphertext.length);
  return out;
}
