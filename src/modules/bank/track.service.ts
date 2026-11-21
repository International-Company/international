import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import type { Actor } from '@/modules/exchange/transaction.service';
import { desk } from './bank.service';
import { executorGroups } from './group-feed.service';

/**
 * Every transfer of the days asked for, followed from where it began to where
 * it was carried out — so whoever watches the desk sees each one's way, how
 * long each step took, and which are stuck:
 *
 *   recorded  → at the counter, or written in the group from outside;
 *   posted    → its message in the bank transfers group;
 *   forwarded → passed on to whoever carries it out: by the desk, by a ❤️ on
 *               it, by forwarding it on WhatsApp, or by a rule;
 *   done      → sent, by the desk's button or a 👍;
 *   receipt   → the bank's receipt kept on it.
 *
 * Read only: built from what the desk and the groups already keep.
 */

export type StageKey = 'recorded' | 'posted' | 'forwarded' | 'done' | 'receipt';

export interface Stage {
  at: Date;
  /** Who did it, when it is known. */
  by: string | null;
  /** Where: the group it was written in or passed on to. */
  group?: string | null;
  /** How it was passed on. */
  via?: 'desk' | 'heart' | 'whatsapp' | 'rule';
}

type DeskLine = Awaited<ReturnType<typeof desk>>['waiting'][number];

export interface Tracked {
  key: string;
  line: DeskLine;
  stages: Partial<Record<StageKey, Stage>>;
}

export interface TrackEvent {
  key: string;
  stage: StageKey;
  at: Date;
  by: string | null;
  group: string | null;
  via: Stage['via'] | null;
  amount: bigint;
  currency: string;
  name: string | null;
  channel: string | null;
}

const minutesBetween = (from: Date, to: Date) => Math.max(0, (to.getTime() - from.getTime()) / 60_000);

const average = (values: number[]) =>
  values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : null;

export async function track(actor: Actor, range: { from: Date; to: Date }, db: DbClient = prisma) {
  const read = await desk(actor, db, range);
  const lines = (read.range ?? []).filter((line) => line.status !== 'REVERSED');

  // Their messages as the groups' panel kept them: where each was written and when.
  const messageIds = lines.map((line) => line.messageId).filter((id): id is string => Boolean(id));
  const messages = messageIds.length
    ? await db.groupMessage.findMany({
        where: { id: { in: messageIds } },
        select: { id: true, chat: true, waId: true, createdAt: true },
      })
    : [];
  const messageOf = new Map(messages.map((row) => [row.id, row]));

  // Where each went from there, and by whom.
  const executors = await executorGroups();
  const forwards = messages.length
    ? await db.groupForward.findMany({
        where: { OR: messages.map((row) => ({ sourceChat: row.chat, sourceWaId: row.waId })) },
        orderBy: { createdAt: 'asc' },
        select: {
          sourceChat: true,
          sourceWaId: true,
          targetChat: true,
          targetName: true,
          targetWaId: true,
          auto: true,
          byUserId: true,
          byName: true,
          reactor: true,
          createdAt: true,
        },
      })
    : [];

  // The receipts: a deal's transfer photos, a request's receipt.
  const dealIds = lines.filter((line) => line.source === 'deal').map((line) => line.id);
  const proofs = dealIds.length
    ? await db.transactionProof.findMany({
        where: { transactionId: { in: dealIds }, kind: 'TRANSFER' },
        orderBy: { createdAt: 'asc' },
        select: { transactionId: true, createdAt: true },
      })
    : [];
  const requestIds = lines.filter((line) => line.source === 'group').map((line) => line.id);
  const receipts = requestIds.length
    ? await db.bankRequest.findMany({
        where: { id: { in: requestIds }, receiptId: { not: null } },
        select: { id: true, receiptId: true },
      })
    : [];
  const receiptFiles = receipts.length
    ? await db.chatImage.findMany({
        where: { id: { in: receipts.map((row) => row.receiptId!) } },
        select: { id: true, createdAt: true },
      })
    : [];

  const tiktokIds = lines.filter((line) => line.source === 'tiktok').map((line) => line.id);
  const tiktokReceipts = tiktokIds.length
    ? await db.tiktokWithdrawal.findMany({
        where: { id: { in: tiktokIds }, receiptId: { not: null } },
        select: { id: true, receiptId: true },
      })
    : [];
  const tiktokFiles = tiktokReceipts.length
    ? await db.chatImage.findMany({
        where: { id: { in: tiktokReceipts.map((row) => row.receiptId!) } },
        select: { id: true, createdAt: true },
      })
    : [];

  const groupName = read.group?.name ?? null;

  const tracked: Tracked[] = lines.map((line) => {
    const key = `${line.source ?? 'deal'}:${line.id}`;
    const stages: Tracked['stages'] = {
      recorded: { at: line.at, by: line.origin?.name ?? line.by ?? null },
    };

    const message = line.messageId ? messageOf.get(line.messageId) : undefined;
    if (message) stages.posted = { at: message.createdAt, by: null, group: groupName };

    if (message) {
      const first = forwards.find(
        (entry) =>
          entry.sourceChat === message.chat &&
          entry.sourceWaId === message.waId &&
          (!entry.auto || executors.some((group) => group.id === entry.targetChat)),
      );
      if (first) {
        stages.forwarded = {
          at: first.createdAt,
          by: first.byName,
          group: first.reactor ? null : (first.targetName ?? first.targetChat),
          via: first.reactor ? 'heart' : first.auto ? 'rule' : first.byUserId ? 'desk' : 'whatsapp',
        };
      }
    }

    if (line.sentAt) stages.done = { at: line.sentAt, by: line.sentBy ?? null };

    const receiptAt =
      line.source === 'deal'
        ? proofs.find((proof) => proof.transactionId === line.id)?.createdAt
        : line.source === 'tiktok'
          ? tiktokFiles.find((file) => file.id === tiktokReceipts.find((row) => row.id === line.id)?.receiptId)?.createdAt
          : receiptFiles.find((file) => file.id === receipts.find((row) => row.id === line.id)?.receiptId)?.createdAt;
    if (receiptAt) stages.receipt = { at: receiptAt, by: null };

    return { key, line, stages };
  });

  // What happened, newest first: the live log beside the table.
  const events: TrackEvent[] = tracked
    .flatMap((entry) =>
      (Object.entries(entry.stages) as [StageKey, Stage][]).map(([stage, value]) => ({
        key: entry.key,
        stage,
        at: value.at,
        by: value.by,
        group: value.group ?? null,
        via: value.via ?? null,
        amount: entry.line.amount,
        currency: entry.line.currency,
        name: entry.line.name,
        channel: entry.line.channel,
      })),
    )
    // A message reaching the group a moment after it was recorded says nothing new in the log.
    .filter((event) => event.stage !== 'posted')
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 150);

  const now = new Date();
  const waiting = tracked.filter((entry) => !entry.stages.done);
  const forwardMinutes = tracked
    .filter((entry) => entry.stages.forwarded)
    .map((entry) => minutesBetween(entry.stages.recorded!.at, entry.stages.forwarded!.at));
  const doneMinutes = tracked
    .filter((entry) => entry.stages.done)
    .map((entry) => minutesBetween(entry.stages.recorded!.at, entry.stages.done!.at));

  return {
    group: read.group,
    rows: tracked.map((entry) => ({ key: entry.key, line: entry.line, stages: entry.stages })),
    events,
    summary: {
      total: tracked.length,
      waiting: waiting.filter((entry) => !entry.stages.forwarded).length,
      forwarded: waiting.filter((entry) => entry.stages.forwarded).length,
      done: tracked.length - waiting.length,
      late: waiting.filter((entry) => minutesBetween(entry.stages.recorded!.at, now) >= 15).length,
      veryLate: waiting.filter((entry) => minutesBetween(entry.stages.recorded!.at, now) >= 30).length,
      avgForward: average(forwardMinutes),
      avgDone: average(doneMinutes),
    },
  };
}
