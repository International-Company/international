'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import {
  ArrowDown,
  Bot,
  CheckCircle2,
  ClipboardList,
  CornerUpRight,
  MessageSquare,
  Receipt,
  User,
  X,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { Skeleton } from '@/ui/primitives';
import { cn } from '@/ui/utils';
import { clockOf, dayKey, dayLabel } from './days';

interface Point {
  id: string;
  group: string;
  fromMe: boolean;
  senderName: string | null;
  senderPhone: string | null;
  text: string;
  mediaId: string | null;
  mediaKind: string | null;
  at: string;
}

interface Trace {
  message: Point;
  origins: (Point & { how: { auto: boolean; by: string | null; at: string } })[];
  forwards: { group: string; auto: boolean; by: string | null; at: string; copyId: string | null; delivered: boolean }[];
  deal: { id: string; reference: string; status: string; by: string | null; sentAt: string | null; sentBy: string | null } | null;
  request: {
    id: string;
    status: string;
    auto: boolean;
    addedByName: string | null;
    sentAt: string | null;
    sentByName: string | null;
    createdAt: string;
  } | null;
}

/**
 * A message followed through the groups.
 *
 * Read top to bottom as it happened: where it was first written and by whom; each
 * time it was passed on before it reached this group, by a rule or by a person;
 * this message itself; every group it went on to from here, and whether the copy
 * arrived; and what it became — the deal it announces, or the request it made in
 * the bank's list, and who sent that, when.
 */
export function MessageTrace({
  id,
  onClose,
  onOpen,
}: {
  id: string | null;
  onClose: () => void;
  /** Follows another message: an origin, or a copy further on. */
  onOpen: (id: string) => void;
}) {
  const { t, locale } = useLocale();
  const [trace, setTrace] = useState<Trace | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!id) return;
    setTrace(null);
    setFailed(false);
    api
      .get<Trace>(`/api/bank/groups/messages/${id}/trace`)
      .then(setTrace)
      .catch(() => setFailed(true));
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [id, onClose]);

  if (!id) return null;

  const when = (at: string) =>
    `${dayLabel(dayKey(at), locale, { today: t('bank.period.today'), yesterday: t('bank.period.yesterday') })} · ${clockOf(at)}`;
  const who = (point: Point) =>
    point.fromMe
      ? t('bankFeed.office')
      : (point.senderName ?? (point.senderPhone ? `+${point.senderPhone}` : t('bankFeed.member')));

  /** One step of the way, on the line down the side. */
  const Step = ({
    icon,
    tone,
    title,
    children,
    last,
  }: {
    icon: ReactNode;
    tone: 'primary' | 'success' | 'warning' | 'neutral';
    title: ReactNode;
    children?: ReactNode;
    last?: boolean;
  }) => (
    <li className="relative flex gap-3 pb-4">
      {!last && <span className="absolute start-[15px] top-8 bottom-0 w-px bg-border-subtle" aria-hidden />}
      <span
        className={cn(
          'relative z-[1] flex size-8 shrink-0 items-center justify-center rounded-full ring-4 ring-surface-sunken',
          tone === 'primary' && 'bg-primary text-white',
          tone === 'success' && 'bg-success text-white',
          tone === 'warning' && 'bg-warning text-white',
          tone === 'neutral' && 'bg-surface text-content-secondary ring-1',
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <div className="text-sm font-semibold text-content">{title}</div>
        {children && <div className="mt-1 text-xs text-content-secondary">{children}</div>}
      </div>
    </li>
  );

  const Bubble = ({ point, here }: { point: Point; here?: boolean }) => (
    <div
      className={cn(
        'mt-1.5 rounded-xl p-2.5 text-sm text-content ring-1',
        here ? 'bg-primary-subtle/50 ring-primary/30' : 'bg-surface ring-border-subtle',
      )}
    >
      {point.mediaId && point.mediaKind === 'image' && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={`/api/bank/groups/media/${point.mediaId}`} alt="" className="mb-1 max-h-40 rounded-lg object-contain" />
      )}
      <p className="line-clamp-6 whitespace-pre-wrap break-words">{point.text || '📎'}</p>
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-[55] flex" role="dialog" aria-modal="true" aria-label={t('bankFeed.traceTitle')}>
      <button type="button" aria-label={t('common.close')} onClick={onClose} className="flex-1 bg-black/30 backdrop-blur-[1px]" />
      <aside className="flex h-full w-full max-w-md flex-col bg-surface-sunken shadow-[0_0_60px_-10px_rgb(0_0_0/0.4)]">
        <header className="flex items-center justify-between gap-2 border-b border-border-subtle bg-surface p-4">
          <div>
            <p className="text-base font-semibold text-content">{t('bankFeed.traceTitle')}</p>
            <p className="text-xs text-content-tertiary">{t('bankFeed.traceHint')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="inline-flex size-8 items-center justify-center rounded-full text-content-tertiary hover:bg-surface-sunken hover:text-content"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {failed ? (
            <p className="p-4 text-center text-sm text-danger-text">{t('errors.generic')}</p>
          ) : !trace ? (
            <div className="space-y-3">
              <Skeleton className="h-16" />
              <Skeleton className="h-24" />
              <Skeleton className="h-16" />
            </div>
          ) : (
            <ol>
              {/* --- Where it began, and each time it was passed on before reaching here --- */}
              {trace.origins.map((origin, index) => (
                <div key={`origin-${index}`}>
                  <Step
                    icon={origin.fromMe ? <Bot className="size-4" /> : <User className="size-4" />}
                    tone="neutral"
                    title={
                      <>
                        {index === 0 ? t('bankFeed.traceFirst') : t('bankFeed.traceVia')}{' '}
                        <span className="text-primary-text">{origin.group}</span>
                      </>
                    }
                  >
                    {origin.id ? (
                      <>
                        {who(origin)}
                        {origin.senderPhone && <span className="ms-1 ltr-content">+{origin.senderPhone}</span>} ·{' '}
                        {when(origin.at)}
                        <button
                          type="button"
                          onClick={() => onOpen(origin.id)}
                          className="ms-2 font-medium text-primary-text hover:underline"
                        >
                          {t('bankFeed.traceOpen')}
                        </button>
                        <Bubble point={origin} />
                      </>
                    ) : (
                      t('bankFeed.traceNotKept')
                    )}
                  </Step>
                  <Step icon={<ArrowDown className="size-4" />} tone="neutral" title={t('bankFeed.tracePassed')}>
                    {origin.how.auto ? t('bankFeed.auto') : t('bankFeed.traceBy', { name: origin.how.by ?? '' })} ·{' '}
                    {when(origin.how.at)}
                  </Step>
                </div>
              ))}

              {/* --- This message --- */}
              <Step
                icon={<MessageSquare className="size-4" />}
                tone="primary"
                last={trace.forwards.length === 0 && !trace.deal && !trace.request}
                title={
                  <>
                    {trace.origins.length === 0 ? t('bankFeed.traceWritten') : t('bankFeed.traceArrived')}{' '}
                    <span className="text-primary-text">{trace.message.group}</span>
                  </>
                }
              >
                {who(trace.message)}
                {trace.message.senderPhone && (
                  <span className="ms-1 font-medium ltr-content">+{trace.message.senderPhone}</span>
                )}{' '}
                · {when(trace.message.at)}
                <Bubble point={trace.message} here />
              </Step>

              {/* --- Where it went from here --- */}
              {trace.forwards.map((forward, index) => (
                <Step
                  key={`forward-${index}`}
                  icon={<CornerUpRight className="size-4" />}
                  tone={forward.delivered ? 'success' : 'warning'}
                  last={index === trace.forwards.length - 1 && !trace.deal && !trace.request}
                  title={
                    <>
                      {t('bankFeed.to', { group: forward.group })}
                    </>
                  }
                >
                  {forward.auto ? t('bankFeed.auto') : t('bankFeed.traceBy', { name: forward.by ?? '' })} ·{' '}
                  {when(forward.at)} ·{' '}
                  {forward.delivered ? t('bankFeed.traceDelivered') : t('bankFeed.traceNotDelivered')}
                  {forward.copyId && (
                    <button
                      type="button"
                      onClick={() => onOpen(forward.copyId!)}
                      className="ms-2 font-medium text-primary-text hover:underline"
                    >
                      {t('bankFeed.traceOpenCopy')}
                    </button>
                  )}
                </Step>
              ))}

              {/* --- What it became --- */}
              {trace.deal && (
                <Step
                  icon={trace.deal.sentAt ? <CheckCircle2 className="size-4" /> : <Receipt className="size-4" />}
                  tone={trace.deal.sentAt || trace.deal.status === 'POSTED' ? 'success' : 'warning'}
                  last={!trace.request}
                  title={
                    <>
                      {t('bankFeed.traceDeal')}{' '}
                      <Link href={`/manage/transactions/${trace.deal.id}`} className="font-mono text-primary-text hover:underline ltr-content">
                        {trace.deal.reference}
                      </Link>
                    </>
                  }
                >
                  {trace.deal.by && t('bankFeed.traceRecordedBy', { name: trace.deal.by })}
                  {trace.deal.status === 'PENDING_TRANSFER'
                    ? ` · ${t('bankFeed.waiting')}`
                    : trace.deal.status === 'REVERSED'
                      ? ` · ${t('bankFeed.reversed')}`
                      : trace.deal.sentAt
                        ? ` · ${t('bankFeed.traceSentBy', { name: trace.deal.sentBy ?? '', when: when(trace.deal.sentAt) })}`
                        : ''}
                </Step>
              )}
              {trace.request && (
                <Step
                  icon={trace.request.status === 'SENT' ? <CheckCircle2 className="size-4" /> : <ClipboardList className="size-4" />}
                  tone={trace.request.status === 'SENT' ? 'success' : trace.request.status === 'DISMISSED' ? 'neutral' : 'warning'}
                  last
                  title={t('bankFeed.traceRequest')}
                >
                  {trace.request.auto ? t('bankFeed.traceReadByBot') : t('bank.addedBy', { name: trace.request.addedByName ?? '' })} ·{' '}
                  {when(trace.request.createdAt)}
                  {trace.request.status === 'SENT' && trace.request.sentAt && (
                    <> · {t('bankFeed.traceSentBy', { name: trace.request.sentByName ?? '', when: when(trace.request.sentAt) })}</>
                  )}
                  {trace.request.status === 'DISMISSED' && <> · {t('bank.dismissed')}</>}
                  {trace.request.status === 'PENDING' && <> · {t('bankFeed.waiting')}</>}
                </Step>
              )}
            </ol>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
