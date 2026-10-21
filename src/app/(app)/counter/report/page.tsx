import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { MyReportView } from './report-view';

export const metadata: Metadata = { title: 'My reports' };
export const dynamic = 'force-dynamic';

/**
 * A teller's report on himself.
 *
 * Behind `exchange.transaction.view`, which every teller holds and which
 * already means "may see his own transactions". Everything on the screen is
 * read for the signed-in person only; there is no parameter naming anyone else.
 */
export default async function MyReportPage() {
  const session = await requirePagePermission('exchange.transaction.view');
  return <MyReportView userId={session.user.id} />;
}
