/**
 * A photo of what a customer paid, as it arrives from a browser.
 *
 * Checked by its bytes rather than by what the browser says it is: this is
 * stored and later served to staff and sent to the group, so it has to actually
 * be a picture. The screen shrinks it before sending, which is why the limit can
 * be small; the database is backed up whole, and every photo is carried with it.
 */

export const MAX_PROOF_BYTES = 3 * 1024 * 1024;

/** How many photos one deal can carry. */
export const MAX_PROOFS = 5;

export type ProofRefusal = 'errors.proofImageInvalid' | 'errors.proofImageTooLarge';

export function readProofImage(base64: string): { bytes: Buffer; mimeType: string } | ProofRefusal {
  const body = base64.replace(/^data:[^,]*,/, '').trim();
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return 'errors.proofImageInvalid';

  const bytes = Buffer.from(body, 'base64');
  if (bytes.length > MAX_PROOF_BYTES) return 'errors.proofImageTooLarge';

  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { bytes, mimeType: 'image/jpeg' };
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length > png.length && png.every((value, index) => bytes[index] === value)) {
    return { bytes, mimeType: 'image/png' };
  }
  return 'errors.proofImageInvalid';
}
