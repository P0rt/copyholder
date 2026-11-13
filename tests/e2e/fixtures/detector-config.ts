// step() setup of the e2e runs: what host serves in /api/config `detector` before params/frozen.json
// exists (docs/protocol.md): preliminary parameters, sign 1, D1.

import type { DetectorChoice } from '../../../web/lib/detector-adapter.ts';

export const E2E_DETECTOR: DetectorChoice = { params: {}, sign: 1, variant: 'D1' };

/** Camera seconds of regular breathing after the narrator starts, before steep inhales (D1 needs 15 s and 10 breaths). */
export const WARMUP_S = 44;
