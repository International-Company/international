'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, TriangleAlert } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Separator } from '@/ui/primitives';
import { useToast } from '@/ui/overlay';
import { Field, MoneyInput } from '@/ui/form';

/**
 * One person at a time, and one question per row: may they do this?
 *
 * Each row has three answers, not two. "From the role" is the important one —
 * it is what almost every row should stay on, and it means the person moves
 * when the role moves. Allow and deny are exceptions to that, and the screen
 * says which of them is an exception by showing what the role would have given.
 * A screen with only two states would silently turn every role into a copy
 * taken on the day somebody last opened it.
 *
 * Deny wins over allow, including over a role that grants it, because the
 * engine resolves it that way — so a manager taking something away can do it in
 * one place without unpicking the role.
 */

type Effect = 'ALLOW' | 'DENY';
type Choice = 'INHERIT' | Effect;

interface Person {
  id: string;
  username: string;
  fullNameEn: string;
  fullNameAr: string;
  jobTitleEn: string | null;
  jobTitleAr: string | null;
  status: string;
  counterLimit: string;
  roleKeys: string[];
  overrides: { key: string; effect: Effect }[];
}

interface Permission {
  key: string;
  module: string;
  nameEn: string;
  nameAr: string;
  descriptionEn: string;
  descriptionAr: string;
  isSensitive: boolean;
}

export function PermissionsView({
  people,
  rolePermissions,
  catalogue,
  modules,
  currentUserId,
}: {
  people: Person[];
  rolePermissions: Record<string, string[]>;
  catalogue: Permission[];
  modules: { key: string; nameEn: string; nameAr: string }[];
  currentUserId: string;
}) {
  const { t, ln } = useLocale();
  const toast = useToast();
  const router = useRouter();

  const [selectedId, setSelectedId] = useState<string | null>(people[0]?.id ?? null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState(false);

  const person = people.find((row) => row.id === selectedId) ?? null;

  /** What this person's roles grant on their own, before any exception. */
  const fromRole = useMemo(() => {
    const keys = new Set<string>();
    for (const roleKey of person?.roleKeys ?? []) {
      for (const key of rolePermissions[roleKey] ?? []) keys.add(key);
    }
    return keys;
  }, [person, rolePermissions]);

  const select = (next: Person) => {
    setSelectedId(next.id);
    setChoices(
      Object.fromEntries(next.overrides.map((entry) => [entry.key, entry.effect as Choice])),
    );
    setLimit(next.counterLimit ? plain(next.counterLimit) : '');
  };

  // The first person is selected before anything is clicked, so their answers
  // have to be loaded the same way.
  const [primed, setPrimed] = useState(false);
  if (!primed && person) {
    setPrimed(true);
    setChoices(Object.fromEntries(person.overrides.map((e) => [e.key, e.effect as Choice])));
    setLimit(person.counterLimit ? plain(person.counterLimit) : '');
  }

  const choiceFor = (key: string): Choice => choices[key] ?? 'INHERIT';

  const setChoice = (key: string, next: Choice) =>
    setChoices((current) => {
      const copy = { ...current };
      if (next === 'INHERIT') delete copy[key];
      else copy[key] = next;
      return copy;
    });

  /** What they end up with, which is the only thing that matters at the counter. */
  const effective = (key: string): boolean => {
    const choice = choiceFor(key);
    if (choice === 'DENY') return false;
    if (choice === 'ALLOW') return true;
    return fromRole.has(key);
  };

  const changed =
    person !== null &&
    (JSON.stringify(Object.entries(choices).sort()) !==
      JSON.stringify(person.overrides.map((e) => [e.key, e.effect as Choice]).sort()) ||
      (person.counterLimit ? plain(person.counterLimit) : '') !== limit);

  const save = async () => {
    if (!person) return;
    setBusy(true);
    try {
      await api.patch(`/api/admin/users/${person.id}`, { counterLimit: limit.trim() || null });
      await api.post(`/api/admin/users/${person.id}`, {
        action: 'setPermissions',
        overrides: Object.entries(choices).map(([key, effect]) => ({
          permissionKey: key,
          effect,
        })),
      });
      toast.success(t('access.saved'), ln(person, 'fullName'));
      router.refresh();
    } catch (error) {
      toast.error(
        t('errors.title'),
        error instanceof ApiError
          ? say(t, error.messageKey, error.params) || error.message
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  const byModule = useMemo(() => {
    const grouped = new Map<string, Permission[]>();
    for (const permission of catalogue) {
      const list = grouped.get(permission.module) ?? [];
      list.push(permission);
      grouped.set(permission.module, list);
    }
    return grouped;
  }, [catalogue]);

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      {/* --- Who --------------------------------------------------------- */}
      <Card className="h-fit">
        <CardHeader title={t('access.people')} />
        <CardBody className="p-0">
          <ul className="divide-y divide-border-base">
            {people.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => select(row)}
                  className={`flex w-full flex-col items-start gap-0.5 px-4 py-3 text-start text-sm transition-colors ${
                    row.id === selectedId ? 'bg-primary-subtle' : 'hover:bg-surface-hover'
                  }`}
                >
                  <span className="font-medium">{ln(row, 'fullName')}</span>
                  <span className="text-content-tertiary text-xs">
                    {ln(row, 'jobTitle') || row.username}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      {/* --- What -------------------------------------------------------- */}
      <div className="space-y-4">
        {person === null ? null : (
          <>
            {person.id === currentUserId && (
              <Alert tone="warning" icon={<TriangleAlert className="h-4 w-4" />}>
                {t('access.self')}
              </Alert>
            )}

            <Card>
              <CardHeader
                title={ln(person, 'fullName')}
                description={t('access.rolesHint')}
                actions={
                  <Button onClick={save} loading={busy} disabled={!changed}>
                    {t('common.save')}
                  </Button>
                }
              />
              <CardBody className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  {person.roleKeys.length === 0 ? (
                    <Badge tone="warning">{t('access.noRole')}</Badge>
                  ) : (
                    person.roleKeys.map((key) => (
                      <Badge key={key} tone="primary">
                        {key}
                      </Badge>
                    ))
                  )}
                </div>

                <Separator />

                <Field label={t('access.ceiling')} hint={t('access.ceilingHint')}>
                  {(field) => (
                    <MoneyInput {...field} value={limit} onValueChange={setLimit} />
                  )}
                </Field>

                {changed && (
                  <Alert tone="warning">{t('access.signsOut')}</Alert>
                )}
              </CardBody>
            </Card>

            {modules.map((module) => {
              const rows = byModule.get(module.key) ?? [];
              if (rows.length === 0) return null;

              return (
                <Card key={module.key}>
                  <CardHeader title={ln(module, 'name')} />
                  <CardBody className="p-0">
                    <ul className="divide-y divide-border-base">
                      {rows.map((permission) => {
                        const choice = choiceFor(permission.key);
                        const roleGives = fromRole.has(permission.key);
                        return (
                          <li
                            key={permission.key}
                            className="flex flex-wrap items-center gap-3 px-4 py-3"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-2 text-sm font-medium">
                                {ln(permission, 'name')}
                                {permission.isSensitive && (
                                  <ShieldCheck className="text-warning-text size-3.5" />
                                )}
                                {effective(permission.key) && (
                                  <Badge tone="success">{t('access.has')}</Badge>
                                )}
                              </span>
                              <span className="text-content-tertiary block text-xs">
                                {ln(permission, 'description')}
                              </span>
                            </span>

                            <span
                              dir="ltr"
                              className="bg-surface-sunken flex shrink-0 rounded-lg p-0.5"
                            >
                              {(['DENY', 'INHERIT', 'ALLOW'] as const).map((option) => (
                                <button
                                  key={option}
                                  type="button"
                                  onClick={() => setChoice(permission.key, option)}
                                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                                    choice === option
                                      ? option === 'DENY'
                                        ? 'bg-danger text-white'
                                        : option === 'ALLOW'
                                          ? 'bg-success text-white'
                                          : 'bg-surface text-content shadow-[var(--shadow-sm)]'
                                      : 'text-content-tertiary hover:text-content'
                                  }`}
                                >
                                  {t(
                                    option === 'INHERIT'
                                      ? roleGives
                                        ? 'access.fromRoleYes'
                                        : 'access.fromRoleNo'
                                      : option === 'ALLOW'
                                        ? 'access.allow'
                                        : 'access.deny',
                                  )}
                                </button>
                              ))}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </CardBody>
                </Card>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

/** A scaled figure as plain digits, for an input the operator types into. */
function plain(scaled: string): string {
  const value = Number(BigInt(scaled)) / 1e8;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
