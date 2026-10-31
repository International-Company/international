import 'server-only';
import { prisma } from '@/core/db/prisma';
import { on } from '@/core/events/bus';
import { toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import { HOME_CURRENCY } from '@/lib/home-currency';
import { TRANSACTION_TYPE_META, type TransactionType } from '@/modules/exchange/transaction-types';
import * as settings from '@/modules/settings/settings.service';
import { shareable, type Shareable } from '@/modules/exchange/share.service';
import { isLinked, sendText, type SentMessage } from './whatsapp.service';

/**
 * Every deal, to the office's WhatsApp group, the moment it is recorded — and
 * every deletion, so the group never holds a deal that no longer stands
 * without being told.
 *
 * A deal is written exactly as the office shares one by hand: the number, the
 * name, the bank or wallet, the amount, a line each with a blank between — the
 * same words the share button produces, so the two can never drift apart.
 * Then the bot answers its own message with what kind of deal it was —
 * «صرافة», «استلام يواس» — as a reply, so the kind sits on the deal it names
 * however busy the group gets.
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

/** The word the office uses for each kind of deal, said in the reply. */
const KIND_LABEL: Record<string, string> = {
  EXCHANGE: 'صرافة',
  WALLET_CASHOUT: 'صرافة',
  WALLET_TOPUP: 'صرافة',
  USDT_RECEIVE: 'استلام يواس',
  USDT_SEND: 'سحب يواس',
  USDT_SALE: 'بيع يواس',
  REMITTANCE_OUT: 'حوالة صادرة',
  REMITTANCE_IN: 'حوالة واردة',
};

export function kindLabel(type: string): string {
  return KIND_LABEL[type] ?? TRANSACTION_TYPE_META[type as TransactionType]?.nameAr ?? type;
}

/**
 * Whether the group hears of a deal at all.
 *
 * An exchange handed over entirely in cash is finished at the counter: the
 * customer walked away with the notes and there is nothing for anyone in the
 * group to send. So only an exchange with a transfer in it is written — in
 * whole or in part. Every other kind is written as before.
 */
export function announced(deal: { type: string; bankPayout: boolean }): boolean {
  return deal.type !== 'EXCHANGE' || deal.bankPayout;
}

/**
 * The deal's message, once the deal can be read.
 *
 * The event fires when the deal is written, but a screen like the exchange
 * machine writes it inside a larger database transaction of its own — and
 * until that commits, nothing outside it can see the row. Reading at once
 * found nothing, and the machine's deals were never announced. So it asks
 * again for a few seconds; a deal whose transaction rolled back never
 * appears, and is rightly never sent.
 */
async function settled(
  transactionId: string,
  load: (id: string) => Promise<Shareable>,
  pause: number,
): Promise<Shareable | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await load(transactionId);
    } catch (error) {
      if ((error as { code?: string }).code !== 'NOT_FOUND') return null;
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
  return null;
}

export interface AnnounceDeps {
  /** The group to write to, or null when nothing should be sent. */
  target: () => Promise<string | null>;
  load: (id: string) => Promise<Shareable>;
  send: (jid: string, text: string, quoted?: SentMessage) => Promise<SentMessage>;
  /** Between attempts to read a deal not yet committed. */
  pause?: number;
}

export type AnnounceOutcome = 'SKIPPED' | 'NOT_FOUND' | 'SEND_FAILED' | 'NO_REPLY' | 'SENT';

/**
 * One deal to the group: its message, then the kind as a reply to it.
 *
 * The reply goes only once the message itself is confirmed sent — a kind
 * hanging under nothing, or under the previous deal, would be worse than no
 * kind at all. Nothing here throws: a failure is logged and said in the
 * outcome, and the deal it was about is untouched.
 */
export async function announceDeal(
  transactionId: string,
  deps: AnnounceDeps,
): Promise<AnnounceOutcome> {
  const group = await deps.target();
  if (!group) return 'SKIPPED';

  const message = await settled(transactionId, deps.load, deps.pause ?? 500);
  if (!message?.text) return 'NOT_FOUND';
  if (!announced(message)) return 'SKIPPED';

  let sent: SentMessage;
  try {
    sent = await deps.send(group, message.text);
  } catch (error) {
    log.warn('Could not announce a deal', { reference: message.reference, error });
    return 'SEND_FAILED';
  }
  if (!sent?.key?.id) {
    log.warn('A deal went out without an id to reply to', { reference: message.reference });
    return 'NO_REPLY';
  }

  try {
    await deps.send(group, kindLabel(message.type), sent);
  } catch (error) {
    log.warn('Could not label a deal', { reference: message.reference, error });
    return 'NO_REPLY';
  }
  return 'SENT';
}

let registered = false;

export function registerWhatsappSubscribers(): void {
  if (registered) return;
  registered = true;

  on('transaction.posted', 'whatsapp-announce-deal', async ({ transactionId }) => {
    await announceDeal(transactionId, {
      target,
      load: (id) => shareable(id, 'ar'),
      send: sendText,
    });
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
      // A deal the group never heard of is not deleted in front of it either.
      if (!deal || !announced({ type: deal.type, bankPayout: deal.payoutBankAmount > 0n })) {
        return;
      }
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
