import 'server-only';
import { prisma } from '@/core/db/prisma';
import { createLogger } from '@/core/logger/logger';
import * as settings from '@/modules/settings/settings.service';
import { formatFigure } from './report-command';
import { recordMessage } from './bot-store';
import { keepMedia } from './chat-images';
import { candidateNumbers } from './inbox-numbers';
import { privateNumberAddress, sendPrivateImage } from './whatsapp.service';
import { usdtReceiptImage } from './usdt-receipt-image';

const log = createLogger('whatsapp:usdt-receipt');

/** The office's own time, whatever the server's. */
const OFFICE_ZONE = 'Asia/Hebron';

/** 26/11/2026 · 14:20, in the office's time. */
function whenOf(date: Date): string {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: OFFICE_ZONE, day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: OFFICE_ZONE, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  return `${day} · ${clock}`;
}

/** The network the coins came on: the transfer the deal settled, or the one its counter request matched. */
async function networkOf(transactionId: string): Promise<string | null> {
  const chain = await prisma.chainTransaction.findFirst({
    where: { OR: [{ linkedTransactionId: transactionId }, { mergedTransactionId: transactionId }] },
    select: { network: true },
  });
  if (chain) return chain.network;
  const request = await prisma.usdtDepositRequest.findFirst({
    where: { transactionId },
    select: { matchedChainTransaction: { select: { network: true } } },
  });
  return request?.matchedChainTransaction?.network ?? null;
}

/**
 * USDT taken in from a customer with a file and a number: they are sent, from
 * the private number, a receipt — what arrived, what they get for it and how,
 * and when — with a line under it. It lands in their conversation in the
 * customers' WhatsApp, as anything the office sends there does.
 *
 * Never the price, the deal's reference or a balance: what came in and what
 * goes out, nothing the customer could mistake for a promise of more.
 * Returns whether it was sent; a customer with no WhatsApp is not an error.
 */
export async function tellUsdtReceipt(transactionId: string, actor: { name: string }): Promise<boolean> {
  if (!(await settings.getBoolean('whatsapp.enabled'))) return false;
  if (!(await settings.getBoolean('usdt.customerReceipt'))) return false;

  const deal = await prisma.transaction.findUnique({
    where: { id: transactionId },
    select: {
      type: true,
      status: true,
      createdAt: true,
      fromAmount: true,
      fromCurrency: true,
      toAmount: true,
      toCurrency: true,
      payoutCashAmount: true,
      payoutBankAmount: true,
      payoutBankChannel: true,
      payoutAccount: true,
      counterpartyName: true,
      counterpartyPhone: true,
      customer: { select: { fullNameAr: true, phone: true } },
    },
  });
  if (!deal || deal.type !== 'USDT_RECEIVE' || deal.status === 'REVERSED') return false;
  // Only for a customer on file: a passer-by's number is not one to write to unasked.
  const phone = deal.customer?.phone?.trim();
  if (!phone) return false;

  let jid: string | null = null;
  for (const digits of candidateNumbers(phone)) {
    jid = await privateNumberAddress(digits).catch(() => null);
    if (jid) break;
  }
  if (!jid) {
    log.info('A USDT customer has no WhatsApp on their number; no receipt sent');
    return false;
  }

  const office = (await settings.getString('company.name.ar').catch(() => '')).trim();
  const bank = deal.payoutBankAmount > 0n;
  const cash = deal.payoutCashAmount > 0n;
  const png = usdtReceiptImage({
    office,
    customer: deal.customer?.fullNameAr ?? deal.counterpartyName ?? null,
    coins: formatFigure(deal.fromAmount),
    token: deal.fromCurrency,
    network: await networkOf(transactionId),
    total: formatFigure(deal.toAmount),
    currency: deal.toCurrency,
    // Both named when both were used; one alone is the total already.
    cash: cash && bank ? formatFigure(deal.payoutCashAmount) : cash ? formatFigure(deal.toAmount) : null,
    bank: bank
      ? {
          amount: cash ? formatFigure(deal.payoutBankAmount) : formatFigure(deal.toAmount),
          channel: deal.payoutBankChannel,
          account: deal.payoutAccount,
        }
      : null,
    when: whenOf(deal.createdAt),
  });

  const caption = [
    `✅ تم استلام ${formatFigure(deal.fromAmount)} ${deal.fromCurrency} بنجاح`,
    `المبلغ المستحق لك: ${formatFigure(deal.toAmount)} ${deal.toCurrency}`,
    'شكراً لتعاملك معنا 🤝',
  ].join('\n');

  const waId = await sendPrivateImage(jid, png, 'image/png', caption);
  const kept = await keepMedia({ bytes: png, mimeType: 'image/png' }, null).catch(() => null);
  await recordMessage(jid, jid, 'staff', caption, {
    authorName: actor.name,
    mediaId: kept?.id ?? null,
    mediaKind: kept ? 'image' : null,
    waId,
  }).catch((error) => log.warn('Could not keep the USDT receipt in the conversation', { error }));
  log.info('A customer was sent their USDT receipt');
  return true;
}
