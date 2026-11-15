import 'server-only';
import * as settings from '@/modules/settings/settings.service';
import { createBotLogger } from './bot-issues';
import { forwardTargets, needsSender, parseForwardRules, type ForwardRule } from './group-forward';
import {
  isOwnNumber,
  memberPhone,
  onIncomingText,
  onOwnGroupMessage,
  sendPassedOn,
  type IncomingText,
  type OwnGroupMessage,
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
  // Why a message in a forwarded group stayed put, without what it said.
  if (targets.length === 0) {
    log.info('A group message passed no forwarding rule', {
      caption: !incoming.text.trim(),
      senderKnown: Boolean(phone),
      sender: phone ? `…${phone.split('@')[0]!.slice(-4)}` : null,
    });
  }
  return passOn(targets, text, deps.send);
}

export type OwnForwardDeps = Pick<ForwardServiceDeps, 'rules' | 'send'>;

/**
 * What the office's own number wrote in a group — a deal it announced, or words
 * typed on its phone — passed on by the same rules. A rule asking for certain
 * numbers passes it when the number it was written from is one of them.
 */
export async function forwardOwnMessage(
  message: OwnGroupMessage,
  deps: OwnForwardDeps,
): Promise<string[]> {
  if (!message.chat.endsWith('@g.us') || !message.text.trim()) return [];
  const rules = await deps.rules();
  return passOn(
    forwardTargets(rules, {
      chat: message.chat,
      text: message.text,
      caption: message.caption,
      senderPhone: message.phone,
    }),
    message.text,
    deps.send,
  );
}

async function passOn(
  targets: string[],
  text: string,
  send: ForwardServiceDeps['send'],
): Promise<string[]> {
  const sent: string[] = [];
  for (const group of targets) {
    try {
      await send(group, text);
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

  const rules = async () => {
    if (!(await settings.getBoolean('whatsapp.enabled'))) return [];
    return parseForwardRules(await settings.getString('whatsapp.forwardRules'));
  };
  const send = (group: string, text: string) => sendPassedOn(group, text);

  onIncomingText(async (incoming) => {
    await forwardGroupMessage(incoming, {
      rules,
      phoneOf: async (message) =>
        message.sender
          ? await memberPhone(message.chat, message.sender, message.account).catch(() => null)
          : null,
      ownNumber: isOwnNumber,
      send,
    });
  });
  onOwnGroupMessage(async (message) => {
    await forwardOwnMessage(message, { rules, send });
  });
}
