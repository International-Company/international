import 'server-only';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import { nextReference } from '@/modules/sequence/reference';
import { currentOpenDay } from '@/modules/exchange/business-day.service';
import * as drawers from '@/modules/drawers/drawer.service';
import * as audit from '@/modules/audit/audit.service';
import { ensureDifferenceDrawer, type Actor } from './shift.service';

const log = createLogger('till-count');

/**
 * جرد الصندوق — counting a teller against what they traded, with no float.
 *
 * ## The arithmetic
 *
 * For every currency, over the period since the teller was last counted:
 *
 *     expected = opening + received − paid + toppedUp − drawn
 *
 * - opening   what was left with them at the last count (`kept`), or nothing;
 * - received  cash their own deals took in;
 * - paid      cash their own deals paid out;
 * - toppedUp  cash the safe gave them in between (a till adjustment, IN);
 * - drawn     cash the safe took from them in between (OUT).
 *
 * Then the drawer is counted, and expected − counted is the difference:
 * positive short, negative over. This is the cash proof banks run at every
 * window at the end of the day, and it needs nothing from the teller during it.
 *
 * ## Whose deals
 *
 * A deal belongs to whoever recorded it, read from the cash movements its legs
 * made — so every kind of deal counts the same way, the machine, wallets, USDT,
 * remittances, without this file knowing any of them. A reversal belongs to the
 * teller whose deal it undid, whoever pressed the button: the cash it puts back
 * is cash the teller was never meant to be holding.
 *
 * Bank and broker legs never touch a drawer of notes, so they never enter it.
 *
 * ## Where the difference goes
 *
 * Without a shift the teller trades out of the treasury's own cash, so the
 * books hold the teller's money there. A shortage is taken out of it into the
 * differences balance, a surplus the other way — exactly what the shift close
 * does — and a Discrepancy is opened for it, to be ruled on in the same place
 * as every other: a miscount, the teller's debt, or the office's loss.
 */

export interface TillLine {
  currency: string;
  opening: bigint;
  received: bigint;
  paid: bigint;
  toppedUp: bigint;
  drawn: bigint;
  expected: bigint;
}

export interface TillPreview {
  teller: { id: string; fullNameEn: string; fullNameAr: string; branchId: string | null };
  periodStart: Date;
  periodEnd: Date;
  /** The count this one carries on from, if any. */
  previous: { reference: string; createdAt: Date } | null;
  /** How many of the teller's deals fall in the period. */
  deals: number;
  /** A teller still on a shift is counted by the handover, not by this. */
  onShift: boolean;
  lines: TillLine[];
}

function requireCounter(actor: Actor): void {
  if (!actor.permissions.includes('treasury.handover.manage')) {
    throw errors.forbidden('treasury.handover.manage');
  }
}

/** Where a teller's period begins when they have never been counted: today. */
async function firstStart(branchId: string | null, db: DbClient): Promise<Date> {
  const day = branchId
    ? await db.businessDay.findFirst({ where: { branchId }, orderBy: { date: 'desc' } })
    : null;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  if (!day) return midnight;
  // The later of the two: an automatic day left open since last week must not
  // drag a week of deals into a first count.
  return day.openedAt > midnight ? day.openedAt : midnight;
}

/** Received and paid in cash, per currency, by the teller's own deals. */
export async function cashFlows(
  tellerId: string,
  from: Date,
  to: Date,
  db: DbClient = prisma,
): Promise<{ flows: Map<string, { received: bigint; paid: bigint }>; deals: number }> {
  const movements = await db.drawerMovement.findMany({
    where: {
      createdAt: { gt: from, lte: to },
      reason: { in: ['TRANSACTION', 'REVERSAL'] },
      drawer: { kind: 'CASH' },
      transaction: {
        OR: [
          { createdById: tellerId, reversalOfId: null },
          { reversalOf: { createdById: tellerId } },
        ],
      },
    },
    select: {
      direction: true,
      amount: true,
      transactionId: true,
      drawer: { select: { currencyCode: true } },
    },
  });

  const flows = new Map<string, { received: bigint; paid: bigint }>();
  const deals = new Set<string>();
  for (const movement of movements) {
    const currency = movement.drawer.currencyCode;
    const flow = flows.get(currency) ?? { received: 0n, paid: 0n };
    if (movement.direction === 'IN') flow.received += movement.amount;
    else flow.paid += movement.amount;
    flows.set(currency, flow);
    if (movement.transactionId) deals.add(movement.transactionId);
  }
  return { flows, deals: deals.size };
}

/** What the teller should hold right now, currency by currency. */
export async function preview(
  tellerId: string,
  actor: Actor,
  db: DbClient = prisma,
  now: Date = new Date(),
): Promise<TillPreview> {
  requireCounter(actor);

  const teller = await db.user.findUnique({
    where: { id: tellerId },
    select: { id: true, fullNameEn: true, fullNameAr: true, branchId: true },
  });
  if (!teller) throw errors.notFound('User', tellerId);

  const previous = await db.tillCount.findFirst({
    where: { tellerId },
    orderBy: { periodEnd: 'desc' },
    select: {
      reference: true,
      createdAt: true,
      periodEnd: true,
      lines: { select: { currencyCode: true, kept: true } },
    },
  });

  const periodStart = previous?.periodEnd ?? (await firstStart(teller.branchId, db));

  const [{ flows, deals }, adjustments, shift] = await Promise.all([
    cashFlows(tellerId, periodStart, now, db),
    db.tillAdjustment.findMany({
      where: { tellerId, createdAt: { gt: periodStart, lte: now } },
      select: { currencyCode: true, direction: true, amount: true },
    }),
    db.shift.findFirst({ where: { tellerId, status: 'OPEN' }, select: { id: true } }),
  ]);

  const lines = new Map<string, TillLine>();
  const line = (currency: string): TillLine => {
    const existing = lines.get(currency);
    if (existing) return existing;
    const fresh: TillLine = {
      currency,
      opening: 0n,
      received: 0n,
      paid: 0n,
      toppedUp: 0n,
      drawn: 0n,
      expected: 0n,
    };
    lines.set(currency, fresh);
    return fresh;
  };

  for (const kept of previous?.lines ?? []) {
    if (kept.kept !== 0n) line(kept.currencyCode).opening = kept.kept;
  }
  for (const [currency, flow] of flows) {
    line(currency).received = flow.received;
    line(currency).paid = flow.paid;
  }
  for (const adjustment of adjustments) {
    const target = line(adjustment.currencyCode);
    if (adjustment.direction === 'IN') target.toppedUp += adjustment.amount;
    else target.drawn += adjustment.amount;
  }
  for (const row of lines.values()) {
    row.expected = row.opening + row.received - row.paid + row.toppedUp - row.drawn;
  }

  return {
    teller,
    periodStart,
    periodEnd: now,
    previous: previous ? { reference: previous.reference, createdAt: previous.createdAt } : null,
    deals,
    onShift: shift !== null,
    lines: [...lines.values()],
  };
}

/** Cash the safe gives a teller, or takes back, between two counts. */
export async function adjust(
  input: {
    tellerId: string;
    currency: string;
    direction: 'IN' | 'OUT';
    amount: bigint;
    note?: string | null;
  },
  actor: Actor,
  db: DbClient = prisma,
) {
  requireCounter(actor);
  if (input.amount <= 0n) {
    throw errors.validation([{ path: 'amount', message: 'Must be more than zero' }]);
  }

  return withTransaction(async (tx) => {
    const teller = await tx.user.findUnique({ where: { id: input.tellerId } });
    if (!teller) throw errors.notFound('User', input.tellerId);

    const row = await tx.tillAdjustment.create({
      data: {
        tellerId: input.tellerId,
        currencyCode: input.currency.toUpperCase(),
        direction: input.direction,
        amount: input.amount,
        note: input.note ?? null,
        createdById: actor.id,
      },
    });

    const amount = `${toDecimalString(input.amount, 2)} ${row.currencyCode}`;
    await audit.record(
      {
        action: 'CREATE',
        module: 'exchange',
        entityType: 'TillAdjustment',
        entityId: row.id,
        summaryEn: `${input.direction === 'IN' ? 'Gave' : 'Took'} ${amount} ${input.direction === 'IN' ? 'to' : 'from'} ${teller.fullNameEn}'s till`,
        summaryAr: `${input.direction === 'IN' ? 'تزويد' : 'سحب'} ${amount} ${input.direction === 'IN' ? 'لصندوق' : 'من صندوق'} ${teller.fullNameAr}`,
        actor,
      },
      tx,
    );
    return row;
  }, db);
}

export interface CountInput {
  tellerId: string;
  lines: {
    currency: string;
    counted: bigint;
    /** What stays with the teller for the next period. Defaults to all of it. */
    kept?: bigint | null;
    /** Overrides the carried opening — only for a teller's very first count. */
    opening?: bigint | null;
    denominations?: string | null;
  }[];
  note?: string | null;
}

/**
 * Records a count, and books whatever it found.
 *
 * The expected figures are worked out again here, inside the transaction,
 * rather than taken from the screen: the screen is a picture of a minute ago,
 * and a deal recorded since would otherwise fall between this count and the
 * next.
 */
export async function record(input: CountInput, actor: Actor, db: DbClient = prisma) {
  requireCounter(actor);
  if (input.tellerId === actor.id) {
    throw errors.precondition(
      'Nobody counts their own till — the count is the second pair of eyes',
      'errors.countOwnTill',
    );
  }

  return withTransaction(async (tx) => {
    const now = new Date();
    const books = await preview(input.tellerId, actor, tx, now);
    if (books.onShift) {
      throw errors.precondition(
        'This teller is on a shift — count them by the handover that closes it',
        'errors.tillOnShift',
      );
    }

    const branchId = books.teller.branchId ?? actor.branchId;
    if (!branchId) throw errors.precondition('No branch is assigned', 'errors.noBranch');

    // Every currency the books know about has to be counted, even to zero; a
    // currency left off would carry its money silently out of the record.
    const given = new Map(input.lines.map((line) => [line.currency.toUpperCase(), line]));
    for (const line of books.lines) {
      if (line.expected !== 0n && !given.has(line.currency)) {
        throw errors.validation(
          [{ path: `lines.${line.currency}`, message: 'Not counted' }],
          `${line.currency} was not counted`,
        );
      }
    }

    const expectedOf = new Map(books.lines.map((line) => [line.currency, line]));
    const firstCount = books.previous === null;

    const lines = [...given.entries()].map(([currency, entry]) => {
      const base = expectedOf.get(currency) ?? {
        currency,
        opening: 0n,
        received: 0n,
        paid: 0n,
        toppedUp: 0n,
        drawn: 0n,
        expected: 0n,
      };
      // The opening carries from the last count and is not anybody's to change
      // after that; only the first count has no last one to carry from.
      const opening = firstCount && entry.opening != null ? entry.opening : base.opening;
      const expected = opening + base.received - base.paid + base.toppedUp - base.drawn;
      return {
        currencyCode: currency,
        opening,
        received: base.received,
        paid: base.paid,
        toppedUp: base.toppedUp,
        drawn: base.drawn,
        expected,
        counted: entry.counted,
        difference: expected - entry.counted,
        kept: entry.kept ?? entry.counted,
        denominations: entry.denominations ?? null,
      };
    });

    for (const line of lines) {
      if (line.counted < 0n || line.kept < 0n || line.kept > line.counted) {
        throw errors.validation(
          [{ path: `lines.${line.currencyCode}`, message: 'Out of range' }],
          `What stays with the teller cannot be more than was counted (${line.currencyCode})`,
        );
      }
    }

    const day = await currentOpenDay(branchId, tx, actor);
    const reference = await nextReference('CNT', tx);

    const count = await tx.tillCount.create({
      data: {
        reference,
        tellerId: input.tellerId,
        branchId,
        businessDayId: day.id,
        periodStart: books.periodStart,
        periodEnd: now,
        countedById: actor.id,
        note: input.note ?? null,
        lines: { create: lines },
      },
      include: { lines: true },
    });

    for (const line of lines) {
      const gap = line.difference;
      if (gap === 0n) continue;

      await ensureDifferenceDrawer(line.currencyCode, tx);
      const size = gap > 0n ? gap : -gap;

      // The same two movements the shift close makes: the office is worth what
      // it was a moment ago, only the name of the place the cash sits under
      // has changed.
      await drawers.move(
        [
          {
            currency: line.currencyCode,
            kind: 'CASH',
            owner: drawers.TREASURY,
            direction: gap > 0n ? 'OUT' : 'IN',
            amount: size,
            reason: 'DIFFERENCE',
            businessDayId: day.id,
            note: reference,
          },
          {
            currency: line.currencyCode,
            kind: 'DIFFERENCE',
            owner: drawers.TREASURY,
            direction: gap > 0n ? 'IN' : 'OUT',
            amount: size,
            reason: 'DIFFERENCE',
            businessDayId: day.id,
            note: reference,
          },
        ],
        actor,
        tx,
      );

      await tx.discrepancy.create({
        data: {
          tillCountId: count.id,
          tellerId: input.tellerId,
          businessDayId: day.id,
          currencyCode: line.currencyCode,
          amount: gap,
          status: 'OPEN',
        },
      });
    }

    const found = lines.filter((line) => line.difference !== 0n);
    await audit.record(
      {
        action: 'CREATE',
        module: 'exchange',
        entityType: 'TillCount',
        entityId: count.id,
        summaryEn: `Counted ${books.teller.fullNameEn}'s till (${reference}) — ${found.length === 0 ? 'exact' : `${found.length} difference(s)`}`,
        summaryAr: `جرد صندوق ${books.teller.fullNameAr} (${reference}) — ${found.length === 0 ? 'مطابق' : `${found.length} فرق`}`,
        actor,
        after: {
          lines: lines.map(
            (line) =>
              `${line.currencyCode} expected ${toDecimalString(line.expected, 2)} counted ${toDecimalString(line.counted, 2)}`,
          ),
        },
      },
      tx,
    );

    if (found.length > 0)
      log.warn('Till count found differences', { reference, found: found.length });
    return count;
  }, db);
}

/** Recent counts, newest first — everybody's for a counter, one's own otherwise. */
export async function list(
  actor: Actor,
  input: { tellerId?: string | null; limit?: number } = {},
  db: DbClient = prisma,
) {
  const counter = actor.permissions.includes('treasury.handover.manage');
  return db.tillCount.findMany({
    where: counter ? (input.tellerId ? { tellerId: input.tellerId } : {}) : { tellerId: actor.id },
    orderBy: { createdAt: 'desc' },
    take: input.limit ?? 30,
    include: {
      teller: { select: { id: true, fullNameEn: true, fullNameAr: true } },
      countedBy: { select: { fullNameEn: true, fullNameAr: true } },
      lines: true,
    },
  });
}

/** One count in full — for the teller it is about, or someone who counts. */
export async function getCount(id: string, actor: Actor, db: DbClient = prisma) {
  const count = await db.tillCount.findUnique({
    where: { id },
    include: {
      teller: { select: { id: true, fullNameEn: true, fullNameAr: true } },
      countedBy: { select: { fullNameEn: true, fullNameAr: true } },
      lines: { orderBy: { currencyCode: 'asc' } },
    },
  });
  if (!count) throw errors.notFound('TillCount', id);
  if (count.tellerId !== actor.id && !actor.permissions.includes('treasury.handover.manage')) {
    throw errors.forbidden('treasury.handover.manage');
  }
  return count;
}
