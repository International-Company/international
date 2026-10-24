import 'server-only';
import { HOME_CURRENCY } from '@/lib/home-currency';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { convert, divideRounded, invertRate, MONEY_FACTOR } from '@/core/money/money';
import { emitAsync } from '@/core/events/bus';
import * as audit from '@/modules/audit/audit.service';

/**
 * Exchange rates.
 *
 * A rate row is never edited. Publishing a new rate closes the previous one by
 * stamping `effectiveTo`, so the table is simultaneously the current rate board
 * and a complete, auditable history — you can always answer "what rate was in
 * force at 14:32 last Tuesday", which is the question that arises whenever a
 * customer disputes a receipt.
 *
 * Direction convention for a pair BASE/QUOTE:
 *   buyRate  — the company BUYS 1 BASE and pays `buyRate` QUOTE
 *   sellRate — the company SELLS 1 BASE and receives `sellRate` QUOTE
 * so `sellRate >= buyRate`, and the spread between them is the desk's margin.
 *
 * A pair does not have one rate. The counter charges differently depending on
 * where the money comes from — notes out of the till, or a transfer through the
 * broker — so every rate belongs to a channel, and asking for "the USD/ILS rate"
 * without saying which is an incomplete question. Every function below takes the
 * channel, and defaults to the till, which is what the overwhelming majority of
 * trades are.
 */

/** Where the money is paid out of, and therefore which price applies. */
export const RATE_CHANNELS = ['CASH', 'BROKER'] as const;
export type RateChannel = (typeof RATE_CHANNELS)[number];

export interface RateInput {
  baseCode: string;
  quoteCode: string;
  /** Defaults to the till. */
  channel?: RateChannel;
  buyRate: bigint;
  sellRate: bigint;
  note?: string;
  source?: string;
  providerRef?: string;
}

export interface ActiveRate {
  id: string;
  baseCode: string;
  quoteCode: string;
  channel: RateChannel;
  buyRate: bigint;
  sellRate: bigint;
  midRate: bigint;
  effectiveFrom: Date;
  source: string;
}

/** Returns the rate in force for a pair, or null. Does not consider inversion. */
export async function getActiveRate(
  baseCode: string,
  quoteCode: string,
  channel: RateChannel = 'CASH',
  db: DbClient = prisma,
): Promise<ActiveRate | null> {
  const row = await db.exchangeRate.findFirst({
    where: { baseCode, quoteCode, channel, isActive: true, effectiveTo: null },
    orderBy: { effectiveFrom: 'desc' },
  });
  return row ? toActiveRate(row) : null;
}

function toActiveRate(row: {
  id: string;
  baseCode: string;
  quoteCode: string;
  channel: string;
  buyRate: bigint;
  sellRate: bigint;
  midRate: bigint;
  effectiveFrom: Date;
  source: string;
}): ActiveRate {
  return {
    id: row.id,
    baseCode: row.baseCode,
    quoteCode: row.quoteCode,
    channel: row.channel as RateChannel,
    buyRate: row.buyRate,
    sellRate: row.sellRate,
    midRate: row.midRate,
    effectiveFrom: row.effectiveFrom,
    source: row.source,
  };
}

export async function listActiveRates(db: DbClient = prisma): Promise<ActiveRate[]> {
  const rows = await db.exchangeRate.findMany({
    where: { isActive: true, effectiveTo: null },
    orderBy: [{ baseCode: 'asc' }, { quoteCode: 'asc' }],
  });
  return rows.map(toActiveRate);
}

/**
 * Publishes a new rate, superseding the current one for the pair.
 * Both operations happen in one transaction so the board is never briefly
 * without a rate for a pair that is actively being traded.
 */
export async function publishRate(
  input: RateInput,
  actor: { id: string; name: string; ip?: string | null; sessionId?: string },
  db: DbClient = prisma,
): Promise<ActiveRate> {
  if (input.baseCode === input.quoteCode) {
    throw errors.precondition('Base and quote currency must differ', 'errors.sameCurrencyPair');
  }
  if (input.buyRate <= 0n || input.sellRate <= 0n) {
    throw errors.precondition('Rates must be greater than zero', 'errors.rateNotPositive');
  }
  if (input.sellRate < input.buyRate) {
    throw errors.precondition(
      'Sell rate must not be below buy rate — that would guarantee a loss on every trade',
      'errors.invertedSpread',
    );
  }

  /*
   * The shekel is never the base. "ILS/USD 2.90" is what a dollar price looks
   * like typed into the wrong way round, and the engine would honour it: 100
   * shekels for 290 dollars. The price belongs on USD/ILS, where 2.90 means
   * what whoever typed it meant.
   */
  if (input.baseCode === HOME_CURRENCY) {
    throw errors.precondition(
      `${HOME_CURRENCY} is the home currency and is always the quote — publish ${input.quoteCode}/${HOME_CURRENCY}`,
      'errors.homeCurrencyBase',
      { pair: `${input.quoteCode}/${HOME_CURRENCY}` },
    );
  }

  const channel = input.channel ?? 'CASH';

  return withTransaction(async (tx) => {
    const [base, quote] = await Promise.all([
      tx.currency.findUnique({ where: { code: input.baseCode } }),
      tx.currency.findUnique({ where: { code: input.quoteCode } }),
    ]);
    if (!base) throw errors.notFound('Currency', input.baseCode);
    if (!quote) throw errors.notFound('Currency', input.quoteCode);

    const now = new Date();

    const previous = await tx.exchangeRate.findFirst({
      where: {
        baseCode: input.baseCode,
        quoteCode: input.quoteCode,
        // Only this channel's rate is superseded. Publishing a broker price
        // must not silently retire the till price for the same pair.
        channel,
        isActive: true,
        effectiveTo: null,
      },
      orderBy: { effectiveFrom: 'desc' },
    });

    if (previous) {
      await tx.exchangeRate.update({
        where: { id: previous.id },
        data: { effectiveTo: now, isActive: false },
      });
    }

    // One pair, one way round, per channel: publishing USD/JOD retires a live
    // JOD/USD for the same channel, so the two can never disagree.
    await tx.exchangeRate.updateMany({
      where: {
        baseCode: input.quoteCode,
        quoteCode: input.baseCode,
        channel,
        isActive: true,
        effectiveTo: null,
      },
      data: { effectiveTo: now, isActive: false },
    });

    const created = await tx.exchangeRate.create({
      data: {
        baseCode: input.baseCode,
        quoteCode: input.quoteCode,
        channel,
        buyRate: input.buyRate,
        sellRate: input.sellRate,
        midRate: divideRounded(input.buyRate + input.sellRate, 2n),
        source: input.source ?? 'MANUAL',
        providerRef: input.providerRef ?? null,
        effectiveFrom: now,
        note: input.note ?? null,
        createdById: actor.id,
      },
    });

    await audit.record(
      {
        action: 'RATE_CHANGE',
        module: 'exchange',
        entityType: 'ExchangeRate',
        entityId: created.id,
        summaryEn: `Rate ${input.baseCode}/${input.quoteCode} set to buy ${fmt(input.buyRate)} / sell ${fmt(input.sellRate)}`,
        summaryAr: `تم تحديث سعر ${input.baseCode}/${input.quoteCode} شراء ${fmt(input.buyRate)} / بيع ${fmt(input.sellRate)}`,
        actor,
        before: previous
          ? { buyRate: previous.buyRate.toString(), sellRate: previous.sellRate.toString() }
          : null,
        after: { buyRate: input.buyRate.toString(), sellRate: input.sellRate.toString() },
      },
      tx,
    );

    emitAsync('rate.changed', {
      baseCode: input.baseCode,
      quoteCode: input.quoteCode,
      rateId: created.id,
      actorId: actor.id,
    });

    return toActiveRate(created);
  }, db);
}

/**
 * Takes a live rate off the board, with nothing in its place.
 *
 * For a price that should never have been published — a shekel-based row
 * above all — rather than one being updated, which is what publishing does.
 * The row stays in the history; only its life ends.
 */
export async function retireRate(
  id: string,
  actor: { id: string; name: string; ip?: string | null; sessionId?: string },
  db: DbClient = prisma,
): Promise<{ retired: true }> {
  const row = await db.exchangeRate.findUnique({ where: { id } });
  if (!row) throw errors.notFound('ExchangeRate', id);
  if (!row.isActive || row.effectiveTo) return { retired: true };

  await db.exchangeRate.update({
    where: { id },
    data: { isActive: false, effectiveTo: new Date() },
  });
  await audit.record(
    {
      action: 'RATE_CHANGE',
      module: 'exchange',
      entityType: 'ExchangeRate',
      entityId: id,
      summaryEn: `Rate ${row.baseCode}/${row.quoteCode} (${row.channel}) taken off the board`,
      summaryAr: `إيقاف سعر ${row.baseCode}/${row.quoteCode} (${row.channel === 'BROKER' ? 'بنك' : 'نقداً'})`,
      actor,
      before: { buyRate: row.buyRate.toString(), sellRate: row.sellRate.toString() },
      after: null,
    },
    db,
  );
  emitAsync('rate.changed', {
    baseCode: row.baseCode,
    quoteCode: row.quoteCode,
    rateId: id,
    actorId: actor.id,
  });
  return { retired: true };
}

function fmt(rate: bigint): string {
  return (Number(rate) / Number(MONEY_FACTOR)).toFixed(4);
}

export async function rateHistory(
  filter: { baseCode?: string; quoteCode?: string; from?: Date; to?: Date; limit?: number },
  db: DbClient = prisma,
) {
  return db.exchangeRate.findMany({
    where: {
      ...(filter.baseCode ? { baseCode: filter.baseCode } : {}),
      ...(filter.quoteCode ? { quoteCode: filter.quoteCode } : {}),
      ...(filter.from || filter.to
        ? {
            effectiveFrom: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lte: filter.to } : {}),
            },
          }
        : {}),
    },
    orderBy: { effectiveFrom: 'desc' },
    take: Math.min(1000, filter.limit ?? 200),
    include: { createdBy: { select: { fullNameEn: true, fullNameAr: true } } },
  });
}

/** The rate that was in force at a given instant — for disputes and reprints. */
export async function rateAt(
  baseCode: string,
  quoteCode: string,
  at: Date,
  db: DbClient = prisma,
): Promise<ActiveRate | null> {
  const row = await db.exchangeRate.findFirst({
    where: {
      baseCode,
      quoteCode,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  return row ? toActiveRate(row) : null;
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

export interface Quote {
  fromCurrency: string;
  toCurrency: string;
  fromAmount: bigint;
  toAmount: bigint;
  /** Applied rate expressed as: 1 fromCurrency = `rate` toCurrency. */
  rate: bigint;
  midRate: bigint;
  rateId: string;
  /** Which side of the board was used, from the company's perspective. */
  side: 'BUY' | 'SELL';
  /** Whether the stored pair had to be inverted to serve this direction. */
  inverted: boolean;
  /** Spread earned versus the mid rate, in `toCurrency`. Positive = company gains. */
  profit: bigint;
}

/**
 * Prices a conversion.
 *
 * A pair may be stored in either direction; the customer can trade either way.
 * When the stored pair matches the requested direction the company is buying
 * the customer's currency, so the buy side applies. When it is reversed the
 * company is selling, so the sell side applies and the rate is inverted. Using
 * the wrong side is the classic way a desk loses the spread on half its trades,
 * so the resolution is centralised here rather than left to call sites.
 */
export async function quoteExchange(
  fromCurrency: string,
  toCurrency: string,
  fromAmount: bigint,
  channel: RateChannel = 'CASH',
  db: DbClient = prisma,
  /**
   * A price the manager granted for this one deal, replacing the board's.
   *
   * The board is still read: the mid, the row id and which side was used all
   * stay as they were, so the margin given up shows as a smaller `profit`
   * rather than disappearing from the record. Only the applied rate changes.
   *
   * Never reachable from a request body — see `price-exception.service`.
   */
  forcedRate?: bigint,
): Promise<Quote> {
  if (fromCurrency === toCurrency) {
    throw errors.precondition('Source and target currency must differ', 'errors.sameCurrencyPair');
  }
  if (fromAmount <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }

  const target = await db.currency.findUnique({ where: { code: toCurrency } });
  if (!target) throw errors.notFound('Currency', toCurrency);
  const targetDecimals = target.decimals;

  // Direct: pair is stored as FROM/TO. Company buys FROM.
  //
  // A row with the shekel as its base is never read: it can only have been
  // published the wrong way round (see `publishRate`), and honouring one paid
  // out dollars at the dollar's own price per shekel.
  const direct =
    fromCurrency === HOME_CURRENCY
      ? null
      : await getActiveRate(fromCurrency, toCurrency, channel, db);
  if (direct) {
    const applied = forcedRate ?? direct.buyRate;
    const toAmount = convert(fromAmount, applied, targetDecimals);
    const atMid = convert(fromAmount, direct.midRate, targetDecimals);
    return {
      fromCurrency,
      toCurrency,
      fromAmount,
      toAmount,
      rate: applied,
      midRate: direct.midRate,
      rateId: direct.id,
      side: 'BUY',
      inverted: false,
      profit: atMid - toAmount,
    };
  }

  // Reverse: pair is stored as TO/FROM. Company sells TO, so invert the sell side.
  const reverse =
    toCurrency === HOME_CURRENCY
      ? null
      : await getActiveRate(toCurrency, fromCurrency, channel, db);
  if (reverse) {
    const rate = forcedRate ?? invertRate(reverse.sellRate);
    const midInverted = invertRate(reverse.midRate);
    const toAmount = convert(fromAmount, rate, targetDecimals);
    const atMid = convert(fromAmount, midInverted, targetDecimals);
    return {
      fromCurrency,
      toCurrency,
      fromAmount,
      toAmount,
      rate,
      midRate: midInverted,
      rateId: reverse.id,
      side: 'SELL',
      inverted: true,
      profit: atMid - toAmount,
    };
  }

  throw errors.rateUnavailable(`${fromCurrency}/${toCurrency}`);
}

/**
 * Prices a conversion from the amount the customer wants to *receive*.
 *
 * Customers ask both ways. "Here is 500 dollars" is `quoteExchange`; "I need
 * exactly 2,000 shekels for the rent" is this. Without it the teller divides on
 * a phone and types the result back in, which rounds twice and disagrees with
 * the receipt by a unit or two often enough to be argued about.
 *
 * The returned quote is a real forward quote: `fromAmount` is derived, then the
 * pair is priced normally, so the figure on the receipt is the figure the
 * ledger posts. `toAmount` can land a minor unit away from the request when the
 * source currency cannot express the exact division — the caller shows what the
 * customer will actually receive rather than what they asked for.
 */
export async function quoteReverse(
  fromCurrency: string,
  toCurrency: string,
  toAmount: bigint,
  channel: RateChannel = 'CASH',
  db: DbClient = prisma,
  /** A price granted for this deal; see `quoteExchange`. */
  forcedRate?: bigint,
): Promise<Quote> {
  if (fromCurrency === toCurrency) {
    throw errors.precondition('Source and target currency must differ', 'errors.sameCurrencyPair');
  }
  if (toAmount <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }

  const source = await db.currency.findUnique({ where: { code: fromCurrency } });
  if (!source) throw errors.notFound('Currency', fromCurrency);

  // Price a unit to learn the applied rate, then invert it to size the input.
  // Deriving from the rate rather than from a scaled probe keeps the answer
  // independent of how large the probe happened to be.
  const unit = await quoteExchange(fromCurrency, toCurrency, MONEY_FACTOR, channel, db, forcedRate);

  const fromAmount = convert(toAmount, invertRate(unit.rate), source.decimals, 'half-up');
  if (fromAmount <= 0n) {
    throw errors.precondition(
      'That amount is too small to price at the current rate',
      'errors.amountNotPositive',
    );
  }

  return quoteExchange(fromCurrency, toCurrency, fromAmount, channel, db, forcedRate);
}

/** The full rate board, as the branch display shows it. */
export async function rateBoard(db: DbClient = prisma) {
  const [rates, currencies] = await Promise.all([
    listActiveRates(db),
    db.currency.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
  ]);

  const byCode = new Map(currencies.map((c) => [c.code, c]));

  return rates.map((rate) => ({
    ...rate,
    baseName: {
      en: byCode.get(rate.baseCode)?.nameEn ?? rate.baseCode,
      ar: byCode.get(rate.baseCode)?.nameAr ?? rate.baseCode,
    },
    quoteName: {
      en: byCode.get(rate.quoteCode)?.nameEn ?? rate.quoteCode,
      ar: byCode.get(rate.quoteCode)?.nameAr ?? rate.quoteCode,
    },
    spread: rate.sellRate - rate.buyRate,
  }));
}
