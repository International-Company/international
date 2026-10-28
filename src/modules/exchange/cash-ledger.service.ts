import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { HOME_CURRENCY } from '@/lib/home-currency';
import type { Actor } from './transaction.service';

/**
 * جرد عملياتي — a teller's own cash, deal by deal, for one window.
 *
 * ## Opening at zero
 *
 * The box opens at nothing, so its closing figure is exactly what the
 * teller's own deals put into the drawer and took out of it. Whatever he
 * started the day with is his to add; what this shows is his work alone, and
 * a difference against the count is a deal he must find.
 *
 * ## Read from the cash, not from the deal
 *
 * Every line is the notes that actually moved: a deal paid out by transfer
 * moves no cash on that side, and a split moves only its cash part. That is
 * the movement record the drawer itself is the sum of, so this cannot disagree
 * with it. A reversal puts its own lines in, and the deal it undid is marked;
 * both stay visible, because a teller hunting a difference needs to see both.
 *
 * ## Buying and selling
 *
 * Said from the office's side, as the counter says it: the office buys the
 * foreign currency the customer hands over and sells the one it hands back.
 */

export interface CashAmount {
  currency: string;
  amount: bigint;
}

export type Side = 'BUY' | 'SELL' | 'CROSS' | 'OTHER';

export interface LedgerEntry {
  id: string;
  reference: string;
  type: string;
  at: Date;
  side: Side;
  /** The foreign currency bought or sold, and how much of it. */
  foreign: CashAmount | null;
  /** The other side of the deal, for reading the line. */
  fromCurrency: string;
  fromAmount: bigint;
  toCurrency: string;
  toAmount: bigint;
  rate: bigint;
  /** Notes in and out of the drawer by this deal. */
  cashIn: CashAmount[];
  cashOut: CashAmount[];
  /** The box after this line, per currency it has touched so far. */
  running: CashAmount[];
  /** This line undoes another, or was undone by one. */
  reversal: boolean;
  reversed: boolean;
}

export interface CashLedger {
  from: Date;
  to: Date;
  /** Always zero, per currency the window touched — said so on the page. */
  opening: CashAmount[];
  /** Per foreign currency: how much the office bought and sold, deals that stand. */
  traded: { currency: string; bought: bigint; sold: bigint; buys: number; sells: number }[];
  entries: LedgerEntry[];
  closing: CashAmount[];
}

function sideOf(type: string, fromCurrency: string, toCurrency: string): Side {
  if (type !== 'EXCHANGE') return 'OTHER';
  if (fromCurrency !== HOME_CURRENCY && toCurrency !== HOME_CURRENCY) return 'CROSS';
  return fromCurrency !== HOME_CURRENCY ? 'BUY' : 'SELL';
}

export async function cashLedger(
  input: { from: Date; to: Date },
  actor: Actor,
  db: DbClient = prisma,
): Promise<CashLedger> {
  if (!actor.permissions.includes('exchange.transaction.view')) {
    throw errors.forbidden('exchange.transaction.view');
  }
  if (input.from > input.to) {
    throw errors.validation([{ path: 'from', message: 'The period starts after it ends' }]);
  }

  const movements = await db.drawerMovement.findMany({
    where: {
      createdAt: { gte: input.from, lte: input.to },
      reason: { in: ['TRANSACTION', 'REVERSAL'] },
      drawer: { kind: 'CASH' },
      transaction: {
        OR: [
          { createdById: actor.id, reversalOfId: null },
          { reversalOf: { createdById: actor.id } },
        ],
      },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      direction: true,
      amount: true,
      createdAt: true,
      drawer: { select: { currencyCode: true } },
      transaction: {
        select: {
          id: true,
          reference: true,
          type: true,
          status: true,
          fromCurrency: true,
          fromAmount: true,
          toCurrency: true,
          toAmount: true,
          rate: true,
          createdAt: true,
          reversalOfId: true,
        },
      },
    },
  });

  // One line per deal, in the order its cash moved.
  const byDeal = new Map<
    string,
    LedgerEntry & { inMap: Map<string, bigint>; outMap: Map<string, bigint> }
  >();
  for (const movement of movements) {
    const deal = movement.transaction;
    if (!deal) continue;
    let entry = byDeal.get(deal.id);
    if (!entry) {
      const side = sideOf(deal.type, deal.fromCurrency, deal.toCurrency);
      entry = {
        id: deal.id,
        reference: deal.reference,
        type: deal.type,
        at: deal.createdAt,
        side,
        foreign:
          side === 'BUY' || side === 'CROSS'
            ? { currency: deal.fromCurrency, amount: deal.fromAmount }
            : side === 'SELL'
              ? { currency: deal.toCurrency, amount: deal.toAmount }
              : null,
        fromCurrency: deal.fromCurrency,
        fromAmount: deal.fromAmount,
        toCurrency: deal.toCurrency,
        toAmount: deal.toAmount,
        rate: deal.rate,
        cashIn: [],
        cashOut: [],
        running: [],
        reversal: deal.reversalOfId !== null,
        reversed: deal.status === 'REVERSED',
        inMap: new Map(),
        outMap: new Map(),
      };
      byDeal.set(deal.id, entry);
    }
    const into = movement.direction === 'IN' ? entry.inMap : entry.outMap;
    const currency = movement.drawer.currencyCode;
    into.set(currency, (into.get(currency) ?? 0n) + movement.amount);
  }

  const list = (map: Map<string, bigint>): CashAmount[] =>
    [...map.entries()]
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((a, b) => a.currency.localeCompare(b.currency));

  // The box, carried line by line from zero.
  const box = new Map<string, bigint>();
  const traded = new Map<string, { bought: bigint; sold: bigint; buys: number; sells: number }>();
  const entries: LedgerEntry[] = [];

  for (const { inMap, outMap, ...entry } of byDeal.values()) {
    for (const [currency, amount] of inMap) box.set(currency, (box.get(currency) ?? 0n) + amount);
    for (const [currency, amount] of outMap) box.set(currency, (box.get(currency) ?? 0n) - amount);

    // Buying and selling count only deals that stand.
    if (!entry.reversal && !entry.reversed && entry.foreign) {
      const totals = traded.get(entry.foreign.currency) ?? {
        bought: 0n,
        sold: 0n,
        buys: 0,
        sells: 0,
      };
      if (entry.side === 'SELL') {
        totals.sold += entry.foreign.amount;
        totals.sells += 1;
      } else {
        totals.bought += entry.foreign.amount;
        totals.buys += 1;
      }
      traded.set(entry.foreign.currency, totals);
    }

    entries.push({
      ...entry,
      cashIn: list(inMap),
      cashOut: list(outMap),
      running: list(new Map(box)),
    });
  }

  const closing = list(box);
  return {
    from: input.from,
    to: input.to,
    opening: closing.map((entry) => ({ currency: entry.currency, amount: 0n })),
    traded: [...traded.entries()]
      .map(([currency, totals]) => ({ currency, ...totals }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    entries,
    closing,
  };
}
