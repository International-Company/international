import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { TransactionsView } from './transactions-view';

export const metadata: Metadata = { title: 'Transactions' };

export default async function TransactionsPage() {
  const session = await requirePermission('exchange.transaction.view');

  return <TransactionsView permissions={session.user.permissions} />;
}
