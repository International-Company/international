import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { PageHeader } from '@/ui/primitives';
import { BoardView } from './board-view';

export const metadata: Metadata = { title: 'Remittance board' };
export const dynamic = 'force-dynamic';

/** The remittances taken from WhatsApp, each followed from the notice to the money paid. */
export default async function RemittanceBoardPage() {
  const session = await requirePagePermission('customers.whatsapp');
  const { t } = await getTranslator();
  return (
    <div className="space-y-4">
      <PageHeader title={t('remitBoard.title')} description={t('remitBoard.subtitle')} />
      <BoardView everyone={session.user.permissions.includes('customers.whatsapp.monitor')} />
    </div>
  );
}
