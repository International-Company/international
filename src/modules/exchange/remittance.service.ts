import 'server-only';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import * as drawers from '@/modules/drawers/drawer.service';
import { formatFigure } from '@/modules/whatsapp/report-command';
import { requireOpenDay } from './business-day.service';
import { emitAsync } from '@/core/events/bus';
import * as audit from '@/modules/audit/audit.service';
import * as settings from '@/modules/settings/settings.service';
import { transferChannels } from './machine.service';
import { MAX_PROOFS, readProofImage, type ProofKind } from './proof-image';
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
  /** The office's accounts a customer can pay into. */
  transferChannels: string[];
  /** The price list, for the screen to work a sum out from. */
  prices: {
    id: string;
    destination: string;
    currency: string;
    chargeKind: string;
    chargeValue: bigint;
    costKind: string;
    costValue: bigint;
  }[];
  currencies: { code: string; nameEn: string; nameAr: string; symbol: string; decimals: number }[];
}

/**
 * What the counter screen needs before anyone types anything.
 *
 * Only cash currencies: a remittance is handed over and paid out in notes, and
 * USDT reaches the branch by a different road with its own screen.
 */
export async function config(db: DbClient = prisma): Promise<RemittanceConfig> {
  const [list, channels, prices, currencies] = await Promise.all([
    destinations(db),
    transferChannels(db),
    db.remittancePrice.findMany({
      orderBy: [{ destination: 'asc' }, { currency: 'asc' }],
      select: {
        id: true,
        destination: true,
        currency: true,
        chargeKind: true,
        chargeValue: true,
        costKind: true,
        costValue: true,
      },
    }),
    db.currency.findMany({
      where: { isActive: true, kind: 'FIAT' },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, nameEn: true, nameAr: true, symbol: true, decimals: true },
    }),
  ]);

  return { destinations: list, transferChannels: channels, prices, currencies };
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
  /** What the correspondent charges for it, or nothing when that is not known yet. */
  cost: bigint | null;
  /** The customer paid by transfer, into this one of the office's accounts. Otherwise notes. */
  intakeChannel?: string | null;
  /** What reaches the beneficiary, in the money it arrives in. For showing only. */
  deliveredAmount?: bigint | null;
  deliveredUnit?: string | null;
  /** A photo of what the customer paid, as base64. */
  proof?: string | null;
  /** A photo of who the remittance is for, as base64. */
  beneficiary?: string | null;
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
  /*
   * Without a price yet the correspondent is held at the whole sum, the most they
   * can be owed, so their balance is never understated. `addPrice` gives back the
   * difference once the price is known, and a reversal mirrors whichever stands.
   */
  const pricePending = input.cost === null;
  const delivered = input.deliveredAmount && input.deliveredAmount > 0n ? input.deliveredAmount : null;
  const cost = input.cost ?? input.collected;
  await check(input, [input.collected, cost], db);

  if (cost > input.collected) {
    throw errors.precondition(
      `Charging ${toDecimalString(cost, 2)} to collect ${toDecimalString(input.collected, 2)} loses money on the transfer`,
      'errors.remittanceBelowCost',
    );
  }

  // Both read before anything is written: a bad photo records no deal.
  const photos = [
    { kind: 'PAYMENT' as const, base64: input.proof },
    { kind: 'BENEFICIARY' as const, base64: input.beneficiary },
  ].flatMap(({ kind, base64 }) => (base64 ? [{ kind, image: readProof_(base64) }] : []));

  // Paid by transfer: the money landed on the office's account, not in the till.
  const intakeChannel = input.intakeChannel?.trim() || null;
  if (intakeChannel && !(await transferChannels(db)).includes(intakeChannel)) {
    throw errors.precondition(
      `${intakeChannel} is not an account the counter offers`,
      'errors.transferChannelUnknown',
      { channel: intakeChannel },
    );
  }

  /*
   * One transaction, so the deal and its photo are visible together. The bot is
   * told of the deal as it is written and waits for it to commit, so by the time
   * it can read the deal it can read the photo as well.
   */
  return withTransaction(async (tx) => {
    const posted = await transactions.record(
      {
        type: 'REMITTANCE_OUT',
        branchId: input.branchId,
        customerId: input.customerId ?? null,
        // Same currency on both sides. What the customer paid, and what the
        // correspondent is owed; the difference is the margin.
        fromCurrency: input.currency,
        fromAmount: input.collected,
        toCurrency: input.currency,
        toAmount: cost,
        pricePending,
        deliveredAmount: delivered,
        deliveredUnit: delivered ? input.deliveredUnit?.trim() || null : null,
        intake: intakeChannel ? { cash: 0n, broker: input.collected } : undefined,
        intakeChannel,
        rate: 100000000n,
        profitAmount: input.collected - cost,
        counterpartyName: input.counterpartyName ?? null,
        counterpartyPhone: input.counterpartyPhone ?? null,
        notes: [input.destination.trim(), input.notes?.trim()].filter(Boolean).join(' — '),
      },
      actor,
      tx,
    );
    for (const { kind, image } of photos) {
      await tx.transactionProof.create({
        data: {
          transactionId: posted.id,
          kind,
          mimeType: image.mimeType,
          size: image.bytes.length,
          data: new Uint8Array(image.bytes),
          createdById: actor.id,
        },
      });
    }
    return posted;
  }, db);
}

/**
 * A remittance written down from what the teller types: the notes taken and the
 * correspondent's price, with a free note. Moves the same balances as `send`, so
 * the drawer and the correspondent stay right, but takes no destination and is
 * not announced to the group; it shows in the teller's count.
 */
export async function recordCash(
  input: {
    currency: string;
    branchId: string;
    collected: bigint;
    cost: bigint;
    notes?: string | null;
  },
  actor: Actor,
  db: DbClient = prisma,
) {
  if (input.collected <= 0n || input.cost <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }
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
      customerId: null,
      fromCurrency: input.currency,
      fromAmount: input.collected,
      toCurrency: input.currency,
      toAmount: input.cost,
      rate: 100000000n,
      profitAmount: input.collected - input.cost,
      counterpartyName: null,
      counterpartyPhone: null,
      notes: input.notes?.trim() || null,
    },
    actor,
    db,
    { unannounced: true },
  );
}

/** Remittances sent whose price is still to be written: a teller's own, or all for a manager. */
export async function unpriced(actor: Actor, db: DbClient = prisma) {
  const rows = await db.transaction.findMany({
    where: {
      type: 'REMITTANCE_OUT',
      pricePending: true,
      status: { not: 'REVERSED' },
      ...(actor.permissions.includes('exchange.transaction.viewAll')
        ? {}
        : { createdById: actor.id }),
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      reference: true,
      fromCurrency: true,
      fromAmount: true,
      counterpartyName: true,
      notes: true,
      createdAt: true,
      customer: { select: { fullNameAr: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    currency: row.fromCurrency,
    amountText: formatFigure(row.fromAmount),
    who: row.customer?.fullNameAr || row.counterpartyName || row.notes,
    createdAt: row.createdAt,
  }));
}

/**
 * The correspondent's price, written after the fact. Once only: a price that
 * turns out wrong is put right as any posted figure is, by reversing the deal.
 *
 * The correspondent gets back what they were held at beyond the price, and the
 * deal takes its profit. That profit counts on the day the deal was recorded.
 */
export async function addPrice(id: string, cost: bigint, actor: Actor, db: DbClient = prisma) {
  // Reading it this way also refuses a deal this person may not see.
  await transactions.getById(id, actor, db);
  return withTransaction(async (tx) => {
    const deal = await tx.transaction.findUnique({ where: { id } });
    if (!deal) throw errors.notFound('Transaction', id);
    if (!deal.pricePending || deal.type !== 'REMITTANCE_OUT' || deal.status === 'REVERSED') {
      throw errors.conflict('This remittance already has its price', 'errors.remittanceHasPrice');
    }
    if (cost <= 0n) {
      throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
    }
    if (cost > deal.fromAmount) {
      throw errors.precondition(
        `Charging ${toDecimalString(cost, 2)} to collect ${toDecimalString(deal.fromAmount, 2)} loses money on the transfer`,
        'errors.remittanceBelowCost',
      );
    }

    const day = await requireOpenDay(deal.branchId, new Date(), tx, actor);
    const margin = deal.fromAmount - cost;
    await tx.transaction.update({
      where: { id },
      data: { toAmount: cost, profitAmount: margin, pricePending: false },
    });
    if (margin > 0n) {
      await drawers.move(
        [
          {
            currency: deal.toCurrency,
            kind: 'CORRESPONDENT',
            direction: 'IN',
            amount: margin,
            reason: 'TRANSACTION',
            transactionId: id,
            businessDayId: day.id,
          },
        ],
        actor,
        tx,
      );
    }
    const figure = `${toDecimalString(cost, 2)} ${deal.toCurrency}`;
    await audit.record(
      {
        action: 'UPDATE',
        module: 'exchange',
        entityType: 'Transaction',
        entityId: id,
        summaryEn: `Added the correspondent's price to ${deal.reference}: ${figure}`,
        summaryAr: `إضافة تسعيرة المراسل إلى ${deal.reference}: ${figure}`,
        actor,
      },
      tx,
    );
    return { id };
  }, db);
}

/** The photo, or the words for why it cannot be kept. */
function readProof_(base64: string) {
  const image = readProofImage(base64);
  if (typeof image === 'string') {
    throw errors.precondition('That photo cannot be kept', image);
  }
  return image;
}

/** Which deals take which photos afterwards, and who may add them. */
const PHOTOS_BY_TYPE: Record<string, { kinds: ProofKind[]; permission: string }> = {
  REMITTANCE_OUT: { kinds: ['PAYMENT', 'BENEFICIARY'], permission: 'exchange.remittance.use' },
  USDT_SALE: { kinds: ['PAYMENT', 'ADDRESS'], permission: 'usdt.withdrawal.use' },
};

const PHOTO_SUMMARIES: Record<ProofKind, { en: string; ar: string }> = {
  PAYMENT: { en: 'payment', ar: 'دليل الدفع' },
  BENEFICIARY: { en: 'beneficiary', ar: 'بيانات المستفيد' },
  ADDRESS: { en: 'address', ar: 'عنوان التحويل' },
};

/**
 * A photo added once the remittance is already recorded: the customer's proof
 * often arrives after they have paid. Only for someone who can read the deal.
 */
export async function addProof(
  transactionId: string,
  base64: string,
  actor: Actor,
  kind: ProofKind = 'PAYMENT',
) {
  const deal = await transactions.getById(transactionId, actor);
  const takes = PHOTOS_BY_TYPE[deal.type];
  if (!takes || !takes.kinds.includes(kind) || deal.status === 'REVERSED') {
    throw errors.precondition(
      'Only an outgoing remittance or a USDT sale that stands takes a photo',
      'errors.proofNotHere',
    );
  }
  if (!actor.permissions.includes(takes.permission)) throw errors.forbidden(takes.permission);
  const image = readProof_(base64);
  const held = await prisma.transactionProof.count({ where: { transactionId } });
  if (held >= MAX_PROOFS) {
    throw errors.precondition(`A deal holds ${MAX_PROOFS} photos`, 'errors.proofTooMany', {
      maximum: String(MAX_PROOFS),
    });
  }
  const proof = await prisma.transactionProof.create({
    data: {
      transactionId,
      kind,
      mimeType: image.mimeType,
      size: image.bytes.length,
      data: new Uint8Array(image.bytes),
      createdById: actor.id,
    },
    select: { id: true },
  });
  await audit.record({
    action: 'UPDATE',
    module: 'exchange',
    entityType: 'Transaction',
    entityId: transactionId,
    summaryEn: `Attached a ${PHOTO_SUMMARIES[kind].en} photo to ${deal.reference}`,
    summaryAr: `إرفاق صورة ${PHOTO_SUMMARIES[kind].ar} بالعملية ${deal.reference}`,
    actor,
  });
  emitAsync('transaction.proofAdded', { transactionId, proofId: proof.id });
  return { id: proof.id };
}

/** The photos a deal carries, without their bytes. */
export function listProofs(transactionId: string, db: DbClient = prisma) {
  return db.transactionProof.findMany({
    where: { transactionId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, kind: true, createdAt: true },
  });
}

/** One photo, to someone who can read the deal it belongs to. */
export async function readProof(transactionId: string, proofId: string, actor: Actor) {
  await transactions.getById(transactionId, actor);
  const proof = await prisma.transactionProof.findFirst({
    where: { id: proofId, transactionId },
    select: { mimeType: true, data: true },
  });
  if (!proof) throw errors.notFound('Proof', proofId);
  return proof;
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
