import 'server-only';
import { prisma } from '@/core/db/prisma';
import { createLogger } from '@/core/logger/logger';
import { keepMedia } from '@/modules/whatsapp/chat-images';
import {
  groups,
  onGroupReaction,
  onGroupSighting,
  reactTo,
  type GroupReaction,
  type GroupSighting,
} from '@/modules/whatsapp/whatsapp.service';
import { markSent } from './bank.service';
import { addReceipt, answerSentInGroup, relayReceipt } from './bank-receipts.service';
import { coverOf, hasPartBefore, transferTarget } from './transfer-payments.service';
import { readReceiptPhoto } from './receipt-reader';
import { parseMoney } from '@/core/money/money';
import { bankGroup, executorGroups } from './group-feed.service';
import { markedBy, markOf, wordsOf } from './group-marks';

const log = createLogger('bank:marks');

/**
 * The bank desk read off the groups themselves, so a transfer handled on the
 * phone is handled on the desk too:
 *
 *   ❤️ on a transfer's message    → "passed on" (موجّهة);
 *   👍 on it                      → "sent" (نُفّذت), as the desk's own button;
 *   a reply quoting it, with a photo → that photo is its receipt, and it is sent.
 *
 * The message may be the transfer's own, in the bank transfers group, or the
 * copy the office passed on to a group that carries it out. Anywhere else a
 * reaction is only a reaction: a deal's announcement among the tellers is not
 * the place a transfer is said to be sent.
 */

type Place = { chat: string; waId: string };

type Found = {
  kind: 'deal' | 'request' | 'tiktok';
  id: string;
  waiting: boolean;
  /** Its message as the desk's list knows it: where a "passed on" is written. */
  ref: Place;
};

/** The message, then what it was a copy of, back to where it was first written. */
async function backTo(place: Place): Promise<Place[]> {
  const chain = [place];
  for (let hop = 0; hop < 4; hop++) {
    const last = chain[chain.length - 1]!;
    const from = await prisma.groupForward.findFirst({
      where: { targetChat: last.chat, targetWaId: last.waId },
      select: { sourceChat: true, sourceWaId: true },
    });
    if (!from || chain.some((at) => at.chat === from.sourceChat && at.waId === from.sourceWaId)) break;
    chain.push({ chat: from.sourceChat, waId: from.sourceWaId });
  }
  return chain;
}

/** The transfer a message in a group stands for, if it stands for one where marks count. */
export async function transferOf(place: Place): Promise<Found | null> {
  const chain = await backTo(place);
  // Not a copy the office passed on: only the bank group and the groups that carry transfers out.
  if (chain.length === 1) {
    const [bank, executors] = await Promise.all([bankGroup(), executorGroups()]);
    if (bank?.id !== place.chat && !executors.some((group) => group.id === place.chat)) return null;
  }
  for (const at of chain) {
    const request = await prisma.bankRequest.findUnique({
      where: { chat_waId: { chat: at.chat, waId: at.waId } },
      select: { id: true, status: true },
    });
    if (request && request.status !== 'DISMISSED') {
      return { kind: 'request', id: request.id, waiting: request.status === 'PENDING', ref: at };
    }
    const tiktok = await prisma.tiktokWithdrawal.findFirst({
      where: {
        deletedAt: null,
        OR: [
          { bankChat: at.chat, bankMessageId: at.waId },
          { announcedChat: at.chat, announcedMessageId: at.waId },
        ],
      },
      select: { id: true, sentAt: true, bankChat: true, bankMessageId: true, announcedChat: true, announcedMessageId: true },
    });
    if (tiktok) {
      return {
        kind: 'tiktok',
        id: tiktok.id,
        waiting: !tiktok.sentAt,
        ref:
          tiktok.bankChat && tiktok.bankMessageId
            ? { chat: tiktok.bankChat, waId: tiktok.bankMessageId }
            : { chat: tiktok.announcedChat!, waId: tiktok.announcedMessageId! },
      };
    }
    const deal = await prisma.transaction.findFirst({
      where: {
        payoutBankAmount: { gt: 0n },
        reversalOfId: null,
        OR: [
          { copyChat: at.chat, copyMessageId: at.waId },
          { announcedChat: at.chat, announcedMessageId: at.waId },
        ],
      },
      select: {
        id: true,
        status: true,
        copyChat: true,
        copyMessageId: true,
        announcedChat: true,
        announcedMessageId: true,
      },
    });
    if (deal) {
      return {
        kind: 'deal',
        id: deal.id,
        waiting: deal.status === 'PENDING_TRANSFER',
        // As the desk's line reads it: the transfers group's copy first, else the announcement.
        ref:
          deal.copyChat && deal.copyMessageId
            ? { chat: deal.copyChat, waId: deal.copyMessageId }
            : { chat: deal.announcedChat!, waId: deal.announcedMessageId! },
      };
    }
  }
  return null;
}

const numberOf = (jid: string | null) =>
  jid?.endsWith('@s.whatsapp.net') ? jid.split('@')[0]!.split(':')[0]! : null;

/** Who reacted, kept to take their own mark back: the office's numbers are one. */
const reactorOf = (reaction: GroupReaction) =>
  reaction.fromMe ? 'office' : (reaction.author ?? null);

async function onReaction(reaction: GroupReaction): Promise<void> {
  const reactor = reactorOf(reaction);
  const who =
    reaction.name?.trim() ||
    (numberOf(reaction.author) ? `+${numberOf(reaction.author)}` : null) ||
    (reaction.fromMe ? 'المكتب' : 'واتساب');

  // Taken off: WhatsApp does not say which it was, so a ❤️ this member put is taken back.
  if (!reaction.emoji) {
    if (!reactor) return;
    const found = await transferOf({ chat: reaction.chat, waId: reaction.waId });
    if (!found) return;
    await prisma.groupForward.deleteMany({
      where: { sourceChat: found.ref.chat, sourceWaId: found.ref.waId, reactor },
    });
    return;
  }

  const mark = markOf(reaction.emoji);
  if (!mark) return;
  const found = await transferOf({ chat: reaction.chat, waId: reaction.waId });
  // Sent already, or taken off the list: a late reaction changes nothing.
  if (!found?.waiting) return;

  if (mark === 'forwarded') {
    if (!reactor) return;
    const already = await prisma.groupForward.findFirst({
      where: { sourceChat: found.ref.chat, sourceWaId: found.ref.waId, reactor },
      select: { id: true },
    });
    if (already) return;
    await prisma.groupForward.create({
      data: {
        sourceChat: found.ref.chat,
        sourceWaId: found.ref.waId,
        targetChat: reaction.chat,
        targetName: markedBy(reaction.name, numberOf(reaction.author)),
        auto: false,
        byName: who,
        reactor,
      },
    });
    log.info('A transfer was marked passed on by a reaction', { kind: found.kind });
    return;
  }

  // 👍: sent, as the desk's "تم التنفيذ" — the group already holds the word, so the bot adds none.
  await markDone(found, who, '👍', reaction.chat);
}

/**
 * Sent, as the desk's "تم التنفيذ" would mark it: by a 👍 on the transfer, or by
 * its receipt arriving as a reply to it. The group already holds the word, so
 * the bot adds none; a deal is confirmed in the system's name, with who did it
 * and how written beside it.
 */
async function markDone(found: Found, who: string, how: '👍' | '📎', where: string): Promise<void> {
  if (!found.waiting) return;
  if (found.kind === 'request') {
    const done = await prisma.bankRequest.updateMany({
      where: { id: found.id, status: 'PENDING' },
      data: { status: 'SENT', sentAt: new Date(), sentByName: who },
    });
    if (done.count > 0 && where !== found.ref.chat) await answerSentInGroup('request', found.id);
  } else if (found.kind === 'tiktok') {
    const done = await prisma.tiktokWithdrawal.updateMany({
      where: { id: found.id, sentAt: null, deletedAt: null },
      data: { sentAt: new Date(), sentByName: who },
    });
    // Done in a group it was passed on to: the transfers group told under its own message, as a deal is.
    if (done.count > 0 && where !== found.ref.chat) await answerSentInGroup('tiktok', found.id);
  } else {
    // A deal is confirmed in someone's name: the system's, with who reacted written beside it.
    const system = await prisma.user.findFirst({ where: { isSystem: true }, select: { id: true } });
    if (!system) {
      log.warn('No system account to confirm a transfer marked sent by a reaction');
      return;
    }
    await markSent(found.id, null, {
      id: system.id,
      name: `${who} (${how} واتساب)`,
      permissions: ['bank.execute'],
    });
  }
  log.info('A transfer was marked sent from the group', { kind: found.kind, how });
}

/**
 * A transfer forwarded by hand, on WhatsApp, from the bank group to another
 * group the office's number is in: found by its words, the same as the
 * original's, and written down as passed on to that group — by whoever
 * forwarded it. From then on a 👍 or a receipt on the copy reaches the transfer.
 */
async function onCopy(sighting: GroupSighting): Promise<void> {
  if (!sighting.forwarded) return;
  const words = wordsOf(sighting.text);
  // Too few words to tell one transfer from another.
  if (words.length < 8) return;
  const bank = await bankGroup();
  if (!bank || bank.id === sighting.chat) return;
  const known = await prisma.groupForward.findFirst({
    where: { targetChat: sighting.chat, targetWaId: sighting.waId },
    select: { id: true },
  });
  if (known) return;

  const recent = await prisma.groupMessage.findMany({
    where: { chat: bank.id, createdAt: { gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } },
    orderBy: { createdAt: 'desc' },
    select: { chat: true, waId: true, text: true },
    take: 500,
  });
  const original = recent.find((row) => wordsOf(row.text) === words);
  if (!original) return;

  // Written where the desk's line looks: a deal's own message when the bank group's is a copy of it.
  const found = await transferOf({ chat: original.chat, waId: original.waId });
  const source = found?.ref ?? { chat: original.chat, waId: original.waId };
  const name =
    (await executorGroups()).find((group) => group.id === sighting.chat)?.name ||
    (await groups().catch(() => [])).find((group) => group.id === sighting.chat)?.name ||
    null;
  await prisma.groupForward.create({
    data: {
      sourceChat: source.chat,
      sourceWaId: source.waId,
      targetChat: sighting.chat,
      targetName: name,
      targetWaId: sighting.waId,
      auto: false,
      byName:
        sighting.name?.trim() ||
        (sighting.phone ? `+${sighting.phone.split('@')[0]}` : null) ||
        (sighting.fromMe ? 'المكتب' : null),
    },
  });
  log.info('A transfer forwarded by hand on WhatsApp was found', { transfer: Boolean(found) });
}

/**
 * Where a transfer's receipts are answered: the transfers group, the groups
 * that carry transfers out, and any group one was passed on to.
 */
async function transferGroup(chat: string): Promise<boolean> {
  const [bank, executors] = await Promise.all([bankGroup(), executorGroups()]);
  if (bank?.id === chat || executors.some((group) => group.id === chat)) return true;
  return Boolean(await prisma.groupForward.findFirst({ where: { targetChat: chat }, select: { id: true } }));
}

/**
 * A photo answering a transfer's message: one more of its receipts — a
 * transfer paid in two parts has two — kept once by the message it came as.
 * Every such photo in a transfer group is also kept by what it answers, so the
 * desk can look for a transfer's receipts again later.
 */
async function onReply(sighting: GroupSighting): Promise<void> {
  if (!sighting.quoted || sighting.mediaKind !== 'image' || !sighting.download) return;
  if (!(await transferGroup(sighting.chat))) return;
  const file = await sighting.download().catch(() => null);
  if (!file || !file.mimeType.startsWith('image/')) return;
  await takeReceipt(sighting, sighting.quoted, file);
}

type Photo = { bytes: Buffer; mimeType: string };

/** Only the digits of an account, a phone or an IBAN. */
const digitsOf = (value: string | null | undefined) => (value ?? '').replace(/\D/g, '');

/** The same account written two ways: 0598…, 970598…, or an IBAN's tail. */
function sameAccount(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = digitsOf(a);
  const y = digitsOf(b);
  if (x.length < 6 || y.length < 6) return false;
  const tail = Math.min(9, x.length, y.length);
  return x.slice(-tail) === y.slice(-tail);
}

/**
 * A receipt put in a group the office passes transfers on to, without quoting
 * the one it pays: matched to the transfer passed on there in the last day and
 * still waiting, by what the receipt says — the account it went to, else the
 * sum — and taken as though it had quoted it. Nothing is guessed: a photo the
 * receipt reader cannot tie to exactly one of them is left alone.
 */
const LOOSE_WINDOW_MS = 24 * 60 * 60 * 1000;

async function onLoosePhoto(sighting: GroupSighting): Promise<void> {
  if (sighting.quoted || sighting.fromMe || sighting.mediaKind !== 'image' || !sighting.download) return;
  const bank = await bankGroup();
  // In the transfers group itself a photo is a request's or nobody's: only the groups passed on to.
  if (!bank || bank.id === sighting.chat) return;
  const copies = await prisma.groupForward.findMany({
    where: { targetChat: sighting.chat, targetWaId: { not: null }, createdAt: { gte: new Date(Date.now() - LOOSE_WINDOW_MS) } },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: { targetWaId: true },
  });
  if (copies.length === 0) return;

  const waiting = new Map<string, { found: Found; waId: string }>();
  for (const copy of copies) {
    const found = await transferOf({ chat: sighting.chat, waId: copy.targetWaId! });
    const key = found ? `${found.kind}:${found.id}` : null;
    if (found?.waiting && key && !waiting.has(key)) waiting.set(key, { found, waId: copy.targetWaId! });
  }
  if (waiting.size === 0) return;

  const file = await sighting.download().catch(() => null);
  if (!file || !file.mimeType.startsWith('image/')) return;
  const reading = await readReceiptPhoto(file);
  if (!reading.available || (!reading.account && !reading.amount)) return;

  const candidates = await Promise.all(
    [...waiting.values()].map(async (entry) => ({ ...entry, target: await transferTarget(entry.found.kind, entry.found.id) })),
  );
  const sum = reading.amount ? parseMoney(reading.amount) : null;
  const byAccount = reading.account ? candidates.filter((entry) => sameAccount(entry.target?.account, reading.account)) : [];
  const bySum =
    sum && sum > 0n
      ? candidates.filter(
          (entry) =>
            entry.target?.total === sum &&
            (!reading.currency || entry.target.currency === reading.currency.toUpperCase()),
        )
      : [];
  // The account first: two transfers of the same sum are told apart by it.
  const match =
    byAccount.length === 1
      ? byAccount[0]
      : byAccount.length > 1
        ? (byAccount.filter((entry) => bySum.includes(entry)).length === 1 ? byAccount.find((entry) => bySum.includes(entry)) : undefined)
        : bySum.length === 1
          ? bySum[0]
          : undefined;
  if (!match) {
    log.info('A receipt in a forwarding group matched no single transfer; left alone', {
      waiting: candidates.length,
      byAccount: byAccount.length,
      bySum: bySum.length,
    });
    return;
  }
  log.info('A receipt put in a forwarding group without a quote was matched to its transfer', { kind: match.found.kind });
  await takeReceipt(sighting, match.waId, file);
}

/** A photo taken as the receipt of the message it answers — quoted, or matched. */
async function takeReceipt(sighting: GroupSighting, quoted: string, file: Photo): Promise<void> {

  const kept = await keepMedia(file, null);
  if (kept) {
    await prisma.groupReply
      .create({ data: { chat: sighting.chat, waId: sighting.waId, quotedWaId: quoted, mediaId: kept.id } })
      .catch((error: { code?: string }) => {
        if (error?.code !== 'P2002') throw error;
      });
  }

  const found = await transferOf({ chat: sighting.chat, waId: quoted });
  if (!found) return;
  const added = await addReceipt(found.kind, found.id, file, { sourceKey: `${sighting.chat}|${sighting.waId}` });
  if (!added) return;
  log.info('A transfer receipt was taken from a reply in a group', { kind: found.kind });
  // Done there too: a ✅ on the office's copy in the group it was passed on to.
  if (sighting.chat !== found.ref.chat) void markCopy(sighting.chat, quoted);

  /*
   * Paid in parts: the receipt is read before it closes anything. One sent in
   * part already is closed by the desk alone; a receipt short of the sum leaves
   * it open, the group told what is left. Read whole — or not read at all — it
   * is the transfer done, as before.
   */
  /*
   * A receipt that does not close it here — it was marked sent already, by a
   * 👍 or at the desk, or this is a part — is still carried back under the
   * transfer's own message, with the number, when it came in another group.
   */
  const elsewhere = sighting.chat !== found.ref.chat;
  if (await hasPartBefore(found.kind, found.id, added)) {
    log.info('A part of a transfer came from a group; the desk closes it');
    if (elsewhere) await relayReceipt(found.kind, found.id, file, true);
    return;
  }
  const cover = found.waiting ? await coverOf(found.kind, found.id, added) : null;
  if (cover === 'short') {
    log.info('A receipt from a group covers only part of its transfer; left open');
    if (elsewhere) await relayReceipt(found.kind, found.id, file, true);
    return;
  }
  if (!found.waiting) {
    if (elsewhere) await relayReceipt(found.kind, found.id, file, false);
    return;
  }

  // The bank's receipt is the transfer done: sent, without waiting on a 👍.
  const who =
    sighting.name?.trim() ||
    (sighting.phone ? `+${sighting.phone.split('@')[0]}` : null) ||
    (sighting.fromMe ? 'المكتب' : 'واتساب');
  await markDone(found, who, '📎', sighting.chat);
}

/** A ✅ on the copy the office sent into a group, once its receipt came there. */
async function markCopy(chat: string, waId: string): Promise<void> {
  try {
    const own = await prisma.groupMessage.findFirst({ where: { chat, waId }, select: { fromMe: true } });
    const sent = await prisma.groupForward.findFirst({ where: { targetChat: chat, targetWaId: waId }, select: { id: true } });
    // Only the office's own copy: a reaction on someone else's message is theirs to put.
    if (own ? !own.fromMe : !sent) return;
    await reactTo(chat, waId, '✅');
  } catch (error) {
    log.warn('Could not mark the copy of a transfer done', { error });
  }
}

let registered = false;

/** Reads the marks and the receipts in the groups. Once per process. */
export function registerGroupMarks(): void {
  if (registered) return;
  registered = true;
  onGroupReaction((reaction) =>
    onReaction(reaction).catch((error) => log.warn('Could not read a reaction on a transfer', { error })),
  );
  onGroupSighting((sighting) =>
    onReply(sighting).catch((error) => log.warn('Could not keep a receipt from a group', { error })),
  );
  onGroupSighting((sighting) =>
    onCopy(sighting).catch((error) => log.warn('Could not trace a forwarded transfer', { error })),
  );
  onGroupSighting((sighting) =>
    onLoosePhoto(sighting).catch((error) => log.warn('Could not match a receipt put without a quote', { error })),
  );
}
