import 'server-only';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { normalizeDigits } from '@/core/money/money';
import { emitAsync } from '@/core/events/bus';
import * as audit from '@/modules/audit/audit.service';
import { transferChannels } from '@/modules/exchange/machine.service';
import { readProofImage } from '@/modules/exchange/proof-image';
import type { Actor } from '@/modules/exchange/transaction.service';
import { formatAmount, formatFigure } from '@/modules/whatsapp/report-command';
import { rateText, tiktokPayout, tiktokTotals } from './tiktok-message';

/**
 * TikTok withdrawals, written down: a photo, who it is for, how it is sent, the
 * dollars withdrawn and the shekels handed over for them.
 *
 * Kept apart from the transactions because it moves no balance. The drawers and
 * the count know nothing of it, so a record here can never put them out.
 */

export const MAX_NAME = 200;

const seesAll = (actor: Actor) => actor.permissions.includes('exchange.transaction.viewAll');

export async function record(
  input: {
    amount: bigint;
    rate: bigint;
    account: string;
    beneficiaryName: string;
    channel: string;
    photo: string;
  },
  actor: Actor,
) {
  if (input.amount <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }
  const payoutAmount = tiktokPayout(input.amount, input.rate);
  if (input.rate <= 0n || payoutAmount <= 0n) {
    throw errors.precondition('Give the price', 'errors.tiktokRateRequired');
  }
  const account = normalizeDigits(input.account).trim();
  if (!account) {
    throw errors.precondition('Say where it goes', 'errors.tiktokAccountRequired');
  }
  const beneficiaryName = input.beneficiaryName.trim();
  if (!beneficiaryName) {
    throw errors.precondition('Say who it is for', 'errors.tiktokNameRequired');
  }
  const channel = input.channel.trim();
  if (!(await transferChannels()).includes(channel)) {
    throw errors.precondition(
      `${channel} is not an account the counter offers`,
      'errors.transferChannelUnknown',
      { channel },
    );
  }
  const image = readProofImage(input.photo);
  if (typeof image === 'string') throw errors.precondition('That photo cannot be kept', image);

  const row = await prisma.tiktokWithdrawal.create({
    data: {
      currency: 'USD',
      amount: input.amount,
      rate: input.rate,
      payoutAmount,
      account,
      beneficiaryName,
      channel,
      mimeType: image.mimeType,
      size: image.bytes.length,
      data: new Uint8Array(image.bytes),
      createdById: actor.id,
    },
    select: { id: true },
  });
  const figure = `${formatAmount({ currency: 'USD', amount: input.amount })} = ${formatAmount({ currency: 'ILS', amount: payoutAmount })}`;
  await audit.record({
    action: 'CREATE',
    module: 'tiktok',
    entityType: 'TiktokWithdrawal',
    entityId: row.id,
    summaryEn: `Recorded a TikTok withdrawal of ${figure}`,
    summaryAr: `تسجيل سحب تيكتوك بمبلغ ${figure}`,
    actor,
  });
  emitAsync('tiktok.recorded', { withdrawalId: row.id });
  return { id: row.id };
}

/** The latest that stand, without their photos: a teller's own, or everyone's for a manager. */
export async function list(actor: Actor) {
  const rows = await prisma.tiktokWithdrawal.findMany({
    where: { deletedAt: null, ...(seesAll(actor) ? {} : { createdById: actor.id }) },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: {
      id: true,
      currency: true,
      amount: true,
      rate: true,
      payoutAmount: true,
      account: true,
      beneficiaryName: true,
      channel: true,
      createdAt: true,
      createdBy: { select: { fullNameAr: true, fullNameEn: true } },
    },
  });
  return rows.map(({ amount, rate, payoutAmount, ...row }) => ({
    ...row,
    amountText: formatFigure(amount),
    // Nothing for a record from before the shekels.
    rateText: rate > 0n ? rateText(rate) : null,
    payoutText: payoutAmount > 0n ? formatFigure(payoutAmount) : null,
  }));
}

/**
 * The teller's own withdrawals in a period, for their daily count. Like a deal
 * undone there, a deleted one stays in the list, marked, and out of the totals.
 */
export async function ownDay(input: { from: Date; to: Date }, actor: Actor) {
  const found = await prisma.tiktokWithdrawal.findMany({
    where: { createdById: actor.id, createdAt: { gte: input.from, lte: input.to } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      currency: true,
      amount: true,
      rate: true,
      payoutAmount: true,
      account: true,
      beneficiaryName: true,
      channel: true,
      createdAt: true,
      deletedAt: true,
    },
  });
  const rows = found.map(({ deletedAt, ...row }) => ({ ...row, deleted: deletedAt !== null }));
  const totals = tiktokTotals(rows);
  return {
    count: totals.count,
    withdrawn: totals.withdrawn.map(({ currency, amount }) => ({
      currency,
      amount: amount.toString(),
    })),
    paid: totals.paid.toString(),
    entries: rows.map(({ amount, rate, payoutAmount, createdAt, ...row }) => ({
      ...row,
      at: createdAt.toISOString(),
      amount: amount.toString(),
      rate: rate > 0n ? rateText(rate) : null,
      payout: payoutAmount.toString(),
    })),
  };
}

async function reachable(id: string, actor: Actor) {
  const row = await prisma.tiktokWithdrawal.findFirst({
    where: { id, deletedAt: null, ...(seesAll(actor) ? {} : { createdById: actor.id }) },
    select: { id: true, mimeType: true, data: true, amount: true, currency: true },
  });
  if (!row) throw errors.notFound('TiktokWithdrawal', id);
  return row;
}

export const readPhoto = reachable;

/** Taken back by whoever may reverse a deal. The row stays, for the audit trail. */
export async function remove(id: string, actor: Actor) {
  if (!actor.permissions.includes('exchange.transaction.reverse')) {
    throw errors.forbidden('exchange.transaction.reverse');
  }
  const row = await reachable(id, actor);
  await prisma.tiktokWithdrawal.update({
    where: { id },
    data: { deletedAt: new Date(), deletedById: actor.id },
  });
  const figure = formatAmount({ currency: row.currency, amount: row.amount });
  await audit.record({
    action: 'DELETE',
    module: 'tiktok',
    entityType: 'TiktokWithdrawal',
    entityId: id,
    summaryEn: `Deleted a TikTok withdrawal of ${figure}`,
    summaryAr: `حذف سحب تيكتوك بمبلغ ${figure}`,
    actor,
  });
  emitAsync('tiktok.deleted', { withdrawalId: id, by: actor.name });
  return { id };
}
