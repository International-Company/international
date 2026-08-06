import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { prisma } from '@/core/db/prisma';
import * as queue from '@/core/jobs/queue';
import { registeredJobs } from '@/core/jobs/worker';
import { toJsonSafe } from '@/core/http/json';
import { PageHeader } from '@/ui/primitives';
import { SystemView } from './system-view';

export const metadata: Metadata = { title: 'System monitor' };
export const dynamic = 'force-dynamic';

export default async function SystemPage() {
  const session = await requirePermission('system.monitor');
  const { t } = await getTranslator();

  const [stats, jobs, tasks, counts] = await Promise.all([
    queue.stats(),
    prisma.job.findMany({
      where: { status: { in: ['PENDING', 'RUNNING', 'FAILED'] } },
      orderBy: [{ status: 'asc' }, { runAt: 'asc' }],
      take: 50,
    }),
    prisma.scheduledTask.findMany({ orderBy: { nextRunAt: 'asc' } }),
    Promise.all([
      prisma.transaction.count(),
      prisma.customer.count(),
      prisma.auditLog.count(),
      prisma.user.count({ where: { status: 'ACTIVE' } }),
      prisma.session.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
    ]),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title={t('system.title')} description={t('system.subtitle')} />

      <SystemView
        stats={stats}
        jobs={toJsonSafe(jobs)}
        tasks={toJsonSafe(tasks)}
        registeredJobs={registeredJobs()}
        counts={{
          transactions: counts[0],
          customers: counts[1],
          auditRecords: counts[2],
          activeUsers: counts[3],
          activeSessions: counts[4],
        }}
        runtime={{
          uptimeSeconds: Math.round(process.uptime()),
          nodeVersion: process.version,
          memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        }}
        canManage={session.user.permissions.includes('system.jobs.manage')}
      />
    </div>
  );
}
