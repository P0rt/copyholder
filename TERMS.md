# Terms of use

> **First version, 12 November 2026.** A short version, in place before the first run of the SmartSpectra SDK. It will be completed by 19 November 2026.

These terms cover the use of Copyholder: the app in this repository, the judge page built from it and the data published in `data/` and `results/`. Copyholder is an open-source project by the author of this repository (below: the author), made for the DEV Presage SmartSpectra SDK Challenge (November 2026). It is not a Presage product. By running the app or using the judge page you accept these terms. How data is handled is described in [PRIVACY.md](PRIVACY.md).

## These terms govern the app

- These terms, not the Presage Terms of Service, govern Copyholder and your use of it. Section 30.1 of the [Presage Terms of Service](https://presagetech.com/legal/terms-of-service) (2 November 2026) asks every app built on the SmartSpectra SDK to have its own terms of use; these are those terms.
- The live mode needs your own API key from the [Presage developer portal](https://physiology.presagetech.com). Your key and your use of the SDK are governed by the agreement between you and Presage.
- The SDK is not part of this repository. `npm run setup:live` installs `@smartspectra/node-sdk` 3.5.0 from npm into `live/`, under its own license. Nothing here gives any right to Presage's name or logo.
- The code is released under the MIT License: see [LICENSE](LICENSE). Texts written for the narrator to read, such as the `gate/` and `sample/` texts and the texts of the space-bar block and the demo takes, are released under CC0 1.0. The license for the published data will be named in `LICENSE-DATA` before the post is published.

## Who may be measured

- Measure only yourself. You must be 18 or older.
- The app is not for anyone under 18: the Presage Terms of Service (sections 7.1 and 30.1) forbid using the SDK on them.
- Only you may be in the camera frame: no other people, and no faces on screens or posters behind you.
- The camera and the microphone turn on only after you press `I agree, start` on the consent screen. `Stop` turns both off at once.

## Not for health decisions

SDK metrics are offered for general wellness and informational purposes only. SDK metrics have not been cleared by the FDA and may not be used for medical diagnosis or treatment. This app makes no diagnosis and no health claim.

You may not use the app or its output (its recordings, numbers and published data) to make any decision about your own health or anyone else's, or present them as fit for that purpose.

## What you may not do

- You may not reverse engineer, decompile or disassemble the SmartSpectra SDK, or try to extract its models or algorithms.
- You may not use the app or its output for medical diagnosis or treatment, or present them as a means of diagnosis or treatment.
- You may not use the SDK's output to build a product that competes with Presage.
- You may not use the app or its output to make decisions about a person's job, insurance, credit, housing, education or benefits, or about a person's truthfulness or trustworthiness.
- You may not use the app or its output to infer the emotions of people at work or in education.
- You may not measure anyone but yourself, or anyone under 18.

## No warranty and no liability

- Copyholder is an experiment made for a challenge entry. It is provided "as is", without warranty of any kind. The narrator may stop late, early or not at all, and the published numbers describe one person with one setup.
- To the extent the law allows, the author is not liable for any loss or damage that arises from using Copyholder.
- On behalf of Presage, and to the extent the law allows, these terms disclaim all warranties, express or implied, for the Presage technology that Copyholder uses (the SmartSpectra SDK, its models, services and output), and all liability of Presage for any loss or damage that arises from your use of Copyholder.

## Changes and contact

These terms may change; every change is in the git history of this file. Questions and requests about the app: open an issue in this repository. Issues are public, so leave out personal details and keys.
