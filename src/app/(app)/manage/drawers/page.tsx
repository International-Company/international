import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import {
  DRAWER_KINDS,
  listDrawers,
  verifyBalances,
  history,
  type DrawerKind,
} from '@/modules/drawers/drawer.service';
import { prisma } from '@/core/db/prisma';
import { toJsonSafe } from '@/core/http/json';
import { PageHeader } from '@/ui/primitives';
import { DrawersView } from './drawers-view';

export const metadata: Metadata = { title: 'Drawers' };
export const dynamic = 'force-dynamic';

export default async function DrawersPage() {
  const session = await requirePermission('exchange.drawer.view');
  const { t } = await getTranslator();

  // Closed drawers included: this is the screen that closes them, and one that
  // vanished on being closed could never be reopened.
  const [drawers, check] = await Promise.all([
    listDrawers({ includeInactive: true }),
    verifyBalances(),
  ]);

  // The movements behind each balance, so "why does it hold this" is answerable
  // on the same screen rather than one click away. Keyed by currency *and* kind,
  // because a currency now has a till and a bank balance and they are two
  // different stories.
  const movements = await Promise.all(
    drawers.map(async (drawer) => ({
      key: `${drawer.currencyCode}:${drawer.kind}`,
      rows: await history(drawer.currencyCode, { limit: 12, kind: drawer.kind as DrawerKind }),
    })),
  );

  const agrees = new Map(
    check.drawers.map((entry) => [`${entry.currency}:${entry.kind}`, entry.agrees]),
  );

  /*
   * Which currency-and-kind pairs still have no drawer.
   *
   * Worked out here rather than in the browser so the add dialog can offer only
   * what can actually be created — one drawer per pair is the whole model, and
   * a form that lets someone pick a pair that already exists is a form whose
   * only outcome is an error message.
   */
  const currencies = await prisma.currency.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: { code: true, nameEn: true, nameAr: true, kind: true },
  });

  const taken = new Set(drawers.map((drawer) => `${drawer.currencyCode}:${drawer.kind}`));
  const openable = currencies.flatMap((currency) =>
    // Every kind the system knows, so a kind added later is offered here without
    // this list having to be remembered and edited a second time.
    DRAWER_KINDS.filter((kind) => !taken.has(`${currency.code}:${kind}`))
      .map((kind) => ({
        currency: currency.code,
        kind,
        nameEn: currency.nameEn,
        nameAr: currency.nameAr,
      })),
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
        openable={toJsonSafe(openable)}
        movements={toJsonSafe(movements)}
        permissions={session.user.permissions}
      />
    </div>
  );
}
