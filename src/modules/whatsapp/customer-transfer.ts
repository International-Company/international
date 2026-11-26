import 'server-only';
import { prisma } from '@/core/db/prisma';
import { createLogger } from '@/core/logger/logger';
import * as settings from '@/modules/settings/settings.service';
import { dealAccount, DEAL_ACCOUNT_SELECT } from '@/modules/bank/deal-account';
import { formatFigure } from './report-command';
import { recordMessage } from './bot-store';
import { keepMedia } from './chat-images';
import { candidateNumbers } from './inbox-numbers';
import { isLinked, sendPrivateImage } from './whatsapp.service';

const log = createLogger('whatsapp:customer-transfer');

/** Kept left to right inside Arabic, so «220.5 ILS» is not read as «ILS 220.5». */
export const ltr = (text: string) => `⁦${text}⁩`;

/**
 * The private number's conversation with this customer, if there is one: the
 * office has written with them on WhatsApp, so the receipt goes where they
 * already talk to it. None, and nothing is sent — a customer is not written
 * to out of the blue.
 */
async function conversationOf(phone: string) {
  const numbers = candidateNumbers(phone);
  if (numbers.length === 0) return null;
  return prisma.botConversation.findFirst({
    where: { phone: { in: numbers } },
    orderBy: { lastMessageAt: 'desc' },
    select: { chat: true, phone: true },
  });
}

/**
 * The bank's receipts of a deal's transfer, sent on to its customer in their
 * WhatsApp conversation with the private number, each once: the photo, with
 * "تم التحويل بنجاح ✔" and where it went under the first. Called whenever a
 * receipt joins a deal — at "sent", from the floating window, from a group's
 * reply; one already sent is not sent again.
 */
export async function tellCustomerTransfer(transactionId: string, actorName = 'المكتب'): Promise<number> {
  if (!(await settings.getBoolean('whatsapp.enabled')) || !(await settings.getBoolean('customers.transferReceipt'))) return 0;
  if (!isLinked()) return 0;

  const deal = await prisma.transaction.findUnique({
    where: { id: transactionId },
    select: {
      ...DEAL_ACCOUNT_SELECT,
      status: true,
      transferConfirmedAt: true,
      payoutBankAmount: true,
      payoutBankChannel: true,
      toCurrency: true,
    },
  });
  if (!deal || deal.status === 'REVERSED' || deal.payoutBankAmount <= 0n) return 0;
  const phone = deal.customer?.phone?.trim();
  if (!phone) return 0;
  const conversation = await conversationOf(phone);
  if (!conversation) return 0;

  const waiting = await prisma.transactionProof.findMany({
    where: { transactionId, kind: 'TRANSFER', customerSentAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (waiting.length === 0) return 0;

  // Claimed before it is sent, so two callers at once send it once.
  const claimed: string[] = [];
  for (const proof of waiting) {
    const taken = await prisma.transactionProof.updateMany({
      where: { id: proof.id, customerSentAt: null },
      data: { customerSentAt: new Date() },
    });
    if (taken.count === 1) claimed.push(proof.id);
  }
  if (claimed.length === 0) return 0;

  const account = dealAccount(deal);
  const where = [deal.payoutBankChannel, account ? ltr(account) : null].filter(Boolean).join(' — ');
  // The sum only when it is all of it: one receipt, the transfer closed.
  const whole =
    Boolean(deal.transferConfirmedAt) &&
    (await prisma.transactionProof.count({ where: { transactionId, kind: 'TRANSFER' } })) === 1;
  const words = [
    'تم التحويل بنجاح ✔',
    whole ? `المبلغ: ${ltr(`${formatFigure(deal.payoutBankAmount)} ${deal.toCurrency}`)}` : null,
    where ? `إلى: ${where}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  let sent = 0;
  for (const [index, id] of claimed.entries()) {
    const proof = await prisma.transactionProof.findUnique({ where: { id }, select: { data: true, mimeType: true } });
    if (!proof || !proof.mimeType.startsWith('image/')) continue;
    const bytes = Buffer.from(proof.data);
    const caption = index === 0 ? words : '';
    try {
      const waId = await sendPrivateImage(conversation.chat, bytes, proof.mimeType, caption);
      const kept = await keepMedia({ bytes, mimeType: proof.mimeType }, null).catch(() => null);
      await recordMessage(conversation.chat, conversation.phone ? `${conversation.phone}@s.whatsapp.net` : null, 'staff', caption, {
        authorName: actorName,
        mediaId: kept?.id ?? null,
        mediaKind: kept ? 'image' : null,
        waId,
      }).catch(() => undefined);
      sent++;
    } catch (error) {
      // Not sent: given back, to go with the next receipt or the next try.
      await prisma.transactionProof.update({ where: { id }, data: { customerSentAt: null } }).catch(() => undefined);
      log.warn('Could not send a customer their transfer receipt', { error });
      break;
    }
  }
  if (sent) log.info('A customer was sent the bank receipt of their transfer', { receipts: sent });
  return sent;
}
