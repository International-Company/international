import 'server-only';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { divideRounded, MONEY_FACTOR } from '@/core/money/money';
import { transferChannels } from '@/modules/exchange/machine.service';
import { readProofImage } from '@/modules/exchange/proof-image';
import * as transactions from '@/modules/exchange/transaction.service';
import type { Actor } from '@/modules/exchange/transaction.service';
import {
  PERCENT_CURRENCY,
  percentCoins,
  percentRate,
  percentTotal,
  saleCoins,
  validPercent,
} from './sale-sums';

/**
 * بيع USDT — تسجيل فقط.
 *
 * The teller sold coins and sent them himself, from wherever he keeps them;
 * the system is told afterwards, so the money he took is in his drawer and
 * the sale is in his day. Nothing is sent from here and no wallet balance is
 * touched — the office keeps none for coins it never held.
 *
 * The price is his, typed every time: what the customer pays per coin. The
 * total is that price times the coins, at the currency's own precision, and
 * is worked out here rather than taken from the screen.
 */

export const SALE_MODES = ['CASH', 'BROKER'] as const;
export type SaleMode = (typeof SALE_MODES)[number];

export interface SaleInput {
  payCurrency: string;
  /** The coins sold, when that is what the teller knows. */
  usdtAmount?: bigint | null;
  /** What came in, when that is what the teller knows: the coins follow from it. */
  received?: bigint | null;
  /** What the customer pays per coin, in `payCurrency`. Not for dollars. */
  price?: bigint | null;
  /** For dollars: the share the office keeps, scaled like money (3% is 3_00000000n). */
  percent?: bigint | null;
  mode: SaleMode;
  /** Which of the broker's accounts the customer paid into, when not in cash. */
  intakeChannel?: string | null;
  branchId: string;
  customerId?: string | null;
  counterpartyName?: string | null;
  counterpartyPhone?: string | null;
  notes?: string | null;
  /** A photo of the customer's transfer to the office, as base64. */
  transferPhoto?: string | null;
  /** A photo of the address the coins go to, as base64. */
  addressPhoto?: string | null;
  /** The address, when it came as text. */
  address?: string | null;
}

/** What the customer pays: the coins at the price, at the currency's precision. */
export function saleTotal(usdtAmount: bigint, price: bigint, decimals: number): bigint {
  const exact = divideRounded(usdtAmount * price, MONEY_FACTOR);
  const step = 10n ** BigInt(Math.max(0, 8 - decimals));
  return divideRounded(exact, step) * step;
}

export async function recordSale(input: SaleInput, actor: Actor, db: DbClient = prisma) {
  if (!actor.permissions.includes('usdt.withdrawal.use')) {
    throw errors.forbidden('usdt.withdrawal.use');
  }
  const byPercent = input.payCurrency === PERCENT_CURRENCY;
  const price = input.price ?? 0n;
  const percent = input.percent ?? -1n;
  if (byPercent ? !validPercent(percent) : price <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }

  const currency = await db.currency.findFirst({
    where: { code: input.payCurrency, isActive: true, kind: 'FIAT' },
    select: { code: true, decimals: true },
  });
  if (!currency) throw errors.notFound('Currency', input.payCurrency);

  /*
   * Either figure can be the one typed. What was received stands as typed, at the
   * currency's precision, and the price stands with it: the coins are rounded, so
   * reading the price back off the two sums would no longer give what was agreed.
   */
  const step = 10n ** BigInt(Math.max(0, 8 - currency.decimals));
  const byReceived = input.received !== null && input.received !== undefined;
  const payTotal = byReceived
    ? divideRounded(input.received!, step) * step
    : byPercent
      ? percentTotal(input.usdtAmount ?? 0n, percent, currency.decimals)
      : saleTotal(input.usdtAmount ?? 0n, price, currency.decimals);
  const usdtAmount = !byReceived
    ? (input.usdtAmount ?? 0n)
    : byPercent
      ? percentCoins(payTotal, percent)
      : saleCoins(payTotal, price);
  if (payTotal <= 0n || usdtAmount <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }

  // Paid by transfer: into which of the broker's accounts, from the manager's list.
  let account: string | null = null;
  if (input.mode === 'BROKER') {
    account = input.intakeChannel?.trim() ?? '';
    if (!account) {
      throw errors.precondition(
        'Say which account the customer paid into',
        'errors.transferChannelRequired',
      );
    }
    if (!(await transferChannels(db)).includes(account)) {
      throw errors.precondition(
        `${account} is not a destination the counter offers`,
        'errors.transferChannelUnknown',
        { channel: account },
      );
    }
  }

  // Read before anything is written: a bad photo records no sale.
  const photos = [
    { kind: 'PAYMENT', base64: input.transferPhoto },
    { kind: 'ADDRESS', base64: input.addressPhoto },
  ].flatMap(({ kind, base64 }) => {
    if (!base64) return [];
    const image = readProofImage(base64);
    if (typeof image === 'string') throw errors.precondition('That photo cannot be kept', image);
    return [{ kind, image }];
  });

  /*
   * One transaction, so the sale and its photos are visible together: the bot is
   * told as the sale is written and waits for it to commit before reading either.
   */
  return withTransaction(async (tx) => {
    const posted = await transactions.record(
      {
        type: 'USDT_SALE',
        branchId: input.branchId,
        customerId: input.customerId ?? null,
        fromCurrency: currency.code,
        fromAmount: payTotal,
        toCurrency: 'USDT',
        toAmount: usdtAmount,
        intake:
          input.mode === 'BROKER' ? { cash: 0n, broker: payTotal } : { cash: payTotal, broker: 0n },
        intakeChannel: account,
        // 1 unit of what was paid = this many coins, as every row reads its rate.
        // By a percentage, the rate is the percentage itself, so it reads back exactly.
        rate: byPercent
          ? percentRate(percent)
          : byReceived
            ? divideRounded(MONEY_FACTOR * MONEY_FACTOR, price)
            : divideRounded(usdtAmount * MONEY_FACTOR, payTotal),
        counterpartyName: input.counterpartyName?.trim() || null,
        counterpartyPhone: input.counterpartyPhone?.trim() || null,
        notes: input.notes?.trim() || null,
        payoutAddress: input.address?.trim() || null,
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
