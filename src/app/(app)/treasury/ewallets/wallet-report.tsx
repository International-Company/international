'use client';

import { ArrowDownLeft, ArrowUpRight, CheckCircle2, Clock, Copy } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { Badge } from '@/ui/primitives';
import { DateText, Money } from '@/ui/display';
import { useToast } from '@/ui/overlay';
import { cn } from '@/ui/utils';

export interface Assignment {
  id: string;
  kind: 'deal' | 'request' | 'tiktok';
  refId: string;
  amount: string;
  sentAmount: string | null;
  currency: string;
  account: string | null;
  name: string | null;
  channel: string | null;
  status: 'ASSIGNED' | 'DONE' | 'CANCELLED';
  assignedByName: string | null;
  assignedAt: string;
  doneAt: string | null;
}

export interface CountRow {
  id: string;
  reference: string;
  expected: string;
  actual: string;
  difference: string;
  status: 'SUBMITTED' | 'CONFIRMED' | 'RETURNED';
  countedByName: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
  screenshotId: string | null;
}

export interface Report {
  wallet: { id: string; name: string; currency: string; balance: string; teller: { fullNameAr: string } | null };
  since: string | null;
  lastCount: CountRow | null;
  pendingCount: CountRow | null;
  opening: string;
  toppedUp: string;
  withdrawn: string;
  sent: string;
  adjusted: string;
  expected: string;
  movements: {
    id: string;
    direction: 'IN' | 'OUT';
    amount: string;
    balanceAfter: string;
    reason: string;
    note: string | null;
    createdAt: string;
    createdBy: { fullNameAr: string } | null;
  }[];
  waiting: Assignment[];
  done: Assignment[];
}

/** Copied with a tap, so nothing is retyped into the wallet's app. */
export function CopyChip({ value, label }: { value: string | null; label?: string }) {
  const toast = useToast();
  const { t } = useLocale();
  if (!value) return null;
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => toast.success(t('ewallet.copied'), value));
      }}
      className="inline-flex items-center gap-1 rounded-md bg-surface-sunken px-2 py-1 text-[13px] font-semibold text-content ring-1 ring-border-subtle hover:ring-primary"
    >
      <Copy className="size-3 text-content-tertiary" />
      <span className="ltr-content">{label ?? value}</span>
    </button>
  );
}

/**
 * The wallet since its last confirmed count: what it opened with, what came in,
 * what it sent, and what the books say it holds — the figure the app's balance
 * is counted against.
 */
export function WalletSummary({ report }: { report: Report }) {
  const { t } = useLocale();
  const currency = report.wallet.currency;
  const line = (label: string, value: string, tone?: 'in' | 'out' | 'total') => (
    <div
      className={cn(
        'flex items-center justify-between px-3 py-2 text-sm',
        tone === 'total' && 'bg-primary-subtle/60 font-bold text-primary-text',
      )}
    >
      <span className={tone === 'total' ? '' : 'text-content-secondary'}>{label}</span>
      <span className={cn('tabular-nums', tone === 'in' && 'text-success-text', tone === 'out' && 'text-danger-text')}>
        {tone === 'in' ? '+ ' : tone === 'out' ? '− ' : ''}
        <Money value={value} currency={currency} />
      </span>
    </div>
  );
  return (
    <div className="divide-y divide-border-subtle overflow-hidden rounded-xl ring-1 ring-border-subtle">
      {line(report.since ? t('ewallet.openingSince') : t('ewallet.opening'), report.opening)}
      {line(t('ewallet.toppedUp'), report.toppedUp, 'in')}
      {BigInt(report.withdrawn) > 0n && line(t('ewallet.withdrawn'), report.withdrawn, 'out')}
      {line(t('ewallet.sent', { count: report.done.length }), report.sent, 'out')}
      {BigInt(report.adjusted) !== 0n && line(t('ewallet.adjusted'), report.adjusted)}
      {line(t('ewallet.expected'), report.expected, 'total')}
    </div>
  );
}

const KIND_KEY = { deal: 'ewallet.kind.deal', request: 'ewallet.kind.request', tiktok: 'ewallet.kind.tiktok' } as const;

/** One transfer handed to the wallet: where it goes, to whom, how much. */
export function AssignmentRow({ row, action }: { row: Assignment; action?: React.ReactNode }) {
  const { t } = useLocale();
  const done = row.status === 'DONE';
  return (
    <li className="space-y-1.5 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-extrabold tabular-nums text-content">
          <Money value={done ? (row.sentAmount ?? row.amount) : row.amount} currency={row.currency} />
        </span>
        <Badge tone="neutral">{t(KIND_KEY[row.kind])}</Badge>
        {row.channel && <Badge tone="primary">{row.channel}</Badge>}
        {done ? (
          <Badge tone="success">
            <CheckCircle2 className="me-1 inline size-3" />
            {t('ewallet.doneAt')} <DateText value={row.doneAt} withTime />
          </Badge>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] text-content-tertiary">
            <Clock className="size-3" />
            <DateText value={row.assignedAt} relative />
            {row.assignedByName ? ` · ${row.assignedByName}` : ''}
          </span>
        )}
        {action && <span className="ms-auto">{action}</span>}
      </div>
      {!done ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <CopyChip value={row.account} />
          <CopyChip value={row.name} />
          <CopyChip value={(Number(row.amount) / 1e8).toString()} />
        </div>
      ) : (
        <p className="text-xs text-content-secondary">
          <span className="ltr-content">{row.account}</span> {row.name ? `· ${row.name}` : ''}
        </p>
      )}
    </li>
  );
}

/** Every movement of the wallet since the last count, newest last. */
export function MovementList({ report }: { report: Report }) {
  const { t } = useLocale();
  if (report.movements.length === 0) {
    return <p className="px-3 py-4 text-center text-xs text-content-tertiary">{t('ewallet.noMovements')}</p>;
  }
  return (
    <ol className="divide-y divide-border-subtle">
      {report.movements.map((row) => (
        <li key={row.id} className="flex items-center gap-2 px-3 py-2 text-xs">
          <span
            className={cn(
              'flex size-6 shrink-0 items-center justify-center rounded-full',
              row.direction === 'IN' ? 'bg-success-subtle text-success-text' : 'bg-danger-subtle text-danger-text',
            )}
          >
            {row.direction === 'IN' ? <ArrowDownLeft className="size-3.5" /> : <ArrowUpRight className="size-3.5" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-content">{row.note ?? row.reason}</span>
            <span className="block text-[10px] text-content-tertiary">
              <DateText value={row.createdAt} withTime />
              {row.createdBy ? ` · ${row.createdBy.fullNameAr}` : ''}
            </span>
          </span>
          <span className={cn('shrink-0 font-semibold tabular-nums', row.direction === 'IN' ? 'text-success-text' : 'text-danger-text')}>
            {row.direction === 'IN' ? '+' : '−'}
            <Money value={row.amount} currency={report.wallet.currency} />
          </span>
          <span className="w-24 shrink-0 text-end tabular-nums text-content-tertiary">
            <Money value={row.balanceAfter} currency={report.wallet.currency} />
          </span>
        </li>
      ))}
    </ol>
  );
}
