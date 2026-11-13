// Published set data/<id>/ (spec 8.7): stream.jsonl from detector_in.jsonl and the nArr of
// stamps.jsonl, with no face landmark coordinates (spec 13.4 "Схемы"); the public manifest;
// what may be published or committed (spec 13.4 "Чистота").
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  GATE_ONLY_FILES, LANDMARK_COUNT, NEVER_IN_GIT, NEVER_IN_GIT_PREFIXES, PUBLISHED_KINDS, RECORD_KINDS, STREAM_FIELDS,
  buildStreamJsonl, checkPublishedNames, detectorInToStream, findFaceLandmarkFields, findLocalPaths, listDeviceNames,
  parseJsonl, sampleToDetectorIn, streamToDetectorIn, toJsonlText, toPublishedManifest, validateAudioEnv,
  validateDetectorInLine, validatePlantedTimes, validatePublishedFolder, validatePublishedManifest, validateSampleLine,
  validateSentenceEnds, validateStreamLine, whyNoPublishedSet, whyNotInGit,
  type DetectorInLine, type Manifest, type SamplePacket, type StampLine, type StreamLine,
} from './index.ts';
import {
  EXAMPLE_SEAL, exampleAudioEnv, exampleDetectorIn, exampleEvents, exampleManifest, examplePlantedTimes,
  exampleSamples, exampleSentenceEnds, exampleStamps, exampleStream,
} from './examples.ts';

const LANDMARK_REASON = 'not allowed: face landmark coordinates stay in samples.jsonl (spec 8.1, 8.7, 12.3)';

describe('stream.jsonl = detector_in.jsonl + nArr from stamps.jsonl (spec 8.7)', () => {
  it('converts the spec 8.1 examples: nArr of the arr stamp with the same seq, order kept', () => {
    const built = detectorInToStream(exampleDetectorIn(), exampleStamps());
    expect(built.errors).toEqual([]);
    expect(built.batchesWithoutArr).toEqual([]);
    expect(built.lines).toEqual(exampleStream());
    expect(toJsonlText(built.lines, 'stream.jsonl')).toBe(
      '{"k":"batch","seq":5417,"nArr":8640000,"tr":[[1794935111123456,-0.4000000059604645]],"talk":[[1794935111123456,0]],"g":0.031746031746031744,"hm":0.0021}\n' +
        '{"k":"val","seq":5418,"code":0}\n' +
        '{"k":"voice","n":8659200,"on":true}\n' +
        '{"k":"state","n":8659200,"s":"listening"}\n',
    );
  });

  it('buildStreamJsonl works on the file texts and gives the same lines', () => {
    const out = buildStreamJsonl(toJsonlText(exampleDetectorIn(), 'detector_in.jsonl'), toJsonlText(exampleStamps(), 'stamps.jsonl'));
    expect(out.errors).toEqual([]);
    expect(out.warnings).toEqual([]);
    expect(out.text).toBe(toJsonlText(exampleStream(), 'stream.jsonl'));
    const back = parseJsonl(out.text ?? '', validateStreamLine, { file: 'stream.jsonl' });
    expect(back.errors).toEqual([]);
  });

  it('a val line gets nArr only when Deck stamped its seq', () => {
    const stamps: StampLine[] = [...exampleStamps(), { n: 8641600, k: 'arr', seq: 5418 }];
    const built = detectorInToStream(exampleDetectorIn(), stamps);
    expect(built.errors).toEqual([]);
    expect(built.lines[1]).toEqual({ k: 'val', seq: 5418, nArr: 8641600, code: 0 });
    expect(toJsonlText([built.lines[1] as StreamLine], 'stream.jsonl')).toBe('{"k":"val","seq":5418,"nArr":8641600,"code":0}\n');
  });

  it('packets after the last arr stamp keep nArr null (Deck had stopped); a gap before it is an error', () => {
    const det = exampleDetectorIn();
    const late: DetectorInLine = { k: 'batch', seq: 5419, tr: [], talk: [], g: null, hm: null };
    const end = detectorInToStream([...det, late], exampleStamps());
    expect(end.errors).toEqual([]);
    expect(end.batchesWithoutArr).toEqual([5419]);
    expect(end.lines[4]).toEqual({ k: 'batch', seq: 5419, nArr: null, tr: [], talk: [], g: null, hm: null });

    const middle = detectorInToStream([late, ...det], exampleStamps());
    expect(middle.errors).toEqual([
      'detector_in.jsonl line 1: packet seq 5419 has no arr stamp in stamps.jsonl, but later packets do',
    ]);
  });

  it('reports a doubled arr stamp and an arrival that goes back in time', () => {
    const twice = detectorInToStream(exampleDetectorIn(), [...exampleStamps(), { n: 8650000, k: 'arr', seq: 5417 }]);
    expect(twice.errors).toEqual(['stamps.jsonl: packet seq 5417 has more than one arr stamp']);

    const det: DetectorInLine[] = [
      { k: 'batch', seq: 1, tr: [], talk: [], g: null, hm: null },
      { k: 'batch', seq: 2, tr: [], talk: [], g: null, hm: null },
    ];
    const back = detectorInToStream(det, [{ n: 9600, k: 'arr', seq: 1 }, { n: 4800, k: 'arr', seq: 2 }]);
    expect(back.errors).toEqual(["detector_in.jsonl line 2: nArr 4800 of seq 2 is before the previous packet's 9600"]);
  });

  it('streamToDetectorIn gives the replay its input back unchanged', () => {
    const lines = detectorInToStream(exampleDetectorIn(), exampleStamps()).lines;
    expect(lines.map(streamToDetectorIn)).toEqual(exampleDetectorIn());
  });

  it('buildStreamJsonl refuses broken inputs with file names and line numbers, and writes nothing', () => {
    const det = `${toJsonlText(exampleDetectorIn(), 'detector_in.jsonl')}{"k":"batch","seq":5420,"tr":[],"talk":[],"g":0,"hm":0,"lm":{"ts":1,"reset":0,"p":[]}}\n`;
    const out = buildStreamJsonl(det, '{"n":0,"k":"arr"}\n');
    expect(out.text).toBeNull();
    expect(out.errors).toEqual([
      `detector_in.jsonl line 5: lm: ${LANDMARK_REASON}`,
      'stamps.jsonl line 1: seq: missing',
    ]);
  });

  it('an interrupted session is published: a last line cut short is dropped with a warning (spec 8.7, 10.6)', () => {
    const det = toJsonlText(exampleDetectorIn(), 'detector_in.jsonl');
    const st = toJsonlText(exampleStamps(), 'stamps.jsonl');
    const stream = toJsonlText(exampleStream(), 'stream.jsonl');
    const cut = buildStreamJsonl(`${det}{"k":"batch","seq":5419,"tr":[[17949351`, `${st}{"n":86500`);
    expect(cut.errors).toEqual([]);
    expect(cut.warnings).toEqual([
      'detector_in.jsonl line 5: partial last line dropped (no newline, not valid JSON: the recording was cut off)',
      'stamps.jsonl line 10: partial last line dropped (no newline, not valid JSON: the recording was cut off)',
    ]);
    expect(cut.text).toBe(stream);
    // A whole last line without its newline is kept as it is.
    const whole = buildStreamJsonl(det.slice(0, -1), st.slice(0, -1));
    expect(whole.warnings).toEqual([]);
    expect(whole.text).toBe(stream);
    // The same partial line anywhere else is a broken file: nothing is written.
    const middle = buildStreamJsonl(`{"k":"batch","seq":5419,"tr":[[17949351\n${det}`, st);
    expect(middle.text).toBeNull();
    expect(middle.warnings).toEqual([]);
    expect(middle.errors).toHaveLength(1);
    expect(middle.errors[0]).toMatch(/^detector_in\.jsonl line 1: not valid JSON \(/);
  });
});

describe('a stream.jsonl never contains face landmark coordinates (spec 8.7, 13.4)', () => {
  /** Landmark coordinates with a fraction and four integer digits: no other value prints like them. */
  const coord = fc.tuple(fc.integer({ min: 1000, max: 1999 }), fc.integer({ min: 1, max: 99 })).map(([a, b]) => a + b / 100);
  const ts = fc.integer({ min: 1_794_935_000_000_000, max: 1_794_936_000_000_000 });
  const packet = fc.record({
    tr: fc.array(fc.tuple(ts, fc.double({ min: -1, max: 1, noNaN: true })), { maxLength: 3 }),
    talk: fc.array(fc.tuple(ts, fc.constantFrom(0 as const, 1 as const)), { maxLength: 2 }),
    g: fc.option(fc.double({ min: 0, max: 0.2, noNaN: true }), { nil: null }),
    hm: fc.option(fc.double({ min: 0, max: 0.05, noNaN: true }), { nil: null }),
    points: fc.array(fc.tuple(coord, coord), { minLength: LANDMARK_COUNT, maxLength: LANDMARK_COUNT }),
    other: fc.constantFrom('voice', 'state', 'none'),
    careless: fc.boolean(),
  });

  it('whatever tap recorded and however the worker copied it', () => {
    fc.assert(
      fc.property(fc.array(packet, { minLength: 1, maxLength: 12 }), (packets) => {
        const det: DetectorInLine[] = [];
        const stamps: StampLine[] = [];
        const coordinates = new Set<string>();
        packets.forEach((pk, i) => {
          const seq = 100 + i;
          const reset = pk.g === null ? 1 : 0;
          const sample: SamplePacket = {
            seq, k: 'm', tArrNs: String(812345678901234 + i * 33_000_000), tsCbUs: 1794935111156789 + i * 33_000,
            tr: pk.tr, talk: pk.talk, g: reset === 1 ? null : pk.g, hm: reset === 1 ? null : pk.hm,
            lm: { ts: 1794935111123456 + i * 33_000, reset: reset as 0 | 1, p: pk.points },
          };
          expect(validateSampleLine(sample)).toEqual([]);
          for (const [x, y] of pk.points) coordinates.add(JSON.stringify(x)).add(JSON.stringify(y));
          const clean = sampleToDetectorIn(sample);
          if (clean === null) throw new Error('a packet is detector input');
          expect(validateDetectorInLine(clean)).toEqual([]);
          // A careless worker could spread the whole tap line into detector_in: the converter
          // rebuilds each line from its allowed fields, so nothing extra gets through.
          det.push(pk.careless ? ({ ...sample, ...clean, p: pk.points, landmarks: pk.points } as unknown as DetectorInLine) : clean);
          stamps.push({ n: 9600 * (i + 1), k: 'arr', seq });
          if (pk.other === 'voice') det.push({ k: 'voice', n: 9600 * (i + 1) + 1, on: i % 2 === 0 });
          if (pk.other === 'state') det.push({ k: 'state', n: 9600 * (i + 1) + 2, s: 'narrating' });
        });
        const built = detectorInToStream(det, stamps);
        expect(built.errors).toEqual([]);
        const text = toJsonlText(built.lines, 'stream.jsonl');
        for (const c of coordinates) expect(text.includes(c)).toBe(false);
        expect(text.includes('tArrNs')).toBe(false);
        built.lines.forEach((line) => {
          expect(findFaceLandmarkFields(line)).toEqual([]);
          expect(validateStreamLine(line)).toEqual([]);
          for (const key of Object.keys(line)) expect(STREAM_FIELDS[line.k]).toContain(key);
        });
        // Replay reads the detector input it had, landmarks aside.
        const replay = built.lines.map(streamToDetectorIn);
        expect(replay.filter((l) => l.k === 'batch').map((l) => (l as { g: unknown }).g)).toEqual(
          packets.map((pk) => (pk.g === null ? null : pk.g)),
        );
      }),
      { numRuns: 150 },
    );
  });

  it('validateStreamLine refuses landmark fields with the reason, and any unknown field', () => {
    const line = { ...exampleStream()[0], lm: { ts: 1, reset: 0, p: [[640.2, 402.1]] }, p: [[640.2, 402.1]] };
    expect(validateStreamLine(line)).toEqual([`lm: ${LANDMARK_REASON}`, `p: ${LANDMARK_REASON}`]);
    expect(validateStreamLine({ k: 'voice', n: 1, on: true, landmarks: [] })).toEqual([`landmarks: ${LANDMARK_REASON}`]);
    expect(validateStreamLine({ k: 'val', seq: 1, code: 0, tArrNs: '1' })).toEqual(['tArrNs: unexpected field']);
    expect(validateStreamLine({ k: 'batch', seq: 1, tr: [], talk: [], g: null, hm: null })).toEqual(['nArr: missing']);
    expect(validateStreamLine({ k: 'mark', n: 1 })).toEqual(['k: unknown stream kind "mark" (expected one of batch, val, voice, state)']);
  });

  it('findFaceLandmarkFields finds landmark keys at any depth', () => {
    expect(findFaceLandmarkFields({ a: [{ b: { points: [] } }], lm: null })).toEqual(['a[0].b.points', 'lm']);
    expect(findFaceLandmarkFields(exampleEvents())).toEqual([]);
    expect(findFaceLandmarkFields(exampleSamples()[0])).toEqual(['lm', 'lm.p']);
  });
});

describe('audio_env.json, sentence_ends.json, planted_times.json (spec 8.7)', () => {
  it('audio_env: levels every 10 ms, rounded to 0.1 dB, both channels the same length', () => {
    expect(validateAudioEnv(exampleAudioEnv())).toEqual([]);
    expect(validateAudioEnv({ ...exampleAudioEnv(), step_ms: 20 })).toEqual(['step_ms: expected 10, got 20']);
    expect(validateAudioEnv({ ...exampleAudioEnv(), mic_db: [-58.23, -57.9, -31.4] })).toEqual([
      'mic_db[0]: expected a report value rounded to 0.1 (spec 8.1), got -58.23',
    ]);
    expect(validateAudioEnv({ ...exampleAudioEnv(), narrator_db: [-22.5] })).toEqual([
      'mic_db has 3 values, narrator_db 1: both cover the same steps',
    ]);
    expect(validateAudioEnv({ ...exampleAudioEnv(), samples: [0.1, 0.2] })).toEqual(['samples: unexpected field']);
  });

  it('sentence_ends: samples only, no text or word times', () => {
    expect(validateSentenceEnds(exampleSentenceEnds())).toEqual([]);
    expect(validateSentenceEnds({ ...exampleSentenceEnds(), text: 'It took about 4 minutes.' })).toEqual([
      'text: not allowed: no text in the published set (spec 8.7)',
    ]);
    const bad = exampleSentenceEnds();
    bad.ends.push({ passage_id: 'p4x', sentence_index: -1, n: 1.5 });
    expect(validateSentenceEnds(bad)).toEqual([
      'ends[2].passage_id: expected "opening" or "p1".."p9", got "p4x"',
      'ends[2].sentence_index: expected an integer >= 0, got -1',
      'ends[2].n: expected a sample number (non-negative integer), got 1.5',
    ]);
  });

  it('planted_times: error number and samples as it sounded, never its text', () => {
    expect(validatePlantedTimes(examplePlantedTimes())).toEqual([]);
    const withText = examplePlantedTimes();
    Object.assign(withText.errors[0] as object, { planted_sentence: 'It took about 4 minutes.' });
    expect(validatePlantedTimes(withText)).toEqual(['errors[0].planted_sentence: not allowed: no text in the published set (spec 8.7)']);
    const backwards = examplePlantedTimes();
    Object.assign(backwards.errors[0] as object, { n_end: 9000000 });
    expect(validatePlantedTimes(backwards)).toEqual(['errors[0]: n_end lies before n_start']);
  });
});

/** A manifest as host writes it on the Mac, with names that can carry a person's name. */
function hostManifest(): Manifest {
  const m = exampleManifest();
  return {
    ...m,
    camera: { name: "Anna's iPhone Camera", requested: [1280, 720, 30] },
    audio: {
      ...m.audio,
      microphone: "Anna's AirPods",
      output: "Anna's AirPods",
      settings: { label: "Anna's AirPods", deviceId: 'f00d', groupId: 'beef', sampleRate: 48000, echoCancellation: false },
    },
    mode: 'session',
    source: '/Users/anna/copyholder/sessions/s1',
    paths: { session: '/Users/anna/copyholder/sessions/s1' },
  };
}

describe('public manifest.json (spec 8.7)', () => {
  it('lists the device names pack prints for confirmation', () => {
    expect(listDeviceNames(hostManifest())).toEqual([
      { path: 'camera.name', value: "Anna's iPhone Camera" },
      { path: 'audio.microphone', value: "Anna's AirPods" },
      { path: 'audio.output', value: "Anna's AirPods" },
      { path: 'audio.settings.label', value: "Anna's AirPods" },
      { path: 'machine', value: 'MacBook Pro (14-inch, M3)' },
    ]);
    expect(listDeviceNames({ ...exampleManifest(), camera: null })).toEqual([
      { path: 'audio.microphone', value: 'USB Headset Microphone' },
      { path: 'machine', value: 'MacBook Pro (14-inch, M3)' },
    ]);
  });

  it('the session copy has local paths; the public check names each one', () => {
    const m = hostManifest();
    expect(findLocalPaths(m)).toEqual(['source', 'paths.session']);
    expect(validatePublishedManifest(m)).toEqual([
      'paths: not allowed in the published manifest (spec 8.7: local paths removed)',
      'source: looks like a local path (spec 8.7)',
    ]);
  });

  it('toPublishedManifest drops paths and device ids and applies --alias; ids, seal and hashes stay', () => {
    const m = hostManifest();
    delete m['source'];
    const pub = toPublishedManifest(m, { "Anna's iPhone Camera": 'Phone camera', "Anna's AirPods": 'Headset', '9f2c41d7': 'XXXX' });
    expect(validatePublishedManifest(pub)).toEqual([]);
    expect(pub.paths).toBeUndefined();
    expect(pub.camera?.name).toBe('Phone camera');
    expect(pub.audio.microphone).toBe('Headset');
    expect(pub.audio.settings).toEqual({ label: 'Headset', sampleRate: 48000, echoCancellation: false });
    expect(pub.plan_commitment).toBe(EXAMPLE_SEAL);
    expect(pub.files).toEqual(m.files);
    expect(pub.id).toBe('s1');
    expect(JSON.stringify(pub).includes('Anna')).toBe(false);
    // The session copy is left as it was.
    expect(m.audio.microphone).toBe("Anna's AirPods");
    expect(m.paths).toBeDefined();
  });
});

describe('what may be published or committed (spec 8.7, 12.4, 13.4 "Чистота")', () => {
  it('checkPublishedNames: the set of spec 8.7, switches for audio, clips and texts', () => {
    expect(checkPublishedNames(['manifest.json', 'stream.jsonl', 'events.jsonl', 'receipt.txt', 'verdict.md', 'plan.json'])).toEqual([]);
    expect(checkPublishedNames(['samples.jsonl', 'sdk_raw.jsonl.gz', 'detector_in.jsonl', 'stamps.jsonl'])).toEqual([
      'samples.jsonl: never published (spec 8.7)',
      'sdk_raw.jsonl.gz: never published (spec 8.7)',
      'detector_in.jsonl: never published (spec 8.7)',
      'stamps.jsonl: never published (spec 8.7)',
    ]);
    expect(checkPublishedNames(['audio.wav', 'clips/o07.wav', 'texts.json', 'notes.md'])).toEqual([
      'audio.wav: published only with --with-audio (spec 8.7)',
      'clips/o07.wav: published only with --with-clips (spec 8.7)',
      'texts.json: published only with --with-texts (spec 8.7)',
      'notes.md: not part of data/<id>/ (spec 8.7)',
    ]);
    expect(checkPublishedNames(['audio.wav', 'clips/o07.wav', 'texts.json'], { audio: true, clips: true, texts: true })).toEqual([]);
  });

  it('verdict.md and verdict.json belong to the set of the day-1 gate only (spec 8.7)', () => {
    expect(GATE_ONLY_FILES).toEqual(['verdict.md', 'verdict.json']);
    expect(checkPublishedNames(['manifest.json', 'verdict.md', 'verdict.json'], { kind: 'gate', pack: 'A' })).toEqual([]);
    expect(checkPublishedNames(['manifest.json', 'receipt.json', 'verdict.md', 'verdict.json'], { kind: 'numbers' })).toEqual([
      'verdict.md: only the set of the day-1 gate has it, this record is "numbers" (spec 8.7)',
      'verdict.json: only the set of the day-1 gate has it, this record is "numbers" (spec 8.7)',
    ]);
  });

  it('a set for the gate, each numbers session, the space-bar block and each demo take; none for development records (spec 8.7)', () => {
    expect(PUBLISHED_KINDS).toEqual(['gate', 'numbers', 'spacebar', 'demo']);
    for (const kind of RECORD_KINDS) expect(whyNoPublishedSet(kind) === null, kind).toBe(PUBLISHED_KINDS.includes(kind));
    for (const pack of ['A', 'B', 'C', null] as const) expect(whyNoPublishedSet('gate', pack)).toBeNull();
    expect(whyNoPublishedSet('gate', '0')).toBe(
      'the probe before the gate (pack 0) is a development record and gets no published set (spec 8.7, 9.4)',
    );
    expect(checkPublishedNames(['manifest.json', 'events.jsonl'], { kind: 'rehearsal' })).toEqual([
      'a rehearsal record is a development record and gets no published set: only gate, numbers, spacebar, demo records do (spec 8.7)',
    ]);
  });

  it('validatePublishedFolder takes kind and pack from manifest.json, which every set carries', () => {
    const verdictMd = '# Verdict\n';
    expect(validatePublishedFolder({ 'manifest.json': JSON.stringify(exampleManifest()), 'verdict.md': verdictMd })).toEqual([
      'verdict.md: only the set of the day-1 gate has it, this record is "numbers" (spec 8.7)',
    ]);
    const gate: Manifest = { ...exampleManifest(), kind: 'gate', pack: 'A', plan_commitment: null };
    expect(validatePublishedFolder({ 'manifest.json': JSON.stringify(gate), 'verdict.md': verdictMd })).toEqual([]);
    expect(validatePublishedFolder({ 'manifest.json': JSON.stringify({ ...gate, pack: '0' }) })).toEqual([
      'the probe before the gate (pack 0) is a development record and gets no published set (spec 8.7, 9.4)',
    ]);
    expect(validatePublishedFolder({ 'stream.jsonl': toJsonlText(exampleStream(), 'stream.jsonl') })).toEqual([
      'manifest.json: missing: every published set carries the public manifest (spec 8.7)',
    ]);
  });

  it('validatePublishedFolder checks names, schemas and landmark fields of every file', () => {
    const ok = {
      'manifest.json': JSON.stringify(exampleManifest()),
      'stream.jsonl': toJsonlText(exampleStream(), 'stream.jsonl'),
      'events.jsonl': toJsonlText(exampleEvents(), 'events.jsonl'),
      'audio_env.json': JSON.stringify(exampleAudioEnv()),
      'receipt.txt': 'COPYHOLDER RECEIPT  session s1\n',
      'audio.wav': null,
    };
    expect(validatePublishedFolder(ok, { audio: true })).toEqual([]);
    const leaked = {
      ...ok,
      'stream.jsonl': `${toJsonlText(exampleStream(), 'stream.jsonl')}{"k":"voice","n":1,"on":true,"p":[[640.2,402.1]]}\n`,
      'samples.jsonl': '',
    };
    expect(validatePublishedFolder(leaked)).toEqual([
      'audio.wav: published only with --with-audio (spec 8.7)',
      'samples.jsonl: never published (spec 8.7)',
      `stream.jsonl line 5: p: ${LANDMARK_REASON}`,
    ]);
  });

  it('whyNotInGit: keys, settings, raw SDK data, samples and video stay out of git', () => {
    expect(NEVER_IN_GIT).toEqual(['.env', 'settings.env', 'sdk_raw.jsonl.gz', 'samples.jsonl']);
    for (const path of ['.env', 'live/.env', 'settings.env', 'sessions/s1/sdk_raw.jsonl.gz', 'sessions/s1/samples.jsonl']) {
      expect(whyNotInGit(path), path).toMatch(/never goes into git \(spec 13\.4, 13\.6\)$/);
    }
    expect(whyNotInGit('video/demo-2.MP4')).toBe('video files (.mp4) never go into git (spec 13.4)');
    expect(whyNotInGit('.env.example')).toBeNull();
    expect(whyNotInGit('settings.env.example')).toBeNull();
    expect(whyNotInGit('data/s1/stream.jsonl')).toBeNull();
  });

  it('whyNotInGit: raw SDK data and samples in any form, and names in any case (spec 13.4)', () => {
    expect(NEVER_IN_GIT_PREFIXES).toEqual(['sdk_raw.jsonl', 'samples.jsonl']);
    expect(whyNotInGit('sessions/s1/sdk_raw.jsonl')).toBe('sdk_raw.jsonl: sdk_raw.jsonl never goes into git, in any form (spec 13.4, 13.6)');
    expect(whyNotInGit('backup/samples.jsonl.gz')).toBe('samples.jsonl.gz: samples.jsonl never goes into git, in any form (spec 13.4, 13.6)');
    expect(whyNotInGit('sdk_raw.jsonl.gz.part')).toMatch(/in any form/);
    expect(whyNotInGit('Live/.ENV')).toBe('.ENV never goes into git (spec 13.4, 13.6)');
    expect(whyNotInGit('Samples.JSONL')).toBe('Samples.JSONL never goes into git (spec 13.4, 13.6)');
    expect(whyNotInGit('docs/samples.jsonl-format.md')).toBeNull();
    expect(whyNotInGit('data/s1/stream.jsonl.gz')).toBeNull();
  });
});
