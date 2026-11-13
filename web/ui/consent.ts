// Consent screen texts (spec 12.2) and the consent token that gates the microphone and the SDK start.
// Each bullet is one paragraph on screen. Keep every paragraph on one source line: lint:words matches
// the allowed disclaimer phrases line by line.

export interface ConsentText {
  title: string;
  /** Paragraph before the bullets. */
  lead: string;
  bullets: ConsentBullet[];
  /** Paragraph after the bullets ('' for none). */
  after: string;
  agree: string;
  cancel: string;
}

/** A bullet as text runs; code runs are shown in a monospace font instead of backticks (spec 12.2). */
export type ConsentBullet = Array<{ text: string; code?: boolean }>;

const AGREE = 'I agree, start';
const CANCEL = 'Cancel';

function plain(text: string): ConsentBullet {
  return [{ text }];
}

/** Live modes: camera and microphone (spec 12.2, verbatim). `<id>` is replaced by the session name. */
export function liveConsentText(sessionId: string, facePreview = false): ConsentText {
  const bullets: ConsentBullet[] = [
    plain('Camera frames are processed on this computer by the SmartSpectra SDK. The app does not store or upload them.'),
  ];
  if (facePreview) {
    // Demo take only (spec 12.2, 15.5); this wording is the spec's assumption.
    bullets.push(plain('This take also turns on the built-in camera for a face preview in the corner of this page. Its frames are only drawn on screen: the app does not store or upload them, and they do not go to the SDK. The screen recording will show the preview.'));
  }
  bullets.push(
    plain('In every session the SDK itself sends derived measurements (such as breathing rate) with session identifiers to Presage in the United States. Presage passes them to its AI provider, Anthropic, to generate "Insights". This cannot currently be switched off. The app never requests an Insight and sends no prompt text.'),
    plain("The SDK also sends app credentials, hashed device identifiers and usage records, and Presage's servers see the IP address."),
    [
      { text: 'SDK telemetry is switched off (' },
      { text: 'enableTelemetry: false', code: true },
      { text: '). That does not switch off authentication, model delivery or the transfer above.' },
    ],
    plain(`Your microphone recording, the chest trace, face points and the SDK's raw messages, which include the full face mesh, are saved to the folder sessions/${sessionId}/ on this computer. The app uploads none of it.`),
    plain('Measure only yourself. You must be 18 or older.'),
    plain('SDK metrics are offered for general wellness and informational purposes only. SDK metrics have not been cleared by the FDA and may not be used for medical diagnosis or treatment. This app makes no diagnosis and no health claim.'),
  );
  return {
    title: 'Before you start',
    lead: 'Copyholder will turn on your camera and your microphone.',
    bullets,
    after: 'Privacy notice: PRIVACY.md. Terms of use: TERMS.md.',
    agree: AGREE,
    cancel: CANCEL,
  };
}

const MIC_LEAD = 'This mode turns on your microphone only. The camera stays off and the SmartSpectra SDK does not run.';

/**
 * Microphone-only modes with a session folder (doctor, spacebar): spec 12.2 keeps the microphone
 * line and the line on whether and where the recording is saved. Wording follows the short screen
 * of spec 12.2 (assumption).
 */
export function micConsentText(sessionId: string): ConsentText {
  return {
    title: 'Before you start',
    lead: MIC_LEAD,
    bullets: [plain(`Your microphone recording is saved to the folder sessions/${sessionId}/ on this computer. The app uploads none of it.`)],
    after: '',
    agree: AGREE,
    cancel: CANCEL,
  };
}

/** Static judge page without a session folder (spec 12.2, 7.11), verbatim. */
export function judgeMicConsentText(): ConsentText {
  return {
    title: 'Before you start',
    lead: MIC_LEAD,
    bullets: [
      plain('Your voice is analysed in this browser tab to find when you speak. It is not saved and not uploaded.'),
      plain("Use headphones, or the narrator's voice will reach the microphone."),
    ],
    after: '',
    agree: AGREE,
    cancel: CANCEL,
  };
}

/** The consent screen as plain text, the way the rendered page reads (bullets as "- ..."). */
export function consentPlainText(c: ConsentText): string {
  const bullets = c.bullets.map((b) => `- ${b.map((r) => r.text).join('')}`).join('\n');
  const parts = [c.title, c.lead, bullets];
  if (c.after) parts.push(c.after);
  parts.push(`[ ${c.agree} ]   [ ${c.cancel} ]`);
  return parts.join('\n\n');
}

// The consent token. Only the consent screen's agree handler mints one; startSession() refuses to
// touch the microphone, the AudioContext, the worker or the sockets without it (spec 12.2).
const MINTED = new WeakSet<object>();

export interface Consent {
  readonly given: true;
  /** ISO time of the 'I agree, start' click. */
  readonly at: string;
}

/** Called only from the 'I agree, start' click handler. */
export function grantConsent(at: string): Consent {
  const token: Consent = Object.freeze({ given: true as const, at });
  MINTED.add(token);
  return token;
}

export function isConsent(value: unknown): value is Consent {
  return typeof value === 'object' && value !== null && MINTED.has(value);
}

export function assertConsent(value: unknown): asserts value is Consent {
  if (!isConsent(value)) throw new Error('no consent: the microphone and the SDK stay off until "I agree, start" is pressed');
}
