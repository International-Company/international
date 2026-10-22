import 'server-only';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import { nextReference } from '@/modules/sequence/reference';
import { currentOpenDay } from '@/modules/exchange/business-day.service';
import * as drawers from '@/modules/drawers/drawer.service';
import * as audit from '@/modules/audit/audit.service';
import * as shifts from './shift.service';

/**
 * التسليم — money crossing between the treasury and a teller.
 *
 * The office's money lives at two levels, and this is the only door between
 * them. It is a document rather than a transfer, and that is the whole design:
 * a transfer is one person's assertion about what they handed over, while a
 * handover is only complete once the other person has counted it and said so
 * under their own name.
 *
 * So the sender declares and the receiver counts. The treasury declares a
 * float; the teller counts it. The teller declares what he is returning; the
 * treasury counts that. **The two are never the same person** — one account
 * signing both halves would leave a document that proves nothing, and this
 * refuses it.
 *
 * Nothing moves until they agree. A count that disagrees leaves the document in
 * dispute with **both balances untouched**, which is the only state from which
 * the truth can still be worked out: the money is still wherever it actually
 * is, and the manager can take the bag back and issue another rather than
 * unwinding a movement that should never have happened.
 */

const log = createLogger('treasury:handover');

export const HANDOVER_DIRECTIONS = ['TO_TELLER', 'TO_TREASURY'] as const;
export type HandoverDirection = (typeof HANDOVER_DIRECTIONS)[number];

export const HANDOVER_STATUSES = ['PENDING', 'CONFIRMED', 'DISPUTED', 'CANCELLED'] as const;
export type HandoverStatus = (typeof HANDOVER_STATUSES)[number];

/**
 * Whether a line is counted or merely acknowledged.
 *
 * Cash changes hands and is counted, so a difference can arise. An allocated
 * line — USDT today, the broker and the correspondent later — never physically
 * moves: what moves is the right to draw on it. There is nothing to miscount,
 * so there is no difference to find.
 */
export const LINE_NATURES = ['COUNTED', 'ALLOCATED'] as const;
export type LineNature = (typeof LINE_NATURES)[number];

export interface Actor {
  id: string;
  name: string;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string;
  permissions: string[];
  branchId?: string | null;
}

export interface HandoverLineInput {
  currency: string;
  kind?: drawers.DrawerKind;
  nature?: LineNature;
  amount: bigint;
}

// ---------------------------------------------------------------------------
// Declaring one
// ---------------------------------------------------------------------------

/**
 * Which side of the document a person is on.
 *
 * The treasury declares floats and counts returns; the teller declares returns
 * and counts floats. Rather than a permission per verb — which would let the
 * verbs drift from the people — each side holds one permission and the document
 * decides what that means in each direction.
 */
function requireSide(actor: Actor, side: 'TREASURY' | 'TELLER'): void {
  const permission = side === 'TREASURY' ? 'treasury.handover.manage' : 'treasury.handover.receive';
  if (!actor.permissions.includes(permission)) throw errors.forbidden(permission);
}

export async function create(
  input: {
    direction: HandoverDirection;
    tellerId: string;
    lines: HandoverLineInput[];
    note?: string | null;
  },
  actor: Actor,
  db: DbClient = prisma,
) {
  // The declarer is the sender: the treasury sends a float, the teller sends
  // back what they hold.
  requireSide(actor, input.direction === 'TO_TELLER' ? 'TREASURY' : 'TELLER');

  if (input.direction === 'TO_TREASURY' && input.tellerId !== actor.id) {
    throw errors.forbidden('treasury.handover.manage');
  }

  if (input.lines.length === 0) {
    throw errors.precondition('A handover needs at least one line', 'errors.handoverEmpty');
  }
  if (input.lines.some((line) => line.amount <= 0n)) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }

  const branchId = actor.branchId;
  if (!branchId) throw errors.precondition('No branch is assigned', 'errors.noBranch');

  return withTransaction(async (tx) => {
    const teller = await tx.user.findUnique({ where: { id: input.tellerId } });
    if (!teller) throw errors.notFound('User', input.tellerId);
    if (teller.status !== 'ACTIVE') {
      throw errors.precondition('That account is not active', 'errors.userInactive');
    }

    /*
     * One at a time, per teller.
     *
     * Two open handovers for the same person would make "confirm the handover"
     * ambiguous at the counter, where the two people are standing together with
     * a bag between them and no interest in choosing from a list.
     */
    const open = await tx.handover.findFirst({
      where: { tellerId: input.tellerId, status: { in: ['PENDING', 'DISPUTED'] } },
      select: { reference: true },
    });
    if (open) {
      throw errors.conflict(
        `${open.reference} is still open for this teller`,
        'errors.handoverAlreadyOpen',
        { reference: open.reference },
      );
    }

    /*
     * Nobody declares what they are not holding.
     *
     * Checked here rather than at the count, and the difference is two people
     * standing at a counter. Declared without it, the shortfall surfaces only
     * when the teller has already counted the bag and pressed confirm — the
     * whole handover is refused, correctly, but the discovery happens at the
     * worst moment and lands on the person who did nothing wrong.
     *
     * Only the counted lines. An allocated one is an acknowledgement of a
     * balance that is not moving, so there is nothing to be short of.
     */
    const sender = input.direction === 'TO_TELLER' ? drawers.TREASURY : drawers.tellerOwner(input.tellerId);

    for (const line of input.lines) {
      if ((line.nature ?? 'COUNTED') !== 'COUNTED') continue;

      const held = await tx.drawer.findUnique({
        where: {
          ownerKey_currencyCode_kind: {
            ownerKey: sender,
            currencyCode: line.currency,
            kind: line.kind ?? 'CASH',
          },
        },
        select: { balance: true, allowNegative: true },
      });

      const balance = held?.balance ?? 0n;
      if (!held?.allowNegative && balance < line.amount) {
        throw errors.insufficientFunds(
          line.currency,
          line.kind ?? 'CASH',
          toDecimalString(balance, 2),
          toDecimalString(line.amount, 2),
        );
      }
    }

    const day = await currentOpenDay(branchId, tx, actor);
    const reference = await nextReference('HND', tx);

    const handover = await tx.handover.create({
      data: {
        reference,
        direction: input.direction,
        status: 'PENDING',
        tellerId: input.tellerId,
        branchId,
        businessDayId: day.id,
        createdById: actor.id,
        note: input.note ?? null,
        lines: {
          create: input.lines.map((line) => ({
            currencyCode: line.currency.toUpperCase(),
            kind: line.kind ?? 'CASH',
            nature: line.nature ?? 'COUNTED',
            amount: line.amount,
          })),
        },
      },
      include: { lines: true },
    });

    /*
     * The teller's drawers are opened here, not at confirmation.
     *
     * Confirmation happens with both people standing at the counter and should
     * do one thing: move the money. Discovering there that a drawer has to be
     * created first — and that creating one needs a permission the teller does
     * not hold — would stop the handover at the worst possible moment.
     */
    for (const line of handover.lines) {
      await ensureTellerDrawer(input.tellerId, line.currencyCode, line.kind, actor, tx);
    }

    await audit.record(
      {
        action: 'CREATE',
        module: 'exchange',
        entityType: 'Handover',
        entityId: handover.id,
        summaryEn: `Declared handover ${reference} ${input.direction === 'TO_TELLER' ? 'to' : 'from'} ${teller.fullNameEn}`,
        summaryAr: `تسليم ${reference} ${input.direction === 'TO_TELLER' ? 'إلى' : 'من'} ${teller.fullNameAr}`,
        actor,
        after: {
          direction: input.direction,
          lines: handover.lines.map((line) => `${line.currencyCode} ${toDecimalString(line.amount, 2)}`),
        },
      },
      tx,
    );

    return handover;
  }, db);
}

/** Opens a teller's drawer for a currency and kind if they have none yet. */
async function ensureTellerDrawer(
  tellerId: string,
  currency: string,
  kind: string,
  actor: Actor,
  tx: DbClient,
): Promise<void> {
  const owner = drawers.tellerOwner(tellerId);
  const existing = await tx.drawer.findUnique({
    where: { ownerKey_currencyCode_kind: { ownerKey: owner, currencyCode: currency, kind } },
  });
  if (existing) return;

  await drawers.ensureTellerDrawer(owner, currency, kind as drawers.DrawerKind, tx);
  log.info('Opened a teller drawer', { tellerId, currency, kind });
}

// ---------------------------------------------------------------------------
// Counting it
// ---------------------------------------------------------------------------

/**
 * The receiver counts, and the money moves — or it does not move at all.
 *
 * Both sides of every line are applied in one database transaction, so a
 * handover cannot leave money in neither drawer or in both. If any counted
 * figure disagrees with what was declared, nothing moves and the document goes
 * to dispute.
 */
export async function confirm(
  id: string,
  counted: { currency: string; kind?: drawers.DrawerKind; amount: bigint }[],
  actor: Actor,
  db: DbClient = prisma,
) {
  return withTransaction(async (tx) => {
    const handover = await tx.handover.findUnique({
      where: { id },
      include: { lines: true, teller: true },
    });
    if (!handover) throw errors.notFound('Handover', id);

    if (handover.status !== 'PENDING') {
      throw errors.conflict('This handover is not awaiting a count', 'errors.handoverNotPending');
    }

    // The receiver is the other side from the declarer.
    requireSide(actor, handover.direction === 'TO_TELLER' ? 'TELLER' : 'TREASURY');

    if (handover.direction === 'TO_TELLER' && handover.tellerId !== actor.id) {
      throw errors.forbidden('treasury.handover.receive');
    }

    /*
     * Never the person who declared it.
     *
     * The whole value of this document is that two people looked at the same
     * money. One account doing both halves produces a record that says nothing,
     * and it is exactly what a single person with both screens would do.
     */
    if (handover.createdById === actor.id) {
      throw errors.precondition(
        'The person who declared a handover cannot also count it',
        'errors.handoverSamePerson',
      );
    }

    const byKey = new Map(
      counted.map((entry) => [`${entry.currency.toUpperCase()}:${entry.kind ?? 'CASH'}`, entry.amount]),
    );

    let disputed = false;
    const settled = handover.lines.map((line) => {
      // An allocated line has nothing to count: it is acknowledged as declared.
      const amount =
        line.nature === 'ALLOCATED'
          ? line.amount
          : (byKey.get(`${line.currencyCode}:${line.kind}`) ?? null);

      if (amount === null) {
        throw errors.precondition(
          `${line.currencyCode} was not counted`,
          'errors.handoverLineNotCounted',
          { currency: line.currencyCode },
        );
      }
      if (amount < 0n) {
        throw errors.precondition('A count cannot be negative', 'errors.amountNotPositive');
      }
      if (amount !== line.amount) disputed = true;

      return { line, amount };
    });

    for (const { line, amount } of settled) {
      await tx.handoverLine.update({ where: { id: line.id }, data: { countedAmount: amount } });
    }

    if (disputed) {
      await tx.handover.update({ where: { id }, data: { status: 'DISPUTED' } });

      await audit.record(
        {
          action: 'SECURITY',
          module: 'exchange',
          entityType: 'Handover',
          entityId: id,
          summaryEn: `Handover ${handover.reference} disputed — the count did not match`,
          summaryAr: `خلاف على التسليم ${handover.reference} — العدّ لم يطابق`,
          actor,
          after: Object.fromEntries(
            settled
              .filter(({ line, amount }) => amount !== line.amount)
              .map(({ line, amount }) => [
                line.currencyCode,
                `declared ${toDecimalString(line.amount, 2)}, counted ${toDecimalString(amount, 2)}`,
              ]),
          ),
        },
        tx,
      );

      log.warn('Handover disputed', { reference: handover.reference });
      return { ...handover, status: 'DISPUTED' as HandoverStatus, moved: false };
    }

    /*
     * Agreed between the two of them. Now the books get their turn.
     *
     * A closing handover reconciles the teller to what was counted *before* the
     * money moves — see `reconcileForClosing`, and note that the order is what
     * makes a surplus possible at all.
     */
    if (handover.direction === 'TO_TREASURY') {
      await shifts.reconcileForClosing(
        { ...handover, businessDayId: handover.businessDayId },
        new Map(settled.map(({ line, amount }) => [`${line.currencyCode}:${line.kind}`, amount])),
        actor,
        tx,
      );
    }

    /*
     * Every line moves both balances, and all of them in this one transaction —
     * so the money is in exactly one place whatever happens next.
     */
    const treasury = drawers.TREASURY;
    const teller = drawers.tellerOwner(handover.tellerId);
    const [from, to] = handover.direction === 'TO_TELLER' ? [treasury, teller] : [teller, treasury];

    await drawers.move(
      settled.flatMap(({ line, amount }) => [
        {
          currency: line.currencyCode,
          kind: line.kind as drawers.DrawerKind,
          owner: from,
          direction: 'OUT' as const,
          amount,
          reason: 'HANDOVER' as const,
          businessDayId: handover.businessDayId,
          note: handover.reference,
        },
        {
          currency: line.currencyCode,
          kind: line.kind as drawers.DrawerKind,
          owner: to,
          direction: 'IN' as const,
          amount,
          reason: 'HANDOVER' as const,
          businessDayId: handover.businessDayId,
          note: handover.reference,
        },
      ]),
      actor,
      tx,
    );

    const confirmed = await tx.handover.update({
      where: { id },
      data: { status: 'CONFIRMED', confirmedById: actor.id, confirmedAt: new Date() },
    });

    /*
     * Taking a float starts the shift and giving one back ends it. There is no
     * separate button for either, because there is no separate act: a teller
     * who has the bag is working, and one who has handed it back is not.
     */
    if (handover.direction === 'TO_TELLER') {
      await shifts.openFromHandover(
        { ...handover, businessDayId: handover.businessDayId },
        tx,
      );
    } else {
      await shifts.closeFromHandover(handover, actor, tx);
    }

    await audit.record(
      {
        action: 'POST',
        module: 'exchange',
        entityType: 'Handover',
        entityId: id,
        summaryEn: `Handover ${handover.reference} counted and confirmed by ${actor.name}`,
        summaryAr: `عُدّ وأُكّد التسليم ${handover.reference} بواسطة ${actor.name}`,
        actor,
      },
      tx,
    );

    log.info('Handover confirmed', { reference: handover.reference });
    return { ...confirmed, moved: true };
  }, db);
}

// ---------------------------------------------------------------------------
// Calling it off
// ---------------------------------------------------------------------------

/**
 * Cancels a handover that has not moved anything.
 *
 * This is what the manager does with a bag that came up short: takes it back
 * whole and issues another. Nothing has to be unwound because a disputed or
 * pending handover has moved no money — which is exactly why it was built to
 * move none until both sides agree.
 */
export async function cancel(id: string, reason: string, actor: Actor, db: DbClient = prisma) {
  requireSide(actor, 'TREASURY');

  if (reason.trim().length < 3) {
    throw errors.validation([{ path: 'reason', message: 'Say why' }]);
  }

  return withTransaction(async (tx) => {
    const handover = await tx.handover.findUnique({ where: { id } });
    if (!handover) throw errors.notFound('Handover', id);

    if (handover.status === 'CONFIRMED') {
      throw errors.conflict(
        'This handover has already moved the money — reverse it with another handover',
        'errors.handoverAlreadyConfirmed',
      );
    }
    if (handover.status === 'CANCELLED') {
      throw errors.conflict('This handover is already cancelled', 'errors.handoverCancelled');
    }

    const cancelled = await tx.handover.update({
      where: { id },
      data: { status: 'CANCELLED', cancelReason: reason.trim() },
    });

    await audit.record(
      {
        action: 'CANCEL',
        module: 'exchange',
        entityType: 'Handover',
        entityId: id,
        summaryEn: `Cancelled handover ${handover.reference}: ${reason.trim()}`,
        summaryAr: `إلغاء التسليم ${handover.reference}: ${reason.trim()}`,
        actor,
      },
      tx,
    );

    return cancelled;
  }, db);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const WITH_PEOPLE = {
  lines: true,
  teller: { select: { id: true, fullNameEn: true, fullNameAr: true } },
  createdBy: { select: { fullNameEn: true, fullNameAr: true } },
  confirmedBy: { select: { fullNameEn: true, fullNameAr: true } },
} as const;

/** Everything still waiting on somebody, plus a little settled history. */
export async function list(
  filter: { tellerId?: string; status?: HandoverStatus[]; limit?: number } = {},
  db: DbClient = prisma,
) {
  return db.handover.findMany({
    where: {
      ...(filter.tellerId ? { tellerId: filter.tellerId } : {}),
      ...(filter.status ? { status: { in: filter.status } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(filter.limit ?? 25, 100),
    include: WITH_PEOPLE,
  });
}

/** What this person is expected to count right now, if anything. */
export async function awaiting(actor: Actor, db: DbClient = prisma) {
  const isTreasury = actor.permissions.includes('treasury.handover.manage');

  return db.handover.findMany({
    where: {
      status: 'PENDING',
      // The treasury counts returns; a teller counts their own float.
      ...(isTreasury
        ? { direction: 'TO_TREASURY' }
        : { direction: 'TO_TELLER', tellerId: actor.id }),
      // Never your own declaration: you cannot count what you handed over.
      createdById: { not: actor.id },
    },
    orderBy: { createdAt: 'asc' },
    include: WITH_PEOPLE,
  });
}

export async function getById(id: string, db: DbClient = prisma) {
  const handover = await db.handover.findUnique({ where: { id }, include: WITH_PEOPLE });
  if (!handover) throw errors.notFound('Handover', id);
  return handover;
}
