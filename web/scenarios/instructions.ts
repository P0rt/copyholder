// Instruction screens shown after consent and before Start. The gate text for packs A, B and C is
// spec 9.2 verbatim (frozen by the gate-prereg tag); the other texts are the page's own wording.

export type InstructionBlock =
  | { kind: 'p'; text: string }
  | { kind: 'ol'; items: string[] }
  | { kind: 'lines'; lines: string[] };

export interface Instruction {
  blocks: InstructionBlock[];
  /** Line shown next to the button; may be ''. */
  footer: string;
  button: string;
}

const CORRECTION_LINES = [
  'Correct the narrator as you would correct a person.',
  'Do not think about breathing.',
  'If you did not catch what was wrong, say: "No, that was wrong."',
];

/** Spec 9.2, verbatim. Item 3 is one paragraph on screen. */
export const GATE_INSTRUCTION: Instruction = {
  blocks: [
    { kind: 'p', text: 'The recording takes about ten minutes. The narrator never stops.' },
    {
      kind: 'ol',
      items: [
        'Minute one: follow the prompts.',
        'Three minutes: listen, stay silent.',
        'Five minutes: 14 obvious mistakes. When the dot under the camera fills, say the correction aloud, three to five words.',
      ],
    },
    { kind: 'lines', lines: CORRECTION_LINES },
  ],
  footer: 'Sit still, eyes on the dot.',
  button: 'Start',
};

/** Pack 0 (spec 9.4): the gate text with the probe's durations and two cues (assumption). */
export const GATE_PROBE_INSTRUCTION: Instruction = {
  blocks: [
    { kind: 'p', text: 'The recording takes about three minutes. The narrator never stops.' },
    {
      kind: 'ol',
      items: [
        'Minute one: follow the prompts.',
        'Half a minute: listen, stay silent.',
        'One minute: 2 obvious mistakes. When the dot under the camera fills, say the correction aloud, three to five words.',
      ],
    },
    { kind: 'lines', lines: CORRECTION_LINES },
  ],
  footer: 'Sit still, eyes on the dot.',
  button: 'Start',
};

export const DOCTOR_INSTRUCTION: Instruction = {
  blocks: [
    { kind: 'p', text: 'Sound and device check, without the camera. About seven minutes.' },
    {
      kind: 'ol',
      items: [
        'Check the device names and the microphone settings on the next screen.',
        'Loop check: take the headset off and hold one earcup on the microphone while it clicks.',
        'Put the headset on. Listen to a 20-second sample twice and choose a level.',
        'Breathe in loudly three times when asked.',
        'Rest with the headset on. The second loop check comes five minutes after the first.',
      ],
    },
    { kind: 'lines', lines: ['Do not change the system volume after this check.'] },
  ],
  footer: '',
  button: 'Start',
};

export const DOCTOR_LEVEL_INSTRUCTION: Instruction = {
  blocks: [
    { kind: 'p', text: 'Volume only, without the camera. About two minutes.' },
    {
      kind: 'ol',
      items: [
        'Put the headset on and stay silent.',
        'Listen to a 20-second sample twice and choose a level.',
        'Stay silent while the sample plays once more.',
      ],
    },
  ],
  footer: '',
  button: 'Start',
};

export const SMOKE_INSTRUCTION: Instruction = {
  blocks: [
    { kind: 'p', text: 'First camera run. About two minutes.' },
    {
      kind: 'ol',
      items: [
        'Sit in the recording pose and follow the prompts.',
        'Breathe with the bar three times.',
        'When asked, start the macOS screen recording, then sit still for a minute.',
        'When asked, cover the lens for two seconds.',
      ],
    },
  ],
  footer: 'Sit still, eyes on the dot.',
  button: 'Start',
};

/** The instruction as plain text, one paragraph per line group, as the spec writes it. */
export function instructionPlainText(ins: Instruction): string {
  const parts = ins.blocks.map((b) => {
    if (b.kind === 'p') return b.text;
    if (b.kind === 'ol') return b.items.map((item, i) => `${i + 1}. ${item}`).join('\n');
    return b.lines.join('\n');
  });
  const last = ins.footer ? `${ins.footer}   [ ${ins.button} ]` : `[ ${ins.button} ]`;
  return [...parts, last].join('\n\n');
}
