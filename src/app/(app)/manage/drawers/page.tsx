import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { listDrawers, verifyBalances, history } from '@/modules/drawers/drawer.service';
import { toJsonSafe } from '@/core/http/json';
import { PageHeader } from '@/ui/primitives';
import { DrawersView } from './drawers-view';

export const metadata: Metadata = { title: 'Drawers' };
export const dynamic = 'force-dynamic';

export default async function DrawersPage() {
  const session = await requirePermission('exchange.drawer.view');
  const { t } = await getTranslator();

  const [drawers, check] = await Promise.all([listDrawers(), verifyBalances()]);

  // The movements behind each balance, so "why does it hold this" is answerable
  // on the same screen rather than one click away.
  const movements = await Promise.all(
    drawers.map(async (drawer) => ({
      currency: drawer.currencyCode,
      rows: await history(drawer.currencyCode, { limit: 12 }),
    })),
  );

  const agrees = new Map(check.drawers.map((entry) => [entry.currency, entry.agrees]));

  return (
    <div className="space-y-4">
      <PageHeader title={t('drawers.title')} description={t('drawers.subtitle')} />

      <DrawersView
        drawers={toJsonSafe(
          drawers.map((drawer) => ({ ...drawer, agrees: agrees.get(drawer.currencyCode) ?? true })),
        )}
        movements={toJsonSafe(movements)}
        permissions={session.user.permissions}
      />
    </div>
  );
}
