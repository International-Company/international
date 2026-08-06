import 'server-only';
import type { Prisma } from '@prisma/client';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import * as audit from '@/modules/audit/audit.service';
import { nextReference } from '@/modules/ledger/reference';
import { containsInsensitive } from '@/core/db/search';

/**
 * Customer master data and KYC state.
 *
 * Names are held in both scripts because the same person is "Mohammed Al-Sayed"
 * on a passport and "محمد السيد" on an identity card, and a teller searching in
 * either script must find them. Both fields are indexed and searched together.
 */

export interface Actor {
  id: string;
  name: string;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string;
  permissions: string[];
}

export type CustomerType = 'INDIVIDUAL' | 'COMPANY';
export type KycStatus = 'NONE' | 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface CustomerInput {
  type?: CustomerType;
  fullNameEn: string;
  fullNameAr: string;
  phone?: string | null;
  altPhone?: string | null;
  email?: string | null;
  nationalId?: string | null;
  passportNo?: string | null;
  taxNumber?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string;
  notes?: string | null;
  branchId?: string | null;
  creditLimit?: bigint;
  creditCurrency?: string | null;
  tags?: string[];
}

export async function createCustomer(
  input: CustomerInput,
  actor: Actor,
  db: DbClient = prisma,
) {
  return withTransaction(async (tx) => {
    // A national id or passport identifies a person; two records for the same
    // person split their transaction history and defeat KYC entirely.
    if (input.nationalId) {
      const existing = await tx.customer.findFirst({ where: { nationalId: input.nationalId } });
      if (existing) {
        throw errors.conflict(
          `Customer ${existing.code} already holds this national ID`,
          'errors.duplicateNationalId',
        );
      }
    }
    if (input.passportNo) {
      const existing = await tx.customer.findFirst({ where: { passportNo: input.passportNo } });
      if (existing) {
        throw errors.conflict(
          `Customer ${existing.code} already holds this passport number`,
          'errors.duplicatePassport',
        );
      }
    }

    const code = await nextReference('CUS', tx, { daily: false, padding: 6 });

    const customer = await tx.customer.create({
      data: {
        code,
        type: input.type ?? 'INDIVIDUAL',
        fullNameEn: input.fullNameEn.trim(),
        fullNameAr: input.fullNameAr.trim(),
        phone: input.phone ?? null,
        altPhone: input.altPhone ?? null,
        email: input.email ?? null,
        nationalId: input.nationalId ?? null,
        passportNo: input.passportNo ?? null,
        taxNumber: input.taxNumber ?? null,
        address: input.address ?? null,
        city: input.city ?? null,
        country: input.country ?? 'PS',
        notes: input.notes ?? null,
        branchId: input.branchId ?? null,
        creditLimit: input.creditLimit ?? 0n,
        creditCurrency: input.creditCurrency ?? null,
        tags: input.tags ? JSON.stringify(input.tags) : null,
        createdById: actor.id,
      },
    });

    await audit.record(
      {
        action: 'CREATE',
        module: 'customers',
        entityType: 'Customer',
        entityId: customer.id,
        summaryEn: `Created customer ${code} — ${input.fullNameEn}`,
        summaryAr: `إضافة عميل ${code} — ${input.fullNameAr}`,
        actor,
        after: { code, fullNameEn: input.fullNameEn, fullNameAr: input.fullNameAr, phone: input.phone },
      },
      tx,
    );

    return customer;
  }, db);
}

export async function updateCustomer(
  id: string,
  input: Partial<CustomerInput>,
  actor: Actor,
  db: DbClient = prisma,
) {
  return withTransaction(async (tx) => {
    const existing = await tx.customer.findUnique({ where: { id } });
    if (!existing) throw errors.notFound('Customer', id);

    const updated = await tx.customer.update({
      where: { id },
      data: {
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.fullNameEn !== undefined ? { fullNameEn: input.fullNameEn.trim() } : {}),
        ...(input.fullNameAr !== undefined ? { fullNameAr: input.fullNameAr.trim() } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.altPhone !== undefined ? { altPhone: input.altPhone } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.nationalId !== undefined ? { nationalId: input.nationalId } : {}),
        ...(input.passportNo !== undefined ? { passportNo: input.passportNo } : {}),
        ...(input.taxNumber !== undefined ? { taxNumber: input.taxNumber } : {}),
        ...(input.address !== undefined ? { address: input.address } : {}),
        ...(input.city !== undefined ? { city: input.city } : {}),
        ...(input.country !== undefined ? { country: input.country } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.creditLimit !== undefined ? { creditLimit: input.creditLimit } : {}),
        ...(input.creditCurrency !== undefined ? { creditCurrency: input.creditCurrency } : {}),
        ...(input.tags !== undefined ? { tags: JSON.stringify(input.tags) } : {}),
      },
    });

    const changes = audit.diff(
      existing as unknown as Record<string, unknown>,
      updated as unknown as Record<string, unknown>,
    );

    await audit.record(
      {
        action: 'UPDATE',
        module: 'customers',
        entityType: 'Customer',
        entityId: id,
        summaryEn: `Updated customer ${existing.code} (${changes.changed.join(', ') || 'no changes'})`,
        summaryAr: `تعديل العميل ${existing.code} (${changes.changed.join('، ') || 'بدون تغييرات'})`,
        actor,
        before: changes.before,
        after: changes.after,
      },
      tx,
    );

    return updated;
  }, db);
}

export async function setKyc(
  id: string,
  input: { status: KycStatus; riskLevel?: RiskLevel; note?: string },
  actor: Actor,
  db: DbClient = prisma,
): Promise<void> {
  await withTransaction(async (tx) => {
    const customer = await tx.customer.findUnique({ where: { id } });
    if (!customer) throw errors.notFound('Customer', id);

    await tx.customer.update({
      where: { id },
      data: {
        kycStatus: input.status,
        kycVerifiedAt: input.status === 'VERIFIED' ? new Date() : null,
        ...(input.riskLevel ? { riskLevel: input.riskLevel } : {}),
      },
    });

    await audit.record(
      {
        action: 'UPDATE',
        module: 'customers',
        entityType: 'Customer',
        entityId: id,
        summaryEn: `KYC for ${customer.code} set to ${input.status}${input.riskLevel ? `, risk ${input.riskLevel}` : ''}`,
        summaryAr: `تحديث حالة اعرف عميلك للعميل ${customer.code} إلى ${input.status}${input.riskLevel ? `، المخاطر ${input.riskLevel}` : ''}`,
        actor,
        before: { kycStatus: customer.kycStatus, riskLevel: customer.riskLevel },
        after: { kycStatus: input.status, riskLevel: input.riskLevel ?? customer.riskLevel },
        metadata: input.note ? { note: input.note } : undefined,
      },
      tx,
    );
  }, db);
}

export async function setBlocked(
  id: string,
  blocked: boolean,
  reason: string,
  actor: Actor,
  db: DbClient = prisma,
): Promise<void> {
  await withTransaction(async (tx) => {
    const customer = await tx.customer.findUnique({ where: { id } });
    if (!customer) throw errors.notFound('Customer', id);

    if (blocked && !reason.trim()) {
      throw errors.validation([{ path: 'reason', message: 'A reason is required to block' }]);
    }

    await tx.customer.update({
      where: { id },
      data: { isBlocked: blocked, blockReason: blocked ? reason : null },
    });

    await audit.record(
      {
        action: 'UPDATE',
        module: 'customers',
        entityType: 'Customer',
        entityId: id,
        summaryEn: blocked
          ? `Blocked customer ${customer.code}: ${reason}`
          : `Unblocked customer ${customer.code}`,
        summaryAr: blocked
          ? `حظر العميل ${customer.code}: ${reason}`
          : `رفع الحظر عن العميل ${customer.code}`,
        actor,
        before: { isBlocked: customer.isBlocked },
        after: { isBlocked: blocked, reason },
      },
      tx,
    );
  }, db);
}

export async function deleteCustomer(id: string, actor: Actor, db: DbClient = prisma): Promise<void> {
  await withTransaction(async (tx) => {
    const customer = await tx.customer.findUnique({
      where: { id },
      include: { _count: { select: { transactions: true } } },
    });
    if (!customer) throw errors.notFound('Customer', id);

    // Deleting a customer with history would orphan financial records. Blocking
    // is the correct action for a customer who must stop trading.
    if (customer._count.transactions > 0) {
      throw errors.conflict(
        `Customer ${customer.code} has ${customer._count.transactions} transaction(s) and cannot be deleted — block them instead`,
        'errors.customerHasTransactions',
      );
    }

    await tx.customer.delete({ where: { id } });

    await audit.record(
      {
        action: 'DELETE',
        module: 'customers',
        entityType: 'Customer',
        entityId: id,
        summaryEn: `Deleted customer ${customer.code} — ${customer.fullNameEn}`,
        summaryAr: `حذف العميل ${customer.code} — ${customer.fullNameAr}`,
        actor,
        before: { code: customer.code, fullNameEn: customer.fullNameEn },
      },
      tx,
    );
  }, db);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface CustomerFilter {
  search?: string;
  type?: CustomerType;
  kycStatus?: KycStatus;
  riskLevel?: RiskLevel;
  blocked?: boolean;
  branchId?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  order?: 'asc' | 'desc';
}

const SORTABLE = new Set(['createdAt', 'code', 'fullNameEn', 'fullNameAr', 'kycStatus']);

export async function listCustomers(filter: CustomerFilter, db: DbClient = prisma) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 25));

  const where: Prisma.CustomerWhereInput = {
    ...(filter.type ? { type: filter.type } : {}),
    ...(filter.kycStatus ? { kycStatus: filter.kycStatus } : {}),
    ...(filter.riskLevel ? { riskLevel: filter.riskLevel } : {}),
    ...(filter.blocked !== undefined ? { isBlocked: filter.blocked } : {}),
    ...(filter.branchId ? { branchId: filter.branchId } : {}),
    ...(filter.search
      ? {
          OR: [
            { code: containsInsensitive(filter.search) },
            { fullNameEn: containsInsensitive(filter.search) },
            { fullNameAr: containsInsensitive(filter.search) },
            { phone: containsInsensitive(filter.search) },
            { altPhone: containsInsensitive(filter.search) },
            { email: containsInsensitive(filter.search) },
            { nationalId: containsInsensitive(filter.search) },
            { passportNo: containsInsensitive(filter.search) },
          ],
        }
      : {}),
  };

  const sortField = filter.sort && SORTABLE.has(filter.sort) ? filter.sort : 'createdAt';

  const [rows, total] = await Promise.all([
    db.customer.findMany({
      where,
      orderBy: { [sortField]: filter.order ?? 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        balances: true,
        _count: { select: { transactions: true } },
      },
    }),
    db.customer.count({ where }),
  ]);

  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function getCustomer(id: string, db: DbClient = prisma) {
  const customer = await db.customer.findUnique({
    where: { id },
    include: {
      balances: { include: { currency: true } },
      documents: { orderBy: { createdAt: 'desc' } },
      branch: { select: { nameEn: true, nameAr: true } },
      transactions: {
        orderBy: { createdAt: 'desc' },
        take: 25,
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
      },
      _count: { select: { transactions: true } },
    },
  });

  if (!customer) throw errors.notFound('Customer', id);
  return customer;
}

/** Type-ahead for the transaction form — deliberately small and fast. */
export async function quickSearch(term: string, db: DbClient = prisma, limit = 10) {
  if (term.trim().length < 2) return [];

  return db.customer.findMany({
    where: {
      isBlocked: false,
      OR: [
        { code: containsInsensitive(term) },
        { fullNameEn: containsInsensitive(term) },
        { fullNameAr: containsInsensitive(term) },
        { phone: containsInsensitive(term) },
        { nationalId: containsInsensitive(term) },
      ],
    },
    take: limit,
    orderBy: { fullNameEn: 'asc' },
    select: {
      id: true,
      code: true,
      fullNameEn: true,
      fullNameAr: true,
      phone: true,
      kycStatus: true,
      riskLevel: true,
    },
  });
}

export async function addDocument(
  customerId: string,
  input: {
    type: string;
    number: string;
    issuedAt?: Date | null;
    expiresAt?: Date | null;
    issuer?: string | null;
    notes?: string | null;
  },
  actor: Actor,
  db: DbClient = prisma,
) {
  const customer = await db.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw errors.notFound('Customer', customerId);

  const document = await db.customerDocument.create({
    data: {
      customerId,
      type: input.type,
      number: input.number,
      issuedAt: input.issuedAt ?? null,
      expiresAt: input.expiresAt ?? null,
      issuer: input.issuer ?? null,
      notes: input.notes ?? null,
    },
  });

  await audit.record(
    {
      action: 'CREATE',
      module: 'customers',
      entityType: 'CustomerDocument',
      entityId: document.id,
      summaryEn: `Added ${input.type} document for customer ${customer.code}`,
      summaryAr: `إضافة وثيقة ${input.type} للعميل ${customer.code}`,
      actor,
    },
    db,
  );

  return document;
}

/** Customers whose identity documents expire soon — a compliance queue. */
export async function expiringDocuments(withinDays = 30, db: DbClient = prisma) {
  const cutoff = new Date(Date.now() + withinDays * 86_400_000);
  return db.customerDocument.findMany({
    where: { expiresAt: { not: null, lte: cutoff } },
    orderBy: { expiresAt: 'asc' },
    take: 100,
    include: {
      customer: { select: { id: true, code: true, fullNameEn: true, fullNameAr: true } },
    },
  });
}
