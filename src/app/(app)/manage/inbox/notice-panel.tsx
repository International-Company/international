'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Clock, Receipt, RotateCcw, Search, Send, X, XCircle } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Button, Skeleton } from '@/ui/primitives';
import { useToast } from '@/ui/overlay';
import { cn } from '@/ui/utils';
import { RemitForm } from './remit-form';

/**
 * A remittance notice beside the customer's conversation, followed step by
 * step: the photo and what it says, sent to the agent's group for checking,
 * what the agent answers under it as it comes, and the teller's word —
 * confirmed or rejected. Paying it out is the next step, not this one.
 */

export const NOTICE_NETWORKS = ['WESTERN', 'MONEYGRAM', 'PAYPAL', 'OTHER'] as const;
export type NoticeNetwork = (typeof NOTICE_NETWORKS)[number];
export type NoticeStatus = 'NEW' | 'CHECKING' | 'CONFIRMED' | 'REJECTED';

interface Reply {
  id: string;
  text: string;
  author: string | null;
  fromMe: boolean;
  imageId: string | null;
  at: string;
}

export interface NoticeLine {
  id: string;
  chatId: string;
  messageId: string | null;
  imageId: string;
  customerName: string | null;
  customerPhone: string | null;
  network: NoticeNetwork;
  amount: string | null;
  currency: string | null;
  agentChat: string | null;
  agentName: string | null;
  sentAt: string | null;
  status: NoticeStatus;
  decidedAt: string | null;
  decidedByName: string | null;
  note: string | null;
  /** The remittance it was paid out as, once it is. */
  transactionId?: string | null;
  createdAt: string;
  replyCount?: number;
}

interface NoticeDetail extends NoticeLine {
  replies: { quoted: Reply[]; since: Reply[] };
}

interface NumberGroup {
  chat: string;
  name: string;
  size: number;
  followed: boolean;
}

const LAST_AGENT_KEY = 'international.notice.agent';

/** How long since it was sent, and how late that is: on time, late after 15 minutes, very late after 30. */
export function checkingLate(sentAt: string | null, now: number): 'ok' | 'late' | 'veryLate' {
  if (!sentAt) return 'ok';
  const minutes = (now - new Date(sentAt).getTime()) / 60_000;
  return minutes >= 30 ? 'veryLate' : minutes >= 15 ? 'late' : 'ok';
}

export const STATUS_STYLE: Record<NoticeStatus, string> = {
  NEW: 'bg-surface-sunken text-content-secondary',
  CHECKING: 'bg-warning-subtle text-warning-text',
  CONFIRMED: 'bg-success-subtle text-success-text',
  REJECTED: 'bg-danger-subtle text-danger-text',
};

export function NoticePanel({
  noticeId,
  onClose,
  onChanged,
  onDraft,
}: {
  noticeId: string;
  onClose: () => void;
  /** Something changed that the notices' list should show. */
  onChanged: () => void;
  /** Words for the customer, put in their conversation's box to be read over and sent. */
  onDraft?: (chatId: string, text: string) => void;
}) {
  const { t } = useLocale();
  const toast = useToast();
  const [notice, setNotice] = useState<NoticeDetail | null>(null);
  const [groups, setGroups] = useState<NumberGroup[] | null>(null);
  const [groupQuery, setGroupQuery] = useState('');
  const [agent, setAgent] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const failure = useCallback(
    (cause: unknown) =>
      toast.error(
        t('errors.title'),
        cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'),
      ),
    [toast, t],
  );

  const read = useCallback(async () => {
    try {
      const found = await api.get<NoticeDetail>(`/api/inbox/mine/notices/${noticeId}`);
      setNotice(found);
      return found;
    } catch (cause) {
      failure(cause);
      return null;
    }
  }, [noticeId, failure]);

  // Opened: read, and its figures into the fields; then read again every few seconds for the agent's answers.
  useEffect(() => {
    setNotice(null);
    void read().then((found) => {
      if (!found) return;
      setAmount(found.amount ? String(Number(found.amount) / 1e8) : '');
      setAgent(found.agentChat ?? (() => {
        try {
          return window.localStorage.getItem(LAST_AGENT_KEY) ?? '';
        } catch {
          return '';
        }
      })());
    });
    const timer = setInterval(() => {
      if (!document.hidden) void read();
      setNow(Date.now());
    }, 5_000);
    return () => clearInterval(timer);
  }, [read]);

  // The number's groups, for choosing the agent's: read once.
  useEffect(() => {
    api
      .get<NumberGroup[]>('/api/inbox/mine/groups')
      .then(setGroups)
      .catch(() => setGroups([]));
  }, []);

  const patch = async (body: Record<string, unknown>) => {
    try {
      setNotice(await api.patch<NoticeDetail>(`/api/inbox/mine/notices/${noticeId}`, body));
      onChanged();
    } catch (cause) {
      failure(cause);
    }
  };

  const act = async (key: string, body: Record<string, unknown>, done?: string) => {
    setBusy(key);
    try {
      setNotice(await api.post<NoticeDetail>(`/api/inbox/mine/notices/${noticeId}`, body));
      if (done) toast.success(done);
      onChanged();
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    if (!agent) return;
    try {
      window.localStorage.setItem(LAST_AGENT_KEY, agent);
    } catch {
      // Only a convenience.
    }
    await act('send', { action: 'send', agentChat: agent }, t('inbox.notice.sent'));
  };

  if (!notice) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-48" />
        <Skeleton className="h-24" />
      </div>
    );
  }

  const decided = notice.status === 'CONFIRMED' || notice.status === 'REJECTED';
  const late = notice.status === 'CHECKING' ? checkingLate(notice.sentAt, now) : 'ok';
  const minutes = notice.sentAt ? Math.max(0, Math.round((now - new Date(notice.sentAt).getTime()) / 60_000)) : 0;
  const shownGroups = (groups ?? []).filter((group) => !groupQuery.trim() || group.name.includes(groupQuery.trim()));
  const replies = [...notice.replies.quoted, ...notice.replies.since];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-3 py-2.5">
        <span className="min-w-0">
          <span className="block text-sm font-bold text-content">{t('inbox.notice.title')}</span>
          <span className="block truncate text-[11px] text-content-tertiary">
            {notice.customerName ?? (notice.customerPhone ? `+${notice.customerPhone}` : '')}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', STATUS_STYLE[notice.status])}>
            {t(`inbox.notice.status.${notice.status}`)}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="inline-flex size-8 items-center justify-center rounded-full text-content-secondary hover:bg-surface-sunken"
          >
            <X className="size-4" />
          </button>
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {/* ① The notice. */}
        <section className="space-y-2 rounded-xl bg-surface p-3 ring-1 ring-border-subtle">
          <h4 className="text-[11px] font-semibold text-content-tertiary">① {t('inbox.notice.stepNotice')}</h4>
          <a href={`/api/inbox/images/${notice.imageId}`} target="_blank" rel="noopener noreferrer" className="block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/inbox/images/${notice.imageId}`}
              alt={t('inbox.notice.photo')}
              className="max-h-56 w-full rounded-lg bg-surface-sunken object-contain ring-1 ring-border-subtle"
            />
          </a>
          <div className="grid grid-cols-4 gap-1 rounded-lg bg-surface-sunken p-1">
            {NOTICE_NETWORKS.map((network) => (
              <button
                key={network}
                type="button"
                disabled={decided}
                onClick={() => void patch({ network })}
                className={cn(
                  'h-8 rounded-md text-[11px] font-semibold transition-colors',
                  notice.network === network ? 'bg-surface text-content shadow-sm' : 'text-content-tertiary hover:text-content-secondary',
                )}
              >
                {t(`inbox.notice.network.${network}`)}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <input
              dir="ltr"
              inputMode="decimal"
              value={amount}
              disabled={decided}
              placeholder={t('inbox.notice.amount')}
              onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ''))}
              onBlur={() => void patch({ amount: amount || null, currency: notice.currency ?? 'USD' })}
              className="h-10 rounded-lg bg-surface-sunken px-3 text-end font-bold tabular-nums outline-none ring-1 ring-border-subtle focus:ring-primary"
            />
            <select
              value={notice.currency ?? 'USD'}
              disabled={decided}
              onChange={(event) => void patch({ currency: event.target.value, amount: amount || null })}
              className="h-10 rounded-lg bg-surface-sunken px-2 text-sm font-semibold outline-none ring-1 ring-border-subtle"
            >
              {['USD', 'EUR', 'ILS', 'JOD', 'GBP'].map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
        </section>

        {/* ② Checked with the agent. */}
        <section className="space-y-2 rounded-xl bg-surface p-3 ring-1 ring-border-subtle">
          <h4 className="text-[11px] font-semibold text-content-tertiary">② {t('inbox.notice.stepCheck')}</h4>
          {!decided && (
            <>
              <label className="flex h-9 items-center gap-2 rounded-lg bg-surface-sunken px-2.5 ring-1 ring-border-subtle">
                <Search className="size-3.5 text-content-tertiary" />
                <input
                  value={groupQuery}
                  onChange={(event) => setGroupQuery(event.target.value)}
                  placeholder={t('inbox.notice.findGroup')}
                  className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                />
              </label>
              {groups === null ? (
                <Skeleton className="h-9" />
              ) : (
                <select
                  value={agent}
                  onChange={(event) => setAgent(event.target.value)}
                  className="h-10 w-full rounded-lg bg-surface-sunken px-2 text-sm font-semibold outline-none ring-1 ring-border-subtle"
                  aria-label={t('inbox.notice.agentGroup')}
                >
                  <option value="">{t('inbox.notice.agentGroup')}</option>
                  {shownGroups.map((group) => (
                    <option key={group.chat} value={group.chat}>
                      {group.name}
                    </option>
                  ))}
                </select>
              )}
              <Button
                fullWidth
                icon={<Send />}
                loading={busy === 'send'}
                disabled={!agent}
                onClick={() => void send()}
              >
                {notice.sentAt ? t('inbox.notice.sendAgain') : t('inbox.notice.send')}
              </Button>
            </>
          )}

          {notice.sentAt && (
            <p
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold',
                late === 'veryLate'
                  ? 'bg-danger text-white'
                  : late === 'late'
                    ? 'bg-warning text-white'
                    : 'bg-surface-sunken text-content-secondary',
              )}
            >
              <Clock className="size-3.5 shrink-0" />
              <span className="truncate">
                {t('inbox.notice.sentTo', { group: notice.agentName ?? '—', minutes })}
              </span>
            </p>
          )}

          {/* What the agent said, as it comes. */}
          {notice.sentAt && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold text-content-tertiary">{t('inbox.notice.replies')}</p>
              {replies.length === 0 ? (
                <p className="rounded-lg bg-surface-sunken px-2.5 py-2 text-xs text-content-tertiary">
                  {t('inbox.notice.noReply')}
                </p>
              ) : (
                replies.map((reply, index) => (
                  <div
                    key={reply.id}
                    className={cn(
                      'rounded-lg px-2.5 py-1.5 text-sm',
                      index < notice.replies.quoted.length
                        ? 'bg-primary-subtle/60 ring-1 ring-primary/20'
                        : 'bg-surface-sunken',
                    )}
                  >
                    <span className="block text-[10px] font-semibold text-primary-text">
                      {reply.author ?? t('inbox.notice.agent')}
                      {index >= notice.replies.quoted.length && ` · ${t('inbox.notice.inGroup')}`}
                    </span>
                    {reply.imageId && (
                      <a href={`/api/inbox/images/${reply.imageId}`} target="_blank" rel="noopener noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/api/inbox/images/${reply.imageId}`} alt="" className="my-1 max-h-32 rounded" />
                      </a>
                    )}
                    <span className="whitespace-pre-wrap break-words">{reply.text}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </section>

        {/* The teller's word. */}
        {notice.sentAt && (
          <section className="rounded-xl bg-surface p-3 ring-1 ring-border-subtle">
            {decided ? (
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 text-sm font-bold',
                    notice.status === 'CONFIRMED' ? 'text-success-text' : 'text-danger-text',
                  )}
                >
                  {notice.status === 'CONFIRMED' ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
                  {t(`inbox.notice.status.${notice.status}`)}
                  {notice.decidedByName && <span className="font-normal text-content-tertiary">· {notice.decidedByName}</span>}
                </span>
                {!notice.transactionId && (
                <button
                  type="button"
                  onClick={() => void act('reopen', { action: 'reopen' })}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-content-tertiary hover:text-content"
                >
                  <RotateCcw className="size-3.5" />
                  {t('inbox.notice.reopen')}
                </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="primary"
                  icon={<CheckCircle2 />}
                  loading={busy === 'CONFIRMED'}
                  onClick={() => void act('CONFIRMED', { action: 'decide', decision: 'CONFIRMED' }, t('inbox.notice.confirmed'))}
                  className="bg-success hover:bg-success/90"
                >
                  {t('inbox.notice.confirm')}
                </Button>
                <Button
                  variant="secondary"
                  icon={<XCircle />}
                  loading={busy === 'REJECTED'}
                  onClick={() => void act('REJECTED', { action: 'decide', decision: 'REJECTED' }, t('inbox.notice.rejected'))}
                  className="text-danger-text"
                >
                  {t('inbox.notice.reject')}
                </Button>
              </div>
            )}
            {notice.status === 'CONFIRMED' && notice.transactionId && (
              <Link
                href={`/manage/transactions/${notice.transactionId}`}
                className="mt-2 flex items-center gap-2 rounded-lg bg-success-subtle/60 px-2.5 py-2 text-xs font-semibold text-success-text hover:underline"
              >
                <Receipt className="size-4" />
                {t('inbox.remit.made')}
              </Link>
            )}
          </section>
        )}
        {notice.status === 'CONFIRMED' && !notice.transactionId && (
          <RemitForm
            noticeId={notice.id}
            network={notice.network}
            amount={notice.amount}
            currency={notice.currency}
            customerName={notice.customerName}
            onDone={(result) => {
              setNotice(result.notice as NoticeDetail);
              onChanged();
              onDraft?.(notice.chatId, result.draft);
            }}
          />
        )}
      </div>
    </div>
  );
}
