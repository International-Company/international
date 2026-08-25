import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { listDrawers, TREASURY } from '@/modules/drawers/drawer.service';
import { isTransferable } from '@/modules/drawers/funding-categories';
import { list, outstanding, commissionRates } from '@/modules/drawers/transfer.service';
import { transferChannels } from '@/modules/exchange/machine.service';
import { toJsonSafe } from '@/core/http/json';
import { PageHeader } from '@/ui/primitives';
import { TransfersView } from './transfers-view';

export const metadata: Metadata = { title: 'Transfers' };
export const dynamic = 'force-dynamic';

/**
 * Money moving between the branch's own balances.
 *
 * Its own screen rather than a third button on the funding dialog, because a
 * transfer is not funding: nothing enters or leaves the company, and reading a
 * month of them means reading two columns — out of where, into where — that the
 * funding log has no room for.
 */
export default async function TransfersPage() {
  const session = await requirePagePermission('exchange.transfer.use');
  const { t } = await getTranslator();

  const actor = {
    id: session.user.id,
    name: session.user.fullNameAr || session.user.fullNameEn,
    permissions: session.user.permissions,
    branchId: session.user.branchId,
  };

  const [drawers, rows, waiting, channels, rates] = await Promise.all([
    listDrawers({ forActor: actor }),
    list({ limit: 100 }, actor),
    outstanding(),
    transferChannels(),
    commissionRates(),
  ]);

  /*
   * Only the treasury's, and only the kinds money may pass through.
   *
   * A teller's own drawer is visible to him everywhere else in the system, but
   * it is not a transfer destination: money reaches it by handover, counted by
   * two people, and offering a way around that here would put a second door on
   * a room that is locked for a reason.
   */
  const options = drawers
    .filter((drawer) => drawer.ownerKey === TREASURY && isTransferable(drawer.kind))
    .map((drawer) => ({
      id: drawer.id,
      nameAr: drawer.nameAr,
      nameEn: drawer.nameEn,
      kind: drawer.kind,
      currencyCode: drawer.currencyCode,
      balance: drawer.balance.toString(),
      decimals: drawer.currency.decimals,
    }));

  return (
    <div className="space-y-4">
      <PageHeader title={t('transfers.title')} description={t('transfers.subtitle')} />

      <TransfersView
        drawers={toJsonSafe(options)}
        initial={toJsonSafe(rows)}
        waiting={toJsonSafe(waiting)}
        channels={channels}
        rates={Object.fromEntries(rates)}
        canManage={session.user.permissions.includes('exchange.drawer.manage')}
      />
    </div>
  );
}
