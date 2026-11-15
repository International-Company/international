import 'server-only';
import { errors } from '@/core/errors/app-error';
import * as settings from '@/modules/settings/settings.service';
import { createBotLogger } from './bot-issues';
import { parseProfile } from './bot-profile';
import { pauseChat, readConversation, recordMessage } from './bot-store';
import { replyPrivately } from './whatsapp.service';

const log = createBotLogger('whatsapp-inbox');

export const MAX_ANSWER_LENGTH = 2000;

/**
 * A member of staff answering a customer from the system, through the private
 * number, as if from its phone: the customer sees the office, not who typed it.
 * The bot keeps out of the conversation for as long as it would had they typed
 * it on the phone, so the two do not talk over each other.
 *
 * Only an answer: the office never writes first to a number from here, which
 * is what gets a linked number banned.
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

  try {
    await replyPrivately(thread.chat, words.slice(0, MAX_ANSWER_LENGTH));
  } catch (error) {
    log.warn('Could not answer a customer', { error });
    throw errors.precondition('WhatsApp did not take the answer', 'errors.inboxSendFailed');
  }

  await recordMessage(thread.chat, phoneJid, 'staff', words, actor.name);
  const { takeoverMinutes } = parseProfile(await settings.getString('whatsapp.privateBotProfile'));
  await pauseChat(thread.chat, phoneJid, takeoverMinutes);
  return readConversation(conversationId);
}
