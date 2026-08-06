import 'server-only';
import { prisma } from '@/core/db/prisma';
import { env } from '@/core/config/env';
import { createLogger } from '@/core/logger/logger';
import * as queue from './queue';

/**
 * In-process background worker and scheduler.
 *
 * A currency exchange office runs this system on one server; an external broker
 * (Redis, SQS) would be operational overhead nobody there is staffed to run.
 * The worker is deliberately contained behind this interface so a distributed
 * runner can replace it without touching a single job handler.
 */

const log = createLogger('jobs:worker');

export type JobHandler = (payload: Record<string, unknown>) => Promise<unknown>;

const globalForWorker = globalThis as unknown as {
  __ifmsJobHandlers?: Map<string, JobHandler>;
  __ifmsWorkerTimer?: NodeJS.Timeout;
  __ifmsWorkerRunning?: boolean;
};

const handlers: Map<string, JobHandler> =
  globalForWorker.__ifmsJobHandlers ?? new Map<string, JobHandler>();
globalForWorker.__ifmsJobHandlers = handlers;

export function registerJob(name: string, handler: JobHandler): void {
  handlers.set(name, handler);
}

export function registeredJobs(): string[] {
  return [...handlers.keys()].sort();
}

/** Drains the queue until it is empty or the budget is spent. */
export async function drain(maxJobs = 25): Promise<number> {
  let processed = 0;

  for (let i = 0; i < maxJobs; i++) {
    const job = await queue.claimNext();
    if (!job) break;

    const handler = handlers.get(job.name);
    if (!handler) {
      await queue.fail(job, new Error(`No handler registered for job "${job.name}"`));
      continue;
    }

    const startedAt = Date.now();
    try {
      const result = await handler(job.payload);
      await queue.complete(job.id, result);
      log.debug('Job completed', { job: job.name, ms: Date.now() - startedAt });
    } catch (error) {
      await queue.fail(job, error);
    }
    processed++;
  }

  return processed;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/** Promotes every due `ScheduledTask` into the job queue. */
export async function scheduleDueTasks(): Promise<number> {
  const now = new Date();
  const due = await prisma.scheduledTask.findMany({
    where: { isEnabled: true, nextRunAt: { lte: now } },
  });

  let scheduled = 0;
  for (const task of due) {
    const jobId = await queue.enqueue(task.jobName, {
      payload: task.payload ? (JSON.parse(task.payload) as Record<string, unknown>) : {},
      queue: 'scheduled',
      uniqueKey: `scheduled:${task.key}`,
    });

    await prisma.scheduledTask.update({
      where: { id: task.id },
      data: {
        lastRunAt: now,
        nextRunAt: new Date(now.getTime() + task.intervalSeconds * 1000),
        runCount: { increment: 1 },
      },
    });

    if (jobId) scheduled++;
  }

  return scheduled;
}

async function tick(): Promise<void> {
  if (globalForWorker.__ifmsWorkerRunning) return; // never overlap ticks
  globalForWorker.__ifmsWorkerRunning = true;

  try {
    await queue.requeueStale();
    await scheduleDueTasks();
    await drain();
  } catch (error) {
    log.error('Worker tick failed', { error });
  } finally {
    globalForWorker.__ifmsWorkerRunning = false;
  }
}

export function startWorker(): void {
  if (!env.JOBS_ENABLED) {
    log.info('Background worker disabled by configuration');
    return;
  }
  if (globalForWorker.__ifmsWorkerTimer) return;

  log.info('Background worker started', {
    intervalSeconds: env.JOBS_TICK_SECONDS,
    handlers: registeredJobs().length,
  });

  const timer = setInterval(() => void tick(), env.JOBS_TICK_SECONDS * 1000);
  // Do not hold the process open purely for the scheduler.
  timer.unref?.();
  globalForWorker.__ifmsWorkerTimer = timer;

  // Run once shortly after boot so a restart picks up work immediately.
  setTimeout(() => void tick(), 5_000).unref?.();
}

export function stopWorker(): void {
  if (globalForWorker.__ifmsWorkerTimer) {
    clearInterval(globalForWorker.__ifmsWorkerTimer);
    globalForWorker.__ifmsWorkerTimer = undefined;
  }
}

export { tick as runWorkerTick };
