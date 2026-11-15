import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { InboxView } from './inbox-view';

export const metadata: Metadata = { title: 'Customer WhatsApp' };
export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  await requirePagePermission('customers.whatsapp');
  // The view draws its own title: a conversation open on a phone hides it.
  return <InboxView />;
}
