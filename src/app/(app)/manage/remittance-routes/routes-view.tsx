'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ArrowLeftRight, Pencil, Plus, Route as RouteIcon, Trash2, Users } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Badge, Button, Card, EmptyState, Skeleton } from '@/ui/primitives';
import { ConfirmDialog, Dialog, useToast } from '@/ui/overlay';
import { Field, Input, Select } from '@/ui/form';
import { networkLabel } from '../inbox/notice-panel';

type Direction = 'IN' | 'OUT' | 'BOTH';

interface RouteRow {
  id: string;
  country: string;
  network: string | null;
  direction: Direction;
  groupChat: string;
  groupName: string | null;
  byName: string | null;
  updatedAt: string;
}

interface Group {
  chat: string;
  name: string;
}

const EMPTY = { country: '', network: '', direction: 'BOTH' as Direction, groupChat: '' };

const DIRECTION_ICON = { IN: ArrowDownLeft, OUT: ArrowUpRight, BOTH: ArrowLeftRight };

export function RoutesView({ networks, countries }: { networks: string[]; countries: string[] }) {
  const { t } = useLocale();
  const toast = useToast();
  const [routes, setRoutes] = useState<RouteRow[] | null>(null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [groupQuery, setGroupQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<RouteRow | null>(null);

  const failure = useCallback(
    (cause: unknown) =>
      toast.error(
        t('errors.title'),
        cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'),
      ),
    [toast, t],
  );

  const load = useCallback(() => {
    api
      .get<RouteRow[]>('/api/remittance-routes')
      .then(setRoutes)
      .catch((cause) => {
        setRoutes([]);
        failure(cause);
      });
  }, [failure]);

  useEffect(load, [load]);

  const openForm = (row: RouteRow | null) => {
    setForm(
      row
        ? { country: row.country, network: row.network ?? '', direction: row.direction, groupChat: row.groupChat }
        : EMPTY,
    );
    setGroupQuery('');
    setEditing({ id: row?.id ?? null });
    if (groups === null) {
      api
        .get<Group[]>('/api/remittance-routes/groups')
        .then(setGroups)
        .catch((cause) => {
          setGroups([]);
          failure(cause);
        });
    }
  };

  const save = async () => {
    if (!editing) return;
    const group = groups?.find((entry) => entry.chat === form.groupChat);
    const known = routes?.find((row) => row.groupChat === form.groupChat);
    const body = {
      country: form.country.trim(),
      network: form.network || null,
      direction: form.direction,
      groupChat: form.groupChat,
      groupName: group?.name ?? known?.groupName ?? null,
    };
    setSaving(true);
    try {
      if (editing.id) await api.patch(`/api/remittance-routes/${editing.id}`, body);
      else await api.post('/api/remittance-routes', body);
      toast.success(t('remitRoutes.saved'));
      setEditing(null);
      load();
    } catch (cause) {
      failure(cause);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      await api.delete(`/api/remittance-routes/${removing.id}`);
      setRemoving(null);
      load();
    } catch (cause) {
      failure(cause);
    }
  };

  // By country, each with its routes: every method first, then one method each.
  const byCountry = useMemo(() => {
    const map = new Map<string, RouteRow[]>();
    for (const row of routes ?? []) {
      const list = map.get(row.country) ?? [];
      list.push(row);
      map.set(row.country, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ar'));
  }, [routes]);

  const shownGroups = (groups ?? []).filter(
    (group) => !groupQuery.trim() || group.name.includes(groupQuery.trim()) || group.chat === form.groupChat,
  );
  const chosenGroup =
    groups?.find((group) => group.chat === form.groupChat) ??
    (form.groupChat ? { chat: form.groupChat, name: routes?.find((row) => row.groupChat === form.groupChat)?.groupName ?? form.groupChat } : null);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button icon={<Plus />} onClick={() => openForm(null)}>
          {t('remitRoutes.add')}
        </Button>
      </div>

      {routes === null ? (
        <Skeleton className="h-40" />
      ) : byCountry.length === 0 ? (
        <EmptyState icon={<RouteIcon />} title={t('remitRoutes.empty')} description={t('remitRoutes.emptyHint')} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {byCountry.map(([country, rows]) => (
            <Card key={country} className="p-0">
              <h3 className="border-b border-border-subtle px-4 py-2.5 text-sm font-bold text-content">{country}</h3>
              <ul className="divide-y divide-border-subtle">
                {rows
                  .sort((a, b) => Number(Boolean(a.network)) - Number(Boolean(b.network)))
                  .map((row) => {
                    const Icon = DIRECTION_ICON[row.direction];
                    return (
                      <li key={row.id} className="flex items-center gap-2 px-4 py-2.5">
                        <span className="min-w-0 flex-1 space-y-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <Badge tone={row.network ? 'primary' : 'neutral'}>
                              {row.network ? networkLabel(t, row.network) : t('remitRoutes.anyMethod')}
                            </Badge>
                            <Badge tone={row.direction === 'IN' ? 'success' : row.direction === 'OUT' ? 'warning' : 'neutral'}>
                              <Icon className="me-1 inline size-3" />
                              {t(`remitRoutes.direction.${row.direction}`)}
                            </Badge>
                          </span>
                          <span className="flex items-center gap-1.5 text-sm font-semibold text-content">
                            <Users className="size-3.5 shrink-0 text-content-tertiary" />
                            <span className="truncate">{row.groupName ?? row.groupChat}</span>
                          </span>
                        </span>
                        <Button size="icon" variant="ghost" aria-label={t('common.edit')} onClick={() => openForm(row)}>
                          <Pencil />
                        </Button>
                        <Button size="icon" variant="ghost" aria-label={t('common.delete')} onClick={() => setRemoving(row)}>
                          <Trash2 />
                        </Button>
                      </li>
                    );
                  })}
              </ul>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.id ? t('remitRoutes.edit') : t('remitRoutes.add')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
            <Button loading={saving} disabled={!form.country.trim() || !form.groupChat} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('remitRoutes.country')} required>
            {(props) => (
              <>
                <Input
                  {...props}
                  list="route-countries"
                  value={form.country}
                  onChange={(event) => setForm((current) => ({ ...current, country: event.target.value }))}
                  placeholder={t('remitRoutes.countryHint')}
                />
                <datalist id="route-countries">
                  {countries.map((country) => (
                    <option key={country} value={country} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('remitRoutes.method')}>
              {(props) => (
                <Select
                  {...props}
                  value={form.network}
                  onChange={(event) => setForm((current) => ({ ...current, network: event.target.value }))}
                  options={[
                    { value: '', label: t('remitRoutes.anyMethod') },
                    ...networks.map((network) => ({ value: network, label: networkLabel(t, network) })),
                  ]}
                />
              )}
            </Field>
            <Field label={t('remitRoutes.directionLabel')}>
              {(props) => (
                <Select
                  {...props}
                  value={form.direction}
                  onChange={(event) => setForm((current) => ({ ...current, direction: event.target.value as Direction }))}
                  options={(['BOTH', 'IN', 'OUT'] as const).map((direction) => ({
                    value: direction,
                    label: t(`remitRoutes.direction.${direction}`),
                  }))}
                />
              )}
            </Field>
          </div>
          <Field label={t('remitRoutes.group')} required hint={t('remitRoutes.groupHint')}>
            {(props) => (
              <div className="space-y-1.5">
                <Input
                  value={groupQuery}
                  onChange={(event) => setGroupQuery(event.target.value)}
                  placeholder={t('remitRoutes.findGroup')}
                />
                {groups === null ? (
                  <Skeleton className="h-10" />
                ) : (
                  <Select
                    {...props}
                    value={form.groupChat}
                    onChange={(event) => setForm((current) => ({ ...current, groupChat: event.target.value }))}
                    options={[
                      { value: '', label: t('remitRoutes.chooseGroup') },
                      ...(chosenGroup && !shownGroups.some((group) => group.chat === chosenGroup.chat) ? [chosenGroup] : []),
                      ...shownGroups,
                    ].map((group) => ('chat' in group ? { value: group.chat, label: group.name } : group))}
                  />
                )}
              </div>
            )}
          </Field>
        </div>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => void remove()}
        title={t('remitRoutes.removeTitle')}
        message={t('remitRoutes.removeHint', { country: removing?.country ?? '', group: removing?.groupName ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
      />
    </div>
  );
}
