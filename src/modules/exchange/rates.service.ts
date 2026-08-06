import 'server-only';
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
 */

export interface RateInput {
  baseCode: string;
  quoteCode: string;
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
  db: DbClient = prisma,
): Promise<ActiveRate | null> {
  const row = await db.exchangeRate.findFirst({
    where: { baseCode, quoteCode, isActive: true, effectiveTo: null },
    orderBy: { effectiveFrom: 'desc' },
  });
  return row ? toActiveRate(row) : null;
}

function toActiveRate(row: {
  id: string;
  baseCode: string;
  quoteCode: string;
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

  return withTransaction(async (tx) => {
    const [base, quote] = await Promise.all([
      tx.currency.findUnique({ where: { code: input.baseCode } }),
      tx.currency.findUnique({ where: { code: input.quoteCode } }),
    ]);
    if (!base) throw errors.notFound('Currency', input.baseCode);
    if (!quote) throw errors.notFound('Currency', input.quoteCode);

    const now = new Date();

    const previous = await tx.exchangeRate.findFirst({
      where: { baseCode: input.baseCode, quoteCode: input.quoteCode, isActive: true, effectiveTo: null },
      orderBy: { effectiveFrom: 'desc' },
    });

    if (previous) {
      await tx.exchangeRate.update({
        where: { id: previous.id },
        data: { effectiveTo: now, isActive: false },
      });
    }

    const created = await tx.exchangeRate.create({
      data: {
        baseCode: input.baseCode,
        quoteCode: input.quoteCode,
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
  db: DbClient = prisma,
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
  const direct = await getActiveRate(fromCurrency, toCurrency, db);
  if (direct) {
    const toAmount = convert(fromAmount, direct.buyRate, targetDecimals);
    const atMid = convert(fromAmount, direct.midRate, targetDecimals);
    return {
      fromCurrency,
      toCurrency,
      fromAmount,
      toAmount,
      rate: direct.buyRate,
      midRate: direct.midRate,
      rateId: direct.id,
      side: 'BUY',
      inverted: false,
      profit: atMid - toAmount,
    };
  }

  // Reverse: pair is stored as TO/FROM. Company sells TO, so invert the sell side.
  const reverse = await getActiveRate(toCurrency, fromCurrency, db);
  if (reverse) {
    const rate = invertRate(reverse.sellRate);
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
