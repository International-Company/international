'use client';

import { useLocale } from '@/i18n/provider';
import { Money } from '@/ui/display';
import { cn } from '@/ui/utils';

/** One whole shekel or dollar, scaled: less than this left over is the fraction a receipt rounds away. */
const WHOLE = 100_000_000n;

/** What is left of a transfer paid in parts, as a stored sum (scaled by 1e8): nothing under one whole unit. */
export function remainingOf(amount: string, paid: string | null | undefined): bigint {
  const left = BigInt(amount || '0') - BigInt(paid || '0');
  return left >= WHOLE ? left : 0n;
}

/**
 * A transfer paid in parts, at a glance: what is left, in orange, and how far
 * it has gone — under the sum on the desk's row, or larger beside a transfer.
 */
export function PartsBar({
  amount,
  paid,
  currency,
  size = 'sm',
  closed = false,
  className,
}: {
  /** Already marked sent: shown only when short of its sum, and as such. */
  closed?: boolean;
  amount: string;
  paid: string | null | undefined;
  currency: string;
  size?: 'sm' | 'lg';
  className?: string;
}) {
  const { t } = useLocale();
  const total = BigInt(amount || '0');
  const sent = BigInt(paid || '0');
  if (sent <= 0n || total <= 0n) return null;
  const left = remainingOf(amount, paid);
  if (closed && left <= 0n) return null;
  const share = Math.min(100, Number((sent * 100n) / total));
  return (
    <span className={cn('block', className)}>
      <span
        className={cn(
          'flex flex-wrap items-center gap-x-1.5 font-bold',
          size === 'lg' ? 'text-sm' : 'text-[10px]',
          left > 0n ? 'text-warning-text' : 'text-success-text',
        )}
      >
        <span className="rounded-full bg-warning-subtle px-1.5 py-px">
          {left > 0n ? t('bankParts.partial') : t('bankParts.complete')}
        </span>
        {left > 0n && (
          <span className="ltr-content inline-flex items-center gap-1">
            {t('bankParts.left')} <Money value={left.toString()} currency={currency} />
          </span>
        )}
      </span>
      <span className={cn('mt-1 block overflow-hidden rounded-full bg-surface-sunken', size === 'lg' ? 'h-2' : 'h-1')}>
        <span
          className={cn('block h-full rounded-full', left > 0n ? 'bg-warning' : 'bg-success')}
          style={{ width: `${share}%` }}
        />
      </span>
      {size === 'lg' && (
        <span className="mt-1 flex items-center gap-1 text-[11px] text-content-tertiary">
          {t('bankParts.sentSoFar')}{' '}
          <span className="ltr-content font-semibold text-content-secondary">
            <Money value={sent.toString()} currency={currency} />
          </span>
        </span>
      )}
    </span>
  );
}
