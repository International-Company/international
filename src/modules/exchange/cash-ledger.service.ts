import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import { HOME_CURRENCY } from '@/lib/home-currency';
import * as audit from '@/modules/audit/audit.service';
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
  /**
   * What the teller said he opened the day with, per currency — zero where he
   * has said nothing. `openingSet` tells the page which of the two it is.
   */
  opening: CashAmount[];
  openingSet: boolean;
  /** The cash currencies he can open a box in, for the form. */
  currencies: { code: string; decimals: number }[];
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

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The opening box a teller entered for a day, per currency. */
export async function openingFor(
  tellerId: string,
  day: string,
  db: DbClient = prisma,
): Promise<Map<string, bigint> | null> {
  if (!DAY.test(day)) return null;
  const rows = await db.tellerOpening.findMany({
    where: { tellerId, day },
    select: { currencyCode: true, amount: true },
  });
  return rows.length === 0 ? null : new Map(rows.map((row) => [row.currencyCode, row.amount]));
}

/**
 * The teller opens his own box for a day — and may correct it, each time on
 * the audit log with what it was before, so a box quietly raised at night to
 * cover a shortage reads as exactly that.
 *
 * Not for a day ahead: the box is what is in the drawer, and tomorrow's
 * drawer is not here yet. A day is the counter's own (YYYY-MM-DD), so
 * "today" is allowed a day's slack either side of the server's clock.
 */
export async function setOpening(
  input: { day: string; lines: CashAmount[] },
  actor: Actor,
  db: DbClient = prisma,
) {
  if (!actor.permissions.includes('exchange.transaction.view')) {
    throw errors.forbidden('exchange.transaction.view');
  }
  if (!DAY.test(input.day)) {
    throw errors.validation([{ path: 'day', message: 'Not a day' }]);
  }
  const tomorrow = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (input.day > tomorrow) {
    throw errors.precondition('A box cannot be opened for a day ahead', 'errors.openingAhead');
  }
  for (const line of input.lines) {
    if (line.amount < 0n) {
      throw errors.validation([{ path: `lines.${line.currency}`, message: 'Below zero' }]);
    }
  }

  const before = await openingFor(actor.id, input.day, db);

  for (const line of input.lines) {
    await db.tellerOpening.upsert({
      where: {
        tellerId_day_currencyCode: {
          tellerId: actor.id,
          day: input.day,
          currencyCode: line.currency,
        },
      },
      create: {
        tellerId: actor.id,
        day: input.day,
        currencyCode: line.currency,
        amount: line.amount,
      },
      update: { amount: line.amount },
    });
  }

  const describe = (map: Map<string, bigint> | null) =>
    map
      ? [...map.entries()].map(([currency, amount]) => `${currency} ${toDecimalString(amount, 2)}`)
      : [];
  const after = new Map(before ?? []);
  for (const line of input.lines) after.set(line.currency, line.amount);

  await audit.record(
    {
      action: before ? 'UPDATE' : 'CREATE',
      module: 'exchange',
      entityType: 'TellerOpening',
      entityId: `${actor.id}:${input.day}`,
      summaryEn: `${before ? 'Corrected' : 'Opened'} his box for ${input.day}`,
      summaryAr: `${before ? 'عدّل' : 'رصّد'} صندوقه الافتتاحي ليوم ${input.day}`,
      actor,
      before: before ? { box: describe(before) } : undefined,
      after: { box: describe(after) },
    },
    db,
  );
}

export async function cashLedger(
  input: { from: Date; to: Date; day?: string },
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

  // The box, carried line by line from what the teller opened with.
  const opened = input.day ? await openingFor(actor.id, input.day, db) : null;
  const box = new Map<string, bigint>(opened ?? []);
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

  const currencies = await db.currency.findMany({
    where: { isActive: true, kind: { not: 'CRYPTO' } },
    orderBy: { sortOrder: 'asc' },
    select: { code: true, decimals: true },
  });

  // Every currency he opened with or traded in closes, even at zero.
  for (const currency of opened?.keys() ?? []) if (!box.has(currency)) box.set(currency, 0n);
  const closing = list(box);
  return {
    from: input.from,
    to: input.to,
    opening: closing.map((entry) => ({
      currency: entry.currency,
      amount: opened?.get(entry.currency) ?? 0n,
    })),
    openingSet: opened !== null,
    currencies,
    traded: [...traded.entries()]
      .map(([currency, totals]) => ({ currency, ...totals }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    entries,
    closing,
  };
}
