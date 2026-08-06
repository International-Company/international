import type { Metadata } from 'next';
import Link from 'next/link';
import { BadgeCheck } from 'lucide-react';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { pendingApprovals } from '@/modules/exchange/transaction.service';
import { toJsonSafe } from '@/core/http/json';
import { Card, EmptyState, PageHeader } from '@/ui/primitives';
import { ApprovalRow } from './approval-row';

export const metadata: Metadata = { title: 'Approvals' };
export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const session = await requirePermission('exchange.transaction.approve');
  const { t } = await getTranslator();

  const pending = await pendingApprovals({
    id: session.user.id,
    name: session.user.fullNameEn,
    permissions: session.user.permissions,
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('transactions.approvalsTitle')}
        description={t('transactions.approvalsSubtitle')}
      />

      <Card>
        {pending.length === 0 ? (
          <EmptyState
            icon={<BadgeCheck />}
            title={t('transactions.noApprovals')}
            action={
              <Link href="/exchange/transactions" className="text-sm text-primary-text hover:underline">
                {t('transactions.title')}
              </Link>
            }
          />
        ) : (
          <ul className="divide-y divide-border-base">
            {pending.map((transaction) => (
              <ApprovalRow key={transaction.id} transaction={toJsonSafe(transaction)} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
