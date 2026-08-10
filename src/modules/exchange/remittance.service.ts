import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import * as settings from '@/modules/settings/settings.service';
import * as transactions from './transaction.service';
import type { Actor } from './transaction.service';

/**
 * Remittances, sent and received.
 *
 * The branch does not deliver these itself. A correspondent company does — it
 * publishes a price for each of its destinations, the branch sells above that
 * price, and the gap is the margin. So a remittance is not a conversion; it is
 * two figures in one currency, and the difference between them is the whole
 * commercial content of the transaction.
 *
 * That difference is why both figures are entered rather than derived. The
 * commission takes several forms depending on the destination and the amount —
 * a flat fee here, a percentage there, sometimes only a worse rate — and a
 * system that insisted on one formula would be wrong for most of them. What
 * cannot vary is that the customer paid one number and the correspondent is
 * owed another, so those are what get recorded.
 *
 * Sending is final the moment it leaves. The correspondent is the one obliged
 * to deliver, and the branch has no relationship with whoever ultimately pays
 * it out, so there is nothing for the branch to wait on and no pending state.
 */

/** Where a remittance can go, as the manager keeps the list. */
export async function destinations(db: DbClient = prisma): Promise<string[]> {
  const raw = await settings.getString('remittance.destinations', db);
  return [
    ...new Set(
      raw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

export interface RemittanceConfig {
  destinations: string[];
  currencies: { code: string; nameEn: string; nameAr: string; symbol: string; decimals: number }[];
}

/**
 * What the counter screen needs before anyone types anything.
 *
 * Only cash currencies: a remittance is handed over and paid out in notes, and
 * USDT reaches the branch by a different road with its own screen.
 */
export async function config(db: DbClient = prisma): Promise<RemittanceConfig> {
  const [list, currencies] = await Promise.all([
    destinations(db),
    db.currency.findMany({
      where: { isActive: true, kind: 'FIAT' },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, nameEn: true, nameAr: true, symbol: true, decimals: true },
    }),
  ]);

  return { destinations: list, currencies };
}

interface Common {
  currency: string;
  destination: string;
  branchId: string;
  customerId?: string | null;
  counterpartyName?: string | null;
  counterpartyPhone?: string | null;
  notes?: string | null;
}

export interface SendInput extends Common {
  /** What the customer hands over in total, commission included. */
  collected: bigint;
  /** What the correspondent charges for it — their published price. */
  cost: bigint;
}

export interface ReceiveInput extends Common {
  /** What the branch hands to the customer. */
  paid: bigint;
  /** What the correspondent credits the branch for handling it. */
  credited: bigint;
}

async function check(input: Common, amounts: bigint[], db: DbClient): Promise<void> {
  if (amounts.some((amount) => amount <= 0n)) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }

  const allowed = await destinations(db);
  const destination = input.destination.trim();
  if (!destination) {
    throw errors.precondition('Say where it is going', 'errors.destinationRequired');
  }
  if (!allowed.includes(destination)) {
    throw errors.precondition(
      `${destination} is not a destination the counter offers`,
      'errors.destinationUnknown',
      { destination },
    );
  }
}

/**
 * A remittance leaving: the customer pays here, the correspondent delivers there.
 *
 * Cash comes in and the correspondent balance goes down — the branch now owes
 * them what they will pay out. That balance is allowed to run negative for
 * exactly this reason, and it is the only honest way to record it: without it,
 * the cash the customer handed over would look like money that arrived from
 * nowhere.
 */
export async function send(input: SendInput, actor: Actor, db: DbClient = prisma) {
  await check(input, [input.collected, input.cost], db);

  if (input.cost > input.collected) {
    throw errors.precondition(
      `Charging ${toDecimalString(input.cost, 2)} to collect ${toDecimalString(input.collected, 2)} loses money on the transfer`,
      'errors.remittanceBelowCost',
    );
  }

  return transactions.record(
    {
      type: 'REMITTANCE_OUT',
      branchId: input.branchId,
      customerId: input.customerId ?? null,
      // Same currency on both sides. What the customer paid, and what the
      // correspondent is owed; the difference is the margin.
      fromCurrency: input.currency,
      fromAmount: input.collected,
      toCurrency: input.currency,
      toAmount: input.cost,
      rate: 100000000n,
      profitAmount: input.collected - input.cost,
      counterpartyName: input.counterpartyName ?? null,
      counterpartyPhone: input.counterpartyPhone ?? null,
      notes: [input.destination.trim(), input.notes?.trim()].filter(Boolean).join(' — '),
    },
    actor,
    db,
  );
}

/**
 * A remittance arriving: the correspondent owes, the branch pays the customer.
 *
 * The mirror of sending. The correspondent balance rises by what they credit,
 * cash falls by what is handed over, and the branch keeps the difference.
 */
export async function receive(input: ReceiveInput, actor: Actor, db: DbClient = prisma) {
  await check(input, [input.paid, input.credited], db);

  if (input.paid > input.credited) {
    throw errors.precondition(
      `Paying ${toDecimalString(input.paid, 2)} against a credit of ${toDecimalString(input.credited, 2)} loses money on the transfer`,
      'errors.remittanceBelowCost',
    );
  }

  return transactions.record(
    {
      type: 'REMITTANCE_IN',
      branchId: input.branchId,
      customerId: input.customerId ?? null,
      fromCurrency: input.currency,
      fromAmount: input.credited,
      toCurrency: input.currency,
      toAmount: input.paid,
      rate: 100000000n,
      profitAmount: input.credited - input.paid,
      counterpartyName: input.counterpartyName ?? null,
      counterpartyPhone: input.counterpartyPhone ?? null,
      notes: [input.destination.trim(), input.notes?.trim()].filter(Boolean).join(' — '),
    },
    actor,
    db,
  );
}
