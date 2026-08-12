import type { Metadata } from 'next';
import Link from 'next/link';
import { Lock } from 'lucide-react';
import { requireActiveSession } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { PERMISSIONS_BY_KEY } from '@/core/security/permissions';
import { Card, CardBody, EmptyState } from '@/ui/primitives';

export const metadata: Metadata = { title: 'No access' };
export const dynamic = 'force-dynamic';

/**
 * Where somebody lands when they follow a link they no longer have.
 *
 * It names the thing they are missing rather than saying "forbidden", because
 * the person reading it is usually a teller whose manager changed something an
 * hour ago, and what they need is a sentence they can repeat to him.
 */
export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ need?: string }>;
}) {
  await requireActiveSession();
  const { t, locale } = await getTranslator();
  const { need } = await searchParams;

  const permission = need ? PERMISSIONS_BY_KEY.get(need) : undefined;
  const named = permission ? (locale === 'ar' ? permission.nameAr : permission.nameEn) : null;

  return (
    <Card>
      <CardBody>
        <EmptyState
          icon={<Lock className="size-6" />}
          title={t('access.deniedTitle')}
          description={named ? t('access.deniedNamed', { permission: named }) : t('access.deniedBody')}
          action={
            <Link
              href="/"
              className="bg-primary hover:bg-primary-hover inline-flex h-10 items-center rounded-lg px-4 text-sm font-medium text-white"
            >
              {t('access.backHome')}
            </Link>
          }
        />
      </CardBody>
    </Card>
  );
}
