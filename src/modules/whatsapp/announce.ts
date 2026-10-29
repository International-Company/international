import 'server-only';
import { prisma } from '@/core/db/prisma';
import { on } from '@/core/events/bus';
import { toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import { HOME_CURRENCY } from '@/lib/home-currency';
import { TRANSACTION_TYPE_META, type TransactionType } from '@/modules/exchange/transaction-types';
import * as settings from '@/modules/settings/settings.service';
import { isLinked, sendText } from './whatsapp.service';

/**
 * Every deal, to the office's WhatsApp group, the moment it is recorded — and
 * every deletion, so the group never holds a deal that no longer stands
 * without being told.
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

/** The price per unit of what was traded: USDT if it is in the deal, else the foreign side. */
export function priceOf(
  deal: Pick<AnnouncedDeal, 'fromCurrency' | 'fromAmount' | 'toCurrency' | 'toAmount'>,
): string | null {
  if (deal.fromCurrency === deal.toCurrency || deal.fromAmount <= 0n || deal.toAmount <= 0n) {
    return null;
  }
  const goodsIsFrom =
    deal.fromCurrency === 'USDT' ||
    (deal.toCurrency !== 'USDT' && deal.fromCurrency !== HOME_CURRENCY);
  const goods = goodsIsFrom ? deal.fromAmount : deal.toAmount;
  const other = goodsIsFrom ? deal.toAmount : deal.fromAmount;
  return (Number(other) / Number(goods)).toFixed(4).replace(/\.?0+$/, '');
}

export function composeDeal(deal: AnnouncedDeal): string {
  const who = deal.customer?.fullNameAr || deal.counterpartyName;
  const phone = deal.customer?.phone || deal.counterpartyPhone;
  const price = priceOf(deal);
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Gaza',
  }).format(deal.createdAt);

  const lines = [
    `🟢 *${titleOf(deal)}*`,
    `المرجع: ${deal.reference}`,
    who ? `العميل: ${who}` : null,
    phone ? `الهاتف: ${phone}` : null,
    `دفع العميل: ${figure(deal.fromAmount)} ${deal.fromCurrency}`,
    `استلم العميل: ${figure(deal.toAmount)} ${deal.toCurrency}`,
    price ? `السعر: ${price}` : null,
    deal.intakeBrokerAmount > 0n
      ? `دُفع بتحويل: ${figure(deal.intakeBrokerAmount)} ${deal.fromCurrency}${deal.intakeBankChannel ? ` — ${deal.intakeBankChannel}` : ''}`
      : null,
    deal.payoutBankAmount > 0n
      ? `يُحوَّل له: ${figure(deal.payoutBankAmount)} ${deal.toCurrency}${deal.payoutBankChannel ? ` — ${deal.payoutBankChannel}` : ''}${deal.payoutAccount ? ` — ${deal.payoutAccount}` : ''}`
      : null,
    deal.status === 'PENDING_TRANSFER' ? '⏳ بانتظار التحويل' : null,
    deal.notes?.trim() ? `ملاحظة: ${deal.notes.trim()}` : null,
    `التلر: ${deal.createdBy?.fullNameAr ?? '—'} · ${time}`,
  ];
  return lines.filter((line): line is string => Boolean(line)).join('\n');
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
    const deal = await prisma.transaction.findUnique({
      where: { id: transactionId },
      select: DEAL_SELECT,
    });
    if (!deal) return;
    await sendText(group, composeDeal(deal)).catch((error) =>
      log.warn('Could not announce a deal', { reference: deal.reference, error }),
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
