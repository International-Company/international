import 'server-only';
import { env } from '@/core/config/env';
import { hmacSha256, timingSafeEqual } from '@/core/security/crypto';

/**
 * The code behind a receipt's QR: the transaction's reference and a short
 * signature over it.
 *
 * The signature is what makes the QR worth scanning. Without it anyone could
 * print a QR for any reference they had seen; with it, only a receipt this
 * system printed opens the verification page at all, and the page then shows
 * what the books hold — so an amount changed on the paper reads as changed.
 */

function sign(reference: string): string {
  return hmacSha256(env.AUTH_SECRET, `receipt-verify:${reference}`).slice(0, 12);
}

export function verificationToken(reference: string): string {
  return `${reference}.${sign(reference)}`;
}

/** The reference a token stands for, or null when it was not signed here. */
export function readToken(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const reference = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  return timingSafeEqual(signature, sign(reference)) ? reference : null;
}
