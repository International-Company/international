import 'server-only';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import * as drawers from '@/modules/drawers/drawer.service';
import { readProofImage } from '@/modules/exchange/proof-image';
import { keepMedia } from '@/modules/whatsapp/chat-images';
import { nextReference } from '@/modules/sequence/reference';
import { DEAL_ACCOUNT_SELECT, dealAccount } from '@/modules/bank/deal-account';
import { ensureDifferenceDrawer } from './shift.service';

const log = createLogger('treasury:ewallet');

/**
 * A teller's e-wallet — Jawwal Pay — that bank transfers are sent from.
 *
 * It is a drawer of the teller's own, of kind EWALLET, so every rule the
 * drawers keep holds for it: it cannot go below what it holds, and each
 * movement says why. The manager tops it up from the bank balance or the
 * treasury's cash; the bank desk hands it transfers to carry out; the teller
 * sends each from the wallet's app, attaches its receipt, and the wallet is
 * debited by what was sent. At the end of the day the teller writes the
 * balance the app shows, with a screenshot, and the manager confirms it: a gap
 * goes to the differences balance like any other count's.
 *
 * What a sent transfer is booked against:
 *  - an office deal had its bank leg taken from the broker balance when it was
 *    recorded, so the wallet paying it gives that back: wallet out, broker in;
 *  - a group's request or a TikTok withdrawal is in no balance at all, so what
 *    the wallet paid for it is the office's claim: wallet out, wallet dues in.
 */

export type TransferKind = 'deal' | 'request' | 'tiktok';
const KIND = 'EWALLET' as const;
const DUES = 'WALLET_DUE' as const;
const PERMISSION = 'ewallet.use';

interface Actor {
  id: string;
  name: string;
  permissions: string[];
  branchId?: string | null;
}

const isManager = (actor: Actor) => actor.permissions.includes('treasury.handover.manage');
const isDesk = (actor: Actor) =>
  isManager(actor) || actor.permissions.includes('bank.execute') || actor.permissions.includes('exchange.transfer.confirm');

function requireManager(actor: Actor) {
  if (!isManager(actor)) throw errors.forbidden('treasury.handover.manage');
}

async function walletOf(drawerId: string, db: DbClient = prisma) {
  const drawer = await db.drawer.findUnique({ where: { id: drawerId }, include: { teller: { select: { id: true, fullNameAr: true, fullNameEn: true, branchId: true } } } });
  if (!drawer || drawer.kind !== KIND || !drawer.tellerId) throw errors.notFound('Ewallet', drawerId);
  return drawer as typeof drawer & { tellerId: string };
}

// ---------------------------------------------------------------------------
// The manager's side: opening, topping up, the list
// ---------------------------------------------------------------------------

/** Every teller's wallet, with what it holds, what waits on it, and its last count. */
export async function listWallets() {
  const wallets = await prisma.drawer.findMany({
    where: { kind: KIND, tellerId: { not: null } },
    include: { teller: { select: { id: true, fullNameAr: true, fullNameEn: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const ids = wallets.map((wallet) => wallet.id);
  const [waiting, counts] = await Promise.all([
    prisma.ewalletAssignment.groupBy({
      by: ['drawerId'],
      where: { drawerId: { in: ids }, status: 'ASSIGNED' },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.ewalletCount.findMany({
      where: { drawerId: { in: ids } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  return wallets.map((wallet) => {
    const open = waiting.find((row) => row.drawerId === wallet.id);
    const mine = counts.filter((count) => count.drawerId === wallet.id);
    return {
      id: wallet.id,
      name: wallet.nameAr,
      currency: wallet.currencyCode,
      balance: wallet.balance,
      isActive: wallet.isActive,
      teller: wallet.teller,
      waiting: open?._count._all ?? 0,
      waitingSum: open?._sum.amount ?? 0n,
      lastCount: mine.find((count) => count.status === 'CONFIRMED') ?? null,
      pendingCount: mine.find((count) => count.status === 'SUBMITTED') ?? null,
    };
  });
}

/**
 * A wallet opened for a teller, in shekels: their own drawer of kind EWALLET,
 * and the right to see their wallet's page given to them.
 */
export async function openWallet(tellerId: string, label: string | null, actor: Actor) {
  requireManager(actor);
  const teller = await prisma.user.findUnique({ where: { id: tellerId }, select: { id: true, fullNameAr: true, fullNameEn: true, isSystem: true } });
  if (!teller || teller.isSystem) throw errors.notFound('User', tellerId);
  const ownerKey = drawers.tellerOwner(tellerId);
  const name = label?.trim() || 'جوال باي';
  const drawer = await withTransaction(async (tx) => {
    const existing = await tx.drawer.findUnique({
      where: { ownerKey_currencyCode_kind: { ownerKey, currencyCode: 'ILS', kind: KIND } },
    });
    if (existing) {
      return tx.drawer.update({ where: { id: existing.id }, data: { isActive: true } });
    }
    const made = await drawers.ensureTellerDrawer(ownerKey, 'ILS', KIND, tx);
    if (!made) throw errors.notFound('User', tellerId);
    return tx.drawer.update({
      where: { id: made.id },
      data: { nameAr: `${name} — ${teller.fullNameAr}`, nameEn: `${name} — ${teller.fullNameEn}` },
    });
  });
  // Their page: given once, never taken from a role that already holds it.
  const permission = await prisma.permission.findUnique({ where: { key: PERMISSION }, select: { id: true } });
  if (permission) {
    await prisma.userPermission
      .upsert({
        where: { userId_permissionId: { userId: tellerId, permissionId: permission.id } },
        create: { userId: tellerId, permissionId: permission.id, effect: 'ALLOW', assignedBy: actor.id, reason: 'Jawwal Pay wallet' },
        update: { effect: 'ALLOW' },
      })
      .catch((error) => log.warn('Could not give a teller their wallet page', { error }));
  }
  log.info('An e-wallet was opened for a teller');
  return { id: drawer.id };
}

/**
 * Money into the wallet from the bank balance or the treasury's cash — or back
 * out of it to either. One entry, both sides together: what left one place is
 * in the other, and nothing in between.
 */
export async function topUp(
  drawerId: string,
  input: { source: 'CASH' | 'BROKER'; direction: 'IN' | 'OUT'; amount: bigint; note?: string | null },
  actor: Actor,
) {
  requireManager(actor);
  if (input.amount <= 0n) throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  const wallet = await walletOf(drawerId);
  const note = [input.direction === 'IN' ? 'تغذية محفظة' : 'سحب من محفظة', wallet.nameAr, input.note?.trim()].filter(Boolean).join(' — ');
  await drawers.move(
    [
      {
        currency: wallet.currencyCode,
        kind: input.source,
        owner: drawers.TREASURY,
        direction: input.direction === 'IN' ? 'OUT' : 'IN',
        amount: input.amount,
        reason: 'TRANSFER',
        note,
      },
      {
        currency: wallet.currencyCode,
        kind: KIND,
        owner: wallet.ownerKey,
        direction: input.direction,
        amount: input.amount,
        reason: 'TRANSFER',
        note,
      },
    ],
    actor,
  );
  log.info('An e-wallet was topped up', { direction: input.direction });
  return walletReport(drawerId, actor);
}

// ---------------------------------------------------------------------------
// Handing transfers to a wallet
// ---------------------------------------------------------------------------

/** What a transfer is to send, where, to whom, and whether it still waits. */
async function transferFacts(kind: TransferKind, id: string) {
  if (kind === 'deal') {
    const deal = await prisma.transaction.findUnique({
      where: { id },
      select: {
        ...DEAL_ACCOUNT_SELECT,
        payoutBankAmount: true,
        payoutBankChannel: true,
        toCurrency: true,
        status: true,
        recipientName: true,
        reference: true,
        customer: { select: { phone: true, fullNameAr: true } },
      },
    });
    if (!deal) throw errors.notFound('Transaction', id);
    return {
      amount: deal.payoutBankAmount,
      currency: deal.toCurrency,
      account: dealAccount(deal),
      name: deal.recipientName ?? deal.customer?.fullNameAr ?? null,
      channel: deal.payoutBankChannel,
      waiting: deal.status === 'PENDING_TRANSFER',
    };
  }
  if (kind === 'request') {
    const row = await prisma.bankRequest.findUnique({ where: { id } });
    if (!row) throw errors.notFound('BankRequest', id);
    return { amount: row.amount, currency: row.currency, account: row.account, name: row.name, channel: row.channel, waiting: row.status === 'PENDING' };
  }
  const row = await prisma.tiktokWithdrawal.findUnique({ where: { id } });
  if (!row) throw errors.notFound('TiktokWithdrawal', id);
  return {
    amount: row.payoutAmount - row.cashAmount,
    currency: 'ILS',
    account: row.account,
    name: row.beneficiaryName,
    channel: row.channel,
    waiting: !row.deletedAt && !row.sentAt,
  };
}

/** A transfer on the bank desk handed to a teller's wallet to send. Once: a second wallet is refused. */
export async function assign(kind: TransferKind, refId: string, drawerId: string, actor: Actor) {
  if (!isDesk(actor)) throw errors.forbidden('bank.execute');
  const [wallet, facts] = await Promise.all([walletOf(drawerId), transferFacts(kind, refId)]);
  if (!wallet.isActive) throw errors.precondition('That wallet is closed', 'errors.drawerInactive', { currency: wallet.currencyCode });
  if (!facts.waiting) throw errors.conflict('This transfer is not waiting', 'errors.notPendingTransfer');
  if (facts.currency !== wallet.currencyCode) {
    throw errors.precondition('The wallet holds another currency', 'errors.ewalletCurrency', { currency: wallet.currencyCode });
  }
  // Sent in part already: the wallet is asked only for what is left.
  const { paidSoFar } = await import('@/modules/bank/transfer-payments.service');
  const paid = (await paidSoFar([{ kind, id: refId, currency: facts.currency }])).get(`${kind}:${refId}`) ?? 0n;
  const amount = facts.amount - paid;
  if (amount <= 0n) throw errors.precondition('Nothing to send', 'errors.amountNotPositive');
  // Passed on to a group to carry out: it is sent there, not from a wallet as well.
  const { heldBy } = await import('@/modules/bank/group-feed.service');
  for (const message of await messagesOf(kind, refId)) {
    const forwarded = await heldBy(message);
    if (forwarded) throw errors.conflict('Passed on to a group', 'errors.ewalletForwarded', { group: forwarded.group });
  }
  const held = await prisma.ewalletAssignment.findFirst({ where: { kind, refId, status: { in: ['ASSIGNED', 'DONE'] } } });
  if (held) {
    throw errors.conflict('Already handed to a wallet', 'errors.ewalletAssigned', { name: held.status === 'DONE' ? '✓' : '' });
  }
  const row = await prisma.ewalletAssignment.create({
    data: {
      kind,
      refId,
      drawerId,
      tellerId: wallet.tellerId,
      amount,
      currency: facts.currency,
      account: facts.account,
      name: facts.name,
      channel: facts.channel,
      assignedById: actor.id,
      assignedByName: actor.name,
    },
  });
  log.info('A transfer was handed to an e-wallet', { kind });
  return { id: row.id };
}

/** The transfer's own messages, where a forward of it would be written down. */
async function messagesOf(kind: TransferKind, id: string): Promise<{ chat: string; waId: string }[]> {
  const pairs: [string | null, string | null][] = [];
  if (kind === 'deal') {
    const deal = await prisma.transaction.findUnique({
      where: { id },
      select: { copyChat: true, copyMessageId: true, announcedChat: true, announcedMessageId: true },
    });
    if (deal) pairs.push([deal.copyChat, deal.copyMessageId], [deal.announcedChat, deal.announcedMessageId]);
  } else if (kind === 'request') {
    const row = await prisma.bankRequest.findUnique({ where: { id }, select: { chat: true, waId: true } });
    if (row) pairs.push([row.chat, row.waId]);
  } else {
    const row = await prisma.tiktokWithdrawal.findUnique({
      where: { id },
      select: { bankChat: true, bankMessageId: true, announcedChat: true, announcedMessageId: true },
    });
    if (row) pairs.push([row.bankChat, row.bankMessageId], [row.announcedChat, row.announcedMessageId]);
  }
  return pairs.filter((pair): pair is [string, string] => Boolean(pair[0] && pair[1])).map(([chat, waId]) => ({ chat, waId }));
}

/** Taken back before it was sent. */
export async function unassign(id: string, actor: Actor) {
  if (!isDesk(actor)) throw errors.forbidden('bank.execute');
  const done = await prisma.ewalletAssignment.updateMany({
    where: { id, status: 'ASSIGNED' },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByName: actor.name },
  });
  if (done.count === 0) throw errors.conflict('It was sent already, or taken back', 'errors.ewalletNotAssigned');
  return { id };
}

/** For the bank desk: which of these transfers a wallet holds, and whose. */
export async function heldByWallets(refIds: string[]) {
  if (refIds.length === 0) return [];
  const rows = await prisma.ewalletAssignment.findMany({
    where: { refId: { in: refIds }, status: { in: ['ASSIGNED', 'DONE'] } },
    select: { id: true, kind: true, refId: true, status: true, tellerId: true, drawerId: true },
  });
  const tellers = await prisma.user.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.tellerId))] } },
    select: { id: true, fullNameAr: true },
  });
  return rows.map((row) => ({ ...row, tellerName: tellers.find((teller) => teller.id === row.tellerId)?.fullNameAr ?? '' }));
}

/** The wallets the desk may hand a transfer to. */
export async function walletChoices() {
  const rows = await prisma.drawer.findMany({
    where: { kind: KIND, isActive: true, tellerId: { not: null } },
    include: { teller: { select: { fullNameAr: true } } },
  });
  return rows.map((row) => ({ id: row.id, name: row.nameAr, teller: row.teller?.fullNameAr ?? '', balance: row.balance, currency: row.currencyCode }));
}

// ---------------------------------------------------------------------------
// The teller's side: sending, and counting
// ---------------------------------------------------------------------------

/** The teller's own wallet, or null when they hold none. */
async function ownWallet(actor: Actor) {
  return prisma.drawer.findUnique({
    where: { ownerKey_currencyCode_kind: { ownerKey: drawers.tellerOwner(actor.id), currencyCode: 'ILS', kind: KIND } },
  });
}

/**
 * Sent from the wallet: its receipt kept on the transfer and the transfer
 * marked sent as the desk's own button would, and the wallet debited by what
 * left it — given back to the broker for an office deal, the office's claim for
 * anything else. The wallet is debited first: one that cannot cover it marks
 * nothing sent.
 */
export async function execute(assignmentId: string, input: { receipt: string; amount?: bigint | null }, actor: Actor) {
  const assignment = await prisma.ewalletAssignment.findUnique({ where: { id: assignmentId } });
  if (!assignment || (assignment.tellerId !== actor.id && !isManager(actor))) throw errors.notFound('EwalletAssignment', assignmentId);
  if (assignment.status !== 'ASSIGNED') throw errors.conflict('It was sent already, or taken back', 'errors.ewalletNotAssigned');
  const image = readProofImage(input.receipt);
  if (typeof image === 'string') throw errors.precondition('That photo cannot be kept', image);
  const sent = input.amount && input.amount > 0n ? input.amount : assignment.amount;
  const wallet = await walletOf(assignment.drawerId);
  const facts = await transferFacts(assignment.kind as TransferKind, assignment.refId);
  if (!facts.waiting) throw errors.conflict('This transfer was marked sent already', 'errors.notPendingTransfer');

  // Claimed, so a second press — or a second screen — sends nothing twice.
  const claimed = await prisma.ewalletAssignment.updateMany({
    where: { id: assignmentId, status: 'ASSIGNED' },
    data: { status: 'DONE', doneAt: new Date(), sentAmount: sent },
  });
  if (claimed.count === 0) throw errors.conflict('It was sent already, or taken back', 'errors.ewalletNotAssigned');

  const deal = assignment.kind === 'deal';
  const note = `${deal ? 'حوالة المكتب' : assignment.kind === 'request' ? 'طلب مجموعة' : 'سحب تيكتوك'} — ${facts.account ?? ''} ${facts.name ?? ''}`.trim();
  const legs = (direction: 'IN' | 'OUT'): drawers.Movement[] => [
    {
      currency: wallet.currencyCode,
      kind: KIND,
      owner: wallet.ownerKey,
      direction: direction === 'OUT' ? 'OUT' : 'IN',
      amount: sent,
      reason: 'TRANSFER',
      note,
    },
    {
      currency: wallet.currencyCode,
      kind: deal ? 'BROKER' : DUES,
      owner: drawers.TREASURY,
      direction: direction === 'OUT' ? 'IN' : 'OUT',
      amount: sent,
      reason: 'TRANSFER',
      account: deal ? 'Jawwal Pay' : null,
      note,
    },
  ];
  try {
    if (!deal) await ensureDues(wallet.currencyCode);
    await drawers.move(legs('OUT'), actor);
  } catch (error) {
    await prisma.ewalletAssignment.update({ where: { id: assignmentId }, data: { status: 'ASSIGNED', doneAt: null, sentAmount: null } });
    throw error;
  }

  // Marked sent as the desk's button marks it: the receipt kept, the groups told.
  const desk = { ...actor, permissions: [...actor.permissions, 'bank.execute', 'exchange.transfer.confirm'] };
  try {
    if (deal) {
      const { markSent } = await import('@/modules/bank/bank.service');
      await markSent(assignment.refId, input.receipt, desk);
    } else if (assignment.kind === 'request') {
      const { markRequestSent } = await import('@/modules/bank/bank-request.service');
      await markRequestSent(assignment.refId, input.receipt, desk);
    } else {
      const { markTiktokSent } = await import('@/modules/bank/bank-tiktok.service');
      await markTiktokSent(assignment.refId, input.receipt, desk);
    }
  } catch (error) {
    // Not marked: the wallet gets its money back and the transfer waits on it again.
    await drawers.move(legs('IN'), actor).catch((undo) => log.error('Could not give a wallet back a transfer that failed', { error: undo }));
    await prisma.ewalletAssignment.update({ where: { id: assignmentId }, data: { status: 'ASSIGNED', doneAt: null, sentAmount: null } });
    throw error;
  }
  log.info('A transfer was sent from an e-wallet', { kind: assignment.kind });
  return myWallet(actor);
}

/** The treasury's wallet dues balance, opened the first time a wallet pays for something no deal booked. */
async function ensureDues(currency: string) {
  const existing = await prisma.drawer.findUnique({
    where: { ownerKey_currencyCode_kind: { ownerKey: drawers.TREASURY, currencyCode: currency, kind: DUES } },
  });
  if (existing) return;
  const row = await prisma.currency.findUniqueOrThrow({ where: { code: currency } });
  await prisma.drawer
    .create({
      data: {
        ownerKey: drawers.TREASURY,
        currencyCode: currency,
        kind: DUES,
        nameAr: `مستحقات المحفظة — ${row.nameAr}`,
        nameEn: `${row.nameEn} — wallet dues`,
        allowNegative: true,
        sortOrder: row.sortOrder * 10 + 6,
      },
    })
    .catch(() => undefined);
}

/**
 * The wallet since its last confirmed count, line by line: what it opened with,
 * every top-up and withdrawal, every transfer it sent, and what the books say
 * it holds now.
 */
export async function walletReport(drawerId: string, actor: Actor) {
  const wallet = await walletOf(drawerId);
  if (wallet.tellerId !== actor.id && !isManager(actor)) throw errors.notFound('Ewallet', drawerId);
  const last = await prisma.ewalletCount.findFirst({
    where: { drawerId, status: 'CONFIRMED' },
    orderBy: { decidedAt: 'desc' },
  });
  // From the moment the last count was confirmed: its adjustment closes the old period, not opens the new one.
  const since = last?.decidedAt ?? last?.createdAt ?? new Date(0);
  const [before, movements, assignments, pending] = await Promise.all([
    prisma.drawerMovement.findFirst({
      where: { drawerId, createdAt: { lte: since } },
      orderBy: { createdAt: 'desc' },
      select: { balanceAfter: true },
    }),
    prisma.drawerMovement.findMany({
      where: { drawerId, createdAt: { gt: since } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, direction: true, amount: true, balanceAfter: true, reason: true, note: true, createdAt: true, createdBy: { select: { fullNameAr: true } } },
    }),
    prisma.ewalletAssignment.findMany({
      where: { drawerId, OR: [{ status: 'ASSIGNED' }, { status: 'DONE', doneAt: { gt: since } }] },
      orderBy: { assignedAt: 'desc' },
    }),
    prisma.ewalletCount.findFirst({ where: { drawerId, status: 'SUBMITTED' }, orderBy: { createdAt: 'desc' } }),
  ]);
  const opening = before?.balanceAfter ?? 0n;
  const sum = (rows: typeof movements, test: (row: (typeof movements)[number]) => boolean) =>
    rows.filter(test).reduce((total, row) => total + row.amount, 0n);
  const sentRows = assignments.filter((row) => row.status === 'DONE');
  return {
    wallet: { id: wallet.id, name: wallet.nameAr, currency: wallet.currencyCode, balance: wallet.balance, teller: wallet.teller },
    since: last?.decidedAt ?? last?.createdAt ?? null,
    lastCount: last,
    pendingCount: pending,
    opening,
    toppedUp: sum(movements, (row) => row.direction === 'IN' && row.reason === 'TRANSFER' && (row.note ?? '').startsWith('تغذية')),
    withdrawn: sum(movements, (row) => row.direction === 'OUT' && row.reason === 'TRANSFER' && (row.note ?? '').startsWith('سحب من محفظة')),
    sent: sentRows.reduce((total, row) => total + (row.sentAmount ?? row.amount), 0n),
    adjusted: sum(movements, (row) => row.reason === 'DIFFERENCE' && row.direction === 'IN') - sum(movements, (row) => row.reason === 'DIFFERENCE' && row.direction === 'OUT'),
    expected: wallet.balance,
    movements,
    waiting: assignments.filter((row) => row.status === 'ASSIGNED'),
    done: sentRows,
  };
}

/** The teller's wallet page: their wallet, what waits on it, and what it sent since the last count. */
export async function myWallet(actor: Actor) {
  const wallet = await ownWallet(actor);
  if (!wallet) return null;
  return walletReport(wallet.id, actor);
}

/**
 * The teller's count: the balance the wallet's app shows, with a screenshot of
 * it. Kept beside the books' figure at that moment; the manager confirms it.
 */
export async function submitCount(input: { actual: bigint; screenshot: string; note?: string | null }, actor: Actor) {
  const wallet = await ownWallet(actor);
  if (!wallet) throw errors.notFound('Ewallet', actor.id);
  if (input.actual < 0n) throw errors.precondition('That balance cannot be used', 'errors.amountNotPositive');
  const image = readProofImage(input.screenshot);
  if (typeof image === 'string') throw errors.precondition('That photo cannot be kept', image);
  const kept = await keepMedia(image, null);
  // A count not yet decided gives way to the new one.
  await prisma.ewalletCount.updateMany({
    where: { drawerId: wallet.id, status: 'SUBMITTED' },
    data: { status: 'RETURNED', decisionNote: 'استُبدل بجرد أحدث' },
  });
  const teller = await prisma.user.findUnique({ where: { id: actor.id }, select: { branchId: true, fullNameAr: true } });
  const expected = (await prisma.drawer.findUniqueOrThrow({ where: { id: wallet.id }, select: { balance: true } })).balance;
  const row = await withTransaction(async (tx) =>
    tx.ewalletCount.create({
      data: {
        reference: await nextReference('EWC', tx),
        drawerId: wallet.id,
        tellerId: actor.id,
        branchId: teller?.branchId ?? null,
        currency: wallet.currencyCode,
        expected,
        actual: input.actual,
        difference: expected - input.actual,
        screenshotId: kept?.id ?? null,
        note: input.note?.trim().slice(0, 500) || null,
        countedByName: teller?.fullNameAr ?? actor.name,
      },
    }),
  );
  log.info('An e-wallet was counted', { gap: (expected - input.actual).toString() });
  return { id: row.id };
}

/**
 * The manager's word on a count. Confirmed, the books are brought to what the
 * app showed: a gap moves between the wallet and the differences balance and
 * is recorded as a difference against the teller, decided later like any
 * other. Returned, the teller counts again.
 */
export async function decideCount(id: string, input: { confirm: boolean; note?: string | null }, actor: Actor) {
  requireManager(actor);
  const count = await prisma.ewalletCount.findUnique({ where: { id } });
  if (!count) throw errors.notFound('EwalletCount', id);
  if (count.status !== 'SUBMITTED') throw errors.conflict('This count was decided already', 'errors.ewalletCountDecided');
  if (!input.confirm) {
    await prisma.ewalletCount.update({
      where: { id },
      data: { status: 'RETURNED', decidedById: actor.id, decidedByName: actor.name, decidedAt: new Date(), decisionNote: input.note?.trim() || null },
    });
    return { id };
  }
  const wallet = await walletOf(count.drawerId);
  await withTransaction(async (tx) => {
    const marked = await tx.ewalletCount.updateMany({
      where: { id, status: 'SUBMITTED' },
      data: { status: 'CONFIRMED', decidedById: actor.id, decidedByName: actor.name, decidedAt: new Date(), decisionNote: input.note?.trim() || null },
    });
    if (marked.count === 0) throw errors.conflict('This count was decided already', 'errors.ewalletCountDecided');
    const gap = count.difference;
    if (gap === 0n) return;
    await ensureDifferenceDrawer(count.currency, tx);
    const size = gap > 0n ? gap : -gap;
    await drawers.move(
      [
        { currency: count.currency, kind: KIND, owner: wallet.ownerKey, direction: gap > 0n ? 'OUT' : 'IN', amount: size, reason: 'DIFFERENCE', note: count.reference },
        { currency: count.currency, kind: 'DIFFERENCE', owner: drawers.TREASURY, direction: gap > 0n ? 'IN' : 'OUT', amount: size, reason: 'DIFFERENCE', note: count.reference },
      ],
      actor,
      tx,
    );
    await tx.discrepancy.create({
      data: { walletCountId: id, tellerId: count.tellerId, currencyCode: count.currency, amount: gap, status: 'OPEN' },
    });
  });
  // Stamped after its adjustment: the wallet's next period starts from what the app showed.
  await prisma.ewalletCount.update({ where: { id }, data: { decidedAt: new Date() } });
  log.info('An e-wallet count was confirmed', { gap: count.difference.toString() });
  return { id };
}

/** The counts waiting on the manager, with their screenshots, newest first. */
export async function pendingCounts() {
  const rows = await prisma.ewalletCount.findMany({ where: { status: 'SUBMITTED' }, orderBy: { createdAt: 'desc' } });
  return rows;
}

/** A count's screenshot: the teller's own, or any to the manager. */
export async function countScreenshot(id: string, actor: Actor) {
  const count = await prisma.ewalletCount.findUnique({ where: { id }, select: { tellerId: true, screenshotId: true } });
  if (!count || !count.screenshotId || (count.tellerId !== actor.id && !isManager(actor))) throw errors.notFound('EwalletCount', id);
  const image = await prisma.chatImage.findUnique({ where: { id: count.screenshotId } });
  if (!image) throw errors.notFound('ChatImage', count.screenshotId);
  return image;
}
