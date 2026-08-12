import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { machineConfig } from '@/modules/exchange/machine.service';
import { rateBoard } from '@/modules/exchange/rates.service';
import { toJsonSafe } from '@/core/http/json';
import { Alert, PageHeader } from '@/ui/primitives';
import { MachineView } from './machine-view';

export const metadata: Metadata = { title: 'Exchange machine' };
export const dynamic = 'force-dynamic';

export default async function MachinePage() {
  const session = await requirePagePermission('exchange.machine.use');
  const { t } = await getTranslator();

  const [config, board] = await Promise.all([machineConfig(), rateBoard()]);

  if (!config.enabled) {
    return (
      <div className="space-y-4">
        <PageHeader title={t('machine.title')} description={t('machine.subtitle')} />
        <Alert tone="neutral" title={t('machine.disabledTitle')}>
          {t('machine.disabledBody')}
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader title={t('machine.title')} description={t('machine.subtitle')} />

      <MachineView
        config={toJsonSafe(config)}
        board={toJsonSafe(board)}
        permissions={session.user.permissions}
      />
    </div>
  );
}
