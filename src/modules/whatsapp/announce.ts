import 'server-only';
import { prisma } from '@/core/db/prisma';
import { on } from '@/core/events/bus';
import { toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import { HOME_CURRENCY } from '@/lib/home-currency';
import { TRANSACTION_TYPE_META, type TransactionType } from '@/modules/exchange/transaction-types';
import * as settings from '@/modules/settings/settings.service';
import { shareable } from '@/modules/exchange/share.service';
import { isLinked, sendText } from './whatsapp.service';

/**
 * Every deal, to the office's WhatsApp group, the moment it is recorded — and
 * every deletion, so the group never holds a deal that no longer stands
 * without being told.
 *
 * A deal is written exactly as the office shares one by hand: the number, the
 * name, the bank or wallet, the amount, a line each with a blank between — the
 * same words the share button produces, so the two can never drift apart.
 *
 * After the posting and apart from it: a group that could not be reached is
 * logged, never a deal that failed. And only when the manager has switched it
 * on, chosen a group, and the number is linked.
 */

const log = createLogger('whatsapp:announce');

export interface AnnouncedDeal {
  reference: string;
  type: string;
  status: string;
  fromCurrency: string;
  fromAmount: bigint;
  toCurrency: string;
  toAmount: bigint;
  payoutBankAmount: bigint;
  payoutBankChannel: string | null;
  payoutAccount: string | null;
  intakeBrokerAmount: bigint;
  intakeBankChannel: string | null;
  counterpartyName: string | null;
  counterpartyPhone: string | null;
  notes: string | null;
  createdAt: Date;
  customer: { fullNameAr: string; phone: string | null } | null;
  createdBy: { fullNameAr: string } | null;
}

/** "320" rather than "320.00", the way the office writes it. */
const figure = (amount: bigint) => toDecimalString(amount, 2).replace(/\.00$/, '');

/** What the deal is called in the group: buying and selling said plainly. */
export function titleOf(deal: Pick<AnnouncedDeal, 'type' | 'fromCurrency' | 'toCurrency'>): string {
  if (deal.type === 'EXCHANGE') {
    return deal.fromCurrency === HOME_CURRENCY
      ? `بيع ${deal.toCurrency}`
      : deal.toCurrency === HOME_CURRENCY
        ? `شراء ${deal.fromCurrency}`
        : `تصريف ${deal.fromCurrency} ← ${deal.toCurrency}`;
  }
  return TRANSACTION_TYPE_META[deal.type as TransactionType]?.nameAr ?? deal.type;
}

export function composeDeletion(
  deal: Pick<
    AnnouncedDeal,
    'reference' | 'type' | 'fromCurrency' | 'fromAmount' | 'toCurrency' | 'toAmount'
  >,
  by: string | null,
  reason: string | null,
): string {
  return [
    `🔴 *حذف عملية — ${titleOf(deal)}*`,
    `المرجع: ${deal.reference}`,
    `كانت: ${figure(deal.fromAmount)} ${deal.fromCurrency} ← ${figure(deal.toAmount)} ${deal.toCurrency}`,
    reason?.trim() ? `السبب: ${reason.trim()}` : null,
    by ? `حذفها: ${by}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

const DEAL_SELECT = {
  reference: true,
  type: true,
  status: true,
  fromCurrency: true,
  fromAmount: true,
  toCurrency: true,
  toAmount: true,
  payoutBankAmount: true,
  payoutBankChannel: true,
  payoutAccount: true,
  intakeBrokerAmount: true,
  intakeBankChannel: true,
  counterpartyName: true,
  counterpartyPhone: true,
  notes: true,
  createdAt: true,
  customer: { select: { fullNameAr: true, phone: true } },
  createdBy: { select: { fullNameAr: true } },
} as const;

/** The group to write to, or null when the office has not asked for it. */
async function target(): Promise<string | null> {
  if (!(await settings.getBoolean('whatsapp.enabled'))) return null;
  const group = (await settings.getString('whatsapp.groupId')).trim();
  if (!group || !isLinked()) return null;
  return group;
}

let registered = false;

export function registerWhatsappSubscribers(): void {
  if (registered) return;
  registered = true;

  on('transaction.posted', 'whatsapp-announce-deal', async ({ transactionId }) => {
    const group = await target();
    if (!group) return;
    const message = await shareable(transactionId, 'ar').catch(() => null);
    if (!message?.text) return;
    await sendText(group, message.text).catch((error) =>
      log.warn('Could not announce a deal', { reference: message.reference, error }),
    );
  });

  on(
    'transaction.reversed',
    'whatsapp-announce-deletion',
    async ({ transactionId, reversalId }) => {
      const group = await target();
      if (!group) return;
      const [deal, reversal] = await Promise.all([
        prisma.transaction.findUnique({ where: { id: transactionId }, select: DEAL_SELECT }),
        prisma.transaction.findUnique({
          where: { id: reversalId },
          select: { reverseReason: true, createdBy: { select: { fullNameAr: true } } },
        }),
      ]);
      if (!deal) return;
      await sendText(
        group,
        composeDeletion(
          deal,
          reversal?.createdBy?.fullNameAr ?? null,
          reversal?.reverseReason ?? null,
        ),
      ).catch((error) =>
        log.warn('Could not announce a deletion', { reference: deal.reference, error }),
      );
    },
  );
}
