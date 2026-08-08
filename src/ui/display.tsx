'use client';

import { useEffect, useState } from 'react';
import { useLocale } from '@/i18n/provider';
import {
  formatAmount,
  formatCompactAmount,
  formatDate,
  formatDateTime,
  formatNumber,
  formatRate,
  formatRelative,
} from '@/i18n/format';
import { Badge } from './primitives';
import { cn, statusTone } from './utils';

/**
 * Locale-aware display components.
 *
 * Formatting a value in a component rather than at the call site means a screen
 * cannot accidentally render an amount without tabular figures, or a date in
 * the wrong calendar — the rules live in one place and apply everywhere.
 */

export function Money({
  value,
  currency,
  decimals = 2,
  signed,
  colored,
  compact,
  className,
}: {
  value: bigint | string;
  currency?: string;
  decimals?: number;
  signed?: boolean;
  /** Colour positive green and negative red — for deltas, not for balances. */
  colored?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const { locale } = useLocale();
  const amount = typeof value === 'bigint' ? value : BigInt(value || '0');

  const text = compact
    ? `${formatCompactAmount(amount, locale)}${currency ? ` ${currency}` : ''}`
    : formatAmount(amount, locale, {
        currency,
        decimals,
        signDisplay: signed ? 'always' : 'auto',
      });

  return (
    <span
      // Amounts always read left-to-right, even inside Arabic text, so the
      // sign and decimal separator land where the reader expects them.
      dir="ltr"
      className={cn(
        'tabular-nums whitespace-nowrap',
        colored && amount > 0n && 'text-success-text',
        colored && amount < 0n && 'text-danger-text',
        className,
      )}
    >
      {text}
    </span>
  );
}

export function Rate({ value, decimals = 4 }: { value: bigint | string; decimals?: number }) {
  return (
    <span dir="ltr" className="tabular-nums whitespace-nowrap">
      {formatRate(value, decimals)}
    </span>
  );
}

export function Num({ value, className }: { value: number; className?: string }) {
  const { locale } = useLocale();
  return (
    <span dir="ltr" className={cn('tabular-nums', className)}>
      {formatNumber(value, locale)}
    </span>
  );
}

export function DateText({
  value,
  withTime,
  relative,
  className,
}: {
  value: Date | string | null | undefined;
  withTime?: boolean;
  relative?: boolean;
  className?: string;
}) {
  const { locale } = useLocale();

  /**
   * A relative time is a function of *now*, and the server's now is never the
   * browser's. "30 seconds ago" rendered on the server becomes "31 seconds ago"
   * by the time it hydrates, and React tears down the tree over the difference —
   * intermittently, which is the hardest kind of bug to be handed later.
   *
   * So the server renders the absolute date, which is stable, and the relative
   * form appears once the component is running in the browser and has a `now`
   * it can trust.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!value) return <span className={cn('text-content-tertiary', className)}>—</span>;

  const title = formatDateTime(value, locale);
  const text =
    relative && mounted
      ? formatRelative(value, locale)
      : withTime
        ? title
        : formatDate(value, locale);

  return (
    <time title={title} className={cn('whitespace-nowrap', className)}>
      {text}
    </time>
  );
}

// ---------------------------------------------------------------------------
// Domain badges
// ---------------------------------------------------------------------------

export function StatusBadge({
  status,
  scope = 'transactions',
}: {
  status: string;
  /** Which dictionary branch holds the label for this status set. */
  scope?: 'transactions' | 'usdt' | 'users' | 'businessDay' | 'backup' | 'system' | 'customers';
}) {
  const { t } = useLocale();

  const key =
    scope === 'customers' ? `customers.kycStatus.${status}` : `${scope}.status.${status}`;
  const label = t(key as never);

  return (
    <Badge tone={statusTone(status)} dot>
      {label === key ? status : label}
    </Badge>
  );
}

export function TransactionTypeBadge({ type }: { type: string }) {
  const { t } = useLocale();
  const label = t(`transactions.type.${type}` as never);

  return <Badge tone="neutral">{label === `transactions.type.${type}` ? type : label}</Badge>;
}

export function RiskBadge({ level }: { level: string }) {
  const { t } = useLocale();
  const tone = level === 'HIGH' ? 'danger' : level === 'MEDIUM' ? 'warning' : 'success';
  const label = t(`customers.risk.${level}` as never);

  return <Badge tone={tone}>{label === `customers.risk.${level}` ? level : label}</Badge>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  const { t } = useLocale();
  const tone =
    severity === 'CRITICAL'
      ? 'danger'
      : severity === 'WARNING'
        ? 'warning'
        : severity === 'SUCCESS'
          ? 'success'
          : 'primary';

  return <Badge tone={tone} dot>{t(`notifications.severity.${severity}` as never)}</Badge>;
}

/** Bilingual record name, picked for the active locale. */
export function LocalizedName({
  record,
  baseKey = 'fullName',
  fallback = '—',
  className,
}: {
  record: object | null | undefined;
  baseKey?: string;
  fallback?: string;
  className?: string;
}) {
  const { ln } = useLocale();
  if (!record) return <span className={cn('text-content-tertiary', className)}>{fallback}</span>;

  const name = ln(record, baseKey);
  return <span className={className}>{name || fallback}</span>;
}

/** Truncated, copyable identifier — hashes, addresses, references. */
export function CopyableId({
  value,
  display,
  className,
}: {
  value: string;
  display?: string;
  className?: string;
}) {
  const { t } = useLocale();

  return (
    <button
      type="button"
      onClick={() => void navigator.clipboard?.writeText(value)}
      title={`${value}\n${t('common.copy')}`}
      className={cn(
        'font-mono text-xs ltr-content transition-colors hover:text-primary-text',
        className,
      )}
    >
      {display ?? value}
    </button>
  );
}
