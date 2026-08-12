import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import * as audit from '@/modules/audit/audit.service';
import { baseCurrency, ratesOn } from './cutoff.service';
import { valued } from './ledger.service';

/**
 * What a teller actually gave the office — in three numbers, never one.
 *
 * The margin on his tickets is the number a counter naturally produces, and on
 * its own it is close to useless:
 *
 *     |                        | teller A | teller B |
 *     |------------------------|----------|----------|
 *     | margin on his deals    |    500   |    350   |
 *     | his count differences  |   −300   |      0   |
 *     | prices he gave away    |   −200   |    −20   |
 *     | **what he gave**       |    **0** |  **330** |
 *
 * By the first line alone A is far ahead. In truth he gave the office nothing,
 * and the two figures that say so are ones he controls as directly as the
 * first: how carefully he counts, and how readily he shades a price.
 *
 * So this returns all three and their sum, and the screen shows all three. A
 * single "score" would be the same mistake with more arithmetic in front of it.
 *
 * Everything is converted to the base currency at the cut-off rates for the end
 * of the period, because a teller who trades in three currencies cannot be
 * compared with one who trades in one otherwise.
 */

const log = createLogger('ledger:teller');

export interface Actor {
  id: string;
  name: string;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string;
  permissions: string[];
  branchId?: string | null;
}

export interface TellerResult {
  tellerId: string;
  fullNameEn: string;
  fullNameAr: string;
  /** Margin written on the tickets he struck, valued in the base currency. */
  margin: bigint;
  deals: number;
  /**
   * What his counts came to. Negative when he was short — the sign is the
   * office's, not his, so the three numbers can simply be added.
   */
  differences: bigint;
  shortages: number;
  surpluses: number;
  /** What the prices he asked for and was granted gave away. Never positive. */
  concessions: bigint;
  concessionCount: number;
  /** The three, added. */
  net: bigint;
  /** Still owed from differences charged to him, valued in the base currency. */
  owed: bigint;
}

/**
 * The three numbers for every teller who worked in a window of dates.
 *
 * Whoever traded, was counted, or was granted a price — not whoever holds a
 * role, because a list padded with people who did nothing is a list nobody
 * reads to the bottom.
 */
export async function tellerResults(
  branchId: string,
  from: Date,
  to: Date,
  db: DbClient = prisma,
): Promise<{
  base: string;
  from: string;
  to: string;
  rows: TellerResult[];
  /** Currencies held with no cut-off rate, left out of every figure above. */
  unpriced: string[];
}> {
  const [base, rates] = await Promise.all([baseCurrency(db), ratesOn(to, db)]);

  /*
   * A currency the manager has not priced is not worth one-for-one.
   *
   * This used to fall back to a rate of 1.00, so a dollar margin was counted as
   * a shekel and nothing said so. `livePosition` treats the same condition as
   * serious — it reports the currency and refuses to close the day on it — and
   * a figure that decides how a person is judged has no business being quieter
   * about it. So the amount is left out and the currency is named.
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

  const [deals, differences, concessions, owed, people] = await Promise.all([
    db.transaction.findMany({
      where: {
        branchId,
        createdAt: { gte: from, lte: to },
        // A reversed deal earned nothing.
        status: { in: ['POSTED', 'PENDING_TRANSFER'] },
        /*
         * And the reversal itself is not anybody's trading. It is a live row
         * carrying the negated margin, stamped with whoever pressed reverse and
         * with the two currencies swapped — so counted here it charged the
         * manager for the teller's mistake, and valued the loss at the wrong
         * currency's rate on top of that.
         */
        reversalOfId: null,
      },
      select: { createdById: true, profitAmount: true, toCurrency: true },
    }),
    db.discrepancy.findMany({
      // Through the shift, which is what carries the branch. Filtering only on
      // the date put every branch's shortages into every branch's figures.
      where: { createdAt: { gte: from, lte: to }, shift: { branchId } },
      select: { tellerId: true, amount: true, currencyCode: true },
    }),
    db.priceException.findMany({
      where: {
        branchId,
        status: 'USED',
        usedAt: { gte: from, lte: to },
        concededAmount: { not: null },
        // Reverse the deal and the teller loses its margin; he must not keep
        // being charged for a price he gave away on a trade that no longer
        // stands.
        usedByTransaction: { status: { not: 'REVERSED' } },
      },
      select: { requestedById: true, concededAmount: true, concededCurrency: true },
    }),
    // What is still owed is a standing figure, not something that happened in
    // the window, so it is read as it is now.
    db.drawer.findMany({
      where: {
        kind: 'RECEIVABLE',
        balance: { gt: 0n },
        tellerId: { not: null },
        teller: { branchId },
      },
      select: { tellerId: true, balance: true, currencyCode: true },
    }),
    db.user.findMany({
      where: { isSystem: false },
      select: { id: true, fullNameEn: true, fullNameAr: true },
    }),
  ]);

  const byId = new Map<string, TellerResult>();
  const named = new Map(people.map((person) => [person.id, person]));

  const rowFor = (tellerId: string): TellerResult => {
    const existing = byId.get(tellerId);
    if (existing) return existing;
    const person = named.get(tellerId);
    const fresh: TellerResult = {
      tellerId,
      fullNameEn: person?.fullNameEn ?? tellerId,
      fullNameAr: person?.fullNameAr ?? tellerId,
      margin: 0n,
      deals: 0,
      differences: 0n,
      shortages: 0,
      surpluses: 0,
      concessions: 0n,
      concessionCount: 0,
      net: 0n,
      owed: 0n,
    };
    byId.set(tellerId, fresh);
    return fresh;
  };

  for (const deal of deals) {
    const row = rowFor(deal.createdById);
    row.margin += worth(deal.profitAmount, deal.toCurrency);
    row.deals += 1;
  }

  for (const difference of differences) {
    const row = rowFor(difference.tellerId);
    /*
     * A discrepancy stores expected − counted, so a shortage is positive. The
     * office lost it, so it enters here negative — which is what lets the three
     * numbers be added rather than each needing its own sign rule explained on
     * the screen.
     */
    row.differences -= worth(difference.amount, difference.currencyCode);
    if (difference.amount > 0n) row.shortages += 1;
    else if (difference.amount < 0n) row.surpluses += 1;
  }

  for (const concession of concessions) {
    const row = rowFor(concession.requestedById);
    row.concessions -= worth(concession.concededAmount ?? 0n, concession.concededCurrency ?? base);
    row.concessionCount += 1;
  }

  for (const debt of owed) {
    if (!debt.tellerId) continue;
    // Only for somebody already on the list: a debt alone is not a period's work.
    const row = byId.get(debt.tellerId);
    if (row) row.owed += worth(debt.balance, debt.currencyCode);
  }

  const rows = [...byId.values()]
    .map((row) => ({ ...row, net: row.margin + row.differences + row.concessions }))
    .sort((a, b) => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0));

  return {
    base,
    from: from.toISOString(),
    to: to.toISOString(),
    rows,
    unpriced: [...unpriced],
  };
}

// ---------------------------------------------------------------------------
// A word from the management
// ---------------------------------------------------------------------------

export const NOTE_TONES = ['PRAISE', 'NOTE', 'WARNING'] as const;
export type NoteTone = (typeof NOTE_TONES)[number];

export interface NoteInput {
  tellerId: string;
  body: string;
  tone?: NoteTone;
  shiftId?: string | null;
  discrepancyId?: string | null;
}

/**
 * Writes something down for one member of staff, and lets them read it.
 *
 * Audited like any other act of management, because it is one: a written
 * warning that can appear in a file without a trail of who put it there is
 * worse than no written warning.
 */
export async function writeNote(input: NoteInput, actor: Actor, db: DbClient = prisma) {
  /*
   * Its own permission, and a manage-level one.
   *
   * This was gated on `ledger.view` — the right to *read* what the office is
   * worth. Anyone who could open the ledger could therefore file a formal
   * warning against anyone, including their own manager, and the only check
   * standing in the way was "not yourself". Writing in a person's file is an
   * act of management, not a side effect of being allowed to read a figure.
   */
  if (!actor.permissions.includes('staff.note.write')) throw errors.forbidden('staff.note.write');

  const body = input.body.trim();
  if (body.length < 2) {
    throw errors.precondition('Write something', 'errors.noteEmpty');
  }
  if (input.tellerId === actor.id) {
    throw errors.precondition(
      'A note is written to somebody else',
      'errors.noteToSelf',
    );
  }

  const teller = await db.user.findUnique({ where: { id: input.tellerId } });
  if (!teller) throw errors.notFound('User', input.tellerId);

  const note = await db.staffNote.create({
    data: {
      tellerId: input.tellerId,
      body,
      tone: input.tone ?? 'NOTE',
      shiftId: input.shiftId ?? null,
      discrepancyId: input.discrepancyId ?? null,
      createdById: actor.id,
    },
  });

  await audit.record(
    {
      action: 'CREATE',
      module: 'users',
      entityType: 'StaffNote',
      entityId: note.id,
      summaryEn: `Wrote a ${note.tone.toLowerCase()} to ${teller.fullNameEn}`,
      summaryAr: `كتب ملاحظة إلى ${teller.fullNameAr}`,
      actor,
      after: { tone: note.tone, body },
    },
    db,
  );

  log.info('Staff note written', { tellerId: input.tellerId, tone: note.tone });
  return note;
}

/** Everything written to or about one person, newest first. */
export async function notesFor(tellerId: string, limit = 20, db: DbClient = prisma) {
  return db.staffNote.findMany({
    where: { tellerId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 100),
    include: {
      createdBy: { select: { fullNameEn: true, fullNameAr: true } },
      shift: { select: { reference: true } },
    },
  });
}

/** What this person has not opened yet. */
export async function unreadFor(tellerId: string, db: DbClient = prisma) {
  return db.staffNote.findMany({
    where: { tellerId, readAt: null },
    orderBy: { createdAt: 'asc' },
    include: { createdBy: { select: { fullNameEn: true, fullNameAr: true } } },
  });
}

/**
 * Marks them read, by the person they are about and nobody else.
 *
 * Not an agreement — only proof of delivery, so "nobody told me" has an answer
 * either way.
 */
export async function markNotesRead(tellerId: string, actor: Actor, db: DbClient = prisma) {
  if (actor.id !== tellerId) throw errors.forbidden('self');
  const { count } = await db.staffNote.updateMany({
    where: { tellerId, readAt: null },
    data: { readAt: new Date() },
  });
  return count;
}
