import 'server-only';
import {
  getContentType,
  normalizeMessageContent,
  type proto,
  type WAMessage,
} from '@whiskeysockets/baileys';

/**
 * Answering one message by quoting it, as WhatsApp does, both ways: the id of
 * the message a customer's answer quotes, and the message an answer from here
 * quotes, rebuilt from what was kept of it.
 */

/** WhatsApp's id of the message this one quotes, if it quotes one. */
export function quotedStanzaId(message: WAMessage | null | undefined): string | null {
  const content = normalizeMessageContent(message?.message);
  if (!content) return null;
  const type = getContentType(content);
  const inner = type ? (content as Record<string, unknown>)[type] : null;
  const info =
    inner && typeof inner === 'object'
      ? (inner as { contextInfo?: proto.IContextInfo | null }).contextInfo
      : null;
  return info?.stanzaId ?? null;
}

/**
 * A kept message, enough for WhatsApp to show it quoted: who wrote it, its id,
 * and its words. The phone shows the original where it still has it.
 */
export function quoteOf(chat: string, waId: string, fromMe: boolean, text: string): WAMessage {
  return {
    key: { remoteJid: chat, fromMe, id: waId },
    message: { conversation: text || '📎' },
  } as WAMessage;
}
