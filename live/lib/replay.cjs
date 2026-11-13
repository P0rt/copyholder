'use strict';
// live:from (spec 6.5): the SDK side of a recording, replayed in real time by the mock tap.
// detector_in.jsonl gives packets (batch) and validation codes (val) in processing order;
// stamps.jsonl gives each packet's recorded arrival sample nArr (`arr` lines) and the audio start (`chunk`).
const fs = require('node:fs');
const path = require('node:path');
const { validationName } = require('./sdk-codes.cjs');

function readJsonl(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object') out.push(v);
    } catch {
      // a torn last line after a crash
    }
  }
  return out;
}

function lastTs(tr) {
  const last = Array.isArray(tr) && tr.length > 0 ? tr[tr.length - 1] : null;
  return Array.isArray(last) && Number.isFinite(last[0]) ? last[0] : null;
}

/**
 * A detector_in line as the samples.jsonl line tap would have sent (no tArrNs yet: added when sent).
 * tsCbUs: the last trace timestamp of the packet, else `prevTsUs` (a `v` line has none of its own).
 */
function toTapLine(d, prevTsUs = 0) {
  if (d.k === 'batch') {
    return {
      seq: d.seq, k: 'm', tsCbUs: lastTs(d.tr) ?? prevTsUs, tr: d.tr ?? [], talk: d.talk ?? [],
      g: d.g ?? null, hm: d.hm ?? null, lm: null,
    };
  }
  return { seq: d.seq, k: 'v', tsCbUs: prevTsUs, code: d.code, name: validationName(d.code) };
}

/**
 * [{atMs, line}] in file order. atMs = (nArr - first audio sample) / 48 when stamps.jsonl has `arr`
 * lines, else from the trace timestamps; a line without its own time keeps the previous one.
 */
function loadReplay(sessionDir, sampleRateHz = 48000) {
  const det = readJsonl(path.join(sessionDir, 'detector_in.jsonl')).filter((d) => d.k === 'batch' || d.k === 'val');
  const stampsFile = path.join(sessionDir, 'stamps.jsonl');
  const stamps = fs.existsSync(stampsFile) ? readJsonl(stampsFile) : [];
  const nArr = new Map();
  let audioStart = null;
  for (const s of stamps) {
    if (s.k === 'arr' && Number.isFinite(s.n) && !nArr.has(s.seq)) nArr.set(s.seq, s.n);
    if (s.k === 'chunk' && Number.isFinite(s.n) && audioStart === null) audioStart = s.n;
  }
  const useArr = nArr.size > 0;
  let firstArr = Infinity;
  for (const n of nArr.values()) firstArr = Math.min(firstArr, n);
  const origin = useArr ? (audioStart ?? firstArr) : null;
  let firstTs = null;
  let prevAt = 0;
  let prevTsUs = 0;
  const out = [];
  for (const d of det) {
    let at = null;
    if (useArr) {
      if (nArr.has(d.seq)) at = ((nArr.get(d.seq) - origin) * 1000) / sampleRateHz;
    } else if (d.k === 'batch') {
      const ts = Array.isArray(d.tr) && Array.isArray(d.tr[0]) ? d.tr[0][0] : null;
      if (Number.isFinite(ts)) {
        if (firstTs === null) firstTs = ts;
        at = (ts - firstTs) / 1000;
      }
    }
    if (at === null || at < prevAt) at = prevAt;
    prevAt = at;
    const line = toTapLine(d, prevTsUs);
    prevTsUs = line.tsCbUs;
    out.push({ atMs: at, line });
  }
  return out;
}

module.exports = { readJsonl, toTapLine, loadReplay };
