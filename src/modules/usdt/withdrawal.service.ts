import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString, MONEY_FACTOR, divideRounded } from '@/core/money/money';
import { quoteExchange, type Quote, type RateChannel } from '@/modules/exchange/rates.service';
import { transferChannels } from '@/modules/exchange/machine.service';
import * as drawers from '@/modules/drawers/drawer.service';
import * as transactions from '@/modules/exchange/transaction.service';
import type { Actor } from '@/modules/exchange/transaction.service';
import * as settings from '@/modules/settings/settings.service';
import { providerFor } from './providers';

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
  input: { payCurrency: string; payAmount: bigint },
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

  const [cash, broker, held] = await Promise.all([
    price('CASH'),
    price('BROKER'),
    drawers.canPay(TOKEN, 0n, 'CASH', db),
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

  const maximum = await settings.getMoney('usdt.withdrawalMaxAmount', db);
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
  const held = await drawers.canPay(TOKEN, total, 'CASH', db);
  if (!held.ok) {
    throw errors.insufficientFunds(
      `The ${TOKEN} balance`,
      `${toDecimalString(held.balance, 2)} ${TOKEN}`,
      `${toDecimalString(total, 2)} ${TOKEN}`,
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

  return transactions.record(
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
