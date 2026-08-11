import type { Metadata } from 'next';
import { requireSession } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { listUserSessions } from '@/modules/auth/session.service';
import { toJsonSafe } from '@/core/http/json';
import { Badge, Card, CardBody, CardHeader, DetailRow, PageHeader } from '@/ui/primitives';
import { AppearanceSettings } from '../manage/settings/appearance-settings';
import { ProfileSecurity } from './profile-security';
import { ProfileBiometrics } from './profile-biometrics';

export const metadata: Metadata = { title: 'My profile' };
export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const session = await requireSession();
  const { t, locale, ln } = await getTranslator();

  const sessions = await listUserSessions(session.user.id);

  return (
    <div className="space-y-4">
      <PageHeader
        title={locale === 'ar' ? session.user.fullNameAr : session.user.fullNameEn}
        description={session.user.username}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title={t('common.details')} />
          <CardBody>
            <dl className="divide-y divide-border-subtle">
              <DetailRow label={t('users.email')}>
                <span className="ltr-content">{session.user.email}</span>
              </DetailRow>
              <DetailRow label={t('users.roles')}>
                <span className="flex flex-wrap justify-end gap-1">
                  {session.user.roles.map((role) => (
                    <Badge key={role.key} tone="primary">
                      {ln(role as unknown as Record<string, unknown>, 'name')}
                    </Badge>
                  ))}
                </span>
              </DetailRow>
              <DetailRow label={t('common.branch')}>
                {ln(session.user as unknown as Record<string, unknown>, 'branchName') || '—'}
              </DetailRow>
              <DetailRow label={t('auth.twoFactor')}>
                {session.user.twoFactorEnabled ? (
                  <Badge tone="success">{t('common.enabled')}</Badge>
                ) : (
                  <Badge tone="neutral">{t('common.disabled')}</Badge>
                )}
              </DetailRow>
              <DetailRow label={t('users.permissions')}>
                {session.user.permissions.length}
              </DetailRow>
            </dl>
          </CardBody>
        </Card>

        <div className="lg:col-span-2">
          <AppearanceSettings />
        </div>
      </div>

      <ProfileBiometrics />

      <ProfileSecurity sessions={toJsonSafe(sessions)} currentSessionId={session.sessionId} />
    </div>
  );
}
