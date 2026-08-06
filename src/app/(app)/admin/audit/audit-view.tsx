'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldAlert, ShieldCheck, Search } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, queryString } from '@/lib/api-client';
import { Alert, Button, Card } from '@/ui/primitives';
import { Input, Select } from '@/ui/form';
import { DataTable, type Column } from '@/ui/data-table';
import { CopyableId, DateText } from '@/ui/display';
import { useToast } from '@/ui/overlay';
import { debounce } from '@/ui/utils';
import { MODULES } from '@/core/security/permissions';

interface AuditRow {
  id: number;
  at: string;
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
  hash: string;
  prevHash: string;
}

interface QueryResponse {
  rows: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

interface Verification {
  valid: boolean;
  checked: number;
  firstBrokenId: number | null;
  reason: string | null;
}

export function AuditView({
  initial,
  canVerify,
}: {
  initial: QueryResponse;
  canVerify: boolean;
}) {
  const { t, locale } = useLocale();
  const toast = useToast();

  const [data, setData] = useState<QueryResponse>(initial);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [module, setModule] = useState('');
  const [verification, setVerification] = useState<Verification | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<QueryResponse>(
        `/api/admin/audit${queryString({ page, pageSize: 50, search, module })}`,
      );
      setData(result);
    } finally {
      setLoading(false);
    }
  }, [page, search, module]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSearchChange = useMemo(
    () =>
      debounce((value: string) => {
        setSearch(value);
        setPage(1);
      }, 300),
    [],
  );

  const verify = async () => {
    setVerifying(true);
    try {
      const result = await api.post<Verification>('/api/admin/audit', { action: 'verify' });
      setVerification(result);

      if (result.valid) {
        toast.success(t('audit.verified', { count: result.checked }));
      } else {
        toast.error(t('audit.verifyFailed', { id: result.firstBrokenId ?? 0 }), result.reason ?? '');
      }
    } finally {
      setVerifying(false);
    }
  };

  const columns: Column<AuditRow>[] = [
    {
      key: 'at',
      header: t('common.date'),
      cell: (row) => (
        <span className="text-xs text-content-secondary">
          <DateText value={row.at} withTime />
        </span>
      ),
    },
    {
      key: 'actor',
      header: t('audit.actor'),
      cell: (row) => (
        <div>
          <p className="text-sm text-content">{row.actorName ?? t('common.unknown')}</p>
          {row.actorIp && (
            <p className="font-mono text-[10px] text-content-tertiary ltr-content">{row.actorIp}</p>
          )}
        </div>
      ),
      hideOnMobile: true,
    },
    {
      key: 'action',
      header: t('audit.action'),
      cell: (row) => (
        <span className="text-xs font-medium text-content">
          {t(`audit.actionType.${row.action}` as never)}
        </span>
      ),
    },
    {
      key: 'summary',
      header: t('audit.summary'),
      cell: (row) => (
        <span className="text-sm text-content">
          {locale === 'ar' ? row.summaryAr : row.summaryEn}
        </span>
      ),
    },
    {
      key: 'hash',
      header: t('audit.hash'),
      align: 'end',
      cell: (row) => <CopyableId value={row.hash} display={`${row.hash.slice(0, 10)}…`} />,
      hideOnMobile: true,
    },
  ];

  return (
    <div className="space-y-4">
      <Alert
        tone={verification ? (verification.valid ? 'success' : 'danger') : 'neutral'}
        icon={verification?.valid === false ? <ShieldAlert /> : <ShieldCheck />}
        title={
          verification
            ? verification.valid
              ? t('audit.verified', { count: verification.checked })
              : t('audit.verifyFailed', { id: verification.firstBrokenId ?? 0 })
            : undefined
        }
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span>{verification?.reason ?? t('audit.verifyExplain')}</span>
          {canVerify && (
            <Button size="sm" variant="secondary" loading={verifying} onClick={() => void verify()}>
              {verifying ? t('audit.verifying') : t('audit.verify')}
            </Button>
          )}
        </div>
      </Alert>

      <Card>
        <div className="flex flex-col gap-3 border-b border-border-base p-3 sm:flex-row">
          <Input
            placeholder={t('common.searchPlaceholder')}
            iconStart={<Search />}
            defaultValue={search}
            onChange={(event) => onSearchChange(event.target.value)}
            className="sm:max-w-sm"
          />
          <Select
            options={[
              { value: '', label: t('common.all') },
              ...MODULES.map((value) => ({ value, label: value })),
            ]}
            value={module}
            onChange={(event) => {
              setModule(event.target.value);
              setPage(1);
            }}
            className="sm:max-w-[12rem]"
          />
        </div>

        <DataTable
          columns={columns}
          rows={data.rows}
          rowKey={(row) => String(row.id)}
          loading={loading}
          onRowClick={(row) => setExpanded(expanded === row.id ? null : row.id)}
          emptyTitle={t('audit.noRecords')}
          renderSubRow={(row) =>
            expanded === row.id ? (
              <div className="space-y-3 text-xs">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {row.beforeData && (
                    <div>
                      <p className="mb-1 font-medium text-content-secondary">{t('audit.before')}</p>
                      <pre className="overflow-x-auto rounded bg-surface p-2 font-mono text-[10px] text-content ltr-content">
                        {JSON.stringify(JSON.parse(row.beforeData), null, 2)}
                      </pre>
                    </div>
                  )}
                  {row.afterData && (
                    <div>
                      <p className="mb-1 font-medium text-content-secondary">{t('audit.after')}</p>
                      <pre className="overflow-x-auto rounded bg-surface p-2 font-mono text-[10px] text-content ltr-content">
                        {JSON.stringify(JSON.parse(row.afterData), null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
                <dl className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                  <div className="flex gap-2">
                    <dt className="text-content-secondary">{t('audit.prevHash')}:</dt>
                    <dd className="font-mono text-[10px] text-content-tertiary ltr-content">
                      {row.prevHash}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-content-secondary">{t('audit.hash')}:</dt>
                    <dd className="font-mono text-[10px] text-content-tertiary ltr-content">
                      {row.hash}
                    </dd>
                  </div>
                </dl>
              </div>
            ) : null
          }
          pagination={{
            page: data.page,
            pageSize: data.pageSize,
            total: data.total,
            pageCount: data.pageCount,
            onPageChange: setPage,
          }}
        />
      </Card>
    </div>
  );
}
