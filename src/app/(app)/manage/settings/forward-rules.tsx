'use client';

import { useEffect, useState } from 'react';
import { ArrowLeftRight, Plus, Trash2 } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import {
  FORWARD_KINDS,
  MAX_FORWARD_RULES,
  type ForwardRule,
} from '@/modules/whatsapp/group-forward';
import { Badge, Button } from '@/ui/primitives';
import { useToast } from '@/ui/overlay';
import { Field, Select, Switch, Textarea } from '@/ui/form';
import { GroupPicker } from './group-picker';

interface Group {
  id: string;
  name: string;
  size: number;
}

const newRule = (): ForwardRule => ({
  id: Math.random().toString(36).slice(2, 10),
  enabled: true,
  from: { id: '', name: '' },
  to: { id: '', name: '' },
  words: '',
  senders: '',
  kind: 'ALL',
});

/**
 * Messages the group number passes from one group on to another: each rule a
 * group read, a group written to, and what a message must be to go.
 */
export function ForwardRules({ canManage }: { canManage: boolean }) {
  const { t } = useLocale();
  const toast = useToast();
  const [saved, setSaved] = useState<ForwardRule[] | null>(null);
  /** The rules being changed; null when only shown. */
  const [draft, setDraft] = useState<ForwardRule[] | null>(null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<ForwardRule[]>('/api/admin/whatsapp/forward')
      .then(setSaved)
      .catch(() => setSaved([]));
  }, []);

  const failure = (cause: unknown) =>
    toast.error(
      t('errors.title'),
      cause instanceof ApiError
        ? say(t, cause.messageKey, cause.params) || cause.message
        : t('errors.generic'),
    );

  const edit = async () => {
    setBusy(true);
    try {
      setGroups(await api.get<Group[]>('/api/admin/whatsapp/groups'));
      setDraft(saved && saved.length > 0 ? saved.map((rule) => ({ ...rule })) : [newRule()]);
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(false);
    }
  };

  const change = (id: string, patch: Partial<ForwardRule>) =>
    setDraft(
      (rules) => rules?.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)) ?? null,
    );

  const pick = (id: string, side: 'from' | 'to', groupId: string) =>
    change(id, {
      [side]: { id: groupId, name: groups?.find((group) => group.id === groupId)?.name ?? '' },
    });

  const incomplete = (draft ?? []).some(
    (rule) => !rule.from.id || !rule.to.id || rule.from.id === rule.to.id,
  );

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      setSaved(await api.put<ForwardRule[]>('/api/admin/whatsapp/forward', { rules: draft }));
      setDraft(null);
      toast.success(t('whatsapp.forward.saved'));
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(false);
    }
  };

  const conditions = (rule: ForwardRule) => {
    const parts = [
      rule.words.trim() ? `${t('whatsapp.forward.words')}: ${rule.words.trim()}` : null,
      rule.senders.trim() ? `${t('whatsapp.forward.senders')}: ${rule.senders.trim()}` : null,
      rule.kind !== 'ALL' ? t(`whatsapp.forward.kind.${rule.kind}`) : null,
    ].filter(Boolean);
    return parts.length ? parts.join(' · ') : t('whatsapp.forward.everything');
  };

  return (
    <div className="space-y-2 border-t border-border-subtle pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold text-content">
          <ArrowLeftRight className="size-4 text-primary-text" />
          {t('whatsapp.forward.title')}
        </span>
        {canManage &&
          (draft === null ? (
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void edit()}>
              {saved && saved.length > 0 ? t('whatsapp.forward.edit') : t('whatsapp.forward.add')}
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
          <ul className="space-y-1.5">
            {saved.map((rule) => (
              <li key={rule.id} className="text-sm">
                <span className="font-medium text-content">
                  {rule.from.name || rule.from.id} ← {rule.to.name || rule.to.id}
                </span>
                {!rule.enabled && (
                  <Badge tone="neutral" className="ms-2">
                    {t('whatsapp.forward.off')}
                  </Badge>
                )}
                <span className="block text-xs text-content-tertiary">{conditions(rule)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-content-tertiary">{t('whatsapp.forward.none')}</p>
        )
      ) : (
        <div className="space-y-3">
          {draft.map((rule, index) => (
            <div key={rule.id} className="space-y-3 rounded-xl bg-surface-sunken p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-content">
                  {t('whatsapp.forward.rule', { index: index + 1 })}
                </span>
                <div className="flex items-center gap-3">
                  <Switch
                    checked={rule.enabled}
                    onCheckedChange={(enabled) => change(rule.id, { enabled })}
                    label={t('whatsapp.forward.enabled')}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 />}
                    aria-label={t('whatsapp.forward.remove')}
                    onClick={() =>
                      setDraft((rules) => rules?.filter((entry) => entry.id !== rule.id) ?? null)
                    }
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <span className="block text-xs text-content-secondary">
                    {t('whatsapp.forward.from')}
                  </span>
                  <GroupPicker
                    groups={groups ?? []}
                    value={rule.from.id}
                    currentName={rule.from.name}
                    unsetLabel={t('whatsapp.forward.choose')}
                    ariaLabel={t('whatsapp.forward.from')}
                    labelOf={(group) => `${group.name} (${group.size})`}
                    onChange={(id) => pick(rule.id, 'from', id)}
                  />
                </div>
                <div className="space-y-1">
                  <span className="block text-xs text-content-secondary">
                    {t('whatsapp.forward.to')}
                  </span>
                  <GroupPicker
                    groups={groups ?? []}
                    value={rule.to.id}
                    currentName={rule.to.name}
                    unsetLabel={t('whatsapp.forward.choose')}
                    ariaLabel={t('whatsapp.forward.to')}
                    labelOf={(group) => `${group.name} (${group.size})`}
                    onChange={(id) => pick(rule.id, 'to', id)}
                  />
                </div>
              </div>
              {rule.from.id && rule.from.id === rule.to.id && (
                <p className="text-xs text-warning-text">{t('whatsapp.forward.sameGroup')}</p>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('whatsapp.forward.words')} hint={t('whatsapp.forward.wordsHint')}>
                  {(props) => (
                    <Textarea
                      {...props}
                      rows={2}
                      maxLength={2000}
                      value={rule.words}
                      onChange={(event) => change(rule.id, { words: event.target.value })}
                    />
                  )}
                </Field>
                <Field
                  label={t('whatsapp.forward.senders')}
                  hint={t('whatsapp.forward.sendersHint')}
                >
                  {(props) => (
                    <Textarea
                      {...props}
                      rows={2}
                      maxLength={2000}
                      dir="ltr"
                      value={rule.senders}
                      onChange={(event) => change(rule.id, { senders: event.target.value })}
                    />
                  )}
                </Field>
              </div>

              <Field label={t('whatsapp.forward.kindLabel')}>
                {(props) => (
                  <Select
                    {...props}
                    value={rule.kind}
                    options={FORWARD_KINDS.map((kind) => ({
                      value: kind,
                      label: t(`whatsapp.forward.kind.${kind}`),
                    }))}
                    onChange={(event) =>
                      change(rule.id, { kind: event.target.value as ForwardRule['kind'] })
                    }
                  />
                )}
              </Field>
            </div>
          ))}

          {draft.length < MAX_FORWARD_RULES && (
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus />}
              onClick={() => setDraft((rules) => [...(rules ?? []), newRule()])}
            >
              {t('whatsapp.forward.addRule')}
            </Button>
          )}
        </div>
      )}
      <p className="text-xs text-content-tertiary">{t('whatsapp.forward.hint')}</p>
    </div>
  );
}
