import type { Metadata } from 'next';
import { prisma } from '@/core/db/prisma';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { dayResult, fundingOn } from '@/modules/ledger/ledger.service';
import { ratesOn } from '@/modules/ledger/cutoff.service';
import { toJsonSafe } from '@/core/http/json';
import { Alert, PageHeader } from '@/ui/primitives';
import { LedgerView } from './ledger-view';

export const metadata: Metadata = { title: 'Ledger' };
export const dynamic = 'force-dynamic';

/**
 * Parses a `YYYY-MM-DD` query as **local** midnight.
 *
 * `new Date('2026-08-10')` is midnight UTC, which anywhere ahead of it is the
 * previous evening — the manager asking for the 10th would get the 9th.
 */
function parseDay(value: string | undefined): Date {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date();
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year!, month! - 1, day!);
}

export default async function LedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const session = await requirePagePermission('ledger.view');
  const { t } = await getTranslator();

  const { date: requested } = await searchParams;
  const date = parseDay(requested);

  if (!session.user.branchId) {
    return (
      <div className="space-y-4">
        <PageHeader title={t('ledger.title')} description={t('ledger.subtitle')} />
        <Alert tone="warning">{t('errors.noBranch')}</Alert>
      </div>
    );
  }

  const [result, rates, funding, currencies] = await Promise.all([
    dayResult(session.user.branchId, date),
    ratesOn(date),
    fundingOn(session.user.branchId, date),
    prisma.currency.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, nameEn: true, nameAr: true, decimals: true },
    }),
  ]);

  // Only the people who actually hold a drawer, so a line can name its holder.
  const holders = await prisma.user.findMany({
    where: { id: { in: [...new Set(result.position.map((l) => l.tellerId).filter(Boolean))] as string[] } },
    select: { id: true, fullNameEn: true, fullNameAr: true },
  });

  const day = {
    ...result,
    rates: [...rates].map(([currency, entry]) => ({
      currency,
      rate: entry.rate,
      setOn: entry.setOn,
    })),
    fundingLines: funding,
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('ledger.title')}
        description={t('ledger.subtitleOn', { date: result.date })}
      />

      <LedgerView
        day={toJsonSafe(day)}
        currencies={currencies}
        permissions={session.user.permissions}
        tellerNames={Object.fromEntries(
          holders.map((person) => [
            person.id,
            session.user.locale === 'en' ? person.fullNameEn : person.fullNameAr,
          ]),
        )}
      />
    </div>
  );
}
