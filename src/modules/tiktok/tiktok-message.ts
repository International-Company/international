import { formatAmount } from '@/modules/whatsapp/report-command';

/** The words a TikTok withdrawal goes to its group with: the photo carries them as a caption. */

export const TIKTOK_DEAL_TYPE = 'TIKTOK_WITHDRAWAL';

interface Withdrawal {
  amount: bigint;
  currency: string;
  beneficiaryName: string;
  channel: string;
  teller: string | null;
}

export function composeWithdrawal({
  amount,
  currency,
  beneficiaryName,
  channel,
  teller,
}: Withdrawal): string {
  return [
    '*سحب تيكتوك*',
    '',
    `المستفيد: ${beneficiaryName.trim()}`,
    channel ? `طريقة التحويل: ${channel}` : null,
    `المبلغ: *${formatAmount({ currency, amount })}*`,
    teller ? `التلر: ${teller}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

export function composeWithdrawalDeleted(
  { amount, currency, beneficiaryName, channel }: Withdrawal,
  by: string | null,
): string {
  return [
    '🔴 *حذف سحب تيكتوك*',
    '',
    `المستفيد: ${beneficiaryName.trim()}`,
    channel ? `طريقة التحويل: ${channel}` : null,
    `كان: ${formatAmount({ currency, amount })}`,
    by ? `حذفها: ${by}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}
