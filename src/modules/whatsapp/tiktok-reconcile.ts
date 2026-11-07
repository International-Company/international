import 'server-only';
import { prisma } from '@/core/db/prisma';
import { createLogger } from '@/core/logger/logger';
import { dayBounds, formatDayKey } from '@/core/time/day-key';
import * as settings from '@/modules/settings/settings.service';
import {
  composeReconciliation,
  RECONCILE_CODE,
  TIKTOK_DEAL_TYPE,
  type ReconcileRow,
} from '@/modules/tiktok/tiktok-message';
import { groupFor, parseRoutes } from './group-routes';
import { parseCommand } from './report-command';
import { onIncomingText, sendText, type IncomingText } from './whatsapp.service';

/**
 * «#مطابقة» in the TikTok group, answered with the dollars withdrawn that day.
 *
 * Only in the group the withdrawals themselves go to: it already saw every one of
 * them, so anyone there may ask, and the answer tells it nothing new. Typed
 * anywhere else, it is ignored.
 */

const log = createLogger('whatsapp:tiktok-reconcile');

export interface ReconcileDeps {
  /** The group TikTok withdrawals are sent to, or null when none is. */
  group: () => Promise<string | null>;
  /** The day's withdrawals that stand. */
  rows: (now: Date) => Promise<ReconcileRow[]>;
  reply: (incoming: IncomingText, text: string) => Promise<void>;
  now?: () => Date;
}

export type ReconcileOutcome = 'IGNORED' | 'SENT' | 'FAILED';

const clock = (at: Date) =>
  `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;

export async function handleReconcile(
  incoming: IncomingText,
  deps: ReconcileDeps,
): Promise<ReconcileOutcome> {
  // The code alone: anything after it is not this command.
  if (parseCommand(incoming.text, RECONCILE_CODE) !== '') return 'IGNORED';
  const group = await deps.group();
  if (!group || incoming.chat !== group) return 'IGNORED';

  const now = deps.now?.() ?? new Date();
  try {
    const text = composeReconciliation(await deps.rows(now), formatDayKey(now), clock(now));
    await deps.reply(incoming, text);
    return 'SENT';
  } catch (error) {
    log.warn('Could not answer a TikTok reconciliation', { error });
    return 'FAILED';
  }
}

let registered = false;

/** Listens for the code in the TikTok group. Once per process. */
export function registerTiktokReconcile(): void {
  if (registered) return;
  registered = true;

  onIncomingText(async (incoming) => {
    await handleReconcile(incoming, {
      group: async () => {
        if (!(await settings.getBoolean('whatsapp.enabled'))) return null;
        return (
          groupFor(
            TIKTOK_DEAL_TYPE,
            parseRoutes(await settings.getString('whatsapp.groupRoutes')),
            (await settings.getString('whatsapp.groupId')).trim(),
          ) || null
        );
      },
      rows: async (now) => {
        const { start, end } = dayBounds(now);
        const found = await prisma.tiktokWithdrawal.findMany({
          where: { deletedAt: null, createdAt: { gte: start, lte: end } },
          orderBy: { createdAt: 'asc' },
          select: { amount: true, currency: true },
        });
        return found;
      },
      reply: async (message, text) => {
        await sendText(message.chat, text, message.message);
      },
    });
  });
}
