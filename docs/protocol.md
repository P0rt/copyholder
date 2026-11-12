# Runtime protocol between tap, host, worker, Deck and the page

This file fixes the wire formats between the live parts (spec sections 6.1-6.5, 7.1-7.3, 8.1). File formats themselves are in spec section 8.1 and in `core/schemas/`. Where this file and the spec differ, the spec wins; fix this file.

## Processes

| Part | File | Started by |
|---|---|---|
| `host` | `live/host.cjs` (CommonJS, needs only `ws` from the root package) | npm scripts (`session`, `gate`, `doctor`, `smoke`, `spacebar`, `live:from`, `live:sim`, `headstart`, ...) |
| `tap` | `live/tap.cjs` (the only file that loads the SDK) | `host`, via `child_process.fork` |
| mock `tap` | `live/mock-tap.cjs` (no SDK; synthetic trace or a recorded `detector_in.jsonl`) | `host` in `live:sim`, `live:from` and tests |
| page | `web/` built by Vite into `web/dist/` | `host` opens it in Chrome |
| Deck | `web/deck.worklet.ts` (AudioWorkletProcessor named `deck`) | page |
| worker | `web/worker.ts` (module Web Worker) | page |

## host <-> tap (fork IPC, `process.send`)

tap -> host:

- `{t:'ready', port}`: the `/tap` WebSocket server listens on `127.0.0.1:port`.
- `{t:'cameras', list:[{id, name}]}`: camera list (sent before exit when no camera was chosen; `smoke` prints it).
- `{t:'status', kind:'processingStatus'|'validationStatus', code, name}`: on every change.
- `{t:'pulse', packets}`: once per second, the number of SDK `metrics` callbacks in the last second (spec 7.1, 7.2).
- `{t:'sdk_error', code, name, message}`: any SDK `error` event or exception from `useCamera()`/`start()`.
- `{t:'started'}`, `{t:'stopped'}`.

host -> tap:

- `{t:'config', token, origin, sessionDir, smoke}`: sent once after `ready`. `token` guards `/tap`; `origin` is the only accepted `Origin`.
- `{t:'start'}`: only after the consent event from the page (spec 12.2). Before it the SDK is never started.
- `{t:'stop'}`: `await sdk.stopAsync()`, then `{t:'stopped'}` and exit.

The API key is read only by `tap` from `.env` (spec 13.6). `host` never reads `.env`.

## HTTP (host)

- Listens on `127.0.0.1`, port chosen by the OS, random 32-byte hex token per run.
- `GET /?token=T` serves `web/dist/index.html` and sets cookie `ch_token=T; HttpOnly; SameSite=Strict; Path=/`. Every other HTTP request needs that cookie or `?token=T`; otherwise 403.
- `GET /api/config` returns the run config as JSON:
  `{mode, sessionId, scenario, tapUrl, sessionUrl, calib, narrator:[names], consentText:'live'|'mic'}`.
  `tapUrl` and `sessionUrl` carry their tokens as `?token=`.
- `GET /api/narrator/<name>` returns narrator audio (`*.wav`, mono 48 kHz) or `timings.json` for the current scenario. Only names in the scenario's allow list are served (spec 7.2, 8.2); anything else is 404. Sealed audio is decrypted in memory only and never before the `preflight_ok` event (spec 7.2).
- `POST` is not used; everything else goes over `/session`.

## WebSocket `/tap` (tap -> worker)

One text frame per `samples.jsonl` line, exactly as written to the file (spec 8.1): kinds `m` (packet), `v` (validationStatus), `s` (processingStatus), `f` (frameSentThrough), `e` (error), `l` (event-loop delay). One client only; wrong token or `Origin` is rejected.

## WebSocket `/session` (worker <-> host)

Text frames are JSON objects with a type field `t`:

- worker -> host
  - `{t:'hello', ua, settings}`: first frame; `settings` is `MediaTrackSettings` of the microphone (`getSettings()`), plus the output device name.
  - `{t:'consent', at}`: user pressed `I agree, start` (host may now send `{t:'start'}` to tap).
  - `{t:'stamp', line}`: one `stamps.jsonl` line (spec 8.1). Deck creates them; the worker forwards them in order.
  - `{t:'det', line}`: one `detector_in.jsonl` line, in processing order.
  - `{t:'event', line}`: one `events.jsonl` line.
  - `{t:'end', reason}`: scenario finished or the user pressed `Stop`.
- host -> worker
  - `{t:'abort', reason}`: SDK `error` or `tap_lost`: Deck mutes the narrator at once, the second loop check is skipped (spec 7.2).
  - `{t:'tap', status}`: tap lifecycle (`starting`, `running`, `stopped`).

Binary frames (worker -> host) carry audio blocks: a 16-byte header, then planar float32 data.

```text
bytes 0-3   ASCII "CHK1"
bytes 4-7   uint32 LE  frames (normally 9600)
bytes 8-15  float64 LE n0 (first sample number of the block)
then        float32 LE ch0[frames] (microphone), float32 LE ch1[frames] (Deck output)
```

`host` appends the block to `audio.wav` (2 channels, float32, 48 kHz, interleaved) and writes the `chunk` stamp `{"n":n0,"k":"chunk","frames":frames}`. A block whose `n0` is not the previous `n0 + frames` marks the audio unusable: `host` writes event `audio_gap` (spec 6.3, 7.2).

## Deck <-> worker (direct MessagePort, bypassing the main thread)

The page creates a `MessageChannel`, gives one end to the worker and the other to Deck (through `AudioWorkletNode.port`, once at start).

- worker -> Deck: `{k:'pkt', seq, hold}` for every SDK packet, after `step()`. Deck stamps `{"n":nArr,"k":"arr","seq":seq}` in the quantum where it handles the message; in live modes `hold:true` starts the 8 ms fade with `nCmd = nArr`.
- Deck -> worker:
  - `{k:'chunk', n0, frames, ch0, ch1}` (Float32Array, transferred) every 9600 frames;
  - `{k:'stamp', line}` for every stamp (`arr`, `hold`, `state`, `voice`, `resume`, `ignored`, `click`, `mark`);
  - voice edges and narrator state changes also arrive as stamps; the worker turns them into `detector_in.jsonl` lines `{k:'voice', n, on}` and `{k:'state', n, s}` and feeds them to `step()` in arrival order (spec 7.3, 7.4).

## Deck <-> main thread (`AudioWorkletNode.port`)

- main -> Deck: `{k:'load', name, pcm, timings}`, `{k:'scenario', steps}`, `{k:'go'}`, `{k:'gain', value}`, `{k:'key'}` (space bar `keydown`), `{k:'stop'}`.
- Deck -> main: `{k:'step', n, name, text}` (a scenario step started: the page shows its prompt), `{k:'cue', n, on}` (the dot fills or empties), `{k:'state', n, s, cause}`, `{k:'level', ch0Db, ch1Db}` (meters, about 10 per second), `{k:'done', n}`.

Scenario timing lives inside Deck and is counted in samples. The main thread only draws what Deck reports. No deadline in the app depends on `setTimeout` or `requestAnimationFrame` (spec 6.1). Steps that wait for an outside condition (SDK `Running` with `kOk` held 5 s, consent) are released by `{k:'go'}`.

## Event names used across parts (working names, spec 8.1)

`preflight_ok`, `tap_lost`, `audio_gap`, `sdk_error`, `consent`, `armed`, `fire`, `hold`, `resume`, window and device events (`visibilitychange`, `blur`, `resize`, `devicechange`, `track_ended`, `track_mute`).
