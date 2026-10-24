import 'server-only';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { divideRounded, MONEY_FACTOR, roundToDecimals, toDecimalString } from '@/core/money/money';
import * as drawers from '@/modules/drawers/drawer.service';
import { cashOwnerFor } from '@/modules/treasury/shift.service';
import * as exceptions from './price-exception.service';
import { ceilingFor } from '@/modules/users/counter-limit';
import * as settings from '@/modules/settings/settings.service';
import {
  quoteExchange,
  quoteReverse,
  type Quote,
  type RateChannel,
} from './rates.service';
import * as transactions from './transaction.service';
import type { Actor } from './transaction.service';

/**
 * The exchange machine.
 *
 * The general transaction form covers ten types and every field any of them
 * needs. That is the right shape for the work that happens once a day and the
 * wrong shape for the work that happens two hundred times: cash in one currency,
 * cash out in another, customer waiting. This module is that narrow case, and it
 * answers the two questions the form cannot — what does the customer receive if
 * they name what they hand over, and what must they hand over if they name what
 * they need — while refusing to quote at all if the drawer cannot pay.
 */

/** The cash currencies the machine trades. USDT is the counter's business. */
export const MACHINE_CURRENCIES = ['ILS', 'USD', 'JOD'] as const;
export type MachineCurrency = (typeof MACHINE_CURRENCIES)[number];

export function isMachineCurrency(value: string): value is MachineCurrency {
  return (MACHINE_CURRENCIES as readonly string[]).includes(value);
}

/** Every ordered pair the three currencies allow. */
export const MACHINE_PAIRS: [MachineCurrency, MachineCurrency][] = MACHINE_CURRENCIES.flatMap(
  (from) =>
    MACHINE_CURRENCIES.filter((to) => to !== from).map(
      (to) => [from, to] as [MachineCurrency, MachineCurrency],
    ),
);

export const pairKey = (from: string, to: string): string => `${from}/${to}`;

/**
 * The pairs the manager has enabled, as an ordered list.
 *
 * Stored as a comma-separated setting rather than a table: it is a handful of
 * fixed strings chosen from a closed set, and a table would add a migration and
 * a screen to express what one settings row already expresses.
 */
export async function enabledPairs(db: DbClient = prisma): Promise<string[]> {
  const raw = await settings.getString('machine.pairs', db);
  const allowed = new Set(MACHINE_PAIRS.map(([from, to]) => pairKey(from, to)));

  const configured = raw
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => allowed.has(entry));

  // An empty or unparseable setting means every pair, not no pairs. A typo must
  // not silently close the counter.
  return configured.length > 0 ? configured : [...allowed];
}

/**
 * Where a bank payout may be sent.
 *
 * A plain list the manager keeps, not a table: these are names on a receipt,
 * they have no properties of their own, and a settings row already expresses a
 * handful of fixed strings without adding a screen and a migration to say so.
 */
export async function transferChannels(db: DbClient = prisma): Promise<string[]> {
  const raw = await settings.getString('machine.transferChannels', db);
  return [
    ...new Set(
      raw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

export interface MachineConfig {
  enabled: boolean;
  pairs: string[];
  transferChannels: string[];
  currencies: { code: string; nameEn: string; nameAr: string; symbol: string; decimals: number }[];
  quickAmounts: number[];
  maxAmount: string;
  requireCustomerAbove: string;
}

export async function machineConfig(db: DbClient = prisma): Promise<MachineConfig> {
  const [enabled, pairs, channels, quickRaw, maxAmount, requireCustomerAbove, currencies] =
    await Promise.all([
      settings.getBoolean('machine.enabled', db),
      enabledPairs(db),
      transferChannels(db),
      settings.getString('machine.quickAmounts', db),
      settings.getMoney('machine.maxAmount', db),
      settings.getMoney('machine.requireCustomerAbove', db),
      db.currency.findMany({
        where: { code: { in: [...MACHINE_CURRENCIES] }, isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { code: true, nameEn: true, nameAr: true, symbol: true, decimals: true },
      }),
    ]);

  const quickAmounts = quickRaw
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .slice(0, 6);

  return {
    enabled,
    pairs,
    transferChannels: channels,
    currencies,
    quickAmounts,
    maxAmount: maxAmount.toString(),
    requireCustomerAbove: requireCustomerAbove.toString(),
  };
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

/**
 * How the customer is paid, and therefore which price applies.
 *
 * `SPLIT` is not a third price. It is the two others applied to two parts of
 * what the customer hands over, which is why it can only be priced forwards:
 * the total handed back is not known until the split is decided.
 */
export const PAYOUT_MODES = ['CASH', 'BROKER', 'SPLIT'] as const;
export type PayoutMode = (typeof PAYOUT_MODES)[number];

export interface MachineQuote {
  fromCurrency: string;
  toCurrency: string;
  /** The whole amount priced through the till. Null when no cash rate exists. */
  cash: Quote | null;
  /** The whole amount priced through the broker. Null when no broker rate exists. */
  broker: Quote | null;
  /** What each balance holds right now. */
  availableCash: bigint;
  availableBroker: bigint;
  /** A short balance is allowed to go below zero, so it is not a reason to stop. */
  overdraw: boolean;
  requiresCustomer: boolean;
  overLimit: boolean;
}

async function assertPairEnabled(from: string, to: string, db: DbClient): Promise<void> {
  const pairs = await enabledPairs(db);
  if (!pairs.includes(pairKey(from, to))) {
    throw errors.precondition(
      `The ${from}/${to} pair is not offered at the counter`,
      'errors.pairNotOffered',
      { pair: pairKey(from, to) },
    );
  }
}

/**
 * Prices a counter exchange through both channels at once.
 *
 * Both, because the branch charges differently depending on where the money
 * comes from and the teller decides that after seeing the two figures — asking
 * the server twice would let the board move between the two answers and quote a
 * split at prices that were never simultaneously true.
 *
 * The balances come back with the prices for the same reason they always did:
 * quoting a customer and discovering at the moment of payment that the branch
 * is short is the failure this design exists to prevent.
 */
export async function quote(
  input: {
    fromCurrency: string;
    toCurrency: string;
    /** Exactly one of these. Reverse pricing is per channel, so it needs one. */
    fromAmount?: bigint;
    toAmount?: bigint;
    /** Which channel a reverse-priced amount is quoted through. */
    reverseThrough?: RateChannel;
    branchId: string;
    /**
     * Who is asking. A teller on shift must be shown what *their* drawer holds,
     * not the office's — quoting against the treasury would offer them money
     * they cannot hand over.
     */
    actorId?: string;
  },
  db: DbClient = prisma,
): Promise<MachineQuote> {
  if (!isMachineCurrency(input.fromCurrency) || !isMachineCurrency(input.toCurrency)) {
    throw errors.precondition(
      'The machine trades shekels, dollars and dinars only',
      'errors.notAMachineCurrency',
    );
  }
  await assertPairEnabled(input.fromCurrency, input.toCurrency, db);

  if ((input.fromAmount === undefined) === (input.toAmount === undefined)) {
    throw errors.validation([
      { path: 'amount', message: 'Give either the amount paid or the amount received' },
    ]);
  }

  /*
   * A reverse-priced amount is sized against one channel's rate, then both
   * channels are priced on the result. So the teller who types "the customer
   * needs 500" still sees what that costs each way.
   */
  const fromAmount =
    input.fromAmount ??
    (
      await quoteReverse(
        input.fromCurrency,
        input.toCurrency,
        input.toAmount!,
        input.reverseThrough ?? 'CASH',
        db,
      )
    ).fromAmount;

  const owner = input.actorId ? await cashOwnerFor(input.actorId, db) : drawers.TREASURY;

  const [cash, broker, cashHeld, brokerHeld, maxAmount, requireCustomerAbove, overdraw] = await Promise.all([
    priceOrNull(input.fromCurrency, input.toCurrency, fromAmount, 'CASH', db),
    priceOrNull(input.fromCurrency, input.toCurrency, fromAmount, 'BROKER', db),
    drawers.canPay(input.toCurrency, 0n, 'CASH', db, owner),
    drawers.canPay(input.toCurrency, 0n, 'BROKER', db),
    // The person's own ceiling if they have a tighter one, so they are told
    // before they read a figure aloud rather than after they press record.
    input.actorId
      ? ceilingFor(input.actorId, await settings.getMoney('machine.maxAmount', db), db)
      : settings.getMoney('machine.maxAmount', db),
    settings.getMoney('machine.requireCustomerAbove', db),
    // Whether a short balance stops the payout at all. When the office allows
    // going below zero, the screen must not warn about a shortfall the server
    // will accept.
    drawers.overdrawAllowed(input.toCurrency, db),
  ]);

  // Limits are read against what the customer hands over, which is the figure
  // the branch is exposed to regardless of which way the teller typed it.
  return {
    fromCurrency: input.fromCurrency,
    toCurrency: input.toCurrency,
    cash,
    broker,
    availableCash: cashHeld.balance,
    availableBroker: brokerHeld.balance,
    overdraw,
    overLimit: maxAmount > 0n && fromAmount > maxAmount,
    requiresCustomer: requireCustomerAbove > 0n && fromAmount >= requireCustomerAbove,
  };
}

/**
 * A price, or nothing.
 *
 * A missing rate for one channel is an ordinary state — a branch may publish a
 * till price and no broker price — so it is not an error, and the teller is
 * simply not offered that way of paying.
 */
async function priceOrNull(
  from: string,
  to: string,
  amount: bigint,
  channel: RateChannel,
  db: DbClient,
): Promise<Quote | null> {
  try {
    return await quoteExchange(from, to, amount, channel, db);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface MachineRecordInput {
  fromCurrency: string;
  toCurrency: string;
  /** How the payout leaves the branch. */
  mode: PayoutMode;
  /** What the customer hands over. Required for a split. */
  fromAmount?: bigint;
  /** What the customer takes away — single channel only. */
  toAmount?: bigint;
  /**
   * For a split: how much the customer wants **transferred**, in the currency
   * they are taking away.
   *
   * Named on the payout side because that is the side the customer names. They
   * say "put two hundred shekels in my account" — the figure that will appear
   * on their statement — not "seventy dollars of what I am handing you". The
   * transfer instruction is therefore exact, and the notes counted out are
   * whatever the rest of their money buys at the till's own price.
   */
  brokerPayout?: bigint;
  /** Which of the broker's accounts the transfer is instructed to. */
  payoutChannel?: string | null;
  branchId: string;
  /**
   * An approval to break the board, granted for this deal.
   *
   * The id, never a rate: the server reads the price from the approval, so a
   * screen that was left open or edited cannot name its own.
   */
  priceExceptionId?: string | null;
  customerId?: string | null;
  counterpartyName?: string | null;
  counterpartyPhone?: string | null;
  notes?: string | null;
}

/**
 * Prices and posts in one call.
 *
 * The price is taken here rather than trusted from the browser, so the receipt
 * cannot disagree with the ledger even if the screen was left open while the
 * board moved. Each leg is priced through its own channel: a split is two
 * trades at two prices settled as one transaction, not one trade divided.
 */
export async function record(input: MachineRecordInput, actor: Actor, db: DbClient = prisma) {
  if (!(await settings.getBoolean('machine.enabled', db))) {
    throw errors.precondition('The exchange machine is switched off', 'errors.machineDisabled');
  }

  /*
   * One transaction around the whole thing, because of the approval.
   *
   * Spending a broken price and posting the deal it was spent on have to be the
   * same event: claimed first and posted after, a failure between them burns an
   * approval on a deal that never happened; posted first and claimed after, two
   * screens can trade on one approval. Inside a transaction neither is
   * possible, and the claim is a conditional update so the loser of a race gets
   * nothing rather than a second copy.
   */
  return withTransaction((tx) => post(input, actor, tx), db);
}

async function post(input: MachineRecordInput, actor: Actor, db: DbClient) {
  const forced = input.priceExceptionId ? await claimForDeal(input, actor, db) : null;

  const legs = await priceLegs(input, db, forced);
  const total = legs.cash.to + legs.broker.to;
  const fromTotal = legs.cash.from + legs.broker.from;

  if (total <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }

  const [officeLimit, requireCustomerAbove] = await Promise.all([
    settings.getMoney('machine.maxAmount', db),
    settings.getMoney('machine.requireCustomerAbove', db),
  ]);
  // The office's ceiling or this person's, whichever binds first.
  const maxAmount = await ceilingFor(actor.id, officeLimit, db);

  if (maxAmount > 0n && fromTotal > maxAmount) {
    throw errors.precondition(
      `The counter limit is ${toDecimalString(maxAmount, 2)} ${input.fromCurrency}`,
      'errors.machineOverLimit',
      { maximum: toDecimalString(maxAmount, 2), currency: input.fromCurrency },
    );
  }
  if (requireCustomerAbove > 0n && fromTotal >= requireCustomerAbove && !input.customerId) {
    throw errors.precondition(
      'This amount requires a registered customer',
      'errors.customerRequired',
    );
  }

  /*
   * Where the transfer is instructed to, checked against the list the manager
   * keeps. Required whenever the broker is paying any of it: the office keeps
   * no ledger per account, but the instruction that leaves for the broker has
   * to say which one, and this is where that is captured.
   */
  let account: string | null = null;
  if (legs.broker.to > 0n) {
    const allowed = await transferChannels(db);
    account = input.payoutChannel?.trim() ?? '';

    if (!account) {
      throw errors.precondition('Say where the transfer is going', 'errors.transferChannelRequired');
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
   * Each leg against its own balance, before anything is promised. Failing here
   * means the teller is told which balance is short and by how much, rather
   * than reading a posting error after quoting a figure aloud.
   */
  const cashOwner = await cashOwnerFor(actor.id, db);

  for (const [kind, amount] of [
    ['CASH', legs.cash.to],
    ['BROKER', legs.broker.to],
  ] as const) {
    if (amount <= 0n) continue;
    // The teller pays from their own drawer; the broker balance is the office's.
    const held = await drawers.canPay(
      input.toCurrency,
      amount,
      kind,
      db,
      kind === 'CASH' ? cashOwner : drawers.TREASURY,
    );
    if (!held.ok) {
      throw errors.insufficientFunds(
        input.toCurrency,
        kind,
        toDecimalString(held.balance, 2),
        toDecimalString(amount, 2),
      );
    }
  }

  /*
   * A split has no single rate. The blended one — what the customer actually
   * got per unit — is what belongs on the receipt, because it is the only rate
   * that describes the trade they made. `rateId` points at a published row only
   * when exactly one was used.
   */
  const rate = blendedRate(fromTotal, total);
  const single = legs.cash.to === 0n ? legs.broker.quote : legs.broker.to === 0n ? legs.cash.quote : null;

  const posted = await transactions.record(
    {
      type: 'EXCHANGE',
      branchId: input.branchId,
      customerId: input.customerId ?? null,
      fromCurrency: input.fromCurrency,
      fromAmount: fromTotal,
      toCurrency: input.toCurrency,
      toAmount: total,
      payout: { cash: legs.cash.to, bank: legs.broker.to },
      payoutChannel: account,
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

  // Stamped on the deal, which is the fourth leash: the concession is read
  // where the transaction is read, not only in a list somebody must think to
  // open.
  if (input.priceExceptionId && forced) {
    await exceptions.stamp(
      input.priceExceptionId,
      posted.id,
      // What the customer got over and above the board, on the leg the approval
      // priced — which is exactly what the office gave up.
      {
        amount: ((forced.rate - forced.boardRate) * forced.covered) / 100000000n,
        currency: input.toCurrency,
      },
      db,
    );
  }

  return posted;
}

/**
 * Spends the approval, having checked it belongs to this deal.
 *
 * The channel compared is **the deal's**, not the approval's. Reading it off
 * the approval would make the comparison a tautology and quietly retire one of
 * the four leashes: a price granted for notes out of the till would then also
 * buy a transfer through the broker, which is a different price entirely.
 *
 * A split is the one case where both channels are genuinely running, so there
 * the approval prices its own leg and the amount it is checked against is that
 * leg's share rather than the whole deal.
 */
async function claimForDeal(
  input: MachineRecordInput,
  actor: Actor,
  db: DbClient,
): Promise<{ channel: RateChannel; rate: bigint; boardRate: bigint; covered: bigint }> {
  const approvedFor = await channelOfException(input.priceExceptionId!, db);

  let channel: RateChannel;
  let covered: bigint;

  if (input.mode === 'SPLIT') {
    if (input.fromAmount === undefined) {
      throw errors.precondition(
        'A split is priced from what the customer hands over',
        'errors.splitNeedsPayAmount',
      );
    }
    /*
     * The approval's cap is checked against what the leg costs at the board.
     * Priced here purely to have a figure to check against; the deal itself is
     * priced again, at the granted rate, when the legs are built.
     */
    const brokerFrom =
      input.brokerPayout && input.brokerPayout > 0n
        ? (
            await quoteReverse(
              input.fromCurrency,
              input.toCurrency,
              input.brokerPayout,
              'BROKER',
              db,
            )
          ).fromAmount
        : 0n;

    channel = approvedFor;
    covered = approvedFor === 'BROKER' ? brokerFrom : input.fromAmount - brokerFrom;
  } else {
    channel = input.mode === 'BROKER' ? 'BROKER' : 'CASH';
    covered =
      input.fromAmount ??
      /*
       * Priced backwards from what the customer wants to receive, so what they
       * hand over is not known until the board has been read. Priced here at
       * the board purely to have a figure to check the cap against; the deal
       * itself is priced again, at the granted rate, below.
       */
      (await quoteReverse(input.fromCurrency, input.toCurrency, input.toAmount!, channel, db))
        .fromAmount;
  }

  const claimed = await exceptions.claim(
    {
      id: input.priceExceptionId!,
      fromCurrency: input.fromCurrency,
      toCurrency: input.toCurrency,
      channel,
      fromAmount: covered,
    },
    actor,
    db,
  );

  return { channel, covered, ...claimed };
}

async function channelOfException(id: string, db: DbClient): Promise<RateChannel> {
  const row = await db.priceException.findUnique({ where: { id }, select: { channel: true } });
  if (!row) throw errors.notFound('PriceException', id);
  return row.channel === 'BROKER' ? 'BROKER' : 'CASH';
}

interface Leg {
  from: bigint;
  to: bigint;
  profit: bigint;
  quote: Quote | null;
}

/** An empty leg — this channel pays none of it. */
const NO_LEG: Leg = { from: 0n, to: 0n, profit: 0n, quote: null };

/**
 * Splits what the customer hands over and prices each part at its own channel.
 *
 * The split is expressed on the side the customer pays, which is the only side
 * that can carry it: the amount handed back is not known until both parts have
 * been priced, so it cannot be the thing divided.
 */
async function priceLegs(
  input: MachineRecordInput,
  db: DbClient,
  /** A price granted for one channel, applied only to that channel's leg. */
  forced: { channel: RateChannel; rate: bigint } | null = null,
): Promise<{ cash: Leg; broker: Leg }> {
  const rateFor = (channel: RateChannel) =>
    forced && forced.channel === channel ? forced.rate : undefined;

  const price = async (amount: bigint, channel: RateChannel): Promise<Leg> => {
    const quoted = await quoteExchange(
      input.fromCurrency,
      input.toCurrency,
      amount,
      channel,
      db,
      rateFor(channel),
    );
    return { from: quoted.fromAmount, to: quoted.toAmount, profit: quoted.profit, quote: quoted };
  };

  if (input.mode !== 'SPLIT') {
    const channel: RateChannel = input.mode === 'BROKER' ? 'BROKER' : 'CASH';

    const quoted =
      input.fromAmount !== undefined
        ? await quoteExchange(
            input.fromCurrency,
            input.toCurrency,
            input.fromAmount,
            channel,
            db,
            rateFor(channel),
          )
        : await quoteReverse(
            input.fromCurrency,
            input.toCurrency,
            input.toAmount!,
            channel,
            db,
            rateFor(channel),
          );

    const leg: Leg = {
      from: quoted.fromAmount,
      to: quoted.toAmount,
      profit: quoted.profit,
      quote: quoted,
    };
    return channel === 'BROKER' ? { cash: NO_LEG, broker: leg } : { cash: leg, broker: NO_LEG };
  }

  // --- A split ---------------------------------------------------------------
  if (input.fromAmount === undefined) {
    throw errors.precondition(
      'A split is priced from what the customer hands over',
      'errors.splitNeedsPayAmount',
    );
  }

  const wanted = input.brokerPayout ?? 0n;
  if (wanted <= 0n) {
    throw errors.precondition(
      'The transferred share must be part of the amount, not all or none of it',
      'errors.splitShareOutOfRange',
    );
  }

  /*
   * The transfer is sized backwards from the figure the customer named, so it
   * lands on their statement as exactly that. What it costs them is whatever
   * the broker's price makes it, and the till takes the remainder.
   */
  const brokerLeg = await quoteReverse(
    input.fromCurrency,
    input.toCurrency,
    wanted,
    'BROKER',
    db,
    rateFor('BROKER'),
  );

  const cashFrom = input.fromAmount - brokerLeg.fromAmount;
  if (cashFrom <= 0n) {
    throw errors.precondition(
      'That transfer costs more than the customer is handing over',
      'errors.splitOverPay',
    );
  }

  const priced = await price(cashFrom, 'CASH');

  /*
   * What the till pays is what the rest of the customer's money buys — the
   * rest before the transfer's cost was rounded, not after.
   *
   * 300 dollars at 2.90 with 70 shekels transferred: the transfer costs
   * 24.1379…, which the dollar expresses as 24.14, and 275.86 at 2.90 is
   * 799.994 → 799.99. Rounded twice, the customer walked away with 869.99 for
   * 300 dollars at a price that makes 870.00. Priced from the unrounded cost,
   * the till pays 800.00 and the two legs add up to what the board promises.
   */
  const target = await db.currency.findUnique({
    where: { code: input.toCurrency },
    select: { decimals: true },
  });
  const brokerRate = brokerLeg.rate;
  const cashRate = priced.quote?.rate ?? 0n;
  const exactTo =
    brokerRate > 0n && cashRate > 0n
      ? roundToDecimals(
          divideRounded(
            (input.fromAmount * brokerRate - wanted * MONEY_FACTOR) * cashRate,
            brokerRate * MONEY_FACTOR,
          ),
          target?.decimals ?? 2,
        )
      : priced.to;
  const cash: Leg = {
    ...priced,
    to: exactTo,
    // the spread moves by the same hundredth the payout does
    profit: priced.profit - (exactTo - priced.to),
  };

  /*
   * The transfer pays out exactly what was named, not what the rounded cost
   * re-multiplies to.
   *
   * Sizing 200.00 backwards through 2.85 costs 70.175…, which the dollar can
   * only express as 70.18 — and 70.18 back through 2.85 is 200.01. Posting
   * that would put a figure on the customer's statement that nobody asked for
   * and nobody can explain. So the office absorbs the fraction of a piastre,
   * which is what it already does on every rounding in this system, and the
   * instruction that leaves for the broker says the figure the customer named.
   */
  const broker: Leg = {
    from: brokerLeg.fromAmount,
    to: wanted,
    profit: brokerLeg.profit,
    quote: brokerLeg,
  };

  return { cash, broker };
}

/**
 * What the customer got per unit, across both legs.
 *
 * Scaled the same way every rate in this system is, and rounded once at the
 * end — deriving it from the two published rates weighted by their shares would
 * round twice and drift from the figures actually posted.
 */
function blendedRate(fromTotal: bigint, toTotal: bigint): bigint {
  if (fromTotal === 0n) return 0n;
  return divideRounded(toTotal * MONEY_FACTOR, fromTotal);
}
