'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, Save } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Card, CardFooter, CardHeader } from '@/ui/primitives';
import { Checkbox } from '@/ui/form';
import { useToast } from '@/ui/overlay';
import { cn } from '@/ui/utils';
import { MODULES, type ModuleKey, type PermissionDefinition } from '@/core/security/permissions';

interface RoleRow {
  id: string;
  key: string;
  nameEn: string;
  nameAr: string;
  description: string | null;
  level: number;
  isSystem: boolean;
  isActive: boolean;
  permissions: { permission: { key: string } }[];
  _count: { users: number };
}

/**
 * The permission matrix.
 *
 * A permission the signed-in administrator does not themselves hold is shown
 * but locked — granting it would be privilege escalation by proxy, since they
 * could then assign the role to themselves. The server enforces the same rule;
 * this makes the boundary visible rather than a surprising rejection on save.
 */
export function RolesView({
  roles,
  permissions,
  moduleLabels,
  grantable,
}: {
  roles: RoleRow[];
  permissions: PermissionDefinition[];
  moduleLabels: Record<ModuleKey, { en: string; ar: string }>;
  grantable: string[];
}) {
  const { t, locale, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [selectedId, setSelectedId] = useState(roles[0]?.id ?? '');
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = roles.find((role) => role.id === selectedId);

  const current = useMemo(
    () => draft ?? new Set(selected?.permissions.map((entry) => entry.permission.key) ?? []),
    [draft, selected],
  );

  const grantableSet = useMemo(() => new Set(grantable), [grantable]);

  const byModule = useMemo(() => {
    const groups = new Map<ModuleKey, PermissionDefinition[]>();
    for (const permission of permissions) {
      const list = groups.get(permission.module) ?? [];
      list.push(permission);
      groups.set(permission.module, list);
    }
    return groups;
  }, [permissions]);

  const toggle = (key: string) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setDraft(next);
  };

  const toggleModule = (module: ModuleKey, on: boolean) => {
    const next = new Set(current);
    for (const permission of byModule.get(module) ?? []) {
      if (!grantableSet.has(permission.key)) continue;
      if (on) next.add(permission.key);
      else next.delete(permission.key);
    }
    setDraft(next);
  };

  const save = async () => {
    if (!selected || !draft) return;
    setError(null);
    setSaving(true);

    try {
      await api.patch('/api/admin/roles', {
        roleId: selected.id,
        permissionKeys: [...draft],
      });
      toast.success(t('common.saved'), ln(selected, 'name'));
      setDraft(null);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? t(caught.messageKey as never, caught.params) || caught.message
          : t('errors.generic'),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
      {/* --- Role list --------------------------------------------------- */}
      <Card className="lg:col-span-1">
        <CardHeader title={t('roles.title')} />
        <ul className="divide-y divide-border-base">
          {roles.map((role) => (
            <li key={role.id}>
              <button
                type="button"
                onClick={() => {
                  setSelectedId(role.id);
                  setDraft(null);
                }}
                className={cn(
                  'w-full px-4 py-3 text-start transition-colors',
                  selectedId === role.id ? 'bg-primary-subtle' : 'hover:bg-surface-hover',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      'text-sm font-medium',
                      selectedId === role.id ? 'text-primary-text' : 'text-content',
                    )}
                  >
                    {ln(role, 'name')}
                  </span>
                  {role.isSystem && <Lock className="size-3 shrink-0 text-content-tertiary" />}
                </div>
                <p className="mt-0.5 text-xs text-content-tertiary">
                  {t('roles.memberCount', { count: role._count.users })} ·{' '}
                  {t('roles.permissionCount', { count: role.permissions.length })}
                </p>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      {/* --- Permission matrix -------------------------------------------- */}
      <div className="lg:col-span-3">
        {selected && (
          <Card>
            <CardHeader
              title={ln(selected, 'name')}
              description={selected.description ?? selected.key}
              actions={
                <div className="flex items-center gap-2">
                  {selected.isSystem && <Badge tone="neutral">{t('roles.systemRole')}</Badge>}
                  <Badge tone="primary">
                    {t('roles.level')} {selected.level}
                  </Badge>
                </div>
              }
            />

            <div className="space-y-5 p-4">
              {error && <Alert tone="danger">{error}</Alert>}
              <Alert tone="neutral">{t('roles.denyWins')}</Alert>

              {MODULES.map((module) => {
                const modulePermissions = byModule.get(module) ?? [];
                if (modulePermissions.length === 0) return null;

                const allowed = modulePermissions.filter((p) => grantableSet.has(p.key));
                const allOn =
                  allowed.length > 0 && allowed.every((p) => current.has(p.key));

                return (
                  <section key={module}>
                    <div className="mb-2 flex items-center justify-between gap-3 border-b border-border-base pb-1.5">
                      <h3 className="text-sm font-semibold text-content">
                        {locale === 'ar' ? moduleLabels[module].ar : moduleLabels[module].en}
                      </h3>
                      {allowed.length > 0 && (
                        <button
                          type="button"
                          onClick={() => toggleModule(module, !allOn)}
                          className="text-xs text-primary-text hover:underline"
                        >
                          {t('roles.selectAllInModule')}
                        </button>
                      )}
                    </div>

                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {modulePermissions.map((permission) => {
                        const locked = !grantableSet.has(permission.key);

                        return (
                          <Checkbox
                            key={permission.key}
                            checked={current.has(permission.key)}
                            disabled={locked}
                            onChange={() => toggle(permission.key)}
                            label={
                              <span className="flex items-center gap-1.5">
                                {locale === 'ar' ? permission.nameAr : permission.nameEn}
                                {permission.isSensitive && (
                                  <Badge tone="warning">{t('roles.sensitive')}</Badge>
                                )}
                                {locked && <Lock className="size-3 text-content-tertiary" />}
                              </span>
                            }
                            description={
                              locale === 'ar' ? permission.descriptionAr : permission.descriptionEn
                            }
                          />
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>

            <CardFooter>
              <Button variant="secondary" disabled={!draft || saving} onClick={() => setDraft(null)}>
                {t('common.reset')}
              </Button>
              <Button
                variant="primary"
                icon={<Save />}
                loading={saving}
                disabled={!draft}
                onClick={() => void save()}
              >
                {t('common.save')}
              </Button>
            </CardFooter>
          </Card>
        )}
      </div>
    </div>
  );
}
