import { createHash } from 'node:crypto';

/** SHA-256 of bytes (or of a string's UTF-8), lowercase hex. */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
