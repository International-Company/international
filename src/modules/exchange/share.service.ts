import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import type { Locale } from '@/i18n/config';
import * as settings from '@/modules/settings/settings.service';
import * as audit from '@/modules/audit/audit.service';
import type { Actor } from './transaction.service';

/**
 * A transaction as a message a person can send.
 *
 * ## Why the office needs this at all
 *
 * The receipt is paper. Half the customers who ask for one are not standing at
 * the counter any more — they telephone an hour later, or the money was for a
 * son abroad, or an office in another town wants confirmation that a remittance
 * was actually recorded. Until now the answer was to print a second copy and
 * photograph it, which is how a receipt ends up in a camera roll with a thumb
 * across the reference.
 *
 * ## Why the text is composed here and not on the screen
 *
 * Four screens can record a transaction and each already knows how to display
 * one, so each could compose its own message. Then the exchange message and the
 * remittance message drift apart, one of them keeps saying "rate" after the
 * wording changed, and — the real risk — one of them one day includes the
 * margin, because the margin is right there in the component's props.
 *
 * Composed once, from the database, with the margin unreachable: this module
 * never selects it.
 *
 * ## What it does not say
 *
 * The office's cost, its spread, its own note on the deal, the customer's
 * identity document. A note is written by a teller for the office — "من أبو
 * محمد", "يستلمها بكرا" — and reads very differently once it is in the hands of
 * the person it describes.
 *
 * ## Plain text, deliberately
 *
 * It is going into WhatsApp. No markdown, no labels — the number, the amount,
 * the channel and the name, a blank line between each, which is how the office
 * already writes these by hand.
 */

/**
 * The currency as the office says it. The catalogue's "شيكل إسرائيلي" is right
 * on a report and wrong in a message, where it is only ever "شيكل".
 */
const SHORT_AR: Record<string, string> = {
  ILS: 'شيكل',
  USD: 'دولار',
  JOD: 'دينار',
  USDT: 'USDT',
};

/** What the button needs: the words, and who to send them to. */
export interface Shareable {
  reference: string;
  /** The letterhead of the PDF. Not in the message: the message is the deal. */
  companyName: string;
  text: string;
  /** The customer's number, when the transaction carries one. */
  phone: string | null;
}

/**
 * A transaction, written out.
 *
 * Only a posted or promised one. A draft is not a fact yet, and a reversed one
 * is a fact that stopped being true — sending either would be the office
 * telling someone something it does not itself believe.
 */
export async function shareable(
  id: string,
  locale: Locale,
  db: DbClient = prisma,
): Promise<Shareable> {
  const transaction = await db.transaction.findUnique({
    where: { id },
    select: {
      id: true,
      reference: true,
      type: true,
      status: true,
      toCurrency: true,
      toAmount: true,
      payoutBankAmount: true,
      payoutBankChannel: true,
      payoutAddress: true,
      counterpartyName: true,
      counterpartyPhone: true,
      customer: { select: { fullNameAr: true, fullNameEn: true, phone: true } },
      payoutWallet: { select: { network: true } },
    },
  });

  if (!transaction) throw errors.notFound('Transaction', id);
  if (transaction.status !== 'POSTED' && transaction.status !== 'PENDING_TRANSFER') {
    throw errors.precondition(
      'Only a posted transaction can be shared',
      'errors.notShareable',
    );
  }

  const name = <T extends Record<string, unknown>>(row: T | null, field: string): string =>
    String(row?.[locale === 'ar' ? `${field}Ar` : `${field}En`] ?? '');

  const [company, currency] = await Promise.all([
    settings.getString(locale === 'ar' ? 'company.name.ar' : 'company.name.en', db),
    db.currency.findUnique({
      where: { code: transaction.toCurrency },
      select: { nameAr: true, nameEn: true },
    }),
  ]);

  const phone = transaction.customer?.phone ?? transaction.counterpartyPhone ?? null;
  const who = transaction.customer
    ? name(transaction.customer, 'fullName')
    : transaction.counterpartyName;

  /*
   * What the person on the other end is paid, and nothing else.
   *
   * When part of it went by bank, that part is what reaches him through the
   * channel named underneath; the cash the customer took at the counter is not
   * his business. Whole amounts lose their ".00" — "320 شيكل" is how the office
   * writes it.
   */
  const paid =
    transaction.payoutBankAmount > 0n ? transaction.payoutBankAmount : transaction.toAmount;
  const amount = toDecimalString(paid, 2).replace(/\.00$/, '');

  /*
   * Four lines, the way the office already writes them by hand: the number,
   * the amount, the channel it goes through, and the name. Each only when the
   * transaction has it — a blank line where a field is missing would read as
   * something left out.
   *
   * The address of a USDT withdrawal stays: it is the one part nobody can
   * correct afterwards, and a customer who reads it back has saved you both.
   */
  const unit =
    (locale === 'ar' ? SHORT_AR[transaction.toCurrency] : undefined) ??
    (currency ? name(currency, 'name') : transaction.toCurrency);

  const lines = [
    phone,
    `${amount} ${unit}`,
    transaction.payoutBankChannel,
    transaction.payoutAddress
      ? transaction.payoutWallet
        ? `${transaction.payoutAddress} (${transaction.payoutWallet.network})`
        : transaction.payoutAddress
      : null,
    who,
  ].filter((line): line is string => Boolean(line?.trim()));

  return {
    reference: transaction.reference,
    companyName: company ?? '',
    text: lines.join('\n\n'),
    phone,
  };
}

/** Where a share went, as far as this system can honestly tell. */
export const SHARE_CHANNELS = ['SYSTEM', 'WHATSAPP', 'COPY'] as const;
export type ShareChannel = (typeof SHARE_CHANNELS)[number];

/**
 * Records that a transaction left the building.
 *
 * Called after the act rather than before it, because what is worth recording
 * is the sending and not the composing — a teller who opens the menu and thinks
 * better of it has done nothing.
 *
 * It records the door, not the destination. Once the text is in the operating
 * system's share sheet or in WhatsApp, this system cannot see which chat it
 * landed in and must not pretend otherwise: `WHATSAPP` means WhatsApp was
 * opened with the message in it, and nothing more.
 */
export async function recordShare(
  id: string,
  channel: ShareChannel,
  actor: Actor,
  db: DbClient = prisma,
): Promise<void> {
  const transaction = await db.transaction.findUnique({
    where: { id },
    select: { id: true, reference: true },
  });
  if (!transaction) throw errors.notFound('Transaction', id);

  await audit.record(
    {
      action: 'SHARE',
      module: 'exchange',
      entityType: 'Transaction',
      entityId: transaction.id,
      summaryEn: `Shared ${transaction.reference} via ${channel.toLowerCase()}`,
      summaryAr: `مشاركة ${transaction.reference} عبر ${channel.toLowerCase()}`,
      actor,
      metadata: { channel },
    },
    db,
  );
}
