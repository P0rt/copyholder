# Privacy notice

> **Version of 20 November 2026.** The first version, of 12 November 2026, was in place before the first run of the SmartSpectra SDK. This version follows the amendment in section 11 of PREREG.md and lists the files passed to the AI assistant so far. Every change is in the git history of this file.

Copyholder is an open-source app by the author of this repository (below: the author), made for the DEV Presage SmartSpectra SDK Challenge (November 2026). It is not a Presage product. This notice covers the app and the recordings the author publishes here. Section 30.1 of the Presage Terms of Service asks every app built on the SDK to give its users such a notice. Terms of use: [TERMS.md](TERMS.md).

Sources: the [SmartSpectra SDK Privacy Policy](https://presagetech.com/legal/privacy-policy) of 3 November 2026 ("Policy" below; the SDK policy on that page), the [Presage Terms of Service](https://presagetech.com/legal/terms-of-service) of 2 November 2026 and the SDK documentation on [telemetry and privacy](https://smartspectra.presagetech.com/docs/telemetry-and-privacy) and [Insights](https://smartspectra.presagetech.com/docs/llm-insights).

## Consent

Copyholder measures only the person who pressed `I agree, start`. The camera and the microphone turn on only after that button. While they are on, an indicator shows in the window, and `Stop` turns both off at once. In the camera modes (`npm run gate`, `npm run smoke` and `npm run headstart`) the consent screen lists:

> - Camera frames are processed on this computer by the SmartSpectra SDK. The app does not store or upload them.
> - In every session the SDK itself sends derived measurements (such as breathing rate) with session identifiers to Presage in the United States. Presage passes them to its AI provider, Anthropic, to generate "Insights". This cannot currently be switched off. The app never requests an Insight and sends no prompt text.
> - The SDK also sends app credentials, hashed device identifiers and usage records, and Presage's servers see the IP address.
> - SDK telemetry is switched off (`enableTelemetry: false`). That does not switch off authentication, model delivery or the transfer above.
> - Your microphone recording, the chest trace, face points and the SDK's raw messages, which include the full face mesh, are saved to the folder `sessions/<id>/` on this computer. The app uploads none of it.
> - Measure only yourself. You must be 18 or older.
> - SDK metrics are offered for general wellness and informational purposes only. SDK metrics have not been cleared by the FDA and may not be used for medical diagnosis or treatment. This app makes no diagnosis and no health claim.

`npm run doctor` turns on only the microphone and does not start the SDK. Its shorter screen says so and says where the microphone recording is saved.

## Where data goes

| Data | Where it goes | Can it be switched off | What the app does |
|---|---|---|---|
| Camera frames read by the SDK | Stay on the computer: the SDK processes them on the device and does not send them to Presage (Policy 3.1) | Not needed | Does not store or upload them |
| Face points | Not sent to Presage (Policy 3.1). `tap` passes 16 points to the page over a local socket | Not needed | Saved in the session folder. Coordinates are never published: the published set keeps two numbers computed from them, the lip gap and head movement, and a gate set also the numbers of the packets stage B reads as resets of the SDK's face tracking (`g_resets.json`) |
| Breathing trace | Not in the list of metrics the SDK documentation names for Insights. `tap` passes it to the page over a local socket | Not needed | Saved in the session folder. Trace samples are published in `data/<id>/` |
| Derived measurements, such as breathing rate, with session identifiers | To Presage (United States), and from there to Anthropic for the Insights feature (Policy 4.2, 7.1) | No (Policy 7.4) | Disclosed on the consent screen and here; `README.md` and the post will repeat it. The app never calls `requestInsight` and sends no prompt text |
| App credentials (the API key), app attestation token, hashed device identifiers, SDK version, usage records. The servers see the IP address (Policy 4.3, 4.4) | To Presage | No | Disclosed in the same places |
| SDK telemetry: session summaries and device readiness reports | To Presage | Yes | Switched off with `enableTelemetry: false`. This does not switch off key checks, model delivery or Insights (Policy 4.4) |
| Microphone audio | The app does not send it: the page passes it to `host` over a local socket | Not needed | Saved to `audio.wav` as the time reference. The published set has its level in 10 ms steps, and a gate set with its verdict the sample numbers at which stage B finds the sniffs in it (`sniff_onsets.json`); the audio itself is published only with `pack --with-audio`. The demo take's audio goes into the video |
| Narrator texts and audio | Public in `gate/` and `sample/`. The AI assistant wrote the texts and rendered the audio with Kokoro in its own cloud container | Not needed | The page plays the clips from this repository through `host` |
| `data/<id>/`, `results/`, freeze files, code | GitHub: this repository | The base set is needed for the claim. Audio is added only by the author | See "What is published" |
| Demo video: a recording of the whole screen during the published take, with the take's two-channel audio, which holds the author's voice. The screen shows the take's page with the live chest trace, and anything else on it at the time, such as a notification or another window: `npm run video` does not crop the picture | A video host (YouTube is planned) and the DEV post | Audio is required | The page shows no camera image. No other people in the frame |
| Terminal output of the commands the AI assistant runs on the Mac, and the files it reads there | Anthropic, through the Claude Code session of the AI assistant (Claude, by Anthropic) | Reports by default. Audio, `samples.jsonl` and `tap.log` only with the author's yes | Listed below |

Publishing and the AI assistant concern only the author's recordings. If you run the app yourself, your files stay in your own `sessions/<id>/`; the app uploads none of them and passes none of them on, and `npm run pack` only writes a folder on your computer.

The app does not request pulse or its variability. As the author reads the SDK documentation, breathing rate is then the only Insights metric left; whether Insights snapshots are sent with this metric set, the documentation does not say, and `npm run smoke` looks for upload entries in the SDK log. The disclosure stays either way. Presage keeps what it receives as Policy 10.1 says: Insights requests and responses while the developer account is active, deleted no later than 60 days after it is closed; usage records and telemetry for up to 365 days.

The camera modes need the network the whole time: the SDK checks its entitlement during the session and has no offline mode. `npm run doctor` and runs with `--tap mock` do not start the SDK, so there is no transfer to Presage. The network is also used to install packages, to download the Kokoro voice model (on the first voice self-test of `npm run doctor` or the first `npm run tts`) and to get OpenTimestamps stamps; session recordings are not part of those requests.

## Files on the computer

Each recording goes into its session folder `sessions/<id>/` (`COPYHOLDER_SESSIONS_DIR` moves `sessions/`), where `host`, `tap` and the analysis commands write their files. The folder stays on the computer that runs the app and is excluded from git. The files that matter for privacy:

| File | Contents | Published | Passed to the AI assistant |
|---|---|---|---|
| `sdk_raw.jsonl.gz` | Raw SDK messages with arrival times, including the full face mesh of 478 points | Never | Never |
| `samples.jsonl` | All that `tap` passed to the page: trace, `talking` flag, 16 lip and eye points, lip gap, head movement, SDK statuses | Never; a gate set lists in `g_resets.json` only the numbers of the packets stage B reads as resets of the SDK's face tracking: those `samples.jsonl` flags, and those with `g` null that `samples.jsonl` does not explain | Only with the author's yes |
| `tap.log` | What `tap` printed to the terminal: camera names, which may contain a person's name; the checks of the SDK's status and error codes; the SDK's device readiness verdict; probe lines with the x and y extent of the face points in frame pixels; SDK errors; `tap`'s error traces, whose local file paths can show the account name on the computer; and, in `smoke`, the SDK's own info log. Text shaped like a key, an id or a hash is replaced by `[redacted]`; the words of file paths and web addresses are kept | Never | Only with the author's yes |
| `audio.wav` | Microphone and narrator output, two channels | Only with `pack --with-audio`; a gate set with its verdict lists in `sniff_onsets.json` only the sample numbers at which stage B finds the sniffs in the microphone channel | Only with the author's yes |
| `detector_in.jsonl` | All detector inputs as numbers; no face point coordinates | Yes, as `stream.jsonl` | Yes |
| `events.jsonl`, `stamps.jsonl` | Script steps, triggers, stops, window and device events, with sample numbers. `events.jsonl` also holds the text of each SDK or `tap` error message during the recording, cut to 300 characters, in which only the API key is blanked out: an id or a local file path in such a message, which can show the account name on the computer, stays in it | `events.jsonl` in full, error messages included; from `stamps.jsonl` only sample numbers, and in a gate set its cue and step marks (`marks.jsonl`: sample numbers, cue numbers and step names, no text) | Yes |
| `manifest.json` | Mode, versions, the Mac model, the browser, device names, microphone settings, the app commit, times, file hashes | Yes, without local paths and device identifiers | Yes |
| `onsets.json` | Voice onsets and the participant's labels | Yes | Yes |

`npm run doctor` runs without `tap`, so its folder has no `sdk_raw.jsonl.gz`, `samples.jsonl` or `tap.log`; a run with `--tap mock` has no `sdk_raw.jsonl.gz`. The other files hold reports and numbers, with no audio and no face point coordinates: `calib.json`, `quickcheck.json`, the step log `ledger.jsonl`, `clock_report.json`, `verdict.md` and `verdict.json`, `retune-report.json` and `retune-report.md` of pack A, and `smoke_report.json`, which also holds the camera names `tap` printed. Chrome keeps the page's microphone permission in a profile of its own, `~/.copyholder/chrome-profile`; the label page has another one next to it. Under `npm run live:electron` the page runs in an Electron window instead, which keeps its data in Electron's folder for the app `copyholder-electron` (on a Mac, `~/Library/Application Support/copyholder-electron`). macOS keeps the camera and microphone permissions it gave, for example to the terminal app, to Chrome or to Electron. The screen recording of a demo take and the finished video stay where they were saved and never go into git.

## Retention and deletion

The app deletes nothing by itself: files stay until you delete them.

- `npm run purge -- <id> --raw` deletes only `sessions/<id>/sdk_raw.jsonl.gz`. `npm run purge -- --raw --all` does the same for every session folder.
- `npm run purge -- <id>` deletes the whole folder `sessions/<id>/`. For the folder of a gate pack A, B or C recording or of a headstart take whose set `data/<id>/` does not exist yet, and for a folder whose `manifest.json` cannot be read or names no known kind, it refuses unless `--force` is given. A run no SDK measured (a dry run or a run with `--tap mock`) gets no set, so purge deletes its folder without `--force`. Keep the folder of a gate run of pack A, B or C with `--tap mock` that reached its objection block (4:15): it is the record that the planted errors of the pack were played (PREREG.md section 7.1), as quickcheck, `clocks`, `label` and `analyze:gate` say; it stays in `sessions/` and gets no set.
- Without `--yes` these commands only print what they would delete.
- They delete files on the computer only. They do not touch the published set or files already passed to the AI assistant.
- To remove the microphone permission and the rest of the two Chrome profiles, delete the folder `~/.copyholder/`. If you used `npm run live:electron`, also delete `~/Library/Application Support/copyholder-electron`. Turn off the camera and microphone permissions of the terminal app, Chrome or Electron in System Settings > Privacy & Security > Camera and Microphone.
- **Retention of the author's recordings:** `sdk_raw.jsonl.gz` is deleted right after the post is published (by 23 November 2026). All other recordings on the Mac are kept until the winners are announced on 10 December 2026, then deleted. If you run the app yourself, you choose when to delete yours.

## What is published

`npm run pack -- <id> --devices-ok` builds the published set `data/<id>/` from the session folder `sessions/<id>/`. It exits with 0 when it wrote the set, 1 when it refused and wrote nothing, and 2 for a usage error.

- **Which recordings get a set:** gate packs A, B and C, and the headstart takes, which are the demo takes of section 11 of PREREG.md. `pack` refuses pack 0, `doctor`, `smoke` and every other kind of recording, and says why. The author publishes sets for the recordings of packs A, B and C and for the one demo take that the rule of section 11 picks: the first take that qualifies, or the last take if none does (`npm run take` prints which). The demo video shows that take.
- **What a set may hold:** only files on the list in `core/schemas/published.ts`. For a gate pack or a demo take these are:
  - `manifest.json`, a public copy (see device names below).
  - `stream.jsonl`, made from `detector_in.jsonl`: breathing trace samples with timestamps and the arrival sample `nArr`, two numbers computed from the face points (the lip gap divided by the distance between the outer eye corners, and head movement), the `talking` flag, SDK statuses, voice detector edges and narrator states.
  - `events.jsonl`: script steps, triggers, stops with their cause, window and device events, and the text of SDK and `tap` error messages as the session folder holds it (see the table above: only the API key is blanked out of it).
  - `audio_env.json`: the level of both channels in 10 ms steps. This is not audio.
  - Where the recording has them: `onsets.json`, `calib.json`, `clock_report.json`, and for a gate pack `verdict.md` and `verdict.json`.
  - For a gate pack also `marks.jsonl`, the cue and step marks of `stamps.jsonl` as they are: sample numbers, cue numbers and step names, no text; `g_resets.json`, the numbers of the packets stage B reads as resets of the SDK's face tracking: those `samples.jsonl` flags, and those with `g` null that `samples.jsonl` does not explain; and, with the verdict, `sniff_onsets.json`, the sample numbers at which stage B finds the sniffs in the microphone channel of `audio.wav`. With them `npm run replay` recomputes the verdict from the set alone. A demo take gets none of them.
  - The list also names files of the dropped first design, such as receipts, which no command writes now.
- **Never published:** face point coordinates, `sdk_raw.jsonl.gz`, `samples.jsonl` (only the numbers of the packets stage B reads as tracking resets reach `g_resets.json`), `tap.log`, `stamps.jsonl` (only its sample numbers reach `stream.jsonl`, and its cue and step marks `marks.jsonl`), `detector_in.jsonl` (only as `stream.jsonl`), `quickcheck.json` and `ledger.jsonl`. The app keeps no camera frames.
- **Device names** appear as the system shows them and may contain a person's name. Without `--devices-ok`, `pack` prints every device name the manifest holds (camera, microphone, output) and writes nothing. `--alias "<system name>=<published name>"`, once for each name, replaces a name in the published manifest only. The published manifest also leaves out local paths and the microphone's device identifiers.
- **Off by default:** `--with-audio <id>` also copies `audio.wav`, both channels of the recording, with the participant's voice. Its value must repeat the session id. Each use needs the author's explicit yes for one recording and is named in this notice. Published audio falls under the Copyholder data license like the rest of the set, so anyone may then copy and analyze the recording of the voice on its conditions.
- `pack` refuses when `data/<id>/` already exists, unless `--replace` is given.
- **License:** the sets and `results/` are under the Copyholder data license ([LICENSE-DATA](LICENSE-DATA)): anyone may copy, share and analyze them and publish what they find, if they name the source and follow [TERMS.md](TERMS.md), whose limits apply to the data as they do to the app.
- **No recall:** a published file stays in the git history and in other people's copies. The challenge rules give the organizer a perpetual, irrevocable license to the submission materials; as the author reads them, that includes the demo video (with the author's voice) and the records in this repository.

The repository also holds the freeze files and the results, once each step has run: `PREREG.md` and `PREREG.md.ots`, `params/frozen.json`, `params/retune.json` and `params/retune.json.ots`, `results/confirm.json` and `results/confirm.md`. These name each recording by its session id and, when an operator renamed its folder, by the folder name too, never by a path; give a renamed folder a name with no personal details.

## What goes to the AI assistant

The author builds and analyses the project with an AI assistant (Claude, by Anthropic) in a Claude Code cloud session. This route is separate from the Insights transfer and covers only the author's recordings.

- The assistant wrote the code and the texts the narrator reads, and rendered the narrator audio of `gate/` and `sample/` with Kokoro in its own cloud container.
- At the author's request it runs the app's commands on the author's Mac through a Claude Code Remote Control session. The terminal output of those commands, and every file it reads on the Mac, reaches Anthropic's servers as part of that session. The author starts every camera run by typing the command in a terminal on the Mac.

| What | When the assistant receives it |
|---|---|
| Reports (quick check, clock report, calibration, verdict, retune report, smoke report, step log) and the files marked Yes above | By default |
| `audio.wav`, `samples.jsonl`, `tap.log`, the screen recording of a demo take | Only with the author's yes, file by file |
| `sdk_raw.jsonl.gz`, the API key | Never |

- Every recording file the assistant reads on the Mac counts as passed and is listed below, also when a command it runs reads the file and prints only numbers. It does not open `.env`, and reads `audio.wav`, `samples.jsonl` and `tap.log` only with the author's yes.
- `quickcheck`, `clocks`, `label`, `analyze:gate`, `retune` and `confirm` load `audio.wav` and `samples.jsonl` of every recording they read; `pack` loads `audio.wav`, and `samples.jsonl` of a gate recording; `video` loads `audio.wav`; `take` reads only `stamps.jsonl` and `manifest.json`. `confirm` also reads `manifest.json` of every folder in the sessions folder, and of the other gate recordings of packs B and C there `ledger.jsonl`, `quickcheck.json`, `clock_report.json`, `calib.json`, `onsets.json`, `events.jsonl`, `stamps.jsonl`, `samples.jsonl`, `detector_in.jsonl`, `verdict.json` and `verdict.md`, but not their `audio.wav`. When the assistant runs one of these commands on a recording, those files count as passed. So for packs A, B and C and the demo takes it runs them only after the author's yes for that recording (for `confirm`, for every gate recording of packs B and C in the sessions folder); without it, the author runs them and passes on only the reports.
- A file passed to the assistant stays in its cloud session; `purge` on the Mac does not delete it.
- In the app, the narrator's voice plays from files in this repository. The app itself sends no recording and no measurement to an AI service; the SDK's transfer above is separate.
- **Files passed so far.** Each file is added to this list by name when it is passed, and the list is checked against the conversation before the post is published. All reads below were on 20 November 2026, by the assistant running commands on the Mac, and all are development recordings, which are not published:
  - `doctor-1`, `doctor-2`: `manifest.json`, `events.jsonl`, `stamps.jsonl`, `calib.json`; `audio.wav` through the repository's loop check analysis, which printed only the delay and level of each click.
  - `doctor-3`: `manifest.json`, `events.jsonl`, `stamps.jsonl`, `calib.json`; `audio.wav` through the same analysis and a one-off check of the microphone channel's peak and clipped samples, numbers only.
  - `smoke-1`: `events.jsonl`.
  - `smoke-2`: `manifest.json`, `events.jsonl`, `stamps.jsonl`, `tap.log`; `samples.jsonl`, of which a few lines around the SDK's status and error messages were printed, and from which the repository's analysis gave the breathing trace medians and the shares of SDK statuses; `audio.wav` was loaded by that analysis, and nothing from it was used.
  - For every session above: the file list with sizes and times, and the terminal output of the run.
  - Not read: `sdk_raw.jsonl.gz`, `detector_in.jsonl`, any sealed folder, and `.env`, which was only checked for a line that holds a key.
  - The reads of `audio.wav` and `samples.jsonl` above came before the author's yes. The author gave it afterwards, on 20 November 2026, for these reads and for the files of the technical runs that follow (`doctor`, `smoke` and pack 0 of the first-day check), for debugging. Packs A, B and C and the demo takes needed a separate yes. The author gave it on 20 November 2026, before any of them was recorded: the assistant runs the analysis commands on these recordings on the Mac, which load their `audio.wav` and `samples.jsonl`, and their sets are published without audio (no `--with-audio`). Each file of theirs that the assistant reads is added below by name.

## The API key and transcripts

- The Presage API key is kept only in `.env` in the local clone, as `SMARTSPECTRA_API_KEY`. `.env` is excluded from git; the repository has `.env.example`. In the app, only `tap` reads the key. A test looks for `.env` in the tree and the git history, and on the Mac also for the key's value. Non-secret settings, such as the camera name, which may contain a person's name, live in `settings.env`, also excluded from git.
- The key never goes to the AI assistant. Do not paste it into a chat, an issue or a commit. After the post is published, the author reissues the key on the Presage developer portal.
- A transcript of the assistant's session goes into the post only after a check for the key, personal paths and names; the same check covers video frames and screenshots. An uploaded session stays hidden until Make Public is pressed.

## Questions, requests and withdrawing consent

- `Cancel` on the consent screen keeps the camera and the microphone off; `Stop` turns both off at once. Delete local files with the purge commands above.
- Questions and requests about the app, including withdrawing consent: open an issue in this repository. Issues are public, so leave out personal details and keys.
- The app cannot recall what the SDK has already sent to Presage; Presage holds it under the SmartSpectra SDK Privacy Policy.
