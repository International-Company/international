'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ImageUp,
  RotateCcw,
  ArrowRight,
  Check,
  CheckCircle2,
  ClipboardList,
  Clock,
  Copy,
  CornerUpRight,
  ExternalLink,
  Globe,
  Pencil,
  Inbox,
  MessageSquare,
  Route,
  Server,
  Undo2,
  Wallet,
  X,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Button, Card, EmptyState, Skeleton } from '@/ui/primitives';
import { Field, Input, Select } from '@/ui/form';
import { Money } from '@/ui/display';
import { ConfirmDialog, useToast } from '@/ui/overlay';
import { shrinkPhoto } from '@/ui/proof-photo';
import { cn } from '@/ui/utils';
import { clockOf, dayKey, dayLabel } from './days';
import { keyOf, stateOf, type Line, type LineState } from './desk-types';
import { MessageTrace } from './message-trace';
import { ReceiptsPanel } from './receipts-panel';
import { PartsBar } from './parts';
import { BankMark } from './bank-view';
import type { Group } from './forward-panel';

/** What the trace says of the transfer's message: where it was written, by whom, and where it went. */
interface TraceView {
  message: {
    id: string;
    group: string;
    fromMe: boolean;
    senderName: string | null;
    senderPhone: string | null;
    text: string;
    mediaId: string | null;
    mediaKind: string | null;
    at: string;
  };
  suggested: { account: string; name: string | null; channel: string | null; amount: string; currency: string } | null;
  forwards: { group: string; at: string; delivered: boolean }[];
  deal: { by: string | null } | null;
}

/** The colours and words of where a transfer stands. */
export const STATE_STYLE = {
  waiting: { chip: 'bg-warning-subtle text-warning-text', key: 'bankDesk.state.waiting' as const },
  forwarded: { chip: 'bg-primary-subtle text-primary-text', key: 'bankDesk.state.forwarded' as const },
  done: { chip: 'bg-success-subtle text-success-text', key: 'bankDesk.state.done' as const },
  reversed: { chip: 'bg-danger-subtle text-danger-text', key: 'bankDesk.state.reversed' as const },
  message: { chip: 'bg-surface-sunken text-content-secondary', key: 'bankDesk.state.message' as const },
} satisfies Record<LineState, { chip: string; key: string }>;

interface Detail {
  id: string;
  reference: string;
  kind: string;
  at: string;
  status: string;
  channel: string | null;
  account: string | null;
  name: string | null;
  phone: string | null;
  amount: string;
  currency: string;
  notes: string | null;
  by: string | null;
  sentAt: string | null;
  sentBy: string | null;
  fromCurrency: string;
  fromAmount: string;
  toAmount: string;
  rate: string;
  intakeCash: string;
  intakeTransfer: string;
  intakeChannel: string | null;
  payoutCash: string;
  customerCode: string | null;
  counterpartyName: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  recipientIdNumber: string | null;
  delivered: { amount: string; unit: string } | null;
  branch: string | null;
  proofs?: { id: string; kind: string }[];
  /** A request from a group: the message it was read from, and how it was added. */
  source?: 'deal' | 'group' | 'message' | 'tiktok';
  message?: string;
  senderPhone?: string | null;
  auto?: boolean;
  addedByName?: string | null;
  receiptId?: string | null;
  origin?: { kind: 'system' | 'external'; name: string | null; phone: string | null };
}

/** A 1e8-scaled rate as the counter reads it: "3.65", "0.2740". */
function rateText(scaled: string): string {
  const value = Number(scaled) / 1e8;
  return value >= 1 ? value.toFixed(4).replace(/0{1,2}$/, '') : value.toFixed(4);
}

/** A stored amount as the bank's app takes it: "320", "12.5". */
function plain(scaled: string): string {
  const value = Number(scaled) / 1e8;
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '');
}

/**
 * The middle column: one transfer in full. Where it came from first — the
 * system and who recorded it, or a number outside the office — then the day and
 * the hour, where it goes and to whom, the message it came as, the deal behind
 * it, its photos, and how far it has got; and the buttons that move it on. A
 * message of the group the bot did not take can be added to the list from here.
 */
export function TransferDetail({
  line,
  version = 0,
  onSend,
  onChanged,
  onAdded,
  onBack,
  executors = [],
  onForward,
  className,
}: {
  line: Line | null;
  /** Bumped when the list was asked again: the column asks again too. */
  version?: number;
  /** Opens the "sent" confirmation for this transfer. */
  onSend: (line: Line) => void;
  /** Something changed that the list should show. */
  onChanged?: () => void;
  /** A message was added to the list as a request: the list should choose it. */
  onAdded?: (key: string) => void;
  /** On a phone: back to the list. */
  onBack?: () => void;
  /** The pinned executing groups, offered as quick buttons. */
  executors?: Group[];
  /** Opens the forward sheet, with these groups ticked when a quick button was pressed. */
  onForward?: (preset?: Group[]) => void;
  className?: string;
}) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [trace, setTrace] = useState<TraceView | null>(null);
  const [failed, setFailed] = useState(false);
  const [tracing, setTracing] = useState<string | null>(null);
  /** A bare message being added to the list, from what the bot read off it. */
  const [adding, setAdding] = useState<{ account: string; name: string; channel: string; amount: string; currency: string } | null>(null);
  const [channels, setChannels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  /** What the bot read, being corrected by hand. */
  const [editing, setEditing] = useState<{ account: string; name: string; channel: string; amount: string; currency: string } | null>(null);
  /** Taking the forward back: asked first, and whether the copies in the groups go too. */
  const [unforwarding, setUnforwarding] = useState(false);
  const [dropCopies, setDropCopies] = useState(true);
  const [unforwardBusy, setUnforwardBusy] = useState(false);
  /** Sent by mistake, being put back to waiting; or its receipt being replaced. */
  const [reopening, setReopening] = useState(false);
  const [correcting, setCorrecting] = useState<'reopen' | 'receipt' | null>(null);
  const receiptPicker = useRef<HTMLInputElement>(null);
  const key = line ? keyOf(line) : null;
  /** The tellers' Jawwal Pay wallets it may be handed to, and the one holding it, if any. */
  const [walletHold, setWalletHold] = useState<{
    wallets: { id: string; name: string; teller: string; balance: string; currency: string }[];
    held: { id: string; status: 'ASSIGNED' | 'DONE'; tellerName: string }[];
  } | null>(null);
  const [pickingWallet, setPickingWallet] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const loadWallets = useCallback(() => {
    if (!line || line.source === 'message') {
      setWalletHold(null);
      return;
    }
    api
      .get<NonNullable<typeof walletHold>>(`/api/ewallets/choices?refs=${line.id}`)
      .then(setWalletHold)
      .catch(() => setWalletHold(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    setPickingWallet(false);
    loadWallets();
  }, [loadWallets, version]);

  const failure = useCallback(
    (cause: unknown) =>
      toast.error(
        t('errors.title'),
        cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'),
      ),
    [toast, t],
  );

  useEffect(() => {
    if (!line) {
      setDetail(null);
      setTrace(null);
      return;
    }
    let gone = false;
    setFailed(false);
    const firstLook = !detail || keyOf(detail as unknown as Line) !== key;
    if (firstLook) {
      setDetail(null);
      setTrace(null);
      setAdding(null);
    }
    const tracing = line.messageId
      ? api.get<TraceView>(`/api/bank/groups/messages/${line.messageId}/trace`).catch(() => null)
      : Promise.resolve(null);
    const reading =
      line.source === 'message'
        ? Promise.resolve(null)
        : api.get<Detail>(
            line.source === 'group'
              ? `/api/bank/requests/${line.id}`
              : line.source === 'tiktok'
                ? `/api/bank/tiktok/${line.id}`
                : `/api/bank/${line.id}`,
          );
    Promise.all([reading, tracing])
      .then(([read, traced]) => {
        if (gone) return;
        setTrace(traced);
        // A bare message has no record of its own: what the list knows, and its words.
        setDetail(
          read ? { ...read, origin: read.origin ?? line.origin } : {
            ...line,
            status: 'MESSAGE',
            fromCurrency: '',
            fromAmount: '0',
            toAmount: '0',
            rate: '0',
            intakeCash: '0',
            intakeTransfer: '0',
            intakeChannel: null,
            payoutCash: '0',
            customerCode: null,
            counterpartyName: null,
            recipientName: null,
            recipientPhone: null,
            recipientIdNumber: null,
            delivered: null,
            branch: null,
            source: 'message',
            message: traced?.message.text ?? line.text ?? '',
            senderPhone: line.origin?.phone ?? null,
          },
        );
      })
      .catch(() => {
        if (!gone) setFailed(true);
      });
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);

  // The banks a request added by hand may name.
  useEffect(() => {
    if ((line?.source !== 'message' && line?.source !== 'group') || channels.length) return;
    api
      .get<{ channels: string[] }>('/api/bank/groups')
      .then((result) => setChannels(result.channels))
      .catch(() => undefined);
  }, [line?.source, channels.length]);

  if (!line) {
    return (
      <Card className={cn('flex flex-col items-center justify-center p-6', className)}>
        <EmptyState icon={<Inbox />} title={t('bankDesk.pickTitle')} description={t('bankDesk.pickHint')} />
      </Card>
    );
  }

  // Which of the desk's three it is, as the correction asks for it.
  const deskKind = line.source === 'group' ? 'request' : line.source === 'tiktok' ? 'tiktok' : 'deal';

  /** Marked sent by mistake: back to waiting. */
  const reopen = async () => {
    setCorrecting('reopen');
    try {
      await api.post('/api/bank/correct', { action: 'reopen', kind: deskKind, id: line.id });
      toast.success(t('bankFix.reopened'));
      setReopening(false);
      onChanged?.();
    } catch (cause) {
      failure(cause);
    } finally {
      setCorrecting(null);
    }
  };

  /** The right receipt in place of the one kept. */
  const changeReceipt = async (file: File | undefined) => {
    if (!file) return;
    setCorrecting('receipt');
    try {
      const receipt = await shrinkPhoto(file);
      await api.post('/api/bank/correct', { action: 'receipt', kind: deskKind, id: line.id, receipt });
      toast.success(t('bankFix.receiptChanged'));
      onChanged?.();
    } catch (cause) {
      failure(cause);
    } finally {
      setCorrecting(null);
    }
  };

  const addToList = async () => {
    if (!adding || !line.messageId) return;
    setBusy(true);
    try {
      const result = await api.post<{ id: string }>('/api/bank/requests', {
        messageId: line.messageId,
        account: adding.account.trim(),
        name: adding.name.trim() || null,
        channel: adding.channel || null,
        amount: adding.amount.trim(),
        currency: adding.currency,
      });
      toast.success(t('bankFeed.added'));
      setAdding(null);
      onAdded?.(keyOf({ id: result.id, source: 'group' }));
      onChanged?.();
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await api.patch(`/api/bank/requests/${line.id}`, {
        account: editing.account.trim(),
        name: editing.name.trim() || null,
        channel: editing.channel || null,
        amount: editing.amount.trim(),
        currency: editing.currency,
      });
      toast.success(t('bankDesk.edited'));
      setEditing(null);
      onChanged?.();
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(false);
    }
  };

  const state = stateOf(line);
  const when = (at: string) =>
    `${dayLabel(dayKey(at), locale, { today: t('bank.period.today'), yesterday: t('bank.period.yesterday') })} · ${clockOf(at)}`;
  // Who began it, where and when: the trace's message, when it was kept.
  const sender = trace?.message;

  const copy = (value: string, what: string) => {
    void navigator.clipboard?.writeText(value);
    toast.success(t('bank.copied'), what);
  };

  const Row = ({ label, children, copyable }: { label: string; children: ReactNode; copyable?: string }) => (
    <div className="flex items-start justify-between gap-3 py-2">
      <dt className="shrink-0 text-xs text-content-tertiary">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5 text-end text-sm font-medium text-content">
        <span className="min-w-0 break-words">{children}</span>
        {copyable && (
          <button
            type="button"
            onClick={() => copy(copyable, label)}
            aria-label={label}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-content-tertiary hover:bg-surface-sunken hover:text-primary-text"
          >
            <Copy className="size-3.5" />
          </button>
        )}
      </dd>
    </div>
  );

  const Section = ({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) => (
    <section className="rounded-2xl bg-surface p-3 ring-1 ring-border-subtle">
      <h3 className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-content-tertiary">
        {title}
        {action}
      </h3>
      <dl className="divide-y divide-border-subtle">{children}</dl>
    </section>
  );

  const pending = detail?.status === 'PENDING_TRANSFER';

  /** The forward taken back: the transfer waits again. */
  const takeBack = async () => {
    if (!line.messageId) return;
    setUnforwardBusy(true);
    try {
      const result = await api.post<{ removed: number; deleted: number }>(
        `/api/bank/groups/messages/${line.messageId}/unforward`,
        { deleteCopies: dropCopies },
      );
      toast.success(
        t('bankDesk.unforwarded'),
        result.deleted > 0 ? t('bankDesk.unforwardedDeleted', { count: result.deleted }) : undefined,
      );
      setUnforwarding(false);
      onChanged?.();
    } catch (cause) {
      failure(cause);
    } finally {
      setUnforwardBusy(false);
    }
  };
  /** Where one of its photos is read from: a deal's, or a TikTok withdrawal's. */
  const proofUrl = (proofId: string) =>
    detail?.source === 'tiktok'
      ? `/api/bank/tiktok/${detail.id}/photos/${proofId}`
      : `/api/bank/${detail?.id}/proofs/${proofId}`;

  return (
    <Card className={cn('flex flex-col overflow-hidden bg-surface-sunken p-0', className)}>
        {/* --- The head: what it is, the sum beside its bank, when and by whom, and how far it got --- */}
        <header className="border-b border-border-subtle bg-surface px-4 pb-3 pt-3">
          <div className="flex items-center gap-2">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                aria-label={t('common.back')}
                className="-ms-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full text-content-tertiary hover:bg-surface-sunken hover:text-content lg:hidden"
              >
                <ArrowRight className="size-4 rtl:rotate-0 ltr:rotate-180" />
              </button>
            )}
            <span className="truncate text-xs font-semibold text-content-secondary">{line.kind}</span>
            {line.source !== 'message' && (
              <span className="truncate font-mono text-[11px] text-content-tertiary ltr-content">{line.reference}</span>
            )}
            <span
              className={cn(
                'ms-auto inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold',
                STATE_STYLE[state].chip,
              )}
            >
              <span className="size-1.5 rounded-full bg-current" aria-hidden />
              {t(STATE_STYLE[state].key)}
            </span>
          </div>

          {detail && BigInt(detail.amount || '0') > 0n && (
            <div className="mt-3 flex items-center gap-3">
              <BankMark line={line} className="size-12 text-sm" />
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => copy(plain(detail.amount), t('bank.amount'))}
                  className="group/amount inline-flex items-center gap-2"
                  title={t('bank.amount')}
                >
                  <Money
                    value={detail.amount}
                    currency={detail.currency}
                    className="text-[28px] font-extrabold leading-none tracking-tight text-content"
                  />
                  <Copy className="size-4 text-content-tertiary opacity-0 transition-opacity group-hover/amount:opacity-100" />
                </button>
                <PartsBar
                  amount={detail.amount}
                  paid={line.paid}
                  currency={detail.currency}
                  size="lg"
                  closed={stateOf(line) === 'done'}
                  className="mt-2 max-w-xs"
                />
                <p className="mt-1 text-sm font-semibold text-content">{detail.channel ?? t('bank.noChannel')}</p>
                <p className="mt-0.5 flex items-center gap-1 text-xs text-content-secondary">
                  <Clock className="size-3.5 shrink-0 text-content-tertiary" />
                  <span className="truncate">
                    <span className="tabular-nums">{when(detail.at)}</span>
                    {detail.by && <> · {detail.by}</>}
                    {detail.branch && <> · {detail.branch}</>}
                  </span>
                </p>
              </div>
            </div>
          )}

          {/* How far it got: arrived, passed on, sent. */}
          {detail && line.messageId && (
            <div className="mt-3 flex items-center gap-3 border-t border-border-subtle pt-3">
              {(() => {
                const steps = [
                  { done: true, icon: <MessageSquare className="size-3" />, label: t('bankDesk.stepWritten'), at: sender?.at ?? line.at },
                  ...(line.source === 'message'
                    ? []
                    : [
                        {
                          done: (trace?.forwards.length ?? 0) > 0 || (line.forwardedTo?.length ?? 0) > 0,
                          icon: <CornerUpRight className="size-3" />,
                          label: t('bankDesk.stepForwarded'),
                          at: trace?.forwards.at(-1)?.at ?? line.forwardedTo?.at(-1)?.at ?? null,
                        },
                        {
                          done: state === 'done',
                          icon: <CheckCircle2 className="size-3" />,
                          label: t('bankDesk.stepDone'),
                          at: detail.sentAt,
                        },
                      ]),
                ];
                return (
                  <ol className="flex min-w-0 flex-1 items-center gap-1.5">
                    {steps.map((step, index) => (
                      <li key={step.label} className={cn('flex items-center gap-1.5', index > 0 && 'min-w-0 flex-1')}>
                        {index > 0 && (
                          <span
                            className={cn('h-0.5 min-w-2 flex-1 rounded-full', step.done ? 'bg-success' : 'bg-border-subtle')}
                            aria-hidden
                          />
                        )}
                        <span
                          className={cn(
                            'flex size-6 shrink-0 items-center justify-center rounded-full',
                            step.done ? 'bg-success text-white' : 'bg-surface-sunken text-content-tertiary ring-1 ring-border-subtle',
                          )}
                        >
                          {step.icon}
                        </span>
                        <span className="flex min-w-0 flex-col leading-tight">
                          <span className={cn('whitespace-nowrap text-[11px] font-semibold', step.done ? 'text-content' : 'text-content-tertiary')}>
                            {step.label}
                          </span>
                          <span className="text-[10px] tabular-nums text-content-tertiary ltr-content">
                            {step.done && step.at ? clockOf(step.at) : '—'}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                );
              })()}
              <button
                type="button"
                onClick={() => setTracing(line.messageId!)}
                title={t('bankDesk.fullPath')}
                className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold text-primary-text hover:bg-primary-subtle"
              >
                <Route className="size-3.5" />
                <span className="hidden sm:inline">{t('bankDesk.fullPath')}</span>
              </button>
            </div>
          )}
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {failed ? (
            <p className="p-4 text-center text-sm text-danger-text">{t('errors.generic')}</p>
          ) : !detail ? (
            <>
              <Skeleton className="h-20" />
              <Skeleton className="h-40" />
              <Skeleton className="h-32" />
            </>
          ) : (
            <>
              {/* --- Where it came from: the system, or a number outside the office --- */}
              {detail.origin && (
                <div className="flex items-center gap-3 rounded-2xl bg-surface px-3 py-2.5 ring-1 ring-border-subtle">
                  <span
                    className={cn(
                      'flex size-9 shrink-0 items-center justify-center rounded-xl',
                      detail.origin.kind === 'external'
                        ? 'bg-warning-subtle text-warning-text'
                        : 'bg-success-subtle text-success-text',
                    )}
                  >
                    {detail.origin.kind === 'external' ? <Globe className="size-4" /> : <Server className="size-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold text-content">
                      {detail.origin.kind === 'external' ? t('bank.originExternalLong') : t('bank.originSystemLong')}
                    </p>
                    <p className="truncate text-[11px] text-content-tertiary">
                      {detail.origin.kind === 'external' ? t('bank.originSender') : t('bank.originRecordedBy')}{' '}
                      <span className="font-semibold text-content-secondary">
                        {detail.origin.kind === 'external'
                          ? (sender?.senderName ?? detail.origin.name ?? '—')
                          : (trace?.deal?.by ?? detail.origin.name ?? '—')}
                      </span>
                      {sender && <> · {t('bank.originIn', { group: sender.group })}</>}
                    </p>
                  </div>
                  {detail.origin.phone && (
                    <button
                      type="button"
                      onClick={() => copy(detail.origin!.phone!, t('bank.phone'))}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-sunken px-2.5 py-1 text-[11px] font-semibold text-content ltr-content hover:text-primary-text"
                    >
                      +{detail.origin.phone}
                      <Copy className="size-3" />
                    </button>
                  )}
                </div>
              )}

              {detail.source === 'message' && (
                <section className="rounded-2xl bg-surface p-3 ring-1 ring-border-subtle">
                  <h3 className="mb-2 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-content-tertiary">
                    <MessageSquare className="size-3" />
                    {t('bank.detailMessage')}
                  </h3>
                  {sender?.mediaId && sender.mediaKind === 'image' && (
                    <a href={`/api/bank/groups/media/${sender.mediaId}`} target="_blank" rel="noopener noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/bank/groups/media/${sender.mediaId}`}
                        alt=""
                        className="mb-2 max-h-48 rounded-lg object-contain ring-1 ring-border-subtle"
                      />
                    </a>
                  )}
                  <p className="whitespace-pre-wrap break-words rounded-xl bg-surface-sunken p-3 text-sm text-content">
                    {detail.message || '📎'}
                  </p>

                  {/* Not in the list: added by hand, from what the bot read. */}
                  {!adding ? (
                    <button
                      type="button"
                      onClick={() => {
                        const read = trace?.suggested;
                        setAdding({
                          account: read?.account ?? '',
                          name: read?.name ?? '',
                          channel: read?.channel ?? channels[0] ?? '',
                          amount: read ? String(Number(read.amount) / 1e8) : '',
                          currency: read?.currency ?? 'ILS',
                        });
                      }}
                      className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-warning/50 bg-warning-subtle/40 px-3 py-2.5 text-xs font-semibold text-warning-text hover:bg-warning-subtle"
                    >
                      <ClipboardList className="size-4" />
                      {trace?.suggested ? t('bankDesk.addRead') : t('bankFeed.addToList')}
                    </button>
                  ) : (
                    <div className="mt-3 space-y-2.5 rounded-xl bg-surface-sunken/60 p-3 ring-1 ring-border-subtle">
                      <p className="text-xs font-semibold text-content">{t('bankFeed.addTitle')}</p>
                      <div className="grid gap-2.5 sm:grid-cols-2">
                        <Field label={t('bank.account')} required>
                          {(props) => (
                            <Input
                              {...props}
                              dir="ltr"
                              value={adding.account}
                              onChange={(event) => setAdding({ ...adding, account: event.target.value })}
                            />
                          )}
                        </Field>
                        <Field label={t('bank.name')}>
                          {(props) => (
                            <Input
                              {...props}
                              value={adding.name}
                              onChange={(event) => setAdding({ ...adding, name: event.target.value })}
                            />
                          )}
                        </Field>
                        <Field label={t('bankFeed.channel')}>
                          {(props) => (
                            <Select
                              {...props}
                              options={[
                                { value: '', label: '—' },
                                ...channels.map((entry) => ({ value: entry, label: entry })),
                              ]}
                              value={adding.channel}
                              onChange={(event) => setAdding({ ...adding, channel: event.target.value })}
                            />
                          )}
                        </Field>
                        <div className="grid grid-cols-[1fr_5.5rem] gap-2">
                          <Field label={t('bank.amount')} required>
                            {(props) => (
                              <Input
                                {...props}
                                dir="ltr"
                                inputMode="decimal"
                                value={adding.amount}
                                onChange={(event) => setAdding({ ...adding, amount: event.target.value })}
                              />
                            )}
                          </Field>
                          <Field label={t('bank.currency')}>
                            {(props) => (
                              <Select
                                {...props}
                                options={['ILS', 'USD', 'JOD', 'EUR'].map((code) => ({ value: code, label: code }))}
                                value={adding.currency}
                                onChange={(event) => setAdding({ ...adding, currency: event.target.value })}
                              />
                            )}
                          </Field>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="primary"
                          size="sm"
                          loading={busy}
                          icon={<Check />}
                          disabled={!adding.account.trim() || !(Number(adding.amount) > 0)}
                          onClick={() => void addToList()}
                        >
                          {t('bankFeed.addToList')}
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => setAdding(null)} disabled={busy}>
                          {t('common.cancel')}
                        </Button>
                      </div>
                    </div>
                  )}
                </section>
              )}

              {/* --- Where it goes: corrected by hand while a request waits --- */}
              {detail.source === 'group' && editing && (
                <section className="space-y-2.5 rounded-2xl bg-surface p-3 ring-2 ring-primary/40">
                  <h3 className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-primary-text">
                    <Pencil className="size-3" />
                    {t('bankDesk.editTitle')}
                  </h3>
                  <div className="grid gap-2.5 sm:grid-cols-2">
                        <Field label={t('bank.account')} required>
                          {(props) => (
                            <Input
                              {...props}
                              dir="ltr"
                              value={editing.account}
                              onChange={(event) => setEditing({ ...editing, account: event.target.value })}
                            />
                          )}
                        </Field>
                        <Field label={t('bank.name')}>
                          {(props) => (
                            <Input
                              {...props}
                              value={editing.name}
                              onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                            />
                          )}
                        </Field>
                    <Field label={t('bankFeed.channel')}>
                      {(props) => (
                        <Select
                          {...props}
                          options={[
                            { value: '', label: '—' },
                            ...[...new Set([...(editing.channel ? [editing.channel] : []), ...channels])].map((entry) => ({ value: entry, label: entry })),
                          ]}
                          value={editing.channel}
                          onChange={(event) => setEditing({ ...editing, channel: event.target.value })}
                        />
                      )}
                    </Field>
                    <div className="grid grid-cols-[1fr_5.5rem] gap-2">
                        <Field label={t('bank.amount')} required>
                          {(props) => (
                            <Input
                              {...props}
                              dir="ltr"
                              inputMode="decimal"
                              value={editing.amount}
                              onChange={(event) => setEditing({ ...editing, amount: event.target.value })}
                            />
                          )}
                        </Field>
                      <Field label={t('bank.currency')}>
                        {(props) => (
                          <Select
                            {...props}
                            options={['ILS', 'USD', 'JOD', 'EUR'].map((code) => ({ value: code, label: code }))}
                            value={editing.currency}
                            onChange={(event) => setEditing({ ...editing, currency: event.target.value })}
                          />
                        )}
                      </Field>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      loading={busy}
                      icon={<Check />}
                      disabled={!editing.account.trim() || !(Number(editing.amount) > 0)}
                      onClick={() => void saveEdit()}
                    >
                      {t('common.save')}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setEditing(null)} disabled={busy}>
                      {t('common.cancel')}
                    </Button>
                  </div>
                </section>
              )}
              {detail.source !== 'message' && !(detail.source === 'group' && editing) && (
              <section className="rounded-2xl bg-surface p-3 ring-1 ring-border-subtle">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-content-tertiary">
                    {t('bank.detailTo')}
                  </h3>
                  <span className="flex items-center gap-1">
                    {detail.source === 'group' && pending && (
                      <button
                        type="button"
                        onClick={() =>
                          setEditing({
                            account: detail.account ?? '',
                            name: detail.name ?? '',
                            channel: detail.channel ?? '',
                            amount: plain(detail.amount),
                            currency: detail.currency,
                          })
                        }
                        className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold text-primary-text hover:bg-primary-subtle"
                      >
                        <Pencil className="size-3" />
                        {t('bankDesk.edit')}
                      </button>
                    )}
                    {(detail.account || detail.name) && (
                      <button
                        type="button"
                        onClick={() =>
                          copy(
                            [detail.account, detail.name, plain(detail.amount)].filter(Boolean).join('\n'),
                            t('bankDesk.copyAll'),
                          )
                        }
                        className="inline-flex items-center gap-1 rounded-full bg-primary-subtle px-2.5 py-1 text-[11px] font-semibold text-primary-text hover:bg-primary/15"
                      >
                        <Copy className="size-3" />
                        {t('bankDesk.copyAll')}
                      </button>
                    )}
                  </span>
                </div>

                <div className="grid gap-2">
                  {detail.account && (
                    <button
                      type="button"
                      onClick={() => copy(detail.account!, t('bank.account'))}
                      className="group/tile flex items-center justify-between gap-3 rounded-xl bg-surface-sunken px-3 py-2.5 text-start ring-1 ring-transparent transition hover:ring-primary/30"
                    >
                      <span className="min-w-0">
                        <span className="block text-[11px] text-content-tertiary">{t('bank.account')}</span>
                        <span className="block truncate font-mono text-lg font-bold tabular-nums text-content ltr-content">
                          {detail.account}
                        </span>
                      </span>
                      <Copy className="size-4 shrink-0 text-content-tertiary group-hover/tile:text-primary-text" />
                    </button>
                  )}
                  {detail.name && (
                    <button
                      type="button"
                      onClick={() => copy(detail.name!, t('bank.name'))}
                      className="group/tile flex items-center justify-between gap-3 rounded-xl bg-surface-sunken px-3 py-2.5 text-start ring-1 ring-transparent transition hover:ring-primary/30"
                    >
                      <span className="min-w-0">
                        <span className="block text-[11px] text-content-tertiary">{t('bank.name')}</span>
                        <span className="block truncate text-base font-bold text-content">{detail.name}</span>
                      </span>
                      <Copy className="size-4 shrink-0 text-content-tertiary group-hover/tile:text-primary-text" />
                    </button>
                  )}
                </div>

                {((detail.phone && detail.phone !== detail.account) || detail.recipientIdNumber || detail.customerCode) && (
                  <dl className="mt-1 divide-y divide-border-subtle">
                    {detail.phone && detail.phone !== detail.account && (
                      <Row label={t('bank.phone')} copyable={detail.phone}>
                        <span className="tabular-nums ltr-content">{detail.phone}</span>
                      </Row>
                    )}
                    {detail.recipientIdNumber && (
                      <Row label={t('remittance.recipientIdNumber')} copyable={detail.recipientIdNumber}>
                        <span className="tabular-nums ltr-content">{detail.recipientIdNumber}</span>
                      </Row>
                    )}
                    {detail.customerCode && (
                      <Row label={t('bank.customer')}>
                        <span className="font-mono text-xs ltr-content">{detail.customerCode}</span>
                      </Row>
                    )}
                  </dl>
                )}
              </section>
              )}

              {/* --- A deal's own message in the group, as it went out --- */}
              {detail.source === 'deal' && sender && (
                <details className="group rounded-2xl bg-surface p-3 ring-1 ring-border-subtle">
                  <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-content-tertiary">
                    <MessageSquare className="size-3" />
                    {t('bank.detailMessage')} · {sender.group}
                    <span className="ms-auto text-[10px] normal-case group-open:hidden">{t('bankDesk.showMore')}</span>
                  </summary>
                  <p className="mt-2 whitespace-pre-wrap break-words rounded-xl bg-surface-sunken p-3 text-sm text-content">
                    {sender.text || '📎'}
                  </p>
                </details>
              )}

              {/* --- A group's request: the message it came as, and who sent it --- */}
              {detail.source === 'group' && (
                <section className="rounded-2xl bg-surface p-3 ring-1 ring-border-subtle">
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-content-tertiary">
                    {t('bank.detailMessage')} · {detail.reference}
                  </h3>
                  <p className="mb-2 text-xs text-content-secondary">
                    {detail.by}
                    {detail.senderPhone && <span className="ms-1 ltr-content">+{detail.senderPhone}</span>}
                    {' · '}
                    {detail.auto ? t('bank.readByBot') : t('bank.addedBy', { name: detail.addedByName ?? '' })}
                  </p>
                  <p className="whitespace-pre-wrap rounded-xl bg-surface-sunken p-3 text-sm text-content">
                    {detail.message}
                  </p>
                </section>
              )}

              {/* --- The deal behind it --- */}
              {(detail.source === 'deal' || detail.source === 'tiktok') && (
              <Section title={t('bank.detailDeal')}>
                <Row label={t('bank.detailPaid')}>
                  <Money value={detail.fromAmount} currency={detail.fromCurrency} />
                </Row>
                <Row label={t('bank.detailGot')}>
                  <Money value={detail.toAmount} currency={detail.currency} />
                </Row>
                {detail.fromCurrency !== detail.currency && (
                  <Row label={t('bank.detailRate')}>
                    <span className="tabular-nums ltr-content">{rateText(detail.rate)}</span>
                  </Row>
                )}
                <Row label={t('bank.detailHow')}>
                  {BigInt(detail.payoutCash) > 0n ? (
                    <span>
                      {t('bank.detailSplit')} · <Money value={detail.amount} currency={detail.currency} /> +{' '}
                      <Money value={detail.payoutCash} currency={detail.currency} />
                    </span>
                  ) : (
                    t('bank.detailAllTransfer')
                  )}
                </Row>
                {BigInt(detail.intakeTransfer) > 0n && (
                  <Row label={t('bank.detailPaidBy')}>
                    {detail.intakeChannel ?? '—'} · <Money value={detail.intakeTransfer} currency={detail.fromCurrency} />
                  </Row>
                )}
                {detail.delivered && (
                  <Row label={t('bank.detailDelivered')}>
                    <span className="tabular-nums">
                      {plain(detail.delivered.amount)} {detail.delivered.unit}
                    </span>
                  </Row>
                )}
                {detail.counterpartyName && detail.counterpartyName !== detail.name && (
                  <Row label={t('transactions.counterpartyName')}>{detail.counterpartyName}</Row>
                )}
                {detail.notes && <Row label={t('common.notes')}>{detail.notes}</Row>}
              </Section>
              )}

              {/* --- Its receipts: as many as it took, fetched from the groups too --- */}
              {detail.source !== 'message' && (
                <ReceiptsPanel kind={deskKind} id={detail.id} version={version} onChanged={onChanged} />
              )}

              {/* --- Its photos --- */}
              {(detail.proofs?.filter((proof) => proof.kind !== 'TRANSFER').length ?? 0) > 0 && (
                <section className="rounded-2xl bg-surface p-3 ring-1 ring-border-subtle">
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-content-tertiary">
                    {t('bank.detailPhotos')}
                  </h3>
                  <div className="grid grid-cols-3 gap-2">
                    {detail.proofs!.filter((proof) => proof.kind !== 'TRANSFER').map((proof) => (
                      <a key={proof.id} href={proofUrl(proof.id)} target="_blank" rel="noopener noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={proofUrl(proof.id)}
                          alt=""
                          className="aspect-square w-full rounded-lg object-cover ring-1 ring-border-subtle"
                        />
                      </a>
                    ))}
                  </div>
                </section>
              )}

              {detail.sentAt && (
                <section className="space-y-2 rounded-2xl bg-success-subtle/40 p-3 ring-1 ring-success/30">
                  <p className="text-center text-xs text-success-text">
                    ✅ {t('bank.detailSentAt', { day: dayKey(detail.sentAt), time: clockOf(detail.sentAt) })}
                    {detail.sentBy && <> · {detail.sentBy}</>}
                  </p>
                  {/* Put right after it was marked sent: the receipt, or the mark itself. */}
                  {detail.source !== 'message' && (
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        ref={receiptPicker}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(event) => {
                          void changeReceipt(event.target.files?.[0]);
                          event.target.value = '';
                        }}
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<ImageUp />}
                        loading={correcting === 'receipt'}
                        onClick={() => receiptPicker.current?.click()}
                      >
                        {t('bankFix.changeReceipt')}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<RotateCcw />}
                        onClick={() => setReopening(true)}
                        className="text-warning-text"
                      >
                        {t('bankFix.reopen')}
                      </Button>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>

        {/* --- Doing it: passed on with a tap to a pinned group, or sent --- */}
        {detail && (
          <footer className="space-y-2 border-t border-border-subtle bg-surface p-3">
            {line.messageId && state === 'forwarded' && (
              <div className="flex items-center justify-between gap-2 rounded-xl bg-primary-subtle/60 px-3 py-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5 font-semibold text-primary-text">
                  <CornerUpRight className="size-3.5 shrink-0" />
                  <span className="truncate">
                    {t('bankDesk.forwardedToNow', {
                      groups: (line.forwardedTo ?? []).map((entry) => entry.group).join('، '),
                    })}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setDropCopies(true);
                    setUnforwarding(true);
                  }}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 font-semibold text-danger-text ring-1 ring-danger/30 hover:bg-danger-subtle"
                >
                  <Undo2 className="size-3.5" />
                  {t('bankDesk.unforward')}
                </button>
              </div>
            )}
            {/* Passed on already: one group only — the way to another is taking it back, above. */}
            {line.messageId && state !== 'done' && state !== 'reversed' && state !== 'forwarded' && onForward && (
              <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
                <span className="shrink-0 text-[11px] font-semibold text-content-tertiary">{t('bankDesk.forwardTo')}</span>
                {executors.slice(0, 4).map((group) => {
                  const already = line.forwardedTo?.some((entry) => entry.group === group.name);
                  return (
                    <button
                      key={group.id}
                      type="button"
                      onClick={() => onForward([group])}
                      className={cn(
                        'inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] font-semibold ring-1 transition-colors',
                        already
                          ? 'bg-primary-subtle text-primary-text ring-primary/30'
                          : 'bg-surface text-content-secondary ring-border-subtle hover:bg-primary-subtle hover:text-primary-text',
                      )}
                    >
                      {already ? <Check className="size-3" /> : <CornerUpRight className="size-3" />}
                      {group.name}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => onForward()}
                  className="inline-flex h-7 shrink-0 items-center rounded-full px-2.5 text-[11px] font-semibold text-primary-text ring-1 ring-dashed ring-primary/40 hover:bg-primary-subtle"
                >
                  {executors.length ? t('bankDesk.otherGroupsShort') : t('bankDesk.chooseGroup')}
                </button>
              </div>
            )}
            {/* Handed to a teller's Jawwal Pay wallet: sent from it, and taken from it. */}
            {walletHold && walletHold.held[0] ? (
              <div className="flex items-center justify-between gap-2 rounded-xl bg-success-subtle/60 px-3 py-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5 font-semibold text-success-text">
                  <Wallet className="size-3.5 shrink-0" />
                  <span className="truncate">
                    {t(walletHold.held[0].status === 'DONE' ? 'ewallet.sentBy' : 'ewallet.heldBy', { name: walletHold.held[0].tellerName })}
                  </span>
                </span>
                {walletHold.held[0].status === 'ASSIGNED' && (
                  <button
                    type="button"
                    disabled={walletBusy}
                    onClick={async () => {
                      setWalletBusy(true);
                      try {
                        await api.delete(`/api/ewallets/assign/${walletHold.held[0]!.id}`);
                        toast.success(t('ewallet.unassigned'));
                        loadWallets();
                        onChanged?.();
                      } catch (cause) {
                        failure(cause);
                      } finally {
                        setWalletBusy(false);
                      }
                    }}
                    className="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 font-semibold text-danger-text ring-1 ring-danger/30 hover:bg-danger-subtle"
                  >
                    <Undo2 className="size-3.5" />
                    {t('ewallet.unassign')}
                  </button>
                )}
              </div>
            ) : (
              pending &&
              walletHold &&
              walletHold.wallets.length > 0 &&
              (pickingWallet ? (
                <div className="space-y-1.5 rounded-xl bg-surface-sunken p-2 ring-1 ring-border-subtle">
                  <p className="px-1 text-[11px] text-content-tertiary">{t('ewallet.assignHint')}</p>
                  {walletHold.wallets.map((wallet) => (
                    <button
                      key={wallet.id}
                      type="button"
                      disabled={walletBusy}
                      onClick={async () => {
                        setWalletBusy(true);
                        try {
                          await api.post('/api/ewallets/assign', { kind: deskKind, refId: line.id, drawerId: wallet.id });
                          toast.success(t('ewallet.assigned'), wallet.teller);
                          setPickingWallet(false);
                          loadWallets();
                          onChanged?.();
                        } catch (cause) {
                          failure(cause);
                        } finally {
                          setWalletBusy(false);
                        }
                      }}
                      className="flex w-full items-center justify-between gap-2 rounded-lg bg-surface px-3 py-2 text-start text-sm ring-1 ring-border-subtle hover:ring-primary disabled:opacity-60"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-content">{wallet.teller}</span>
                        <span className="block truncate text-[11px] text-content-tertiary">{wallet.name}</span>
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-content-secondary">
                        {t('ewallet.balanceNow')} <Money value={wallet.balance} currency={wallet.currency} />
                      </span>
                    </button>
                  ))}
                  <button type="button" onClick={() => setPickingWallet(false)} className="w-full py-1 text-[11px] text-content-tertiary hover:text-content">
                    {t('common.cancel')}
                  </button>
                </div>
              ) : (
                <Button variant="secondary" fullWidth icon={<Wallet />} onClick={() => setPickingWallet(true)}>
                  {t('ewallet.assign')}
                </Button>
              ))
            )}
            <div className="flex gap-2">
            {line.messageId && state !== 'done' && state !== 'reversed' && onForward && (
              <Button variant="secondary" icon={<CornerUpRight />} onClick={() => onForward()} className="shrink-0">
                {t('bankDesk.forwardTab')}
              </Button>
            )}
            {pending && (
              <Button variant="primary" fullWidth icon={<Check />} onClick={() => onSend(line)}>
                {t('bank.markSent')}
              </Button>
            )}
            {detail.source === 'group' ? (
              pending && (
                <button
                  type="button"
                  onClick={() => {
                    void api
                      .delete(`/api/bank/requests/${detail.id}`)
                      .then(() => {
                        toast.success(t('bank.dismissed'));
                        onChanged?.();
                      })
                      .catch(() => toast.error(t('errors.title'), t('errors.generic')));
                  }}
                  title={t('bank.dismiss')}
                  className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-3 text-sm font-medium text-danger-text ring-1 ring-border-subtle hover:bg-danger-subtle"
                >
                  <X className="size-4" />
                  <span className="hidden sm:inline">{t('bank.dismiss')}</span>
                </button>
              )
            ) : detail.source === 'deal' ? (
            <Link
              href={`/manage/transactions/${detail.id}`}
              title={t('bank.detailOpen')}
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-3 text-sm font-medium text-primary-text ring-1 ring-border-subtle hover:bg-surface-sunken"
            >
              <ExternalLink className="size-4" />
              <span className="hidden sm:inline">{t('bank.detailOpen')}</span>
            </Link>
            ) : null}
            </div>
          </footer>
        )}
      <MessageTrace id={tracing} onClose={() => setTracing(null)} onOpen={setTracing} />
      <ConfirmDialog
        open={reopening}
        onClose={() => setReopening(false)}
        onConfirm={() => void reopen()}
        title={t('bankFix.reopenTitle')}
        message={t('bankFix.reopenHint')}
        confirmLabel={t('bankFix.reopen')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        loading={correcting === 'reopen'}
      />
      <ConfirmDialog
        open={unforwarding}
        onClose={() => setUnforwarding(false)}
        onConfirm={() => void takeBack()}
        title={t('bankDesk.unforwardTitle')}
        message={t('bankDesk.unforwardHint')}
        confirmLabel={t('bankDesk.unforward')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        loading={unforwardBusy}
      >
        <label className="mt-3 flex items-start gap-2 text-sm text-content">
          <input
            type="checkbox"
            checked={dropCopies}
            onChange={(event) => setDropCopies(event.target.checked)}
            className="mt-0.5 size-4 accent-[var(--color-danger)]"
          />
          <span>
            {t('bankDesk.unforwardDelete')}
            <span className="block text-xs text-content-tertiary">{t('bankDesk.unforwardDeleteHint')}</span>
          </span>
        </label>
      </ConfirmDialog>
    </Card>
  );
}
