'use client';

import { useEffect, useState } from 'react';
import { Music2, Plus, Trash2 } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Button } from '@/ui/primitives';
import { Input } from '@/ui/form';
import { useToast } from '@/ui/overlay';
import { GroupPicker } from './group-picker';

interface Group {
  id: string;
  name: string;
  size: number;
}

interface Recipient {
  name: string;
  group: { id: string; name: string };
}

/**
 * Whom TikTok withdrawals are sent to: a name each, chosen on the TikTok screen,
 * and the group that hears of the withdrawals sent to them. With none set, every
 * withdrawal goes to the TikTok group, as before.
 */
export function TiktokRecipients({ canManage }: { canManage: boolean }) {
  const { t } = useLocale();
  const toast = useToast();
  const [saved, setSaved] = useState<Recipient[] | null>(null);
  /** The list being changed; null when only shown. */
  const [draft, setDraft] = useState<Recipient[] | null>(null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<Recipient[]>('/api/admin/whatsapp/tiktok')
      .then(setSaved)
      .catch(() => setSaved([]));
  }, []);

  const failure = (cause: unknown) =>
    toast.error(
      t('errors.title'),
      cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'),
    );

  const edit = async () => {
    setBusy(true);
    try {
      setGroups(await api.get<Group[]>('/api/admin/whatsapp/groups'));
      setDraft(
        saved && saved.length > 0
          ? saved.map((entry) => ({ ...entry, group: { ...entry.group } }))
          : [{ name: '', group: { id: '', name: '' } }, { name: '', group: { id: '', name: '' } }],
      );
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(false);
    }
  };

  const change = (index: number, patch: Partial<Recipient>) =>
    setDraft((list) => list?.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)) ?? null);

  const names = (draft ?? []).map((entry) => entry.name.trim());
  const incomplete = (draft ?? []).some(
    (entry, index) => !entry.name.trim() || !entry.group.id || names.indexOf(entry.name.trim()) !== index,
  );

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      setSaved(await api.put<Recipient[]>('/api/admin/whatsapp/tiktok', { recipients: draft }));
      setDraft(null);
      toast.success(t('whatsapp.tiktokRecipients.saved'));
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 border-t border-border-subtle pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold text-content">
          <Music2 className="size-4 text-primary-text" />
          {t('whatsapp.tiktokRecipients.title')}
        </span>
        {canManage &&
          (draft === null ? (
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void edit()}>
              {saved && saved.length > 0 ? t('whatsapp.tiktokRecipients.edit') : t('whatsapp.tiktokRecipients.add')}
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button size="sm" loading={busy} disabled={incomplete} onClick={() => void save()}>
                {t('common.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          ))}
      </div>

      {draft === null ? (
        saved && saved.length > 0 ? (
          <ul className="space-y-1">
            {saved.map((entry) => (
              <li key={entry.name} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-semibold text-content">{entry.name}</span>
                <span className="text-content-secondary">{entry.group.name || entry.group.id}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-content-tertiary">{t('whatsapp.tiktokRecipients.none')}</p>
        )
      ) : (
        <div className="space-y-2">
          {draft.map((entry, index) => (
            <div key={index} className="grid gap-2 rounded-xl bg-surface-sunken p-3 sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-center">
              <Input
                value={entry.name}
                maxLength={60}
                placeholder={t('whatsapp.tiktokRecipients.name')}
                aria-label={t('whatsapp.tiktokRecipients.name')}
                onChange={(event) => change(index, { name: event.target.value })}
              />
              <GroupPicker
                groups={groups ?? []}
                value={entry.group.id}
                currentName={entry.group.name}
                unsetLabel={t('whatsapp.tiktokRecipients.choose')}
                ariaLabel={t('whatsapp.tiktokRecipients.group')}
                labelOf={(group) => `${group.name} (${group.size})`}
                onChange={(id) =>
                  change(index, { group: { id, name: groups?.find((group) => group.id === id)?.name ?? '' } })
                }
              />
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 />}
                aria-label={t('whatsapp.tiktokRecipients.remove')}
                onClick={() => setDraft((list) => list?.filter((_, at) => at !== index) ?? null)}
              />
            </div>
          ))}
          {draft.length < 10 && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus />}
              onClick={() => setDraft((list) => [...(list ?? []), { name: '', group: { id: '', name: '' } }])}
            >
              {t('whatsapp.tiktokRecipients.another')}
            </Button>
          )}
          <p className="text-xs text-content-tertiary">{t('whatsapp.tiktokRecipients.hint')}</p>
        </div>
      )}
    </div>
  );
}
