import 'server-only';
import { prisma, withTransaction, type DbClient, type Tx } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import type { FundingCategory, DrawerKind } from './funding-categories';
import { toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import * as audit from '@/modules/audit/audit.service';
import { currentOpenDay } from '@/modules/exchange/business-day.service';

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

/**
 * Who holds a drawer.
 *
 * The office's money lives at two levels: the treasury, which the manager runs,
 * and one drawer per teller, handed over and counted at the start and end of a
 * shift. Until the shift machinery exists every drawer is the treasury's, and
 * every caller here says so by omission — the default below.
 *
 * The key is a single string because it is half of the drawer's unique
 * identity, and a nullable owner id cannot be: PostgreSQL treats NULLs as
 * distinct, so two treasury tills of the same currency would both be accepted.
 */
export const TREASURY = 'TREASURY';

export function tellerOwner(userId: string): string {
  return `teller:${userId}`;
}

export function isTellerOwner(ownerKey: string): boolean {
  return ownerKey.startsWith('teller:');
}

/** The user id inside a teller's owner key, or null for the treasury. */
export function ownerTellerId(ownerKey: string): string | null {
  return isTellerOwner(ownerKey) ? ownerKey.slice('teller:'.length) : null;
}

/*
 * The kinds live in `./funding-categories` and are re-exported here.
 *
 * `CASH` is the till. `BROKER` is what the bank broker owes the branch. And
 * `CORRESPONDENT` is the running account with the remittance company, which is
 * the one that spends much of its life negative: sending a remittance means
 * owing them until it is settled.
 */
export { DRAWER_KINDS, type DrawerKind } from './funding-categories';

export interface Actor {
  id: string;
  name: string;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string;
  permissions?: string[];
  /** Which branch's day a funding movement belongs to. */
  branchId?: string | null;
}

/**
 * Why a drawer changed.
 *
 * `HANDOVER` is money crossing between the treasury and a teller, and
 * `DIFFERENCE` is a count that did not match being parked until somebody rules
 * on it. Neither is funding and neither may be counted as such: funding is
 * money entering or leaving the company, while these move it between pockets of
 * the same company and change what the office is worth by nothing.
 */
export type MovementReason =
  | 'TRANSACTION'
  | 'FUNDING'
  | 'REVERSAL'
  | 'HANDOVER'
  | 'DIFFERENCE';

/*
 * The funding categories live in `./funding-categories` and are re-exported
 * here. They had to move because the screen that records a funding movement
 * offers them, and a client component cannot import this file.
 */
export {
  FUNDING_CATEGORIES,
  isFundingCategory,
  type FundingCategory,
} from './funding-categories';

export interface Movement {
  currency: string;
  /** Defaults to the till, which is what the overwhelming majority of movements are. */
  kind?: DrawerKind;
  /** Whose drawer. Defaults to the treasury, which is every drawer for now. */
  owner?: string;
  direction: 'IN' | 'OUT';
  amount: bigint;
  reason: MovementReason;
  /** Why, for funding. Meaningless on anything else, which says why by being it. */
  category?: FundingCategory | null;
  /**
   * Which of the broker's accounts this went through.
   *
   * Not a balance of its own — the office's claim is on the broker, not on an
   * account — but the instruction that left for him named one, and this is
   * where that survives long enough to be checked against his statement.
   */
  account?: string | null;
  transactionId?: string | null;
  /** The day this belongs to. Every movement of money belongs to one. */
  businessDayId?: string | null;
  note?: string | null;
}

/** How a drawer is named in an error the operator will actually read. */
function describe(currency: string, kind: DrawerKind): string {
  if (kind === 'BROKER') return `The ${currency} broker balance`;
  if (kind === 'CORRESPONDENT') return `The ${currency} correspondent balance`;
  return `The ${currency} drawer`;
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
    // The treasury's first, then each teller's, so the office's own money is
    // never buried among the drawers it lent out.
    orderBy: [{ ownerKey: 'asc' }, { sortOrder: 'asc' }],
    include: {
      currency: { select: { symbol: true, decimals: true, kind: true } },
      teller: { select: { fullNameEn: true, fullNameAr: true } },
    },
  });
}

export async function getDrawer(
  currency: string,
  kind: DrawerKind = 'CASH',
  db: DbClient = prisma,
  owner: string = TREASURY,
) {
  const drawer = await db.drawer.findUnique({
    where: { ownerKey_currencyCode_kind: { ownerKey: owner, currencyCode: currency, kind } },
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
  owner: string = TREASURY,
): Promise<{ ok: boolean; balance: bigint }> {
  const drawer = await db.drawer.findUnique({
    where: { ownerKey_currencyCode_kind: { ownerKey: owner, currencyCode: currency, kind } },
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
/**
 * Opens a teller's drawer for a currency and kind, returning null for anyone
 * else. Idempotent: two movements in the same transaction find the first one.
 */
export async function ensureTellerDrawer(
  ownerKey: string,
  currency: string,
  kind: DrawerKind,
  tx: DbClient,
) {
  const tellerId = ownerTellerId(ownerKey);
  if (!tellerId) return null;

  const [teller, currencyRow] = await Promise.all([
    tx.user.findUniqueOrThrow({ where: { id: tellerId } }),
    tx.currency.findUniqueOrThrow({ where: { code: currency } }),
  ]);

  return tx.drawer.create({
    data: {
      ownerKey,
      tellerId,
      currencyCode: currency,
      kind,
      nameEn: `${teller.fullNameEn} — ${currencyRow.nameEn}`,
      nameAr: `${teller.fullNameAr} — ${currencyRow.nameAr}`,
      /*
       * A teller's drawer never runs short: it holds what was handed to them,
       * and the server refuses to pay out more than that. The one exception is
       * what they owe, which only ever grows by a manager's decision.
       */
      allowNegative: false,
      sortOrder:
        currencyRow.sortOrder * 10 +
        (kind === 'BROKER' ? 1 : kind === 'CORRESPONDENT' ? 2 : kind === 'RECEIVABLE' ? 4 : 0),
    },
  });
}

async function applyMovement(tx: Tx, movement: Movement, actor: Actor): Promise<bigint> {
  const kind = movement.kind ?? 'CASH';
  const owner = movement.owner ?? TREASURY;
  const drawer =
    (await tx.drawer.findUnique({
      where: { ownerKey_currencyCode_kind: { ownerKey: owner, currencyCode: movement.currency, kind } },
    })) ??
    /*
     * A teller's drawer is opened the moment they hold something in it. It is
     * not a configured thing the way the treasury's is — a teller who buys
     * dollars across the counter needs somewhere to put them, and refusing the
     * trade because nobody thought to create the container first would be
     * refusing it for a reason the teller cannot act on. It ends the shift at
     * zero like every other one.
     *
     * The treasury's drawers are never conjured. A movement against one that
     * does not exist is a misconfiguration, and should say so.
     */
    (await ensureTellerDrawer(owner, movement.currency, kind, tx));

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
      movement.currency,
      kind,
      toDecimalString(drawer.balance, 2),
      toDecimalString(movement.amount, 2),
    );
  }

  await tx.drawerMovement.create({
    data: {
      drawerId: drawer.id,
      direction: movement.direction,
      amount: movement.amount,
      balanceAfter: updated.balance,
      reason: movement.reason,
      category: movement.category ?? null,
      account: movement.account ?? null,
      transactionId: movement.transactionId ?? null,
      businessDayId: movement.businessDayId ?? null,
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
    /**
     * Why. Required, because the daily result is measured by telling an owner's
     * deposit apart from a day's takings, and a default would silently pick one
     * of those answers for a manager who never chose.
     */
    category: FundingCategory;
    /** Which broker account, when the money is moving through him. */
    account?: string | null;
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

  /*
   * Funding belongs to a day, like everything else that moves money.
   *
   * Required rather than optional: the day's result is measured by what moved
   * inside it, and a deposit belonging to no day is money the ledger can see in
   * the balance and cannot explain.
   *
   * The session that is open, not the one matching today's date. A manager
   * counting the till at one in the morning is still working the day he opened,
   * and money he puts in then belongs to that day's result rather than to a day
   * nobody has opened yet.
   */
  const branchId = actor.branchId;
  if (!branchId) {
    throw errors.precondition('No branch is assigned', 'errors.noBranch');
  }
  const day = await currentOpenDay(branchId, db);

  const kind = input.kind ?? 'CASH';
  const movement: Movement = {
    currency: input.currency,
    kind,
    direction: input.direction,
    amount: input.amount,
    reason: 'FUNDING',
    category: input.category,
    businessDayId: day.id,
    account: input.account ?? null,
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
      category: input.category,
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
    /** Whose drawer this is. The treasury's unless a teller is named. */
    owner?: string;
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
    where: {
      ownerKey_currencyCode_kind: {
        ownerKey: input.owner ?? TREASURY,
        currencyCode: input.currency,
        kind: input.kind,
      },
    },
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
      ownerKey: input.owner ?? TREASURY,
      // Kept beside the key so a drawer can be joined to its holder. The two
      // are set together here and nowhere else, which is what stops them
      // disagreeing about whose drawer this is.
      tellerId: ownerTellerId(input.owner ?? TREASURY),
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
  options: { limit?: number; kind?: DrawerKind; owner?: string } = {},
  db: DbClient = prisma,
) {
  const kind = options.kind ?? 'CASH';
  const drawer = await db.drawer.findUnique({
    where: {
      ownerKey_currencyCode_kind: {
        ownerKey: options.owner ?? TREASURY,
        currencyCode: currency,
        kind,
      },
    },
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
 * What went through the broker, account by account, for checking his statement.
 *
 * Not a set of balances. The office's claim is on the broker as a whole — it
 * keeps no books per account, and inventing them here would create a second
 * place that claims to know how much money exists. What this answers is the
 * question his statement actually raises: "you say this account moved this
 * much; do my instructions agree?"
 *
 * So each account reports what left through it, what came back, and the net —
 * a figure to compare, not a balance to trust.
 */
export async function brokerActivity(
  options: { currency?: string; from?: Date; to?: Date } = {},
  db: DbClient = prisma,
) {
  const brokerDrawers = await db.drawer.findMany({
    where: { kind: 'BROKER', ...(options.currency ? { currencyCode: options.currency } : {}) },
    include: { currency: { select: { decimals: true } } },
    orderBy: { sortOrder: 'asc' },
  });

  const results = [];

  for (const drawer of brokerDrawers) {
    const movements = await db.drawerMovement.findMany({
      where: {
        drawerId: drawer.id,
        ...(options.from || options.to
          ? { createdAt: { ...(options.from ? { gte: options.from } : {}), ...(options.to ? { lte: options.to } : {}) } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        transaction: { select: { id: true, reference: true, status: true } },
        createdBy: { select: { fullNameEn: true, fullNameAr: true } },
      },
    });

    // Grouped in memory rather than by the database: the set is one branch's
    // movements over a period, and doing it here keeps the ordering and the
    // rounding identical to the list shown beneath the totals.
    const byAccount = new Map<string, { out: bigint; in: bigint; count: number }>();

    for (const movement of movements) {
      // Everything that went through him, including anything instructed before
      // the account was recorded — filed under a name the manager can see.
      const key = movement.account ?? '—';
      const entry = byAccount.get(key) ?? { out: 0n, in: 0n, count: 0 };
      if (movement.direction === 'OUT') entry.out += movement.amount;
      else entry.in += movement.amount;
      entry.count += 1;
      byAccount.set(key, entry);
    }

    results.push({
      currency: drawer.currencyCode,
      decimals: drawer.currency.decimals,
      balance: drawer.balance,
      accounts: [...byAccount.entries()]
        .map(([account, totals]) => ({ account, ...totals, net: totals.out - totals.in }))
        .sort((a, b) => (b.out - b.in > a.out - a.in ? 1 : -1)),
      movements,
    });
  }

  return results;
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
      // Identified the way the database identifies it. Currency and kind alone
      // stopped being unique the moment a teller could hold shekels too, and a
      // caller keying these results on that pair would show one person's
      // disagreement against another person's drawer.
      drawerId: drawer.id,
      owner: drawer.ownerKey,
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
