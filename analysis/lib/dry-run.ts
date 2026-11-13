// Dry runs (spec 6.5): a folder written while tap ran its stand-in SDK (tap --dry, tests only) has
// `dry: true` at the top level of manifest.json (live/lib/manifest.cjs). No SDK and no camera ran,
// so it is no recording and never counts: quickcheck and the smoke report refuse it.

/** The words each verdict line puts after its prefix (RE-RECORD NOW:, DOCTOR FAIL:, SMOKE FAIL:). */
export const DRY_RUN_REASON = "dry run (tap's stand-in SDK)";

/** quickcheck's reason: the folder is refused, not checked. */
export const DRY_RUN_NEVER_COUNTS = `${DRY_RUN_REASON}, this folder never counts`;

/** The plain-words line printed before the verdict. */
export const DRY_RUN_NOTE =
  'manifest.json says dry: true: tap ran its stand-in SDK, so no SDK and no camera ran. Such a folder is no recording and never counts (spec 6.5); record again with the real SDK.';

/** True when manifest.json marks a dry run; a missing or unreadable manifest is not one. */
export function isDryRun(manifest: Readonly<Record<string, unknown>> | null | undefined): boolean {
  return manifest?.['dry'] === true;
}
