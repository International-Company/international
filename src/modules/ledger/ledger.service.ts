import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { MONEY_FACTOR, divideRounded } from '@/core/money/money';
import { dayKey, dayBounds, formatDayKey } from '@/core/time/day-key';
import type { FundingCategory } from '@/modules/drawers/funding-categories';
import { ratesOn, baseCurrency, ONE } from './cutoff.service';

/**
 * دفتر الأستاذ — what the office is worth, and why that changed today.
 *
 * The whole ledger rests on one idea, which is the manager's own: profit is not
 * the sum of the margins written on the day's tickets. It is the change in what
 * the office holds, valued at the rates he approves. A margin that looked good
 * on a ticket is worth nothing if the currency it was earned in fell further
 * than the margin, and a quiet day can still be profitable because a position
 * moved the right way. So the tickets are indicators and the position is the
 * measure.
 *
 * That leaves exactly one thing to be careful about: the owner's own money.
 * What the branch holds also changes when he puts money in or takes it out, and
 * no arithmetic can tell that apart from trading without being told. It is told
 * by the category on every funding movement — which is why that category has no
 * default anywhere in this system.
 *
 *     result = (worth at this close) − (worth at the last close)
 *              − what the owner put in + what he took out
 *
 * Expenses are left inside the result, because they are a real cost of running
 * the window rather than the owner reaching across the boundary. They are
 * reported separately so the result before them can be read too.
 */

/** Converts an amount in a currency to the base, at a 1e8-scaled rate. */
export function valued(amount: bigint, rate: bigint): bigint {
  return divideRounded(amount * rate, MONEY_FACTOR);
}

export interface PositionLine {
  drawerId: string;
  currencyCode: string;
  kind: string;
  balance: bigint;
  cutoffRate: bigint;
  /** The balance in the base currency. */
  worth: bigint;
}

/**
 * What the office holds right now, valued at the rates in force for a date.
 *
 * Used before a close — to show the manager what he is about to freeze — and
 * never after one: a closed day reads its own frozen rows instead, because a
 * result that changes when tomorrow's rate is approved is not a result.
 */
export async function livePosition(
  date: Date = new Date(),
  db: DbClient = prisma,
): Promise<{ base: string; lines: PositionLine[]; missing: string[]; worth: bigint }> {
  const [base, rates, held] = await Promise.all([
    baseCurrency(db),
    ratesOn(date, db),
    db.drawer.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, currencyCode: true, kind: true, balance: true },
    }),
  ]);

  const lines: PositionLine[] = [];
  const missing = new Set<string>();

  for (const drawer of held) {
    const rate = rates.get(drawer.currencyCode)?.rate;
    if (rate === undefined) {
      // Only a currency that actually holds something. A drawer sitting at zero
      // needs no rate: nothing it is worth can be got wrong.
      if (drawer.balance !== 0n) missing.add(drawer.currencyCode);
      continue;
    }
    lines.push({
      drawerId: drawer.id,
      currencyCode: drawer.currencyCode,
      kind: drawer.kind,
      balance: drawer.balance,
      cutoffRate: rate,
      worth: valued(drawer.balance, rate),
    });
  }

  return {
    base,
    lines,
    missing: [...missing],
    worth: lines.reduce((total, line) => total + line.worth, 0n),
  };
}

/** The frozen position of a closed day, read back exactly as it was written. */
export async function positionOf(businessDayId: string, db: DbClient = prisma) {
  const rows = await db.dayPosition.findMany({
    where: { businessDayId },
    orderBy: [{ currencyCode: 'asc' }, { kind: 'asc' }],
  });

  return rows.map((row) => ({
    drawerId: row.drawerId,
    currencyCode: row.currencyCode,
    kind: row.kind,
    balance: row.balance,
    cutoffRate: row.cutoffRate,
    worth: valued(row.balance, row.cutoffRate),
  }));
}

const worthOf = (lines: { worth: bigint }[]) => lines.reduce((total, l) => total + l.worth, 0n);

/**
 * Freezes what every drawer holds, at the rates in force, onto a day.
 *
 * Called from the close, inside its transaction. It refuses if any currency the
 * branch actually holds has no approved rate — valuing a holding at nothing
 * would understate the office by exactly the amount nobody had got round to
 * pricing, and that understatement would then be reported as a loss.
 */
export async function freezePosition(
  businessDayId: string,
  date: Date,
  db: DbClient,
): Promise<void> {
  const position = await livePosition(date, db);

  if (position.missing.length > 0) {
    throw errors.precondition(
      `No cut-off rate is approved for ${position.missing.join(', ')} — set one before closing`,
      'errors.cutoffMissing',
      { currencies: position.missing.join('، ') },
    );
  }

  // Re-closing a day that was reopened replaces its position rather than adding
  // to it: the day has one closing balance, and the second close is the one
  // that describes it.
  await db.dayPosition.deleteMany({ where: { businessDayId } });

  await db.dayPosition.createMany({
    data: position.lines.map((line) => ({
      businessDayId,
      drawerId: line.drawerId,
      currencyCode: line.currencyCode,
      kind: line.kind,
      balance: line.balance,
      cutoffRate: line.cutoffRate,
    })),
  });
}

// ---------------------------------------------------------------------------
// The day's result
// ---------------------------------------------------------------------------

export interface FundingTotals {
  ownerIn: bigint;
  ownerOut: bigint;
  expense: bigint;
  correction: bigint;
}

export interface DayResult {
  base: string;
  date: string;
  status: string;
  /** Frozen when the day is closed, live otherwise. */
  frozen: boolean;
  position: PositionLine[];
  missing: string[];
  worth: bigint;
  /** The previous close this day is measured against; zero if there is none. */
  openingWorth: bigint;
  openingDate: string | null;
  funding: FundingTotals;
  /**
   * What the day earned: the change in worth, with the owner's own money taken
   * back out of it. Expenses are inside this figure.
   */
  result: bigint;
  /** The same before expenses, which is what the window itself produced. */
  resultBeforeExpenses: bigint;
  /**
   * How much of the change came from rates moving rather than from trading —
   * yesterday's holdings repriced at today's rates. The rest is the window.
   */
  revaluation: bigint;
  tradingResult: bigint;
  /** The margins written on the day's tickets, valued in the base currency. */
  margins: { type: string; count: number; margin: bigint }[];
}

/**
 * Everything the manager reads about one day.
 *
 * A closed day answers from its own frozen rows and never moves again. An open
 * one answers from the live balances at today's approved rates, and says so —
 * it is a running figure, which is exactly what a manager wants at four in the
 * afternoon and exactly what nobody should quote in a report.
 */
export async function dayResult(
  branchId: string,
  date: Date,
  db: DbClient = prisma,
): Promise<DayResult> {
  const on = dayKey(date);
  const base = await baseCurrency(db);

  const day = await db.businessDay.findUnique({
    where: { branchId_date: { branchId, date: on } },
    select: { id: true, status: true },
  });

  const closed = day?.status === 'CLOSED';
  const frozenRows = day ? await positionOf(day.id, db) : [];
  const frozen = closed && frozenRows.length > 0;

  const live = frozen ? null : await livePosition(on, db);
  const position = frozen ? frozenRows : (live?.lines ?? []);
  const worth = worthOf(position);

  /*
   * The last close before this day, wherever it fell. Not "yesterday": an office
   * that was shut on Friday must measure Saturday against Thursday, or Friday's
   * absence would be reported as a day that earned nothing and Saturday's as a
   * day that earned two days' worth.
   */
  const previous = await db.businessDay.findFirst({
    where: { branchId, date: { lt: on }, status: 'CLOSED', positions: { some: {} } },
    orderBy: { date: 'desc' },
    select: { id: true, date: true },
  });

  const openingLines = previous ? await positionOf(previous.id, db) : [];
  const openingWorth = worthOf(openingLines);

  const funding = await fundingTotals(day?.id ?? null, on, db);
  const owner = funding.ownerIn - funding.ownerOut;

  const result = worth - openingWorth - owner;

  /*
   * What yesterday's holdings alone would have gained from the rates moving.
   * Measured on the opening position at both days' rates, so what is left is
   * what the window actually did — the manager's own distinction between the
   * position and the trading.
   */
  const rates = frozen
    ? new Map(position.map((line) => [line.currencyCode, line.cutoffRate]))
    : new Map([...(await ratesOn(on, db))].map(([code, entry]) => [code, entry.rate]));

  const revaluation = openingLines.reduce((total, line) => {
    const now = rates.get(line.currencyCode) ?? line.cutoffRate;
    return total + valued(line.balance, now) - valued(line.balance, line.cutoffRate);
  }, 0n);

  return {
    base,
    date: formatDayKey(on),
    status: day?.status ?? 'NONE',
    frozen,
    position,
    missing: live?.missing ?? [],
    worth,
    openingWorth,
    openingDate: previous ? formatDayKey(previous.date) : null,
    funding,
    result,
    resultBeforeExpenses: result + funding.expense,
    revaluation,
    tradingResult: result - revaluation,
    margins: await marginsOn(day?.id ?? null, branchId, on, db),
  };
}

/**
 * The owner's money and the day's costs, valued in the base currency.
 *
 * Read from the movements rather than from any running total, for the reason
 * every figure here is: a total kept alongside the movements is a second thing
 * claiming to know, and the day it disagrees nobody can say which is right.
 */
async function fundingTotals(
  businessDayId: string | null,
  date: Date,
  db: DbClient,
): Promise<FundingTotals> {
  const rates = await ratesOn(date, db);

  const rows = await db.drawerMovement.findMany({
    where: { ...fundingWhere(businessDayId, date), category: { not: null } },
    select: {
      direction: true,
      amount: true,
      category: true,
      drawer: { select: { currencyCode: true } },
    },
  });

  const totals: FundingTotals = { ownerIn: 0n, ownerOut: 0n, expense: 0n, correction: 0n };

  for (const row of rows) {
    const rate = rates.get(row.drawer.currencyCode)?.rate;
    // A movement in a currency with no approved rate is left out rather than
    // valued at a guess. The close refuses to happen in that state, so this
    // only ever affects a day still being watched live.
    if (rate === undefined) continue;

    const worth = valued(row.amount, rate);
    const category = row.category as FundingCategory;

    if (category === 'OWNER_IN') totals.ownerIn += worth;
    else if (category === 'OWNER_OUT') totals.ownerOut += worth;
    else if (category === 'EXPENSE') totals.expense += worth;
    else if (category === 'CORRECTION') {
      // A shortage found in the count is a loss and a surplus is a gain, so the
      // direction is the sign. It stays inside the result; it is separated only
      // so the manager can see how much of the day came from miscounting.
      totals.correction += row.direction === 'IN' ? worth : -worth;
    }
  }

  // An expense is money leaving, and a deposit money arriving, whichever
  // direction the movement happened to be recorded in — but the categories are
  // only meaningful one way round, so nothing here needs a sign but correction.
  return totals;
}

/**
 * The margins written on the day's tickets, by kind of business.
 *
 * The manager's «صندوق أرباح صرافة» and «صندوق أرباح حوالات» — indicators, not
 * balances. Nothing holds this money: it is already inside the drawers, and
 * showing it as a fund of its own would be the same shekel counted twice.
 */
async function marginsOn(
  businessDayId: string | null,
  branchId: string,
  date: Date,
  db: DbClient,
): Promise<{ type: string; count: number; margin: bigint }[]> {
  const { start, end } = dayBounds(date);
  const rates = await ratesOn(date, db);

  const rows = await db.transaction.findMany({
    where: {
      branchId,
      // A transaction has belonged to a day since it was first recorded, so
      // this is the day it belongs to — not the day it happens to fall on.
      ...(businessDayId ? { businessDayId } : { createdAt: { gte: start, lte: end } }),
      status: { in: ['POSTED', 'PENDING_TRANSFER'] },
    },
    select: { type: true, profitAmount: true, toCurrency: true },
  });

  const byType = new Map<string, { count: number; margin: bigint }>();

  for (const row of rows) {
    const rate = rates.get(row.toCurrency)?.rate ?? ONE;
    const entry = byType.get(row.type) ?? { count: 0, margin: 0n };
    entry.count += 1;
    entry.margin += valued(row.profitAmount, rate);
    byType.set(row.type, entry);
  }

  return [...byType].map(([type, entry]) => ({ type, ...entry }));
}

/**
 * Which funding movements belong to a day.
 *
 * The day itself when there is one, because a day is opened and closed by hand
 * and what happened inside it is what its result is measured on. Only when no
 * day was ever opened for the date does this fall back to the calendar, which
 * is the honest answer for movements recorded before funding belonged to a day
 * at all.
 */
function fundingWhere(businessDayId: string | null, date: Date) {
  if (businessDayId) return { reason: 'FUNDING' as const, businessDayId };
  const { start, end } = dayBounds(date);
  return { reason: 'FUNDING' as const, businessDayId: null, createdAt: { gte: start, lte: end } };
}

/**
 * The day's funding movements themselves, so a figure can be opened up.
 *
 * A manager who reads "the owner took out 4,000" and cannot see the four lines
 * behind it has been given a number to believe rather than to check.
 */
export async function fundingOn(branchId: string, date: Date, db: DbClient = prisma) {
  const day = await db.businessDay.findUnique({
    where: { branchId_date: { branchId, date: dayKey(date) } },
    select: { id: true },
  });

  return db.drawerMovement.findMany({
    where: fundingWhere(day?.id ?? null, date),
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      direction: true,
      amount: true,
      category: true,
      note: true,
      account: true,
      createdAt: true,
      drawer: { select: { currencyCode: true, kind: true } },
      createdBy: { select: { fullNameEn: true, fullNameAr: true } },
    },
  });
}

/**
 * A run of closed days with what each was worth, for the trend.
 *
 * Only closed days appear: an open one is a running figure, and putting it on a
 * chart beside settled ones invites a comparison that is not being made.
 */
export async function worthHistory(branchId: string, limit = 30, db: DbClient = prisma) {
  const days = await db.businessDay.findMany({
    where: { branchId, status: 'CLOSED', positions: { some: {} } },
    orderBy: { date: 'desc' },
    take: Math.min(limit, 120),
    select: { id: true, date: true, positions: true },
  });

  return days
    .map((day) => ({
      date: formatDayKey(day.date),
      worth: day.positions.reduce(
        (total, row) => total + valued(row.balance, row.cutoffRate),
        0n,
      ),
    }))
    .reverse();
}
