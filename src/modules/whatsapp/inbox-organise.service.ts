import 'server-only';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';

/**
 * How each person keeps their inbox: replies they type often, the labels they
 * sort by, and which conversations they pinned, archived or left unread. Each
 * person's own — one teller pinning a customer moves nothing for another —
 * except a reply shared with the office, which everyone is offered.
 */

export type Scope = 'bot' | 'teller';

const MAX_REPLIES = 200;
const MAX_LABELS = 30;
export const LABEL_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b'];

// ---------------------------------------------------------------------------
// Quick replies
// ---------------------------------------------------------------------------

export async function listReplies(ownerId: string) {
  const rows = await prisma.inboxQuickReply.findMany({
    where: { OR: [{ ownerId }, { shared: true }] },
    orderBy: [{ shortcut: 'asc' }],
    take: MAX_REPLIES,
  });
  return rows.map((row) => ({
    id: row.id,
    shortcut: row.shortcut,
    text: row.text,
    shared: row.shared,
    mine: row.ownerId === ownerId,
  }));
}

/** A shortcut is one word, as it is typed after "/". */
const cleanShortcut = (raw: string) =>
  raw
    .trim()
    .replace(/^\/+/, '')
    .replace(/\s+/g, '_')
    .slice(0, 30);

export async function saveReply(
  ownerId: string,
  input: { id?: string; shortcut: string; text: string; shared: boolean },
  canShare: boolean,
) {
  const shortcut = cleanShortcut(input.shortcut);
  const text = input.text.trim().slice(0, 2000);
  if (!shortcut || !text) throw errors.validation([{ path: 'text', message: 'Write the shortcut and the reply' }]);
  const shared = input.shared && canShare;
  // The same shortcut again is that reply rewritten, not a second one.
  const same = input.id ? null : await prisma.inboxQuickReply.findFirst({ where: { ownerId, shortcut }, select: { id: true } });
  if (input.id || same) {
    const row = await prisma.inboxQuickReply.findFirst({ where: { id: input.id ?? same!.id, ownerId } });
    if (!row) throw errors.notFound('InboxQuickReply', input.id ?? shortcut);
    await prisma.inboxQuickReply.update({ where: { id: row.id }, data: { shortcut, text, shared } });
  } else {
    const count = await prisma.inboxQuickReply.count({ where: { ownerId } });
    if (count >= MAX_REPLIES) throw errors.precondition('Too many replies', 'errors.inboxTooMany');
    await prisma.inboxQuickReply.create({ data: { ownerId, shortcut, text, shared } });
  }
  return listReplies(ownerId);
}

/** Only the one who made it removes it — a shared reply too, or a manager who may share. */
export async function removeReply(ownerId: string, id: string, canShare: boolean) {
  const row = await prisma.inboxQuickReply.findFirst({
    where: { id, OR: [{ ownerId }, ...(canShare ? [{ shared: true }] : [])] },
  });
  if (!row) throw errors.notFound('InboxQuickReply', id);
  await prisma.inboxQuickReply.delete({ where: { id: row.id } });
  return listReplies(ownerId);
}

// ---------------------------------------------------------------------------
// Labels and how each conversation is kept
// ---------------------------------------------------------------------------

const readLabels = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
};

export async function organisation(ownerId: string, scope: Scope) {
  const [labels, marks] = await Promise.all([
    prisma.inboxLabel.findMany({ where: { ownerId }, orderBy: { createdAt: 'asc' } }),
    prisma.inboxChatMark.findMany({ where: { ownerId, chatKey: { startsWith: `${scope}:` } } }),
  ]);
  return {
    labels: labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
    marks: Object.fromEntries(
      marks.map((mark) => [
        mark.chatKey.slice(scope.length + 1),
        {
          pinned: mark.pinned,
          pinnedAt: mark.pinnedAt,
          archived: mark.archived,
          markedUnread: mark.markedUnread,
          labels: readLabels(mark.labels),
        },
      ]),
    ),
  };
}

export async function markChat(
  ownerId: string,
  scope: Scope,
  chatId: string,
  change: { pinned?: boolean; archived?: boolean; markedUnread?: boolean; labels?: string[] },
) {
  const chatKey = `${scope}:${chatId}`;
  const labels = change.labels
    ? (
        await prisma.inboxLabel.findMany({
          where: { ownerId, id: { in: change.labels.slice(0, MAX_LABELS) } },
          select: { id: true },
        })
      ).map((label) => label.id)
    : undefined;
  const data = {
    ...(change.pinned !== undefined ? { pinned: change.pinned, pinnedAt: change.pinned ? new Date() : null } : {}),
    // An archived conversation is not kept pinned, as WhatsApp does it.
    ...(change.archived !== undefined ? { archived: change.archived, ...(change.archived ? { pinned: false, pinnedAt: null } : {}) } : {}),
    ...(change.markedUnread !== undefined ? { markedUnread: change.markedUnread } : {}),
    ...(labels !== undefined ? { labels: labels.length ? JSON.stringify(labels) : null } : {}),
  };
  await prisma.inboxChatMark.upsert({
    where: { ownerId_chatKey: { ownerId, chatKey } },
    create: { ownerId, chatKey, ...data },
    update: data,
  });
  return organisation(ownerId, scope);
}

export async function saveLabel(ownerId: string, input: { id?: string; name: string; color: string }) {
  const name = input.name.trim().slice(0, 30);
  const color = LABEL_COLORS.includes(input.color) ? input.color : LABEL_COLORS[0]!;
  if (!name) throw errors.validation([{ path: 'name', message: 'Name the label' }]);
  // A label of that name already: its colour changed, not a second one made.
  const same = input.id ? null : await prisma.inboxLabel.findFirst({ where: { ownerId, name }, select: { id: true } });
  if (input.id || same) {
    const row = await prisma.inboxLabel.findFirst({ where: { id: input.id ?? same!.id, ownerId } });
    if (!row) throw errors.notFound('InboxLabel', input.id ?? name);
    await prisma.inboxLabel.update({ where: { id: row.id }, data: { name, color } });
  } else {
    if ((await prisma.inboxLabel.count({ where: { ownerId } })) >= MAX_LABELS) {
      throw errors.precondition('Too many labels', 'errors.inboxTooMany');
    }
    await prisma.inboxLabel.create({ data: { ownerId, name, color } });
  }
}

/** A label removed, and taken off every conversation that had it. */
export async function removeLabel(ownerId: string, id: string) {
  const row = await prisma.inboxLabel.findFirst({ where: { id, ownerId } });
  if (!row) throw errors.notFound('InboxLabel', id);
  await prisma.inboxLabel.delete({ where: { id: row.id } });
  const marks = await prisma.inboxChatMark.findMany({ where: { ownerId, labels: { contains: id } } });
  for (const mark of marks) {
    const left = readLabels(mark.labels).filter((entry) => entry !== id);
    await prisma.inboxChatMark.update({ where: { id: mark.id }, data: { labels: left.length ? JSON.stringify(left) : null } });
  }
}
