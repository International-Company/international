import { normalizeDigits } from '@/core/money/money';
import { foldName } from './report-command';

/**
 * Rules for passing messages from one WhatsApp group on to another.
 *
 * Each rule names the group it reads and the group it writes to. With no
 * condition it passes on everything written there; each condition set narrows
 * it: the words a message must hold (any one of them), the numbers it must come
 * from (any one), and whether it is typed text or the words under a photo.
 * Only the words go on: a photo itself stays where it was.
 */

export const FORWARD_KINDS = ['ALL', 'TEXT', 'CAPTION'] as const;
export type ForwardKind = (typeof FORWARD_KINDS)[number];

export interface ForwardRule {
  id: string;
  enabled: boolean;
  from: { id: string; name: string };
  to: { id: string; name: string };
  /** Words or phrases, one per line or separated by commas. Empty: any message. */
  words: string;
  /** Phone numbers, one per line or separated by commas. Empty: anyone. */
  senders: string;
  kind: ForwardKind;
}

export const MAX_FORWARD_RULES = 30;

/** The stored rules. Anything unreadable is dropped rather than guessed at. */
export function parseForwardRules(raw: string): ForwardRule[] {
  let stored: unknown;
  try {
    stored = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(stored)) return [];
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const group = (value: unknown) => {
    const entry = (value ?? {}) as { id?: unknown; name?: unknown };
    return { id: text(entry.id).trim(), name: text(entry.name) };
  };
  return stored
    .filter(
      (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
    )
    .map((entry) => ({
      id: text(entry.id) || Math.random().toString(36).slice(2, 10),
      enabled: entry.enabled !== false,
      from: group(entry.from),
      to: group(entry.to),
      words: text(entry.words),
      senders: text(entry.senders),
      kind: FORWARD_KINDS.includes(entry.kind as ForwardKind) ? (entry.kind as ForwardKind) : 'ALL',
    }))
    .filter((rule) => rule.from.id && rule.to.id && rule.from.id !== rule.to.id)
    .slice(0, MAX_FORWARD_RULES);
}

/** A list typed one per line or with commas, Arabic or Latin. */
export function listOf(value: string): string[] {
  return value
    .split(/[\n,،]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** The last nine digits: the number however it was written, with or without its country code. */
function phoneKey(value: string): string {
  const digits = normalizeDigits(value).replace(/\D/g, '');
  return digits.length > 9 ? digits.slice(-9) : digits;
}

export interface ForwardCandidate {
  chat: string;
  /** What the message says: its text, or the words under a photo. */
  text: string;
  /** Whether those words are under a photo or video rather than typed on their own. */
  caption: boolean;
  /** The sender's phone, digits or a JID, when it is known. */
  senderPhone: string | null;
}

/** Whether a message passes a rule's conditions. */
export function ruleMatches(rule: ForwardRule, message: ForwardCandidate): boolean {
  if (!rule.enabled || rule.from.id !== message.chat || !message.text.trim()) return false;
  if (rule.kind === 'TEXT' && message.caption) return false;
  if (rule.kind === 'CAPTION' && !message.caption) return false;

  const words = listOf(rule.words).map(foldName).filter(Boolean);
  if (words.length > 0) {
    const said = foldName(message.text);
    if (!words.some((word) => said.includes(word))) return false;
  }

  const senders = listOf(rule.senders).map(phoneKey).filter(Boolean);
  if (senders.length > 0) {
    const from = message.senderPhone ? phoneKey(message.senderPhone.split('@')[0]!) : '';
    if (!from || !senders.includes(from)) return false;
  }
  return true;
}

/** Whether any rule asks who sent a message, so the sender is looked up only then. */
export function needsSender(rules: ForwardRule[], chat: string): boolean {
  return rules.some((rule) => rule.enabled && rule.from.id === chat && listOf(rule.senders).length);
}

/** The groups a message goes on to: each once, however many rules send it there. */
export function forwardTargets(rules: ForwardRule[], message: ForwardCandidate): string[] {
  return [...new Set(rules.filter((rule) => ruleMatches(rule, message)).map((rule) => rule.to.id))];
}
