import 'server-only';
import { prisma, withTransaction, type DbClient, type Tx } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import * as audit from '@/modules/audit/audit.service';

/**
 * The drawers.
 *
 * What the branch holds, and the only thing in this system that says how much
 * money there is. This replaced a double-entry ledger: the counter does two
 * things, and both are a movement between two drawers, so the machinery that
 * proved every entry balanced was answering a question nobody here asks any
 * more.
 *
 * One row per currency *and kind*. A bank balance is the same object as a till —
 * money you pay out of and must not overdraw — so it is a second drawer rather
 * than a second concept, and everything below works on it unchanged.
 *
 * What survived from the ledger is the part that still earns its keep. Balances
 * are never computed from a read and written back — that loses money under two
 * tellers working at once — and every change leaves a movement row, so a balance
 * can always be explained rather than merely asserted.
 */

const log = createLogger('drawers');

/** Where the money physically is. */
export const DRAWER_KINDS = ['CASH', 'BROKER'] as const;
export type DrawerKind = (typeof DRAWER_KINDS)[number];

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
  /** Defaults to the till, which is what the overwhelming majority of movements are. */
  kind?: DrawerKind;
  direction: 'IN' | 'OUT';
  amount: bigint;
  reason: MovementReason;
  transactionId?: string | null;
  note?: string | null;
}

/** How a drawer is named in an error the operator will actually read. */
function describe(currency: string, kind: DrawerKind): string {
  return kind === 'BROKER' ? `The ${currency} bank balance` : `The ${currency} drawer`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Every drawer, in display order.
 *
 * Closed ones are hidden by default because nothing may be traded from them —
 * but the screen that closes a drawer has to keep showing it, or closing one
 * would make it vanish with no way back. That screen asks for all of them.
 */
export async function listDrawers(
  options: { includeInactive?: boolean } = {},
  db: DbClient = prisma,
) {
  return db.drawer.findMany({
    where: options.includeInactive ? {} : { isActive: true },
    orderBy: { sortOrder: 'asc' },
    include: { currency: { select: { symbol: true, decimals: true, kind: true } } },
  });
}

export async function getDrawer(
  currency: string,
  kind: DrawerKind = 'CASH',
  db: DbClient = prisma,
) {
  const drawer = await db.drawer.findUnique({
    where: { currencyCode_kind: { currencyCode: currency, kind } },
    include: { currency: { select: { symbol: true, decimals: true, kind: true } } },
  });
  if (!drawer) throw errors.notFound('Drawer', `${currency} ${kind}`);
  return drawer;
}

/** True when the drawer can pay this out right now. */
export async function canPay(
  currency: string,
  amount: bigint,
  kind: DrawerKind = 'CASH',
  db: DbClient = prisma,
): Promise<{ ok: boolean; balance: bigint }> {
  const drawer = await db.drawer.findUnique({
    where: { currencyCode_kind: { currencyCode: currency, kind } },
  });
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
  const kind = movement.kind ?? 'CASH';
  const drawer = await tx.drawer.findUnique({
    where: { currencyCode_kind: { currencyCode: movement.currency, kind } },
  });
  if (!drawer) throw errors.notFound('Drawer', `${movement.currency} ${kind}`);
  if (!drawer.isActive) {
    throw errors.precondition(
      `${describe(movement.currency, kind)} is closed`,
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
      describe(movement.currency, kind),
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

    // Ordered by the drawer's full identity so two concurrent settlements
    // touching the same drawers always take the rows in the same sequence, and
    // cannot deadlock waiting on each other's locks. Currency alone stopped
    // being that identity the moment a currency could have two drawers.
    const ordered = [...movements].sort((a, b) => balanceKey(a).localeCompare(balanceKey(b)));

    for (const movement of ordered) {
      balances[balanceKey(movement)] = await applyMovement(tx, movement, actor);
    }

    return balances;
  }, db);
}

/** How a drawer is keyed in the balances a `move` returns. */
export function balanceKey(drawer: { currency: string; kind?: DrawerKind }): string {
  return `${drawer.currency}:${drawer.kind ?? 'CASH'}`;
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
  input: {
    currency: string;
    kind?: DrawerKind;
    direction: 'IN' | 'OUT';
    amount: bigint;
    note?: string | null;
  },
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

  const kind = input.kind ?? 'CASH';
  const movement: Movement = {
    currency: input.currency,
    kind,
    direction: input.direction,
    amount: input.amount,
    reason: 'FUNDING',
    note: input.note ?? null,
  };

  const balances = await move([movement], actor, db);

  const balance = balances[balanceKey(movement)]!;
  const verb = input.direction === 'IN' ? 'Added to' : 'Taken from';
  const verbAr = input.direction === 'IN' ? 'إيداع في' : 'سحب من';
  const place = kind === 'BROKER' ? `${input.currency} bank balance` : `${input.currency} drawer`;
  const placeAr = kind === 'BROKER' ? `رصيد بنك ${input.currency}` : `صندوق ${input.currency}`;

  await audit.record({
    action: 'UPDATE',
    module: 'exchange',
    entityType: 'Drawer',
    entityId: `${input.currency}:${kind}`,
    summaryEn: `${verb} the ${place}: ${toDecimalString(input.amount, 2)} — balance ${toDecimalString(balance, 2)}${input.note ? ` (${input.note})` : ''}`,
    summaryAr: `${verbAr} ${placeAr}: ${toDecimalString(input.amount, 2)} — الرصيد ${toDecimalString(balance, 2)}${input.note ? ` (${input.note})` : ''}`,
    actor,
    after: {
      currency: input.currency,
      kind,
      amount: input.amount.toString(),
      balance: balance.toString(),
    },
  });

  log.info('Drawer funded', {
    currency: input.currency,
    kind,
    direction: input.direction,
    balance: balance.toString(),
  });

  return balance;
}

/**
 * Opens a drawer for a currency and kind that has none.
 *
 * One per pair is the whole model, so this fills a gap rather than adding a
 * second account: the pair is the drawer's identity everywhere else in the
 * system, and two rows sharing it would make every lookup ambiguous.
 */
export async function createDrawer(
  input: {
    currency: string;
    kind: DrawerKind;
    nameEn: string;
    nameAr: string;
    lowBalanceThreshold?: bigint;
    allowNegative?: boolean;
  },
  actor: Actor,
  db: DbClient = prisma,
) {
  if (!actor.permissions?.includes('exchange.drawer.manage')) {
    throw errors.forbidden('exchange.drawer.manage');
  }

  const currency = await db.currency.findUnique({ where: { code: input.currency } });
  if (!currency) throw errors.notFound('Currency', input.currency);

  const existing = await db.drawer.findUnique({
    where: { currencyCode_kind: { currencyCode: input.currency, kind: input.kind } },
  });
  if (existing) {
    throw errors.conflict(
      `${describe(input.currency, input.kind)} already exists`,
      'errors.drawerExists',
      { currency: input.currency },
    );
  }
  if (input.nameEn.trim().length === 0 || input.nameAr.trim().length === 0) {
    throw errors.validation([{ path: 'nameEn', message: 'A drawer needs a name' }]);
  }

  const drawer = await db.drawer.create({
    data: {
      currencyCode: input.currency,
      kind: input.kind,
      nameEn: input.nameEn.trim(),
      nameAr: input.nameAr.trim(),
      lowBalanceThreshold: input.lowBalanceThreshold ?? 0n,
      allowNegative: input.allowNegative ?? false,
      // Beside its own currency's other drawer, so the screen stays ordered by
      // currency rather than by creation date.
      sortOrder: currency.sortOrder * 10 + (input.kind === 'BROKER' ? 1 : 0),
    },
  });

  await audit.record({
    action: 'CREATE',
    module: 'exchange',
    entityType: 'Drawer',
    entityId: `${input.currency}:${input.kind}`,
    summaryEn: `Opened ${describe(input.currency, input.kind).toLowerCase()}`,
    summaryAr: `فتح ${input.kind === 'BROKER' ? `رصيد بنك ${input.currency}` : `صندوق ${input.currency}`}`,
    actor,
    after: { currency: input.currency, kind: input.kind, nameEn: drawer.nameEn },
  });

  log.info('Drawer opened', { currency: input.currency, kind: input.kind });

  return drawer;
}

/**
 * Removes a drawer that never held anything.
 *
 * Only one that has recorded no movement and holds no money can go. A drawer
 * with movements is the explanation for balances that have already been
 * reported and receipts already printed — deleting it would either orphan that
 * history or take it down with the row, and the second is worse. Anything with
 * a past is closed instead, which stops it trading and keeps the record.
 */
export async function deleteDrawer(
  currency: string,
  kind: DrawerKind,
  actor: Actor,
  db: DbClient = prisma,
): Promise<void> {
  if (!actor.permissions?.includes('exchange.drawer.manage')) {
    throw errors.forbidden('exchange.drawer.manage');
  }

  const drawer = await getDrawer(currency, kind, db);

  if (drawer.balance !== 0n) {
    throw errors.precondition(
      `${describe(currency, kind)} still holds ${toDecimalString(drawer.balance, 2)} ${currency}`,
      'errors.drawerNotEmpty',
      { currency, balance: toDecimalString(drawer.balance, 2) },
    );
  }

  const movements = await db.drawerMovement.count({ where: { drawerId: drawer.id } });
  if (movements > 0) {
    throw errors.precondition(
      `${describe(currency, kind)} has ${movements} movement(s) behind it — close it instead`,
      'errors.drawerHasHistory',
      { currency, count: String(movements) },
    );
  }

  // A monitored wallet counts its holdings towards a drawer. Removing the
  // drawer under it would leave the wallet pointing at nothing.
  const wallets = await db.wallet.count({ where: { drawerId: drawer.id } });
  if (wallets > 0) {
    throw errors.precondition(
      `${describe(currency, kind)} is linked to ${wallets} wallet(s)`,
      'errors.drawerHasWallets',
      { currency, count: String(wallets) },
    );
  }

  await db.drawer.delete({ where: { id: drawer.id } });

  await audit.record({
    action: 'DELETE',
    module: 'exchange',
    entityType: 'Drawer',
    entityId: `${currency}:${kind}`,
    summaryEn: `Removed ${describe(currency, kind).toLowerCase()}, which had never been used`,
    summaryAr: `حذف ${kind === 'BROKER' ? `رصيد بنك ${currency}` : `صندوق ${currency}`} ولم يكن قد استُعمل قط`,
    actor,
    before: { currency, kind, nameEn: drawer.nameEn },
  });

  log.info('Drawer removed', { currency, kind });
}

/**
 * Editing a drawer — what it is called, when to warn, whether it is open.
 *
 * Not its balance. The balance is the sum of the movements beneath it, and
 * typing over it would leave the drawer disagreeing with its own history —
 * `verifyBalances()` would start reporting a discrepancy that no movement
 * explains, and the one number in this system that says how much money exists
 * would become an opinion. Money moves through `fund`, which leaves a record of
 * why.
 */
export async function updateDrawer(
  currency: string,
  kind: DrawerKind,
  patch: {
    nameEn?: string;
    nameAr?: string;
    lowBalanceThreshold?: bigint;
    allowNegative?: boolean;
    isActive?: boolean;
  },
  actor: Actor,
  db: DbClient = prisma,
) {
  // Guarded here as well as at the route, for the same reason funding is: this
  // decides whether the counter can trade a currency at all.
  if (!actor.permissions?.includes('exchange.drawer.manage')) {
    throw errors.forbidden('exchange.drawer.manage');
  }

  const drawer = await getDrawer(currency, kind, db);

  if (patch.nameEn !== undefined && patch.nameEn.trim().length === 0) {
    throw errors.validation([{ path: 'nameEn', message: 'A drawer needs a name' }]);
  }
  if (patch.nameAr !== undefined && patch.nameAr.trim().length === 0) {
    throw errors.validation([{ path: 'nameAr', message: 'A drawer needs a name' }]);
  }
  if (patch.lowBalanceThreshold !== undefined && patch.lowBalanceThreshold < 0n) {
    throw errors.validation([
      { path: 'lowBalanceThreshold', message: 'A warning threshold cannot be negative' },
    ]);
  }

  /*
   * Closing a drawer that still holds money would hide it: the balance stays on
   * the row, stops appearing anywhere, and still counts in any total derived
   * from the table. Empty it first, through a movement that says where it went.
   */
  if (patch.isActive === false && drawer.balance !== 0n) {
    throw errors.precondition(
      `${describe(currency, kind)} still holds ${toDecimalString(drawer.balance, 2)} ${currency}`,
      'errors.drawerNotEmpty',
      { currency, balance: toDecimalString(drawer.balance, 2) },
    );
  }

  const updated = await db.drawer.update({
    where: { id: drawer.id },
    data: {
      ...(patch.nameEn !== undefined ? { nameEn: patch.nameEn.trim() } : {}),
      ...(patch.nameAr !== undefined ? { nameAr: patch.nameAr.trim() } : {}),
      ...(patch.lowBalanceThreshold !== undefined
        ? { lowBalanceThreshold: patch.lowBalanceThreshold }
        : {}),
      ...(patch.allowNegative !== undefined ? { allowNegative: patch.allowNegative } : {}),
      ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
    },
  });

  await audit.record({
    action: 'UPDATE',
    module: 'exchange',
    entityType: 'Drawer',
    entityId: `${currency}:${kind}`,
    summaryEn: `Updated ${describe(currency, kind).toLowerCase()}`,
    summaryAr: `تعديل ${kind === 'BROKER' ? `رصيد بنك ${currency}` : `صندوق ${currency}`}`,
    actor,
    before: {
      nameEn: drawer.nameEn,
      nameAr: drawer.nameAr,
      lowBalanceThreshold: drawer.lowBalanceThreshold.toString(),
      allowNegative: drawer.allowNegative,
      isActive: drawer.isActive,
    },
    after: {
      nameEn: updated.nameEn,
      nameAr: updated.nameAr,
      lowBalanceThreshold: updated.lowBalanceThreshold.toString(),
      allowNegative: updated.allowNegative,
      isActive: updated.isActive,
    },
  });

  log.info('Drawer updated', { currency, kind });

  return updated;
}

/** The movements behind a drawer's balance, newest first. */
export async function history(
  currency: string,
  options: { limit?: number; kind?: DrawerKind } = {},
  db: DbClient = prisma,
) {
  const kind = options.kind ?? 'CASH';
  const drawer = await db.drawer.findUnique({
    where: { currencyCode_kind: { currencyCode: currency, kind } },
  });
  if (!drawer) throw errors.notFound('Drawer', `${currency} ${kind}`);

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
      kind: drawer.kind as DrawerKind,
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
