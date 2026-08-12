import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { createLogger } from '@/core/logger/logger';
import * as notifications from '@/modules/notifications/notifications.service';
import { baseCurrency, ratesOn } from '@/modules/ledger/cutoff.service';
import { valued } from '@/modules/ledger/ledger.service';

/**
 * The teller's day, written by the system instead of by the teller.
 *
 * A manager who has to ask for a report gets the report the teller chose to
 * write — filed when he remembers, in the shape he prefers, omitting what he
 * would rather not raise. This one is composed the moment the shift closes, out
 * of the same rows that moved the money, and it reaches the manager on its own.
 *
 * ## Why the observations exist
 *
 * A page of correct numbers is not a report. Somebody still has to notice that
 * the margin is down a third, or that this is the third shortage in five
 * shifts — and a manager reading twenty of these a week will stop noticing.
 * So the noticing is done here.
 *
 * Two rules govern it, and both matter:
 *
 * **Against his own history, not against the others.** Tellers work different
 * windows and different counters; a man compared to the branch's average is
 * being judged on which chair he was given. Every comparison here is to his own
 * median over his recent shifts.
 *
 * **Codes, not sentences.** What is stored is `{ code, tone, params }`, and the
 * words are looked up when somebody reads it. So the report speaks whichever
 * language the reader has, and — more to the point — nothing writes prose about
 * a man's money. "أقلّ من معدله بـ ٣٠٪" is a fact with a number attached; a
 * generated sentence about how he seems to be doing is an opinion nobody can
 * check and no system should be putting in a personnel file.
 *
 * ## When it is written
 *
 * Inside the transaction that closes the shift. A closed shift therefore always
 * has one, and cannot be left without because a later step failed. If composing
 * it fails, the handover fails with it and nothing has moved — the teller
 * counts again, which costs a minute, rather than the office keeping a shift
 * with no record of what happened in it.
 */

const log = createLogger('treasury:shift-report');

/**
 * How far back "usually" reaches.
 *
 * Ten shifts is roughly a fortnight of one man's work: long enough that one bad
 * afternoon does not become his baseline, short enough that a teller who has
 * improved is measured on who he is now rather than who he was in the spring.
 */
const HISTORY = 10;

/** Below this share of his usual margin per deal, the drop is worth a line. */
const MARGIN_LOW = 0.7;
/** And above this, so the report is not only ever bad news. */
const MARGIN_HIGH = 1.3;

/** Shortages within the recent window that turn one bad count into a pattern. */
const REPEAT_WINDOW = 5;
const REPEAT_COUNT = 3;

/** Fewer deals than this, with a shift of real length, is a quiet counter. */
const QUIET_DEALS = 3;

export type Tone = 'GOOD' | 'NOTE' | 'WARN';

export interface Observation {
  code: string;
  tone: Tone;
  params?: Record<string, string | number>;
}

/**
 * Composes and stores the report for a shift that is closing.
 *
 * Called from inside the closing transaction, after the money has moved and the
 * difference (if any) has been booked, so what it reads is final.
 */
export async function writeForShift(
  shift: {
    id: string;
    tellerId: string;
    branchId: string;
    businessDayId: string | null;
    reference: string;
    openedAt: Date;
    openingHandoverId: string;
    closingHandoverId?: string | null;
  },
  closingHandoverId: string,
  tx: DbClient,
): Promise<void> {
  const closedAt = new Date();
  const [base, rates] = await Promise.all([baseCurrency(tx), ratesOn(closedAt, tx)]);

  /*
   * A currency with no cut-off rate is not worth one-for-one. Counting it that
   * way would be an invented figure in a report about somebody's performance,
   * so it is left out of the totals and said out loud instead.
   */
  const unpriced = new Set<string>();
  const worth = (amount: bigint, currency: string): bigint => {
    const rate = rates.get(currency)?.rate;
    if (rate === undefined) {
      if (amount !== 0n) unpriced.add(currency);
      return 0n;
    }
    return valued(amount, rate);
  };

  const [opening, closing, deals, differences, exceptions] = await Promise.all([
    tx.handoverLine.findMany({
      where: { handoverId: shift.openingHandoverId },
      select: { currencyCode: true, amount: true },
    }),
    tx.handoverLine.findMany({
      where: { handoverId: closingHandoverId },
      select: { currencyCode: true, countedAmount: true, amount: true },
    }),
    tx.transaction.findMany({
      where: {
        createdById: shift.tellerId,
        createdAt: { gte: shift.openedAt, lte: closedAt },
        // A reversal is a second row belonging to whoever reversed it, and a
        // reversed original earned nothing. Neither is this teller's work.
        status: { in: ['POSTED', 'PENDING_TRANSFER'] },
        reversalOfId: null,
      },
      select: { type: true, profitAmount: true, toCurrency: true },
    }),
    tx.discrepancy.findMany({
      where: { shiftId: shift.id },
      select: { amount: true, currencyCode: true },
    }),
    tx.priceException.findMany({
      where: {
        requestedById: shift.tellerId,
        createdAt: { gte: shift.openedAt, lte: closedAt },
      },
      select: { status: true, concededAmount: true, concededCurrency: true, approvedRate: true, costRate: true },
    }),
  ]);

  // --- The figures ---------------------------------------------------------
  const floatWorth = opening.reduce((total, line) => total + worth(line.amount, line.currencyCode), 0n);
  const returnedWorth = closing.reduce(
    (total, line) => total + worth(line.countedAmount ?? line.amount, line.currencyCode),
    0n,
  );

  const byType = new Map<string, number>();
  let margin = 0n;
  for (const deal of deals) {
    byType.set(deal.type, (byType.get(deal.type) ?? 0) + 1);
    margin += worth(deal.profitAmount, deal.toCurrency);
  }

  // A shortage is stored positive; the office lost it, so it enters negative.
  let differenceTotal = 0n;
  let shortages = 0;
  let surpluses = 0;
  let largestShortage = 0n;
  for (const difference of differences) {
    differenceTotal -= worth(difference.amount, difference.currencyCode);
    if (difference.amount > 0n) {
      shortages += 1;
      if (difference.amount > largestShortage) largestShortage = difference.amount;
    } else if (difference.amount < 0n) {
      surpluses += 1;
    }
  }

  let concessions = 0n;
  let granted = 0;
  let grantedBelowCost = 0;
  for (const exception of exceptions) {
    if (exception.status === 'USED' || exception.status === 'APPROVED') granted += 1;
    if (exception.concededAmount) {
      concessions -= worth(exception.concededAmount, exception.concededCurrency ?? base);
    }
    // A higher rate is worse for the office, so it is above cost while below it.
    if (exception.approvedRate && exception.costRate && exception.approvedRate >= exception.costRate) {
      grantedBelowCost += 1;
    }
  }

  const net = margin + differenceTotal + concessions;
  const minutes = Math.max(0, Math.round((closedAt.getTime() - shift.openedAt.getTime()) / 60_000));

  // --- What is worth saying about it ---------------------------------------
  const observations = await notice(
    {
      tellerId: shift.tellerId,
      deals: deals.length,
      margin,
      differenceTotal,
      shortages,
      surpluses,
      largestShortage,
      concessions,
      exceptionsAsked: exceptions.length,
      grantedBelowCost,
      minutes,
      unpriced: [...unpriced],
      base,
    },
    tx,
  );

  await tx.shiftReport.create({
    data: {
      shiftId: shift.id,
      tellerId: shift.tellerId,
      branchId: shift.branchId,
      businessDayId: shift.businessDayId,
      openedAt: shift.openedAt,
      closedAt,
      minutes,
      baseCurrency: base,
      floatWorth,
      returnedWorth,
      deals: deals.length,
      dealsByType: JSON.stringify(Object.fromEntries(byType)),
      margin,
      differences: differenceTotal,
      concessions,
      net,
      shortages,
      surpluses,
      exceptionsAsked: exceptions.length,
      exceptionsGranted: granted,
      observations: JSON.stringify(observations),
    },
  });

  const teller = await tx.user.findUniqueOrThrow({
    where: { id: shift.tellerId },
    select: { fullNameEn: true, fullNameAr: true },
  });

  const worst = observations.some((entry) => entry.tone === 'WARN');

  await notifications.notify(
    {
      severity: worst ? 'WARNING' : 'INFO',
      eventKey: 'treasury.shiftReport.ready',
      module: 'exchange',
      titleEn: `Shift report — ${teller.fullNameEn}`,
      titleAr: `تقرير ورديّة — ${teller.fullNameAr}`,
      bodyEn: `${shift.reference} · ${deals.length} deals`,
      bodyAr: `${shift.reference} · ${deals.length} عملية`,
      entityType: 'ShiftReport',
      entityId: shift.id,
      link: '/manage/tellers',
    },
    { permission: 'ledger.view', branchId: shift.branchId, exceptUserId: shift.tellerId },
    tx,
  );

  log.info('Shift report written', {
    shift: shift.reference,
    deals: deals.length,
    observations: observations.length,
  });
}

// ---------------------------------------------------------------------------
// The noticing
// ---------------------------------------------------------------------------

interface Summary {
  tellerId: string;
  deals: number;
  margin: bigint;
  differenceTotal: bigint;
  shortages: number;
  surpluses: number;
  largestShortage: bigint;
  concessions: bigint;
  exceptionsAsked: number;
  grantedBelowCost: number;
  minutes: number;
  unpriced: string[];
  base: string;
}

/**
 * What a person reading twenty of these a week would want pointed out.
 *
 * Ordered worst-first, so the line that matters is the first one read. And when
 * there is genuinely nothing to say, it says that rather than showing an empty
 * space — "nothing to report" is information, and a report that is silent on a
 * clean shift teaches the reader that silence means unread.
 */
async function notice(summary: Summary, tx: DbClient): Promise<Observation[]> {
  const found: Observation[] = [];

  const history = await tx.shiftReport.findMany({
    where: { tellerId: summary.tellerId },
    orderBy: { closedAt: 'desc' },
    take: HISTORY,
    select: { margin: true, deals: true, shortages: true, exceptionsAsked: true },
  });

  // --- Things that cost money ----------------------------------------------
  if (summary.unpriced.length > 0) {
    found.push({
      code: 'UNPRICED',
      tone: 'WARN',
      params: { currencies: summary.unpriced.join('، ') },
    });
  }

  if (summary.shortages > 0) {
    found.push({
      code: 'SHORT',
      tone: 'WARN',
      params: { count: summary.shortages, amount: decimal(summary.largestShortage) },
    });

    const recent = history.slice(0, REPEAT_WINDOW - 1);
    const repeated = recent.filter((entry) => entry.shortages > 0).length + 1;
    if (repeated >= REPEAT_COUNT) {
      found.push({
        code: 'SHORT_REPEATED',
        tone: 'WARN',
        params: { count: repeated, window: Math.min(REPEAT_WINDOW, recent.length + 1) },
      });
    }
  }

  if (summary.grantedBelowCost > 0) {
    found.push({ code: 'BELOW_COST', tone: 'WARN', params: { count: summary.grantedBelowCost } });
  }

  /*
   * A surplus is not good news wearing a different hat. The likeliest reason a
   * drawer holds more than it should is that somebody was handed less than they
   * were owed and has not noticed yet.
   */
  if (summary.surpluses > 0) {
    found.push({ code: 'SURPLUS', tone: 'NOTE', params: { count: summary.surpluses } });
  }

  // --- Against his own usual ------------------------------------------------
  const priorDeals = history.filter((entry) => entry.deals > 0);
  if (priorDeals.length >= 3 && summary.deals > 0) {
    const usual = median(priorDeals.map((entry) => Number(entry.margin) / entry.deals));
    const now = Number(summary.margin) / summary.deals;

    if (usual > 0 && now < usual * MARGIN_LOW) {
      found.push({
        code: 'MARGIN_BELOW',
        tone: 'NOTE',
        params: { percent: Math.round((1 - now / usual) * 100) },
      });
    } else if (usual > 0 && now > usual * MARGIN_HIGH) {
      found.push({
        code: 'MARGIN_ABOVE',
        tone: 'GOOD',
        params: { percent: Math.round((now / usual - 1) * 100) },
      });
    }

    const usualAsks = median(history.map((entry) => entry.exceptionsAsked));
    if (summary.exceptionsAsked >= 2 && summary.exceptionsAsked > Math.max(1, usualAsks * 2)) {
      found.push({
        code: 'MANY_EXCEPTIONS',
        tone: 'NOTE',
        params: { count: summary.exceptionsAsked, usual: Math.round(usualAsks) },
      });
    }
  }

  // --- Shape of the shift ---------------------------------------------------
  if (history.length === 0) {
    found.push({ code: 'FIRST_SHIFT', tone: 'NOTE' });
  }

  if (summary.deals < QUIET_DEALS && summary.minutes > 120) {
    found.push({
      code: 'QUIET',
      tone: 'NOTE',
      params: { deals: summary.deals, hours: Math.round(summary.minutes / 60) },
    });
  }

  if (found.length === 0) {
    found.push({ code: 'CLEAN', tone: 'GOOD' });
  }

  const order: Record<Tone, number> = { WARN: 0, NOTE: 1, GOOD: 2 };
  return found.sort((a, b) => order[a.tone] - order[b.tone]);
}

/** The middle value, which one exceptional afternoon cannot drag. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/** A scaled amount as plain digits, for a number carried inside a sentence. */
function decimal(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(9, '0');
  const whole = digits.slice(0, -8).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${whole}.${digits.slice(-8, -6)}`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listReports(
  filter: { branchId?: string | null; tellerId?: string; limit?: number } = {},
  db: DbClient = prisma,
) {
  return db.shiftReport.findMany({
    where: {
      ...(filter.branchId ? { branchId: filter.branchId } : {}),
      ...(filter.tellerId ? { tellerId: filter.tellerId } : {}),
    },
    orderBy: { closedAt: 'desc' },
    take: Math.min(filter.limit ?? 20, 100),
    include: {
      teller: { select: { fullNameEn: true, fullNameAr: true } },
      shift: { select: { reference: true } },
    },
  });
}

export function parseObservations(raw: string): Observation[] {
  try {
    const parsed = JSON.parse(raw) as Observation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
