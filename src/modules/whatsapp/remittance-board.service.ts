import 'server-only';
import { prisma } from '@/core/db/prisma';

/**
 * The remittances taken from WhatsApp, each followed from the notice the
 * customer sent to the money reaching them — as the bank desk follows a
 * transfer:
 *
 *   received   → the customer's photo taken as a notice;
 *   sent       → to the agent's group for checking;
 *   answered   → the agent's first word under it;
 *   decided    → confirmed or rejected by the teller;
 *   remitted   → the incoming remittance made from it;
 *   paid       → the transfer to the customer made, or the notes handed over;
 *   told       → the customer written to with its reference.
 *
 * Read only, from what the notices, the groups and the deals already keep.
 * A teller sees their own; whoever watches every number sees everyone's.
 */

export type Stage = 'received' | 'sent' | 'answered' | 'decided' | 'remitted' | 'paid' | 'told';

export interface BoardRange {
  from: Date;
  to: Date;
}

/** Minutes a notice may wait for the agent before it is late, then very late. */
const LATE_MIN = 15;
const VERY_LATE_MIN = 30;

export async function remittanceBoard(
  viewer: { id: string; all: boolean },
  range: BoardRange,
  options: { owner?: string | null } = {},
) {
  const owner = viewer.all ? options.owner || undefined : viewer.id;
  /*
   * The days asked for, and whatever is still on its way from before them: a
   * notice sent yesterday and not yet paid is today's work, as on the bank desk.
   */
  const rows = await prisma.remittanceNotice.findMany({
    where: {
      ...(owner ? { ownerId: owner } : {}),
      OR: [
        { createdAt: { gte: range.from, lte: range.to } },
        { createdAt: { lt: range.from }, status: { in: ['NEW', 'CHECKING', 'CONFIRMED'] } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  // The agents' first answers: what quotes the photo sent, else what came after it.
  const sentIds = rows.map((row) => row.sentMessageId).filter((id): id is string => Boolean(id));
  const quoted = sentIds.length
    ? await prisma.tellerChatMessage.findMany({
        where: { quotedId: { in: sentIds }, fromMe: false },
        orderBy: { createdAt: 'asc' },
        select: { quotedId: true, createdAt: true, text: true, authorName: true },
      })
    : [];
  const groups = [...new Set(rows.filter((row) => row.agentChat).map((row) => `${row.ownerId}|${row.agentChat}`))];
  const groupChats = groups.length
    ? await prisma.tellerChat.findMany({
        where: { OR: groups.map((key) => ({ ownerId: key.split('|')[0], chat: key.split('|')[1] })) },
        select: { id: true, ownerId: true, chat: true },
      })
    : [];
  const earliestSent = rows.reduce<Date | null>((min, row) => (row.sentAt && (!min || row.sentAt < min) ? row.sentAt : min), null);
  const groupTalk =
    groupChats.length && earliestSent
      ? await prisma.tellerChatMessage.findMany({
          where: { chatId: { in: groupChats.map((chat) => chat.id) }, fromMe: false, createdAt: { gte: earliestSent } },
          orderBy: { createdAt: 'asc' },
          select: { chatId: true, createdAt: true, text: true, authorName: true },
          take: 2000,
        })
      : [];

  // The remittances made, their transfers, and the customer told.
  const dealIds = rows.map((row) => row.transactionId).filter((id): id is string => Boolean(id));
  const deals = dealIds.length
    ? await prisma.transaction.findMany({
        where: { id: { in: dealIds } },
        select: {
          id: true,
          reference: true,
          status: true,
          type: true,
          fromAmount: true,
          fromCurrency: true,
          toAmount: true,
          toCurrency: true,
          payoutBankAmount: true,
          payoutBankChannel: true,
          payoutAccount: true,
          transferConfirmedAt: true,
          createdAt: true,
        },
      })
    : [];
  const told = deals.length
    ? await prisma.tellerChatMessage.findMany({
        where: {
          chatId: { in: rows.filter((row) => row.transactionId).map((row) => row.chatId) },
          fromMe: true,
          OR: deals.map((deal) => ({ text: { contains: deal.reference } })),
        },
        select: { chatId: true, text: true, createdAt: true },
      })
    : [];

  const people = await prisma.user.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.ownerId))] } },
    select: { id: true, fullNameAr: true, fullNameEn: true },
  });

  const now = Date.now();
  const lines = rows.map((row) => {
    const deal = row.transactionId ? deals.find((entry) => entry.id === row.transactionId) : undefined;
    const group = groupChats.find((chat) => chat.ownerId === row.ownerId && chat.chat === row.agentChat);
    const answer =
      (row.sentMessageId ? quoted.find((entry) => entry.quotedId === row.sentMessageId) : undefined) ??
      (group && row.sentAt
        ? groupTalk.find((entry) => entry.chatId === group.id && entry.createdAt >= row.sentAt!)
        : undefined);
    const out = row.direction === 'OUT';
    const bank = Boolean(!out && deal && deal.payoutBankAmount > 0n);
    // Sent out, it is done once recorded: the customer paid, the agent carried it out.
    const paidAt = deal
      ? out
        ? deal.status === 'POSTED'
          ? deal.createdAt
          : null
        : bank
        ? deal.transferConfirmedAt
        : deal.status === 'POSTED'
          ? deal.createdAt
          : null
      : null;
    const toldAt = deal ? told.find((entry) => entry.chatId === row.chatId && entry.text.includes(deal.reference))?.createdAt ?? null : null;
    const person = people.find((entry) => entry.id === row.ownerId);

    const stages: Partial<Record<Stage, { at: Date; by?: string | null; note?: string | null }>> = {
      received: { at: row.createdAt, by: person?.fullNameAr ?? null },
    };
    if (row.sentAt) stages.sent = { at: row.sentAt, by: row.agentName };
    if (answer) stages.answered = { at: answer.createdAt, by: answer.authorName, note: answer.text.slice(0, 160) };
    if (row.decidedAt && (row.status === 'CONFIRMED' || row.status === 'REJECTED')) {
      stages.decided = { at: row.decidedAt, by: row.decidedByName };
    }
    if (deal) stages.remitted = { at: deal.createdAt, note: deal.reference };
    if (paidAt) stages.paid = { at: paidAt, note: bank ? deal!.payoutBankChannel : null };
    if (toldAt) stages.told = { at: toldAt };

    /*
     * Where it stands, as one word: still to send to the agent, with the agent,
     * confirmed and waiting to be paid out, paid out and waiting on the bank,
     * done, or rejected.
     */
    const state =
      row.status === 'REJECTED'
        ? 'rejected'
        : paidAt
          ? 'done'
          : deal
            ? 'remitted'
            : row.status === 'CONFIRMED'
              ? 'confirmed'
              : row.status === 'CHECKING'
                ? 'checking'
                : 'new';
    // How long the step it waits on has taken: the agent, the payout, or the bank.
    const waitingSince =
      state === 'checking'
        ? row.sentAt
        : state === 'confirmed'
          ? row.decidedAt
          : state === 'remitted'
            ? deal!.createdAt
            : state === 'new'
              ? row.createdAt
              : null;
    const waited = waitingSince ? Math.max(0, Math.round((now - waitingSince.getTime()) / 60_000)) : null;

    return {
      id: row.id,
      chatId: row.chatId,
      imageId: row.imageId,
      owner: { id: row.ownerId, nameAr: person?.fullNameAr ?? '—', nameEn: person?.fullNameEn ?? '—' },
      /** On the viewer's own number: its conversation can be opened from here. */
      mine: row.ownerId === viewer.id,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      network: row.network,
      direction: out ? ('OUT' as const) : ('IN' as const),
      beneficiaryName: row.beneficiaryName,
      deliverAmount: row.deliverAmount,
      deliverCurrency: row.deliverCurrency,
      amount: row.amount,
      currency: row.currency,
      agentName: row.agentName,
      note: row.note,
      state,
      waited,
      late: waited === null ? 'ok' : waited >= VERY_LATE_MIN ? 'veryLate' : waited >= LATE_MIN ? 'late' : 'ok',
      deal: deal
        ? {
            id: deal.id,
            reference: deal.reference,
            fromAmount: deal.fromAmount,
            fromCurrency: deal.fromCurrency,
            toAmount: deal.toAmount,
            toCurrency: deal.toCurrency,
            bank,
            channel: deal.payoutBankChannel,
            account: deal.payoutAccount,
          }
        : null,
      stages,
      createdAt: row.createdAt,
    };
  });

  const count = (state: string) => lines.filter((line) => line.state === state).length;
  const minutes = (from: Stage, to: Stage) => {
    const spans = lines
      .filter((line) => line.stages[from] && line.stages[to])
      .map((line) => (line.stages[to]!.at.getTime() - line.stages[from]!.at.getTime()) / 60_000);
    return spans.length ? Math.round((spans.reduce((sum, value) => sum + value, 0) / spans.length) * 10) / 10 : null;
  };
  return {
    lines,
    summary: {
      total: lines.length,
      incoming: lines.filter((line) => line.direction === 'IN').length,
      outgoing: lines.filter((line) => line.direction === 'OUT').length,
      new: count('new'),
      checking: count('checking'),
      confirmed: count('confirmed'),
      remitted: count('remitted'),
      done: count('done'),
      rejected: count('rejected'),
      late: lines.filter((line) => line.late !== 'ok' && line.state !== 'done' && line.state !== 'rejected').length,
      avgAnswer: minutes('sent', 'answered'),
      avgDone: minutes('received', 'paid'),
    },
    // For the manager's filter: who has notices in these days.
    owners: viewer.all ? people.map((entry) => ({ id: entry.id, nameAr: entry.fullNameAr, nameEn: entry.fullNameEn })) : [],
  };
}
