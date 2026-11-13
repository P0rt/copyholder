// audio.wav header (spec 8.1), CHK1 blocks (docs/protocol.md) and the ledger chain (spec 8.5).
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireCjs } from './helpers.ts';

interface WavInfo {
  fileBytes: number;
  riffBytes: number;
  dataOffset: number;
  dataBytes: number;
  presentBytes: number;
  placeholder: boolean;
  formatTag: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
}
interface Writer {
  fd: number;
  frames: number;
  append(b: Buffer): boolean;
  close(): void;
}
const wav = requireCjs('../../live/lib/wav.cjs') as {
  UNKNOWN_SIZE: number;
  WavWriter: new (file: string, opts?: { channels?: number; sampleRateHz?: number }) => Writer;
  readWavInfo(file: string): WavInfo;
  isConsistentWav(info: WavInfo): boolean;
  repairWav(file: string): WavInfo;
  channelAsMonoWav(file: string, channel: number): { length: number; stream: AsyncIterable<Buffer> };
};
const blocks = requireCjs('../../live/lib/audio-block.cjs') as {
  encodeAudioBlock(n0: number, ch0: ArrayLike<number>, ch1: ArrayLike<number>): Buffer;
  parseAudioBlock(b: Buffer): { frames?: number; n0?: number; planar?: Buffer; error?: string };
  interleaveStereoBytes(planar: Buffer, frames: number): Buffer;
  checkBlockContinuity(prev: { n0: number; frames: number } | null, n0: number): { ok: boolean; expectedN0: number };
};
const ledger = requireCjs('../../live/lib/ledger.cjs') as {
  ZERO_HASH: string;
  utcSeconds(d: Date): string;
  formatLedgerLine(e: { i: number; step: string; utc: string; commit: string | null; outSha256: Record<string, string>; exploratory?: boolean; prev: string }): string;
  appendLedgerStep(dir: string, e: { step: string; commit: string | null; outSha256: Record<string, string>; exploratory?: boolean; date: Date }): string;
  verifyLedgerText(text: string): { ok: boolean; lines: string[]; error: string | null };
};

function stereo(frames: number, start: number): Buffer {
  const b = Buffer.alloc(frames * 8);
  for (let i = 0; i < frames; i++) {
    b.writeFloatLE((start + i) / 1024, i * 8);
    b.writeFloatLE(-(start + i) / 2048, i * 8 + 4);
  }
  return b;
}

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of stream) parts.push(p);
  return Buffer.concat(parts);
}

describe('audio.wav writer', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'copyholder-wav-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the unknown-length marker while open and real sizes on close', () => {
    const file = join(dir, 'audio.wav');
    const w = new wav.WavWriter(file);
    w.append(stereo(9600, 0));
    const open = wav.readWavInfo(file);
    expect(open.placeholder).toBe(true);
    expect(open.riffBytes).toBe(wav.UNKNOWN_SIZE);
    expect(open.dataBytes).toBe(wav.UNKNOWN_SIZE);
    w.append(stereo(4800, 9600));
    w.close();
    const info = wav.readWavInfo(file);
    expect(wav.isConsistentWav(info)).toBe(true);
    expect(info).toMatchObject({
      formatTag: 3, channels: 2, sampleRate: 48000, byteRate: 384000, blockAlign: 8, bitsPerSample: 32,
      dataOffset: 44, dataBytes: 14400 * 8, riffBytes: 36 + 14400 * 8, fileBytes: 44 + 14400 * 8,
    });
    const bytes = readFileSync(file);
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(bytes.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(bytes.toString('ascii', 36, 40)).toBe('data');
    expect(bytes.readFloatLE(44 + 9600 * 8)).toBe(9600 / 1024);
  });

  it('never overwrites a file and refuses partial frames', () => {
    const file = join(dir, 'audio.wav');
    writeFileSync(file, 'keep me');
    expect(() => new wav.WavWriter(file)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('keep me');
    const w = new wav.WavWriter(join(dir, 'b.wav'));
    expect(() => w.append(Buffer.alloc(12))).toThrow(/partial/);
    w.close();
  });

  it('is repaired from the file size after a crash, even with a torn last frame', () => {
    const file = join(dir, 'audio.wav');
    const w = new wav.WavWriter(file);
    w.append(stereo(9600, 0));
    w.append(stereo(9600, 9600));
    closeSync(w.fd); // the process died: no close(), the header keeps the marker
    appendFileSync(file, Buffer.alloc(5)); // half a frame written at the moment of the crash
    const before = wav.readWavInfo(file);
    expect(before.placeholder).toBe(true);
    expect(wav.isConsistentWav(before)).toBe(false);
    const after = wav.repairWav(file);
    expect(wav.isConsistentWav(after)).toBe(true);
    expect(after.dataBytes).toBe(19200 * 8);
    expect(readFileSync(file).readFloatLE(44 + 19199 * 8)).toBe(19199 / 1024);
  });

  it('extracts one channel as a mono WAV (live-from microphone)', async () => {
    const file = join(dir, 'audio.wav');
    const w = new wav.WavWriter(file);
    w.append(stereo(10000, 0));
    w.close();
    for (const ch of [0, 1]) {
      const { length, stream } = wav.channelAsMonoWav(file, ch);
      const out = await collect(stream);
      expect(out.length).toBe(length);
      const mono = join(dir, `ch${ch}.wav`);
      writeFileSync(mono, out);
      const info = wav.readWavInfo(mono);
      expect(wav.isConsistentWav(info)).toBe(true);
      expect(info).toMatchObject({ channels: 1, sampleRate: 48000, bitsPerSample: 32, formatTag: 3, dataBytes: 40000 });
      expect(out.readFloatLE(44 + 4 * 1234)).toBe(ch === 0 ? 1234 / 1024 : -1234 / 2048);
    }
  });
});

describe('CHK1 audio blocks', () => {
  it('round-trips and interleaves planar channels', () => {
    const b = blocks.encodeAudioBlock(19200, [0.5, 0.25, -1], [0.125, -0.5, 1]);
    const p = blocks.parseAudioBlock(b);
    expect(p).toMatchObject({ frames: 3, n0: 19200 });
    const inter = blocks.interleaveStereoBytes(p.planar ?? Buffer.alloc(0), 3);
    const vals = Array.from({ length: 6 }, (_, i) => inter.readFloatLE(i * 4));
    expect(vals).toEqual([0.5, 0.125, 0.25, -0.5, -1, 1]);
  });

  it('rejects malformed blocks', () => {
    const good = blocks.encodeAudioBlock(0, [0, 0], [0, 0]);
    expect(blocks.parseAudioBlock(Buffer.alloc(8)).error).toBeTruthy();
    const badMagic = Buffer.from(good);
    badMagic.write('XXXX', 0, 'ascii');
    expect(blocks.parseAudioBlock(badMagic).error).toBe('bad magic');
    expect(blocks.parseAudioBlock(good.subarray(0, good.length - 4)).error).toMatch(/does not match/);
    const badN0 = Buffer.from(good);
    badN0.writeDoubleLE(1.5, 8);
    expect(blocks.parseAudioBlock(badN0).error).toMatch(/n0/);
  });

  it('checks n0 continuity', () => {
    expect(blocks.checkBlockContinuity(null, 4800)).toEqual({ ok: true, expectedN0: 4800 });
    expect(blocks.checkBlockContinuity({ n0: 0, frames: 9600 }, 9600)).toEqual({ ok: true, expectedN0: 9600 });
    expect(blocks.checkBlockContinuity({ n0: 0, frames: 9600 }, 19200).ok).toBe(false);
    expect(blocks.checkBlockContinuity({ n0: 9600, frames: 9600 }, 0).ok).toBe(false); // a restart (reload)
  });
});

describe('ledger.jsonl', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'copyholder-ledger-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('formats lines in the spec order and chains them by SHA-256 of the previous line', () => {
    const date = new Date(Date.UTC(2026, 10, 14, 9, 12, 40, 123));
    expect(ledger.utcSeconds(date)).toBe('2026-11-14T09:12:40Z');
    const l0 = ledger.appendLedgerStep(dir, { step: 'record', commit: '1a2b3c4', outSha256: { 'b.json': 'b'.repeat(64), 'a.json': 'a'.repeat(64) }, date });
    expect(l0).toBe(
      `{"i":0,"step":"record","utc":"2026-11-14T09:12:40Z","commit":"1a2b3c4","out_sha256":{"a.json":"${'a'.repeat(64)}","b.json":"${'b'.repeat(64)}"},"exploratory":false,"prev":"${'0'.repeat(64)}"}`,
    );
    const l1 = ledger.appendLedgerStep(dir, { step: 'quickcheck', commit: '1a2b3c4', outSha256: {}, date });
    const row1 = JSON.parse(l1) as { i: number; prev: string };
    expect(row1.i).toBe(1);
    expect(row1.prev).toBe(createHash('sha256').update(l0).digest('hex'));
    const text = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
    expect(text).toBe(`${l0}\n${l1}\n`);
    expect(ledger.verifyLedgerText(text).ok).toBe(true);
  });

  it('detects an edited line', () => {
    const date = new Date(0);
    ledger.appendLedgerStep(dir, { step: 'record', commit: 'abcdef0', outSha256: { 'x': '1'.repeat(64) }, date });
    ledger.appendLedgerStep(dir, { step: 'quickcheck', commit: 'abcdef0', outSha256: {}, date });
    const file = join(dir, 'ledger.jsonl');
    const edited = readFileSync(file, 'utf8').replace('1'.repeat(64), '2'.repeat(64));
    const check = ledger.verifyLedgerText(edited);
    expect(check.ok).toBe(false);
    expect(check.error).toMatch(/line 2/);
    writeFileSync(file, edited);
    expect(() => ledger.appendLedgerStep(dir, { step: 'clocks', commit: 'abcdef0', outSha256: {}, date })).toThrow(/hash chain/);
  });
});
