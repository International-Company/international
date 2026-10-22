import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { createLogger } from '@/core/logger/logger';

/**
 * Knowing who sent the coins before anybody asks.
 *
 * ## What is learned, and from what
 *
 * Every arrival carries the address it came from. The first time the counter
 * settles one for a customer, that address is written against them — and so is
 * where they were paid, if it was not in cash. The next transfer from the same
 * address arrives already knowing whose it is and where the money goes; the
 * teller checks it and records it.
 *
 * ## Why it never decides on its own
 *
 * An exchange's hot wallet sends for thousands of people. The first time a
 * second customer is seen on an address, it stops being anybody's: it is
 * reported as shared, and nothing is filled in. Guessing there would hand one
 * person's money to another, which is worse than any amount of typing.
 *
 * Only the counter writes here, and only after a settlement has been posted —
 * an address is learned from money that actually arrived, never from a form.
 */

const log = createLogger('usdt:recognition');

export interface SavedPayout {
  id: string;
  channel: string;
  account: string;
  isDefault: boolean;
  timesUsed: number;
}

export type Recognition =
  | {
      status: 'KNOWN';
      customer: {
        id: string;
        code: string;
        fullNameEn: string;
        fullNameAr: string;
        phone: string | null;
        isBlocked: boolean;
      };
      /** Settled arrivals from this address for this customer. */
      timesSeen: number;
      /** Where they were paid last time, when it was by transfer. */
      payout: SavedPayout | null;
    }
  | { status: 'SHARED'; customers: number };

const keyOf = (network: string, address: string) => `${network}\u0000${address}`;

/** What is known about each of these sending addresses. Unknown ones are absent. */
export async function recognise(
  senders: { network: string; address: string }[],
  db: DbClient = prisma,
): Promise<Map<string, Recognition>> {
  const wanted = senders.filter((sender) => sender.address);
  if (wanted.length === 0) return new Map();

  const rows = await db.customerWallet.findMany({
    where: { OR: wanted.map(({ network, address }) => ({ network, address })) },
    select: {
      network: true,
      address: true,
      timesSeen: true,
      customer: {
        select: {
          id: true,
          code: true,
          fullNameEn: true,
          fullNameAr: true,
          phone: true,
          isBlocked: true,
          payouts: {
            where: { isDefault: true },
            take: 1,
            select: { id: true, channel: true, account: true, isDefault: true, timesUsed: true },
          },
        },
      },
    },
  });

  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = keyOf(row.network, row.address);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  const known = new Map<string, Recognition>();
  for (const [key, owners] of grouped) {
    if (owners.length > 1) {
      known.set(key, { status: 'SHARED', customers: owners.length });
      continue;
    }
    const [only] = owners;
    if (!only) continue;
    const { payouts, ...customer } = only.customer;
    known.set(key, {
      status: 'KNOWN',
      customer,
      timesSeen: only.timesSeen,
      payout: payouts[0] ?? null,
    });
  }
  return known;
}

export function recognitionKey(network: string, address: string): string {
  return keyOf(network, address);
}

/** The ways a customer has been paid by transfer, most used first. */
export async function payoutsFor(
  customerId: string,
  db: DbClient = prisma,
): Promise<SavedPayout[]> {
  return db.customerPayout.findMany({
    where: { customerId },
    orderBy: [{ isDefault: 'desc' }, { timesUsed: 'desc' }, { lastUsedAt: 'desc' }],
    take: 10,
    select: { id: true, channel: true, account: true, isDefault: true, timesUsed: true },
  });
}

/**
 * Writes down what a settled arrival taught: this customer sends from this
 * address, and — when paid by transfer — is paid to this account.
 *
 * The payout used becomes the default, so the next arrival offers the account
 * the customer chose most recently.
 */
export async function remember(
  input: {
    customerId: string;
    network: string;
    address: string | null;
    payout: { channel: string; account: string } | null;
  },
  db: DbClient = prisma,
): Promise<void> {
  const now = new Date();

  if (input.address) {
    await db.customerWallet.upsert({
      where: {
        network_address_customerId: {
          network: input.network,
          address: input.address,
          customerId: input.customerId,
        },
      },
      create: { customerId: input.customerId, network: input.network, address: input.address },
      update: { timesSeen: { increment: 1 }, lastSeenAt: now },
    });
  }

  if (input.payout) {
    const channel = input.payout.channel.trim();
    const account = input.payout.account.trim();
    if (channel && account) {
      await db.customerPayout.updateMany({
        where: { customerId: input.customerId, isDefault: true },
        data: { isDefault: false },
      });
      await db.customerPayout.upsert({
        where: { customerId_channel_account: { customerId: input.customerId, channel, account } },
        create: { customerId: input.customerId, channel, account, isDefault: true },
        update: { isDefault: true, timesUsed: { increment: 1 }, lastUsedAt: now },
      });
    }
  }

  log.debug('Learned from a settled arrival', {
    customerId: input.customerId,
    address: Boolean(input.address),
    payout: Boolean(input.payout),
  });
}
