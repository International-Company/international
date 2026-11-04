import { toDecimalString } from '@/core/money/money';

/**
 * What a receipt's QR says when it is scanned: the deal, as plain text.
 *
 * Text and not a link, by the office's decision: whoever holds the paper should
 * read their receipt without being sent to the address the system runs on. It
 * needs no internet, and it proves nothing — it says what the paper says, so
 * checking a receipt against the books is done by searching its number.
 *
 * Kept short on purpose. Arabic takes two bytes a letter, and every byte makes
 * the squares smaller on a thermal roll, where they have to stay scannable.
 */

/** Past this the company's name is left out; the deal itself always fits. */
export const RECEIPT_QR_MAX_BYTES = 200;

const size = (lines: string[]) => new TextEncoder().encode(lines.join('\n')).length;

export function receiptQrText(receipt: {
  company: string;
  number: string;
  when: string;
  paid: { amount: bigint; currency: string };
  received: { amount: bigint; currency: string };
}): string {
  const deal = [
    `إيصال: ${receipt.number}`,
    receipt.when,
    `دفع: ${toDecimalString(receipt.paid.amount, 2)} ${receipt.paid.currency}`,
    `استلم: ${toDecimalString(receipt.received.amount, 2)} ${receipt.received.currency}`,
  ];
  const company = receipt.company.trim();
  const whole = company ? [company, ...deal] : deal;
  return (size(whole) <= RECEIPT_QR_MAX_BYTES ? whole : deal).join('\n');
}
