// WAV formats by file kind (spec 8.1, 8.2, 8.7) and the sealed .enc layout (spec 8.2).
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CLIP_AFTER_SAMPLES, CLIP_BEFORE_SAMPLES, ENC_NONCE_BYTES, ENC_TAG_BYTES, HOST_DECRYPTABLE, SEALED_FOLDER_FILES,
  checkWavFormat, hostMayDecrypt, joinEncParts, splitEncBytes, wavEncoding,
} from './index.ts';

const float = (channels: number, sampleRateHz = 48000) => ({ formatTag: 3, channels, sampleRateHz, bitsPerSample: 32 });
const int16 = (channels: number, sampleRateHz = 48000) => ({ formatTag: 1, channels, sampleRateHz, bitsPerSample: 16 });

describe('WAV formats', () => {
  it('session audio: 2 channels, float32, 48 kHz (spec 8.1)', () => {
    expect(checkWavFormat('session', float(2))).toEqual([]);
    expect(checkWavFormat('session', int16(1, 44100))).toEqual([
      'audio.wav of a recording (spec 8.1): expected 2 channel(s), got 1',
      'audio.wav of a recording (spec 8.1): expected 48000 Hz, got 44100',
      'audio.wav of a recording (spec 8.1): expected float32 samples, got int16',
    ]);
  });

  it('narrator mono float32; published audio 16 bit; clips either', () => {
    expect(checkWavFormat('narrator', float(1))).toEqual([]);
    expect(checkWavFormat('published', int16(2))).toEqual([]);
    expect(checkWavFormat('published', float(2))).toEqual(['audio.wav in data/<id>/ (spec 8.7): expected int16 samples, got float32']);
    expect(checkWavFormat('clip', float(1))).toEqual([]);
    expect(checkWavFormat('clip', int16(1))).toEqual([]);
    expect(checkWavFormat('clip', { formatTag: 1, channels: 1, sampleRateHz: 48000, bitsPerSample: 24 })).toEqual([
      'a clip in data/<id>/clips/ (spec 8.7): expected float32 or int16 samples, got format 1, 24 bit',
    ]);
    expect(wavEncoding({ formatTag: 0xfffe, bitsPerSample: 32 })).toBeNull();
    expect((CLIP_BEFORE_SAMPLES + CLIP_AFTER_SAMPLES) / 48000).toBe(2);
  });
});

describe('sealed folder (spec 8.2)', () => {
  it('host may decrypt narrator audio and timings only', () => {
    for (const name of SEALED_FOLDER_FILES) {
      expect(hostMayDecrypt(name), name).toBe((HOST_DECRYPTABLE as readonly string[]).includes(name));
    }
    for (const name of ['plan.json.enc', 'texts.json.enc', 'score.json.enc', 'planter.log.enc', 'audio/../plan.json.enc', 'p1.wav.enc']) {
      expect(hostMayDecrypt(name), name).toBe(false);
    }
    expect(hostMayDecrypt('audio\\p2.wav.enc')).toBe(true);
  });

  it('a .enc file is nonce, ciphertext and tag; split and join are inverse', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: ENC_NONCE_BYTES + ENC_TAG_BYTES, maxLength: 200 }), (bytes) => {
        const parts = splitEncBytes(bytes);
        expect(parts.nonce).toHaveLength(12);
        expect(parts.tag).toHaveLength(16);
        expect(parts.ciphertext).toHaveLength(bytes.length - 28);
        expect(joinEncParts(parts)).toEqual(bytes);
      }),
      { numRuns: 100 },
    );
    expect(() => splitEncBytes(new Uint8Array(27))).toThrow(/27 bytes is too short \(spec 8\.2\)/);
    expect(() => joinEncParts({ nonce: new Uint8Array(8), ciphertext: new Uint8Array(0), tag: new Uint8Array(16) })).toThrow(/nonce must be 12 bytes/);
  });
});
