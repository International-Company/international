import { formatAmount } from '@/modules/whatsapp/report-command';

/** The words a TikTok withdrawal goes to its group with: the photo carries them as a caption. */

export const TIKTOK_DEAL_TYPE = 'TIKTOK_WITHDRAWAL';

interface Withdrawal {
  amount: bigint;
  currency: string;
  details: string;
  teller: string | null;
}

export function composeWithdrawal({ amount, currency, details, teller }: Withdrawal): string {
  return [
    '*سحب تيكتوك*',
    '',
    details.trim(),
    '',
    `المبلغ: *${formatAmount({ currency, amount })}*`,
    teller ? `التلر: ${teller}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

export function composeWithdrawalDeleted(
  { amount, currency, details }: Withdrawal,
  by: string | null,
): string {
  return [
    '🔴 *حذف سحب تيكتوك*',
    '',
    details.trim(),
    '',
    `كان: ${formatAmount({ currency, amount })}`,
    by ? `حذفها: ${by}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}
