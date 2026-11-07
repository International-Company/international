import { toDecimalString, wholeAmount } from '@/core/money/money';
import { formatAmount } from '@/modules/whatsapp/report-command';

/** A TikTok withdrawal's sums, and the words it goes to its group with as the photo's caption. */

export const TIKTOK_DEAL_TYPE = 'TIKTOK_WITHDRAWAL';

/** What the dollars come to in shekels at this price, whole as the office hands it over. */
export function tiktokPayout(amount: bigint, rate: bigint): bigint {
  return wholeAmount((amount * rate) / 100_000_000n) * 100_000_000n;
}

/** A price as it is typed: 2.55, not 2.5500. */
export function rateText(rate: bigint): string {
  return toDecimalString(rate, 4).replace(/\.?0+$/, '');
}

/** A day's sums per currency, from the withdrawals that stand. */
export function tiktokTotals(
  rows: { amount: bigint; currency: string; payoutAmount: bigint; deleted: boolean }[],
): { withdrawn: { currency: string; amount: bigint }[]; paid: bigint; count: number } {
  const standing = rows.filter((row) => !row.deleted);
  const withdrawn = new Map<string, bigint>();
  for (const { currency, amount } of standing) {
    withdrawn.set(currency, (withdrawn.get(currency) ?? 0n) + amount);
  }
  return {
    withdrawn: [...withdrawn].map(([currency, amount]) => ({ currency, amount })),
    paid: standing.reduce((sum, row) => sum + row.payoutAmount, 0n),
    count: standing.length,
  };
}

const shekels = (scaled: bigint) => `${scaled / 100_000_000n} ش`;

interface Withdrawal {
  account: string;
  channel: string;
  beneficiaryName: string;
  payoutAmount: bigint;
}

/** A line each with a blank between, in the order the office writes a transfer. */
export function composeWithdrawal({
  account,
  channel,
  beneficiaryName,
  payoutAmount,
}: Withdrawal): string {
  return [account, channel, beneficiaryName.trim(), shekels(payoutAmount)].join('\n\n');
}

/** For the group that only needs to know whose it is: the photo carries the name alone. */
export function composeWithdrawalName({ beneficiaryName }: { beneficiaryName: string }): string {
  return beneficiaryName.trim();
}

/** That group's word that one was deleted: the name, marked, and nothing more. */
export function composeWithdrawalNameDeleted({
  beneficiaryName,
}: {
  beneficiaryName: string;
}): string {
  return `🔴 *سحب ملغى*\n\n${beneficiaryName.trim()}`;
}

/** Says which one by whatever it holds: a record from before the shekels has only its amount. */
export function composeWithdrawalDeleted(
  {
    amount,
    currency,
    account,
    channel,
    beneficiaryName,
    payoutAmount,
  }: Withdrawal & { amount: bigint; currency: string },
  by: string | null,
): string {
  return [
    '🔴 *حذف سحب تيكتوك*',
    account,
    channel,
    beneficiaryName.trim(),
    payoutAmount > 0n ? shekels(payoutAmount) : formatAmount({ currency, amount }),
    by ? `حذفها: ${by}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

/** What a group types for the day's TikTok reconciliation. */
export const RECONCILE_CODE = '#مطابقة';

export interface ReconcileRow {
  amount: bigint;
  currency: string;
  /** The pounds the photo shows, when the teller typed them. */
  egpAmount: bigint | null;
}

/**
 * What the TikTok group checks against what it was sent: the day's withdrawals
 * added up, the dollars and the pounds. Withdrawals whose pounds were left blank
 * are counted, so the pound total is not taken for the whole day's.
 */
export function composeReconciliation(rows: ReconcileRow[], day: string, asOf: string): string {
  const totals = tiktokTotals(rows.map((row) => ({ ...row, payoutAmount: 0n, deleted: false })));
  const dollars = totals.withdrawn.length
    ? totals.withdrawn.map((total) => `مجموع الدولار: *${formatAmount(total)}*`)
    : ['مجموع الدولار: *0 دولار*'];
  const pounds = rows.reduce((sum, row) => sum + (row.egpAmount ?? 0n), 0n);
  const blank = rows.filter((row) => !row.egpAmount).length;
  return [
    '📋 *مطابقة تيكتوك*',
    `${day} — حتى الساعة ${asOf}`,
    '',
    ...dollars,
    `مجموع الجنيه: *${formatAmount({ currency: 'EGP', amount: pounds })}*`,
    blank > 0 ? `(${blank} ${blank === 1 ? 'سحب' : 'سحوبات'} بلا مبلغ بالجنيه)` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}
