import 'server-only';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import * as drawers from '@/modules/drawers/drawer.service';
import * as audit from '@/modules/audit/audit.service';
import type { Actor } from './shift.service';

/**
 * Ruling on a difference, once the cameras have been watched.
 *
 * Nothing here is automatic, and that is the point. At the moment a gap is
 * found it belongs to nobody: the day's operations and the recordings have not
 * been reviewed, and a system that guessed would be assigning blame by
 * arithmetic. So it waits in the differences balance, costing the office
 * nothing on paper, until a person decides.
 *
 * The decision is where the money finally lands:
 *
 *   - **Miscount** — it turned up. The gap goes back to the till and the
 *     office never lost anything.
 *   - **Charged to the teller** — it becomes a debt they owe. Still no loss:
 *     an asset changed its name from cash to a receivable.
 *   - **Company loss** — the office absorbs it, and the result takes it **on
 *     the day of the decision**, not the day of the discovery. That is what
 *     "suspended" means, and it is why the ledger reports how old the oldest
 *     open one is: this account is only honest while somebody is still looking.
 */

const log = createLogger('treasury:discrepancy');

export const RESOLUTIONS = ['MISCOUNT', 'CHARGED_TO_TELLER', 'COMPANY_LOSS'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

const DIFFERENCE: drawers.DrawerKind = 'DIFFERENCE';
const RECEIVABLE: drawers.DrawerKind = 'RECEIVABLE';

function requireManager(actor: Actor): void {
  if (!actor.permissions.includes('treasury.handover.manage')) {
    throw errors.forbidden('treasury.handover.manage');
  }
}

export async function resolve(
  id: string,
  input: { resolution: Resolution; note?: string | null },
  actor: Actor,
  db: DbClient = prisma,
) {
  requireManager(actor);

  return withTransaction(async (tx) => {
    const difference = await tx.discrepancy.findUnique({
      where: { id },
      include: { teller: true, shift: { select: { reference: true } } },
    });
    if (!difference) throw errors.notFound('Discrepancy', id);
    if (difference.status !== 'OPEN') {
      throw errors.conflict('This difference has already been settled', 'errors.differenceResolved');
    }

    const { currencyCode, amount } = difference;
    // Positive is a shortage: the differences balance is holding it. Negative is
    // a surplus, and the balance is short by that much.
    const size = amount > 0n ? amount : -amount;
    const shortage = amount > 0n;

    /*
     * Every outcome empties the differences balance of this gap. What differs is
     * where it goes, and only one of the three touches what the office is worth.
     */
    if (input.resolution === 'MISCOUNT') {
      // The money was there all along; it goes back where it belongs.
      await drawers.move(
        [
          {
            currency: currencyCode,
            kind: DIFFERENCE,
            owner: drawers.TREASURY,
            direction: shortage ? 'OUT' : 'IN',
            amount: size,
            reason: 'DIFFERENCE',
            note: `${difference.shift.reference} — miscount`,
          },
          {
            currency: currencyCode,
            kind: 'CASH',
            owner: drawers.TREASURY,
            direction: shortage ? 'IN' : 'OUT',
            amount: size,
            reason: 'DIFFERENCE',
            note: `${difference.shift.reference} — miscount`,
          },
        ],
        actor,
        tx,
      );
    } else if (input.resolution === 'CHARGED_TO_TELLER') {
      if (!shortage) {
        throw errors.precondition(
          'A surplus cannot be charged to anyone — nobody owes money that was found',
          'errors.surplusNotChargeable',
        );
      }

      await ensureReceivable(difference.tellerId, currencyCode, tx);

      // Cash became a claim on a person. The office is worth the same until it
      // decides that claim is worthless.
      await drawers.move(
        [
          {
            currency: currencyCode,
            kind: DIFFERENCE,
            owner: drawers.TREASURY,
            direction: 'OUT',
            amount: size,
            reason: 'DIFFERENCE',
            note: `${difference.shift.reference} — charged`,
          },
          {
            currency: currencyCode,
            kind: RECEIVABLE,
            owner: drawers.tellerOwner(difference.tellerId),
            direction: 'IN',
            amount: size,
            reason: 'DIFFERENCE',
            note: `${difference.shift.reference} — charged`,
          },
        ],
        actor,
        tx,
      );
    } else {
      /*
       * Written off. One-sided on purpose: the money left the company and
       * nothing came back, so the office is worth less by exactly this much —
       * which is what a loss is. Recorded as a counting correction so the
       * ledger keeps it out of the trading result and shows it on its own.
       */
      await drawers.move(
        [
          {
            currency: currencyCode,
            kind: DIFFERENCE,
            owner: drawers.TREASURY,
            direction: shortage ? 'OUT' : 'IN',
            amount: size,
            reason: 'FUNDING',
            category: 'CORRECTION',
            note: `${difference.shift.reference} — written off`,
          },
        ],
        actor,
        tx,
      );
    }

    const resolved = await tx.discrepancy.update({
      where: { id },
      data: {
        status: 'RESOLVED',
        resolution: input.resolution,
        resolutionNote: input.note?.trim() || null,
        resolvedById: actor.id,
        resolvedAt: new Date(),
      },
    });

    await audit.record(
      {
        action: 'UPDATE',
        module: 'exchange',
        entityType: 'Discrepancy',
        entityId: id,
        summaryEn: `Settled a ${shortage ? 'shortage' : 'surplus'} of ${toDecimalString(size, 2)} ${currencyCode} from ${difference.shift.reference} as ${input.resolution}`,
        summaryAr: `فصل في ${shortage ? 'نقص' : 'زيادة'} ${toDecimalString(size, 2)} ${currencyCode} من ${difference.shift.reference}`,
        actor,
        after: { resolution: input.resolution, teller: difference.teller.username },
      },
      tx,
    );

    log.info('Discrepancy resolved', { id, resolution: input.resolution });
    return resolved;
  }, db);
}

/**
 * The teller pays what they were charged.
 *
 * Cash whether it came out of their pocket or out of wages the office kept —
 * both leave the till holding money it would otherwise not have, which is the
 * only thing the books can see and the only thing that is true of both.
 */
export async function settleDebt(
  input: { tellerId: string; currency: string; amount: bigint; note?: string | null },
  actor: Actor,
  db: DbClient = prisma,
) {
  requireManager(actor);

  if (input.amount <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }

  return withTransaction(async (tx) => {
    const owed = await tx.drawer.findUnique({
      where: {
        ownerKey_currencyCode_kind: {
          ownerKey: drawers.tellerOwner(input.tellerId),
          currencyCode: input.currency,
          kind: RECEIVABLE,
        },
      },
    });
    if (!owed || owed.balance < input.amount) {
      throw errors.precondition(
        'That is more than this teller owes',
        'errors.moreThanOwed',
      );
    }

    await drawers.move(
      [
        {
          currency: input.currency,
          kind: RECEIVABLE,
          owner: drawers.tellerOwner(input.tellerId),
          direction: 'OUT',
          amount: input.amount,
          reason: 'DIFFERENCE',
          note: input.note ?? null,
        },
        {
          currency: input.currency,
          kind: 'CASH',
          owner: drawers.TREASURY,
          direction: 'IN',
          amount: input.amount,
          reason: 'DIFFERENCE',
          note: input.note ?? null,
        },
      ],
      actor,
      tx,
    );

    const teller = await tx.user.findUniqueOrThrow({ where: { id: input.tellerId } });

    await audit.record(
      {
        action: 'UPDATE',
        module: 'exchange',
        entityType: 'User',
        entityId: input.tellerId,
        summaryEn: `${teller.fullNameEn} settled ${toDecimalString(input.amount, 2)} ${input.currency} of what they owed`,
        summaryAr: `سدّد ${teller.fullNameAr} ${toDecimalString(input.amount, 2)} ${input.currency} مما عليه`,
        actor,
      },
      tx,
    );

    return { settled: input.amount.toString() };
  }, db);
}

async function ensureReceivable(tellerId: string, currency: string, tx: DbClient): Promise<void> {
  const owner = drawers.tellerOwner(tellerId);
  const existing = await tx.drawer.findUnique({
    where: { ownerKey_currencyCode_kind: { ownerKey: owner, currencyCode: currency, kind: RECEIVABLE } },
  });
  if (existing) return;

  const [teller, row] = await Promise.all([
    tx.user.findUniqueOrThrow({ where: { id: tellerId } }),
    tx.currency.findUniqueOrThrow({ where: { code: currency } }),
  ]);

  await tx.drawer.create({
    data: {
      ownerKey: owner,
      tellerId,
      currencyCode: currency,
      kind: RECEIVABLE,
      nameEn: `${teller.fullNameEn} — owes`,
      nameAr: `ذمّة — ${teller.fullNameAr}`,
      allowNegative: false,
      sortOrder: row.sortOrder * 10 + 4,
    },
  });
}

/** What each teller still owes, for the manager to chase. */
export async function outstandingDebts(db: DbClient = prisma) {
  return db.drawer.findMany({
    where: { kind: RECEIVABLE, balance: { gt: 0n } },
    include: { teller: { select: { id: true, fullNameEn: true, fullNameAr: true } } },
    orderBy: { balance: 'desc' },
  });
}
