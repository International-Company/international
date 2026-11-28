import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { PageHeader } from '@/ui/primitives';
import { noticeNetworks } from '@/modules/whatsapp/remittance-notice.service';
import { routeCountries } from '@/modules/whatsapp/remittance-routes.service';
import { RoutesView } from './routes-view';

export const metadata: Metadata = { title: 'Remittance routes' };
export const dynamic = 'force-dynamic';

/** Each country linked to the agent's group its remittances go to, received or sent. */
export default async function RemittanceRoutesPage() {
  await requirePagePermission('customers.whatsapp.monitor');
  const { t } = await getTranslator();
  const [networks, countries] = await Promise.all([noticeNetworks(), routeCountries()]);
  return (
    <div className="space-y-4">
      <PageHeader title={t('remitRoutes.title')} description={t('remitRoutes.subtitle')} />
      <RoutesView networks={networks} countries={countries} />
    </div>
  );
}
