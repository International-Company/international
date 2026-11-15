import 'server-only';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import * as settings from '@/modules/settings/settings.service';
import { createBotLogger } from './bot-issues';
import { parseProfile } from './bot-profile';
import { pauseChat, readConversation, recordMessage } from './bot-store';
import { candidateNumbers } from './inbox-numbers';
import { privateNumberAddress, replyPrivately } from './whatsapp.service';

const log = createBotLogger('whatsapp-inbox');

export const MAX_ANSWER_LENGTH = 2000;

/** The bot keeps out of a conversation a person is in, for as long as the panel says. */
async function keepBotOut(chat: string, phoneJid: string | null) {
  const { takeoverMinutes } = parseProfile(await settings.getString('whatsapp.privateBotProfile'));
  await pauseChat(chat, phoneJid, takeoverMinutes);
}

async function sendOrSay(chat: string, words: string) {
  try {
    await replyPrivately(chat, words.slice(0, MAX_ANSWER_LENGTH));
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
 */
export async function answerCustomer(
  conversationId: string,
  text: string,
  actor: { name: string },
) {
  const words = text.trim();
  if (!words) throw errors.validation([{ path: 'text', message: 'Write the answer' }]);

  const thread = await readConversation(conversationId);
  const phoneJid = thread.phone ? `${thread.phone}@s.whatsapp.net` : null;

  await sendOrSay(thread.chat, words);
  await recordMessage(thread.chat, phoneJid, 'staff', words, actor.name);
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

  await sendOrSay(jid, words);
  await recordMessage(jid, jid, 'staff', words, actor.name);
  await keepBotOut(jid, jid);
  const row = await prisma.botConversation.findFirst({
    where: { OR: [{ chat: jid }, { phone: digits }] },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true },
  });
  log.info('A member of staff opened a conversation');
  return { id: row!.id };
}
