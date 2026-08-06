import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { createLogger } from '@/core/logger/logger';

/**
 * Durable job queue backed by the database.
 *
 * Jobs survive a restart, which matters: a wallet synchronisation or nightly
 * backup that vanishes because the process was recycled is worse than one that
 * never ran, because nobody notices. Failed jobs retry with exponential backoff
 * and land in a terminal FAILED state that the system monitor surfaces.
 */

const log = createLogger('jobs:queue');

export interface EnqueueOptions {
  queue?: string;
  payload?: Record<string, unknown>;
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
  /** Prevents duplicates: an identical pending job is not enqueued twice. */
  uniqueKey?: string;
}

export async function enqueue(
  name: string,
  options: EnqueueOptions = {},
  db: DbClient = prisma,
): Promise<string | null> {
  if (options.uniqueKey) {
    const existing = await db.job.findFirst({
      where: { uniqueKey: options.uniqueKey, status: { in: ['PENDING', 'RUNNING'] } },
      select: { id: true },
    });
    if (existing) {
      log.debug('Skipped duplicate job', { name, uniqueKey: options.uniqueKey });
      return null;
    }
  }

  const job = await db.job.create({
    data: {
      name,
      queue: options.queue ?? 'default',
      payload: options.payload ? JSON.stringify(options.payload) : null,
      runAt: options.runAt ?? new Date(),
      priority: options.priority ?? 100,
      maxAttempts: options.maxAttempts ?? 3,
      uniqueKey: options.uniqueKey ?? null,
    },
  });

  return job.id;
}

export interface ClaimedJob {
  id: string;
  name: string;
  queue: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/**
 * Claims the next due job.
 *
 * The status transition is guarded by `updateMany ... where status = 'PENDING'`,
 * so if two workers race, exactly one gets a non-zero count and the loser moves
 * on to the next candidate.
 */
export async function claimNext(queue?: string, db: DbClient = prisma): Promise<ClaimedJob | null> {
  const candidates = await db.job.findMany({
    where: {
      status: 'PENDING',
      runAt: { lte: new Date() },
      ...(queue ? { queue } : {}),
    },
    orderBy: [{ priority: 'asc' }, { runAt: 'asc' }],
    take: 5,
  });

  for (const candidate of candidates) {
    const claimed = await db.job.updateMany({
      where: { id: candidate.id, status: 'PENDING' },
      data: { status: 'RUNNING', startedAt: new Date(), attempts: { increment: 1 } },
    });

    if (claimed.count === 1) {
      return {
        id: candidate.id,
        name: candidate.name,
        queue: candidate.queue,
        payload: candidate.payload ? (JSON.parse(candidate.payload) as Record<string, unknown>) : {},
        attempts: candidate.attempts + 1,
        maxAttempts: candidate.maxAttempts,
      };
    }
  }

  return null;
}

export async function complete(
  jobId: string,
  result?: unknown,
  db: DbClient = prisma,
): Promise<void> {
  await db.job.update({
    where: { id: jobId },
    data: {
      status: 'COMPLETED',
      finishedAt: new Date(),
      lastError: null,
      result: result === undefined ? null : JSON.stringify(result).slice(0, 4000),
    },
  });
}

/** Exponential backoff: 30s, 2m, 8m, 32m … capped at one hour. */
function backoffMs(attempts: number): number {
  return Math.min(3_600_000, 30_000 * 4 ** (attempts - 1));
}

export async function fail(
  job: ClaimedJob,
  error: unknown,
  db: DbClient = prisma,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts;

  await db.job.update({
    where: { id: job.id },
    data: exhausted
      ? { status: 'FAILED', finishedAt: new Date(), lastError: message.slice(0, 2000) }
      : {
          status: 'PENDING',
          runAt: new Date(Date.now() + backoffMs(job.attempts)),
          lastError: message.slice(0, 2000),
        },
  });

  log[exhausted ? 'error' : 'warn'](exhausted ? 'Job failed permanently' : 'Job failed, will retry', {
    job: job.name,
    jobId: job.id,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    error: message,
  });
}

export async function retry(jobId: string, db: DbClient = prisma): Promise<void> {
  await db.job.update({
    where: { id: jobId },
    data: { status: 'PENDING', runAt: new Date(), attempts: 0, lastError: null, finishedAt: null },
  });
}

export async function cancel(jobId: string, db: DbClient = prisma): Promise<void> {
  await db.job.updateMany({
    where: { id: jobId, status: { in: ['PENDING', 'RUNNING'] } },
    data: { status: 'CANCELLED', finishedAt: new Date() },
  });
}

/** Reclaims jobs abandoned by a process that died mid-run. */
export async function requeueStale(olderThanMinutes = 15, db: DbClient = prisma): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const result = await db.job.updateMany({
    where: { status: 'RUNNING', startedAt: { lt: cutoff } },
    data: { status: 'PENDING', lastError: 'Reclaimed after worker timeout' },
  });
  if (result.count > 0) log.warn('Requeued stale jobs', { count: result.count });
  return result.count;
}

export async function stats(db: DbClient = prisma) {
  const grouped = await db.job.groupBy({ by: ['status'], _count: { _all: true } });
  const counts: Record<string, number> = {
    PENDING: 0,
    RUNNING: 0,
    COMPLETED: 0,
    FAILED: 0,
    CANCELLED: 0,
  };
  for (const row of grouped) counts[row.status] = row._count._all;

  const oldestPending = await db.job.findFirst({
    where: { status: 'PENDING', runAt: { lte: new Date() } },
    orderBy: { runAt: 'asc' },
    select: { runAt: true },
  });

  return {
    counts,
    backlogSeconds: oldestPending
      ? Math.max(0, Math.round((Date.now() - oldestPending.runAt.getTime()) / 1000))
      : 0,
  };
}

/** Housekeeping — completed jobs are noise after a few days. */
export async function purgeCompleted(olderThanDays = 7, db: DbClient = prisma): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const result = await db.job.deleteMany({
    where: { status: { in: ['COMPLETED', 'CANCELLED'] }, finishedAt: { lt: cutoff } },
  });
  return result.count;
}
