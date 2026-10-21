import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { ActivityView } from './activity-view';

export const metadata: Metadata = { title: 'Teller activity' };
export const dynamic = 'force-dynamic';

/**
 * Everything each teller recorded, by kind of work, with the totals.
 *
 * Behind `exchange.transaction.viewAll` — the permission that already means
 * "may read other people's transactions". This screen reads nothing that the
 * transactions list would not show the same person; it only adds them up.
 */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ teller?: string }>;
}) {
  await requirePagePermission('exchange.transaction.viewAll');
  // The tellers screen links here with one person already chosen.
  const { teller } = await searchParams;

  return <ActivityView initialTeller={teller ?? ''} />;
}
