import 'server-only';
import { prisma } from '@/core/db/prisma';
import { on } from '@/core/events/bus';
import { toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import { HOME_CURRENCY } from '@/lib/home-currency';
import { TRANSACTION_TYPE_META, type TransactionType } from '@/modules/exchange/transaction-types';
import * as settings from '@/modules/settings/settings.service';
import { shareable, type Shareable } from '@/modules/exchange/share.service';
import { groupFor, parseRoutes } from './group-routes';
import { isLinked, sendImage, sendText, type SentMessage } from './whatsapp.service';

/**
 * Every deal, to the office's WhatsApp group, the moment it is recorded — and
 * every deletion, so the group never holds a deal that no longer stands
 * without being told.
 *
 * A deal is written exactly as the office shares one by hand: the number, the
 * name, the bank or wallet, the amount, a line each with a blank between — the
 * same words the share button produces, so the two can never drift apart.
 * Then the bot answers its own message with what kind of deal it was —
 * «صرافة», «استلام يواس» — as a reply, so the kind sits on the deal it names
 * however busy the group gets.
 *
 * After the posting and apart from it: a group that could not be reached is
 * logged, never a deal that failed. And only when the manager has switched it
 * on, chosen a group, and the number is linked.
 */

const log = createLogger('whatsapp:announce');

export interface AnnouncedDeal {
  reference: string;
  type: string;
  status: string;
  fromCurrency: string;
  fromAmount: bigint;
  toCurrency: string;
  toAmount: bigint;
  payoutBankAmount: bigint;
  payoutBankChannel: string | null;
  payoutAccount: string | null;
  intakeBrokerAmount: bigint;
  intakeBankChannel: string | null;
  counterpartyName: string | null;
  counterpartyPhone: string | null;
  notes: string | null;
  createdAt: Date;
  customer: { fullNameAr: string; phone: string | null } | null;
  createdBy: { fullNameAr: string } | null;
}

/** "320" rather than "320.00", the way the office writes it. */
const figure = (amount: bigint) => toDecimalString(amount, 2).replace(/\.00$/, '');

/** What the deal is called in the group: buying and selling said plainly. */
export function titleOf(deal: Pick<AnnouncedDeal, 'type' | 'fromCurrency' | 'toCurrency'>): string {
  if (deal.type === 'EXCHANGE') {
    return deal.fromCurrency === HOME_CURRENCY
      ? `بيع ${deal.toCurrency}`
      : deal.toCurrency === HOME_CURRENCY
        ? `شراء ${deal.fromCurrency}`
        : `تصريف ${deal.fromCurrency} ← ${deal.toCurrency}`;
  }
  return TRANSACTION_TYPE_META[deal.type as TransactionType]?.nameAr ?? deal.type;
}

export function composeDeletion(
  deal: Pick<
    AnnouncedDeal,
    'reference' | 'type' | 'fromCurrency' | 'fromAmount' | 'toCurrency' | 'toAmount'
  >,
  by: string | null,
  reason: string | null,
): string {
  return [
    `🔴 *حذف عملية — ${titleOf(deal)}*`,
    `المرجع: ${deal.reference}`,
    `كانت: ${figure(deal.fromAmount)} ${deal.fromCurrency} ← ${figure(deal.toAmount)} ${deal.toCurrency}`,
    reason?.trim() ? `السبب: ${reason.trim()}` : null,
    by ? `حذفها: ${by}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

const DEAL_SELECT = {
  reference: true,
  type: true,
  status: true,
  fromCurrency: true,
  fromAmount: true,
  toCurrency: true,
  toAmount: true,
  payoutBankAmount: true,
  payoutBankChannel: true,
  payoutAccount: true,
  intakeBrokerAmount: true,
  intakeBankChannel: true,
  counterpartyName: true,
  counterpartyPhone: true,
  notes: true,
  createdAt: true,
  customer: { select: { fullNameAr: true, phone: true } },
  createdBy: { select: { fullNameAr: true } },
} as const;

/** The group to write to about a deal of this type, or null when the office has not asked for it. */
async function target(type: string): Promise<string | null> {
  if (!(await settings.getBoolean('whatsapp.enabled'))) return null;
  const group = groupFor(
    type,
    parseRoutes(await settings.getString('whatsapp.groupRoutes')),
    (await settings.getString('whatsapp.groupId')).trim(),
  );
  if (!group || !isLinked()) return null;
  return group;
}

/** The word the office uses for each kind of deal, said in the reply. */
const KIND_LABEL: Record<string, string> = {
  EXCHANGE: 'صرافة',
  WALLET_CASHOUT: 'صرافة',
  WALLET_TOPUP: 'صرافة',
  USDT_RECEIVE: 'استلام يواس',
  USDT_SEND: 'سحب يواس',
  USDT_SALE: 'بيع يواس',
  REMITTANCE_OUT: 'حوالة صادرة',
  REMITTANCE_IN: 'حوالة واردة',
};

export function kindLabel(type: string): string {
  return KIND_LABEL[type] ?? TRANSACTION_TYPE_META[type as TransactionType]?.nameAr ?? type;
}

/**
 * Whether the group hears of a deal at all.
 *
 * An exchange handed over entirely in cash is finished at the counter: the
 * customer walked away with the notes and there is nothing for anyone in the
 * group to send. So only an exchange with a transfer in it is written — in
 * whole or in part. Every other kind is written as before.
 */
export function announced(deal: { type: string; bankPayout: boolean }): boolean {
  return deal.type !== 'EXCHANGE' || deal.bankPayout;
}

/**
 * The deal's message, once the deal can be read.
 *
 * The event fires when the deal is written, but a screen like the exchange
 * machine writes it inside a larger database transaction of its own — and
 * until that commits, nothing outside it can see the row. Reading at once
 * found nothing, and the machine's deals were never announced. So it asks
 * again for a few seconds; a deal whose transaction rolled back never
 * appears, and is rightly never sent.
 */
async function settled(
  transactionId: string,
  load: (id: string) => Promise<Shareable>,
  pause: number,
): Promise<Shareable | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await load(transactionId);
    } catch (error) {
      if ((error as { code?: string }).code !== 'NOT_FOUND') return null;
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
  return null;
}

export interface DealPhoto {
  data: Uint8Array;
  mimeType: string;
  kind: string;
}

const PHOTO_WORDS: Record<string, string> = {
  PAYMENT: 'دليل الدفع',
  BENEFICIARY: 'بيانات المستفيد',
};

export interface AnnounceDeps {
  /** The group to write to about a deal of this type, or null when nothing should be sent. */
  target: (type: string) => Promise<string | null>;
  load: (id: string) => Promise<Shareable>;
  send: (jid: string, text: string, quoted?: SentMessage) => Promise<SentMessage>;
  /** The photos the deal carries, the one to go with its message first. */
  photos?: (id: string) => Promise<DealPhoto[]>;
  sendPhoto?: (
    jid: string,
    photo: DealPhoto,
    caption: string,
    quoted?: SentMessage,
  ) => Promise<SentMessage>;
  /** Between attempts to read a deal not yet committed. */
  pause?: number;
}

export type AnnounceOutcome = 'SKIPPED' | 'NOT_FOUND' | 'SEND_FAILED' | 'NO_REPLY' | 'SENT';

/**
 * One deal to the group: its message, then the kind as a reply to it.
 *
 * The reply goes only once the message itself is confirmed sent — a kind
 * hanging under nothing, or under the previous deal, would be worse than no
 * kind at all. Nothing here throws: a failure is logged and said in the
 * outcome, and the deal it was about is untouched.
 */
export async function announceDeal(
  transactionId: string,
  deps: AnnounceDeps,
): Promise<AnnounceOutcome> {
  const message = await settled(transactionId, deps.load, deps.pause ?? 500);
  if (!message?.text) return 'NOT_FOUND';
  if (!announced(message)) return 'SKIPPED';

  const group = await deps.target(message.type);
  if (!group) return 'SKIPPED';

  /*
   * The deal's photo goes with its message, as the caption. A photo that cannot
   * be read or sent never costs the group the deal: it goes as words instead.
   */
  let sent: SentMessage | undefined;
  let photos: DealPhoto[] = [];
  if (deps.photos && deps.sendPhoto) {
    try {
      photos = await deps.photos(transactionId);
      if (photos[0]) sent = await deps.sendPhoto(group, photos[0], message.text);
    } catch (error) {
      log.warn('Could not send a deal’s photo; sending its words', {
        reference: message.reference,
        error,
      });
      sent = undefined;
    }
  }

  try {
    sent ??= await deps.send(group, message.text);
  } catch (error) {
    log.warn('Could not announce a deal', { reference: message.reference, error });
    return 'SEND_FAILED';
  }
  if (!sent?.key?.id) {
    log.warn('A deal went out without an id to reply to', { reference: message.reference });
    return 'NO_REPLY';
  }

  let outcome: AnnounceOutcome = 'SENT';
  try {
    await deps.send(group, kindLabel(message.type), sent);
  } catch (error) {
    log.warn('Could not label a deal', { reference: message.reference, error });
    outcome = 'NO_REPLY';
  }

  // The rest as replies to the deal, each saying what it is.
  for (const photo of photos.slice(1)) {
    await deps
      .sendPhoto?.(group, photo, PHOTO_WORDS[photo.kind] ?? '', sent)
      .catch((error) =>
        log.warn('Could not send one of a deal’s photos', { reference: message.reference, error }),
      );
  }
  return outcome;
}

/** A deal's photos, what was paid before who it is for. */
function dealPhotos(transactionId: string) {
  return prisma.transactionProof.findMany({
    where: { transactionId },
    orderBy: [{ kind: 'desc' }, { createdAt: 'asc' }],
    select: { data: true, mimeType: true, kind: true },
  });
}

let registered = false;

export function registerWhatsappSubscribers(): void {
  if (registered) return;
  registered = true;

  on('transaction.posted', 'whatsapp-announce-deal', async ({ transactionId, unannounced }) => {
    if (unannounced) return;
    await announceDeal(transactionId, {
      target,
      load: (id) => shareable(id, 'ar'),
      send: sendText,
      photos: dealPhotos,
      sendPhoto: (jid, photo, caption, quoted) =>
        sendImage(jid, Buffer.from(photo.data), caption, quoted, photo.mimeType),
    });
  });

  // A photo added after the deal went out: the group gets it, saying which deal.
  on('transaction.proofAdded', 'whatsapp-announce-proof', async ({ transactionId, proofId }) => {
    const [message, proof] = await Promise.all([
      shareable(transactionId, 'ar'),
      prisma.transactionProof.findUnique({
        where: { id: proofId },
        select: { data: true, mimeType: true, kind: true },
      }),
    ]);
    if (!proof) return;
    const group = await target(message.type);
    if (!group) return;
    await sendImage(
      group,
      Buffer.from(proof.data),
      `${PHOTO_WORDS[proof.kind] ?? ''}\n\n${message.text}`,
      undefined,
      proof.mimeType,
    ).catch((error) =>
      log.warn('Could not send a payment photo', { reference: message.reference, error }),
    );
  });

  on(
    'transaction.reversed',
    'whatsapp-announce-deletion',
    async ({ transactionId, reversalId }) => {
      const [deal, reversal] = await Promise.all([
        prisma.transaction.findUnique({ where: { id: transactionId }, select: DEAL_SELECT }),
        prisma.transaction.findUnique({
          where: { id: reversalId },
          select: { reverseReason: true, createdBy: { select: { fullNameAr: true } } },
        }),
      ]);
      // A deal the group never heard of is not deleted in front of it either.
      if (!deal || !announced({ type: deal.type, bankPayout: deal.payoutBankAmount > 0n })) {
        return;
      }
      const group = await target(deal.type);
      if (!group) return;
      await sendText(
        group,
        composeDeletion(
          deal,
          reversal?.createdBy?.fullNameAr ?? null,
          reversal?.reverseReason ?? null,
        ),
      ).catch((error) =>
        log.warn('Could not announce a deletion', { reference: deal.reference, error }),
      );
    },
  );
}
