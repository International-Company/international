import 'server-only';
import { prisma } from '@/core/db/prisma';
import { createLogger } from '@/core/logger/logger';
import { dayBounds, formatDayKey } from '@/core/time/day-key';
import * as settings from '@/modules/settings/settings.service';
import { categoriesOf, parseRoutes, type RouteCategory } from './group-routes';
import {
  composeGroupReconciliation,
  isReconcileCode,
  type BankDue,
  type RemittanceSent,
  type UsdtDeposit,
  type TiktokWithdrawn,
} from './reconcile-message';
import { onIncomingText, sendText, type IncomingText } from './whatsapp.service';

/**
 * «#مطابقة» in a group, answered with that group's own reconciliation for the day.
 *
 * Which part a group gets follows from what it is sent: it already saw every
 * deal it is told about, so anyone in it may ask, and the answer tells it
 * nothing new. A group sent none of these kinds is not answered at all.
 */

const log = createLogger('whatsapp:reconcile');

/** The kinds of deal that put a bank payout in a group's answer. */
const BANK_TYPES: Record<string, BankDue['kind']> = {
  EXCHANGE: 'EXCHANGE',
  WALLET_CASHOUT: 'EXCHANGE',
  WALLET_TOPUP: 'EXCHANGE',
  USDT_RECEIVE: 'USDT',
  USDT_SEND: 'USDT',
};

export interface ReconcileDeps {
  /** The kinds of deal the group is sent; none when WhatsApp is off. */
  categories: (group: string) => Promise<RouteCategory[]>;
  /** The day's figures, for the kinds asked for only. */
  bank: (now: Date, kinds: BankDue['kind'][]) => Promise<BankDue[]>;
  remittances: (now: Date) => Promise<RemittanceSent[]>;
  deposits: (now: Date) => Promise<UsdtDeposit[]>;
  tiktok: (now: Date) => Promise<TiktokWithdrawn[]>;
  reply: (incoming: IncomingText, text: string) => Promise<void>;
  now?: () => Date;
}

export type ReconcileOutcome = 'IGNORED' | 'SENT' | 'FAILED';

const clock = (at: Date) =>
  `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;

export async function handleReconcile(
  incoming: IncomingText,
  deps: ReconcileDeps,
): Promise<ReconcileOutcome> {
  // The code alone: anything after it is not this command.
  if (!isReconcileCode(incoming.text)) return 'IGNORED';
  const categories = await deps.categories(incoming.chat);
  const bankKinds = (['EXCHANGE', 'USDT'] as const).filter((kind) => categories.includes(kind));
  // A group sent only each remittance's number and sum checks them the same way.
  const hearsRemittances =
    categories.includes('REMITTANCE') || categories.includes('REMITTANCE_COPY');
  const hearsDeposits = categories.includes('USDT_SALE_COPY');
  const hearsTiktok = categories.includes('TIKTOK');
  if (bankKinds.length === 0 && !hearsRemittances && !hearsDeposits && !hearsTiktok) {
    // Said so in the log: a group left out of the routes is the usual reason for no answer.
    log.info('Reconciliation asked in a group sent none of its kinds', {
      group: incoming.chat,
      kinds: categories,
    });
    return 'IGNORED';
  }

  const now = deps.now?.() ?? new Date();
  try {
    const text = composeGroupReconciliation({
      day: formatDayKey(now),
      asOf: clock(now),
      bank: bankKinds.length > 0 ? await deps.bank(now, bankKinds) : undefined,
      deposits: hearsDeposits ? await deps.deposits(now) : undefined,
      remittances: hearsRemittances ? await deps.remittances(now) : undefined,
      tiktok: hearsTiktok ? await deps.tiktok(now) : undefined,
    });
    if (!text) return 'IGNORED';
    await deps.reply(incoming, text);
    return 'SENT';
  } catch (error) {
    log.warn('Could not answer a reconciliation', { error });
    return 'FAILED';
  }
}

let registered = false;

/** Listens for the code in every group. Once per process. */
export function registerReconcile(): void {
  if (registered) return;
  registered = true;

  onIncomingText(async (incoming) => {
    await handleReconcile(incoming, liveDeps());
  });
}

/** The figures read from the books, and the answer sent to the group asked from. */
export function liveDeps(): ReconcileDeps {
  return {
    categories: async (group) => {
      if (!(await settings.getBoolean('whatsapp.enabled'))) return [];
      return categoriesOf(
        group,
        parseRoutes(await settings.getString('whatsapp.groupRoutes')),
        (await settings.getString('whatsapp.groupId')).trim(),
      );
    },
    bank: async (now, kinds) => {
      const { start, end } = dayBounds(now);
      const types = Object.keys(BANK_TYPES).filter((type) => kinds.includes(BANK_TYPES[type]!));
      const deals = await prisma.transaction.findMany({
        where: {
          createdAt: { gte: start, lte: end },
          status: { not: 'REVERSED' },
          type: { in: types },
          payoutBankAmount: { gt: 0n },
        },
        orderBy: { createdAt: 'asc' },
        select: { type: true, toCurrency: true, payoutBankAmount: true, payoutBankChannel: true },
      });
      return deals.map((deal) => ({
        kind: BANK_TYPES[deal.type]!,
        currency: deal.toCurrency,
        amount: deal.payoutBankAmount,
        channel: deal.payoutBankChannel,
      }));
    },
    deposits: async (now) => {
      const { start, end } = dayBounds(now);
      const deals = await prisma.transaction.findMany({
        where: {
          createdAt: { gte: start, lte: end },
          status: { not: 'REVERSED' },
          type: 'USDT_SALE',
          unannounced: false,
        },
        orderBy: { createdAt: 'asc' },
        select: { toAmount: true, payoutAddress: true },
      });
      return deals.map((deal) => ({ amount: deal.toAmount, address: deal.payoutAddress }));
    },
    remittances: async (now) => {
      const { start, end } = dayBounds(now);
      // Those the group was told of: one recorded only for the count never reached it.
      const deals = await prisma.transaction.findMany({
        where: {
          createdAt: { gte: start, lte: end },
          status: { not: 'REVERSED' },
          type: 'REMITTANCE_OUT',
          unannounced: false,
        },
        orderBy: { createdAt: 'asc' },
        select: {
          fromAmount: true,
          fromCurrency: true,
          deliveredAmount: true,
          deliveredUnit: true,
          counterpartyPhone: true,
          customer: { select: { phone: true } },
        },
      });
      return deals.map((deal) => ({
        phone: deal.customer?.phone ?? deal.counterpartyPhone,
        ...(deal.deliveredAmount
          ? { amount: deal.deliveredAmount, unit: deal.deliveredUnit?.trim() || deal.fromCurrency }
          : { amount: deal.fromAmount, unit: deal.fromCurrency }),
      }));
    },
    tiktok: async (now) => {
      const { start, end } = dayBounds(now);
      return prisma.tiktokWithdrawal.findMany({
        where: { deletedAt: null, createdAt: { gte: start, lte: end } },
        select: { egpAmount: true },
      });
    },
    reply: async (message, text) => {
      await sendText(message.chat, text, message.message);
    },
  };
}
