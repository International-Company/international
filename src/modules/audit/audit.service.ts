import 'server-only';
import type { Prisma } from '@prisma/client';
import { prisma, type DbClient } from '@/core/db/prisma';
import { canonicalize, sha256 } from '@/core/security/crypto';
import { createLogger } from '@/core/logger/logger';
import { containsInsensitive } from '@/core/db/search';

/**
 * The immutable audit trail.
 *
 * Every record stores the SHA-256 of the previous record, forming a chain:
 *
 *     hash(n) = SHA256( hash(n-1) || canonical(record n) )
 *
 * Editing or deleting any historical row changes its hash, which breaks every
 * subsequent link. `verifyChain()` detects exactly where. This gives the audit
 * log tamper-evidence even against an operator with direct database access —
 * which is the property auditors and regulators actually ask for.
 *
 * Nothing in this module updates or deletes; there is deliberately no such API.
 */

const log = createLogger('audit');

export const GENESIS_HASH = '0'.repeat(64);

export type AuditAction =
  | 'CREATE' | 'UPDATE' | 'DELETE'
  | 'LOGIN' | 'LOGOUT' | 'LOGIN_FAILED'
  | 'APPROVE' | 'REJECT' | 'POST' | 'REVERSE' | 'CANCEL'
  | 'PERMISSION_CHANGE' | 'ROLE_CHANGE' | 'PASSWORD_CHANGE' | 'PASSWORD_RESET'
  | 'RATE_CHANGE' | 'WALLET_CHANGE' | 'SETTING_CHANGE'
  | 'BACKUP' | 'RESTORE' | 'EXPORT' | 'PRINT' | 'SYNC'
  | 'DAY_OPEN' | 'DAY_CLOSE' | 'DAY_REOPEN'
  | 'SECURITY';

export interface AuditActor {
  id?: string | null;
  name?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string | null;
}

export interface AuditInput {
  action: AuditAction;
  module: string;
  entityType?: string | null;
  entityId?: string | null;
  summaryEn: string;
  summaryAr: string;
  actor?: AuditActor;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Serialises appends within this process. Two concurrent writers could
 * otherwise read the same `prevHash` and fork the chain. The database
 * transaction protects the rows; this protects the ordering.
 */
let appendQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = appendQueue.then(fn, fn);
  appendQueue = result.catch(() => undefined);
  return result;
}

/** The exact field set that participates in the hash. Order is irrelevant —
 *  `canonicalize` sorts keys — but membership is part of the contract. */
function hashableRecord(input: {
  at: Date;
  actorId: string | null;
  actorName: string | null;
  actorIp: string | null;
  action: string;
  module: string;
  entityType: string | null;
  entityId: string | null;
  summaryEn: string;
  summaryAr: string;
  beforeData: string | null;
  afterData: string | null;
  metadata: string | null;
}) {
  return {
    at: input.at.toISOString(),
    actorId: input.actorId,
    actorName: input.actorName,
    actorIp: input.actorIp,
    action: input.action,
    module: input.module,
    entityType: input.entityType,
    entityId: input.entityId,
    summaryEn: input.summaryEn,
    summaryAr: input.summaryAr,
    beforeData: input.beforeData,
    afterData: input.afterData,
    metadata: input.metadata,
  };
}

export function computeHash(prevHash: string, record: ReturnType<typeof hashableRecord>): string {
  return sha256(`${prevHash}${canonicalize(record)}`);
}

function serialize(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return canonicalize(value);
}

/**
 * Appends one record. Never throws into the caller's path: an audit failure
 * must not roll back a completed financial operation, but it must be loud.
 */
export async function record(input: AuditInput, db: DbClient = prisma): Promise<void> {
  try {
    await enqueue(async () => {
      const at = new Date();
      const actor = input.actor ?? {};

      const base = {
        at,
        actorId: actor.id ?? null,
        actorName: actor.name ?? null,
        actorIp: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        sessionId: actor.sessionId ?? null,
        action: input.action,
        module: input.module,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        summaryEn: input.summaryEn,
        summaryAr: input.summaryAr,
        beforeData: serialize(input.before),
        afterData: serialize(input.after),
        metadata: serialize(input.metadata),
      };

      const previous = await db.auditLog.findFirst({
        orderBy: { id: 'desc' },
        select: { hash: true },
      });
      const prevHash = previous?.hash ?? GENESIS_HASH;
      const hash = computeHash(prevHash, hashableRecord(base));

      await db.auditLog.create({ data: { ...base, prevHash, hash } });
    });
  } catch (error) {
    log.error('Failed to append audit record', {
      action: input.action,
      module: input.module,
      entityId: input.entityId,
      error,
    });
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface ChainVerificationResult {
  valid: boolean;
  checked: number;
  firstBrokenId: number | null;
  /** Human-readable reason for the first break found. */
  reason: string | null;
  verifiedAt: Date;
  durationMs: number;
}

/**
 * Recomputes the whole chain in batches. Returns the first divergence rather
 * than a list — once a link is broken every later hash is meaningless.
 */
export async function verifyChain(
  options: { batchSize?: number; db?: DbClient } = {},
): Promise<ChainVerificationResult> {
  const { batchSize = 500, db = prisma } = options;
  const startedAt = Date.now();

  let cursor = 0;
  let checked = 0;
  let expectedPrev = GENESIS_HASH;

  for (;;) {
    const batch = await db.auditLog.findMany({
      where: { id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    if (batch.length === 0) break;

    for (const row of batch) {
      checked++;

      if (row.prevHash !== expectedPrev) {
        return {
          valid: false,
          checked,
          firstBrokenId: row.id,
          reason: `Record ${row.id} points at ${row.prevHash.slice(0, 12)}… but the previous record hashes to ${expectedPrev.slice(0, 12)}… — a record was inserted, removed or reordered.`,
          verifiedAt: new Date(),
          durationMs: Date.now() - startedAt,
        };
      }

      const recomputed = computeHash(row.prevHash, hashableRecord(row));
      if (recomputed !== row.hash) {
        return {
          valid: false,
          checked,
          firstBrokenId: row.id,
          reason: `Record ${row.id} has been modified after it was written — its stored hash does not match its contents.`,
          verifiedAt: new Date(),
          durationMs: Date.now() - startedAt,
        };
      }

      expectedPrev = row.hash;
      cursor = row.id;
    }
  }

  return {
    valid: true,
    checked,
    firstBrokenId: null,
    reason: null,
    verifiedAt: new Date(),
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------------

export interface AuditQuery {
  actorId?: string;
  module?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function query(input: AuditQuery, db: DbClient = prisma) {
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50));

  const where: Prisma.AuditLogWhereInput = {};
  if (input.actorId) where.actorId = input.actorId;
  if (input.module) where.module = input.module;
  if (input.action) where.action = input.action;
  if (input.entityType) where.entityType = input.entityType;
  if (input.entityId) where.entityId = input.entityId;
  if (input.from || input.to) {
    where.at = {};
    if (input.from) where.at.gte = input.from;
    if (input.to) where.at.lte = input.to;
  }
  if (input.search) {
    where.OR = [
      { summaryEn: containsInsensitive(input.search) },
      { summaryAr: containsInsensitive(input.search) },
      { actorName: containsInsensitive(input.search) },
      { entityId: containsInsensitive(input.search) },
    ];
  }

  const [rows, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: { id: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.auditLog.count({ where }),
  ]);

  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Full history for one entity, oldest first — drives the "activity" timeline. */
export async function historyFor(entityType: string, entityId: string, db: DbClient = prisma) {
  return db.auditLog.findMany({
    where: { entityType, entityId },
    orderBy: { id: 'asc' },
  });
}

// ---------------------------------------------------------------------------
// Diffing — keeps stored snapshots small and reviews readable
// ---------------------------------------------------------------------------

/**
 * Reduces a before/after pair to only the fields that actually changed.
 * Storing whole rows would bloat the log and bury the change an auditor
 * is looking for.
 */
export function diff<T extends Record<string, unknown>>(
  before: T | null | undefined,
  after: T | null | undefined,
  options: { ignore?: string[] } = {},
): { before: Record<string, unknown>; after: Record<string, unknown>; changed: string[] } {
  const ignore = new Set(options.ignore ?? ['updatedAt', 'createdAt', 'version']);
  const beforeOut: Record<string, unknown> = {};
  const afterOut: Record<string, unknown> = {};
  const changed: string[] = [];

  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    if (ignore.has(key)) continue;
    const a = before?.[key];
    const b = after?.[key];
    if (canonicalize(a) === canonicalize(b)) continue;

    changed.push(key);
    beforeOut[key] = a === undefined ? null : a;
    afterOut[key] = b === undefined ? null : b;
  }

  return { before: beforeOut, after: afterOut, changed };
}
