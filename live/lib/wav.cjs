'use strict';
// audio.wav: 2 channels, float32, 48 kHz, interleaved; ch0 microphone, ch1 Deck output (spec 8.1).
// The header is 44 bytes. While recording both size fields hold 0xFFFFFFFF ("length unknown,
// read to the end of the file"); a clean close writes the real sizes. After a crash a reader
// takes the length from the file size, and repairWav() writes it into the header.
const fs = require('node:fs');
const { Readable } = require('node:stream');

const WAV_HEADER_BYTES = 44;
const FORMAT_PCM = 1;
const FORMAT_IEEE_FLOAT = 3;
const UNKNOWN_SIZE = 0xffffffff;
// The RIFF size field (36 + data bytes) must fit in 32 bits.
const MAX_DATA_BYTES = 0xffffffff - 64;

function riffSizeFor(dataOffset, dataBytes) {
  return dataOffset - 8 + dataBytes + (dataBytes & 1);
}

/** 44-byte WAV header. dataBytes null writes the "unknown length" marker. */
function wavHeader({ channels, sampleRate, bitsPerSample = 32, formatTag = FORMAT_IEEE_FLOAT, dataBytes = null }) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const known = dataBytes !== null && dataBytes !== undefined;
  const b = Buffer.alloc(WAV_HEADER_BYTES);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(known ? riffSizeFor(WAV_HEADER_BYTES, dataBytes) : UNKNOWN_SIZE, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(formatTag, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * blockAlign, 28);
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(bitsPerSample, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(known ? dataBytes : UNKNOWN_SIZE, 40);
  return b;
}

function writeAllSync(fd, buf, position) {
  let done = 0;
  while (done < buf.length) {
    done += fs.writeSync(fd, buf, done, buf.length - done, position + done);
  }
}

/** Appends interleaved float32 frames; never overwrites an existing file. */
class WavWriter {
  constructor(file, { channels = 2, sampleRateHz = 48000 } = {}) {
    this.file = file;
    this.channels = channels;
    this.sampleRateHz = sampleRateHz;
    this.blockAlign = channels * 4;
    this.dataBytes = 0;
    this.closed = false;
    this.fd = fs.openSync(file, 'wx');
    writeAllSync(this.fd, wavHeader({ channels, sampleRate: sampleRateHz, dataBytes: null }), 0);
  }

  get frames() {
    return this.dataBytes / this.blockAlign;
  }

  /** Returns false (and writes nothing) when the file would exceed the WAV size limit. */
  append(interleaved) {
    if (this.closed) throw new Error('audio.wav is closed');
    if (interleaved.length % this.blockAlign !== 0) throw new Error('partial audio frame');
    if (this.dataBytes + interleaved.length > MAX_DATA_BYTES) return false;
    writeAllSync(this.fd, interleaved, WAV_HEADER_BYTES + this.dataBytes);
    this.dataBytes += interleaved.length;
    return true;
  }

  /** Writes the real sizes into the header. */
  close() {
    if (this.closed) return;
    writeAllSync(this.fd, wavHeader({ channels: this.channels, sampleRate: this.sampleRateHz, dataBytes: this.dataBytes }), 0);
    fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);
    this.closed = true;
  }
}

/** Reads the header fields of a WAV file and the bytes really present after the data chunk start. */
function readWavInfo(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const fileBytes = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(fileBytes, 4096));
    fs.readSync(fd, head, 0, head.length, 0);
    if (head.length < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`${file} is not a RIFF/WAVE file`);
    }
    const riffBytes = head.readUInt32LE(4);
    let fmt = null;
    let dataOffset = -1;
    let dataBytes = -1;
    let off = 12;
    while (off + 8 <= head.length) {
      const id = head.toString('ascii', off, off + 4);
      const len = head.readUInt32LE(off + 4);
      if (id === 'fmt ' && off + 24 <= head.length) {
        fmt = {
          formatTag: head.readUInt16LE(off + 8),
          channels: head.readUInt16LE(off + 10),
          sampleRate: head.readUInt32LE(off + 12),
          byteRate: head.readUInt32LE(off + 16),
          blockAlign: head.readUInt16LE(off + 20),
          bitsPerSample: head.readUInt16LE(off + 22),
        };
      }
      if (id === 'data') {
        dataOffset = off + 8;
        dataBytes = len;
        break;
      }
      off += 8 + len + (len & 1);
    }
    if (!fmt || dataOffset < 0) throw new Error(`${file} has no fmt or data chunk`);
    const presentBytes = Math.max(0, fileBytes - dataOffset);
    const placeholder = dataBytes === UNKNOWN_SIZE || riffBytes === UNKNOWN_SIZE;
    return { fileBytes, riffBytes, dataOffset, dataBytes, presentBytes, placeholder, ...fmt };
  } finally {
    fs.closeSync(fd);
  }
}

/** True when sizes and format fields agree with each other and with the file. */
function isConsistentWav(info) {
  return !info.placeholder &&
    info.blockAlign === (info.channels * info.bitsPerSample) / 8 &&
    info.byteRate === info.sampleRate * info.blockAlign &&
    info.dataBytes % info.blockAlign === 0 &&
    info.dataBytes <= info.presentBytes &&
    info.riffBytes === riffSizeFor(info.dataOffset, info.dataBytes) &&
    info.riffBytes + 8 <= info.fileBytes;
}

/** Length of the audio in whole frames, using the file size when the header holds the marker. */
function usableDataBytes(info) {
  const bytes = info.placeholder ? info.presentBytes : Math.min(info.dataBytes, info.presentBytes);
  return bytes - (bytes % info.blockAlign);
}

/** Writes sizes taken from the file size into the header (after a crash). Returns the new info. */
function repairWav(file) {
  const info = readWavInfo(file);
  const whole = usableDataBytes({ ...info, placeholder: true });
  const fd = fs.openSync(file, 'r+');
  try {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(riffSizeFor(info.dataOffset, whole), 0);
    writeAllSync(fd, b, 4);
    b.writeUInt32LE(whole, 0);
    writeAllSync(fd, b, info.dataOffset - 4);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return readWavInfo(file);
}

/**
 * One channel of a multichannel WAV as a mono WAV with the same sample format, streamed.
 * Used for live-from: channel 0 of the recorded audio.wav stands in for the microphone (spec 6.5).
 */
function channelAsMonoWav(file, channel) {
  const info = readWavInfo(file);
  if (channel < 0 || channel >= info.channels) throw new Error(`no channel ${channel} in ${file}`);
  const bytesPerSample = info.bitsPerSample / 8;
  const frames = usableDataBytes(info) / info.blockAlign;
  const header = wavHeader({
    channels: 1, sampleRate: info.sampleRate, bitsPerSample: info.bitsPerSample,
    formatTag: info.formatTag, dataBytes: frames * bytesPerSample,
  });
  async function* body() {
    yield header;
    const fd = await fs.promises.open(file, 'r');
    try {
      const framesPerRead = 8192;
      const inBuf = Buffer.alloc(framesPerRead * info.blockAlign);
      for (let f = 0; f < frames; f += framesPerRead) {
        const n = Math.min(framesPerRead, frames - f);
        const { bytesRead } = await fd.read(inBuf, 0, n * info.blockAlign, info.dataOffset + f * info.blockAlign);
        const got = Math.floor(bytesRead / info.blockAlign);
        const out = Buffer.alloc(got * bytesPerSample);
        for (let i = 0; i < got; i++) {
          inBuf.copy(out, i * bytesPerSample, i * info.blockAlign + channel * bytesPerSample,
            i * info.blockAlign + (channel + 1) * bytesPerSample);
        }
        yield out;
        if (got < n) break;
      }
    } finally {
      await fd.close();
    }
  }
  return { length: header.length + frames * bytesPerSample, stream: Readable.from(body()) };
}

module.exports = {
  WAV_HEADER_BYTES, FORMAT_PCM, FORMAT_IEEE_FLOAT, UNKNOWN_SIZE, MAX_DATA_BYTES,
  wavHeader, WavWriter, readWavInfo, isConsistentWav, usableDataBytes, repairWav, channelAsMonoWav,
};

// After a crash: node live/lib/wav.cjs repair sessions/<id>/audio.wav
if (require.main === module) {
  const [cmd, file] = process.argv.slice(2);
  if (cmd !== 'repair' || !file) {
    process.stdout.write('Usage: node live/lib/wav.cjs repair <audio.wav>\n');
    process.exitCode = 2;
  } else {
    const before = readWavInfo(file);
    if (isConsistentWav(before)) {
      process.stdout.write(`${file} is fine: ${before.dataBytes / before.blockAlign} frames.\n`);
    } else {
      const after = repairWav(file);
      process.stdout.write(`${file} repaired: ${after.dataBytes / after.blockAlign} frames.\n`);
    }
  }
}
