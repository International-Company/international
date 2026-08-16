import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString, MONEY_FACTOR, divideRounded } from '@/core/money/money';
import { quoteExchange, type Quote, type RateChannel } from '@/modules/exchange/rates.service';
import { transferChannels } from '@/modules/exchange/machine.service';
import * as drawers from '@/modules/drawers/drawer.service';
import { cashOwnerFor } from '@/modules/treasury/shift.service';
import { ceilingFor } from '@/modules/users/counter-limit';
import * as transactions from '@/modules/exchange/transaction.service';
import type { Actor } from '@/modules/exchange/transaction.service';
import * as settings from '@/modules/settings/settings.service';
import * as audit from '@/modules/audit/audit.service';
import * as notifications from '@/modules/notifications/notifications.service';
import { createLogger } from '@/core/logger/logger';
import { providerFor } from './providers';

const log = createLogger('usdt:withdrawal');

/**
 * Selling USDT at the window.
 *
 * The mirror of the receiving screen. There a customer sends USDT and takes
 * notes away; here they pay and the branch sends USDT to their wallet. The two
 * sides of the same market, priced from the same published pair — the branch
 * buys at one figure and sells at the other, which is why no second rate had to
 * be invented for this.
 *
 * What the customer pays with can arrive three ways, exactly as a payout can
 * leave three ways: from the till, into the broker's account, or part each. The
 * price differs by channel, so a split is two trades at two prices settled as
 * one transaction rather than one trade divided — the same rule the exchange
 * machine follows, and for the same reason.
 *
 * The USDT leaves the balance the moment the trade is recorded, before anyone
 * has touched a wallet. A promise that has not yet reduced the balance is one
 * two tellers can both make against the same coins. The transfer itself is
 * therefore outstanding proof, not outstanding money, and the row says so by
 * waiting at `PENDING_TRANSFER` until someone confirms it went.
 */

export const PAYMENT_MODES = ['CASH', 'BROKER', 'SPLIT'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/** The token the counter sells. The wallets hold it; the drawer counts it. */
const TOKEN = 'USDT';

export interface WithdrawalQuote {
  payCurrency: string;
  /** The whole amount priced through the till. Null when no cash rate exists. */
  cash: Quote | null;
  /** The whole amount priced through the broker. Null when no broker rate exists. */
  broker: Quote | null;
  /** What the branch can actually send. */
  availableUsdt: bigint;
}

/**
 * Prices what the customer wants to buy, through both channels at once.
 *
 * Both, because the teller decides how the customer is paying after seeing the
 * two figures; asking the server twice would let the board move between the two
 * answers and price a split at rates that were never simultaneously true.
 */
export async function quote(
  input: { payCurrency: string; payAmount: bigint; actorId?: string },
  db: DbClient = prisma,
): Promise<WithdrawalQuote> {
  if (input.payAmount <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }

  const price = async (channel: RateChannel): Promise<Quote | null> => {
    try {
      return await quoteExchange(input.payCurrency, TOKEN, input.payAmount, channel, db);
    } catch {
      // A branch may publish a till price and no broker price. That is an
      // ordinary state, so the teller is simply not offered that way of paying.
      return null;
    }
  };

  // A teller is shown the USDT allocated to them, never the wallet's total.
  const owner = input.actorId ? await cashOwnerFor(input.actorId, db) : drawers.TREASURY;

  const [cash, broker, held] = await Promise.all([
    price('CASH'),
    price('BROKER'),
    drawers.canPay(TOKEN, 0n, 'CASH', db, owner),
  ]);

  return { payCurrency: input.payCurrency, cash, broker, availableUsdt: held.balance };
}

export interface RecordInput {
  payCurrency: string;
  /** What the customer hands over in total, across both channels. */
  payAmount: bigint;
  mode: PaymentMode;
  /**
   * For a split: how much of what the customer pays settles through the broker.
   * The till takes the rest, so the two can never be sent in disagreeing with
   * each other or with a total priced from a stale board.
   */
  brokerShare?: bigint;
  /** Which of the broker's accounts the customer paid into. */
  intakeChannel?: string | null;
  /** The customer's wallet, and which of ours it will be sent from. */
  address: string;
  walletId: string;
  branchId: string;
  customerId?: string | null;
  counterpartyName?: string | null;
  counterpartyPhone?: string | null;
  notes?: string | null;
}

interface Leg {
  from: bigint;
  to: bigint;
  profit: bigint;
  quote: Quote | null;
}

const NO_LEG: Leg = { from: 0n, to: 0n, profit: 0n, quote: null };

/**
 * Splits what the customer pays and prices each part at its own channel.
 *
 * The split is expressed on the side the customer pays, which is the only side
 * that can carry it: how much USDT they get is not known until both parts have
 * been priced, so it cannot be the thing divided.
 */
async function priceLegs(input: RecordInput, db: DbClient): Promise<{ cash: Leg; broker: Leg }> {
  const price = async (amount: bigint, channel: RateChannel): Promise<Leg> => {
    const quoted = await quoteExchange(input.payCurrency, TOKEN, amount, channel, db);
    return { from: quoted.fromAmount, to: quoted.toAmount, profit: quoted.profit, quote: quoted };
  };

  if (input.mode !== 'SPLIT') {
    const leg = await price(input.payAmount, input.mode === 'BROKER' ? 'BROKER' : 'CASH');
    return input.mode === 'BROKER' ? { cash: NO_LEG, broker: leg } : { cash: leg, broker: NO_LEG };
  }

  const brokerShare = input.brokerShare ?? 0n;
  if (brokerShare <= 0n || brokerShare >= input.payAmount) {
    throw errors.precondition(
      'The transferred share must be part of the amount, not all or none of it',
      'errors.splitShareOutOfRange',
    );
  }

  const [cash, broker] = await Promise.all([
    price(input.payAmount - brokerShare, 'CASH'),
    price(brokerShare, 'BROKER'),
  ]);

  return { cash, broker };
}

/**
 * Prices and posts in one call.
 *
 * The price is taken here rather than trusted from the browser, so the receipt
 * cannot disagree with the ledger even if the screen was left open while the
 * board moved.
 */
export async function record(input: RecordInput, actor: Actor, db: DbClient = prisma) {
  if (!(await settings.getBoolean('usdt.withdrawalEnabled', db))) {
    throw errors.precondition('USDT withdrawals are switched off', 'errors.withdrawalDisabled');
  }

  const wallet = await db.wallet.findUnique({ where: { id: input.walletId } });
  if (!wallet) throw errors.notFound('Wallet', input.walletId);
  if (!wallet.isActive) {
    throw errors.precondition('That wallet is not in use', 'errors.walletInactive');
  }

  /*
   * The address is checked against the network it will be sent on, not against
   * a general idea of what an address looks like. A TRON address typed into an
   * Ethereum transfer is money sent nowhere, and no later step can recover it.
   */
  const address = input.address.trim();
  if (!providerFor(wallet.network).validateAddress(address)) {
    throw errors.precondition(
      `${address} is not a valid ${wallet.network} address`,
      'errors.invalidAddressForNetwork',
      { network: wallet.network },
    );
  }
  if (address.toLowerCase() === wallet.address.toLowerCase()) {
    throw errors.precondition(
      'That is the branch’s own address',
      'errors.withdrawalToOwnAddress',
    );
  }

  const legs = await priceLegs(input, db);
  const payTotal = legs.cash.from + legs.broker.from;
  const total = legs.cash.to + legs.broker.to;

  if (total <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }

  const maximum = await ceilingFor(
    actor.id,
    await settings.getMoney('usdt.withdrawalMaxAmount', db),
    db,
  );
  if (maximum > 0n && total > maximum) {
    throw errors.precondition(
      `A withdrawal cannot exceed ${toDecimalString(maximum, 2)} ${TOKEN}`,
      'errors.withdrawalTooLarge',
      { maximum: toDecimalString(maximum, 2) },
    );
  }

  /*
   * Which of the broker's accounts the customer paid into, checked against the
   * list the manager keeps. The office keeps no ledger per account, but a
   * payment it claims arrived has to say where, or the broker's statement can
   * never be checked against it.
   */
  let account: string | null = null;
  if (legs.broker.from > 0n) {
    const allowed = await transferChannels(db);
    account = input.intakeChannel?.trim() ?? '';

    if (!account) {
      throw errors.precondition(
        'Say which account the customer paid into',
        'errors.transferChannelRequired',
      );
    }
    if (!allowed.includes(account)) {
      throw errors.precondition(
        `${account} is not a destination the counter offers`,
        'errors.transferChannelUnknown',
        { channel: account },
      );
    }
  }

  /*
   * Before anything is promised. Failing here means the teller is told the
   * branch is short and by how much, rather than reading a posting error after
   * naming a figure aloud.
   */
  const held = await drawers.canPay(TOKEN, total, 'CASH', db, await cashOwnerFor(actor.id, db));
  if (!held.ok) {
    throw errors.insufficientFunds(
      TOKEN,
      'CASH',
      toDecimalString(held.balance, 2),
      toDecimalString(total, 2),
    );
  }

  /*
   * A split has no single rate. What the customer actually got per unit is the
   * only one that describes the trade they made, so that is what goes on the
   * receipt; `rateId` points at a published row only when exactly one was used.
   */
  const rate = payTotal === 0n ? 0n : divideRounded(total * MONEY_FACTOR, payTotal);
  const single =
    legs.cash.to === 0n ? legs.broker.quote : legs.broker.to === 0n ? legs.cash.quote : null;

  const gated = await approvalRequired(db);

  const created = await transactions.record(
    {
      type: 'USDT_SEND',
      branchId: input.branchId,
      customerId: input.customerId ?? null,
      fromCurrency: input.payCurrency,
      fromAmount: payTotal,
      toCurrency: TOKEN,
      toAmount: total,
      intake: { cash: legs.cash.from, broker: legs.broker.from },
      intakeChannel: account,
      payoutAddress: address,
      payoutWalletId: wallet.id,
      rate,
      rateId: single?.rateId ?? null,
      profitAmount: legs.cash.profit + legs.broker.profit,
      counterpartyName: input.counterpartyName ?? null,
      counterpartyPhone: input.counterpartyPhone ?? null,
      notes: input.notes ?? null,
    },
    actor,
    db,
  );

  if (!gated) return created;

  /*
   * Stamped straight after the posting rather than inside it. `record` is the
   * one path every kind of transaction goes through, and teaching it about a
   * gate that belongs to one of them would put a USDT concern in everybody
   * else's way.
   */
  await db.transaction.update({
    where: { id: created.id },
    data: { approvalState: 'PENDING' },
  });

  /*
   * Everyone who may release it, in this branch, except whoever recorded it.
   * A failed notice must not fail the sale: the money has moved, the row
   * exists, and the queue of waiting sends is on the manager's screen whether
   * or not this message arrived.
   */
  await notifications
    .notify(
      {
        severity: 'WARNING',
        eventKey: 'usdt.withdrawal.awaitingApproval',
        module: 'usdt',
        titleEn: 'A USDT send is waiting for you',
        titleAr: 'سحب USDT بانتظار موافقتك',
        bodyEn: `${created.reference}: ${toDecimalString(total, 2)} ${TOKEN} to ${address}. The coins cannot leave until you release it.`,
        bodyAr: `${created.reference}: ${toDecimalString(total, 2)} ${TOKEN} إلى ${address}. لا تخرج العملة حتى تُفرج عنها.`,
        entityType: 'Transaction',
        entityId: created.id,
        link: `/manage/withdrawals`,
        createdById: actor.id,
      },
      { permission: APPROVE_PERMISSION, branchId: input.branchId, exceptUserId: actor.id },
      db,
    )
    .catch((error) => log.warn('Approval notice failed', { id: created.id, error }));

  return created;
}

/** The wallets a withdrawal may be sent from, in the order the manager set. */
export async function sendableWallets(db: DbClient = prisma) {
  return db.wallet.findMany({
    where: { isActive: true, tokenSymbol: TOKEN },
    orderBy: [{ counterSortOrder: 'asc' }, { label: 'asc' }],
    select: { id: true, label: true, labelAr: true, network: true, address: true },
  });
}

export interface WithdrawalConfig {
  enabled: boolean;
  wallets: Awaited<ReturnType<typeof sendableWallets>>;
  /** Currencies a customer may pay with — the cash ones, not the token itself. */
  currencies: { code: string; nameEn: string; nameAr: string; symbol: string; decimals: number }[];
  transferChannels: string[];
  maxAmount: string;
}

export async function config(db: DbClient = prisma): Promise<WithdrawalConfig> {
  const [enabled, wallets, currencies, channels, maxAmount] = await Promise.all([
    settings.getBoolean('usdt.withdrawalEnabled', db),
    sendableWallets(db),
    db.currency.findMany({
      where: { isActive: true, kind: 'FIAT' },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, nameEn: true, nameAr: true, symbol: true, decimals: true },
    }),
    transferChannels(db),
    settings.getMoney('usdt.withdrawalMaxAmount', db),
  ]);

  return { enabled, wallets, currencies, transferChannels: channels, maxAmount: maxAmount.toString() };
}

// ---------------------------------------------------------------------------
// A manager releases the send
// ---------------------------------------------------------------------------

/**
 * The gate on the one step nothing can undo.
 *
 * ## Where it sits, and why there
 *
 * Not before the customer pays. A teller who had to fetch the manager before
 * taking money would have the customer standing at the window through it, and
 * two tellers could promise the same coins while nobody's balance had moved.
 * The sale is recorded exactly as it always was — the customer pays, the coins
 * come off the wallet balance, the row waits — and what the gate holds is the
 * transfer itself.
 *
 * That is the right place for it because it is the only irreversible one. Cash
 * can be handed back. A reversal can undo a posting. A transfer that has been
 * broadcast is gone, and no entry in this system or any other brings it back.
 *
 * ## What each answer means
 *
 * **Approved** — the row becomes an ordinary promise awaiting its send, and
 * whoever sends may send.
 *
 * **Declined** — the sale is reversed. The coins return to the wallet balance
 * and the customer's money comes back out of the till, because they are owed
 * it: they paid for a thing the office decided not to do. The teller hands it
 * over. Nothing is left half-done.
 *
 * ## Nobody releases their own
 *
 * The whole control is that a second person looked at the address and the
 * amount. A manager who also serves customers would otherwise release his own
 * sends with one press, which is the same as having no gate.
 */
export const APPROVE_PERMISSION = 'usdt.withdrawal.approve';

/** Whether the office is asking for a signature on sends at all. */
export async function approvalRequired(db: DbClient = prisma): Promise<boolean> {
  return settings.getBoolean('usdt.withdrawalRequiresApproval', db);
}

/**
 * Sends waiting on a manager, oldest first.
 *
 * Oldest first because the customer attached to the oldest one has been
 * waiting the longest, and a queue that shows the newest at the top quietly
 * teaches everybody to serve the impatient before the patient.
 */
export async function awaitingApproval(branchId: string | null, db: DbClient = prisma) {
  return db.transaction.findMany({
    where: {
      type: 'USDT_SEND',
      approvalState: 'PENDING',
      status: 'PENDING_TRANSFER',
      ...(branchId ? { branchId } : {}),
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      reference: true,
      createdAt: true,
      fromCurrency: true,
      fromAmount: true,
      toAmount: true,
      payoutAddress: true,
      counterpartyName: true,
      createdBy: { select: { id: true, fullNameEn: true, fullNameAr: true } },
      customer: { select: { fullNameEn: true, fullNameAr: true } },
      payoutWallet: { select: { label: true, labelAr: true, network: true } },
    },
  });
}

export interface DecisionInput {
  approve: boolean;
  /** Required on a decline: the teller has to be able to tell the customer. */
  note?: string | null;
}

export async function decide(
  id: string,
  input: DecisionInput,
  actor: Actor,
  db: DbClient = prisma,
) {
  if (!actor.permissions.includes(APPROVE_PERMISSION)) {
    throw errors.forbidden(APPROVE_PERMISSION);
  }

  const row = await db.transaction.findUnique({
    where: { id },
    select: {
      id: true,
      reference: true,
      type: true,
      status: true,
      approvalState: true,
      createdById: true,
      toAmount: true,
      payoutAddress: true,
    },
  });

  if (!row) throw errors.notFound('Transaction', id);
  if (row.type !== 'USDT_SEND') {
    throw errors.precondition('Only a USDT sale is released this way', 'errors.notAWithdrawal');
  }
  if (row.approvalState !== 'PENDING') {
    throw errors.conflict('This send has already been decided', 'errors.withdrawalDecided');
  }
  if (row.createdById === actor.id) {
    throw errors.precondition(
      'The person who recorded it cannot be the person who releases it',
      'errors.withdrawalSamePerson',
    );
  }

  if (!input.approve) {
    const reason = input.note?.trim();
    if (!reason) {
      throw errors.validation([{ path: 'note', message: 'A reason is required' }]);
    }

    /*
     * Marked before the reversal, not after. The reversal is its own posting
     * and emits its own events; a row that were reversed first would be
     * observed by all of them still claiming to be waiting on a manager.
     */
    await db.transaction.update({
      where: { id },
      data: {
        approvalState: 'DECLINED',
        approvalDecidedAt: new Date(),
        approvedById: actor.id,
        approvalNote: reason,
      },
    });

    await transactions.reverse(id, `رفض الإفراج: ${reason}`, actor, db);

    await notifications
      .notify(
        {
          severity: 'WARNING',
          eventKey: 'usdt.withdrawal.declined',
          module: 'usdt',
          titleEn: 'A USDT send was declined',
          titleAr: 'رُفض سحب USDT',
          bodyEn: `${row.reference} was reversed: ${reason}`,
          bodyAr: `${row.reference} عُكست: ${reason}`,
          entityType: 'Transaction',
          entityId: row.id,
          link: `/manage/transactions/${row.id}`,
          createdById: actor.id,
        },
        { userIds: [row.createdById] },
        db,
      )
      .catch((error) => log.warn('Decline notice failed', { id, error }));

    log.info('USDT send declined', { reference: row.reference, by: actor.id });
    return { id: row.id, reference: row.reference, approvalState: 'DECLINED' as const };
  }

  const approved = await db.transaction.update({
    where: { id },
    data: {
      approvalState: 'APPROVED',
      approvalDecidedAt: new Date(),
      approvedById: actor.id,
      approvalNote: input.note?.trim() || null,
    },
    select: { id: true, reference: true },
  });

  await audit.record(
    {
      action: 'UPDATE',
      module: 'usdt',
      entityType: 'Transaction',
      entityId: approved.id,
      summaryEn: `Released ${approved.reference} for sending: ${toDecimalString(row.toAmount, 2)} ${TOKEN} to ${row.payoutAddress ?? '—'}`,
      summaryAr: `الإفراج عن ${approved.reference} للإرسال: ${toDecimalString(row.toAmount, 2)} ${TOKEN} إلى ${row.payoutAddress ?? '—'}`,
      actor,
      after: { approvalState: 'APPROVED' },
    },
    db,
  );

  await notifications
    .notify(
      {
        severity: 'SUCCESS',
        eventKey: 'usdt.withdrawal.approved',
        module: 'usdt',
        titleEn: 'A USDT send was released',
        titleAr: 'أُفرج عن سحب USDT',
        bodyEn: `${approved.reference} may now be sent.`,
        bodyAr: `${approved.reference} صار بالإمكان إرساله.`,
        entityType: 'Transaction',
        entityId: approved.id,
        link: `/manage/transactions/${approved.id}`,
        createdById: actor.id,
      },
      { userIds: [row.createdById] },
      db,
    )
    .catch((error) => log.warn('Approval notice failed', { id, error }));

  log.info('USDT send released', { reference: approved.reference, by: actor.id });
  return { id: approved.id, reference: approved.reference, approvalState: 'APPROVED' as const };
}
