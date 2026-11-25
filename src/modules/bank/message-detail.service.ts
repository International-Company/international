import 'server-only';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import type { Actor } from '@/modules/exchange/transaction.service';
import { listReceipts } from './bank-receipts.service';
import { transferOf } from './group-marks.service';
import { watched } from './group-feed.service';
import { readReceiptDetails, type ReceiptDetails } from './receipt-reader';
import { paidSoFar } from './transfer-payments.service';

const log = createLogger('bank:message');

/**
 * A group's message opened in full on the desk: what its photo says — the
 * receipt read field by field, once, and kept — the transfer it answers or
 * is, how far that transfer got, and the message it replies to.
 */

const DESK = ['bank.execute', 'exchange.transfer.confirm'];
const requireDesk = (actor: Actor) => {
  if (!DESK.some((name) => actor.permissions.includes(name))) throw errors.forbidden('bank.execute');
};

type Kind = 'deal' | 'request' | 'tiktok';

/** A transfer as one card shows it: to whom, how much, how far it got. */
async function transferCard(kind: Kind, id: string) {
  let card: {
    kind: Kind;
    id: string;
    reference: string | null;
    account: string | null;
    name: string | null;
    channel: string | null;
    amount: bigint;
    currency: string;
    state: 'waiting' | 'sent' | 'cancelled';
    by: string | null;
    at: Date;
    sentAt: Date | null;
    sentBy: string | null;
  } | null = null;
  if (kind === 'deal') {
    const row = await prisma.transaction.findUnique({
      where: { id },
      select: {
        reference: true,
        payoutAccount: true,
        recipientName: true,
        counterpartyName: true,
        payoutBankChannel: true,
        payoutBankAmount: true,
        toCurrency: true,
        status: true,
        createdAt: true,
        transferConfirmedAt: true,
        createdBy: { select: { fullNameAr: true } },
        transferConfirmedBy: { select: { fullNameAr: true } },
      },
    });
    if (row) {
      card = {
        kind,
        id,
        reference: row.reference,
        account: row.payoutAccount,
        name: row.recipientName ?? row.counterpartyName,
        channel: row.payoutBankChannel,
        amount: row.payoutBankAmount,
        currency: row.toCurrency,
        state: row.status === 'REVERSED' ? 'cancelled' : row.status === 'PENDING_TRANSFER' ? 'waiting' : 'sent',
        by: row.createdBy?.fullNameAr ?? null,
        at: row.createdAt,
        sentAt: row.transferConfirmedAt,
        sentBy: row.transferConfirmedBy?.fullNameAr ?? null,
      };
    }
  } else if (kind === 'request') {
    const row = await prisma.bankRequest.findUnique({ where: { id } });
    if (row) {
      card = {
        kind,
        id,
        reference: null,
        account: row.account,
        name: row.name,
        channel: row.channel,
        amount: row.amount,
        currency: row.currency,
        state: row.status === 'DISMISSED' ? 'cancelled' : row.status === 'SENT' ? 'sent' : 'waiting',
        by: row.addedByName ?? row.senderName,
        at: row.createdAt,
        sentAt: row.sentAt,
        sentBy: row.sentByName,
      };
    }
  } else {
    const row = await prisma.tiktokWithdrawal.findUnique({
      where: { id },
      select: {
        account: true,
        beneficiaryName: true,
        channel: true,
        payoutAmount: true,
        cashAmount: true,
        createdAt: true,
        deletedAt: true,
        sentAt: true,
        sentByName: true,
        createdBy: { select: { fullNameAr: true } },
      },
    });
    if (row) {
      card = {
        kind,
        id,
        reference: 'TikTok',
        account: row.account,
        name: row.beneficiaryName,
        channel: row.channel,
        amount: row.payoutAmount - row.cashAmount,
        currency: 'ILS',
        state: row.deletedAt ? 'cancelled' : row.sentAt ? 'sent' : 'waiting',
        by: row.createdBy?.fullNameAr ?? null,
        at: row.createdAt,
        sentAt: row.sentAt,
        sentBy: row.sentByName,
      };
    }
  }
  if (!card) return null;
  const [paid, receipts] = await Promise.all([
    paidSoFar([{ kind, id, currency: card.currency }]),
    listReceipts(kind, id),
  ]);
  return { ...card, paid: paid.get(`${kind}:${id}`) ?? null, receipts: receipts.length };
}

/** What was read off the photo before, if it was. */
async function readingOf(mediaId: string): Promise<ReceiptDetails | null> {
  const row = await prisma.mediaReading.findFirst({ where: { mediaId }, orderBy: { createdAt: 'desc' } });
  if (!row) return null;
  try {
    return JSON.parse(row.fields) as ReceiptDetails;
  } catch {
    return null;
  }
}

export async function messageDetail(messageId: string, actor: Actor) {
  requireDesk(actor);
  const message = await prisma.groupMessage.findUnique({ where: { id: messageId } });
  if (!message) throw errors.notFound('GroupMessage', messageId);
  const groups = await watched();
  const nameOf = (chat: string) => groups.find((group) => group.id === chat)?.name ?? null;

  // What it replies to: kept when it was a photo answering a message.
  const reply = await prisma.groupReply.findFirst({ where: { chat: message.chat, waId: message.waId } });
  const quoted = reply
    ? await prisma.groupMessage.findUnique({ where: { chat_waId: { chat: message.chat, waId: reply.quotedWaId } } })
    : null;

  // The transfer it is, or the one it answers.
  const own = await transferOf({ chat: message.chat, waId: message.waId }).catch(() => null);
  const answered = !own && reply ? await transferOf({ chat: message.chat, waId: reply.quotedWaId }).catch(() => null) : null;
  const found = own ?? answered;
  const transfer = found ? await transferCard(found.kind, found.id) : null;

  const image = message.mediaId && message.mediaKind === 'image' ? message.mediaId : null;
  return {
    group: nameOf(message.chat),
    image,
    reading: image ? await readingOf(image) : null,
    /** The message it replies to, when that is kept; `replied` alone when it is not. */
    replied: Boolean(reply),
    quoted: quoted
      ? {
          id: quoted.id,
          fromMe: quoted.fromMe,
          senderName: quoted.senderName,
          senderPhone: quoted.senderPhone,
          text: quoted.text,
          mediaId: quoted.mediaId,
          mediaKind: quoted.mediaKind,
          at: quoted.createdAt,
        }
      : null,
    transfer,
    /** The transfer is this message itself, not one it answers. */
    isTransfer: Boolean(own),
  };
}

/** The message's photo read field by field, and kept: asked again, it is not read twice. */
export async function readMessage(messageId: string, actor: Actor, again = false) {
  requireDesk(actor);
  const message = await prisma.groupMessage.findUnique({ where: { id: messageId } });
  if (!message?.mediaId || message.mediaKind !== 'image') throw errors.notFound('GroupMessage', messageId);
  if (!again) {
    const kept = await readingOf(message.mediaId);
    if (kept) return { reading: kept };
  }
  const file = await prisma.chatImage.findUnique({ where: { id: message.mediaId }, select: { data: true, mimeType: true } });
  if (!file) throw errors.notFound('ChatImage', message.mediaId);
  const reading = await readReceiptDetails({ bytes: Buffer.from(file.data), mimeType: file.mimeType });
  if (!reading) return { reading: null };
  await prisma.mediaReading.create({ data: { mediaId: message.mediaId, fields: JSON.stringify(reading) } });
  log.info('A receipt in a group was read in full');
  return { reading };
}
