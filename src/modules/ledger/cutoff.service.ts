import 'server-only';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import { dayKey, formatDayKey } from '@/core/time/day-key';
import * as audit from '@/modules/audit/audit.service';

/**
 * أسعار القص — the rates the office's holdings are valued at.
 *
 * Deliberately not the trading board. The board says what the counter charges a
 * customer standing in front of it; this says what the branch's own position is
 * worth at the end of the day, and the two are different judgements made for
 * different reasons. In a market driven by supply and demand the manager reads
 * the second one himself, and the whole day's profit is measured against it — so
 * it is approved by hand rather than derived from the trades that happened to
 * pass through the window.
 *
 * They roll forward. A day with no rate for a currency uses the most recent
 * earlier one, because silence at the close means the manager saw no reason to
 * move it — not that the currency became worthless. Rolling forward is what
 * makes a day nobody touched still value correctly.
 *
 * Everything is quoted in units of the base currency for one unit of the other,
 * scaled 1e8, and the base currency is worth exactly one of itself.
 */

export const ONE = 100000000n;

export interface Actor {
  id: string;
  name: string;
  ip?: string | null;
  sessionId?: string;
  permissions: string[];
}

/** The currency everything else is measured in. */
export async function baseCurrency(db: DbClient = prisma): Promise<string> {
  const base = await db.currency.findFirst({ where: { isBase: true }, select: { code: true } });
  if (!base) {
    throw errors.precondition(
      'No base currency is marked — the position has nothing to be measured in',
      'errors.noBaseCurrency',
    );
  }
  return base.code;
}

/**
 * The rates in force on a date, one per currency.
 *
 * Resolved per currency by looking backwards, so a currency set months ago and
 * a currency set this morning both answer. The base currency is not stored and
 * cannot be set: it is one of itself by definition, and a row saying otherwise
 * would be a rate the manager could get wrong.
 */
export async function ratesOn(
  date: Date,
  db: DbClient = prisma,
): Promise<Map<string, { rate: bigint; setOn: Date | null }>> {
  const on = dayKey(date);
  const base = await baseCurrency(db);

  const currencies = await db.currency.findMany({
    where: { isActive: true },
    select: { code: true },
    orderBy: { sortOrder: 'asc' },
  });

  const resolved = new Map<string, { rate: bigint; setOn: Date | null }>();

  // One query per currency rather than one for all of them: "the latest row on
  // or before this date, per currency" is a window function in SQL, and the
  // handful of currencies an exchange office trades does not justify one.
  await Promise.all(
    currencies.map(async ({ code }) => {
      if (code === base) {
        resolved.set(code, { rate: ONE, setOn: null });
        return;
      }
      const row = await db.cutoffRate.findFirst({
        where: { currencyCode: code, date: { lte: on } },
        orderBy: { date: 'desc' },
        select: { rate: true, date: true },
      });
      if (row) resolved.set(code, { rate: row.rate, setOn: row.date });
    }),
  );

  return resolved;
}

/**
 * Sets a currency's cut-off rate for a date, replacing any already set for it.
 *
 * Replacing rather than superseding, unlike the trading board. A trading rate
 * that was quoted to a customer is evidence and must survive; a cut-off rate is
 * an opinion about value that has not been acted on, and the manager correcting
 * a typo before the close should leave one rate for the day, not two. What was
 * actually used is frozen onto the day's positions the moment it is closed, and
 * that is the copy nothing can rewrite.
 */
export async function setRate(
  input: { date?: Date; currencyCode: string; rate: bigint; note?: string | null },
  actor: Actor,
  db: DbClient = prisma,
) {
  if (!actor.permissions.includes('ledger.cutoff.manage')) {
    throw errors.forbidden('ledger.cutoff.manage');
  }
  if (input.rate <= 0n) {
    throw errors.precondition('A cut-off rate must be greater than zero', 'errors.rateNotPositive');
  }

  const date = dayKey(input.date ?? new Date());
  const code = input.currencyCode.toUpperCase();
  const base = await baseCurrency(db);

  if (code === base) {
    throw errors.precondition(
      `${base} is the currency everything else is measured in — it cannot be given a rate against itself`,
      'errors.cutoffBaseCurrency',
      { currency: base },
    );
  }

  const currency = await db.currency.findUnique({ where: { code } });
  if (!currency) throw errors.notFound('Currency', code);

  return withTransaction(async (tx) => {
    const previous = await tx.cutoffRate.findUnique({
      where: { date_currencyCode: { date, currencyCode: code } },
    });

    const row = await tx.cutoffRate.upsert({
      where: { date_currencyCode: { date, currencyCode: code } },
      create: {
        date,
        currencyCode: code,
        rate: input.rate,
        note: input.note ?? null,
        setById: actor.id,
      },
      update: { rate: input.rate, note: input.note ?? null, setById: actor.id },
    });

    await audit.record(
      {
        action: previous ? 'UPDATE' : 'CREATE',
        module: 'exchange',
        entityType: 'CutoffRate',
        entityId: row.id,
        summaryEn: `Cut-off rate for ${code} on ${formatDayKey(date)}: 1 ${code} = ${toDecimalString(input.rate, 4)} ${base}`,
        summaryAr: `سعر القص لـ ${code} بتاريخ ${formatDayKey(date)}: 1 ${code} = ${toDecimalString(input.rate, 4)} ${base}`,
        actor,
        before: previous ? { rate: previous.rate.toString() } : undefined,
        after: { rate: input.rate.toString() },
      },
      tx,
    );

    return row;
  }, db);
}

/** Rates actually written for a date, for the screen that edits them. */
export async function ratesSetOn(date: Date, db: DbClient = prisma) {
  return db.cutoffRate.findMany({
    where: { date: dayKey(date) },
    include: { setBy: { select: { fullNameEn: true, fullNameAr: true } } },
    orderBy: { currencyCode: 'asc' },
  });
}

/** Recent history for one currency, so a manager can see how it has moved. */
export async function historyFor(currencyCode: string, limit = 30, db: DbClient = prisma) {
  return db.cutoffRate.findMany({
    where: { currencyCode: currencyCode.toUpperCase() },
    orderBy: { date: 'desc' },
    take: Math.min(limit, 120),
    select: { date: true, rate: true, note: true },
  });
}
