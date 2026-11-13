# Privacy notice

> **First version, 12 November 2026.** A short version, in place before the first run of the SmartSpectra SDK. It will be completed by 19 November 2026.

Copyholder is an open-source app by the author of this repository (below: the author), made for the DEV Presage SmartSpectra SDK Challenge (November 2026). It is not a Presage product. This notice covers the app, the judge page built from it and the recordings the author publishes here. Section 30.1 of the Presage Terms of Service asks every app built on the SDK to give its users such a notice. Terms of use: [TERMS.md](TERMS.md).

Sources: the [SmartSpectra SDK Privacy Policy](https://presagetech.com/legal/privacy-policy) of 3 November 2026 ("Policy" below; the SDK policy on that page), the [Presage Terms of Service](https://presagetech.com/legal/terms-of-service) of 2 November 2026 and the SDK documentation on [telemetry and privacy](https://smartspectra.presagetech.com/docs/telemetry-and-privacy) and [Insights](https://smartspectra.presagetech.com/docs/llm-insights).

## Consent

Copyholder measures only the person who pressed `I agree, start`. The camera and the microphone turn on only after that button. While they are on, an indicator shows in the window, and `Stop` turns both off at once. In live mode the consent screen lists:

> - Camera frames are processed on this computer by the SmartSpectra SDK. The app does not store or upload them.
> - In every session the SDK itself sends derived measurements (such as breathing rate) with session identifiers to Presage in the United States. Presage passes them to its AI provider, Anthropic, to generate "Insights". This cannot currently be switched off. The app never requests an Insight and sends no prompt text.
> - The SDK also sends app credentials, hashed device identifiers and usage records, and Presage's servers see the IP address.
> - SDK telemetry is switched off (`enableTelemetry: false`). That does not switch off authentication, model delivery or the transfer above.
> - Your microphone recording, the chest trace, face points and the SDK's raw messages, which include the full face mesh, are saved to the folder `sessions/<id>/` on this computer. The app uploads none of it.
> - Measure only yourself. You must be 18 or older.
> - SDK metrics are offered for general wellness and informational purposes only. SDK metrics have not been cleared by the FDA and may not be used for medical diagnosis or treatment. This app makes no diagnosis and no health claim.

A demo take adds one line: the built-in camera shows a face preview in a corner of the page; its frames are only drawn on screen, the app does not store or upload them, they do not go to the SDK, and the screen recording shows the preview. Modes without the camera do not start the SDK; their shorter screen says only what the microphone does and whether and where the recording is saved.

## Where data goes

| Data | Where it goes | Can it be switched off | What the app does |
|---|---|---|---|
| Camera frames read by the SDK | Stay on the computer: the SDK processes them on the device and does not send them to Presage (Policy 3.1) | Not needed | Does not store or upload them |
| Face points | Not sent to Presage (Policy 3.1). `tap` passes 16 points to the page over a local socket | Not needed | Saved in the session folder. Coordinates are never published: the published set keeps two numbers per frame |
| Breathing trace | Not in the list of metrics the SDK documentation names for Insights. `tap` passes it to the page over a local socket | Not needed | Saved in the session folder. Trace samples are published in `data/<id>/` |
| Derived measurements, such as breathing rate, with session identifiers | To Presage (United States), and from there to Anthropic for the Insights feature (Policy 4.2, 7.1) | No (Policy 7.4) | Disclosed on the consent screen and here; `README.md` and the post will repeat it. The app never calls `requestInsight` and sends no prompt text |
| App credentials (the API key), app attestation token, hashed device identifiers, SDK version, usage records. The servers see the IP address (Policy 4.3, 4.4) | To Presage | No | Disclosed in the same places |
| SDK telemetry: session summaries and device readiness reports | To Presage | Yes | Switched off with `enableTelemetry: false`. This does not switch off key checks, model delivery or Insights (Policy 4.4) |
| Microphone audio | The app does not send it: the page passes it to `host` over a local socket | Not needed | Saved to `audio.wav` as the time reference. The demo take's audio goes into the video. Anything more only with the author's yes (see below) |
| Draft text, text with planted errors, narrator audio | The app does not send them. A local model in Ollama plants the errors and Kokoro makes the voice, both on the Mac. Audio for the public texts may be rendered in the AI assistant's cloud session (see below) | Not needed | Kept in the sealed folder. After the reveal, the changed sentences are published |
| `data/<id>/`, `results/`, freeze files, code | GitHub: this repository and the judge page | The base set is needed by the judges. Audio, voice clips and full texts are added only by the author | See "What is published" |
| Demo video: screen recording, the take's audio with the author's voice, face preview from a second camera | A video host (YouTube is planned) and the DEV post | Audio is required; the face preview can be removed | No other people in the frame |
| Reports and files for analysis | The cloud session of the AI assistant (Claude, by Anthropic) | Reports by default. Audio, texts and face points only with the author's yes | Listed below |

Publishing and the AI assistant concern only the author's recordings. If you run the app yourself, your files stay in your own `sessions/<id>/`; the app publishes none of them and passes none of them on.

The app does not request pulse or its variability. As the author reads the SDK documentation, breathing rate is then the only Insights metric left; whether Insights snapshots are sent with this metric set, the documentation does not say, and `npm run smoke` looks for upload entries in the SDK log. The disclosure stays either way. Presage keeps what it receives as Policy 10.1 says: Insights requests and responses while the developer account is active, deleted no later than 60 days after it is closed; usage records and telemetry for up to 365 days.

Live mode needs the network the whole time: the SDK checks its entitlement during the session and has no offline mode. Replay mode and the no-camera mode do not start the SDK, so there is no transfer to Presage. The network is also used to install packages, download the Ollama and Kokoro models and get OpenTimestamps stamps; session recordings and draft texts are not part of those requests.

## Files on the computer

The session folder `sessions/<id>/` stays on the computer that runs the app and is excluded from git. The files that matter for privacy:

| File | Contents | Published | Passed to the AI assistant |
|---|---|---|---|
| `sdk_raw.jsonl.gz` | Raw SDK messages with arrival times, including the full face mesh of 478 points | Never | Never |
| `samples.jsonl` | All that `tap` passed to the page: trace, `talking` flag, 16 lip and eye points, lip gap, head movement, SDK statuses | Never | Only with the author's yes |
| `tap.log` | What `tap` printed to the terminal: camera names, which may contain a person's name; the checks of the SDK's status and error codes; the SDK's device readiness verdict; probe lines with the x and y extent of the face points in frame pixels; SDK errors; `tap`'s error traces, whose local file paths can show the account name on the computer; and, in `smoke`, the SDK's own info log. Text shaped like a key, an id or a hash is replaced by `[redacted]`; the words of file paths and web addresses are kept | Never | Only with the author's yes |
| `audio.wav` | Microphone and narrator output, two channels | Not by default | Only with the author's yes |
| `detector_in.jsonl` | All detector inputs as numbers; no face point coordinates | Yes, as `stream.jsonl` | Yes |
| `events.jsonl`, `stamps.jsonl` | Script steps, triggers, stops, keys, window and device events, with sample numbers | `events.jsonl` in full; from `stamps.jsonl` only sample numbers | Yes |
| `manifest.json` | Mode, versions, device names, the seal (a hash), file hashes | Yes, without local paths | Yes |
| `onsets.json`, `review.json` | Voice onsets and reply labels; the author's objection marks | `onsets.json` in full; `review.json` only as the total in the receipt | Yes |

The other files (`calib.json`, `quickcheck.json`, `clock_report.json`, the receipt, the verdict, the step log) hold reports and numbers: no audio, no text, no face point coordinates. The sealed folder `~/Library/Application Support/copyholder/sealed/<id>/` is outside the repository. It holds, encrypted, the plan of planted errors, the original and changed texts, the narrator audio, word timings, the score before the reveal and the planter log; the cipher key is in the macOS keychain. After the reveal it also holds the opened `plan.json` and `texts.json`. The screen recording of a demo take and the finished video stay where they were saved and never go into git.

## Retention and deletion

The app deletes nothing by itself: files stay until you delete them.

- `npm run purge -- <id> --raw` deletes only `sdk_raw.jsonl.gz`.
- `npm run purge -- <id>` deletes the whole session folder. It deletes the sealed folder of a plan listed in `freeze_manifest.json` only after `reveal` and `pack`, and refuses otherwise; for `pilot` and `rehearsal`, after `reveal`.
- Both delete files on the computer only. They do not touch the published set or files already passed to the AI assistant.
- **Retention of the author's recordings:** `sdk_raw.jsonl.gz` is deleted right after the post is published on 22 November 2026. All other recordings on the Mac are kept until the winners are announced on 10 December 2026, then deleted. If you run the app yourself, you choose when to delete yours.

## What is published

`npm run pack -- <id>` builds the published set `data/<id>/`: a reduced recording for the replay mode and the files that check the numbers.

- `stream.jsonl`: breathing trace samples with timestamps and the arrival sample `nArr`; two numbers per frame (the lip gap divided by the distance between the outer eye corners, and head movement); the `talking` flag, SDK statuses, voice detector edges, narrator states.
- `events.jsonl`, `onsets.json`: script steps, triggers, stops with their cause, resumes, window and device events; voice onsets and reply labels.
- `audio_env.json`: loudness of both channels in 10 ms steps. This is not audio.
- `manifest.json`, `calib.json`, `clock_report.json`, `receipt.json`, `receipt.txt`: versions, device names, calibrations, the clock report, the receipt; no local paths. The first-day check also has `verdict.md` and `verdict.json`.
- After the reveal: `sentence_ends.json` and `planted_times.json` (sample numbers where each narrator sentence ended and where each planted error started and ended, no text), and `plan.json` (salt, places and classes of the planted errors, hashes of texts and audio; of the text, only the changed sentences, in both versions).

A set is published for every recording that a number or claim in the post rests on: the first-day check, every started session for numbers (cancelled and aborted ones too), the space-bar block and every demo take. Development recordings get none: `doctor`, `smoke`, the trial before the check, the no-camera listening and the rehearsal. The repository also holds the freeze files and results: `PREREG.md`, `params/frozen.json`, `scoring_rules.json`, `freeze_manifest.json`, `*.ots`, `results/results.json` and figures.

- **Never published:** face point coordinates, `sdk_raw.jsonl.gz`, `samples.jsonl`, `tap.log`. The app keeps no camera frames.
- **Always published:** the changed sentences, since the seal cannot be checked without them. In the sessions for numbers each one reveals a sentence of the author's own draft.
- **Device names** appear as the system shows them and may contain a person's name. `pack` prints them and waits for confirmation; a neutral name can replace them.
- **Off by default:** `--with-audio` (both channels of a session), `--with-clips` (two-second voice clips around each objection), `--with-texts` (full texts). Each needs the author's explicit yes for one session. The full version of this notice names each use.
- **No recall:** a published file stays in the git history and in other people's copies. The challenge rules give the organizer a perpetual, irrevocable license to the submission materials; as the author reads them, that includes the demo video (the author's voice and, unless the preview is removed, face) and the records in this repository.

## What goes to the AI assistant

The author builds and analyses the project with an AI assistant (Claude, by Anthropic) in a cloud agent session. This route is separate from the Insights transfer and covers only the author's recordings. By default all analysis runs on the Mac with `npm run` commands, and the assistant receives reports and reduced files: no audio, no text, no face point coordinates.

| What | When the assistant receives it |
|---|---|
| Reports (verdict, clock report, quick check, calibration, receipts, step log) and the files marked Yes above | By default; the first-day check goes as two archives (next rows) |
| First-day check, archive A: the recording up to 4:15 | Right away, for debugging. Audio only with the author's yes |
| First-day check, archive B: the objection block | Only after the hash of `params/frozen.json` is in the step log. Audio only with the author's yes |
| `audio.wav`, `samples.jsonl`, `tap.log`, draft texts, full texts after the reveal, source files of the demo shoot | Only with the author's yes, file by file |
| `sdk_raw.jsonl.gz`, a sealed plan before the reveal, the API key | Never |

- If the assistant runs commands on the Mac, the same rules hold, and every recording file it reads there counts as passed and is listed below. It does not open the sealed folder or `.env`, and reads audio, texts and `samples.jsonl` only with the author's yes.
- A file passed to the assistant stays in its cloud session; `purge` on the Mac does not delete it.
- If Kokoro runs in the cloud session, the assistant renders there the narrator audio for public texts: the first-day check sets and the judge sample. The author's drafts and the texts whose plan is hidden from the author (no-camera listening, rehearsal, space-bar block, demo takes) are voiced on the Mac by `npm run plant`.
- In the app, the model that plants the errors and the narrator's voice run locally. The app itself sends no draft text and no measurement to an AI service; the SDK's transfer above is separate.
- **Files passed so far:** none as of this first version (12 November 2026). Each file is added to this list by name when it is passed, and the list is checked against the conversation before the post is published.

## The judge page

The judge page (GitHub Pages, or `127.0.0.1` through `npm run judge` or the release archive) is static and has no server. The SDK never runs there, and the replay and the number check read only published files. In the no-camera mode the microphone turns on only for voice answers, after a short consent screen: the voice is analysed in the browser tab to find when you speak, and it is not saved and not uploaded. Answering with the space bar keeps the microphone off. GitHub hosts the page and this repository under its own privacy statement.

## The API key and transcripts

- The Presage API key is kept only in `.env` in the local clone, as `SMARTSPECTRA_API_KEY`. `.env` is excluded from git; the repository has `.env.example`. Only `tap` reads the key. A test looks for `.env` in the tree and the git history, and on the Mac also for the key's value. Non-secret settings, such as the camera name, which may contain a person's name, live in `settings.env`, also excluded from git.
- The key never goes to the AI assistant. Do not paste it into a chat, an issue or a commit. After the post is published on 22 November 2026, the author reissues the key on the Presage developer portal.
- A transcript of the assistant's session goes into the post only after a check for the key, personal paths, names and draft text; the same check covers video frames and screenshots. An uploaded session stays hidden until Make Public is pressed.

## Questions, requests and withdrawing consent

- `Cancel` on the consent screen keeps the camera and the microphone off; `Stop` turns both off at once. Delete local files with the purge commands above.
- Questions and requests about the app, including withdrawing consent: open an issue in this repository. Issues are public, so leave out personal details and keys.
- The app cannot recall what the SDK has already sent to Presage; Presage holds it under the SmartSpectra SDK Privacy Policy.
