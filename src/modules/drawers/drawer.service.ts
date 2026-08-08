import 'server-only';
import { prisma, withTransaction, type DbClient, type Tx } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import * as audit from '@/modules/audit/audit.service';

/**
 * The drawers.
 *
 * What the branch holds, one row per currency, and the only thing in this system
 * that says how much money there is. This replaced a double-entry ledger: the
 * counter does two things, and both are a movement between two drawers, so the
 * machinery that proved every entry balanced was answering a question nobody
 * here asks any more.
 *
 * What survived from it is the part that still earns its keep. Balances are
 * never computed from a read and written back — that loses money under two
 * tellers working at once — and every change leaves a movement row, so a balance
 * can always be explained rather than merely asserted.
 */

const log = createLogger('drawers');

export interface Actor {
  id: string;
  name: string;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string;
  permissions?: string[];
}

export type MovementReason = 'TRANSACTION' | 'FUNDING' | 'REVERSAL';

export interface Movement {
  currency: string;
  direction: 'IN' | 'OUT';
  amount: bigint;
  reason: MovementReason;
  transactionId?: string | null;
  note?: string | null;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listDrawers(db: DbClient = prisma) {
  return db.drawer.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    include: { currency: { select: { symbol: true, decimals: true, kind: true } } },
  });
}

export async function getDrawer(currency: string, db: DbClient = prisma) {
  const drawer = await db.drawer.findUnique({
    where: { currencyCode: currency },
    include: { currency: { select: { symbol: true, decimals: true, kind: true } } },
  });
  if (!drawer) throw errors.notFound('Drawer', currency);
  return drawer;
}

/** True when the drawer can pay this out right now. */
export async function canPay(
  currency: string,
  amount: bigint,
  db: DbClient = prisma,
): Promise<{ ok: boolean; balance: bigint }> {
  const drawer = await db.drawer.findUnique({ where: { currencyCode: currency } });
  if (!drawer || !drawer.isActive) return { ok: false, balance: 0n };
  return { ok: drawer.allowNegative || drawer.balance >= amount, balance: drawer.balance };
}

// ---------------------------------------------------------------------------
// Moving money
// ---------------------------------------------------------------------------

/**
 * Applies one movement and records it. Must run inside a transaction.
 *
 * The balance is changed with an atomic increment rather than read-modify-write.
 * Two tellers settling at the same instant would otherwise both read the old
 * balance and the second write would erase the first — money vanishing with no
 * error anywhere. The check that a drawer can cover a payment happens against
 * the value the increment actually produced, which is the only value that was
 * ever true.
 */
async function applyMovement(tx: Tx, movement: Movement, actor: Actor): Promise<bigint> {
  const drawer = await tx.drawer.findUnique({ where: { currencyCode: movement.currency } });
  if (!drawer) throw errors.notFound('Drawer', movement.currency);
  if (!drawer.isActive) {
    throw errors.precondition(
      `The ${movement.currency} drawer is closed`,
      'errors.drawerInactive',
      { currency: movement.currency },
    );
  }
  if (movement.amount <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }

  const delta = movement.direction === 'IN' ? movement.amount : -movement.amount;

  const updated = await tx.drawer.update({
    where: { id: drawer.id },
    data: { balance: { increment: delta } },
    select: { balance: true },
  });

  if (updated.balance < 0n && !drawer.allowNegative) {
    // Rolls the whole enclosing transaction back, so nothing is half-applied.
    throw errors.insufficientFunds(
      `The ${movement.currency} drawer`,
      `${toDecimalString(drawer.balance, 2)} ${movement.currency}`,
      `${toDecimalString(movement.amount, 2)} ${movement.currency}`,
    );
  }

  await tx.drawerMovement.create({
    data: {
      drawerId: drawer.id,
      direction: movement.direction,
      amount: movement.amount,
      balanceAfter: updated.balance,
      reason: movement.reason,
      transactionId: movement.transactionId ?? null,
      note: movement.note ?? null,
      createdById: actor.id,
    },
  });

  return updated.balance;
}

/**
 * Applies a set of movements together, or none of them.
 *
 * Both counter tools move exactly two drawers — one in, one out — and a state
 * where only one landed is the failure worth designing against. The caller
 * passes both and gets atomicity for free.
 */
export async function move(
  movements: Movement[],
  actor: Actor,
  db: DbClient = prisma,
): Promise<Record<string, bigint>> {
  if (movements.length === 0) return {};

  return withTransaction(async (tx) => {
    const balances: Record<string, bigint> = {};

    // Ordered by currency so two concurrent settlements touching the same pair
    // always take the rows in the same sequence, and cannot deadlock waiting on
    // each other's locks.
    const ordered = [...movements].sort((a, b) => a.currency.localeCompare(b.currency));

    for (const movement of ordered) {
      balances[movement.currency] = await applyMovement(tx, movement, actor);
    }

    return balances;
  }, db);
}

/**
 * Adds to or takes from a drawer outside any customer transaction — a manager
 * loading the till in the morning, or lifting the takings out of it.
 *
 * Audited loudly and separately from trading: this is the one way money enters
 * or leaves the branch without a customer on the other side of it, so it is
 * exactly what a manager reviewing the day needs to be able to pick out.
 */
export async function fund(
  input: { currency: string; direction: 'IN' | 'OUT'; amount: bigint; note?: string | null },
  actor: Actor,
  db: DbClient = prisma,
): Promise<bigint> {
  // Checked here and not only at the route. Every other way money moves has a
  // customer on the other side and a receipt to match; this one has neither, so
  // it is the last thing that should depend on a single caller remembering to
  // guard it.
  if (!actor.permissions?.includes('exchange.drawer.manage')) {
    throw errors.forbidden('exchange.drawer.manage');
  }

  const balances = await move(
    [
      {
        currency: input.currency,
        direction: input.direction,
        amount: input.amount,
        reason: 'FUNDING',
        note: input.note ?? null,
      },
    ],
    actor,
    db,
  );

  const balance = balances[input.currency]!;
  const verb = input.direction === 'IN' ? 'Added to' : 'Taken from';
  const verbAr = input.direction === 'IN' ? 'إيداع في' : 'سحب من';

  await audit.record({
    action: 'UPDATE',
    module: 'exchange',
    entityType: 'Drawer',
    entityId: input.currency,
    summaryEn: `${verb} the ${input.currency} drawer: ${toDecimalString(input.amount, 2)} — balance ${toDecimalString(balance, 2)}${input.note ? ` (${input.note})` : ''}`,
    summaryAr: `${verbAr} صندوق ${input.currency}: ${toDecimalString(input.amount, 2)} — الرصيد ${toDecimalString(balance, 2)}${input.note ? ` (${input.note})` : ''}`,
    actor,
    after: { currency: input.currency, amount: input.amount.toString(), balance: balance.toString() },
  });

  log.info('Drawer funded', {
    currency: input.currency,
    direction: input.direction,
    balance: balance.toString(),
  });

  return balance;
}

/** The movements behind a drawer's balance, newest first. */
export async function history(
  currency: string,
  options: { limit?: number } = {},
  db: DbClient = prisma,
) {
  const drawer = await db.drawer.findUnique({ where: { currencyCode: currency } });
  if (!drawer) throw errors.notFound('Drawer', currency);

  return db.drawerMovement.findMany({
    where: { drawerId: drawer.id },
    orderBy: { createdAt: 'desc' },
    take: Math.min(options.limit ?? 50, 200),
    include: {
      transaction: { select: { id: true, reference: true, type: true } },
      createdBy: { select: { fullNameEn: true, fullNameAr: true } },
    },
  });
}

/**
 * Re-derives every balance from its movements and reports any disagreement.
 *
 * Nothing should ever be able to change a balance except `applyMovement`, which
 * writes both together — so this must always come back clean. It exists because
 * "should never happen" is a claim worth being able to check on demand rather
 * than believe.
 */
export async function verifyBalances(db: DbClient = prisma) {
  const drawers = await db.drawer.findMany({ orderBy: { sortOrder: 'asc' } });
  const results = [];

  for (const drawer of drawers) {
    const sums = await db.drawerMovement.groupBy({
      by: ['direction'],
      where: { drawerId: drawer.id },
      _sum: { amount: true },
    });

    const inflow = sums.find((s) => s.direction === 'IN')?._sum.amount ?? 0n;
    const outflow = sums.find((s) => s.direction === 'OUT')?._sum.amount ?? 0n;
    const derived = inflow - outflow;

    results.push({
      currency: drawer.currencyCode,
      balance: drawer.balance,
      derived,
      agrees: derived === drawer.balance,
    });
  }

  const disagreements = results.filter((r) => !r.agrees);
  if (disagreements.length > 0) {
    log.error('Drawer balances disagree with their movements', { disagreements });
  }

  return { drawers: results, ok: disagreements.length === 0 };
}
