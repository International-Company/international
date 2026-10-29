'use client';

import { useCallback, useEffect, useState } from 'react';
import { Link2, Link2Off, Loader2, MessageCircle, Send, Users } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Badge, Button } from '@/ui/primitives';
import { ConfirmDialog, useToast } from '@/ui/overlay';

/**
 * The office's WhatsApp number: linked by scanning a QR from the phone, then
 * pointed at one of its groups. Every deal goes there once the switch below
 * this panel is on.
 *
 * Polled quickly while a QR is up — it changes every twenty seconds or so,
 * and the moment it is scanned the panel should say so — and slowly after.
 */

type Status = 'OFF' | 'CONNECTING' | 'WAITING_QR' | 'CONNECTED';

interface Link {
  status: Status;
  qrImage: string | null;
  number: string | null;
  name: string | null;
  error: string | null;
  groupId: string;
  groupName: string;
  enabled: boolean;
}

interface Group {
  id: string;
  name: string;
  size: number;
}

export function WhatsappPanel({ canManage }: { canManage: boolean }) {
  const { t } = useLocale();
  const toast = useToast();
  const [link, setLink] = useState<Link | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [chosen, setChosen] = useState('');
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  const load = useCallback(async () => {
    try {
      setLink(await api.get<Link>('/api/admin/whatsapp'));
    } catch {
      // Kept as it was; the next poll tries again.
    }
  }, []);

  const waiting = link?.status === 'WAITING_QR' || link?.status === 'CONNECTING';

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), waiting ? 2_000 : 15_000);
    return () => clearInterval(timer);
  }, [load, waiting]);

  const failure = (cause: unknown) =>
    toast.error(
      t('errors.title'),
      cause instanceof ApiError
        ? say(t, cause.messageKey, cause.params) || cause.message
        : t('errors.generic'),
    );

  const act = async (body: Record<string, string>, done?: string) => {
    setBusy(body.action ?? null);
    try {
      await api.post('/api/admin/whatsapp', body);
      if (done) toast.success(done);
      await load();
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(null);
    }
  };

  const loadGroups = async () => {
    setBusy('groups');
    try {
      const list = await api.get<Group[]>('/api/admin/whatsapp/groups');
      setGroups(list);
      setChosen(
        link?.groupId && list.some((g) => g.id === link.groupId)
          ? link.groupId
          : (list[0]?.id ?? ''),
      );
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(null);
    }
  };

  const saveGroup = async () => {
    const group = groups?.find((entry) => entry.id === chosen);
    if (!group) return;
    await act({ action: 'group', id: group.id, name: group.name }, t('whatsapp.groupSaved'));
    setGroups(null);
  };

  if (!link) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-surface-sunken p-4 text-sm text-content-tertiary">
        <Loader2 className="size-4 animate-spin" />
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-2xl bg-surface-sunken p-4">
      {/* --- The link --------------------------------------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-success-subtle text-success-text">
            <MessageCircle className="size-5" />
          </span>
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold text-content">
              {t('whatsapp.number')}
              {link.status === 'CONNECTED' ? (
                <Badge tone="success">{t('whatsapp.linked')}</Badge>
              ) : link.status === 'OFF' ? (
                <Badge tone="neutral">{t('whatsapp.notLinked')}</Badge>
              ) : (
                <Badge tone="warning">{t('whatsapp.linking')}</Badge>
              )}
            </p>
            {link.status === 'CONNECTED' && link.number && (
              <p className="text-sm text-content-secondary">
                <span className="ltr-content tabular-nums">+{link.number}</span>
                {link.name && <span> · {link.name}</span>}
              </p>
            )}
          </div>
        </div>

        {canManage &&
          (link.status === 'CONNECTED' ? (
            <Button variant="secondary" icon={<Link2Off />} onClick={() => setConfirmUnlink(true)}>
              {t('whatsapp.unlink')}
            </Button>
          ) : link.status === 'OFF' ? (
            <Button
              icon={<Link2 />}
              loading={busy === 'connect'}
              onClick={() => void act({ action: 'connect' })}
            >
              {t('whatsapp.link')}
            </Button>
          ) : null)}
      </div>

      {link.status === 'OFF' && link.error && (
        <p className="rounded-xl bg-warning-subtle px-3 py-2 text-sm text-content-secondary">
          {t(`whatsapp.error.${link.error}` as never)}
        </p>
      )}

      {link.status === 'CONNECTING' && (
        <p className="flex items-center gap-2 text-sm text-content-secondary">
          <Loader2 className="size-4 animate-spin" />
          {t('whatsapp.connecting')}
        </p>
      )}

      {/* --- The QR, with the steps on the phone ------------------------------ */}
      {link.status === 'WAITING_QR' && link.qrImage && (
        <div className="flex flex-col items-center gap-4 rounded-xl bg-surface p-4 sm:flex-row sm:items-start">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={link.qrImage}
            alt="QR"
            width={220}
            height={220}
            className="rounded-lg bg-white p-2 ring-1 ring-border-subtle"
          />
          <ol className="list-inside list-decimal space-y-2 text-sm text-content-secondary">
            <li>{t('whatsapp.step1')}</li>
            <li>{t('whatsapp.step2')}</li>
            <li>{t('whatsapp.step3')}</li>
            <li>{t('whatsapp.step4')}</li>
            <li className="list-none pt-1 text-xs text-content-tertiary">
              {t('whatsapp.qrRefresh')}
            </li>
          </ol>
        </div>
      )}

      {/* --- The group --------------------------------------------------------- */}
      {link.status === 'CONNECTED' && (
        <div className="space-y-3 rounded-xl bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Users className="size-4 text-primary-text" />
              <span className="text-sm text-content-secondary">{t('whatsapp.group')}:</span>
              <span className="text-sm font-semibold text-content">
                {link.groupName || t('whatsapp.noGroup')}
              </span>
            </div>
            {canManage && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === 'groups'}
                  onClick={() => void loadGroups()}
                >
                  {link.groupId ? t('whatsapp.changeGroup') : t('whatsapp.chooseGroup')}
                </Button>
                {link.groupId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Send />}
                    loading={busy === 'test'}
                    onClick={() => void act({ action: 'test' }, t('whatsapp.testSent'))}
                  >
                    {t('whatsapp.test')}
                  </Button>
                )}
              </div>
            )}
          </div>

          {groups !== null &&
            (groups.length === 0 ? (
              <p className="text-sm text-content-tertiary">{t('whatsapp.noGroups')}</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={chosen}
                  onChange={(event) => setChosen(event.target.value)}
                  className="h-10 min-w-0 flex-1 rounded-xl bg-surface-sunken px-3 text-sm font-medium text-content outline-none ring-1 ring-border-subtle focus:ring-primary"
                >
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name} ({group.size})
                    </option>
                  ))}
                </select>
                <Button size="sm" loading={busy === 'group'} onClick={() => void saveGroup()}>
                  {t('common.save')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setGroups(null)}>
                  {t('common.cancel')}
                </Button>
              </div>
            ))}

          {!link.enabled && link.groupId && (
            <p className="text-xs text-warning-text">{t('whatsapp.switchOff')}</p>
          )}
        </div>
      )}

      <p className="text-xs text-content-tertiary">{t('whatsapp.advice')}</p>

      <ConfirmDialog
        open={confirmUnlink}
        onClose={() => setConfirmUnlink(false)}
        onConfirm={() => {
          setConfirmUnlink(false);
          void act({ action: 'disconnect' }, t('whatsapp.unlinked'));
        }}
        title={t('whatsapp.unlinkTitle')}
        message={t('whatsapp.unlinkBody')}
        confirmLabel={t('whatsapp.unlink')}
        cancelLabel={t('common.cancel')}
        tone="danger"
      />
    </div>
  );
}
