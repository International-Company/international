import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import type { Locale } from '@/i18n/config';
import * as settings from '@/modules/settings/settings.service';
import * as audit from '@/modules/audit/audit.service';
import type { Actor } from './transaction.service';
import { MACHINE_TYPES } from './transaction-types';

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
/** Everything a message is written from, and nothing it must not say. */
const SHARE_SELECT = {
  id: true,
  reference: true,
  type: true,
  status: true,
  toCurrency: true,
  toAmount: true,
  payoutBankAmount: true,
  payoutBankChannel: true,
  payoutAccount: true,
  payoutAddress: true,
  counterpartyName: true,
  counterpartyPhone: true,
  customer: { select: { fullNameAr: true, fullNameEn: true, phone: true } },
  payoutWallet: { select: { network: true } },
} as const;

type ShareRow = {
  toCurrency: string;
  toAmount: bigint;
  payoutBankAmount: bigint;
  payoutBankChannel: string | null;
  payoutAccount: string | null;
  payoutAddress: string | null;
  counterpartyName: string | null;
  counterpartyPhone: string | null;
  customer: { fullNameAr: string; fullNameEn: string; phone: string | null } | null;
  payoutWallet: { network: string } | null;
};

/** The currency as the message says it, for each code the rows use. */
async function unitsFor(
  codes: string[],
  locale: Locale,
  db: DbClient,
): Promise<Map<string, string>> {
  const rows = await db.currency.findMany({
    where: { code: { in: [...new Set(codes)] } },
    select: { code: true, nameAr: true, nameEn: true },
  });
  const named = new Map(rows.map((row) => [row.code, locale === 'ar' ? row.nameAr : row.nameEn]));
  return new Map(
    [...new Set(codes)].map((code) => [
      code,
      (locale === 'ar' ? SHORT_AR[code] : undefined) ?? named.get(code) ?? code,
    ]),
  );
}

/**
 * One transaction, the way the office writes it on WhatsApp:
 *
 *     الرقم
 *     الاسم
 *     اسم المحفظة أو البنك
 *     المبلغ
 *
 * The number is the account the money goes to when one was recorded — the line
 * the person making the transfer acts on — and the customer's phone otherwise.
 * The amount is what reaches them: the transferred part of a split, since the
 * cash taken at the counter is not the transfer's business; whole amounts lose
 * their ".00", because "320 شيكل" is how the office writes it. Each line only
 * when the transaction has it — a blank where a field is missing reads as
 * something left out.
 *
 * The address of a USDT withdrawal follows, when there is one: it is the one
 * part nobody can correct afterwards, and a customer who reads it back has
 * saved everybody.
 */
function composeLines(transaction: ShareRow, locale: Locale, unit: string): string[] {
  const phone = transaction.customer?.phone ?? transaction.counterpartyPhone ?? null;
  const who = transaction.customer
    ? locale === 'ar'
      ? transaction.customer.fullNameAr
      : transaction.customer.fullNameEn
    : transaction.counterpartyName;

  const paid =
    transaction.payoutBankAmount > 0n ? transaction.payoutBankAmount : transaction.toAmount;
  const amount =
    transaction.toCurrency === 'USDT'
      ? toDecimalString(paid, 2).replace(/\.00$/, '')
      : wholeAmount(paid).toString();

  return [
    transaction.payoutAccount?.trim() || phone,
    who,
    transaction.payoutBankChannel,
    `${amount} ${unit}`,
    transaction.payoutAddress
      ? transaction.payoutWallet
        ? `${transaction.payoutAddress} (${transaction.payoutWallet.network})`
        : transaction.payoutAddress
      : null,
  ].filter((line): line is string => Boolean(line?.trim()));
}

/**
 * A cash amount as the office writes it in a transfer: whole, with the first
 * figure after the point deciding — six or more rounds up, five or less is
 * dropped. 915.6 is 916; 915.5 is 915. USDT keeps its fraction: coins sent
 * are exact.
 */
export function wholeAmount(scaled: bigint): bigint {
  const whole = scaled / 100_000_000n;
  const tenths = (scaled % 100_000_000n) / 10_000_000n;
  return tenths >= 6n ? whole + 1n : whole;
}

export async function shareable(
  id: string,
  locale: Locale,
  db: DbClient = prisma,
): Promise<Shareable> {
  const transaction = await db.transaction.findUnique({ where: { id }, select: SHARE_SELECT });

  if (!transaction) throw errors.notFound('Transaction', id);
  if (transaction.status !== 'POSTED' && transaction.status !== 'PENDING_TRANSFER') {
    throw errors.precondition('Only a posted transaction can be shared', 'errors.notShareable');
  }

  const [company, units] = await Promise.all([
    settings.getString(locale === 'ar' ? 'company.name.ar' : 'company.name.en', db),
    unitsFor([transaction.toCurrency], locale, db),
  ]);

  const lines = composeLines(transaction, locale, units.get(transaction.toCurrency)!);

  return {
    reference: transaction.reference,
    companyName: company ?? '',
    // A blank line between each, the way the office types them.
    text: lines.join('\n\n'),
    phone: transaction.customer?.phone ?? transaction.counterpartyPhone ?? null,
  };
}

/** Between two transfers in one message: a line WhatsApp shows as a divider. */
const DIVIDER = '\n\n———\n\n';

/**
 * Every transfer still owed, as one message, oldest first.
 *
 * What the person who makes the transfers needs at the end of a run: each one
 * in the same four lines as a single share, so it can be read and ticked off
 * one block at a time. A teller gets their own; someone who sees everybody's
 * transactions gets the office's.
 *
 * Exchange and USDT are settled apart, so each screen asks for its own kind:
 * the machine's exchanges, or the USDT counter's deals. Without a kind, all.
 */
export type PendingKind = 'exchange' | 'usdt';

const KIND_TYPES: Record<PendingKind, string[]> = {
  // A wallet top-up is a transfer the machine promised, settled with the rest.
  exchange: [...MACHINE_TYPES],
  usdt: ['USDT_RECEIVE', 'USDT_SEND'],
};

export async function pendingTransfers(
  actor: Actor,
  locale: Locale,
  db: DbClient = prisma,
  kind?: PendingKind,
): Promise<{ count: number; text: string }> {
  const rows = await db.transaction.findMany({
    where: {
      ...(kind ? { type: { in: KIND_TYPES[kind] } } : {}),
      status: 'PENDING_TRANSFER',
      payoutBankAmount: { gt: 0n },
      reversalOfId: null,
      ...(actor.permissions.includes('exchange.transaction.viewAll')
        ? {}
        : { createdById: actor.id }),
      ...(actor.branchId ? { branchId: actor.branchId } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
    select: SHARE_SELECT,
  });

  if (rows.length === 0) return { count: 0, text: '' };

  const units = await unitsFor(
    rows.map((row) => row.toCurrency),
    locale,
    db,
  );

  return {
    count: rows.length,
    text: rows
      .map((row) => composeLines(row, locale, units.get(row.toCurrency)!).join('\n\n'))
      .join(DIVIDER),
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
