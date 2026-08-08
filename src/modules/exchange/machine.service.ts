import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import * as drawers from '@/modules/drawers/drawer.service';
import * as settings from '@/modules/settings/settings.service';
import { quoteExchange, quoteReverse, type Quote } from './rates.service';
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
  (from) => MACHINE_CURRENCIES.filter((to) => to !== from).map((to) => [from, to] as [MachineCurrency, MachineCurrency]),
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

export interface MachineConfig {
  enabled: boolean;
  pairs: string[];
  currencies: { code: string; nameEn: string; nameAr: string; symbol: string; decimals: number }[];
  quickAmounts: number[];
  maxAmount: string;
  requireCustomerAbove: string;
}

export async function machineConfig(db: DbClient = prisma): Promise<MachineConfig> {
  const [enabled, pairs, quickRaw, maxAmount, requireCustomerAbove, currencies] = await Promise.all([
    settings.getBoolean('machine.enabled', db),
    enabledPairs(db),
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
    currencies,
    quickAmounts,
    maxAmount: maxAmount.toString(),
    requireCustomerAbove: requireCustomerAbove.toString(),
  };
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

export interface MachineQuote {
  quote: Quote;
  /** Whether the branch can actually pay this out right now. */
  available: boolean;
  availableAmount: bigint;
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
 * Prices a counter exchange and checks it can be honoured.
 *
 * The drawer check is the reason this exists rather than a bare call to the
 * rates service. Quoting a customer and discovering at the moment of payment
 * that the branch is short is the failure this design is meant to prevent — the
 * teller learns before the number leaves their mouth.
 */
export async function quote(
  input: {
    fromCurrency: string;
    toCurrency: string;
    /** Exactly one of these. */
    fromAmount?: bigint;
    toAmount?: bigint;
    branchId: string;
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

  const priced =
    input.fromAmount !== undefined
      ? await quoteExchange(input.fromCurrency, input.toCurrency, input.fromAmount, db)
      : await quoteReverse(input.fromCurrency, input.toCurrency, input.toAmount!, db);

  const [maxAmount, requireCustomerAbove] = await Promise.all([
    settings.getMoney('machine.maxAmount', db),
    settings.getMoney('machine.requireCustomerAbove', db),
  ]);

  // Limits are read against what the customer hands over, which is the figure
  // the branch is exposed to regardless of which way the teller typed it.
  const overLimit = maxAmount > 0n && priced.fromAmount > maxAmount;
  const requiresCustomer = requireCustomerAbove > 0n && priced.fromAmount >= requireCustomerAbove;

  // The same question the recording path will ask, asked here first so a green
  // light cannot become a failed posting a second later.
  const payout = await drawers.canPay(input.toCurrency, priced.toAmount, db);

  return {
    quote: priced,
    available: payout.ok,
    availableAmount: payout.balance,

    requiresCustomer,
    overLimit,
  };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface MachineRecordInput {
  fromCurrency: string;
  toCurrency: string;
  fromAmount?: bigint;
  toAmount?: bigint;
  branchId: string;
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
 * board moved. The teller sees the posted figures and can reverse if the
 * customer no longer agrees — which is the same recourse every other posting
 * has.
 */
export async function record(input: MachineRecordInput, actor: Actor, db: DbClient = prisma) {
  if (!(await settings.getBoolean('machine.enabled', db))) {
    throw errors.precondition('The exchange machine is switched off', 'errors.machineDisabled');
  }

  const priced = await quote(
    {
      fromCurrency: input.fromCurrency,
      toCurrency: input.toCurrency,
      fromAmount: input.fromAmount,
      toAmount: input.toAmount,
      branchId: input.branchId,
    },
    db,
  );

  if (priced.overLimit) {
    const maximum = await settings.getMoney('machine.maxAmount', db);
    throw errors.precondition(
      `The counter limit is ${toDecimalString(maximum, 2)} ${input.fromCurrency}`,
      'errors.machineOverLimit',
      { maximum: toDecimalString(maximum, 2), currency: input.fromCurrency },
    );
  }
  if (priced.requiresCustomer && !input.customerId) {
    throw errors.precondition(
      'This amount requires a registered customer',
      'errors.customerRequired',
    );
  }

  // The drawer refuses this again on the way through. Failing here means the
  // teller is told the drawer and the shortfall rather than reading a posting
  // error, and the customer has not been quoted a figure first.
  if (!priced.available) {
    throw errors.insufficientFunds(
      `The ${input.toCurrency} drawer`,
      `${toDecimalString(priced.availableAmount, 2)} ${input.toCurrency}`,
      `${toDecimalString(priced.quote.toAmount, 2)} ${input.toCurrency}`,
    );
  }

  return transactions.record(
    {
      type: 'EXCHANGE',
      branchId: input.branchId,
      customerId: input.customerId ?? null,
      fromCurrency: input.fromCurrency,
      fromAmount: priced.quote.fromAmount,
      toCurrency: input.toCurrency,
      toAmount: priced.quote.toAmount,
      rate: priced.quote.rate,
      rateId: priced.quote.rateId,
      profitAmount: priced.quote.profit,
      counterpartyName: input.counterpartyName ?? null,
      counterpartyPhone: input.counterpartyPhone ?? null,
      notes: input.notes ?? null,
    },
    actor,
    db,
  );
}
