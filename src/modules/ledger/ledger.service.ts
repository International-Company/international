import 'server-only';
import { prisma, withTransaction, type DbClient, type Tx } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import { balanceDelta, type AccountType } from './accounts';
import { nextReference } from './reference';

/**
 * The general ledger.
 *
 * Every financial fact in the system becomes a journal entry here, and nothing
 * else is permitted to write to `accounts.balance`. That single rule is what
 * makes the books provable: the cached balance and the sum of the account's
 * journal lines must always agree, and `reconcile()` checks exactly that.
 *
 * Entries are append-only. A mistake is corrected by posting its mirror image,
 * never by editing history.
 */

const log = createLogger('ledger');

export interface JournalLineInput {
  accountId: string;
  debit?: bigint;
  credit?: bigint;
  memo?: string;
}

export interface PostEntryInput {
  description: string;
  descriptionAr?: string;
  lines: JournalLineInput[];
  transactionId?: string;
  valueDate?: Date;
  createdById?: string;
  reference?: string;
}

export interface PostedEntry {
  id: string;
  reference: string;
  lineCount: number;
}

/**
 * Posts a balanced journal entry and applies it to account balances atomically.
 *
 * Multi-currency entries are validated per currency: an exchange moves ILS and
 * USD in the same entry, and each currency must balance on its own. A single
 * cross-currency "total" would be meaningless.
 */
export async function postEntry(
  input: PostEntryInput,
  db: DbClient = prisma,
): Promise<PostedEntry> {
  if (input.lines.length < 2) {
    throw errors.precondition('A journal entry needs at least two lines', 'errors.entryTooFewLines');
  }

  return withTransaction(async (tx) => {
    const accountIds = [...new Set(input.lines.map((l) => l.accountId))];
    const accounts = await tx.account.findMany({ where: { id: { in: accountIds } } });

    if (accounts.length !== accountIds.length) {
      const found = new Set(accounts.map((a) => a.id));
      const missing = accountIds.find((id) => !found.has(id));
      throw errors.notFound('Account', missing);
    }

    const accountById = new Map(accounts.map((a) => [a.id, a]));

    // --- Validate: balanced per currency, non-negative, all sides positive ---
    const totalsByCurrency = new Map<string, { debit: bigint; credit: bigint }>();

    for (const line of input.lines) {
      const account = accountById.get(line.accountId)!;
      if (!account.isActive) {
        throw errors.precondition(
          `Account ${account.code} is inactive`,
          'errors.accountInactive',
        );
      }

      const debit = line.debit ?? 0n;
      const credit = line.credit ?? 0n;

      if (debit < 0n || credit < 0n) {
        throw errors.precondition('Journal amounts must not be negative', 'errors.negativeAmount');
      }
      if (debit > 0n && credit > 0n) {
        throw errors.precondition(
          'A journal line is either a debit or a credit, never both',
          'errors.lineBothSides',
        );
      }
      if (debit === 0n && credit === 0n) {
        throw errors.precondition('Journal lines must carry an amount', 'errors.zeroLine');
      }

      const totals = totalsByCurrency.get(account.currencyCode) ?? { debit: 0n, credit: 0n };
      totals.debit += debit;
      totals.credit += credit;
      totalsByCurrency.set(account.currencyCode, totals);
    }

    for (const [currency, totals] of totalsByCurrency) {
      if (totals.debit !== totals.credit) {
        throw errors.unbalanced(`${toDecimalString(totals.debit - totals.credit, 8)} ${currency}`);
      }
    }

    // --- Apply ------------------------------------------------------------
    const reference = input.reference ?? (await nextReference('JRN', tx));

    const entry = await tx.journalEntry.create({
      data: {
        reference,
        description: input.description,
        descriptionAr: input.descriptionAr ?? null,
        transactionId: input.transactionId ?? null,
        valueDate: input.valueDate ?? new Date(),
        createdById: input.createdById ?? null,
      },
    });

    // Aggregate first: two lines can touch the same account, and we want one
    // balance update carrying the correct final `balanceAfter`.
    const deltaByAccount = new Map<string, bigint>();
    for (const line of input.lines) {
      const account = accountById.get(line.accountId)!;
      const delta = balanceDelta(account.type as AccountType, line.debit ?? 0n, line.credit ?? 0n);
      deltaByAccount.set(line.accountId, (deltaByAccount.get(line.accountId) ?? 0n) + delta);
    }

    const balanceAfterByAccount = new Map<string, bigint>();
    for (const [accountId, delta] of deltaByAccount) {
      const account = accountById.get(accountId)!;
      const next = account.balance + delta;

      if (next < 0n && !account.allowNegative) {
        throw errors.insufficientFunds(
          account.code,
          `${toDecimalString(account.balance, 2)} ${account.currencyCode}`,
          `${toDecimalString(-delta, 2)} ${account.currencyCode}`,
        );
      }

      await tx.account.update({ where: { id: accountId }, data: { balance: next } });
      balanceAfterByAccount.set(accountId, next);
    }

    await tx.journalLine.createMany({
      data: input.lines.map((line, index) => ({
        entryId: entry.id,
        accountId: line.accountId,
        currencyCode: accountById.get(line.accountId)!.currencyCode,
        debit: line.debit ?? 0n,
        credit: line.credit ?? 0n,
        balanceAfter: balanceAfterByAccount.get(line.accountId) ?? 0n,
        memo: line.memo ?? null,
        sequence: index,
      })),
    });

    log.info('Posted journal entry', {
      reference,
      lines: input.lines.length,
      transactionId: input.transactionId,
    });

    return { id: entry.id, reference, lineCount: input.lines.length };
  }, db);
}

/**
 * Posts the mirror image of an existing entry. Debits become credits and the
 * original stays exactly as it was written — the correction is visible, which
 * is the entire point of a ledger.
 */
export async function reverseEntry(
  entryId: string,
  options: { reason: string; createdById?: string },
  db: DbClient = prisma,
): Promise<PostedEntry> {
  return withTransaction(async (tx) => {
    const original = await tx.journalEntry.findUnique({
      where: { id: entryId },
      include: { lines: true, reversedBy: true },
    });

    if (!original) throw errors.notFound('Journal entry', entryId);
    if (original.reversedBy) {
      throw errors.conflict('This entry has already been reversed', 'errors.alreadyReversed');
    }
    if (original.isReversal) {
      throw errors.conflict('A reversal cannot itself be reversed', 'errors.cannotReverseReversal');
    }

    const posted = await postEntry(
      {
        description: `Reversal of ${original.reference} — ${options.reason}`,
        descriptionAr: `عكس القيد ${original.reference} — ${options.reason}`,
        transactionId: original.transactionId ?? undefined,
        createdById: options.createdById,
        lines: original.lines.map((line) => ({
          accountId: line.accountId,
          debit: line.credit,
          credit: line.debit,
          memo: `Reversal: ${line.memo ?? ''}`.trim(),
        })),
      },
      tx,
    );

    await tx.journalEntry.update({
      where: { id: posted.id },
      data: { isReversal: true, reversesEntryId: original.id },
    });

    return posted;
  }, db);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  nameEn: string;
  nameAr: string;
  type: string;
  currencyCode: string;
  debit: bigint;
  credit: bigint;
  balance: bigint;
}

/**
 * Trial balance as at a moment in time. Totals are grouped per currency —
 * summing across currencies would be arithmetic without meaning.
 */
export async function trialBalance(
  options: { asOf?: Date; branchId?: string } = {},
  db: DbClient = prisma,
): Promise<{ rows: TrialBalanceRow[]; totals: Record<string, { debit: bigint; credit: bigint }> }> {
  const accounts = await db.account.findMany({
    where: { ...(options.branchId ? { branchId: options.branchId } : {}) },
    orderBy: [{ currencyCode: 'asc' }, { sortOrder: 'asc' }, { code: 'asc' }],
  });

  const grouped = await db.journalLine.groupBy({
    by: ['accountId'],
    _sum: { debit: true, credit: true },
    ...(options.asOf ? { where: { createdAt: { lte: options.asOf } } } : {}),
  });

  const sums = new Map(grouped.map((g) => [g.accountId, g._sum]));
  const totals: Record<string, { debit: bigint; credit: bigint }> = {};

  const rows: TrialBalanceRow[] = accounts.map((account) => {
    const sum = sums.get(account.id);
    const debit = sum?.debit ?? 0n;
    const credit = sum?.credit ?? 0n;

    const currencyTotals = totals[account.currencyCode] ?? { debit: 0n, credit: 0n };
    currencyTotals.debit += debit;
    currencyTotals.credit += credit;
    totals[account.currencyCode] = currencyTotals;

    return {
      accountId: account.id,
      code: account.code,
      nameEn: account.nameEn,
      nameAr: account.nameAr,
      type: account.type,
      currencyCode: account.currencyCode,
      debit,
      credit,
      balance: balanceDelta(account.type as AccountType, debit, credit),
    };
  });

  return { rows, totals };
}

export interface ReconciliationIssue {
  accountId: string;
  code: string;
  currencyCode: string;
  cachedBalance: bigint;
  computedBalance: bigint;
  difference: bigint;
}

/**
 * Verifies every cached account balance against the sum of its journal lines.
 * Runs as a scheduled job; a non-empty result means something wrote to a
 * balance outside this module and is a genuine incident.
 */
export async function reconcile(db: DbClient = prisma): Promise<ReconciliationIssue[]> {
  const accounts = await db.account.findMany();
  const grouped = await db.journalLine.groupBy({
    by: ['accountId'],
    _sum: { debit: true, credit: true },
  });
  const sums = new Map(grouped.map((g) => [g.accountId, g._sum]));

  const issues: ReconciliationIssue[] = [];

  for (const account of accounts) {
    const sum = sums.get(account.id);
    const computed = balanceDelta(
      account.type as AccountType,
      sum?.debit ?? 0n,
      sum?.credit ?? 0n,
    );

    if (computed !== account.balance) {
      issues.push({
        accountId: account.id,
        code: account.code,
        currencyCode: account.currencyCode,
        cachedBalance: account.balance,
        computedBalance: computed,
        difference: account.balance - computed,
      });
    }
  }

  if (issues.length > 0) {
    log.error('Ledger reconciliation found discrepancies', { count: issues.length, issues });
  }

  return issues;
}

/** Account statement: every line touching an account, with a running balance. */
export async function accountStatement(
  accountId: string,
  options: { from?: Date; to?: Date; page?: number; pageSize?: number } = {},
  db: DbClient = prisma,
) {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, options.pageSize ?? 50));

  const where = {
    accountId,
    ...(options.from || options.to
      ? {
          createdAt: {
            ...(options.from ? { gte: options.from } : {}),
            ...(options.to ? { lte: options.to } : {}),
          },
        }
      : {}),
  };

  const [lines, total] = await Promise.all([
    db.journalLine.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        entry: {
          select: {
            reference: true,
            description: true,
            descriptionAr: true,
            postedAt: true,
            transactionId: true,
            transaction: { select: { reference: true, type: true } },
          },
        },
      },
    }),
    db.journalLine.count({ where }),
  ]);

  return { lines, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Movement totals for an account across a window — used by the daily close. */
export async function movements(
  accountId: string,
  from: Date,
  to: Date,
  db: DbClient = prisma,
): Promise<{ debit: bigint; credit: bigint }> {
  const result = await db.journalLine.aggregate({
    where: { accountId, createdAt: { gte: from, lte: to } },
    _sum: { debit: true, credit: true },
  });
  return { debit: result._sum.debit ?? 0n, credit: result._sum.credit ?? 0n };
}

export type { Tx };
