import 'server-only';
import type { Prisma } from '@prisma/client';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { dayBounds, formatDayKey } from '@/core/time/day-key';
import type { Actor } from './transaction.service';
import {
  categoryOf,
  TRANSACTION_TYPES,
  type Category,
  type TransactionType,
} from './transaction-types';

/**
 * What each person at the counter did, by kind of work.
 *
 * ## Three kinds, not five types
 *
 * The office talks about its work in three words — صرافة، حوالات، USDT — and a
 * manager reading a teller's day asks about those three. The five types stay
 * underneath, because "sent" and "received" are different promises, but the
 * screen groups them the way the question is asked.
 *
 * ## Totals per currency, never across them
 *
 * A teller who took 500 dollars and 2,000 shekels did not handle "2,500" of
 * anything. Converting to one figure would need a rate, and the rate would be
 * an opinion about a day that is already over. So every total is kept in its
 * own currency and shown that way; the one place this office values everything
 * in one currency is the ledger, which says which rates it used.
 *
 * ## What counts
 *
 * What stands: posted, and promised (a transfer not yet confirmed is still
 * money the teller took). A reversed deal is counted separately and kept out of
 * every total — it happened, and the manager should see how often, but it did
 * not move money. The reversal row itself is nobody's trading and is left out
 * entirely, as `tellerResults` does.
 */

/** An amount in one currency. Scaled by 1e8, as everywhere else. */
export interface Amount {
  currency: string;
  amount: bigint;
}

export interface TypeTotals {
  type: TransactionType;
  /** Deals that stand: posted, or promised and not yet confirmed. */
  count: number;
  /** Of those, still waiting on a transfer or a send. */
  pending: number;
  /** Struck and later reversed. Not in any total. */
  reversed: number;
  /** What the customers handed over, per currency. */
  received: Amount[];
  /** What the office paid out, per currency. */
  paid: Amount[];
  /** The margin, per currency — only for someone allowed to see it. */
  margin: Amount[] | null;
}

export interface TellerSummary {
  tellerId: string;
  fullNameEn: string;
  fullNameAr: string;
  counts: Record<Category, number>;
  total: number;
  reversed: number;
  /** The last thing he recorded in the window. */
  lastAt: Date | null;
}

export interface Activity {
  from: string;
  to: string;
  /** Everyone who recorded something in the window, busiest first. */
  tellers: TellerSummary[];
  /** The breakdown — for one teller when one is chosen, for the office otherwise. */
  types: TypeTotals[];
  canSeeMargin: boolean;
}

export async function activity(
  input: {
    from: Date;
    to: Date;
    tellerId?: string | null;
    /**
     * The caller's own work, and nobody else's — the teller's report on
     * himself. Asked for explicitly rather than inferred from a missing
     * permission, so a manager opening his own report gets his own and not,
     * silently, the whole office's.
     */
    own?: boolean;
  },
  actor: Actor,
  db: DbClient = prisma,
): Promise<Activity> {
  if (input.own) {
    // Anyone who may see a transaction may see his own.
    if (!actor.permissions.includes('exchange.transaction.view')) {
      throw errors.forbidden('exchange.transaction.view');
    }
  } else if (!actor.permissions.includes('exchange.transaction.viewAll')) {
    // Everybody's work is the manager's view.
    throw errors.forbidden('exchange.transaction.viewAll');
  }
  if (input.from > input.to) {
    throw errors.validation([{ path: 'from', message: 'The period starts after it ends' }]);
  }

  const canSeeMargin = actor.permissions.includes('exchange.margin.view');
  const tellerId = input.own ? actor.id : input.tellerId;

  const where: Prisma.TransactionWhereInput = {
    createdAt: { gte: input.from, lte: input.to },
    reversalOfId: null,
    ...(actor.branchId ? { branchId: actor.branchId } : {}),
    // Narrowed in the query, not after it: his report must not read other
    // people's rows only to throw them away.
    ...(input.own ? { createdById: actor.id } : {}),
  };

  /*
   * Read once, folded here.
   *
   * Two `groupBy`s would do the sums in the database, but a window of a month
   * at one branch is thousands of rows, not millions, and one plain read keeps
   * the counting rules in one readable loop instead of split across two
   * aggregate shapes that each have to remember to exclude the reversed.
   */
  const rows = await db.transaction.findMany({
    where,
    select: {
      createdById: true,
      type: true,
      status: true,
      fromCurrency: true,
      fromAmount: true,
      toCurrency: true,
      toAmount: true,
      profitAmount: true,
      createdAt: true,
    },
  });

  const people = await db.user.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.createdById))] } },
    select: { id: true, fullNameEn: true, fullNameAr: true },
  });
  const named = new Map(people.map((person) => [person.id, person]));

  // --- Who did what ---------------------------------------------------------
  const tellers = new Map<string, TellerSummary>();
  for (const row of rows) {
    let summary = tellers.get(row.createdById);
    if (!summary) {
      const person = named.get(row.createdById);
      summary = {
        tellerId: row.createdById,
        fullNameEn: person?.fullNameEn ?? row.createdById,
        fullNameAr: person?.fullNameAr ?? row.createdById,
        counts: { EXCHANGE: 0, REMITTANCE: 0, USDT: 0 },
        total: 0,
        reversed: 0,
        lastAt: null,
      };
      tellers.set(row.createdById, summary);
    }

    if (!summary.lastAt || row.createdAt > summary.lastAt) summary.lastAt = row.createdAt;

    if (row.status === 'REVERSED') {
      summary.reversed += 1;
      continue;
    }
    const category = categoryOf(row.type);
    if (category) summary.counts[category] += 1;
    summary.total += 1;
  }

  // --- How much, by type ----------------------------------------------------
  const chosen = tellerId ? rows.filter((row) => row.createdById === tellerId) : rows;

  const byType = new Map<
    TransactionType,
    TypeTotals & {
      sums: Record<'received' | 'paid' | 'margin', Map<string, bigint>>;
    }
  >();
  for (const type of TRANSACTION_TYPES) {
    byType.set(type, {
      type,
      count: 0,
      pending: 0,
      reversed: 0,
      received: [],
      paid: [],
      margin: null,
      sums: { received: new Map(), paid: new Map(), margin: new Map() },
    });
  }

  const add = (into: Map<string, bigint>, currency: string, amount: bigint) =>
    into.set(currency, (into.get(currency) ?? 0n) + amount);

  for (const row of chosen) {
    const totals = byType.get(row.type as TransactionType);
    if (!totals) continue;

    if (row.status === 'REVERSED') {
      totals.reversed += 1;
      continue;
    }

    totals.count += 1;
    if (row.status === 'PENDING_TRANSFER') totals.pending += 1;
    add(totals.sums.received, row.fromCurrency, row.fromAmount);
    add(totals.sums.paid, row.toCurrency, row.toAmount);
    // The margin is written in the currency paid out, as `tellerResults` reads it.
    add(totals.sums.margin, row.toCurrency, row.profitAmount);
  }

  const list = (sums: Map<string, bigint>): Amount[] =>
    [...sums.entries()]
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((a, b) => a.currency.localeCompare(b.currency));

  const types = [...byType.values()].map(({ sums, ...totals }) => ({
    ...totals,
    received: list(sums.received),
    paid: list(sums.paid),
    margin: canSeeMargin ? list(sums.margin) : null,
  }));

  return {
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    tellers: [...tellers.values()].sort((a, b) => b.total - a.total || b.reversed - a.reversed),
    types,
    canSeeMargin,
  };
}

// ---------------------------------------------------------------------------
// What his work did to the balances in his hands
// ---------------------------------------------------------------------------

/**
 * One balance a teller holds, and how it moved in a window.
 *
 * Split by why, because the four reasons mean different things to him: money
 * the treasury handed him is not money he earned, and money he gave back is not
 * money he lost. Only the trading lines are his work; the handovers are the
 * frame it happened in.
 */
export interface BalanceFlow {
  currency: string;
  kind: string;
  decimals: number;
  /** Handed to him by the treasury. */
  handedIn: bigint;
  /** Taken in from customers — and what reversals gave back. */
  tradeIn: bigint;
  /** Paid out to customers — and what reversals took back. */
  tradeOut: bigint;
  /** Returned to the treasury. */
  handedBack: bigint;
  /** Anything else: a count difference settled, a transfer. Signed. */
  other: bigint;
  /** What the balance holds now. */
  balance: bigint;
}

const TRADING = new Set(['TRANSACTION', 'REVERSAL']);

export async function balanceFlow(
  input: { from: Date; to: Date },
  actor: Actor,
  db: DbClient = prisma,
): Promise<BalanceFlow[]> {
  /*
   * His own drawers and nobody else's, whoever is asking — there is no
   * parameter here naming whose, so there is nothing to get wrong. Closed ones
   * too: a drawer retired this afternoon still moved this morning.
   */
  const drawers = await db.drawer.findMany({
    where: { ownerKey: `teller:${actor.id}` },
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true,
      currencyCode: true,
      kind: true,
      balance: true,
      isActive: true,
      currency: { select: { decimals: true } },
    },
  });
  if (drawers.length === 0) return [];

  const movements = await db.drawerMovement.findMany({
    where: {
      drawerId: { in: drawers.map((drawer) => drawer.id) },
      createdAt: { gte: input.from, lte: input.to },
    },
    select: { drawerId: true, direction: true, amount: true, reason: true },
  });

  const flows = new Map<string, BalanceFlow>(
    drawers.map((drawer) => [
      drawer.id,
      {
        currency: drawer.currencyCode,
        kind: drawer.kind,
        decimals: drawer.currency.decimals,
        handedIn: 0n,
        tradeIn: 0n,
        tradeOut: 0n,
        handedBack: 0n,
        other: 0n,
        balance: drawer.balance,
      },
    ]),
  );

  for (const movement of movements) {
    const flow = flows.get(movement.drawerId);
    if (!flow) continue;
    const incoming = movement.direction === 'IN';

    if (movement.reason === 'HANDOVER') {
      if (incoming) flow.handedIn += movement.amount;
      else flow.handedBack += movement.amount;
    } else if (TRADING.has(movement.reason)) {
      if (incoming) flow.tradeIn += movement.amount;
      else flow.tradeOut += movement.amount;
    } else {
      flow.other += incoming ? movement.amount : -movement.amount;
    }
  }

  // A closed drawer that did nothing in the window is history, not a balance.
  return drawers
    .filter((drawer) => {
      const flow = flows.get(drawer.id)!;
      const moved = flow.handedIn || flow.tradeIn || flow.tradeOut || flow.handedBack || flow.other;
      return drawer.isActive || moved !== 0n || flow.balance !== 0n;
    })
    .map((drawer) => flows.get(drawer.id)!);
}

// ---------------------------------------------------------------------------
// The machine's own running total, for the teller standing at it
// ---------------------------------------------------------------------------

/** What one bank channel carried today, and how much of it is still owed. */
export interface ChannelTotal {
  channel: string;
  currency: string;
  /** Recorded as paid by transfer, not yet confirmed as sent. */
  pending: bigint;
  pendingCount: number;
  /** Confirmed as sent. */
  sent: bigint;
  sentCount: number;
}

export interface MachineToday {
  /** False when no day is open — there is no "today" to total. */
  dayOpen: boolean;
  count: number;
  /** What the customers handed over, per currency. */
  received: Amount[];
  /** Paid out across the counter, per currency. */
  paidCash: Amount[];
  /** Paid out by transfer, per currency — sent or not. */
  paidBank: Amount[];
  /** The transfers, by the channel they go through. */
  bank: ChannelTotal[];
}

/**
 * What this teller has exchanged on the machine today, and what of it the
 * office still owes by transfer.
 *
 * "Today" is the open business day rather than the calendar date: a day is
 * opened and closed by hand, and a trade belongs to the day it was recorded in
 * whatever the clock says — the same rule the ledger reads by. His own trades
 * only, whoever is asking; reversed ones and the reversals themselves are left
 * out, because neither moved money that is still out.
 */
export async function machineToday(actor: Actor, db: DbClient = prisma): Promise<MachineToday> {
  const empty: MachineToday = {
    dayOpen: false,
    count: 0,
    received: [],
    paidCash: [],
    paidBank: [],
    bank: [],
  };
  if (!actor.branchId) return empty;

  const day = await db.businessDay.findFirst({
    where: { branchId: actor.branchId, status: { in: ['OPEN', 'REOPENED'] } },
    orderBy: { date: 'desc' },
    select: { id: true },
  });
  if (!day) return empty;

  const rows = await db.transaction.findMany({
    where: {
      type: 'EXCHANGE',
      createdById: actor.id,
      businessDayId: day.id,
      reversalOfId: null,
      status: { in: ['POSTED', 'PENDING_TRANSFER'] },
    },
    select: {
      status: true,
      fromCurrency: true,
      fromAmount: true,
      toCurrency: true,
      payoutCashAmount: true,
      payoutBankAmount: true,
      payoutBankChannel: true,
    },
  });

  const received = new Map<string, bigint>();
  const paidCash = new Map<string, bigint>();
  const paidBank = new Map<string, bigint>();
  const channels = new Map<string, ChannelTotal>();
  const add = (into: Map<string, bigint>, currency: string, amount: bigint) => {
    if (amount !== 0n) into.set(currency, (into.get(currency) ?? 0n) + amount);
  };

  for (const row of rows) {
    add(received, row.fromCurrency, row.fromAmount);
    add(paidCash, row.toCurrency, row.payoutCashAmount);
    add(paidBank, row.toCurrency, row.payoutBankAmount);

    if (row.payoutBankAmount > 0n) {
      // A transfer recorded before the channel was asked for has none; it is
      // still money owed, so it is counted under a name that says so.
      const channel = row.payoutBankChannel?.trim() || '—';
      const key = `${channel}\u0000${row.toCurrency}`;
      const total = channels.get(key) ?? {
        channel,
        currency: row.toCurrency,
        pending: 0n,
        pendingCount: 0,
        sent: 0n,
        sentCount: 0,
      };
      if (row.status === 'PENDING_TRANSFER') {
        total.pending += row.payoutBankAmount;
        total.pendingCount += 1;
      } else {
        total.sent += row.payoutBankAmount;
        total.sentCount += 1;
      }
      channels.set(key, total);
    }
  }

  const list = (sums: Map<string, bigint>): Amount[] =>
    [...sums.entries()]
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    dayOpen: true,
    count: rows.length,
    received: list(received),
    paidCash: list(paidCash),
    paidBank: list(paidBank),
    // The most owed first: that is the line the teller is asked about.
    bank: [...channels.values()].sort((a, b) =>
      a.pending === b.pending ? a.channel.localeCompare(b.channel) : a.pending > b.pending ? -1 : 1,
    ),
  };
}

// ---------------------------------------------------------------------------
// One teller, day by day
// ---------------------------------------------------------------------------

/** One business day of one teller's work, and where he stood at its end. */
export interface LedgerDay {
  dayId: string;
  /** The day, as `YYYY-MM-DD`. */
  date: string;
  /** OPEN | REOPENED | CLOSING | CLOSED. */
  status: string;
  /** Exchanges on the machine that stand. */
  count: number;
  received: Amount[];
  paidCash: Amount[];
  paidBank: Amount[];
  /**
   * That day's own transfers still unsent when it ended. Each day stands on
   * its own — nothing is carried in from the days before it.
   */
  owedAtEnd: Amount[];
}

/**
 * A teller's days, newest first: what each one came to, and what he still
 * owed the bank when it ended.
 *
 * ## Why each day's owed figure is its own
 *
 * The office settles the bank day by day, so a day's figure is only what was
 * promised by transfer on that day and not yet confirmed as sent by its close
 * — nothing carried in from earlier days. It is read from when each transfer
 * was recorded and when it was confirmed, so last week's figure stays last
 * week's however much has been sent since.
 *
 * Both the exchanged totals and the owed figure are exchanges only. USDT
 * deals are a separate account, settled apart, so a USDT payout by transfer
 * never lands in the exchange day.
 *
 * A reversed deal is left out of both — it neither exchanged anything nor
 * promised anything that is still owed.
 */
export async function dailyLedger(
  input: { days?: number; tellerId?: string | null },
  actor: Actor,
  db: DbClient = prisma,
): Promise<LedgerDay[]> {
  // His own, unless the asker may read everybody's and named somebody.
  const tellerId =
    input.tellerId && actor.permissions.includes('exchange.transaction.viewAll')
      ? input.tellerId
      : actor.id;
  if (!actor.permissions.includes('exchange.transaction.view')) {
    throw errors.forbidden('exchange.transaction.view');
  }
  if (!actor.branchId) return [];

  const days = await db.businessDay.findMany({
    where: { branchId: actor.branchId },
    orderBy: { date: 'desc' },
    take: Math.min(Math.max(input.days ?? 14, 1), 90),
    select: { id: true, date: true, status: true },
  });
  if (days.length === 0) return [];

  const oldest = days[days.length - 1]!.date;

  const [worked, transfers] = await Promise.all([
    db.transaction.findMany({
      where: {
        type: 'EXCHANGE',
        createdById: tellerId,
        businessDayId: { in: days.map((day) => day.id) },
        reversalOfId: null,
        status: { in: ['POSTED', 'PENDING_TRANSFER'] },
      },
      select: {
        businessDayId: true,
        fromCurrency: true,
        fromAmount: true,
        toCurrency: true,
        payoutCashAmount: true,
        payoutBankAmount: true,
      },
    }),
    // Every exchange transfer promised on one of these days: unsent now, or
    // sent only after the oldest of them began. USDT deals are settled apart
    // and never enter the exchange account.
    db.transaction.findMany({
      where: {
        type: 'EXCHANGE',
        createdById: tellerId,
        createdAt: { gte: oldest },
        reversalOfId: null,
        status: { not: 'REVERSED' },
        payoutBankAmount: { gt: 0n },
        OR: [{ transferConfirmedAt: null }, { transferConfirmedAt: { gte: oldest } }],
      },
      select: {
        toCurrency: true,
        payoutBankAmount: true,
        createdAt: true,
        transferConfirmedAt: true,
        status: true,
      },
    }),
  ]);

  const add = (into: Map<string, bigint>, currency: string, amount: bigint) => {
    if (amount !== 0n) into.set(currency, (into.get(currency) ?? 0n) + amount);
  };
  const list = (sums: Map<string, bigint>): Amount[] =>
    [...sums.entries()]
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((a, b) => a.currency.localeCompare(b.currency));

  const now = new Date();

  return days.map((day) => {
    const mine = worked.filter((row) => row.businessDayId === day.id);
    const received = new Map<string, bigint>();
    const paidCash = new Map<string, bigint>();
    const paidBank = new Map<string, bigint>();
    for (const row of mine) {
      add(received, row.fromCurrency, row.fromAmount);
      add(paidCash, row.toCurrency, row.payoutCashAmount);
      add(paidBank, row.toCurrency, row.payoutBankAmount);
    }

    // Only this day's transfers, as they stood at its end (or now, while it runs).
    const { start, end } = dayBounds(day.date);
    const cutoff = end > now ? now : end;
    const owed = new Map<string, bigint>();
    for (const transfer of transfers) {
      if (transfer.createdAt < start || transfer.createdAt > cutoff) continue;
      const sentBy = transfer.transferConfirmedAt;
      // Confirmed by the cut-off means paid; a row no longer pending but with
      // no time recorded was settled some other way and is not owed.
      if (sentBy ? sentBy <= cutoff : transfer.status !== 'PENDING_TRANSFER') continue;
      add(owed, transfer.toCurrency, transfer.payoutBankAmount);
    }

    return {
      dayId: day.id,
      date: formatDayKey(day.date),
      status: day.status,
      count: mine.length,
      received: list(received),
      paidCash: list(paidCash),
      paidBank: list(paidBank),
      owedAtEnd: list(owed),
    };
  });
}

// ---------------------------------------------------------------------------
// One day, entry by entry
// ---------------------------------------------------------------------------

/** One exchange of a teller's day, as the day's detail lists it. */
export interface DayEntry {
  id: string;
  reference: string;
  createdAt: Date;
  /** POSTED | PENDING_TRANSFER | REVERSED. */
  status: string;
  fromCurrency: string;
  fromAmount: bigint;
  toCurrency: string;
  toAmount: bigint;
  payoutCashAmount: bigint;
  payoutBankAmount: bigint;
  payoutBankChannel: string | null;
  transferConfirmedAt: Date | null;
  /** Who it was for — the registered customer, or the name left at the counter. */
  party: { en: string | null; ar: string | null };
}

/**
 * The exchanges behind one row of the days, oldest first: the same day, the
 * same teller, and the same rule for whose — so the detail always adds up to
 * the row it opens from.
 *
 * Reversed deals are listed, marked, because the teller asks "where did that
 * one go" as often as "what did I do"; the reversing rows themselves are not,
 * since they are the deletion, not a second deal.
 */
export async function dayEntries(
  input: { dayId: string; tellerId?: string | null },
  actor: Actor,
  db: DbClient = prisma,
): Promise<DayEntry[]> {
  const tellerId =
    input.tellerId && actor.permissions.includes('exchange.transaction.viewAll')
      ? input.tellerId
      : actor.id;
  if (!actor.permissions.includes('exchange.transaction.view')) {
    throw errors.forbidden('exchange.transaction.view');
  }

  const rows = await db.transaction.findMany({
    where: {
      type: 'EXCHANGE',
      createdById: tellerId,
      businessDayId: input.dayId,
      reversalOfId: null,
      ...(actor.branchId ? { branchId: actor.branchId } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
    select: {
      id: true,
      reference: true,
      createdAt: true,
      status: true,
      fromCurrency: true,
      fromAmount: true,
      toCurrency: true,
      toAmount: true,
      payoutCashAmount: true,
      payoutBankAmount: true,
      payoutBankChannel: true,
      transferConfirmedAt: true,
      counterpartyName: true,
      customer: { select: { fullNameEn: true, fullNameAr: true } },
    },
  });

  return rows.map(({ counterpartyName, customer, ...row }) => ({
    ...row,
    party: {
      en: customer?.fullNameEn ?? counterpartyName ?? null,
      ar: customer?.fullNameAr ?? counterpartyName ?? null,
    },
  }));
}
