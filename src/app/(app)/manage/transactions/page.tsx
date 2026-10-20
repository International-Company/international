import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { TransactionsView } from './transactions-view';

export const metadata: Metadata = { title: 'Transactions' };

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const session = await requirePagePermission('exchange.transaction.view');
  // Global search lands here with a customer's code, to show that customer's trades.
  const { search } = await searchParams;

  return (
    <TransactionsView permissions={session.user.permissions} initialSearch={search ?? ''} />
  );
}
