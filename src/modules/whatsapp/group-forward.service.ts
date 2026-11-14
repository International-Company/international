import 'server-only';
import * as settings from '@/modules/settings/settings.service';
import { createBotLogger } from './bot-issues';
import { forwardTargets, needsSender, parseForwardRules, type ForwardRule } from './group-forward';
import {
  isOwnNumber,
  memberPhone,
  onIncomingText,
  sendText,
  type IncomingText,
} from './whatsapp.service';

const log = createBotLogger('whatsapp-forward');

export interface ForwardServiceDeps {
  rules: () => Promise<ForwardRule[]>;
  phoneOf: (incoming: IncomingText) => Promise<string | null>;
  ownNumber: (phone: string | null) => boolean;
  send: (group: string, text: string) => Promise<unknown>;
}

/**
 * A group message passed on to every group a rule sends it to, as it was written.
 * Never one the office's own numbers wrote: what one sends to a group another
 * hears, and two rules pointing at each other would pass it back and forth.
 */
export async function forwardGroupMessage(
  incoming: IncomingText,
  deps: ForwardServiceDeps,
): Promise<string[]> {
  if (incoming.account === 'private' || !incoming.chat.endsWith('@g.us')) return [];
  if (incoming.message.key.fromMe) return [];
  const text = incoming.text.trim() ? incoming.text : (incoming.caption ?? '');
  if (!text.trim()) return [];

  const rules = await deps.rules();
  if (!rules.some((rule) => rule.enabled && rule.from.id === incoming.chat)) return [];

  // Looked up only when a rule asks who sent it: it is a call to WhatsApp for each message.
  const phone =
    incoming.senderPhone ??
    (needsSender(rules, incoming.chat) ? await deps.phoneOf(incoming) : null);
  if (deps.ownNumber(phone ?? incoming.sender)) return [];

  const targets = forwardTargets(rules, {
    chat: incoming.chat,
    text,
    caption: !incoming.text.trim(),
    senderPhone: phone,
  });
  const sent: string[] = [];
  for (const group of targets) {
    try {
      await deps.send(group, text);
      sent.push(group);
    } catch (error) {
      log.warn('Could not pass a group message on', { error });
    }
  }
  return sent;
}

let registered = false;

/** Listens to every group for messages a rule passes on. Once per process. */
export function registerGroupForward(): void {
  if (registered) return;
  registered = true;

  onIncomingText(async (incoming) => {
    await forwardGroupMessage(incoming, {
      rules: async () => {
        if (!(await settings.getBoolean('whatsapp.enabled'))) return [];
        return parseForwardRules(await settings.getString('whatsapp.forwardRules'));
      },
      phoneOf: async (message) =>
        message.sender
          ? await memberPhone(message.chat, message.sender, message.account).catch(() => null)
          : null,
      ownNumber: isOwnNumber,
      send: (group, text) => sendText(group, text),
    });
  });
}
