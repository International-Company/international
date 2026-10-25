'use client';

import { useEffect, useState } from 'react';
import { MessageCircle, Printer } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { Button } from '@/ui/primitives';
import { Dialog } from '@/ui/overlay';
import { DateText } from '@/ui/display';
import { cn } from '@/ui/utils';
import { plain } from '../handovers/count-record';

/**
 * محضر الجرد on screen: how each currency's expected figure was reached, what
 * was counted against it, and what stays with the teller — with a way to print
 * it for both signatures, or send it.
 */

interface RecordLine {
  currency: string;
  opening: string;
  received: string;
  paid: string;
  toppedUp: string;
  drawn: string;
  expected: string;
  counted: string;
  difference: string;
  kept: string;
}

interface TillRecord {
  id: string;
  reference: string;
  teller: { fullNameEn: string; fullNameAr: string };
  countedBy: { fullNameEn: string; fullNameAr: string };
  note: string | null;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  lines: RecordLine[];
}

/** Short, over or exact — a difference is expected minus counted. */
export function useVerdict(decimalsOf: (code: string) => number) {
  const { t } = useLocale();
  return (currency: string, difference: string) => {
    const gap = BigInt(difference);
    if (gap === 0n) return { text: t('till.exact'), tone: 'ok' as const };
    const amount = `${plain((gap < 0n ? -gap : gap).toString(), decimalsOf(currency))} ${currency}`;
    return gap > 0n
      ? { text: t('till.short', { amount }), tone: 'short' as const }
      : { text: t('till.over', { amount }), tone: 'over' as const };
  };
}

export const verdictTone = {
  ok: 'text-success-text',
  short: 'text-danger-text',
  over: 'text-warning-text',
} as const;

export function TillRecordDialog({
  id,
  onClose,
  decimalsOf,
}: {
  id: string | null;
  onClose: () => void;
  decimalsOf: (code: string) => number;
}) {
  const { t, ln } = useLocale();
  const verdict = useVerdict(decimalsOf);
  const [record, setRecord] = useState<TillRecord | null>(null);

  useEffect(() => {
    if (!id) return;
    setRecord(null);
    void api
      .get<TillRecord>(`/api/treasury/till-counts/${id}`)
      .then(setRecord)
      .catch(() => setRecord(null));
  }, [id]);

  const message = (data: TillRecord) =>
    [
      t('till.recordTitle', { reference: data.reference }),
      `${t('till.teller')}: ${ln(data.teller, 'fullName')}`,
      `${t('till.countedBy')}: ${ln(data.countedBy, 'fullName')}`,
      new Date(data.createdAt).toLocaleString('en-GB'),
      '',
      ...data.lines.flatMap((line) => {
        const decimals = decimalsOf(line.currency);
        return [
          `${line.currency}:`,
          `${t('till.expected')}: ${plain(line.expected, decimals)}`,
          `${t('till.counted')}: ${plain(line.counted, decimals)}`,
          `${t('till.difference')}: ${verdict(line.currency, line.difference).text}`,
          '',
        ];
      }),
      data.note ?? '',
    ]
      .join('\n')
      .trim();

  const columns = [
    'opening',
    'received',
    'paid',
    'toppedUp',
    'drawn',
    'expected',
    'counted',
  ] as const;

  return (
    <Dialog
      open={id !== null}
      onClose={onClose}
      size="lg"
      title={record ? t('till.recordTitle', { reference: record.reference }) : t('till.record')}
      footer={
        record && (
          <>
            <Button
              variant="secondary"
              icon={<Printer />}
              onClick={() => window.open(`/print/till-count/${record.id}`, '_blank')}
            >
              {t('till.print')}
            </Button>
            <Button
              icon={<MessageCircle />}
              onClick={() =>
                window.open(
                  `https://wa.me/?text=${encodeURIComponent(message(record))}`,
                  '_blank',
                  'noopener,noreferrer',
                )
              }
            >
              {t('till.send')}
            </Button>
          </>
        )
      }
    >
      {!record ? (
        <p className="py-6 text-center text-sm text-content-tertiary">{t('common.loading')}</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-content-secondary">
            <span>
              {t('till.teller')}: {ln(record.teller, 'fullName')}
            </span>
            <span>
              {t('till.countedBy')}: {ln(record.countedBy, 'fullName')}
            </span>
            <span className="flex gap-1">
              {t('till.period')}: <DateText value={record.periodStart} withTime /> —{' '}
              <DateText value={record.periodEnd} withTime />
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] border-collapse text-sm">
              <thead>
                <tr className="bg-surface-sunken text-xs text-content-secondary">
                  <th className="px-2 py-2 text-start font-medium">{t('till.currency')}</th>
                  {columns.map((column) => (
                    <th key={column} className="px-2 py-2 text-end font-medium">
                      {t(`till.${column}`)}
                    </th>
                  ))}
                  <th className="px-2 py-2 text-end font-medium">{t('till.difference')}</th>
                  <th className="px-2 py-2 text-end font-medium">{t('till.kept')}</th>
                </tr>
              </thead>
              <tbody>
                {record.lines.map((line) => {
                  const decimals = decimalsOf(line.currency);
                  const result = verdict(line.currency, line.difference);
                  return (
                    <tr key={line.currency} className="border-t border-border-subtle">
                      <td className="px-2 py-2 font-medium ltr-content">{line.currency}</td>
                      {columns.map((column) => (
                        <td
                          key={column}
                          className={cn(
                            'px-2 py-2 text-end tabular-nums ltr-content',
                            (column === 'expected' || column === 'counted') && 'font-semibold',
                          )}
                        >
                          {plain(line[column], decimals)}
                        </td>
                      ))}
                      <td
                        className={cn(
                          'px-2 py-2 text-end text-xs font-semibold',
                          verdictTone[result.tone],
                        )}
                      >
                        {result.text}
                      </td>
                      <td className="px-2 py-2 text-end tabular-nums ltr-content">
                        {plain(line.kept, decimals)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {record.note && <p className="text-sm text-content-secondary">{record.note}</p>}
        </div>
      )}
    </Dialog>
  );
}
