import 'server-only';
import type { Prisma } from '@prisma/client';
import { prisma, withTransaction, type DbClient, type Tx } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { convert, toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import { emitAsync } from '@/core/events/bus';
import * as audit from '@/modules/audit/audit.service';
import { postEntry, reverseEntry } from '@/modules/ledger/ledger.service';
import { nextReference } from '@/modules/ledger/reference';
import * as settings from '@/modules/settings/settings.service';
import { getActiveRate, quoteExchange } from './rates.service';
import {
  AFFECTS_CUSTOMER_BALANCE,
  buildJournalLines,
  TRANSACTION_TYPE_META,
  type TransactionStatus,
  type TransactionType,
} from './posting-rules';
import { requireOpenDay } from './business-day.service';
import { containsInsensitive } from '@/core/db/search';

/**
 * Transaction lifecycle.
 *
 *   DRAFT ──submit──▶ POSTED ──reverse──▶ REVERSED
 *     └──cancel──▶ CANCELLED
 *
 * There is no approval step. Recording a transaction posts it, and only POSTED
 * transactions touch the ledger. A draft is a working document an operator can
 * still correct; a posted one is permanent and can be undone only by a visible
 * reversing entry.
 */

const log = createLogger('exchange:transaction');

export interface CreateTransactionInput {
  type: TransactionType;
  branchId: string;
  customerId?: string | null;
  fromCurrency: string;
  fromAmount: bigint;
  toCurrency?: string;
  toAmount?: bigint;
  rate?: bigint;
  feeCurrency?: string | null;
  feeAmount?: bigint;
  sourceAccountId?: string | null;
  destinationAccountId?: string | null;
  counterpartyName?: string | null;
  counterpartyPhone?: string | null;
  counterpartyDoc?: string | null;
  notes?: string | null;
  internalNotes?: string | null;
  valueDate?: Date;
  channel?: string;
  metadata?: Record<string, unknown>;
}

export interface Actor {
  id: string;
  name: string;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string;
  permissions: string[];
  branchId?: string | null;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * A price this system quoted earlier and recorded, being honoured now.
 *
 * The counter tools quote a customer, write the quote to a row, and settle it
 * minutes later once the money actually arrives. Re-pricing at settlement would
 * pay a different figure from the one the customer was shown, and routing it
 * through the override permission would mean handing every teller the authority
 * to reprice anything. This is neither: it is only reachable from server code
 * holding a persisted quote, and the reference of that record is audited with
 * the transaction.
 */
export interface AgreedQuote {
  rate: bigint;
  toAmount: bigint;
  /** The record that fixed this price, for the audit trail. */
  sourceReference: string;
}

export async function create(
  input: CreateTransactionInput,
  actor: Actor,
  options: { submit?: boolean; agreedQuote?: AgreedQuote } = {},
  db: DbClient = prisma,
): Promise<{ id: string; reference: string; status: TransactionStatus }> {
  const meta = TRANSACTION_TYPE_META[input.type];
  if (!meta) throw errors.precondition(`Unknown transaction type: ${input.type}`);

  if (input.fromAmount <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }
  if (meta.requiresCustomer && !input.customerId) {
    throw errors.precondition(
      `${meta.nameEn} requires a registered customer`,
      'errors.customerRequired',
    );
  }

  const created = await withTransaction(async (tx) => {
    // --- Customer checks -------------------------------------------------
    if (input.customerId) {
      const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
      if (!customer) throw errors.notFound('Customer', input.customerId);
      if (customer.isBlocked) {
        throw errors.precondition(
          `Customer ${customer.code} is blocked: ${customer.blockReason ?? 'no reason recorded'}`,
          'errors.customerBlocked',
        );
      }
    }

    // --- Value date --------------------------------------------------------
    const valueDate = input.valueDate ?? new Date();
    if (!(await settings.getBoolean('operations.allowBackdating', tx))) {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      if (valueDate < startOfToday && !actor.permissions.includes('exchange.transaction.overrideLimit')) {
        throw errors.precondition(
          'Back-dated value dates are disabled',
          'errors.backdatingDisabled',
        );
      }
    }

    // --- Amounts -----------------------------------------------------------
    let toCurrency = input.toCurrency ?? input.fromCurrency;
    let toAmount = input.toAmount ?? input.fromAmount;
    let rate = input.rate ?? 100_000_000n;
    let rateId: string | null = null;
    let profitAmount = 0n;

    if (meta.isCrossCurrency) {
      if (!input.toCurrency) {
        throw errors.precondition('Target currency is required', 'errors.targetCurrencyRequired');
      }
      toCurrency = input.toCurrency;

      // Re-price server-side. A rate posted from the browser is a suggestion,
      // never an instruction — otherwise the board can be bypassed entirely.
      const quote = await quoteExchange(input.fromCurrency, toCurrency, input.fromAmount, tx);
      rate = quote.rate;
      rateId = quote.rateId;
      profitAmount = quote.profit;
      toAmount = quote.toAmount;

      // A price already quoted to the customer wins over the board, which may
      // have moved in the minutes since. Profit is still measured against the
      // *current* mid — what the position is really worth now, not what it was
      // worth when the quote was given.
      if (options.agreedQuote) {
        const atMid = quote.profit + quote.toAmount;
        rate = options.agreedQuote.rate;
        toAmount = options.agreedQuote.toAmount;
        profitAmount = atMid - toAmount;
      } else if (input.toAmount && input.toAmount !== quote.toAmount) {
        // An operator may improve the customer's rate within their authority,
        // but never quietly worsen it beyond what the board supports.
        if (!actor.permissions.includes('exchange.transaction.overrideLimit')) {
          throw errors.forbidden('exchange.transaction.overrideLimit');
        }
        profitAmount = quote.profit + (quote.toAmount - input.toAmount);
        toAmount = input.toAmount;
      }
    }

    const reference = await nextReference('TXN', tx);
    const row = await tx.transaction.create({
      data: {
        reference,
        type: input.type,
        status: 'DRAFT',
        channel: input.channel ?? 'COUNTER',
        branchId: input.branchId,
        customerId: input.customerId ?? null,
        fromCurrency: input.fromCurrency,
        fromAmount: input.fromAmount,
        toCurrency,
        toAmount,
        rate,
        rateId,
        profitAmount,
        feeCurrency: input.feeCurrency ?? null,
        feeAmount: input.feeAmount ?? 0n,
        sourceAccountId: input.sourceAccountId ?? null,
        destinationAccountId: input.destinationAccountId ?? null,
        counterpartyName: input.counterpartyName ?? null,
        counterpartyPhone: input.counterpartyPhone ?? null,
        counterpartyDoc: input.counterpartyDoc ?? null,
        notes: input.notes ?? null,
        internalNotes: input.internalNotes ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        valueDate,
        createdById: actor.id,
      },
    });

    await audit.record(
      {
        action: 'CREATE',
        module: 'exchange',
        entityType: 'Transaction',
        entityId: row.id,
        summaryEn: `Created ${meta.nameEn} ${reference} for ${toDecimalString(input.fromAmount, 2)} ${input.fromCurrency}`,
        summaryAr: `إنشاء ${meta.nameAr} ${reference} بمبلغ ${toDecimalString(input.fromAmount, 2)} ${input.fromCurrency}`,
        actor,
        after: {
          reference,
          type: input.type,
          fromAmount: input.fromAmount.toString(),
          fromCurrency: input.fromCurrency,
          toAmount: toAmount.toString(),
          toCurrency,
          rate: rate.toString(),
          ...(options.agreedQuote ? { agreedQuoteFrom: options.agreedQuote.sourceReference } : {}),
        },
      },
      tx,
    );

    return { id: row.id, reference, status: 'DRAFT' as TransactionStatus };
  }, db);

  emitAsync('transaction.created', {
    transactionId: created.id,
    reference: created.reference,
    type: input.type,
    actorId: actor.id,
  });

  if (options.submit) {
    const result = await submit(created.id, actor, db);
    return { ...created, status: result.status };
  }

  return created;
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

const EDITABLE_STATUSES: TransactionStatus[] = ['DRAFT'];

export async function update(
  id: string,
  input: Partial<CreateTransactionInput>,
  actor: Actor,
  db: DbClient = prisma,
): Promise<void> {
  await withTransaction(async (tx) => {
    const existing = await loadForUpdate(tx, id);

    if (!EDITABLE_STATUSES.includes(existing.status as TransactionStatus)) {
      throw errors.conflict(
        `A ${existing.status.toLowerCase().replace('_', ' ')} transaction cannot be edited`,
        'errors.notEditable',
      );
    }
    assertOwnership(existing, actor);

    const data: Prisma.TransactionUpdateInput = { version: { increment: 1 } };

    if (input.fromAmount !== undefined) {
      if (input.fromAmount <= 0n) {
        throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
      }
      data.fromAmount = input.fromAmount;
    }
    if (input.customerId !== undefined) {
      data.customer = input.customerId ? { connect: { id: input.customerId } } : { disconnect: true };
    }
    if (input.counterpartyName !== undefined) data.counterpartyName = input.counterpartyName;
    if (input.counterpartyPhone !== undefined) data.counterpartyPhone = input.counterpartyPhone;
    if (input.counterpartyDoc !== undefined) data.counterpartyDoc = input.counterpartyDoc;
    if (input.notes !== undefined) data.notes = input.notes;
    if (input.internalNotes !== undefined) data.internalNotes = input.internalNotes;
    if (input.feeAmount !== undefined) data.feeAmount = input.feeAmount;
    if (input.feeCurrency !== undefined) data.feeCurrency = input.feeCurrency;

    // Re-price when the amount or currencies moved.
    const meta = TRANSACTION_TYPE_META[existing.type as TransactionType];
    if (meta.isCrossCurrency && (input.fromAmount !== undefined || input.toCurrency !== undefined)) {
      const quote = await quoteExchange(
        input.fromCurrency ?? existing.fromCurrency,
        input.toCurrency ?? existing.toCurrency,
        input.fromAmount ?? existing.fromAmount,
        tx,
      );
      data.toAmount = quote.toAmount;
      data.rate = quote.rate;
      data.profitAmount = quote.profit;
      data.appliedRate = { connect: { id: quote.rateId } };
    }

    const updated = await tx.transaction.update({ where: { id }, data });

    const changes = audit.diff(
      existing as unknown as Record<string, unknown>,
      updated as unknown as Record<string, unknown>,
    );

    await audit.record(
      {
        action: 'UPDATE',
        module: 'exchange',
        entityType: 'Transaction',
        entityId: id,
        summaryEn: `Updated transaction ${existing.reference} (${changes.changed.join(', ') || 'no field changes'})`,
        summaryAr: `تعديل العملية ${existing.reference} (${changes.changed.join('، ') || 'بدون تغييرات'})`,
        actor,
        before: changes.before,
        after: changes.after,
      },
      tx,
    );
  }, db);
}

/**
 * Submits a draft, which posts it to the ledger.
 *
 * There is no intermediate state and no second signature: recording a
 * transaction is the decision, and posting is its immediate consequence.
 */
export async function submit(
  id: string,
  actor: Actor,
  db: DbClient = prisma,
): Promise<{ status: TransactionStatus }> {
  const transaction = await prisma.transaction.findUnique({ where: { id } });
  if (!transaction) throw errors.notFound('Transaction', id);

  if (transaction.status !== 'DRAFT') {
    throw errors.conflict('Only a draft can be submitted', 'errors.notDraft');
  }
  assertOwnership(transaction, actor);

  await post(id, actor, db);

  emitAsync('transaction.submitted', {
    transactionId: id,
    reference: transaction.reference,
    actorId: actor.id,
  });

  return { status: 'POSTED' };
}

/**
 * Posts to the ledger. This is the point of no return: after it succeeds the
 * transaction can only be undone by a reversal, which leaves both entries
 * visible forever.
 */
export async function post(id: string, actor: Actor, db: DbClient = prisma): Promise<void> {
  const transaction = await withTransaction(async (tx) => {
    const row = await loadForUpdate(tx, id);

    if (row.status === 'POSTED') {
      throw errors.conflict('This transaction is already posted', 'errors.alreadyPosted');
    }
    if (row.status !== 'DRAFT') {
      throw errors.conflict(
        `A ${row.status.toLowerCase()} transaction cannot be posted`,
        'errors.notPostable',
      );
    }

    // --- Business day ------------------------------------------------------
    let businessDayId: string | null = null;
    if (await settings.getBoolean('operations.requireBusinessDay', tx)) {
      const day = await requireOpenDay(row.branchId, row.valueDate, tx);
      businessDayId = day.id;
    }

    // --- Ledger ------------------------------------------------------------
    const lines = await buildJournalLines(tx, {
      type: row.type as TransactionType,
      reference: row.reference,
      fromCurrency: row.fromCurrency,
      fromAmount: row.fromAmount,
      toCurrency: row.toCurrency,
      toAmount: row.toAmount,
      feeCurrency: row.feeCurrency,
      feeAmount: row.feeAmount,
      customerId: row.customerId,
      sourceAccountId: row.sourceAccountId,
      destinationAccountId: row.destinationAccountId,
      branchId: row.branchId,
    });

    const meta = TRANSACTION_TYPE_META[row.type as TransactionType];

    await postEntry(
      {
        description: `${meta.nameEn} ${row.reference}`,
        descriptionAr: `${meta.nameAr} ${row.reference}`,
        transactionId: row.id,
        valueDate: row.valueDate,
        createdById: actor.id,
        lines,
      },
      tx,
    );

    // --- Customer balance ---------------------------------------------------
    const direction = AFFECTS_CUSTOMER_BALANCE[row.type as TransactionType];
    if (direction !== 0 && row.customerId) {
      const delta = BigInt(direction) * row.fromAmount;
      await tx.customerBalance.upsert({
        where: {
          customerId_currencyCode: {
            customerId: row.customerId,
            currencyCode: row.fromCurrency,
          },
        },
        create: {
          customerId: row.customerId,
          currencyCode: row.fromCurrency,
          balance: delta,
        },
        update: { balance: { increment: delta } },
      });
    }

    await tx.transaction.update({
      where: { id },
      data: {
        status: 'POSTED',
        postedAt: new Date(),
        businessDayId,
        version: { increment: 1 },
      },
    });

    await tx.receipt.create({
      data: {
        transactionId: id,
        number: await nextReference('RCP', tx),
        locale: 'ar',
      },
    });

    await audit.record(
      {
        action: 'POST',
        module: 'exchange',
        entityType: 'Transaction',
        entityId: id,
        summaryEn: `Posted ${meta.nameEn} ${row.reference} — ${toDecimalString(row.fromAmount, 2)} ${row.fromCurrency}`,
        summaryAr: `ترحيل ${meta.nameAr} ${row.reference} — ${toDecimalString(row.fromAmount, 2)} ${row.fromCurrency}`,
        actor,
        metadata: { journalLines: lines.length },
      },
      tx,
    );

    return row;
  }, db);

  log.info('Transaction posted', { reference: transaction.reference, type: transaction.type });

  emitAsync('transaction.posted', {
    transactionId: id,
    reference: transaction.reference,
    type: transaction.type,
    actorId: actor.id,
  });
}

/**
 * Reverses a posted transaction by mirroring its journal entry. The original
 * is marked REVERSED but its record and its entry stay exactly as written.
 */
export async function reverse(
  id: string,
  reason: string,
  actor: Actor,
  db: DbClient = prisma,
): Promise<{ reversalId: string; reference: string }> {
  if (!reason.trim()) {
    throw errors.validation([{ path: 'reason', message: 'A reason is required to reverse' }]);
  }

  // Checked here and not only at the route. A teller posts their own work, so
  // undoing a posting is the manager's control over it — the one place where the
  // two roles actually differ on a transaction, and too important to leave to a
  // single caller remembering to guard it.
  if (!actor.permissions.includes('exchange.transaction.reverse')) {
    throw errors.forbidden('exchange.transaction.reverse');
  }

  const result = await withTransaction(async (tx) => {
    const original = await tx.transaction.findUnique({
      where: { id },
      include: { journalEntries: { where: { isReversal: false }, orderBy: { createdAt: 'asc' } } },
    });

    if (!original) throw errors.notFound('Transaction', id);
    if (original.status !== 'POSTED') {
      throw errors.conflict('Only a posted transaction can be reversed', 'errors.notPosted');
    }

    const existingReversal = await tx.transaction.findFirst({ where: { reversalOfId: id } });
    if (existingReversal) {
      throw errors.conflict('This transaction has already been reversed', 'errors.alreadyReversed');
    }

    for (const entry of original.journalEntries) {
      await reverseEntry(entry.id, { reason, createdById: actor.id }, tx);
    }

    // Undo the customer balance movement.
    const direction = AFFECTS_CUSTOMER_BALANCE[original.type as TransactionType];
    if (direction !== 0 && original.customerId) {
      await tx.customerBalance.update({
        where: {
          customerId_currencyCode: {
            customerId: original.customerId,
            currencyCode: original.fromCurrency,
          },
        },
        data: { balance: { increment: BigInt(-direction) * original.fromAmount } },
      });
    }

    const reversalReference = await nextReference('TXN', tx);

    const reversal = await tx.transaction.create({
      data: {
        reference: reversalReference,
        type: original.type,
        status: 'POSTED',
        channel: 'SYSTEM',
        branchId: original.branchId,
        customerId: original.customerId,
        // Swap the legs — this transaction is the mirror of the original.
        fromCurrency: original.toCurrency,
        fromAmount: original.toAmount,
        toCurrency: original.fromCurrency,
        toAmount: original.fromAmount,
        rate: original.rate,
        profitAmount: -original.profitAmount,
        feeCurrency: original.feeCurrency,
        feeAmount: -original.feeAmount,
        notes: `Reversal of ${original.reference}: ${reason}`,
        reversalOfId: original.id,
        businessDayId: original.businessDayId,
        valueDate: new Date(),
        postedAt: new Date(),
        createdById: actor.id,
      },
    });

    await tx.transaction.update({
      where: { id },
      data: { status: 'REVERSED', version: { increment: 1 } },
    });

    await audit.record(
      {
        action: 'REVERSE',
        module: 'exchange',
        entityType: 'Transaction',
        entityId: id,
        summaryEn: `Reversed ${original.reference} via ${reversalReference}: ${reason}`,
        summaryAr: `عكس العملية ${original.reference} بالعملية ${reversalReference}: ${reason}`,
        actor,
        metadata: { reason, reversalId: reversal.id },
      },
      tx,
    );

    return { reversalId: reversal.id, reference: reversalReference };
  }, db);

  emitAsync('transaction.reversed', {
    transactionId: id,
    reversalId: result.reversalId,
    actorId: actor.id,
  });

  return result;
}

export async function cancel(
  id: string,
  reason: string,
  actor: Actor,
  db: DbClient = prisma,
): Promise<void> {
  await withTransaction(async (tx) => {
    const transaction = await loadForUpdate(tx, id);

    if (transaction.status !== 'DRAFT') {
      throw errors.conflict(
        'Only a draft can be cancelled — a posted transaction is reversed instead',
        'errors.notCancellable',
      );
    }
    assertOwnership(transaction, actor);

    await tx.transaction.update({
      where: { id },
      data: { status: 'CANCELLED', cancelReason: reason, version: { increment: 1 } },
    });

    await audit.record(
      {
        action: 'CANCEL',
        module: 'exchange',
        entityType: 'Transaction',
        entityId: id,
        summaryEn: `Cancelled transaction ${transaction.reference}: ${reason}`,
        summaryAr: `إلغاء العملية ${transaction.reference}: ${reason}`,
        actor,
      },
      tx,
    );
  }, db);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface TransactionFilter {
  status?: TransactionStatus | TransactionStatus[];
  type?: TransactionType | TransactionType[];
  branchId?: string;
  customerId?: string;
  createdById?: string;
  currency?: string;
  from?: Date;
  to?: Date;
  minAmount?: bigint;
  maxAmount?: bigint;
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  order?: 'asc' | 'desc';
}

function buildWhere(filter: TransactionFilter, actor: Actor): Prisma.TransactionWhereInput {
  const where: Prisma.TransactionWhereInput = {};

  // Without `viewAll`, a user only ever sees their own work.
  if (!actor.permissions.includes('exchange.transaction.viewAll')) {
    where.createdById = actor.id;
  }
  if (filter.createdById) where.createdById = filter.createdById;

  if (filter.status) {
    where.status = Array.isArray(filter.status) ? { in: filter.status } : filter.status;
  }
  if (filter.type) {
    where.type = Array.isArray(filter.type) ? { in: filter.type } : filter.type;
  }
  if (filter.branchId) where.branchId = filter.branchId;
  if (filter.customerId) where.customerId = filter.customerId;
  if (filter.currency) {
    where.OR = [{ fromCurrency: filter.currency }, { toCurrency: filter.currency }];
  }
  if (filter.from || filter.to) {
    where.createdAt = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lte: filter.to } : {}),
    };
  }
  if (filter.minAmount !== undefined || filter.maxAmount !== undefined) {
    where.fromAmount = {
      ...(filter.minAmount !== undefined ? { gte: filter.minAmount } : {}),
      ...(filter.maxAmount !== undefined ? { lte: filter.maxAmount } : {}),
    };
  }
  if (filter.search) {
    where.AND = [
      {
        OR: [
          { reference: containsInsensitive(filter.search) },
          { counterpartyName: containsInsensitive(filter.search) },
          { counterpartyPhone: containsInsensitive(filter.search) },
          { notes: containsInsensitive(filter.search) },
          { customer: { fullNameEn: containsInsensitive(filter.search) } },
          { customer: { fullNameAr: containsInsensitive(filter.search) } },
          { customer: { code: containsInsensitive(filter.search) } },
        ],
      },
    ];
  }

  return where;
}

const SORTABLE = new Set(['createdAt', 'reference', 'fromAmount', 'status', 'type', 'valueDate']);

export async function list(filter: TransactionFilter, actor: Actor, db: DbClient = prisma) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 25));
  const where = buildWhere(filter, actor);

  const sortField = filter.sort && SORTABLE.has(filter.sort) ? filter.sort : 'createdAt';

  const [rows, total] = await Promise.all([
    db.transaction.findMany({
      where,
      orderBy: { [sortField]: filter.order ?? 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        customer: { select: { id: true, code: true, fullNameEn: true, fullNameAr: true } },
        createdBy: { select: { id: true, fullNameEn: true, fullNameAr: true } },
        branch: { select: { id: true, nameEn: true, nameAr: true } },
      },
    }),
    db.transaction.count({ where }),
  ]);

  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function getById(id: string, actor: Actor, db: DbClient = prisma) {
  const transaction = await db.transaction.findUnique({
    where: { id },
    include: {
      customer: true,
      createdBy: { select: { id: true, fullNameEn: true, fullNameAr: true, username: true } },
      branch: true,
      receipts: true,
      sourceAccount: { select: { id: true, code: true, nameEn: true, nameAr: true } },
      destinationAccount: { select: { id: true, code: true, nameEn: true, nameAr: true } },
      chainTransaction: true,
      reversalOf: { select: { id: true, reference: true } },
      reversedBy: { select: { id: true, reference: true } },
      journalEntries: {
        include: {
          lines: {
            include: { account: { select: { code: true, nameEn: true, nameAr: true, type: true } } },
            orderBy: { sequence: 'asc' },
          },
        },
      },
    },
  });

  if (!transaction) throw errors.notFound('Transaction', id);

  if (
    !actor.permissions.includes('exchange.transaction.viewAll') &&
    transaction.createdById !== actor.id
  ) {
    throw errors.forbidden('exchange.transaction.viewAll');
  }

  return transaction;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadForUpdate(tx: Tx, id: string) {
  const row = await tx.transaction.findUnique({ where: { id } });
  if (!row) throw errors.notFound('Transaction', id);
  return row;
}

/** A teller may only act on their own drafts; supervisors may act on any. */
function assertOwnership(transaction: { createdById: string }, actor: Actor): void {
  if (transaction.createdById === actor.id) return;
  if (actor.permissions.includes('exchange.transaction.viewAll')) return;
  throw errors.forbidden('exchange.transaction.viewAll');
}
