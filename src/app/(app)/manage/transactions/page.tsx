import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { TransactionsView } from './transactions-view';

export const metadata: Metadata = { title: 'Transactions' };

export default async function TransactionsPage() {
  const session = await requirePagePermission('exchange.transaction.view');

  return <TransactionsView permissions={session.user.permissions} />;
}
