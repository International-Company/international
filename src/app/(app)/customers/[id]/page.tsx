import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { getCustomer } from '@/modules/customers/customers.service';
import { historyFor } from '@/modules/audit/audit.service';
import { isAppError } from '@/core/errors/app-error';
import { toJsonSafe } from '@/core/http/json';
import { PageHeader } from '@/ui/primitives';
import { CustomerDetail } from './customer-detail';

export const metadata: Metadata = { title: 'Customer' };
export const dynamic = 'force-dynamic';

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requirePermission('customers.view');
  const { t } = await getTranslator();

  let customer;
  try {
    customer = await getCustomer(id);
  } catch (error) {
    if (isAppError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const history = await historyFor('Customer', id);

  return (
    <div className="space-y-4">
      <PageHeader
        title={customer.fullNameAr || customer.fullNameEn}
        description={<span className="font-mono ltr-content">{customer.code}</span>}
        breadcrumb={
          <Link href="/customers" className="text-xs text-content-secondary hover:text-primary-text">
            ← {t('customers.title')}
          </Link>
        }
      />

      <CustomerDetail
        customer={toJsonSafe(customer)}
        history={toJsonSafe(history)}
        permissions={session.user.permissions}
      />
    </div>
  );
}
