// Blind label page (spec 7.6): one item at a time in the order the server chose, the microphone
// channel only, from 1 s before the dot signal to 1 s past the 10 s the voice may take to begin.
// The page never gets the narrator channel, the breathing trace, stops, detector marks or the
// automatic onset: only the window's samples. Three views: the whole window, 1 s around the mark
// (both waveform and spectrogram) and 20 ms on each side of it; the mark is a whole sample.
// Plain module, no build step, no framework.

const KEY_KIND = { s: 'speech', c: 'cough', l: 'laugh', t: 'throat', o: 'other', n: 'none' };
const WAVE_TOP = 0;
const WAVE_HEIGHT = 120;
const SPEC_TOP = 128;
const DETAIL_WAVE_HEIGHT = 96;
const DETAIL_SPEC_TOP = 104;
const DETAIL_MS = 1000;
const FFT_SIZE = 1024;
const SPEC_MAX_HZ = 8000;
const SPEC_RANGE_DB = 80;
const ZOOM_HALF_MS = 20;

const $ = (id) => document.getElementById(id);

const st = {
  info: null,
  pos: 0,
  samples: null,
  mark: null,
  kind: null,
  spectrogram: null,
  detailFrom: 0,
  detailSpec: null,
  detailSpecFrom: -1,
  ctx: null,
  source: null,
  playStart: 0,
  playFrom: 0,
  busy: false,
};

async function api(path, body) {
  const init = body === undefined
    ? { cache: 'no-store', credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, init);
  const type = res.headers.get('content-type') || '';
  const data = type.startsWith('application/json') ? await res.json() : null;
  if (!res.ok) throw new Error((data && data.error) || `the server answered ${res.status}`);
  return data;
}

function setStatus(text, isError = false) {
  const s = $('status');
  s.textContent = text;
  s.classList.toggle('error', isError);
}

function windowLength() {
  return st.info.beforeSamples + st.info.afterSamples;
}

function rate() {
  return st.info.sampleRateHz;
}

function detailLength() {
  return Math.min(windowLength(), Math.round((DETAIL_MS * rate()) / 1000));
}

/** Seconds after the dot of a window sample, as text: "+5.300 s" or "-0.250 s". */
function afterDot(n, digits = 3) {
  const s = (n - st.info.beforeSamples) / rate();
  return `${s >= 0 ? '+' : '-'}${Math.abs(s).toFixed(digits)} s`;
}

// ---- spectrogram ---------------------------------------------------------------------------

function makeFft(n) {
  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const a = i + j;
          const b = a + half;
          const tr = re[b] * cos[k] - im[b] * sin[k];
          const ti = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  };
}

const fft = makeFft(FFT_SIZE);
const hann = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));

/** Samples [from, from + span) with one column per canvas pixel: Hann window of 1024 samples centred on the column, 0-8 kHz, dB. */
function computeSpectrogram(samples, from, span, width, height) {
  const len = samples.length;
  const binHz = rate() / FFT_SIZE;
  const maxBin = Math.min(FFT_SIZE / 2, Math.ceil(SPEC_MAX_HZ / binHz));
  const db = new Float32Array(width * (maxBin + 1));
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  let top = -Infinity;
  for (let x = 0; x < width; x++) {
    const centre = from + Math.floor(((x + 0.5) * span) / width);
    for (let i = 0; i < FFT_SIZE; i++) {
      const n = centre - FFT_SIZE / 2 + i;
      re[i] = n >= 0 && n < len ? samples[n] * hann[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b <= maxBin; b++) {
      const v = 10 * Math.log10(re[b] * re[b] + im[b] * im[b] + 1e-20);
      db[x * (maxBin + 1) + b] = v;
      if (v > top) top = v;
    }
  }
  const image = new ImageData(width, height);
  for (let y = 0; y < height; y++) {
    const hz = (1 - y / (height - 1)) * SPEC_MAX_HZ;
    const b = Math.min(maxBin, Math.max(0, Math.round(hz / binHz)));
    for (let x = 0; x < width; x++) {
      const t = Math.min(1, Math.max(0, (db[x * (maxBin + 1) + b] - (top - SPEC_RANGE_DB)) / SPEC_RANGE_DB));
      const g = Math.round(255 * (1 - t));
      const p = 4 * (y * width + x);
      image.data[p] = g;
      image.data[p + 1] = g;
      image.data[p + 2] = g;
      image.data[p + 3] = 255;
    }
  }
  return image;
}

// ---- drawing ---------------------------------------------------------------------------------

function cssColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#000';
}

function drawWave(g, samples, from, to, top, height, width) {
  let peak = 1e-9;
  for (let n = Math.max(0, from); n < Math.min(samples.length, to); n++) peak = Math.max(peak, Math.abs(samples[n]));
  const mid = top + height / 2;
  const scale = (0.45 * height) / peak;
  g.strokeStyle = cssColor('--line');
  g.beginPath();
  g.moveTo(0, mid);
  g.lineTo(width, mid);
  g.stroke();
  g.strokeStyle = cssColor('--fg');
  g.beginPath();
  const span = to - from;
  if (span <= width * 2) {
    for (let n = from; n < to; n++) {
      const x = ((n - from + 0.5) / span) * width;
      const v = n >= 0 && n < samples.length ? samples[n] : 0;
      if (n === from) g.moveTo(x, mid - v * scale);
      else g.lineTo(x, mid - v * scale);
    }
  } else {
    for (let x = 0; x < width; x++) {
      const a = from + Math.floor((x * span) / width);
      const b = Math.max(a + 1, from + Math.floor(((x + 1) * span) / width));
      let lo = 0;
      let hi = 0;
      for (let n = Math.max(0, a); n < Math.min(samples.length, b); n++) {
        const v = samples[n];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      g.moveTo(x + 0.5, mid - hi * scale);
      g.lineTo(x + 0.5, mid - lo * scale + 1);
    }
  }
  g.stroke();
}

function vline(g, x, top, bottom, color, dashed) {
  g.save();
  g.strokeStyle = color;
  g.lineWidth = 2;
  if (dashed) g.setLineDash([5, 4]);
  g.beginPath();
  g.moveTo(x, top);
  g.lineTo(x, bottom);
  g.stroke();
  g.restore();
}

function drawOverview(playhead = null) {
  const c = $('overview');
  const g = c.getContext('2d');
  const w = c.width;
  const len = windowLength();
  g.fillStyle = cssColor('--panel');
  g.fillRect(0, 0, w, c.height);
  drawWave(g, st.samples, 0, len, WAVE_TOP, WAVE_HEIGHT, w);
  if (st.spectrogram) g.putImageData(st.spectrogram, 0, SPEC_TOP);
  if (st.mark !== null) {
    // The stretch the detail view shows.
    g.save();
    g.globalAlpha = 0.15;
    g.fillStyle = cssColor('--chosen');
    g.fillRect((st.detailFrom / len) * w, 0, Math.max(2, (detailLength() / len) * w), c.height);
    g.restore();
  }
  const xCue = (st.info.beforeSamples / len) * w;
  vline(g, xCue, 0, c.height, cssColor('--muted'), true);
  g.fillStyle = cssColor('--muted');
  g.font = '12px ui-monospace, Menlo, monospace';
  g.fillText('dot', xCue + 4, 12);
  g.fillText('8 kHz', 4, SPEC_TOP + 12);
  if (st.mark !== null) vline(g, ((st.mark + 0.5) / len) * w, 0, c.height, cssColor('--accent'), false);
  if (playhead !== null) vline(g, (playhead / len) * w, 0, c.height, cssColor('--chosen'), false);
}

/** Puts the detail view's stretch around the mark when the mark is near its edge or outside it. */
function followMark(force) {
  const len = windowLength();
  const span = detailLength();
  const from = st.detailFrom;
  const margin = Math.round(span / 10);
  if (!force && st.mark >= from + margin && st.mark < from + span - margin) return;
  st.detailFrom = Math.min(len - span, Math.max(0, st.mark - Math.round(span / 2)));
}

function drawDetail() {
  const c = $('detail');
  const g = c.getContext('2d');
  const w = c.width;
  g.fillStyle = cssColor('--panel');
  g.fillRect(0, 0, w, c.height);
  if (st.mark === null) {
    delete c.dataset.from;
    delete c.dataset.span;
    g.fillStyle = cssColor('--muted');
    g.font = '14px -apple-system, Arial, sans-serif';
    g.fillText('Click the whole window above; this view then shows 1 s around the mark.', 12, c.height / 2);
    return;
  }
  const span = detailLength();
  const from = st.detailFrom;
  // The stretch shown, as window samples (read by the browser test).
  c.dataset.from = String(from);
  c.dataset.span = String(span);
  if (st.detailSpecFrom !== from || st.detailSpec === null) {
    st.detailSpec = computeSpectrogram(st.samples, from, span, w, c.height - DETAIL_SPEC_TOP);
    st.detailSpecFrom = from;
  }
  drawWave(g, st.samples, from, from + span, 0, DETAIL_WAVE_HEIGHT, w);
  g.putImageData(st.detailSpec, 0, DETAIL_SPEC_TOP);
  const xOf = (n) => ((n - from + 0.5) / span) * w;
  const cue = st.info.beforeSamples;
  if (cue >= from && cue < from + span) vline(g, xOf(cue), 0, c.height, cssColor('--muted'), true);
  g.fillStyle = cssColor('--muted');
  g.font = '11px ui-monospace, Menlo, monospace';
  const step = Math.round(rate() / 10);
  for (let n = Math.ceil((from - cue) / step) * step + cue; n < from + span; n += step) {
    const x = xOf(n);
    g.fillRect(x, DETAIL_WAVE_HEIGHT - 6, 1, 6);
    g.fillText(afterDot(n, 1), Math.min(w - 52, Math.max(0, x - 22)), DETAIL_WAVE_HEIGHT - 8);
  }
  vline(g, xOf(st.mark), 0, c.height, cssColor('--accent'), false);
}

function zoomHalf() {
  return Math.round((ZOOM_HALF_MS * rate()) / 1000);
}

function drawZoom() {
  const c = $('zoom');
  const g = c.getContext('2d');
  const w = c.width;
  g.fillStyle = cssColor('--panel');
  g.fillRect(0, 0, w, c.height);
  if (st.mark === null) {
    g.fillStyle = cssColor('--muted');
    g.font = '14px -apple-system, Arial, sans-serif';
    g.fillText('Click the picture above to place the mark; this view then shows 20 ms on each side of it.', 12, c.height / 2);
    return;
  }
  const half = zoomHalf();
  const from = st.mark - half;
  const to = st.mark + half;
  drawWave(g, st.samples, from, to, 4, c.height - 20, w);
  g.fillStyle = cssColor('--muted');
  g.font = '11px ui-monospace, Menlo, monospace';
  const perMs = rate() / 1000;
  for (let k = -ZOOM_HALF_MS; k <= ZOOM_HALF_MS; k += 5) {
    const x = ((half + k * perMs + 0.5) / (2 * half)) * w;
    g.fillRect(x, c.height - 16, 1, 5);
    g.fillText(`${k > 0 ? '+' : ''}${k} ms`, Math.min(w - 40, Math.max(0, x - 14)), c.height - 2);
  }
  vline(g, ((half + 0.5) / (2 * half)) * w, 0, c.height - 18, cssColor('--accent'), false);
}

function drawAxis() {
  const axis = $('axis');
  axis.textContent = '';
  const len = windowLength();
  const r = rate();
  const firstS = -Math.floor(st.info.beforeSamples / r);
  const lastS = Math.floor(st.info.afterSamples / r);
  for (let s = firstS; s <= lastS; s++) {
    const n = st.info.beforeSamples + s * r;
    if (n < 0 || n > len) continue;
    const span = document.createElement('span');
    span.textContent = `${s > 0 ? '+' : ''}${s} s`;
    span.style.left = `${(100 * n) / len}%`;
    axis.appendChild(span);
  }
}

function updateReadout() {
  const r = $('readout');
  if (st.mark === null) {
    r.textContent = 'No mark yet';
    delete r.dataset.offset;
    return;
  }
  const s = (st.mark - st.info.beforeSamples) / rate();
  const when = s >= 0 ? `${s.toFixed(4)} s after the dot` : `${(-s).toFixed(4)} s before the dot`;
  r.textContent = `Mark at ${when} (sample ${st.mark} of the ${windowLength()} shown)`;
  r.dataset.offset = String(st.mark);
}

function updateKinds() {
  for (const b of document.querySelectorAll('button.kind')) b.setAttribute('aria-checked', String(b.dataset.label === st.kind));
}

function redraw() {
  drawOverview();
  drawDetail();
  drawZoom();
  updateReadout();
  updateKinds();
  const done = st.info.marks.filter((m) => m !== null).length;
  $('counter').textContent = `Event ${st.pos + 1} of ${st.info.count} · ${done} saved${st.info.exploratory ? ' · exploratory run' : ''}`;
  $('back').disabled = st.pos === 0 || st.busy;
}

// ---- playback ---------------------------------------------------------------------------------

function stopPlayback() {
  if (st.source) {
    try {
      st.source.stop();
    } catch {
      // already stopped
    }
    st.source = null;
  }
}

async function play(fromSample, toSample = windowLength()) {
  stopPlayback();
  if (!st.ctx) st.ctx = new AudioContext();
  if (st.ctx.state === 'suspended') await st.ctx.resume();
  const buffer = st.ctx.createBuffer(1, st.samples.length, rate());
  buffer.copyToChannel(st.samples, 0);
  const src = st.ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(st.ctx.destination);
  src.onended = () => {
    if (st.source === src) {
      st.source = null;
      drawOverview();
    }
  };
  st.source = src;
  st.playStart = st.ctx.currentTime;
  st.playFrom = fromSample;
  src.start(0, fromSample / rate(), Math.max(0, toSample - fromSample) / rate());
  const tick = () => {
    if (st.source !== src) return;
    const n = st.playFrom + (st.ctx.currentTime - st.playStart) * rate();
    drawOverview(Math.min(n, windowLength()));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---- events -------------------------------------------------------------------------------------

function canvasX(canvas, ev) {
  const rect = canvas.getBoundingClientRect();
  return ((ev.clientX - rect.left) * canvas.width) / rect.width;
}

function setMark(n, recentre = false) {
  st.mark = Math.min(windowLength() - 1, Math.max(0, Math.round(n)));
  if (st.kind === 'none') st.kind = null;
  followMark(recentre);
  redraw();
}

function firstUnmarked(after = -1) {
  const marks = st.info.marks;
  for (let i = after + 1; i < marks.length; i++) if (marks[i] === null) return i;
  for (let i = 0; i < marks.length; i++) if (marks[i] === null) return i;
  return null;
}

async function load(pos) {
  st.busy = true;
  stopPlayback();
  setStatus('Loading the stretch...');
  let samples;
  try {
    const res = await fetch(`/api/audio/${pos}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) throw new Error(`the server answered ${res.status}`);
    samples = new Float32Array(await res.arrayBuffer());
  } catch (e) {
    st.busy = false;
    setStatus(`Cannot load event ${pos + 1}: ${e.message}`, true);
    return;
  }
  st.pos = pos;
  st.samples = samples;
  const saved = st.info.marks[pos];
  st.mark = saved && saved.offset !== null ? saved.offset : null;
  st.kind = saved ? saved.label : null;
  const c = $('overview');
  st.spectrogram = computeSpectrogram(st.samples, 0, st.samples.length, c.width, c.height - SPEC_TOP);
  st.detailSpec = null;
  st.detailSpecFrom = -1;
  st.detailFrom = 0;
  if (st.mark !== null) followMark(true);
  st.busy = false;
  setStatus(saved ? 'This event is saved; a new mark replaces it.' : '');
  redraw();
}

async function save() {
  if (st.busy) return;
  if (st.kind === null) {
    setStatus('Pick the kind of sound, or No reply.', true);
    return;
  }
  if (st.kind !== 'none' && st.mark === null) {
    setStatus('Click where the first sound begins.', true);
    return;
  }
  const label = st.kind;
  const offset = st.kind === 'none' ? null : st.mark;
  st.busy = true;
  try {
    await api('/api/mark', { pos: st.pos, label, offset });
    st.info.marks[st.pos] = { label, offset };
  } catch (e) {
    st.busy = false;
    setStatus(`Not saved: ${e.message}`, true);
    return;
  }
  st.busy = false;
  const next = firstUnmarked(st.pos);
  if (next === null) await finish();
  else await load(next);
}

async function finish() {
  st.busy = true;
  stopPlayback();
  setStatus('Saving all marks...');
  try {
    const r = await api('/api/finish', {});
    showDone(r.message || '');
  } catch (e) {
    st.busy = false;
    setStatus(e.message, true);
  }
}

function showDone(message) {
  $('work').hidden = true;
  $('done').hidden = false;
  $('done-message').textContent = message;
  $('counter').textContent = `${st.info.count} of ${st.info.count} saved`;
}

function onKey(ev) {
  if (ev.metaKey || ev.ctrlKey || $('work').hidden || st.busy) return;
  const key = ev.key;
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    ev.preventDefault();
    if (st.mark === null) {
      setStatus('Click the picture first to place the mark.', true);
      return;
    }
    const step = ev.altKey ? Math.round(rate() / 100) : ev.shiftKey ? Math.round(rate() / 1000) : 1;
    setMark(st.mark + (key === 'ArrowLeft' ? -step : step));
    return;
  }
  if (key === ' ') {
    ev.preventDefault();
    if (st.source) {
      stopPlayback();
      drawOverview();
    } else play(0);
    return;
  }
  if (key === 'Enter') {
    ev.preventDefault();
    save();
    return;
  }
  const lower = key.length === 1 ? key.toLowerCase() : '';
  if (lower === 'p') {
    ev.preventDefault();
    if (st.mark !== null) play(st.mark);
    return;
  }
  if (lower === 'd') {
    ev.preventDefault();
    if (st.mark !== null) play(st.detailFrom, st.detailFrom + detailLength());
    return;
  }
  if (lower in KEY_KIND) {
    ev.preventDefault();
    st.kind = KEY_KIND[lower];
    redraw();
  }
}

function wire() {
  $('overview').addEventListener('click', (ev) => {
    if (st.busy) return;
    const c = $('overview');
    setMark((canvasX(c, ev) / c.width) * windowLength(), true);
  });
  $('detail').addEventListener('click', (ev) => {
    if (st.busy || st.mark === null) return;
    const c = $('detail');
    setMark(st.detailFrom + Math.floor((canvasX(c, ev) / c.width) * detailLength()));
  });
  $('zoom').addEventListener('click', (ev) => {
    if (st.busy || st.mark === null) return;
    const c = $('zoom');
    const half = zoomHalf();
    setMark(st.mark - half + Math.floor((canvasX(c, ev) / c.width) * 2 * half));
  });
  for (const b of document.querySelectorAll('button.kind')) {
    b.addEventListener('click', () => {
      st.kind = b.dataset.label;
      redraw();
    });
  }
  $('play').addEventListener('click', () => (st.source ? (stopPlayback(), drawOverview()) : play(0)));
  $('play-mark').addEventListener('click', () => {
    if (st.mark !== null) play(st.mark);
  });
  $('play-detail').addEventListener('click', () => {
    if (st.mark !== null) play(st.detailFrom, st.detailFrom + detailLength());
  });
  $('back').addEventListener('click', () => {
    if (st.pos > 0 && !st.busy) load(st.pos - 1);
  });
  $('save').addEventListener('click', () => save());
  document.addEventListener('keydown', onKey);
}

async function start() {
  try {
    st.info = await api('/api/state');
  } catch (e) {
    $('counter').textContent = `The page cannot reach the label server: ${e.message}`;
    return;
  }
  if (!Array.isArray(st.info.marks)) {
    $('counter').textContent = 'The label server sent no event list.';
    return;
  }
  if (st.info.done) {
    showDone('The marks were saved earlier.');
    return;
  }
  wire();
  if (st.info.count === 0) {
    await finish();
    return;
  }
  $('work').hidden = false;
  drawAxis();
  await load(firstUnmarked() ?? 0);
}

start();
