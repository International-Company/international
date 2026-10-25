'use client';

import { useEffect, useState } from 'react';
import { MessageCircle, Printer } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { Button } from '@/ui/primitives';
import { Dialog } from '@/ui/overlay';
import { DateText } from '@/ui/display';
import { cn } from '@/ui/utils';

/**
 * محضر الجرد on screen: the books, the declaration and the count, side by side,
 * and the difference that was booked — with a way to print it or send it.
 */

interface RecordLine {
  currency: string;
  kind: string;
  nature: string;
  expected: string | null;
  declared: string;
  counted: string | null;
  difference: string | null;
}

interface CountRecord {
  id: string;
  reference: string;
  status: string;
  shift: string | null;
  teller: { fullNameEn: string; fullNameAr: string };
  confirmedBy: { fullNameEn: string; fullNameAr: string } | null;
  createdAt: string;
  confirmedAt: string | null;
  lines: RecordLine[];
}

/** A 1e8-scaled figure at a currency's precision; whole amounts lose ".00". */
export function plain(scaled: string | null, decimals: number): string {
  if (scaled === null) return '—';
  const value = BigInt(scaled);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = 10n ** BigInt(8 - decimals);
  const rounded = (abs + unit / 2n) / unit;
  const whole = (rounded / 10n ** BigInt(decimals))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (rounded % 10n ** BigInt(decimals)).toString().padStart(decimals, '0');
  const text = decimals === 0 || /^0+$/.test(fraction) ? whole : `${whole}.${fraction}`;
  return negative ? `-${text}` : text;
}

export function CountRecordDialog({
  id,
  onClose,
  decimalsOf,
}: {
  id: string | null;
  onClose: () => void;
  decimalsOf: (code: string) => number;
}) {
  const { t, ln } = useLocale();
  const [record, setRecord] = useState<CountRecord | null>(null);

  useEffect(() => {
    if (!id) return;
    setRecord(null);
    void api
      .get<CountRecord>(`/api/treasury/handovers/${id}/record`)
      .then(setRecord)
      .catch(() => setRecord(null));
  }, [id]);

  // A difference is the books minus the count: positive short, negative over.
  const verdict = (line: RecordLine) => {
    if (line.difference === null) return null;
    const gap = BigInt(line.difference);
    if (gap === 0n) return { text: t('handover.recordExact'), tone: 'ok' as const };
    const amount = `${plain((gap < 0n ? -gap : gap).toString(), decimalsOf(line.currency))} ${line.currency}`;
    return gap > 0n
      ? { text: t('handover.recordShort', { amount }), tone: 'short' as const }
      : { text: t('handover.recordOver', { amount }), tone: 'over' as const };
  };

  const message = (data: CountRecord) =>
    [
      t('handover.recordTitle', { reference: data.reference }),
      ln(data.teller, 'fullName'),
      data.confirmedAt ? new Date(data.confirmedAt).toLocaleString('en-GB') : '',
      '',
      ...data.lines.flatMap((line) => {
        const decimals = decimalsOf(line.currency);
        return [
          `${line.currency}:`,
          `${t('handover.colExpected')}: ${plain(line.expected, decimals)}`,
          `${t('handover.colDeclared')}: ${plain(line.declared, decimals)}`,
          `${t('handover.colCounted')}: ${plain(line.counted, decimals)}`,
          `${t('handover.colDifference')}: ${verdict(line)?.text ?? '—'}`,
          '',
        ];
      }),
    ]
      .join('\n')
      .trim();

  return (
    <Dialog
      open={id !== null}
      onClose={onClose}
      size="lg"
      title={
        record ? t('handover.recordTitle', { reference: record.reference }) : t('handover.record')
      }
      footer={
        record && (
          <>
            <Button
              variant="secondary"
              icon={<Printer />}
              onClick={() => window.open(`/print/handover/${record.id}`, '_blank')}
            >
              {t('handover.recordPrint')}
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
              {t('handover.recordSend')}
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
            <span>{ln(record.teller, 'fullName')}</span>
            {record.shift && <span className="font-mono ltr-content">{record.shift}</span>}
            {record.confirmedBy && (
              <span>
                {t('handover.recordCountedBy')} {ln(record.confirmedBy, 'fullName')}
              </span>
            )}
            {record.confirmedAt && <DateText value={record.confirmedAt} withTime />}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse text-sm">
              <thead>
                <tr className="bg-surface-sunken text-xs text-content-secondary">
                  <th className="px-3 py-2 text-start font-medium">{t('handover.colCurrency')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('handover.colExpected')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('handover.colDeclared')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('handover.colCounted')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('handover.colDifference')}</th>
                </tr>
              </thead>
              <tbody>
                {record.lines.map((line) => {
                  const decimals = decimalsOf(line.currency);
                  const result = verdict(line);
                  return (
                    <tr
                      key={`${line.currency}:${line.kind}`}
                      className="border-t border-border-subtle"
                    >
                      <td className="px-3 py-2 font-medium ltr-content">{line.currency}</td>
                      <td className="px-3 py-2 text-end tabular-nums ltr-content">
                        {plain(line.expected, decimals)}
                      </td>
                      <td className="px-3 py-2 text-end tabular-nums ltr-content">
                        {plain(line.declared, decimals)}
                      </td>
                      <td className="px-3 py-2 text-end font-semibold tabular-nums ltr-content">
                        {plain(line.counted, decimals)}
                      </td>
                      <td
                        className={cn(
                          'px-3 py-2 text-end text-xs font-semibold',
                          result?.tone === 'ok' && 'text-success-text',
                          result?.tone === 'short' && 'text-danger-text',
                          result?.tone === 'over' && 'text-warning-text',
                        )}
                      >
                        {result?.text ?? '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Dialog>
  );
}
