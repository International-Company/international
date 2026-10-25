import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { MONEY_FACTOR, toDecimalString } from '@/core/money/money';
import * as settings from '@/modules/settings/settings.service';
import * as drawers from '@/modules/drawers/drawer.service';
import { cashOwnerFor } from '@/modules/treasury/shift.service';
import { ceilingFor } from '@/modules/users/counter-limit';
import * as transactions from './transaction.service';
import { transferChannels } from './machine.service';
import type { Actor } from './transaction.service';

/**
 * Cash out of a customer's wallet, and cash into it — the two same-currency
 * services an exchange counter runs beside the conversions.
 *
 * ## The two shapes
 *
 *     cash-out:  customer transfers 1,000 to the office's PalPay
 *                → office hands over 1,000 − fee in notes
 *     top-up:    customer hands over 1,000 + fee in notes
 *                → office transfers 1,000 to the customer's wallet
 *
 * The amount the teller types is always the one that moves through the wallet,
 * because that is the figure on the customer's phone; the fee, which he also
 * types, is what the office keeps, and the notes are whatever is left.
 *
 * ## Where the money goes
 *
 * Through the office's account at the broker on the wallet side and the till
 * on the other, as an exchange paid by transfer does. A top-up is a promise —
 * the transfer has not left yet — so it waits on confirmation like any other.
 * The fee is the whole of the office's income and is recorded as the margin.
 */

export const WALLET_OPS = ['CASHOUT', 'TOPUP'] as const;
export type WalletOp = (typeof WALLET_OPS)[number];

/**
 * What comes in, what goes out, and through which balance — the whole of the
 * arithmetic, kept apart so it can be read and tested on its own.
 *
 *     cash-out:  in  = amount        by transfer
 *                out = amount − fee  in notes
 *     top-up:    in  = amount + fee  in notes
 *                out = amount        by transfer
 */
export function walletShape(op: WalletOp, amount: bigint, fee: bigint) {
  if (op === 'CASHOUT') {
    const out = amount - fee;
    return {
      type: 'WALLET_CASHOUT' as const,
      fromAmount: amount,
      toAmount: out,
      intake: { cash: 0n, broker: amount },
      payout: { cash: out, bank: 0n },
    };
  }
  const paid = amount + fee;
  return {
    type: 'WALLET_TOPUP' as const,
    fromAmount: paid,
    toAmount: amount,
    intake: { cash: paid, broker: 0n },
    payout: { cash: 0n, bank: amount },
  };
}

export interface WalletOpInput {
  op: WalletOp;
  currency: string;
  /** What moves through the wallet — the figure on the customer's phone. */
  amount: bigint;
  /** What the office keeps. Typed by the teller each time. */
  fee: bigint;
  /** Which of the office's accounts the wallet side goes through. */
  channel: string;
  /** The customer's wallet number. Required for a top-up: it is where the money goes. */
  account?: string | null;
  branchId: string;
  customerId?: string | null;
  counterpartyName?: string | null;
  counterpartyPhone?: string | null;
  notes?: string | null;
}

export async function recordWalletOp(input: WalletOpInput, actor: Actor, db: DbClient = prisma) {
  if (!(await settings.getBoolean('machine.enabled', db))) {
    throw errors.precondition('The exchange machine is switched off', 'errors.machineDisabled');
  }

  const currency = await db.currency.findUnique({
    where: { code: input.currency },
    select: { code: true, kind: true, isActive: true },
  });
  if (!currency || !currency.isActive) throw errors.notFound('Currency', input.currency);
  // A wallet here is a bank wallet; coins have their own counter.
  if (currency.kind === 'CRYPTO') {
    throw errors.precondition('Wallet services are for bank currencies', 'errors.walletOpCurrency');
  }

  if (input.amount <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }
  if (input.fee < 0n) {
    throw errors.precondition('A fee cannot be negative', 'errors.walletOpFee');
  }
  // On a cash-out the fee comes out of the money; it cannot be all of it.
  if (input.op === 'CASHOUT' && input.fee >= input.amount) {
    throw errors.precondition('The fee must be less than the amount', 'errors.walletOpFee');
  }

  const channel = input.channel.trim();
  if (!(await transferChannels(db)).includes(channel)) {
    throw errors.precondition(
      `${channel} is not an account the counter offers`,
      'errors.transferChannelUnknown',
      { channel },
    );
  }

  const account = input.account?.trim() || null;
  if (input.op === 'TOPUP' && !account) {
    throw errors.precondition(
      'Say which wallet the money goes to',
      'errors.transferAccountRequired',
    );
  }

  // The teller's ceiling, read against the money he is responsible for.
  const maximum = await ceilingFor(actor.id, await settings.getMoney('machine.maxAmount', db), db);
  if (maximum > 0n && input.amount > maximum) {
    throw errors.precondition(
      `The counter limit is ${toDecimalString(maximum, 2)} ${input.currency}`,
      'errors.machineOverLimit',
      { maximum: toDecimalString(maximum, 2), currency: input.currency },
    );
  }

  const cashOut = input.op === 'CASHOUT';
  const shape = walletShape(input.op, input.amount, input.fee);
  const { fromAmount, toAmount } = shape;

  // The notes have to be there, unless the office lets a drawer run short.
  if (cashOut) {
    const held = await drawers.canPay(
      input.currency,
      toAmount,
      'CASH',
      db,
      await cashOwnerFor(actor.id, db),
    );
    if (!held.ok) {
      throw errors.insufficientFunds(
        input.currency,
        'CASH',
        toDecimalString(held.balance, 2),
        toDecimalString(toAmount, 2),
      );
    }
  }

  return transactions.record(
    {
      type: shape.type,
      branchId: input.branchId,
      customerId: input.customerId ?? null,
      fromCurrency: input.currency,
      fromAmount,
      toCurrency: input.currency,
      toAmount,
      intake: shape.intake,
      intakeChannel: cashOut ? channel : null,
      payout: shape.payout,
      payoutChannel: cashOut ? null : channel,
      payoutAccount: cashOut ? null : account,
      // One currency on both sides: one for one, and the fee is the margin.
      rate: MONEY_FACTOR,
      profitAmount: input.fee,
      counterpartyName: input.counterpartyName ?? null,
      counterpartyPhone: input.counterpartyPhone ?? null,
      notes: input.notes ?? null,
    },
    actor,
    db,
  );
}
