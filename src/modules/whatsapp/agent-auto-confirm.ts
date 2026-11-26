import 'server-only';
import { prisma } from '@/core/db/prisma';
import { createLogger } from '@/core/logger/logger';
import * as settings from '@/modules/settings/settings.service';
import { agentVerdict } from './agent-reply';

const log = createLogger('whatsapp:auto-confirm');

/** An answer not quoting the photo still counts, when it is the only one waiting there and this recent. */
const UNQUOTED_WINDOW_MS = 2 * 60 * 60_000;

/**
 * An agent answered in their group: a notice waiting on that answer, and the
 * answer a plain yes — «تم», «واصل», ✅ — is confirmed by itself, in the
 * agent's name, marked as automatic. It can be reopened as any decision can.
 *
 * Which notice: the one whose photo the answer quotes; with no quote, only
 * when exactly one of the teller's notices waits in that group, sent within
 * the last two hours — never a guess between two.
 *
 * A no is not acted on: the teller rejects, the board shows the agent's word.
 */
export async function confirmFromAgentReply(input: {
  ownerId: string;
  /** The group's conversation, and the message answered, as kept. */
  chatId: string;
  agentChat: string;
  quotedId: string | null;
  text: string;
  author: string | null;
}): Promise<void> {
  if (agentVerdict(input.text) !== 'yes') return;
  if (!(await settings.getBoolean('remittance.autoConfirm'))) return;

  const waiting = { ownerId: input.ownerId, status: 'CHECKING', direction: 'IN', transactionId: null };
  let noticeId: string | null = null;
  if (input.quotedId) {
    const notice = await prisma.remittanceNotice.findFirst({
      where: { ...waiting, sentMessageId: input.quotedId },
      select: { id: true },
    });
    noticeId = notice?.id ?? null;
  } else {
    const notices = await prisma.remittanceNotice.findMany({
      where: { ...waiting, agentChat: input.agentChat, sentAt: { gte: new Date(Date.now() - UNQUOTED_WINDOW_MS) } },
      select: { id: true },
      take: 2,
    });
    noticeId = notices.length === 1 ? notices[0]!.id : null;
  }
  if (!noticeId) return;

  // Still waiting when written: a decision taken meanwhile stands.
  const done = await prisma.remittanceNotice.updateMany({
    where: { id: noticeId, status: 'CHECKING', transactionId: null },
    data: {
      status: 'CONFIRMED',
      decidedAt: new Date(),
      decidedByName: `${input.author?.trim() || 'الوكيل'} · تلقائي`.slice(0, 80),
    },
  });
  if (done.count === 1) log.info('A remittance notice was confirmed from the agent’s answer', { quoted: Boolean(input.quotedId) });
}
