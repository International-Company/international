'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarCheck, CalendarPlus, LockKeyhole } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { parseMoney, toDecimalString } from '@/core/money/money';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, PageHeader } from '@/ui/primitives';
import { ConfirmDialog, useToast } from '@/ui/overlay';
import { MoneyInput, Textarea } from '@/ui/form';
import { DateText, Money, StatusBadge } from '@/ui/display';
import { cn } from '@/ui/utils';

interface SheetRow {
  accountId: string;
  code: string;
  nameEn: string;
  nameAr: string;
  currencyCode: string;
  kind: string;
  openingBalance: string;
  totalIn: string;
  totalOut: string;
  systemBalance: string;
}

interface DayRecord {
  id: string;
  date: string;
  status: string;
  openedAt: string;
  closedAt: string | null;
  notes: string | null;
  openedBy?: { fullNameEn: string; fullNameAr: string } | null;
  closedBy?: { fullNameEn: string; fullNameAr: string } | null;
  _count?: { transactions: number };
}

/**
 * The daily open/close cycle.
 *
 * The count sheet is pre-filled with what the ledger expects, so an operator
 * whose drawer agrees can close in one click, while any drawer that differs
 * shows the variance live as they type — before they commit to it.
 */
export function BusinessDayView({
  branch,
  day,
  sheet,
  history,
  permissions,
}: {
  branch: { id: string; nameEn: string; nameAr: string };
  day: DayRecord | null;
  sheet: SheetRow[];
  history: DayRecord[];
  permissions: string[];
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [counts, setCounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(sheet.map((row) => [row.accountId, toDecimalString(BigInt(row.systemBalance), 2)])),
  );
  const [notes, setNotes] = useState('');
  const [confirming, setConfirming] = useState<'open' | 'close' | null>(null);
  const [busy, setBusy] = useState(false);

  const isOpen = day?.status === 'OPEN' || day?.status === 'REOPENED';

  const differences = useMemo(
    () =>
      sheet
        .map((row) => {
          const entered = counts[row.accountId] ?? '';
          let counted: bigint;
          try {
            counted = entered === '' ? BigInt(row.systemBalance) : parseMoney(entered);
          } catch {
            counted = BigInt(row.systemBalance);
          }
          return { ...row, counted, difference: counted - BigInt(row.systemBalance) };
        })
        .filter((row) => row.difference !== 0n),
    [sheet, counts],
  );

  const act = async (action: 'open' | 'close') => {
    setBusy(true);
    try {
      await api.post('/api/exchange/business-day', {
        action,
        branchId: branch.id,
        notes: notes || undefined,
        ...(action === 'close'
          ? {
              counts: sheet.map((row) => ({
                accountId: row.accountId,
                countedBalance: counts[row.accountId] ?? toDecimalString(BigInt(row.systemBalance), 2),
              })),
            }
          : {}),
      });

      toast.success(t('common.saved'), action === 'open' ? t('businessDay.openDay') : t('businessDay.closeDay'));
      setConfirming(null);
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
      {/* --- Current day ---------------------------------------------------- */}
      <Card>
        <CardHeader
          title={t('businessDay.currentDay')}
          description={ln(branch, 'name')}
          actions={
            <div className="flex items-center gap-2">
              {day && <StatusBadge status={day.status} scope="businessDay" />}
              {!day && permissions.includes('exchange.day.open') && (
                <Button
                  variant="primary"
                  size="sm"
                  icon={<CalendarPlus />}
                  onClick={() => setConfirming('open')}
                >
                  {t('businessDay.openDay')}
                </Button>
              )}
              {isOpen && permissions.includes('exchange.day.close') && (
                <Button
                  variant="primary"
                  size="sm"
                  icon={<LockKeyhole />}
                  onClick={() => setConfirming('close')}
                >
                  {t('businessDay.closeDay')}
                </Button>
              )}
            </div>
          }
        />

        {!day ? (
          <EmptyState
            icon={<CalendarCheck />}
            title={t('businessDay.noOpenDay')}
            description={t('businessDay.noOpenDayHint')}
          />
        ) : (
          <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
            <div>
              <p className="text-xs text-content-secondary">{t('common.date')}</p>
              <p className="mt-0.5 text-sm font-medium text-content">
                <DateText value={day.date} />
              </p>
            </div>
            <div>
              <p className="text-xs text-content-secondary">{t('businessDay.openDay')}</p>
              <p className="mt-0.5 text-sm text-content">
                {day.openedBy ? ln(day.openedBy, 'fullName') : '—'}
              </p>
            </div>
            <div>
              <p className="text-xs text-content-secondary">{t('common.time')}</p>
              <p className="mt-0.5 text-sm text-content">
                <DateText value={day.openedAt} withTime />
              </p>
            </div>
            <div>
              <p className="text-xs text-content-secondary">{t('nav.transactions')}</p>
              <p className="mt-0.5 text-sm font-medium text-content tabular-nums">
                {day._count?.transactions ?? 0}
              </p>
            </div>
          </div>
        )}
      </Card>

      {/* --- Count sheet ---------------------------------------------------- */}
      {isOpen && (
        <Card>
          <CardHeader title={t('businessDay.countSheet')} description={t('businessDay.countHint')} />

          {/* ------------------------------------------------------------ */}
          {/* Counting on a phone.                                         */}
          {/*                                                              */}
          {/* The count is done standing at the drawer, not at a desk, so  */}
          {/* this is the one screen most likely to be used on a handset.  */}
          {/* A seven-column table cannot serve that: each drawer gets its */}
          {/* own card, with the figure to type into placed directly under */}
          {/* the figure to compare it against.                            */}
          {/* ------------------------------------------------------------ */}
          <ul className="divide-y divide-border-base sm:hidden">
            {sheet.map((row) => {
              const entered = counts[row.accountId] ?? '';
              let difference = 0n;
              try {
                difference =
                  (entered === '' ? BigInt(row.systemBalance) : parseMoney(entered)) -
                  BigInt(row.systemBalance);
              } catch {
                difference = 0n;
              }

              return (
                <li key={row.accountId} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-content">{ln(row, 'name')}</p>
                      <p className="font-mono text-[10px] text-content-tertiary ltr-content">
                        {row.code}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-content-secondary">
                      {t('businessDay.systemBalance')}
                    </span>
                  </div>

                  <p className="mt-1 text-end text-base font-semibold text-content">
                    <Money value={row.systemBalance} currency={row.currencyCode} />
                  </p>

                  <div className="mt-3">
                    <label className="mb-1 block text-xs font-medium text-content">
                      {t('businessDay.countedBalance')}
                    </label>
                    <MoneyInput
                      value={entered}
                      onValueChange={(value) =>
                        setCounts((current) => ({ ...current, [row.accountId]: value }))
                      }
                      currency={row.currencyCode}
                      aria-label={`${t('businessDay.countedBalance')} ${row.code}`}
                    />
                  </div>

                  <div
                    className={cn(
                      'mt-2 flex items-center justify-between text-sm',
                      difference > 0n && 'text-success-text',
                      difference < 0n && 'text-danger-text',
                      difference === 0n && 'text-content-tertiary',
                    )}
                  >
                    <span className="text-xs">{t('businessDay.difference')}</span>
                    <span className="font-medium">
                      {difference === 0n ? '—' : <Money value={difference} signed />}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="hidden overflow-x-auto sm:block">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border-base bg-surface-sunken">
                    <th className="px-4 py-2 text-start text-xs font-medium text-content-secondary">
                      {t('accounts.accountName')}
                    </th>
                    <th className="hidden px-4 py-2 text-end text-xs font-medium text-content-secondary sm:table-cell">
                      {t('businessDay.openingBalance')}
                    </th>
                    <th className="hidden px-4 py-2 text-end text-xs font-medium text-content-secondary md:table-cell">
                      {t('businessDay.totalIn')}
                    </th>
                    <th className="hidden px-4 py-2 text-end text-xs font-medium text-content-secondary md:table-cell">
                      {t('businessDay.totalOut')}
                    </th>
                    <th className="px-4 py-2 text-end text-xs font-medium text-content-secondary">
                      {t('businessDay.systemBalance')}
                    </th>
                    <th className="px-4 py-2 text-end text-xs font-medium text-content-secondary">
                      {t('businessDay.countedBalance')}
                    </th>
                    <th className="px-4 py-2 text-end text-xs font-medium text-content-secondary">
                      {t('businessDay.difference')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-base">
                  {sheet.map((row) => {
                    const entered = counts[row.accountId] ?? '';
                    let difference = 0n;
                    try {
                      difference =
                        (entered === '' ? BigInt(row.systemBalance) : parseMoney(entered)) -
                        BigInt(row.systemBalance);
                    } catch {
                      difference = 0n;
                    }

                    return (
                      <tr key={row.accountId}>
                        <td className="px-4 py-2">
                          <p className="text-sm text-content">{ln(row, 'name')}</p>
                          <p className="font-mono text-[10px] text-content-tertiary ltr-content">
                            {row.code}
                          </p>
                        </td>
                        <td className="hidden px-4 py-2 text-end text-sm text-content-secondary sm:table-cell">
                          <Money value={row.openingBalance} />
                        </td>
                        <td className="hidden px-4 py-2 text-end text-sm text-success-text md:table-cell">
                          <Money value={row.totalIn} />
                        </td>
                        <td className="hidden px-4 py-2 text-end text-sm text-danger-text md:table-cell">
                          <Money value={row.totalOut} />
                        </td>
                        <td className="px-4 py-2 text-end text-sm font-medium">
                          <Money value={row.systemBalance} currency={row.currencyCode} />
                        </td>
                        <td className="px-4 py-2">
                          <MoneyInput
                            value={entered}
                            onValueChange={(value) =>
                              setCounts((current) => ({ ...current, [row.accountId]: value }))
                            }
                            className="h-8 max-w-[10rem] ms-auto"
                            aria-label={`${t('businessDay.countedBalance')} ${row.code}`}
                          />
                        </td>
                        <td
                          className={cn(
                            'px-4 py-2 text-end text-sm font-medium tabular-nums',
                            difference > 0n && 'text-success-text',
                            difference < 0n && 'text-danger-text',
                            difference === 0n && 'text-content-tertiary',
                          )}
                        >
                          {difference === 0n ? '—' : <Money value={difference} signed />}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {differences.length > 0 && (
            <div className="border-t border-border-base p-4">
              <Alert tone="warning" title={t('businessDay.hasDifferences', { count: differences.length })}>
                {t('businessDay.countHint')}
              </Alert>
            </div>
          )}
        </Card>
      )}

      {/* --- History --------------------------------------------------------- */}
      <Card>
        <CardHeader title={t('rates.history')} />
        {history.length === 0 ? (
          <EmptyState title={t('common.noResults')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <tbody className="divide-y divide-border-base">
                {history.map((record) => (
                  <tr key={record.id} className="hover:bg-surface-hover">
                    <td className="px-4 py-2.5 text-sm text-content">
                      <DateText value={record.date} />
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={record.status} scope="businessDay" />
                    </td>
                    <td className="hidden px-4 py-2.5 text-sm text-content-secondary sm:table-cell">
                      {t('businessDay.transactionCount', { count: record._count?.transactions ?? 0 })}
                    </td>
                    <td className="hidden px-4 py-2.5 text-sm text-content-secondary sm:table-cell">
                      {record.closedBy ? ln(record.closedBy, 'fullName') : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-end text-xs text-content-tertiary">
                      {record.closedAt ? <DateText value={record.closedAt} withTime /> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* --- Confirmations ---------------------------------------------------- */}
      <ConfirmDialog
        open={confirming === 'open'}
        onClose={() => setConfirming(null)}
        onConfirm={() => void act('open')}
        title={t('businessDay.openDay')}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        loading={busy}
      />

      <ConfirmDialog
        open={confirming === 'close'}
        onClose={() => setConfirming(null)}
        onConfirm={() => void act('close')}
        title={t('businessDay.closeDay')}
        message={t('businessDay.closeConfirm')}
        confirmLabel={t('businessDay.closeDay')}
        cancelLabel={t('common.cancel')}
        tone={differences.length > 0 ? 'danger' : 'primary'}
        loading={busy}
      >
        <div className="space-y-3">
          {differences.length > 0 && (
            <div className="rounded-[var(--radius-control)] border border-warning-border bg-warning-subtle p-3">
              <p className="text-xs font-medium text-warning-text">
                {t('businessDay.hasDifferences', { count: differences.length })}
              </p>
              <ul className="mt-2 space-y-1">
                {differences.map((row) => (
                  <li key={row.accountId} className="flex justify-between gap-3 text-xs">
                    <span className="font-mono ltr-content">{row.code}</span>
                    <Money value={row.difference} currency={row.currencyCode} signed colored />
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder={t('common.notes')}
            rows={2}
          />
        </div>
      </ConfirmDialog>
    </div>
  );
}
