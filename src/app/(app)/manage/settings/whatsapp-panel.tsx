'use client';

import { useCallback, useEffect, useState } from 'react';
import { Link2, Link2Off, Loader2, MessageCircle, Send, Users } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import {
  ROUTE_CATEGORIES,
  type GroupRoutes,
  type RouteCategory,
} from '@/modules/whatsapp/group-routes';
import { Badge, Button } from '@/ui/primitives';
import { ConfirmDialog, useToast } from '@/ui/overlay';
import { Field, Textarea } from '@/ui/form';

/**
 * The office's WhatsApp number: linked by scanning a QR from the phone, then
 * pointed at its groups. Every deal goes to the main group, or to its kind's own
 * group if it has one, once the switch below this panel is on.
 *
 * Polled quickly while a QR is up — it changes every twenty seconds or so,
 * and the moment it is scanned the panel should say so — and slowly after.
 */

type Status = 'OFF' | 'CONNECTING' | 'WAITING_QR' | 'CONNECTED';

interface Snapshot {
  status: Status;
  qrImage: string | null;
  number: string | null;
  name: string | null;
  error: string | null;
}

interface Link extends Snapshot {
  /** The second number, linked the same way. */
  second: Snapshot;
  /** The number that answers customers, linked the same way. */
  private: Snapshot;
  /** What the private number still needs before it answers anyone. */
  privateGaps: ('NOT_LINKED' | 'NO_GROUP' | 'SWITCHED_OFF' | 'NO_KEY')[];
  groupId: string;
  groupName: string;
  routes: GroupRoutes;
  welcomeMessage: string;
  enabled: boolean;
}

interface Group {
  id: string;
  name: string;
  size: number;
  /** Which number is in it, and so writes to it. */
  account: 'main' | 'second' | 'private';
}

export function WhatsappPanel({ canManage }: { canManage: boolean }) {
  const { t } = useLocale();
  const toast = useToast();
  const [link, setLink] = useState<Link | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [chosen, setChosen] = useState('');
  /** The number's groups, once the manager opens the routes to change them. */
  const [routeGroups, setRouteGroups] = useState<Group[] | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [confirmUnlinkNumber, setConfirmUnlinkNumber] = useState<'second' | 'private' | null>(null);
  /** The welcome message being edited; null until the manager types. */
  const [welcomeDraft, setWelcomeDraft] = useState<string | null>(null);
  const [confirmWelcome, setConfirmWelcome] = useState(false);

  const load = useCallback(async () => {
    try {
      setLink(await api.get<Link>('/api/admin/whatsapp'));
    } catch {
      // Kept as it was; the next poll tries again.
    }
  }, []);

  const waiting = [link?.status, link?.second.status, link?.private.status].some(
    (status) => status === 'WAITING_QR' || status === 'CONNECTING',
  );

  /** A group as listed, saying so when the second number is the one in it. */
  const groupLabel = (group: Group) =>
    `${group.name} (${group.size})${group.account === 'main' ? '' : ` · ${t(group.account === 'second' ? 'whatsapp.secondShort' : 'whatsapp.privateShort')}`}`;

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

  /** Whether it went through; a failure has already been said. */
  const act = async (body: Record<string, string>, done?: string) => {
    setBusy(body.action ?? null);
    try {
      await api.post('/api/admin/whatsapp', body);
      if (done) toast.success(done);
      await load();
      return true;
    } catch (cause) {
      failure(cause);
      return false;
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

  const openRoutes = async () => {
    setBusy('routes');
    try {
      setRouteGroups(await api.get<Group[]>('/api/admin/whatsapp/groups'));
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(null);
    }
  };

  const saveRoute = (category: RouteCategory, id: string) => {
    const name = routeGroups?.find((group) => group.id === id)?.name ?? '';
    void act({ action: 'route', category, id, name }, t('whatsapp.groupSaved'));
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
                {(link.groupId || Object.keys(link.routes).length > 0) && (
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
                      {groupLabel(group)}
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

          {/* --- Which group hears of which deals ------------------------------- */}
          <div className="space-y-2 border-t border-border-subtle pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold text-content">{t('whatsapp.routes')}</span>
              {canManage &&
                (routeGroups === null ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === 'routes'}
                    onClick={() => void openRoutes()}
                  >
                    {t('whatsapp.routesChange')}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setRouteGroups(null)}>
                    {t('common.close')}
                  </Button>
                ))}
            </div>
            {ROUTE_CATEGORIES.map((category) => {
              const route = link.routes[category];
              const unset =
                category === 'USDT_SALE'
                  ? t('whatsapp.routeSameAsUsdt')
                  : category === 'REMITTANCE_COPY' ||
                      category === 'TIKTOK_NAME' ||
                      category === 'USDT_SALE_COPY' ||
                      category === 'PRIVATE_LEADS' ||
                      category === 'PRIVATE_FORWARD'
                    ? t('whatsapp.routeNotSent')
                    : t('whatsapp.routeMain');
              return (
                <div key={category} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-content-secondary">
                    {t(`whatsapp.route.${category}`)}
                  </span>
                  {routeGroups === null ? (
                    <span className="text-sm font-medium text-content">
                      {route?.name || unset}
                    </span>
                  ) : (
                    <select
                      aria-label={t(`whatsapp.route.${category}`)}
                      value={route?.id ?? ''}
                      disabled={busy === 'route'}
                      onChange={(event) => saveRoute(category, event.target.value)}
                      className="h-10 min-w-0 flex-1 rounded-xl bg-surface-sunken px-3 text-sm font-medium text-content outline-none ring-1 ring-border-subtle focus:ring-primary sm:max-w-xs"
                    >
                      <option value="">{unset}</option>
                      {/* A group the number has since left still shows what is set. */}
                      {route && !routeGroups.some((group) => group.id === route.id) && (
                        <option value={route.id}>{route.name}</option>
                      )}
                      {routeGroups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {groupLabel(group)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              );
            })}
            <p className="text-xs text-content-tertiary">{t('whatsapp.routesHint')}</p>
          </div>

          {/* --- What a group is told when it is linked ------------------------- */}
          {canManage && (
            <div className="space-y-2 border-t border-border-subtle pt-3">
              <Field label={t('whatsapp.welcome')} hint={t('whatsapp.welcomeHint')}>
                {(props) => (
                  <Textarea
                    {...props}
                    rows={4}
                    maxLength={2000}
                    value={welcomeDraft ?? link.welcomeMessage}
                    onChange={(event) => setWelcomeDraft(event.target.value)}
                  />
                )}
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  loading={busy === 'welcome'}
                  disabled={welcomeDraft === null || welcomeDraft.trim() === link.welcomeMessage}
                  onClick={() =>
                    void act(
                      { action: 'welcome', message: welcomeDraft ?? '' },
                      t('whatsapp.welcomeSaved'),
                    ).then((saved) => {
                      // A message that failed to save stays on screen to try again.
                      if (saved) setWelcomeDraft(null);
                    })
                  }
                >
                  {t('common.save')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Send />}
                  loading={busy === 'welcomeSend'}
                  disabled={
                    !link.welcomeMessage ||
                    (welcomeDraft !== null && welcomeDraft.trim() !== link.welcomeMessage)
                  }
                  onClick={() => setConfirmWelcome(true)}
                >
                  {t('whatsapp.welcomeSendNow')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* --- The other numbers ---------------------------------------------- */}
      {link.status === 'CONNECTED' &&
        (['second', 'private'] as const).map((account) => {
          const number = link[account];
          return (
        <div key={account} className="space-y-3 rounded-xl bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="flex items-center gap-2 text-sm font-semibold text-content">
                {t(`whatsapp.${account}Number`)}
                {number.status === 'CONNECTED' ? (
                  <Badge tone="success">{t('whatsapp.linked')}</Badge>
                ) : number.status === 'OFF' ? (
                  <Badge tone="neutral">{t('whatsapp.notLinked')}</Badge>
                ) : (
                  <Badge tone="warning">{t('whatsapp.linking')}</Badge>
                )}
              </p>
              {number.status === 'CONNECTED' && number.number && (
                <p className="text-sm text-content-secondary">
                  <span className="ltr-content tabular-nums">+{number.number}</span>
                  {number.name && <span> · {number.name}</span>}
                </p>
              )}
            </div>
            {canManage &&
              (number.status === 'CONNECTED' ? (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Link2Off />}
                  onClick={() => setConfirmUnlinkNumber(account)}
                >
                  {t('whatsapp.unlink')}
                </Button>
              ) : number.status === 'OFF' ? (
                <Button
                  size="sm"
                  icon={<Link2 />}
                  loading={busy === 'connect'}
                  onClick={() => void act({ action: 'connect', account })}
                >
                  {t(`whatsapp.${account}Link`)}
                </Button>
              ) : null)}
          </div>

          {number.status === 'OFF' && number.error && (
            <p className="rounded-xl bg-warning-subtle px-3 py-2 text-sm text-content-secondary">
              {t(`whatsapp.error.${number.error}` as never)}
            </p>
          )}

          {number.status === 'WAITING_QR' && number.qrImage && (
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={number.qrImage}
                alt="QR"
                width={220}
                height={220}
                className="rounded-lg bg-white p-2 ring-1 ring-border-subtle"
              />
              <ol className="list-inside list-decimal space-y-2 text-sm text-content-secondary">
                <li>{t(`whatsapp.${account}Step`)}</li>
                <li>{t('whatsapp.step2')}</li>
                <li>{t('whatsapp.step3')}</li>
                <li>{t('whatsapp.step4')}</li>
              </ol>
            </div>
          )}

          {account === 'private' &&
            (link.privateGaps.length === 0 ? (
              <p className="rounded-xl bg-success-subtle px-3 py-2 text-sm font-medium text-content">
                {t('whatsapp.privateReady')}
              </p>
            ) : (
              <div className="rounded-xl bg-warning-subtle px-3 py-2 text-sm text-content-secondary">
                <p className="font-medium text-content">{t('whatsapp.privateNotReady')}</p>
                <ul className="mt-1 list-inside list-disc space-y-1">
                  {link.privateGaps.map((gap) => (
                    <li key={gap}>{t(`whatsapp.privateGap.${gap}`)}</li>
                  ))}
                </ul>
              </div>
            ))}

          <p className="text-xs text-content-tertiary">{t(`whatsapp.${account}Hint`)}</p>
        </div>
          );
        })}

      <p className="text-xs text-content-tertiary">{t('whatsapp.advice')}</p>

      <ConfirmDialog
        open={confirmWelcome}
        onClose={() => setConfirmWelcome(false)}
        onConfirm={() => {
          setConfirmWelcome(false);
          void act({ action: 'welcomeSend' }, t('whatsapp.welcomeSent'));
        }}
        title={t('whatsapp.welcomeConfirmTitle')}
        message={t('whatsapp.welcomeConfirmBody')}
        confirmLabel={t('whatsapp.welcomeSendNow')}
        cancelLabel={t('common.cancel')}
      />

      <ConfirmDialog
        open={confirmUnlinkNumber !== null}
        onClose={() => setConfirmUnlinkNumber(null)}
        onConfirm={() => {
          if (confirmUnlinkNumber) {
            void act({ action: 'disconnect', account: confirmUnlinkNumber }, t('whatsapp.unlinked'));
          }
          setConfirmUnlinkNumber(null);
        }}
        title={t(`whatsapp.${confirmUnlinkNumber ?? 'second'}UnlinkTitle`)}
        message={t(`whatsapp.${confirmUnlinkNumber ?? 'second'}UnlinkBody`)}
        confirmLabel={t('whatsapp.unlink')}
        cancelLabel={t('common.cancel')}
        tone="danger"
      />

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
