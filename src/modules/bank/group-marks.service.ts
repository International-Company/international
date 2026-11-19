import 'server-only';
import { prisma } from '@/core/db/prisma';
import { createLogger } from '@/core/logger/logger';
import { keepMedia } from '@/modules/whatsapp/chat-images';
import {
  onGroupReaction,
  onGroupSighting,
  type GroupReaction,
  type GroupSighting,
} from '@/modules/whatsapp/whatsapp.service';
import { markSent } from './bank.service';
import { bankGroup, executorGroups } from './group-feed.service';
import { markedBy, markOf } from './group-marks';

const log = createLogger('bank:marks');

/**
 * The bank desk read off the groups themselves, so a transfer handled on the
 * phone is handled on the desk too:
 *
 *   ❤️ on a transfer's message    → "passed on" (موجّهة);
 *   👍 on it                      → "sent" (نُفّذت), as the desk's own button;
 *   a reply quoting it, with a photo → that photo is its receipt.
 *
 * The message may be the transfer's own, in the bank transfers group, or the
 * copy the office passed on to a group that carries it out. Anywhere else a
 * reaction is only a reaction: a deal's announcement among the tellers is not
 * the place a transfer is said to be sent.
 */

type Place = { chat: string; waId: string };

type Found = {
  kind: 'deal' | 'request';
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
async function transferOf(place: Place): Promise<Found | null> {
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
  if (found.kind === 'request') {
    await prisma.bankRequest.updateMany({
      where: { id: found.id, status: 'PENDING' },
      data: { status: 'SENT', sentAt: new Date(), sentByName: who },
    });
  } else {
    // A deal is confirmed in someone's name: the system's, with who reacted written beside it.
    const system = await prisma.user.findFirst({ where: { isSystem: true }, select: { id: true } });
    if (!system) {
      log.warn('No system account to confirm a transfer marked sent by a reaction');
      return;
    }
    await markSent(found.id, null, {
      id: system.id,
      name: `${who} (👍 واتساب)`,
      permissions: ['bank.execute'],
    });
  }
  log.info('A transfer was marked sent by a reaction', { kind: found.kind });
}

/** A photo answering a transfer's message: kept as its receipt. */
async function onReply(sighting: GroupSighting): Promise<void> {
  if (!sighting.quoted || sighting.mediaKind !== 'image' || !sighting.download) return;
  const found = await transferOf({ chat: sighting.chat, waId: sighting.quoted });
  if (!found) return;
  const file = await sighting.download().catch(() => null);
  if (!file || !file.mimeType.startsWith('image/')) return;

  if (found.kind === 'request') {
    const kept = await keepMedia(file, null);
    if (!kept) return;
    await prisma.bankRequest.update({ where: { id: found.id }, data: { receiptId: kept.id } });
  } else {
    await prisma.transactionProof.create({
      data: {
        transactionId: found.id,
        kind: 'TRANSFER',
        mimeType: file.mimeType,
        size: file.bytes.length,
        data: new Uint8Array(file.bytes),
      },
    });
  }
  log.info('A transfer receipt was taken from a reply in a group', { kind: found.kind });
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
}
