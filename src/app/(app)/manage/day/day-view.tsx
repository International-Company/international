'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarCheck, DoorClosed, DoorOpen, RotateCcw } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Alert, Badge, Button, Card, CardBody, CardHeader, StatTile } from '@/ui/primitives';
import { ConfirmDialog, useToast } from '@/ui/overlay';
import { Textarea } from '@/ui/form';
import { DateText, Money } from '@/ui/display';

/**
 * The counter's day, opened and closed by the manager.
 *
 * The teller cannot record anything until this is open, which is the point: it
 * is the manager saying the counter is trading. Closing draws the line — the
 * day's work becomes a fixed set to review rather than an arbitrary slice of
 * the clock.
 */

interface Day {
  id: string;
  date: string;
  status: string;
  openedAt: string;
  closedAt: string | null;
  notes: string | null;
  openedBy: { fullNameEn: string; fullNameAr: string } | null;
  closedBy: { fullNameEn: string; fullNameAr: string } | null;
  _count?: { transactions: number };
}

interface Summary {
  byType: { type: string; count: number }[];
  profit: string;
  reversals: number;
}

type Pending = 'open' | 'close' | 'reopen' | null;

export function DayView({
  current,
  recent,
  summary,
  permissions,
}: {
  current: Day | null;
  recent: Day[];
  summary: Summary;
  permissions: string[];
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [pending, setPending] = useState<Pending>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const isOpen = current?.status === 'OPEN' || current?.status === 'REOPENED';
  const canOpen = permissions.includes('exchange.day.open');
  const canClose = permissions.includes('exchange.day.close');
  const canReopen = permissions.includes('exchange.day.reopen');

  const act = async (action: Exclude<Pending, null>) => {
    setBusy(true);
    try {
      await api.post('/api/manage/day', {
        action,
        ...(action === 'reopen' ? { reason: text } : { notes: text || undefined }),
      });
      toast.success(t('common.saved'));
      setPending(null);
      setText('');
      router.refresh();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError
          ? say(t, cause.messageKey, cause.params) || cause.message
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  const total = summary.byType.reduce((sum, entry) => sum + entry.count, 0);

  return (
    <div className="space-y-4">
      {/* --- Is the counter trading? -------------------------------------- */}
      <Card>
        <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            {isOpen ? (
              <DoorOpen className="h-8 w-8 text-success-text" />
            ) : (
              <DoorClosed className="h-8 w-8 text-content-tertiary" />
            )}
            <div>
              <p className="text-lg font-semibold text-content">
                {isOpen ? t('day.open') : t('day.closed')}
              </p>
              <p className="text-sm text-content-secondary">
                {current ? (
                  <>
                    <DateText value={current.date} />
                    {current.openedBy ? <span>{` · ${ln(current.openedBy, 'fullName')}`}</span> : null}
                  </>
                ) : (
                  t('day.notOpenedToday')
                )}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {!isOpen && canOpen && (
              <Button variant="primary" icon={<DoorOpen />} onClick={() => setPending('open')}>
                {t('day.openAction')}
              </Button>
            )}
            {isOpen && canClose && (
              <Button variant="secondary" icon={<DoorClosed />} onClick={() => setPending('close')}>
                {t('day.closeAction')}
              </Button>
            )}
            {current?.status === 'CLOSED' && canReopen && (
              <Button variant="ghost" icon={<RotateCcw />} onClick={() => setPending('reopen')}>
                {t('day.reopenAction')}
              </Button>
            )}
          </div>
        </CardBody>
      </Card>

      {!isOpen && (
        <Alert tone="warning" title={t('day.blockedTitle')}>
          {t('day.blockedBody')}
        </Alert>
      )}

      {/* --- What happened today ------------------------------------------ */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label={t('day.todayCount')} value={total} icon={<CalendarCheck />} />
        {permissions.includes('exchange.margin.view') && (
          <StatTile label={t('transactions.profit')} value={<Money value={summary.profit} />} />
        )}
        <StatTile
          label={t('day.reversals')}
          value={summary.reversals}
          tone={summary.reversals > 0 ? 'warning' : 'neutral'}
        />
      </div>

      {/* --- Recent days -------------------------------------------------- */}
      <Card>
        <CardHeader title={t('day.recent')} />
        <ul className="divide-y divide-border-base">
          {recent.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <span className="flex items-center gap-2">
                <DateText value={entry.date} />
                <Badge tone={entry.status === 'CLOSED' ? 'neutral' : 'success'}>
                  {t(`day.status.${entry.status}` as never)}
                </Badge>
              </span>
              {/*
                Composed into one string rather than several adjacent
                expressions. A conditional that yields '' sits in the child list
                as an empty text node, and the server and the browser do not
                agree on how many text nodes that makes — which shows up as an
                intermittent hydration failure and nothing else.
              */}
              <span className="text-sm text-content-secondary">
                {[
                  `${entry._count?.transactions ?? 0} ${t('day.transactions')}`,
                  entry.closedBy ? ln(entry.closedBy, 'fullName') : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </li>
          ))}
          {recent.length === 0 && (
            <li className="px-4 py-6 text-sm text-content-secondary">{t('common.noResults')}</li>
          )}
        </ul>
      </Card>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => pending && void act(pending)}
        title={
          pending === 'open'
            ? t('day.openAction')
            : pending === 'close'
              ? t('day.closeAction')
              : t('day.reopenAction')
        }
        message={pending === 'close' ? t('day.closeWarning') : undefined}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        tone={pending === 'reopen' ? 'danger' : 'primary'}
        loading={busy}
      >
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={pending === 'reopen' ? t('day.reopenReason') : t('common.notes')}
          rows={2}
          required={pending === 'reopen'}
        />
      </ConfirmDialog>
    </div>
  );
}
