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
  /** Handed over in notes: all of it, part of it, or none. */
  cashAmount?: bigint;
}

/**
 * A line each with a blank between, in the order the office writes a transfer.
 * Paid in notes it says so where the account would be; split, the sum says how.
 */
export function composeWithdrawal({
  account,
  channel,
  beneficiaryName,
  payoutAmount,
  cashAmount = 0n,
}: Withdrawal): string {
  const cash = cashAmount > 0n ? cashAmount : 0n;
  if (cash >= payoutAmount) {
    return [account.trim(), 'نقدي', beneficiaryName.trim(), shekels(payoutAmount)]
      .filter(Boolean)
      .join('\n\n');
  }
  const sum =
    cash > 0n
      ? `${shekels(payoutAmount)} (تحويل ${shekels(payoutAmount - cash)} + نقدي ${shekels(cash)})`
      : shekels(payoutAmount);
  return [account, channel, beneficiaryName.trim(), sum].join('\n\n');
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

/** Someone TikTok withdrawals are sent to, by name, and the group that is theirs. */
export interface TiktokRecipient {
  name: string;
  group: { id: string; name: string };
}

export const MAX_TIKTOK_RECIPIENTS = 10;

/** The recipients as stored; anything unreadable, or without a name or a group, is left out. */
export function parseTiktokRecipients(raw: string): TiktokRecipient[] {
  let stored: unknown;
  try {
    stored = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  const out: TiktokRecipient[] = [];
  for (const entry of stored) {
    const value = (entry ?? {}) as { name?: unknown; group?: { id?: unknown; name?: unknown } };
    const name = typeof value.name === 'string' ? value.name.trim().slice(0, 60) : '';
    const id = typeof value.group?.id === 'string' ? value.group.id.trim() : '';
    if (!name || !id.endsWith('@g.us') || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, group: { id, name: typeof value.group?.name === 'string' ? value.group.name : '' } });
  }
  return out.slice(0, MAX_TIKTOK_RECIPIENTS);
}
