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
  // on the same screen rather than one click away. Keyed by currency *and* kind,
  // because a currency now has a till and a bank balance and they are two
  // different stories.
  const movements = await Promise.all(
    drawers.map(async (drawer) => ({
      key: `${drawer.currencyCode}:${drawer.kind}`,
      rows: await history(drawer.currencyCode, { limit: 12, kind: drawer.kind as 'CASH' | 'BANK' }),
    })),
  );

  const agrees = new Map(
    check.drawers.map((entry) => [`${entry.currency}:${entry.kind}`, entry.agrees]),
  );

  return (
    <div className="space-y-4">
      <PageHeader title={t('drawers.title')} description={t('drawers.subtitle')} />

      <DrawersView
        drawers={toJsonSafe(
          drawers.map((drawer) => ({
            ...drawer,
            agrees: agrees.get(`${drawer.currencyCode}:${drawer.kind}`) ?? true,
          })),
        )}
        movements={toJsonSafe(movements)}
        permissions={session.user.permissions}
      />
    </div>
  );
}
