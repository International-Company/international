import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { transferChannels } from '@/modules/exchange/machine.service';
import * as settings from '@/modules/settings/settings.service';
import { rateText } from '@/modules/tiktok/tiktok-message';
import { getTranslator } from '@/i18n/server';
import { PageHeader } from '@/ui/primitives';
import { TiktokView } from './tiktok-view';

export const metadata: Metadata = { title: 'TikTok' };
export const dynamic = 'force-dynamic';

export default async function TiktokPage() {
  const session = await requirePagePermission('exchange.remittance.use');
  const { t } = await getTranslator();

  const [channels, rate] = await Promise.all([
    transferChannels(),
    settings.getMoney('tiktok.usdRate'),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title={t('tiktok.title')} description={t('tiktok.subtitle')} />
      <TiktokView
        channels={channels}
        defaultRate={rate > 0n ? rateText(rate) : ''}
        permissions={session.user.permissions}
      />
    </div>
  );
}
