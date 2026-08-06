'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Database, DatabaseBackup, ShieldCheck, Trash2 } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { formatBytes } from '@/i18n/format';
import { Alert, Badge, Button, Card, CardHeader, EmptyState } from '@/ui/primitives';
import { Input } from '@/ui/form';
import { ConfirmDialog, useToast } from '@/ui/overlay';
import { CopyableId, DateText, StatusBadge } from '@/ui/display';

interface BackupRow {
  id: string;
  filename: string;
  sizeBytes: string;
  checksum: string | null;
  type: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  verifiedAt: string | null;
  error: string | null;
  rowCount: number;
  tableCount: number;
  createdBy: { fullNameEn: string; fullNameAr: string } | null;
}

export function BackupView({
  backups,
  permissions,
}: {
  backups: BackupRow[];
  permissions: string[];
}) {
  const { t, locale, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<BackupRow | null>(null);
  const [deleting, setDeleting] = useState<BackupRow | null>(null);
  const [confirmText, setConfirmText] = useState('');

  const canCreate = permissions.includes('system.backup.create');
  const canRestore = permissions.includes('system.backup.restore');

  const run = async (body: Record<string, unknown>, successMessage: string) => {
    setBusy(true);
    try {
      await api.post('/api/admin/backup', body);
      toast.success(successMessage);
      setRestoring(null);
      setDeleting(null);
      setConfirmText('');
      router.refresh();
    } catch (error) {
      toast.error(
        t('errors.title'),
        error instanceof ApiError
          ? t(error.messageKey as never, error.params) || error.message
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={t('backup.title')}
          actions={
            canCreate && (
              <Button
                variant="primary"
                size="sm"
                icon={<DatabaseBackup />}
                loading={busy}
                onClick={() => void run({ action: 'create' }, t('common.saved'))}
              >
                {t('backup.create')}
              </Button>
            )
          }
        />

        {backups.length === 0 ? (
          <EmptyState icon={<Database />} title={t('backup.noBackups')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border-base bg-surface-sunken">
                  <th className="px-4 py-2 text-start text-xs font-medium text-content-secondary">
                    {t('backup.filename')}
                  </th>
                  <th className="px-4 py-2 text-start text-xs font-medium text-content-secondary">
                    {t('common.status')}
                  </th>
                  <th className="hidden px-4 py-2 text-end text-xs font-medium text-content-secondary sm:table-cell">
                    {t('backup.size')}
                  </th>
                  <th className="hidden px-4 py-2 text-end text-xs font-medium text-content-secondary md:table-cell">
                    {t('backup.rowCount', { count: '' }).trim()}
                  </th>
                  <th className="hidden px-4 py-2 text-start text-xs font-medium text-content-secondary md:table-cell">
                    {t('backup.startedAt')}
                  </th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border-base">
                {backups.map((backup) => (
                  <tr key={backup.id} className="hover:bg-surface-hover">
                    <td className="px-4 py-2.5">
                      <p className="font-mono text-xs text-content ltr-content">{backup.filename}</p>
                      {backup.checksum && (
                        <CopyableId
                          value={backup.checksum}
                          display={`${backup.checksum.slice(0, 12)}…`}
                          className="text-[10px] text-content-tertiary"
                        />
                      )}
                      {backup.error && (
                        <p className="mt-0.5 text-xs text-danger-text">{backup.error}</p>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-col gap-1">
                        <StatusBadge status={backup.status} scope="backup" />
                        <Badge tone="neutral">
                          {backup.type === 'AUTOMATIC' ? t('backup.automatic') : t('backup.manual')}
                        </Badge>
                      </div>
                    </td>
                    <td className="hidden px-4 py-2.5 text-end text-sm text-content-secondary tabular-nums sm:table-cell">
                      {formatBytes(Number(backup.sizeBytes), locale)}
                    </td>
                    <td className="hidden px-4 py-2.5 text-end text-sm text-content-secondary tabular-nums md:table-cell">
                      {backup.rowCount.toLocaleString('en-US')}
                    </td>
                    <td className="hidden px-4 py-2.5 text-xs text-content-secondary md:table-cell">
                      <DateText value={backup.startedAt} withTime />
                      {backup.createdBy && (
                        <p className="text-content-tertiary">{ln(backup.createdBy, 'fullName')}</p>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t('backup.verify')}
                          onClick={() =>
                            void run({ action: 'verify', backupId: backup.id }, t('backup.verifyOk'))
                          }
                        >
                          <ShieldCheck className="size-4" />
                        </Button>
                        {canRestore && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setRestoring(backup)}
                              disabled={!['COMPLETED', 'VERIFIED'].includes(backup.status)}
                            >
                              {t('backup.restore')}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title={t('common.delete')}
                              onClick={() => setDeleting(backup)}
                            >
                              <Trash2 className="size-4 text-danger-text" />
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* --- Restore ------------------------------------------------------- */}
      <ConfirmDialog
        open={restoring !== null}
        onClose={() => {
          setRestoring(null);
          setConfirmText('');
        }}
        onConfirm={() =>
          void run(
            { action: 'restore', backupId: restoring!.id, confirm: 'RESTORE' },
            t('common.saved'),
          )
        }
        title={t('backup.restore')}
        confirmLabel={t('backup.restore')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        loading={busy}
      >
        <div className="space-y-3">
          <Alert tone="danger">{t('backup.restoreWarning')}</Alert>
          <p className="font-mono text-xs text-content-secondary ltr-content">
            {restoring?.filename}
          </p>
          <Input
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
            placeholder={t('backup.restoreConfirm')}
            dir="ltr"
            autoFocus
          />
          {confirmText !== 'RESTORE' && (
            <p className="text-xs text-content-tertiary">{t('backup.restoreConfirm')}</p>
          )}
        </div>
      </ConfirmDialog>

      {/* --- Delete -------------------------------------------------------- */}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() =>
          void run({ action: 'delete', backupId: deleting!.id }, t('common.saved'))
        }
        title={t('common.delete')}
        message={deleting?.filename}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        loading={busy}
      />
    </div>
  );
}
