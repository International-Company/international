import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { getById } from '@/modules/exchange/transaction.service';
import { historyFor } from '@/modules/audit/audit.service';
import { isAppError } from '@/core/errors/app-error';
import { toJsonSafe } from '@/core/http/json';
import { PageHeader } from '@/ui/primitives';
import { TransactionDetail } from './transaction-detail';

export const metadata: Metadata = { title: 'Transaction' };
export const dynamic = 'force-dynamic';

export default async function TransactionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requirePagePermission('exchange.transaction.view');
  const { t } = await getTranslator();

  let transaction;
  try {
    transaction = await getById(id, {
      id: session.user.id,
      name: session.user.fullNameEn,
      permissions: session.user.permissions,
    });
  } catch (error) {
    if (isAppError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const history = await historyFor('Transaction', id);

  return (
    <div className="space-y-4">
      <PageHeader
        title={<span className="font-mono ltr-content">{transaction.reference}</span>}
        breadcrumb={
          <Link
            href="/manage/transactions"
            className="text-xs text-content-secondary hover:text-primary-text"
          >
            ← {t('transactions.title')}
          </Link>
        }
      />

      <TransactionDetail
        transaction={toJsonSafe(transaction)}
        history={toJsonSafe(history)}
        permissions={session.user.permissions}
      />
    </div>
  );
}
