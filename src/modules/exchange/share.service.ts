import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import { formatDateTime } from '@/i18n/format';
import { getDictionary } from '@/i18n/translate';
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
 * It is going into WhatsApp. No markdown, no table alignment that survives one
 * font and not another — a blank line between blocks and a colon after each
 * label, which is what every message in that application already looks like.
 */

/** What the button needs: the words, and who to send them to. */
export interface Shareable {
  reference: string;
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
      createdAt: true,
      fromCurrency: true,
      fromAmount: true,
      toCurrency: true,
      toAmount: true,
      rate: true,
      payoutAddress: true,
      counterpartyName: true,
      counterpartyPhone: true,
      branch: { select: { nameAr: true, nameEn: true } },
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

  const t = getDictionary(locale);
  const say = (key: string): string => {
    const value = key
      .split('.')
      .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], t);
    return typeof value === 'string' ? value : key;
  };
  const name = <T extends Record<string, unknown>>(row: T | null, field: string): string =>
    String(row?.[locale === 'ar' ? `${field}Ar` : `${field}En`] ?? '');

  const company = await settings.getString(
    locale === 'ar' ? 'company.name.ar' : 'company.name.en',
    db,
  );

  const lines: string[] = [];
  const put = (label: string, value: string) => lines.push(`${label}: ${value}`);

  if (company) lines.push(company, '');

  lines.push(say(`transactions.type.${transaction.type}`));
  put(say('transactions.reference'), transaction.reference);

  // A promise is marked as one. The customer has paid and the coins or the
  // transfer have not left yet, and a message that hid that would be the office
  // claiming to have finished something it has not.
  if (transaction.status === 'PENDING_TRANSFER') {
    lines.push(say('machine.pendingTransfer'));
  }

  lines.push('');

  put(
    say('receipt.received'),
    `${toDecimalString(transaction.fromAmount, 2)} ${transaction.fromCurrency}`,
  );

  // An exchange has two sides and a price between them; a remittance in one
  // currency has one amount, and saying "1 USD = 1.0000 USD" underneath it
  // would be arithmetic nobody asked for.
  if (transaction.toCurrency !== transaction.fromCurrency) {
    put(
      say('receipt.rate'),
      `1 ${transaction.fromCurrency} = ${toDecimalString(transaction.rate, 4)} ${transaction.toCurrency}`,
    );
    put(
      say('receipt.delivered'),
      `${toDecimalString(transaction.toAmount, 2)} ${transaction.toCurrency}`,
    );
  }

  // The one part of a withdrawal nobody can correct afterwards. It is on the
  // receipt for that reason and it belongs here for the same one — a customer
  // who reads it back to you before the coins move has saved you both.
  if (transaction.payoutAddress) {
    lines.push('');
    put(
      say('withdraw.address'),
      transaction.payoutWallet
        ? `${transaction.payoutAddress} (${transaction.payoutWallet.network})`
        : transaction.payoutAddress,
    );
  }

  lines.push('');
  put(say('receipt.date'), formatDateTime(transaction.createdAt, locale));
  put(say('common.branch'), name(transaction.branch, 'name'));

  const who = transaction.customer
    ? name(transaction.customer, 'fullName')
    : transaction.counterpartyName;
  if (who) put(say('receipt.customer'), who);

  return {
    reference: transaction.reference,
    text: lines.join('\n'),
    phone: transaction.customer?.phone ?? transaction.counterpartyPhone ?? null,
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
