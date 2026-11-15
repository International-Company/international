import 'server-only';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import * as settings from '@/modules/settings/settings.service';
import { createBotLogger } from './bot-issues';
import { parseProfile } from './bot-profile';
import { markSeen, pauseChat, readConversation, recordMessage } from './bot-store';
import { keepImage, readyImage } from './chat-images';
import { candidateNumbers } from './inbox-numbers';
import { quoteOf } from './wa-quote';
import { privateNumberAddress, replyPrivately, sendPrivateImage } from './whatsapp.service';

const log = createBotLogger('whatsapp-inbox');

export const MAX_ANSWER_LENGTH = 2000;

/** The bot keeps out of a conversation a person is in, for as long as the panel says. */
async function keepBotOut(chat: string, phoneJid: string | null) {
  const { takeoverMinutes } = parseProfile(await settings.getString('whatsapp.privateBotProfile'));
  await pauseChat(chat, phoneJid, takeoverMinutes);
}

async function sendOrSay(
  chat: string,
  words: string,
  quoted?: ReturnType<typeof quoteOf>,
): Promise<string | null> {
  try {
    return await replyPrivately(chat, words.slice(0, MAX_ANSWER_LENGTH), quoted);
  } catch (error) {
    log.warn('Could not write to a customer', { error });
    throw errors.precondition('WhatsApp did not take the message', 'errors.inboxSendFailed');
  }
}

/**
 * A member of staff answering a customer from the system, through the private
 * number, as if from its phone: the customer sees the office, not who typed it.
 * The bot keeps out of the conversation for as long as it would had they typed
 * it on the phone, so the two do not talk over each other.
 *
 * With a photo, the words go under it. Given a message of the conversation,
 * the answer quotes it, as answering one message does in WhatsApp.
 */
export async function answerCustomer(
  conversationId: string,
  text: string,
  actor: { name: string },
  photo?: string,
  quoteId?: string,
) {
  const words = text.trim();
  const image = photo ? readyImage(photo) : null;
  if (!words && !image) throw errors.validation([{ path: 'text', message: 'Write the answer' }]);

  const thread = await readConversation(conversationId);
  const phoneJid = thread.phone ? `${thread.phone}@s.whatsapp.net` : null;
  const target = quoteId
    ? await prisma.botMessage.findFirst({
        where: { id: quoteId, conversationId, waId: { not: null } },
        select: { waId: true, role: true, text: true },
      })
    : null;
  const quoted = target?.waId
    ? quoteOf(thread.chat, target.waId, target.role !== 'customer', target.text)
    : undefined;

  let imageId: string | null = null;
  let waId: string | null = null;
  if (image) {
    try {
      waId = await sendPrivateImage(
        thread.chat,
        image.bytes,
        image.mimeType,
        words.slice(0, MAX_ANSWER_LENGTH),
        quoted,
      );
    } catch (error) {
      log.warn('Could not send a photo to a customer', { error });
      throw errors.precondition('WhatsApp did not take the photo', 'errors.inboxSendFailed');
    }
    imageId = await keepImage(image, null);
  } else {
    waId = await sendOrSay(thread.chat, words, quoted);
  }
  await recordMessage(thread.chat, phoneJid, 'staff', words, {
    authorName: actor.name,
    mediaId: imageId,
    mediaKind: imageId ? 'image' : null,
    waId,
    quotedWaId: target?.waId ?? null,
  });
  await markSeen(conversationId);
  await keepBotOut(thread.chat, phoneJid);
  return readConversation(conversationId);
}

/**
 * Writing first to a number that has not written to the office.
 *
 * WhatsApp bans a linked number that writes first to many strangers, so there
 * is a ceiling a day, set on the panel, counted over the conversations the
 * office opened in the last day that nobody has answered yet.
 */
export async function startConversation(
  typedPhone: string,
  text: string,
  actor: { name: string },
): Promise<{ id: string }> {
  const words = text.trim();
  if (!words) throw errors.validation([{ path: 'text', message: 'Write the message' }]);
  const candidates = candidateNumbers(typedPhone);
  if (candidates.length === 0) {
    throw errors.precondition('That is not a phone number', 'errors.inboxBadNumber');
  }

  let jid: string | null = null;
  for (const digits of candidates) {
    try {
      jid = await privateNumberAddress(digits);
    } catch (error) {
      log.warn('Could not ask WhatsApp about a number', { error });
      throw errors.precondition('The private number is not connected', 'errors.inboxSendFailed');
    }
    if (jid) break;
  }
  if (!jid) throw errors.precondition('That number has no WhatsApp', 'errors.inboxNoWhatsapp');

  const digits = jid.split('@')[0]!.split(':')[0]!;
  const known = await prisma.botConversation.findFirst({
    where: { OR: [{ chat: jid }, { phone: digits }] },
    select: { id: true },
  });
  if (!known) {
    const ceiling = await settings.getNumber('whatsapp.inboxNewChatsPerDay');
    const opened = await prisma.botConversation.count({
      where: {
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        messages: { none: { role: 'customer' } },
      },
    });
    if (opened >= ceiling) {
      throw errors.precondition('Too many new conversations today', 'errors.inboxDailyCeiling', {
        count: ceiling,
      });
    }
  }

  const waId = await sendOrSay(jid, words);
  await recordMessage(jid, jid, 'staff', words, { authorName: actor.name, waId });
  await keepBotOut(jid, jid);
  const row = await prisma.botConversation.findFirst({
    where: { OR: [{ chat: jid }, { phone: digits }] },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true },
  });
  log.info('A member of staff opened a conversation');
  return { id: row!.id };
}
