import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { prisma } from '@/core/db/prisma';
import { trialBalance } from '@/modules/ledger/ledger.service';
import { toJsonSafe } from '@/core/http/json';
import { PageHeader } from '@/ui/primitives';
import { CashboxesView } from './cashboxes-view';

export const metadata: Metadata = { title: 'Cashboxes' };
export const dynamic = 'force-dynamic';

export default async function CashboxesPage() {
  const session = await requirePermission('exchange.account.view');
  const { t } = await getTranslator();

  const [accounts, balance] = await Promise.all([
    prisma.account.findMany({
      where: { isActive: true },
      orderBy: [{ currencyCode: 'asc' }, { sortOrder: 'asc' }, { code: 'asc' }],
      select: {
        id: true,
        code: true,
        nameEn: true,
        nameAr: true,
        type: true,
        kind: true,
        currencyCode: true,
        balance: true,
        allowNegative: true,
      },
    }),
    session.user.permissions.includes('reports.financial.view')
      ? trialBalance({})
      : Promise.resolve(null),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title={t('accounts.title')} description={t('accounts.subtitle')} />

      <CashboxesView
        accounts={toJsonSafe(accounts)}
        trialBalance={balance ? toJsonSafe(balance) : null}
      />
    </div>
  );
}
