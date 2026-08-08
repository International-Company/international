import { redirect } from 'next/navigation';
import { getSession } from '@/modules/auth/context';
import { landingFor } from '@/app/_shell/navigation';

/** The root is a router, not a page: signed in goes to work, signed out signs in. */
export default async function RootPage() {
  const session = await getSession();
  redirect(session ? landingFor(session.user.permissions) : '/login');
}
