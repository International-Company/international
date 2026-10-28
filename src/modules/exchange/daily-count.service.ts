import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { HOME_CURRENCY } from '@/lib/home-currency';
import type { Actor } from './transaction.service';

/**
 * الجرد اليومي — a teller's day, sorted the way he counts it: USDT taken in,
 * USDT sent out, foreign currency bought, foreign currency sold. Each kind on
 * its own, with what came in and what went out under it, and every deal of
 * that kind listed beneath.
 *
 * Read from the deals rather than the drawer: a USDT receipt paid by bank
 * moves no cash, yet it is still a receipt he made and must account for.
 * The drawer's own reading is «جرد عملياتي»; this is the work behind it.
 *
 * A deal undone later stays in its list, marked, and out of the totals — the
 * teller hunting a difference needs to see it was there. The reversal itself
 * is not listed: it is the same deal read backwards.
 */

export type CountKind = 'USDT_RECEIVE' | 'USDT_SEND' | 'BUY' | 'SELL';

export const COUNT_KINDS: CountKind[] = ['USDT_RECEIVE', 'USDT_SEND', 'BUY', 'SELL'];

export interface CountAmount {
  currency: string;
  amount: bigint;
}

export interface CountEntry {
  id: string;
  reference: string;
  at: Date;
  status: string;
  customer: string | null;
  fromCurrency: string;
  fromAmount: bigint;
  toCurrency: string;
  toAmount: bigint;
  /** What the customer was paid by transfer rather than in notes. */
  payoutBank: bigint;
  payoutChannel: string | null;
  reversed: boolean;
}

export interface CountGroup {
  kind: CountKind;
  /** Deals that stand. */
  count: number;
  /** What the office took from the customer, per currency, deals that stand. */
  received: CountAmount[];
  /** What the office gave the customer, per currency, deals that stand. */
  paid: CountAmount[];
  entries: CountEntry[];
}

export interface DailyCount {
  from: Date;
  to: Date;
  groups: CountGroup[];
}

/** Which list a deal belongs in, or none: remittances are counted elsewhere. */
export function kindOf(type: string, fromCurrency: string): CountKind | null {
  if (type === 'USDT_RECEIVE' || type === 'USDT_SEND') return type;
  if (type !== 'EXCHANGE') return null;
  // As the counter says it: the office buys whatever foreign currency is
  // handed over, and sells when the customer hands over shekels.
  return fromCurrency === HOME_CURRENCY ? 'SELL' : 'BUY';
}

export async function dailyCount(
  input: { from: Date; to: Date },
  actor: Actor,
  db: DbClient = prisma,
): Promise<DailyCount> {
  if (!actor.permissions.includes('exchange.transaction.view')) {
    throw errors.forbidden('exchange.transaction.view');
  }
  if (input.from > input.to) {
    throw errors.validation([{ path: 'from', message: 'The period starts after it ends' }]);
  }

  const deals = await db.transaction.findMany({
    where: {
      createdById: actor.id,
      reversalOfId: null,
      type: { in: ['EXCHANGE', 'USDT_RECEIVE', 'USDT_SEND'] },
      createdAt: { gte: input.from, lte: input.to },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      reference: true,
      type: true,
      status: true,
      createdAt: true,
      fromCurrency: true,
      fromAmount: true,
      toCurrency: true,
      toAmount: true,
      payoutBankAmount: true,
      payoutBankChannel: true,
      counterpartyName: true,
      customer: { select: { fullNameAr: true, fullNameEn: true } },
    },
  });

  const groups = new Map<
    CountKind,
    CountGroup & { inMap: Map<string, bigint>; outMap: Map<string, bigint> }
  >(
    COUNT_KINDS.map((kind) => [
      kind,
      { kind, count: 0, received: [], paid: [], entries: [], inMap: new Map(), outMap: new Map() },
    ]),
  );

  for (const deal of deals) {
    const kind = kindOf(deal.type, deal.fromCurrency);
    if (!kind) continue;
    const group = groups.get(kind)!;
    const reversed = deal.status === 'REVERSED';
    group.entries.push({
      id: deal.id,
      reference: deal.reference,
      at: deal.createdAt,
      status: deal.status,
      customer:
        deal.customer?.fullNameAr || deal.customer?.fullNameEn || deal.counterpartyName || null,
      fromCurrency: deal.fromCurrency,
      fromAmount: deal.fromAmount,
      toCurrency: deal.toCurrency,
      toAmount: deal.toAmount,
      payoutBank: deal.payoutBankAmount,
      payoutChannel: deal.payoutBankChannel,
      reversed,
    });
    if (reversed) continue;
    group.count += 1;
    group.inMap.set(
      deal.fromCurrency,
      (group.inMap.get(deal.fromCurrency) ?? 0n) + deal.fromAmount,
    );
    group.outMap.set(deal.toCurrency, (group.outMap.get(deal.toCurrency) ?? 0n) + deal.toAmount);
  }

  const list = (map: Map<string, bigint>): CountAmount[] =>
    [...map.entries()]
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    from: input.from,
    to: input.to,
    groups: [...groups.values()].map(({ inMap, outMap, ...group }) => ({
      ...group,
      received: list(inMap),
      paid: list(outMap),
    })),
  };
}
