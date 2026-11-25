import 'server-only';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import { customerNames, shownName } from './chat-names';
import { answer, followGroup } from './teller-whatsapp.service';
import { toDecimalString } from '@/core/money/money';
import * as remittances from '@/modules/exchange/remittance.service';
import { quoteExchange } from '@/modules/exchange/rates.service';
import type { Actor } from '@/modules/exchange/transaction.service';
import * as settings from '@/modules/settings/settings.service';
import { createCustomer } from '@/modules/customers/customers.service';
import { payoutsFor, remember } from '@/modules/usdt/recognition.service';

const log = createLogger('whatsapp:notices');

/**
 * Remittance notices, received and checked from the customer inbox.
 *
 * A customer sends the teller, on the teller's own number, the photo of a
 * remittance sent to them — Western Union, MoneyGram, PayPal. Before a shekel
 * is paid out it is checked with the network's agent: the photo goes, from the
 * same number, to the group the teller shares with the agent, and what the
 * agent answers under it is read back beside the customer's conversation.
 * The teller then says confirmed or rejected; a confirmed notice is what a
 * remittance is paid out against, at the next step.
 *
 * Every notice is the teller's own, as the conversation it came from is.
 */

/** The methods the screen says in its own language; anything else in the list is a name, shown as written. */
export const BUILT_IN_NETWORKS = ['WESTERN', 'MONEYGRAM', 'PAYPAL', 'RIA', 'USDT', 'BANK', 'OTHER'];
export type Network = string;

const NETWORK_WORDS: Record<string, string> = {
  WESTERN: 'ويسترن يونيون',
  MONEYGRAM: 'موني غرام',
  PAYPAL: 'باي بال',
  RIA: 'ريا',
  USDT: 'USDT',
  BANK: 'حوالة بنكية',
  OTHER: 'حوالة',
};

/** A method in words, for what is written in a group. */
export const networkWord = (network: string | null | undefined) =>
  (network && NETWORK_WORDS[network]) || network || 'حوالة';

/** The methods offered on a remittance taken from a chat, as the settings list them. */
export async function noticeNetworks(): Promise<string[]> {
  const raw = await settings.getString('remittance.noticeNetworks').catch(() => '');
  const list = [...new Set(raw.split(',').map((entry) => entry.trim()).filter(Boolean))];
  return list.length ? list : BUILT_IN_NETWORKS;
}

async function owned(ownerId: string, id: string) {
  const row = await prisma.remittanceNotice.findFirst({ where: { id, ownerId } });
  if (!row) throw errors.notFound('RemittanceNotice', id);
  return row;
}

/** A photo of the customer's conversation, taken as a remittance notice. */
export async function createNotice(ownerId: string, messageId: string) {
  const message = await prisma.tellerChatMessage.findFirst({
    where: { id: messageId, chat: { ownerId } },
    include: { chat: true },
  });
  if (!message) throw errors.notFound('TellerChatMessage', messageId);
  if (!message.imageId) {
    throw errors.precondition('Only a photo can be a remittance notice', 'errors.noticeNeedsPhoto');
  }
  // The same photo taken twice is the same notice.
  const already = await prisma.remittanceNotice.findFirst({ where: { ownerId, messageId } });
  if (already) return { id: already.id };
  const records = await customerNames([message.chat.phone]);
  const row = await prisma.remittanceNotice.create({
    data: {
      ownerId,
      chatId: message.chatId,
      messageId: message.id,
      imageId: message.imageId,
      customerName: shownName(message.chat.phone, message.chat.name, records),
      customerPhone: message.chat.phone,
    },
  });
  return { id: row.id };
}

/**
 * A remittance the customer sends, opened from their conversation: who it is
 * for and what reaches them are written in, their payment's photo chosen from
 * the conversation when they paid by transfer.
 */
export async function createOutgoing(ownerId: string, chatId: string) {
  const chat = await prisma.tellerChat.findFirst({ where: { id: chatId, ownerId } });
  if (!chat) throw errors.notFound('TellerChat', chatId);
  const records = await customerNames([chat.phone]);
  const row = await prisma.remittanceNotice.create({
    data: {
      ownerId,
      chatId: chat.id,
      direction: 'OUT',
      network: (await noticeNetworks())[0] ?? 'OTHER',
      customerName: shownName(chat.phone, chat.name, records),
      customerPhone: chat.phone,
      intakeMethod: 'CASH',
    },
  });
  return { id: row.id };
}

/** What the teller read off it: the network, the sum, a note. */
export async function updateNotice(
  ownerId: string,
  id: string,
  input: {
    network?: Network;
    amount?: bigint | null;
    currency?: string | null;
    note?: string | null;
    beneficiaryName?: string | null;
    beneficiaryPhone?: string | null;
    beneficiaryAccount?: string | null;
    destination?: string | null;
    deliverAmount?: bigint | null;
    deliverCurrency?: string | null;
    intakeMethod?: string | null;
    intakeChannel?: string | null;
    /** A photo of the conversation taken as the customer's payment. */
    photoMessageId?: string | null;
  },
) {
  const notice = await owned(ownerId, id);
  if (input.network && !(await noticeNetworks()).includes(input.network) && input.network !== notice.network) {
    throw errors.validation([{ path: 'network', message: 'Not a method the settings offer' }]);
  }
  const text = (value: string | null | undefined, max: number) =>
    value === undefined ? undefined : value?.trim().slice(0, max) || null;
  let imageId: string | null | undefined;
  if (input.photoMessageId !== undefined) {
    imageId = input.photoMessageId
      ? ((
          await prisma.tellerChatMessage.findFirst({
            where: { id: input.photoMessageId, chatId: notice.chatId, imageId: { not: null } },
            select: { imageId: true },
          })
        )?.imageId ?? undefined)
      : null;
  }
  await prisma.remittanceNotice.update({
    where: { id },
    data: {
      ...(input.network ? { network: input.network } : {}),
      ...(text(input.beneficiaryName, 120) !== undefined ? { beneficiaryName: text(input.beneficiaryName, 120) } : {}),
      ...(text(input.beneficiaryPhone, 40) !== undefined ? { beneficiaryPhone: text(input.beneficiaryPhone, 40) } : {}),
      ...(text(input.beneficiaryAccount, 80) !== undefined ? { beneficiaryAccount: text(input.beneficiaryAccount, 80) } : {}),
      ...(text(input.destination, 120) !== undefined ? { destination: text(input.destination, 120) } : {}),
      ...(input.deliverAmount !== undefined
        ? { deliverAmount: input.deliverAmount && input.deliverAmount > 0n ? input.deliverAmount : null }
        : {}),
      ...(input.deliverCurrency !== undefined ? { deliverCurrency: input.deliverCurrency?.trim().toUpperCase() || null } : {}),
      ...(input.intakeMethod !== undefined
        ? { intakeMethod: ['CASH', 'BANK', 'SPLIT'].includes(input.intakeMethod ?? '') ? input.intakeMethod : null }
        : {}),
      ...(text(input.intakeChannel, 80) !== undefined ? { intakeChannel: text(input.intakeChannel, 80) } : {}),
      ...(imageId !== undefined ? { imageId } : {}),
      ...(input.amount !== undefined ? { amount: input.amount && input.amount > 0n ? input.amount : null } : {}),
      ...(input.currency !== undefined ? { currency: input.currency?.trim().toUpperCase() || null } : {}),
      ...(input.note !== undefined ? { note: input.note?.trim().slice(0, 500) || null } : {}),
    },
  });
  return noticeDetail(ownerId, id);
}

/**
 * Sent for checking: the photo, from the teller's number, to the agent's group,
 * with a line saying what it is. The group is followed, so what the agent
 * answers is read; sent again, it goes again — to the same group or another.
 */
export async function sendForCheck(ownerId: string, id: string, agentChat: string) {
  const notice = await owned(ownerId, id);
  if (notice.status === 'CONFIRMED' || notice.status === 'REJECTED') {
    throw errors.conflict('This notice is already decided', 'errors.noticeDecided');
  }
  const followed = await followGroup(ownerId, agentChat, true);
  if (!followed.id) throw errors.precondition('That group cannot be used', 'errors.tellerSendFailed');
  if (notice.direction === 'OUT') return sendOutgoing(ownerId, notice, agentChat, followed.id);
  const image = notice.imageId ? await prisma.chatImage.findUnique({ where: { id: notice.imageId } }) : null;
  if (!image) throw errors.notFound('ChatImage', notice.imageId ?? '');

  const amount = notice.amount ? ` · ${Number(notice.amount) / 1e8} ${notice.currency ?? ''}`.trimEnd() : '';
  // The agent checks the notice, not the customer: their name and number stay with the office.
  const caption = `🔍 للتشييك — ${networkWord(notice.network)}${amount}`;

  await answer(ownerId, followed.id, caption, Buffer.from(image.data).toString('base64'));
  // The message it went as: the newest the teller's number wrote there, carrying a photo.
  const sent = await prisma.tellerChatMessage.findFirst({
    where: { chatId: followed.id, fromMe: true, imageId: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  const group = await prisma.tellerChat.findUnique({ where: { id: followed.id }, select: { name: true } });
  await prisma.remittanceNotice.update({
    where: { id },
    data: {
      agentChat,
      agentName: group?.name ?? null,
      sentMessageId: sent?.id ?? null,
      sentAt: new Date(),
      status: 'CHECKING',
    },
  });
  log.info('A remittance notice was sent for checking');
  return noticeDetail(ownerId, id);
}

const figureOf = (value: bigint | null, currency: string | null) =>
  value ? `${toDecimalString(value, 2).replace(/\.00$/, '')} ${currency ?? ''}`.trim() : null;

/**
 * Sent out: the details the agent carries it out with, written to their group —
 * who it is for, their number and account, where, and what reaches them.
 */
async function sendOutgoing(
  ownerId: string,
  notice: Awaited<ReturnType<typeof owned>>,
  agentChat: string,
  groupChatId: string,
) {
  if (!notice.beneficiaryName?.trim() || !notice.deliverAmount) {
    throw errors.precondition('Write who it is for and how much reaches them', 'errors.outgoingIncomplete');
  }
  const text = [
    `📤 حوالة للتنفيذ — ${networkWord(notice.network)}`,
    notice.destination ? `الوجهة: ${notice.destination}` : null,
    `المستفيد: ${notice.beneficiaryName}`,
    notice.beneficiaryPhone ? `الهاتف: ${notice.beneficiaryPhone}` : null,
    notice.beneficiaryAccount ? `الحساب: ${notice.beneficiaryAccount}` : null,
    `المبلغ: ${figureOf(notice.deliverAmount, notice.deliverCurrency)}`,
  ]
    .filter(Boolean)
    .join('\n');
  await answer(ownerId, groupChatId, text);
  const sent = await prisma.tellerChatMessage.findFirst({
    where: { chatId: groupChatId, fromMe: true },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  const group = await prisma.tellerChat.findUnique({ where: { id: groupChatId }, select: { name: true } });
  await prisma.remittanceNotice.update({
    where: { id: notice.id },
    data: { agentChat, agentName: group?.name ?? null, sentMessageId: sent?.id ?? null, sentAt: new Date(), status: 'CHECKING' },
  });
  log.info('An outgoing remittance was sent to its agent');
  return noticeDetail(ownerId, notice.id);
}

/** The teller's word on it: confirmed by the agent, or not. */
export async function decideNotice(ownerId: string, id: string, decision: 'CONFIRMED' | 'REJECTED', by: string) {
  const notice = await owned(ownerId, id);
  if (notice.transactionId) throw errors.conflict('This notice is already paid out', 'errors.noticeDecided');
  await prisma.remittanceNotice.update({
    where: { id },
    data: { status: decision, decidedAt: new Date(), decidedByName: by },
  });
  return noticeDetail(ownerId, id);
}

/** Back to checking: a decision taken by mistake. */
export async function reopenNotice(ownerId: string, id: string) {
  // Paid out already: what was decided stands with the remittance made from it.
  const paid = await owned(ownerId, id);
  if (paid.transactionId) throw errors.precondition('Already paid out', 'errors.noticeAlreadyPaid');
  const notice = await owned(ownerId, id);
  if (notice.transactionId) throw errors.conflict('This notice is already paid out', 'errors.noticeDecided');
  await prisma.remittanceNotice.update({
    where: { id },
    data: { status: notice.sentAt ? 'CHECKING' : 'NEW', decidedAt: null, decidedByName: null },
  });
  return noticeDetail(ownerId, id);
}

/**
 * What the agent said: the answers quoting the photo sent them, and failing
 * those, what was written in the group since — an agent does not always quote.
 */
async function agentReplies(notice: { agentChat: string | null; sentMessageId: string | null; sentAt: Date | null; ownerId: string }) {
  if (!notice.agentChat || !notice.sentAt) return { quoted: [], since: [] };
  const group = await prisma.tellerChat.findFirst({
    where: { ownerId: notice.ownerId, chat: notice.agentChat },
    select: { id: true },
  });
  if (!group) return { quoted: [], since: [] };
  const shape = (row: { id: string; text: string; authorName: string | null; imageId: string | null; createdAt: Date; fromMe: boolean }) => ({
    id: row.id,
    text: row.text,
    author: row.fromMe ? null : row.authorName,
    fromMe: row.fromMe,
    imageId: row.imageId,
    at: row.createdAt,
  });
  const quoted = notice.sentMessageId
    ? await prisma.tellerChatMessage.findMany({
        where: { chatId: group.id, quotedId: notice.sentMessageId },
        orderBy: { createdAt: 'asc' },
        take: 20,
      })
    : [];
  const since = await prisma.tellerChatMessage.findMany({
    where: { chatId: group.id, createdAt: { gt: notice.sentAt }, fromMe: false, id: { notIn: quoted.map((row) => row.id) } },
    orderBy: { createdAt: 'asc' },
    take: 6,
  });
  return { quoted: quoted.map(shape), since: since.map(shape) };
}

function noticeLine(row: Awaited<ReturnType<typeof owned>>) {
  return {
    id: row.id,
    chatId: row.chatId,
    messageId: row.messageId,
    imageId: row.imageId,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    network: row.network,
    direction: row.direction,
    beneficiaryName: row.beneficiaryName,
    beneficiaryPhone: row.beneficiaryPhone,
    beneficiaryAccount: row.beneficiaryAccount,
    destination: row.destination,
    deliverAmount: row.deliverAmount,
    deliverCurrency: row.deliverCurrency,
    intakeMethod: row.intakeMethod,
    intakeChannel: row.intakeChannel,
    amount: row.amount,
    currency: row.currency,
    agentChat: row.agentChat,
    agentName: row.agentName,
    sentAt: row.sentAt,
    status: row.status,
    decidedAt: row.decidedAt,
    decidedByName: row.decidedByName,
    note: row.note,
    transactionId: row.transactionId,
    createdAt: row.createdAt,
  };
}

/** One notice in full, with what the agent has said so far. */
export async function noticeDetail(ownerId: string, id: string) {
  const row = await owned(ownerId, id);
  return { ...noticeLine(row), replies: await agentReplies(row), networks: await noticeNetworks() };
}

/** The teller's notices, newest first: those still being checked, then the rest of the last days. */
export async function listNotices(ownerId: string) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await prisma.remittanceNotice.findMany({
    where: { ownerId, OR: [{ status: { in: ['NEW', 'CHECKING'] } }, { createdAt: { gte: since } }] },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  // How many answers each has had from its agent: a quick sign it has moved.
  const counts = await Promise.all(
    rows.map(async (row) => {
      // Only those still being checked: a decided notice's answers are history.
      if (row.status !== 'CHECKING') return 0;
      const replies = await agentReplies(row);
      return replies.quoted.length + replies.since.length;
    }),
  );
  return rows.map((row, index) => ({ ...noticeLine(row), replyCount: counts[index] ?? 0 }));
}

// ---------------------------------------------------------------------------
// Paid out: a confirmed notice made the incoming remittance it is
// ---------------------------------------------------------------------------

/** What the form offers: where it came through, where it may be paid, in what money. */
export async function remitOptions(ownerId: string, id: string) {
  const notice = await owned(ownerId, id);
  const [settings, currencies] = await Promise.all([
    remittances.config(),
    prisma.currency.findMany({
      where: { isActive: true, kind: 'FIAT' },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, nameAr: true, nameEn: true },
    }),
  ]);
  // The correspondent the network's name points to, when the manager's list has it.
  const word = networkWord(notice.network);
  const suggested =
    settings.destinations.find((entry) => entry.includes(word.split(' ')[0]!)) ??
    settings.destinations.find((entry) => word.includes(entry)) ??
    null;
  const customer = await customerOf(notice.customerPhone);
  return {
    destinations: settings.destinations,
    channels: settings.transferChannels,
    currencies,
    suggested,
    customer: customer
      ? { id: customer.id, code: customer.code, name: customer.fullNameAr, idNumber: customer.nationalId }
      : null,
    payouts: customer ? await payoutsFor(customer.id) : [],
  };
}

/** The office's file for a phone, matched on its last nine digits as the chats' names are. */
async function customerOf(phone: string | null | undefined, db: DbClient = prisma) {
  const digits = phone?.replace(/\D/g, '') ?? '';
  if (digits.length < 9) return null;
  return db.customer.findFirst({
    where: { phone: { endsWith: digits.slice(-9) } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, code: true, fullNameAr: true, nationalId: true },
  });
}

/** What a sum comes to in the money it is paid out in, at the board, as the counter prices it. */
export async function quoteRemit(ownerId: string, id: string, amount: bigint, from: string, to: string) {
  await owned(ownerId, id);
  if (amount <= 0n || from === to) return { toAmount: amount, rate: 100_000_000n };
  const quoted = await quoteExchange(from, to, amount, 'CASH');
  return { toAmount: quoted.toAmount, rate: quoted.rate };
}

export interface RemitInput {
  destination: string;
  currency: string;
  credited: bigint;
  payCurrency: string;
  paid: bigint;
  /** Paid by transfer to the customer's bank or wallet; otherwise in notes at the counter. */
  payoutChannel?: string | null;
  payoutAccount?: string | null;
  recipientName?: string | null;
  recipientIdNumber?: string | null;
  /**
   * Paid in a second currency too: this much of what was received is paid in
   * other money — in notes or to an account — and the rest as above.
   */
  second?: RemitPart | null;
}

export interface RemitPart {
  /** The share of what was received, in the money it was received in. */
  credited: bigint;
  payCurrency: string;
  paid: bigint;
  payoutChannel?: string | null;
  payoutAccount?: string | null;
}

const figure = (value: bigint) => toDecimalString(value, 2).replace(/\.00$/, '');

/**
 * The remittance a confirmed notice is paid out as: received from the
 * correspondent, paid to the customer at the board's rate, in notes or to their
 * bank — which puts it on the bank desk with every other transfer to make. The
 * notice's photo goes with it. Comes back with the words for the customer,
 * for the teller to read over before they are sent.
 */
export async function remitNotice(ownerId: string, id: string, input: RemitInput, actor: Actor) {
  const notice = await owned(ownerId, id);
  if (notice.status !== 'CONFIRMED') {
    throw errors.precondition('Only a confirmed notice is paid out', 'errors.noticeNotConfirmed');
  }
  if (notice.transactionId) throw errors.precondition('Already paid out', 'errors.noticeAlreadyPaid');
  if (!actor.branchId) throw errors.precondition('No branch is assigned', 'errors.noBranch');
  const branchId = actor.branchId;

  // Two currencies: the second takes its share of what was received, the first the rest.
  const second = input.second && input.second.credited > 0n ? input.second : null;
  if (second && (second.credited >= input.credited || second.paid <= 0n)) {
    throw errors.precondition('The second part must be less than what was received', 'errors.remitSplitInvalid');
  }
  const first: RemitPart = {
    credited: second ? input.credited - second.credited : input.credited,
    payCurrency: input.payCurrency,
    paid: input.paid,
    payoutChannel: input.payoutChannel,
    payoutAccount: input.payoutAccount,
  };

  const image = notice.imageId
    ? await prisma.chatImage.findUnique({ where: { id: notice.imageId }, select: { data: true } })
    : null;
  const paypal = notice.network === 'PAYPAL';
  const recipientName = input.recipientName?.trim() || notice.customerName;
  const idNumber = input.recipientIdNumber?.trim() || null;

  const result = await withTransaction(async (tx) => {
    /*
     * The customer's file: the one their phone is already on, or a new one in
     * their name — so every remittance they receive is found in one place.
     */
    let customer = await customerOf(notice.customerPhone, tx);
    if (!customer && notice.customerPhone) {
      const name = recipientName?.trim() || `+${notice.customerPhone}`;
      const made = await createCustomer(
        { fullNameEn: name, fullNameAr: name, phone: notice.customerPhone, branchId },
        actor,
        tx,
      );
      customer = { id: made.id, code: made.code, fullNameAr: made.fullNameAr, nationalId: made.nationalId };
    }
    // Their ID number, when the file has none and nobody else holds it.
    if (customer && idNumber && !customer.nationalId) {
      const holder = await tx.customer.findFirst({ where: { nationalId: idNumber }, select: { id: true } });
      if (!holder) await tx.customer.update({ where: { id: customer.id }, data: { nationalId: idNumber } });
    }

    const post = (part: RemitPart, index: number) => {
      const bank = Boolean(part.payoutChannel?.trim());
      return remittances.receive(
        {
          currency: input.currency.toUpperCase(),
          destination: paypal ? remittances.PAYPAL_DESTINATION : input.destination,
          paypal,
          convert: true,
          branchId,
          customerId: customer?.id ?? null,
          counterpartyName: notice.customerName,
          counterpartyPhone: notice.customerPhone,
          notes: [`إشعار واتساب — ${networkWord(notice.network)}`, second ? `جزء ${index} من 2` : null]
            .filter(Boolean)
            .join(' — '),
          credited: part.credited,
          paid: part.paid,
          payCurrency: part.payCurrency.toUpperCase(),
          // The photo once, with the first.
          notice: index === 1 && image ? Buffer.from(image.data).toString('base64') : null,
          recipientName,
          recipientPhone: notice.customerPhone,
          recipientIdNumber: idNumber,
          payoutBank: bank ? part.paid : null,
          payoutChannel: bank ? part.payoutChannel!.trim() : null,
          payoutAccount: bank ? part.payoutAccount?.trim() || null : null,
        },
        actor,
        tx,
      );
    };
    const one = await post(first, 1);
    const two = second ? await post(second, 2) : null;

    // The accounts used, remembered for their next remittance.
    if (customer) {
      for (const part of [first, second]) {
        if (part?.payoutChannel?.trim() && part.payoutAccount?.trim()) {
          await remember(
            {
              customerId: customer.id,
              network: '',
              address: null,
              payout: { channel: part.payoutChannel, account: part.payoutAccount },
            },
            tx,
          );
        }
      }
    }
    await tx.remittanceNotice.update({
      where: { id: notice.id },
      data: { transactionId: one.id, extraTransactionId: two?.id ?? null },
    });
    return { one, two };
  });
  log.info('A notice was paid out as a remittance', { notice: notice.id, parts: result.two ? 2 : 1 });

  const line = (part: RemitPart) => {
    const paidText = `${figure(part.paid)} ${part.payCurrency.toUpperCase()}`;
    return part.payoutChannel?.trim()
      ? `سيتم تحويل ${paidText} إلى حسابك في ${part.payoutChannel.trim()}${part.payoutAccount?.trim() ? ` (${part.payoutAccount.trim()})` : ''}`
      : `المبلغ ${paidText} جاهز للاستلام من المكتب`;
  };
  const draft = [
    `تم استلام حوالتك ✅`,
    `المبلغ: ${figure(input.credited)} ${input.currency.toUpperCase()}`,
    line(first),
    second ? line(second) : null,
    `رقم المعاملة: ${[result.one.reference, result.two?.reference].filter(Boolean).join(' + ')}`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    notice: await noticeDetail(ownerId, id),
    transaction: { id: result.one.id, reference: result.one.reference },
    draft,
  };
}

// ---------------------------------------------------------------------------
// Sent out: the remittance recorded once the agent carried it out
// ---------------------------------------------------------------------------

export interface RemitOutInput {
  destination: string;
  currency: string;
  /** What the customer paid in all, commission included. */
  collected: bigint;
  /** What the agent charges for it, when known. */
  cost: bigint | null;
  /** Paid by transfer into one of the office's accounts — all of it, or this much and the rest in notes. */
  intakeChannel?: string | null;
  intakeTransfer?: bigint | null;
}

/**
 * The outgoing remittance a carried-out request is, recorded: the customer's
 * money in — in notes, by transfer, or both — and the agent owed for it. The
 * photo of the customer's payment goes with it. Comes back with words for the
 * customer, for the teller to read over before they are sent.
 */
export async function remitOutNotice(ownerId: string, id: string, input: RemitOutInput, actor: Actor) {
  const notice = await owned(ownerId, id);
  if (notice.direction !== 'OUT') throw errors.precondition('Not an outgoing remittance', 'errors.noticeNotConfirmed');
  if (notice.status !== 'CONFIRMED') {
    throw errors.precondition('Only one the agent carried out is recorded', 'errors.noticeNotConfirmed');
  }
  if (notice.transactionId) throw errors.precondition('Already recorded', 'errors.noticeAlreadyPaid');
  if (!actor.branchId) throw errors.precondition('No branch is assigned', 'errors.noBranch');

  const image = notice.imageId
    ? await prisma.chatImage.findUnique({ where: { id: notice.imageId }, select: { data: true } })
    : null;
  const paypal = notice.network === 'PAYPAL';
  const posted = await remittances.send(
    {
      currency: input.currency.toUpperCase(),
      destination: paypal ? remittances.PAYPAL_DESTINATION : input.destination,
      paypal,
      branchId: actor.branchId,
      counterpartyName: notice.customerName,
      counterpartyPhone: notice.customerPhone,
      notes: [`واتساب — ${networkWord(notice.network)}`, notice.beneficiaryName ? `المستفيد: ${notice.beneficiaryName}` : null]
        .filter(Boolean)
        .join(' — '),
      collected: input.collected,
      cost: input.cost,
      intakeChannel: input.intakeChannel?.trim() || null,
      intakeTransfer: input.intakeChannel?.trim() && input.intakeTransfer ? input.intakeTransfer : null,
      deliveredAmount: notice.deliverAmount,
      deliveredUnit: notice.deliverCurrency,
      proof: image ? Buffer.from(image.data).toString('base64') : null,
    },
    actor,
  );
  await prisma.remittanceNotice.update({ where: { id: notice.id }, data: { transactionId: posted.id } });
  log.info('An outgoing remittance was recorded from a chat', { notice: notice.id });

  const draft = [
    'تم إرسال حوالتك ✅',
    notice.beneficiaryName ? `المستفيد: ${notice.beneficiaryName}` : null,
    figureOf(notice.deliverAmount, notice.deliverCurrency) ? `المبلغ: ${figureOf(notice.deliverAmount, notice.deliverCurrency)}` : null,
    `رقم المعاملة: ${posted.reference}`,
  ]
    .filter(Boolean)
    .join('\n');
  return { notice: await noticeDetail(ownerId, id), transaction: { id: posted.id, reference: posted.reference }, draft };
}

/**
 * A photo the agent answered with — the receipt, the remittance's code —
 * passed to the customer in their own conversation.
 */
export async function passToCustomer(ownerId: string, id: string, replyId: string) {
  const notice = await owned(ownerId, id);
  const replies = await agentReplies(notice);
  const reply = [...replies.quoted, ...replies.since].find((entry) => entry.id === replyId);
  if (!reply?.imageId) throw errors.notFound('TellerChatMessage', replyId);
  const image = await prisma.chatImage.findUnique({ where: { id: reply.imageId }, select: { data: true } });
  if (!image) throw errors.notFound('ChatImage', reply.imageId);
  const caption = notice.direction === 'OUT' ? 'إيصال حوالتك ✅' : 'إشعار حوالتك ✅';
  await answer(ownerId, notice.chatId, caption, Buffer.from(image.data).toString('base64'));
  return noticeDetail(ownerId, id);
}
