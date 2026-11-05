import { toDecimalString, wholeAmount } from '@/core/money/money';
import { formatAmount } from '@/modules/whatsapp/report-command';

/** A TikTok withdrawal's sums, and the words it goes to its group with as the photo's caption. */

export const TIKTOK_DEAL_TYPE = 'TIKTOK_WITHDRAWAL';

/** What the USDT comes to in shekels at this price, whole as the office hands it over. */
export function tiktokPayout(amount: bigint, rate: bigint): bigint {
  return wholeAmount((amount * rate) / 100_000_000n) * 100_000_000n;
}

/** A price as it is typed: 2.55, not 2.5500. */
export function rateText(rate: bigint): string {
  return toDecimalString(rate, 4).replace(/\.?0+$/, '');
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
