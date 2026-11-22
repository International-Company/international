import 'server-only';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { emitAsync } from '@/core/events/bus';
import { createLogger } from '@/core/logger/logger';
import * as audit from '@/modules/audit/audit.service';
import { readProofImage } from '@/modules/exchange/proof-image';
import type { Actor } from '@/modules/exchange/transaction.service';
import { keepMedia } from '@/modules/whatsapp/chat-images';
import { answerInGroup, reactTo, sendImage, sentStub } from '@/modules/whatsapp/whatsapp.service';

const log = createLogger('bank:correction');

/**
 * A transfer on the bank desk put right after it was marked sent: back to
 * waiting when it was marked by mistake — a 👍 on the wrong message, a press
 * on the wrong row — or its receipt replaced with the right one.
 *
 * Marking sent writes nothing to the books beyond the deal's status and who
 * confirmed it, so taking it back is exactly that undone; the deal's money was
 * booked when it was recorded and stays as it was. Each is in the audit log.
 */

export type DeskKind = 'deal' | 'request' | 'tiktok';

const DESK = ['bank.execute', 'exchange.transfer.confirm'];

function requireDesk(actor: Actor) {
  if (!DESK.some((name) => actor.permissions.includes(name))) throw errors.forbidden('bank.execute');
}

/** Back to waiting: no longer sent, nobody's name on it, the ✅ taken off where the bot put it. */
export async function reopenSent(kind: DeskKind, id: string, actor: Actor & { name: string }) {
  requireDesk(actor);
  if (kind === 'deal') {
    const row = await prisma.transaction.findUnique({
      where: { id },
      select: { reference: true, status: true, payoutBankAmount: true, transferConfirmedAt: true },
    });
    if (!row) throw errors.notFound('Transaction', id);
    if (row.status !== 'POSTED' || !row.transferConfirmedAt || row.payoutBankAmount <= 0n) {
      throw errors.conflict('This transfer is not marked sent', 'errors.notSentTransfer');
    }
    await prisma.transaction.update({
      where: { id },
      data: { status: 'PENDING_TRANSFER', transferConfirmedAt: null, transferConfirmedById: null },
    });
    await audit.record({
      action: 'UPDATE',
      module: 'exchange',
      entityType: 'Transaction',
      entityId: id,
      summaryEn: `Took back the sent mark on ${row.reference}: its transfer waits again`,
      summaryAr: `إلغاء تنفيذ تحويل العملية ${row.reference}: عادت إلى الانتظار`,
      actor,
      before: { status: 'POSTED' },
      after: { status: 'PENDING_TRANSFER' },
    });
    emitAsync('transaction.transferReopened', { transactionId: id });
    log.info('A transfer was put back to waiting', { reference: row.reference });
    return { id };
  }

  if (kind === 'request') {
    const row = await prisma.bankRequest.findUnique({ where: { id } });
    if (!row) throw errors.notFound('BankRequest', id);
    if (row.status !== 'SENT') throw errors.conflict('This request is not marked sent', 'errors.notSentTransfer');
    await prisma.bankRequest.update({ where: { id }, data: { status: 'PENDING', sentAt: null, sentByName: null } });
    await audit.record({
      action: 'UPDATE',
      module: 'bank',
      entityType: 'BankRequest',
      entityId: id,
      summaryEn: 'Took back the sent mark on a group transfer request: it waits again',
      summaryAr: 'إلغاء تنفيذ طلب تحويل من مجموعة: عاد إلى الانتظار',
      actor,
    });
    return { id };
  }

  const row = await prisma.tiktokWithdrawal.findUnique({
    where: { id },
    select: { sentAt: true, deletedAt: true, bankChat: true, bankMessageId: true },
  });
  if (!row || row.deletedAt) throw errors.notFound('TiktokWithdrawal', id);
  if (!row.sentAt) throw errors.conflict('This withdrawal is not marked sent', 'errors.notSentTransfer');
  await prisma.tiktokWithdrawal.update({ where: { id }, data: { sentAt: null, sentByName: null } });
  if (row.bankChat && row.bankMessageId) {
    await reactTo(row.bankChat, row.bankMessageId, '').catch((error) =>
      log.warn('Could not take the sent mark off a TikTok transfer', { error }),
    );
  }
  await audit.record({
    action: 'UPDATE',
    module: 'bank',
    entityType: 'TiktokWithdrawal',
    entityId: id,
    summaryEn: 'Took back the sent mark on a TikTok withdrawal: it waits again',
    summaryAr: 'إلغاء تنفيذ سحب تيك توك: عاد إلى الانتظار',
    actor,
  });
  return { id };
}

const UPDATED = '✅ تم التحويل — الإشعار الصحيح';

/**
 * The receipt replaced with the right one. Sent already, the new one also goes
 * to the group under the transfer's message, so whoever reads it there has the
 * right photo, not only the desk.
 */
export async function replaceReceipt(kind: DeskKind, id: string, receipt: string, actor: Actor & { name: string }) {
  requireDesk(actor);
  const image = readProofImage(receipt);
  if (typeof image === 'string') throw errors.precondition('That photo cannot be kept', image);

  if (kind === 'deal') {
    const row = await prisma.transaction.findUnique({
      where: { id },
      select: { reference: true, status: true, transferConfirmedAt: true },
    });
    if (!row) throw errors.notFound('Transaction', id);
    const proof = await prisma.$transaction(async (tx) => {
      await tx.transactionProof.deleteMany({ where: { transactionId: id, kind: 'TRANSFER' } });
      return tx.transactionProof.create({
        data: {
          transactionId: id,
          kind: 'TRANSFER',
          mimeType: image.mimeType,
          size: image.bytes.length,
          data: new Uint8Array(image.bytes),
          createdById: actor.id,
        },
        select: { id: true },
      });
    });
    await audit.record({
      action: 'UPDATE',
      module: 'exchange',
      entityType: 'Transaction',
      entityId: id,
      summaryEn: `Replaced the bank receipt of ${row.reference}`,
      summaryAr: `تغيير إشعار التحويل للعملية ${row.reference}`,
      actor,
    });
    // Sent already: the right receipt to the group, as the first one went.
    if (row.status === 'POSTED' && row.transferConfirmedAt) {
      emitAsync('transaction.transferSent', { transactionId: id, proofId: proof.id, actorId: actor.id });
    }
    return { id };
  }

  const kept = await keepMedia(image, null);
  if (!kept) throw errors.precondition('That photo cannot be kept', 'errors.proofImageInvalid');

  if (kind === 'request') {
    const row = await prisma.bankRequest.findUnique({ where: { id } });
    if (!row) throw errors.notFound('BankRequest', id);
    await prisma.bankRequest.update({ where: { id }, data: { receiptId: kept.id } });
    if (row.status === 'SENT') {
      await answerInGroup(
        row.chat,
        { id: row.waId, author: row.senderJid, text: row.text },
        { image: image.bytes, mimetype: image.mimeType, caption: UPDATED },
      ).catch((error) => log.warn('Could not send the right receipt to the group', { error }));
    }
  } else {
    const row = await prisma.tiktokWithdrawal.findUnique({
      where: { id },
      select: { sentAt: true, deletedAt: true, bankChat: true, bankMessageId: true },
    });
    if (!row || row.deletedAt) throw errors.notFound('TiktokWithdrawal', id);
    await prisma.tiktokWithdrawal.update({ where: { id }, data: { receiptId: kept.id } });
    if (row.sentAt && row.bankChat && row.bankMessageId) {
      await sendImage(row.bankChat, image.bytes, UPDATED, sentStub(row.bankChat, row.bankMessageId), image.mimeType).catch(
        (error) => log.warn('Could not send the right receipt to the group', { error }),
      );
    }
  }
  await audit.record({
    action: 'UPDATE',
    module: 'bank',
    entityType: kind === 'request' ? 'BankRequest' : 'TiktokWithdrawal',
    entityId: id,
    summaryEn: 'Replaced a transfer receipt',
    summaryAr: 'تغيير إشعار تحويل',
    actor,
  });
  return { id };
}
