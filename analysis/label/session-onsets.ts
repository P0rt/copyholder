// HOOK, NOT BUILT YET: automatic onsets of the session variant of spec 7.6 (numbers sessions,
// space-bar block, rehearsal, demo take, listening without camera). There the search covers the
// whole time the narrator reads or a hold pause runs, with the floor N per anchor candidate, and
// the replies are classified by spec 4.2 (core/onset findSessionOnsets does the signal part).
// `label` calls sessionOnsetEvents() for every record kind but the gate; until it is built the
// command stops before writing anything.

import type { OnsetEvent } from '../../core/schemas/index.ts';
import type { LoadedSession } from '../lib/session.ts';

export class SessionVariantNotBuilt extends Error {
  constructor(kind: string) {
    super(`the session variant of the automatic onsets (spec 7.6) is not built yet, so a ${kind} recording cannot be labelled`);
    this.name = 'SessionVariantNotBuilt';
  }
}

/**
 * Automatic onsets.json events of a session recording (spec 4.2, 7.6), in time order, with
 * `label` and `manual` null; the window shown on the label page starts 1 s before `searchFrom`.
 * Not built yet: always throws SessionVariantNotBuilt.
 */
export function sessionOnsetEvents(session: Pick<LoadedSession, 'kind'>): Array<{ event: OnsetEvent; searchFrom: number }> {
  throw new SessionVariantNotBuilt(session.kind);
}
