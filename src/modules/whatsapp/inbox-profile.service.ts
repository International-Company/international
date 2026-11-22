import 'server-only';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import type { Scope } from './inbox-organise.service';

/**
 * Who is on the other end of a conversation, beside it: the office's record
 * for that number, what they did with the office lately, and the notes the
 * staff keep on them — written here, never sent.
 *
 * A teller's own number's conversation is theirs alone, as everywhere else in
 * the inbox; the private number's are every inbox holder's.
 */

/** Numbers are one person on their last nine digits: 0599… and 970599… alike. */
const keyOf = (phone: string | null | undefined) => {
  const digits = phone?.replace(/\D/g, '') ?? '';
  return digits.length >= 9 ? digits.slice(-9) : null;
};

/** The conversation, if this person may read it, and the number it is with. */
async function chatOf(ownerId: string, scope: Scope, chatId: string) {
  if (scope === 'teller') {
    const row = await prisma.tellerChat.findFirst({
      where: { id: chatId, ownerId },
      select: { id: true, phone: true, chat: true, createdAt: true },
    });
    if (!row) throw errors.notFound('TellerChat', chatId);
    return { phone: row.phone, group: row.chat.endsWith('@g.us'), since: row.createdAt };
  }
  const row = await prisma.botConversation.findUnique({
    where: { id: chatId },
    select: { phone: true, chat: true, createdAt: true },
  });
  if (!row) throw errors.notFound('BotConversation', chatId);
  return { phone: row.phone, group: row.chat.endsWith('@g.us'), since: row.createdAt };
}

export async function chatProfile(ownerId: string, scope: Scope, chatId: string) {
  const chat = await chatOf(ownerId, scope, chatId);
  const key = chat.group ? null : keyOf(chat.phone);
  const customer = key
    ? await prisma.customer.findFirst({
        where: { OR: [{ phone: { endsWith: key } }, { altPhone: { endsWith: key } }] },
        select: {
          id: true,
          code: true,
          fullNameAr: true,
          fullNameEn: true,
          phone: true,
          city: true,
          kycStatus: true,
          riskLevel: true,
          isBlocked: true,
          blockReason: true,
          notes: true,
          createdAt: true,
        },
      })
    : null;

  // What they did with the office: by their record, or by the number written on the deal.
  const where = [
    ...(customer ? [{ customerId: customer.id }] : []),
    ...(key ? [{ counterpartyPhone: { endsWith: key } }] : []),
  ];
  const [transactions, totals, notes] = await Promise.all([
    where.length
      ? prisma.transaction.findMany({
          where: { OR: where, reversalOfId: null },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            reference: true,
            type: true,
            status: true,
            fromCurrency: true,
            fromAmount: true,
            toCurrency: true,
            toAmount: true,
            createdAt: true,
          },
        })
      : Promise.resolve([]),
    where.length
      ? prisma.transaction.aggregate({ where: { OR: where, reversalOfId: null, status: { not: 'REVERSED' } }, _count: { _all: true }, _min: { createdAt: true } })
      : Promise.resolve(null),
    prisma.inboxChatNote.findMany({
      where: { chatKey: `${scope}:${chatId}` },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);

  return {
    phone: chat.phone,
    group: chat.group,
    since: chat.since,
    customer,
    transactions,
    dealCount: totals?._count._all ?? 0,
    firstDealAt: totals?._min.createdAt ?? null,
    notes: notes.map((note) => ({
      id: note.id,
      text: note.text,
      authorName: note.authorName,
      mine: note.authorId === ownerId,
      createdAt: note.createdAt,
    })),
  };
}

export async function addNote(
  author: { id: string; name: string },
  scope: Scope,
  chatId: string,
  text: string,
) {
  await chatOf(author.id, scope, chatId);
  const words = text.trim().slice(0, 1000);
  if (!words) throw errors.validation([{ path: 'text', message: 'Write the note' }]);
  await prisma.inboxChatNote.create({
    data: { chatKey: `${scope}:${chatId}`, authorId: author.id, authorName: author.name.slice(0, 80), text: words },
  });
  return chatProfile(author.id, scope, chatId);
}

/** Only the one who wrote a note removes it. */
export async function removeNote(ownerId: string, scope: Scope, chatId: string, noteId: string) {
  await chatOf(ownerId, scope, chatId);
  const note = await prisma.inboxChatNote.findFirst({
    where: { id: noteId, chatKey: `${scope}:${chatId}`, authorId: ownerId },
  });
  if (!note) throw errors.notFound('InboxChatNote', noteId);
  await prisma.inboxChatNote.delete({ where: { id: note.id } });
  return chatProfile(ownerId, scope, chatId);
}
