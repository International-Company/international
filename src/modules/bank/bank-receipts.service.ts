import 'server-only';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import type { Actor } from '@/modules/exchange/transaction.service';
import { keepMedia } from '@/modules/whatsapp/chat-images';
import * as settings from '@/modules/settings/settings.service';
import { answerInGroup, isLinked, sendImage, sentStub } from '@/modules/whatsapp/whatsapp.service';
import { sentWords } from '@/modules/whatsapp/sent-words';

const log = createLogger('bank:receipts');

/**
 * A transfer's receipts on the bank desk — as many as it took: a payment split
 * in two, a second screenshot, the bank's and Jawwal Pay's. Kept from the desk,
 * and from the groups: every photo answering the transfer's message, in the
 * transfers group or in a group it was passed on to, is its receipt, kept once
 * by the message it came as.
 *
 * A deal's are its TRANSFER proofs; a group's request's and a TikTok
 * withdrawal's are transfer receipts, the first also on the row as before.
 */

export type ReceiptKind = 'deal' | 'request' | 'tiktok';

const DESK = ['bank.execute', 'exchange.transfer.confirm'];
const requireDesk = (actor: Actor) => {
  if (!DESK.some((name) => actor.permissions.includes(name))) throw errors.forbidden('bank.execute');
};

export interface ReceiptFile {
  bytes: Buffer;
  mimeType: string;
}

/** One more receipt on the transfer; null when this group message was kept already. */
export async function addReceipt(
  kind: ReceiptKind,
  id: string,
  file: ReceiptFile,
  options: { sourceKey?: string | null; actorId?: string | null } = {},
): Promise<string | null> {
  const sourceKey = options.sourceKey ?? null;
  if (sourceKey) {
    const already =
      kind === 'deal'
        ? await prisma.transactionProof.findFirst({ where: { sourceKey }, select: { id: true } })
        : await prisma.transferReceipt.findUnique({ where: { sourceKey }, select: { id: true } });
    if (already) return null;
  }
  if (kind === 'deal') {
    const proof = await prisma.transactionProof.create({
      data: {
        transactionId: id,
        kind: 'TRANSFER',
        mimeType: file.mimeType,
        size: file.bytes.length,
        data: new Uint8Array(file.bytes),
        createdById: options.actorId ?? null,
        sourceKey,
      },
      select: { id: true },
    });
    readLater(kind, id);
    return proof.id;
  }
  const kept = await keepMedia(file, null);
  if (!kept) return null;
  const row = await prisma.transferReceipt.create({
    data: { kind, refId: id, imageId: kept.id, sourceKey },
    select: { id: true },
  });
  // The first is also the row's own receipt, as everything that reads one expects.
  if (kind === 'request') {
    await prisma.bankRequest.updateMany({ where: { id, receiptId: null }, data: { receiptId: kept.id } });
  } else {
    await prisma.tiktokWithdrawal.updateMany({ where: { id, receiptId: null }, data: { receiptId: kept.id } });
  }
  readLater(kind, id);
  return row.id;
}

/** The new receipt read for its sum in the background; loaded late, as the payments read receipts too. */
function readLater(kind: ReceiptKind, id: string) {
  void import('./transfer-payments.service')
    .then((payments) => payments.syncPayments(kind, id))
    .catch((error) => log.warn('Could not start reading a receipt', { error }));
}

/** Every receipt the transfer carries, oldest first, as the desk shows them. */
export async function listReceipts(kind: ReceiptKind, id: string) {
  if (kind === 'deal') {
    const proofs = await prisma.transactionProof.findMany({
      where: { transactionId: id, kind: 'TRANSFER' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, sourceKey: true, createdAt: true },
    });
    return proofs.map((proof) => ({
      id: proof.id,
      url: `/api/bank/${id}/proofs/${proof.id}`,
      fromGroup: Boolean(proof.sourceKey),
      at: proof.createdAt,
    }));
  }
  const [rows, own] = await Promise.all([
    prisma.transferReceipt.findMany({ where: { kind, refId: id }, orderBy: { createdAt: 'asc' } }),
    kind === 'request'
      ? prisma.bankRequest.findUnique({ where: { id }, select: { receiptId: true } })
      : prisma.tiktokWithdrawal.findUnique({ where: { id }, select: { receiptId: true } }),
  ]);
  // A receipt kept on the row before there could be more than one.
  const older =
    own?.receiptId && !rows.some((row) => row.imageId === own.receiptId)
      ? [{ id: `own:${own.receiptId}`, url: `/api/bank/groups/media/${own.receiptId}`, fromGroup: false, at: null as Date | null }]
      : [];
  return [
    ...older,
    ...rows.map((row) => ({
      id: row.id,
      url: `/api/bank/groups/media/${row.imageId}`,
      fromGroup: Boolean(row.sourceKey),
      at: row.createdAt as Date | null,
    })),
  ];
}

/** The receipts' photos themselves, for sending under the transfer in its group. */
export async function receiptFiles(kind: ReceiptKind, id: string, limit = 6): Promise<ReceiptFile[]> {
  if (kind === 'deal') {
    const proofs = await prisma.transactionProof.findMany({
      where: { transactionId: id, kind: 'TRANSFER' },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { data: true, mimeType: true },
    });
    return proofs.map((proof) => ({ bytes: Buffer.from(proof.data), mimeType: proof.mimeType }));
  }
  const own =
    kind === 'request'
      ? await prisma.bankRequest.findUnique({ where: { id }, select: { receiptId: true } })
      : await prisma.tiktokWithdrawal.findUnique({ where: { id }, select: { receiptId: true } });
  const rows = await prisma.transferReceipt.findMany({
    where: { kind, refId: id },
    orderBy: { createdAt: 'asc' },
    select: { imageId: true },
  });
  const ids = [...new Set([...(own?.receiptId ? [own.receiptId] : []), ...rows.map((row) => row.imageId)])].slice(0, limit);
  const files = await prisma.chatImage.findMany({ where: { id: { in: ids } }, select: { id: true, data: true, mimeType: true } });
  return ids
    .map((imageId) => files.find((file) => file.id === imageId))
    .filter((file): file is NonNullable<typeof file> => Boolean(file) && file!.mimeType.startsWith('image/'))
    .map((file) => ({ bytes: Buffer.from(file.data), mimeType: file.mimeType }));
}

export async function addReceiptByHand(
  kind: ReceiptKind,
  id: string,
  file: ReceiptFile,
  actor: Actor,
  options: { tell?: boolean } = {},
) {
  requireDesk(actor);
  await exists(kind, id);
  await addReceipt(kind, id, file, { actorId: actor.id });
  if (options.tell) await tellGroup(kind, id, file);
  return listReceipts(kind, id);
}

/**
 * A receipt given at the desk's sending window, answered under the transfer's
 * own message in its group: the photo, the number it went to and "تم التحويل".
 */
async function tellGroup(kind: ReceiptKind, id: string, file: ReceiptFile) {
  if (!(await settings.getBoolean('whatsapp.enabled')) || !isLinked()) return;
  try {
    if (kind === 'request') {
      const row = await prisma.bankRequest.findUnique({ where: { id } });
      if (!row) return;
      await answerInGroup(
        row.chat,
        { id: row.waId, author: row.senderJid, text: row.text },
        { image: file.bytes, mimetype: file.mimeType, caption: sentWords(row.account) },
      );
      return;
    }
    let chat: string | null = null;
    let messageId: string | null = null;
    let account: string | null = null;
    if (kind === 'deal') {
      const deal = await prisma.transaction.findUnique({
        where: { id },
        select: { payoutAccount: true, copyChat: true, copyMessageId: true, announcedChat: true, announcedMessageId: true },
      });
      if (!deal) return;
      chat = deal.copyChat ?? deal.announcedChat;
      messageId = deal.copyChat ? deal.copyMessageId : deal.announcedMessageId;
      account = deal.payoutAccount;
    } else {
      const row = await prisma.tiktokWithdrawal.findUnique({
        where: { id },
        select: { account: true, bankChat: true, bankMessageId: true },
      });
      if (!row) return;
      chat = row.bankChat;
      messageId = row.bankMessageId;
      account = row.account;
    }
    if (!chat || !messageId) return;
    await sendImage(chat, file.bytes, sentWords(account), sentStub(chat, messageId), file.mimeType);
  } catch (error) {
    log.warn('Could not answer a transfer with its receipt in its group', { kind, error });
  }
}

export async function removeReceipt(kind: ReceiptKind, id: string, receiptId: string, actor: Actor) {
  requireDesk(actor);
  if (kind === 'deal') {
    await prisma.transactionProof.deleteMany({ where: { id: receiptId, transactionId: id, kind: 'TRANSFER' } });
  } else if (receiptId.startsWith('own:')) {
    const imageId = receiptId.slice(4);
    if (kind === 'request') await prisma.bankRequest.updateMany({ where: { id, receiptId: imageId }, data: { receiptId: null } });
    else await prisma.tiktokWithdrawal.updateMany({ where: { id, receiptId: imageId }, data: { receiptId: null } });
  } else {
    const row = await prisma.transferReceipt.findFirst({ where: { id: receiptId, kind, refId: id } });
    if (row) {
      await prisma.transferReceipt.delete({ where: { id: row.id } });
      // The row's own receipt moves on to the next one, or goes.
      const next = await prisma.transferReceipt.findFirst({ where: { kind, refId: id }, orderBy: { createdAt: 'asc' } });
      const data = { receiptId: next?.imageId ?? null };
      if (kind === 'request') await prisma.bankRequest.updateMany({ where: { id, receiptId: row.imageId }, data });
      else await prisma.tiktokWithdrawal.updateMany({ where: { id, receiptId: row.imageId }, data });
    }
  }
  return listReceipts(kind, id);
}

async function exists(kind: ReceiptKind, id: string) {
  const found =
    kind === 'deal'
      ? await prisma.transaction.findUnique({ where: { id }, select: { id: true } })
      : kind === 'request'
        ? await prisma.bankRequest.findUnique({ where: { id }, select: { id: true } })
        : await prisma.tiktokWithdrawal.findUnique({ where: { id }, select: { id: true } });
  if (!found) throw errors.notFound('Transfer', id);
}

/** The messages a transfer is in: its own in the transfers group, and the copies passed on from it. */
async function messagesOf(kind: ReceiptKind, id: string): Promise<{ chat: string; waId: string }[]> {
  const own: { chat: string | null; waId: string | null }[] = [];
  if (kind === 'deal') {
    const deal = await prisma.transaction.findUnique({
      where: { id },
      select: { copyChat: true, copyMessageId: true, announcedChat: true, announcedMessageId: true },
    });
    if (deal) own.push({ chat: deal.copyChat, waId: deal.copyMessageId }, { chat: deal.announcedChat, waId: deal.announcedMessageId });
  } else if (kind === 'request') {
    const row = await prisma.bankRequest.findUnique({ where: { id }, select: { chat: true, waId: true } });
    if (row) own.push({ chat: row.chat, waId: row.waId });
  } else {
    const row = await prisma.tiktokWithdrawal.findUnique({
      where: { id },
      select: { bankChat: true, bankMessageId: true, announcedChat: true, announcedMessageId: true },
    });
    if (row) own.push({ chat: row.bankChat, waId: row.bankMessageId }, { chat: row.announcedChat, waId: row.announcedMessageId });
  }
  const places = own.filter((place): place is { chat: string; waId: string } => Boolean(place.chat && place.waId));
  if (places.length === 0) return [];
  // Passed on from there, by the desk or a rule: the copies the receipts answer, a hop or two away.
  const all = [...places];
  let frontier = places;
  for (let hop = 0; hop < 3 && frontier.length; hop++) {
    const copies = await prisma.groupForward.findMany({
      where: { OR: frontier.map((place) => ({ sourceChat: place.chat, sourceWaId: place.waId })), targetWaId: { not: null } },
      select: { targetChat: true, targetWaId: true },
    });
    frontier = copies
      .map((copy) => ({ chat: copy.targetChat, waId: copy.targetWaId! }))
      .filter((place) => !all.some((known) => known.chat === place.chat && known.waId === place.waId));
    all.push(...frontier);
  }
  return all;
}

/**
 * Looked for again in the groups: every photo kept as answering one of the
 * transfer's messages, there or where it was passed on, taken as a receipt it
 * does not have yet.
 */
export async function collectReceipts(kind: ReceiptKind, id: string, actor: Actor) {
  requireDesk(actor);
  await exists(kind, id);
  const places = await messagesOf(kind, id);
  let added = 0;
  if (places.length > 0) {
    const replies = await prisma.groupReply.findMany({
      where: { OR: places.map((place) => ({ chat: place.chat, quotedWaId: place.waId })) },
      orderBy: { createdAt: 'asc' },
      take: 40,
    });
    for (const reply of replies) {
      const file = await prisma.chatImage.findUnique({ where: { id: reply.mediaId }, select: { data: true, mimeType: true } });
      if (!file || !file.mimeType.startsWith('image/')) continue;
      const kept = await addReceipt(kind, id, { bytes: Buffer.from(file.data), mimeType: file.mimeType }, {
        sourceKey: `${reply.chat}|${reply.waId}`,
      }).catch((error) => {
        log.warn('Could not keep a receipt found in a group', { error });
        return null;
      });
      if (kept) added++;
    }
  }
  return { added, groups: new Set(places.map((place) => place.chat)).size, receipts: await listReceipts(kind, id) };
}
