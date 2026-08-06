'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Play, RefreshCw, ShieldCheck, Scale, XCircle } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { formatDuration } from '@/i18n/format';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, StatTile } from '@/ui/primitives';
import { useToast } from '@/ui/overlay';
import { DateText, Num, StatusBadge } from '@/ui/display';

interface JobRow {
  id: string;
  name: string;
  queue: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lastError: string | null;
}

interface TaskRow {
  id: string;
  key: string;
  nameEn: string;
  nameAr: string;
  jobName: string;
  intervalSeconds: number;
  isEnabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  lastStatus: string | null;
  runCount: number;
}

interface IntegrityResult {
  kind: 'ledger' | 'audit';
  ok: boolean;
  detail: string;
}

export function SystemView({
  stats,
  jobs,
  tasks,
  registeredJobs,
  counts,
  runtime,
  canManage,
}: {
  stats: { counts: Record<string, number>; backlogSeconds: number };
  jobs: JobRow[];
  tasks: TaskRow[];
  registeredJobs: string[];
  counts: {
    transactions: number;
    customers: number;
    auditRecords: number;
    activeUsers: number;
    activeSessions: number;
  };
  runtime: { uptimeSeconds: number; nodeVersion: string; memoryMb: number };
  canManage: boolean;
}) {
  const { t, locale, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [busy, setBusy] = useState<string | null>(null);
  const [integrity, setIntegrity] = useState<IntegrityResult | null>(null);

  const post = async (body: Record<string, unknown>, key: string) => {
    setBusy(key);
    try {
      return await api.post<Record<string, unknown>>('/api/admin/system', body);
    } catch (error) {
      toast.error(
        t('errors.title'),
        error instanceof ApiError
          ? t(error.messageKey as never, error.params) || error.message
          : t('errors.generic'),
      );
      return null;
    } finally {
      setBusy(null);
    }
  };

  const reconcile = async () => {
    const result = await post({ action: 'reconcile' }, 'reconcile');
    if (!result) return;

    const issues = (result.issues as unknown[]) ?? [];
    setIntegrity({
      kind: 'ledger',
      ok: issues.length === 0,
      detail:
        issues.length === 0
          ? t('system.reconciliationOk')
          : t('system.reconciliationFailed', { count: issues.length }),
    });
  };

  const verifyAudit = async () => {
    const result = await post({ action: 'verifyAudit' }, 'verifyAudit');
    if (!result) return;

    setIntegrity({
      kind: 'audit',
      ok: Boolean(result.valid),
      detail: result.valid
        ? t('audit.verified', { count: Number(result.checked) })
        : String(result.reason ?? t('audit.verifyFailed', { id: 0 })),
    });
  };

  const runTask = async (taskKey: string) => {
    const result = await post({ action: 'runTask', taskKey }, taskKey);
    if (result) {
      toast.success(t('common.saved'), taskKey);
      router.refresh();
    }
  };

  const jobAction = async (jobId: string, action: 'retryJob' | 'cancelJob') => {
    const result = await post({ action, jobId }, jobId);
    if (result) router.refresh();
  };

  return (
    <div className="space-y-4">
      {/* --- Health tiles ------------------------------------------------- */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label={t('system.queue')}
          value={stats.counts.PENDING ?? 0}
          hint={`${t('system.backlog')}: ${stats.backlogSeconds}s`}
          icon={<Activity />}
          tone={(stats.counts.FAILED ?? 0) > 0 ? 'danger' : 'neutral'}
        />
        <StatTile
          label={t('system.status.FAILED')}
          value={stats.counts.FAILED ?? 0}
          icon={<XCircle />}
          tone={(stats.counts.FAILED ?? 0) > 0 ? 'danger' : 'success'}
        />
        <StatTile
          label={t('dashboard.activeUsers')}
          value={counts.activeSessions}
          hint={`${counts.activeUsers} ${t('users.title')}`}
        />
        <StatTile
          label={t('system.uptime')}
          value={formatDuration(runtime.uptimeSeconds * 1000, locale)}
          hint={`${runtime.nodeVersion} · ${runtime.memoryMb} MB`}
        />
      </div>

      {/* --- Integrity ----------------------------------------------------- */}
      <Card>
        <CardHeader title={t('system.integrity')} />
        <div className="space-y-3 p-4">
          {integrity && (
            <Alert tone={integrity.ok ? 'success' : 'danger'} icon={<ShieldCheck />}>
              {integrity.detail}
            </Alert>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              icon={<Scale />}
              loading={busy === 'reconcile'}
              onClick={() => void reconcile()}
            >
              {t('system.runReconciliation')}
            </Button>
            <Button
              variant="secondary"
              icon={<ShieldCheck />}
              loading={busy === 'verifyAudit'}
              onClick={() => void verifyAudit()}
            >
              {t('audit.verify')}
            </Button>
          </div>

          <dl className="grid grid-cols-2 gap-3 pt-2 sm:grid-cols-4">
            <div>
              <dt className="text-xs text-content-secondary">{t('nav.transactions')}</dt>
              <dd className="text-sm font-medium text-content">
                <Num value={counts.transactions} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-content-secondary">{t('nav.customers')}</dt>
              <dd className="text-sm font-medium text-content">
                <Num value={counts.customers} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-content-secondary">{t('audit.title')}</dt>
              <dd className="text-sm font-medium text-content">
                <Num value={counts.auditRecords} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-content-secondary">{t('system.jobs')}</dt>
              <dd className="text-sm font-medium text-content">{registeredJobs.length}</dd>
            </div>
          </dl>
        </div>
      </Card>

      {/* --- Scheduled tasks ----------------------------------------------- */}
      <Card>
        <CardHeader title={t('system.scheduledTasks')} />
        {tasks.length === 0 ? (
          <EmptyState title={t('common.noResults')} />
        ) : (
          <table className="w-full">
            <tbody className="divide-y divide-border-base">
              {tasks.map((task) => (
                <tr key={task.id} className="hover:bg-surface-hover">
                  <td className="px-4 py-2.5">
                    <p className="text-sm text-content">{ln(task, 'name')}</p>
                    <p className="font-mono text-[10px] text-content-tertiary ltr-content">
                      {task.jobName}
                    </p>
                  </td>
                  <td className="hidden px-4 py-2.5 text-sm text-content-secondary sm:table-cell">
                    {t('system.interval')}: {task.intervalSeconds}s
                  </td>
                  <td className="px-4 py-2.5">
                    {task.lastStatus ? (
                      <StatusBadge status={task.lastStatus} scope="usdt" />
                    ) : (
                      <Badge tone="neutral">{t('common.never')}</Badge>
                    )}
                  </td>
                  <td className="hidden px-4 py-2.5 text-xs text-content-secondary md:table-cell">
                    {t('system.nextRun')}: <DateText value={task.nextRunAt} relative />
                  </td>
                  <td className="px-4 py-2.5 text-end">
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Play />}
                        loading={busy === task.key}
                        onClick={() => void runTask(task.key)}
                      >
                        {t('system.runNow')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* --- Jobs ----------------------------------------------------------- */}
      <Card>
        <CardHeader
          title={t('system.jobs')}
          actions={
            <Button variant="ghost" size="sm" icon={<RefreshCw />} onClick={() => router.refresh()}>
              {t('common.refresh')}
            </Button>
          }
        />
        {jobs.length === 0 ? (
          <EmptyState title={t('system.noJobs')} />
        ) : (
          <table className="w-full">
            <tbody className="divide-y divide-border-base">
              {jobs.map((job) => (
                <tr key={job.id} className="hover:bg-surface-hover">
                  <td className="px-4 py-2.5">
                    <p className="font-mono text-xs text-content ltr-content">{job.name}</p>
                    {job.lastError && (
                      <p className="mt-0.5 truncate text-xs text-danger-text">{job.lastError}</p>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={job.status} scope="system" />
                  </td>
                  <td className="hidden px-4 py-2.5 text-sm text-content-secondary tabular-nums sm:table-cell">
                    {job.attempts}/{job.maxAttempts}
                  </td>
                  <td className="hidden px-4 py-2.5 text-xs text-content-secondary md:table-cell">
                    <DateText value={job.runAt} relative />
                  </td>
                  <td className="px-4 py-2.5 text-end">
                    {canManage && (
                      <div className="flex justify-end gap-1">
                        {job.status === 'FAILED' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={busy === job.id}
                            onClick={() => void jobAction(job.id, 'retryJob')}
                          >
                            {t('system.retryJob')}
                          </Button>
                        )}
                        {job.status === 'PENDING' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={busy === job.id}
                            onClick={() => void jobAction(job.id, 'cancelJob')}
                          >
                            {t('system.cancelJob')}
                          </Button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
