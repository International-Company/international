import { z } from 'zod';
import { route } from '@/core/http/route';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import * as queue from '@/core/jobs/queue';
import { registeredJobs, runWorkerTick } from '@/core/jobs/worker';
import { registeredHandlers } from '@/core/events/bus';
import { reconcile } from '@/modules/ledger/ledger.service';
import { verifyChain } from '@/modules/audit/audit.service';

/**
 * System health.
 *
 * Reports the three things that determine whether this deployment is actually
 * trustworthy right now: is the queue keeping up, does the ledger still balance,
 * and is the audit chain intact.
 */
export const GET = route({
  permissions: ['system.monitor'],
  handler: async () => {
    const [jobStats, jobs, tasks, lastBackup, counts] = await Promise.all([
      queue.stats(),
      prisma.job.findMany({
        where: { status: { in: ['PENDING', 'RUNNING', 'FAILED'] } },
        orderBy: [{ status: 'asc' }, { runAt: 'asc' }],
        take: 50,
      }),
      prisma.scheduledTask.findMany({ orderBy: { nextRunAt: 'asc' } }),
      prisma.backup.findFirst({
        where: { status: { in: ['COMPLETED', 'VERIFIED'] } },
        orderBy: { startedAt: 'desc' },
        select: { id: true, filename: true, startedAt: true, sizeBytes: true, status: true },
      }),
      Promise.all([
        prisma.transaction.count(),
        prisma.customer.count(),
        prisma.auditLog.count(),
        prisma.user.count({ where: { status: 'ACTIVE' } }),
        prisma.session.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
      ]),
    ]);

    const [transactionCount, customerCount, auditCount, activeUsers, activeSessions] = counts;

    return {
      queue: jobStats,
      jobs,
      tasks,
      registeredJobs: registeredJobs(),
      eventHandlers: registeredHandlers(),
      lastBackup,
      counts: { transactionCount, customerCount, auditCount, activeUsers, activeSessions },
      runtime: {
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
    };
  },
});

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('retryJob'), jobId: z.string() }),
  z.object({ action: z.literal('cancelJob'), jobId: z.string() }),
  z.object({ action: z.literal('runTask'), taskKey: z.string() }),
  z.object({ action: z.literal('tick') }),
  z.object({ action: z.literal('reconcile') }),
  z.object({ action: z.literal('verifyAudit') }),
]);

export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['system.monitor'],
  bodySchema,
  handler: async ({ body, actor }) => {
    const requireManage = () => {
      if (!actor.permissions.includes('system.jobs.manage')) {
        throw errors.forbidden('system.jobs.manage');
      }
    };

    switch (body.action) {
      case 'retryJob':
        requireManage();
        await queue.retry(body.jobId);
        return { ok: true };

      case 'cancelJob':
        requireManage();
        await queue.cancel(body.jobId);
        return { ok: true };

      case 'runTask': {
        requireManage();
        const task = await prisma.scheduledTask.findUnique({ where: { key: body.taskKey } });
        if (!task) throw errors.notFound('Scheduled task', body.taskKey);

        const jobId = await queue.enqueue(task.jobName, {
          payload: task.payload ? (JSON.parse(task.payload) as Record<string, unknown>) : {},
          queue: 'manual',
          priority: 1,
        });
        // Run it now rather than waiting for the next tick.
        await runWorkerTick();
        return { jobId };
      }

      case 'tick':
        requireManage();
        await runWorkerTick();
        return { ok: true };

      case 'reconcile': {
        const issues = await reconcile();
        return { issues, valid: issues.length === 0 };
      }

      case 'verifyAudit':
        return verifyChain();
    }
  },
});
