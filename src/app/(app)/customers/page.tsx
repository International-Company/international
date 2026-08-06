import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { CustomersView } from './customers-view';

export const metadata: Metadata = { title: 'Customers' };

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const { new: openNew } = await searchParams;
  const session = await requirePermission('customers.view');

  return (
    <CustomersView
      permissions={session.user.permissions}
      openCreateInitially={openNew === '1'}
    />
  );
}
