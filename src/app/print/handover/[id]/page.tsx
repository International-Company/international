import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireActiveSession } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { prisma } from '@/core/db/prisma';
import { toDecimalString } from '@/core/money/money';
import * as settings from '@/modules/settings/settings.service';
import { formatDateTime } from '@/i18n/format';
import { countRecord } from '@/modules/treasury/count-record.service';
import { AutoPrint } from '../../receipt/[id]/auto-print';

export const metadata: Metadata = { title: 'Count record', robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * محضر الجرد, on paper — signed by both people at the counter.
 *
 * Printed by the browser, like a receipt, for the same reason: Arabic needs the
 * browser's text engine. Who may print it is the record's own rule — the
 * teller it is about, or anyone who counts handovers.
 */
export default async function HandoverRecordPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireActiveSession();
  const { t, locale, ln, isRtl } = await getTranslator();

  const record = await countRecord(id, {
    id: session.user.id,
    permissions: session.user.permissions,
  }).catch(() => null);
  if (!record) notFound();

  const [companyName, currencies] = await Promise.all([
    settings.getString(locale === 'ar' ? 'company.name.ar' : 'company.name.en'),
    prisma.currency.findMany({ select: { code: true, decimals: true } }),
  ]);
  const decimals = new Map(currencies.map((row) => [row.code, row.decimals]));

  const figure = (value: bigint | null, currency: string) =>
    value === null ? '—' : toDecimalString(value, decimals.get(currency) ?? 2);

  const verdict = (difference: bigint | null, currency: string) => {
    if (difference === null) return '—';
    if (difference === 0n) return t('handover.recordExact');
    const amount = `${figure(difference < 0n ? -difference : difference, currency)} ${currency}`;
    return difference > 0n
      ? t('handover.recordShort', { amount })
      : t('handover.recordOver', { amount });
  };

  return (
    <div className="min-h-screen bg-canvas p-4 print:bg-white print:p-0">
      <AutoPrint />

      <article
        dir={isRtl ? 'rtl' : 'ltr'}
        className="mx-auto max-w-2xl border border-gray-300 bg-white p-6 text-[13px] leading-relaxed text-black"
      >
        <header className="border-b border-gray-400 pb-3 text-center">
          <h1 className="text-lg font-bold">{companyName}</h1>
          <p className="mt-1 text-sm font-semibold">
            {t('handover.recordTitle', { reference: record.reference })}
          </p>
        </header>

        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
          <dt className="text-gray-600">{t('handover.teller')}</dt>
          <dd>{ln(record.teller, 'fullName')}</dd>
          {record.shift && (
            <>
              <dt className="text-gray-600">{t('handover.myShift')}</dt>
              <dd className="font-mono">{record.shift}</dd>
            </>
          )}
          {record.confirmedBy && (
            <>
              <dt className="text-gray-600">{t('handover.recordCountedBy')}</dt>
              <dd>{ln(record.confirmedBy, 'fullName')}</dd>
            </>
          )}
          <dt className="text-gray-600">{t('receipt.date')}</dt>
          <dd>{formatDateTime(record.confirmedAt ?? record.createdAt, locale)}</dd>
        </dl>

        <table className="mt-4 w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-gray-400">
              <th className="py-1.5 text-start">{t('handover.colCurrency')}</th>
              <th className="py-1.5 text-end">{t('handover.colExpected')}</th>
              <th className="py-1.5 text-end">{t('handover.colDeclared')}</th>
              <th className="py-1.5 text-end">{t('handover.colCounted')}</th>
              <th className="py-1.5 text-end">{t('handover.colDifference')}</th>
            </tr>
          </thead>
          <tbody>
            {record.lines.map((line) => (
              <tr key={`${line.currency}:${line.kind}`} className="border-b border-gray-200">
                <td className="py-1.5 font-semibold">{line.currency}</td>
                <td className="py-1.5 text-end tabular-nums">{figure(line.expected, line.currency)}</td>
                <td className="py-1.5 text-end tabular-nums">{figure(line.declared, line.currency)}</td>
                <td className="py-1.5 text-end font-semibold tabular-nums">
                  {figure(line.counted, line.currency)}
                </td>
                <td className="py-1.5 text-end">{verdict(line.difference, line.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Signed by both: the teller who handed it over and whoever counted it. */}
        <footer className="mt-10 grid grid-cols-2 gap-8 text-xs">
          <div className="border-t border-gray-500 pt-1 text-center">
            {t('handover.teller')}: {ln(record.teller, 'fullName')}
          </div>
          <div className="border-t border-gray-500 pt-1 text-center">
            {t('handover.recordCountedBy')}{' '}
            {record.confirmedBy ? ln(record.confirmedBy, 'fullName') : ''}
          </div>
        </footer>
      </article>
    </div>
  );
}
