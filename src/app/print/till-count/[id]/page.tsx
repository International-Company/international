import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireActiveSession } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { prisma } from '@/core/db/prisma';
import { toDecimalString } from '@/core/money/money';
import * as settings from '@/modules/settings/settings.service';
import { formatDateTime } from '@/i18n/format';
import { getCount } from '@/modules/treasury/till-count.service';
import { AutoPrint } from '../../receipt/[id]/auto-print';

export const metadata: Metadata = { title: 'Till count', robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * محضر جرد الصندوق, on paper — how each expected figure was reached, what was
 * counted against it, and a line for each of the two people to sign.
 */
export default async function TillCountPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireActiveSession();
  const { t, locale, ln, isRtl } = await getTranslator();

  const count = await getCount(id, {
    id: session.user.id,
    name: session.user.fullNameEn ?? '',
    permissions: session.user.permissions,
  }).catch(() => null);
  if (!count) notFound();

  const [companyName, currencies] = await Promise.all([
    settings.getString(locale === 'ar' ? 'company.name.ar' : 'company.name.en'),
    prisma.currency.findMany({ select: { code: true, decimals: true } }),
  ]);
  const decimals = new Map(currencies.map((row) => [row.code, row.decimals]));
  const figure = (value: bigint, currency: string) =>
    toDecimalString(value, decimals.get(currency) ?? 2);

  const verdict = (difference: bigint, currency: string) => {
    if (difference === 0n) return t('till.exact');
    const amount = `${figure(difference < 0n ? -difference : difference, currency)} ${currency}`;
    return difference > 0n ? t('till.short', { amount }) : t('till.over', { amount });
  };

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
    <div className="min-h-screen bg-canvas p-4 print:bg-white print:p-0">
      <AutoPrint />

      <article
        dir={isRtl ? 'rtl' : 'ltr'}
        className="mx-auto max-w-3xl border border-gray-300 bg-white p-6 text-[13px] leading-relaxed text-black"
      >
        <header className="border-b border-gray-400 pb-3 text-center">
          <h1 className="text-lg font-bold">{companyName}</h1>
          <p className="mt-1 text-sm font-semibold">
            {t('till.recordTitle', { reference: count.reference })}
          </p>
        </header>

        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
          <dt className="text-gray-600">{t('till.teller')}</dt>
          <dd>{ln(count.teller, 'fullName')}</dd>
          <dt className="text-gray-600">{t('till.countedBy')}</dt>
          <dd>{ln(count.countedBy, 'fullName')}</dd>
          <dt className="text-gray-600">{t('till.period')}</dt>
          <dd>
            {formatDateTime(count.periodStart, locale)} — {formatDateTime(count.periodEnd, locale)}
          </dd>
        </dl>

        <table className="mt-4 w-full border-collapse text-[11px]">
          <thead>
            <tr className="border-b border-gray-400">
              <th className="py-1.5 text-start">{t('till.currency')}</th>
              {columns.map((column) => (
                <th key={column} className="py-1.5 text-end">
                  {t(`till.${column}`)}
                </th>
              ))}
              <th className="py-1.5 text-end">{t('till.difference')}</th>
              <th className="py-1.5 text-end">{t('till.kept')}</th>
            </tr>
          </thead>
          <tbody>
            {count.lines.map((line) => (
              <tr key={line.currencyCode} className="border-b border-gray-200">
                <td className="py-1.5 font-semibold">{line.currencyCode}</td>
                {columns.map((column) => (
                  <td key={column} className="py-1.5 text-end tabular-nums">
                    {figure(line[column], line.currencyCode)}
                  </td>
                ))}
                <td className="py-1.5 text-end font-semibold">
                  {verdict(line.difference, line.currencyCode)}
                </td>
                <td className="py-1.5 text-end tabular-nums">
                  {figure(line.kept, line.currencyCode)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {count.note && <p className="mt-3 text-xs">{count.note}</p>}

        <footer className="mt-10 grid grid-cols-2 gap-8 text-xs">
          <div className="border-t border-gray-500 pt-1 text-center">
            {t('till.teller')}: {ln(count.teller, 'fullName')}
          </div>
          <div className="border-t border-gray-500 pt-1 text-center">
            {t('till.countedBy')}: {ln(count.countedBy, 'fullName')}
          </div>
        </footer>
      </article>
    </div>
  );
}
