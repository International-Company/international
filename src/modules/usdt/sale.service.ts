import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { divideRounded, MONEY_FACTOR } from '@/core/money/money';
import { transferChannels } from '@/modules/exchange/machine.service';
import * as transactions from '@/modules/exchange/transaction.service';
import type { Actor } from '@/modules/exchange/transaction.service';

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
  /** The coins sold. */
  usdtAmount: bigint;
  /** What the customer pays per coin, in `payCurrency`. */
  price: bigint;
  mode: SaleMode;
  /** Which of the broker's accounts the customer paid into, when not in cash. */
  intakeChannel?: string | null;
  branchId: string;
  customerId?: string | null;
  counterpartyName?: string | null;
  counterpartyPhone?: string | null;
  notes?: string | null;
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
  if (input.usdtAmount <= 0n || input.price <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }

  const currency = await db.currency.findFirst({
    where: { code: input.payCurrency, isActive: true, kind: 'FIAT' },
    select: { code: true, decimals: true },
  });
  if (!currency) throw errors.notFound('Currency', input.payCurrency);

  const payTotal = saleTotal(input.usdtAmount, input.price, currency.decimals);
  if (payTotal <= 0n) {
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

  return transactions.record(
    {
      type: 'USDT_SALE',
      branchId: input.branchId,
      customerId: input.customerId ?? null,
      fromCurrency: currency.code,
      fromAmount: payTotal,
      toCurrency: 'USDT',
      toAmount: input.usdtAmount,
      intake:
        input.mode === 'BROKER' ? { cash: 0n, broker: payTotal } : { cash: payTotal, broker: 0n },
      intakeChannel: account,
      // 1 unit of what was paid = this many coins, as every row reads its rate.
      rate: divideRounded(input.usdtAmount * MONEY_FACTOR, payTotal),
      counterpartyName: input.counterpartyName?.trim() || null,
      counterpartyPhone: input.counterpartyPhone?.trim() || null,
      notes: input.notes?.trim() || null,
    },
    actor,
    db,
  );
}
