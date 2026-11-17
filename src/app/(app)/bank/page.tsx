import type { Metadata } from 'next';
import { requirePageAnyPermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { PageHeader } from '@/ui/primitives';
import { BankDesk } from './bank-desk';

export const metadata: Metadata = { title: 'Bank' };
export const dynamic = 'force-dynamic';

/** The bank desk: the transfers deals promised, sent one by one from the office's accounts. */
export default async function BankPage() {
  await requirePageAnyPermission('bank.execute', 'exchange.transfer.confirm');
  const { t } = await getTranslator();
  return (
    <div className="space-y-4">
      <PageHeader title={t('bank.title')} description={t('bank.subtitle')} />
      <BankDesk />
    </div>
  );
}
