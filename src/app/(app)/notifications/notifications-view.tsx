'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Archive, BellOff, CheckCheck } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, queryString } from '@/lib/api-client';
import { Button, Card, EmptyState, LoadingRows } from '@/ui/primitives';
import { Select } from '@/ui/form';
import { useToast } from '@/ui/overlay';
import { DateText, SeverityBadge } from '@/ui/display';
import { cn } from '@/ui/utils';

interface RecipientRow {
  id: string;
  readAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  notification: {
    id: string;
    severity: string;
    eventKey: string;
    module: string;
    titleEn: string;
    titleAr: string;
    bodyEn: string;
    bodyAr: string;
    link: string | null;
    createdAt: string;
  };
}

interface InboxResponse {
  rows: RecipientRow[];
  total: number;
  unread: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export function NotificationsView({ initial }: { initial: InboxResponse }) {
  const { t, locale } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [data, setData] = useState<InboxResponse>(initial);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [severity, setSeverity] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<InboxResponse>(
        `/api/notifications${queryString({ page, pageSize: 25, severity, unreadOnly })}`,
      );
      setData(result);
    } finally {
      setLoading(false);
    }
  }, [page, severity, unreadOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const markRead = async (ids: string[]) => {
    await api.post('/api/notifications', { action: 'read', ids });
    void load();
    // Refresh the shell so the unread badge updates too.
    router.refresh();
  };

  const markAllRead = async () => {
    const result = await api.post<{ updated: number }>('/api/notifications', { action: 'readAll' });
    toast.success(t('notifications.markAllRead'), String(result.updated));
    void load();
    router.refresh();
  };

  const archive = async (ids: string[]) => {
    await api.post('/api/notifications', { action: 'archive', ids });
    void load();
    router.refresh();
  };

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-border-base p-3 sm:flex-row sm:items-center">
        <Select
          options={[
            { value: '', label: t('common.allTypes') },
            ...['CRITICAL', 'WARNING', 'INFO', 'SUCCESS'].map((value) => ({
              value,
              label: t(`notifications.severity.${value}` as never),
            })),
          ]}
          value={severity}
          onChange={(event) => {
            setSeverity(event.target.value);
            setPage(1);
          }}
          className="sm:max-w-[12rem]"
        />

        <Button
          variant={unreadOnly ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => {
            setUnreadOnly((current) => !current);
            setPage(1);
          }}
        >
          {t('notifications.unread')}
          {data.unread > 0 && ` (${data.unread})`}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          icon={<CheckCheck />}
          className="sm:ms-auto"
          disabled={data.unread === 0}
          onClick={() => void markAllRead()}
        >
          {t('notifications.markAllRead')}
        </Button>
      </div>

      {loading ? (
        <LoadingRows rows={6} columns={3} />
      ) : data.rows.length === 0 ? (
        <EmptyState
          icon={<BellOff />}
          title={t('notifications.noNotifications')}
          description={t('notifications.noNotificationsHint')}
        />
      ) : (
        <ul className="divide-y divide-border-base">
          {data.rows.map((row) => {
            const isUnread = row.readAt === null;

            return (
              <li
                key={row.id}
                className={cn(
                  'flex items-start gap-3 p-4 transition-colors',
                  isUnread && 'bg-primary-subtle/40',
                )}
              >
                <span className="mt-0.5 shrink-0">
                  <SeverityBadge severity={row.notification.severity} />
                </span>

                <div className="min-w-0 flex-1">
                  <p className={cn('text-sm text-content', isUnread && 'font-medium')}>
                    {locale === 'ar' ? row.notification.titleAr : row.notification.titleEn}
                  </p>
                  <p className="mt-0.5 text-sm text-content-secondary">
                    {locale === 'ar' ? row.notification.bodyAr : row.notification.bodyEn}
                  </p>
                  <p className="mt-1 text-xs text-content-tertiary">
                    <DateText value={row.notification.createdAt} relative />
                    {row.notification.link && (
                      <>
                        {' · '}
                        <Link
                          href={row.notification.link}
                          onClick={() => void markRead([row.id])}
                          className="text-primary-text hover:underline"
                        >
                          {t('common.view')}
                        </Link>
                      </>
                    )}
                  </p>
                </div>

                <div className="flex shrink-0 gap-1">
                  {isUnread && (
                    <Button
                      variant="ghost"
                      size="icon"
                      title={t('notifications.markRead')}
                      onClick={() => void markRead([row.id])}
                    >
                      <CheckCheck className="size-4" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    title={t('notifications.archive')}
                    onClick={() => void archive([row.id])}
                  >
                    <Archive className="size-4" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {data.pageCount > 1 && (
        <div className="flex items-center justify-between border-t border-border-base px-4 py-3">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            {t('common.previous')}
          </Button>
          <span className="text-xs text-content-secondary">
            {t('common.pageOf', { page: data.page, total: data.pageCount })}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={page >= data.pageCount}
            onClick={() => setPage(page + 1)}
          >
            {t('common.next')}
          </Button>
        </div>
      )}
    </Card>
  );
}
