'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Plus, RefreshCw, Trash2, Wallet as WalletIcon } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import type { TranslationKey } from '@/i18n/types';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, StatTile } from '@/ui/primitives';
import { ConfirmDialog, Dialog, useToast } from '@/ui/overlay';
import { Checkbox, Field, FormGrid, Input, NumberInput, Select, Switch } from '@/ui/form';
import { DateText, Money, StatusBadge } from '@/ui/display';

interface WalletRow {
  id: string;
  label: string;
  labelAr: string;
  network: string;
  address: string;
  maskedAddress: string;
  tokenSymbol: string;
  balance: string;
  balanceUpdatedAt: string | null;
  isActive: boolean;
  isWatchOnly: boolean;
  minConfirmations: number;
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  autoCreateTransaction: boolean;
  isCounterAddress: boolean;
  counterSortOrder: number;
  _count: { transactions: number };
}

interface Portfolio {
  byToken: { token: string; total: string; wallets: number }[];
  byNetwork: { network: string; total: string; wallets: number }[];
  walletCount: number;
}

export function WalletsView({
  wallets,
  portfolio,
  networks,
  permissions,
}: {
  wallets: WalletRow[];
  portfolio: Portfolio;
  networks: {
    network: string;
    name: string;
    configured: boolean;
    credentials: 'NOT_REQUIRED' | 'KEYED' | 'ANONYMOUS' | 'REJECTED';
  }[];
  permissions: string[];
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<WalletRow | null>(null);
  const [deleting, setDeleting] = useState<WalletRow | null>(null);

  const [editForm, setEditForm] = useState({
    label: '',
    labelAr: '',
    minConfirmations: 19,
    notifyOnIncoming: true,
    notifyOnOutgoing: true,
    isCounterAddress: false,
    counterSortOrder: 0,
    isActive: true,
  });

  const openEdit = (wallet: WalletRow) => {
    setError(null);
    setEditForm({
      label: wallet.label,
      labelAr: wallet.labelAr,
      minConfirmations: wallet.minConfirmations,
      notifyOnIncoming: true,
      notifyOnOutgoing: true,
      isCounterAddress: wallet.isCounterAddress,
      counterSortOrder: wallet.counterSortOrder ?? 0,
      isActive: wallet.isActive,
    });
    setEditing(wallet);
  };
  const [syncing, setSyncing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    label: '',
    labelAr: '',
    network: 'TRON',
    address: '',
    minConfirmations: 19,
    notifyOnIncoming: true,
    notifyOnOutgoing: true,
    autoCreateTransaction: true,
  });

  const canManage = permissions.includes('usdt.wallet.manage');
  const canSync = permissions.includes('usdt.wallet.sync');

  /**
   * Releasing an address to the counter, or withdrawing it.
   *
   * Kept as a direct toggle on the row rather than buried in an edit dialog: it
   * is the one wallet property that decides what a customer is shown, and a
   * manager should be able to see and change it in the same glance.
   */
  const setCounterAddress = async (walletId: string, isCounterAddress: boolean) => {
    try {
      await api.patch(`/api/usdt/wallets/${walletId}`, { isCounterAddress });
      toast.success(t('common.saved'));
      router.refresh();
    } catch (caught) {
      toast.error(
        t('errors.title'),
        caught instanceof ApiError ? caught.message : t('errors.generic'),
      );
    }
  };

  const sync = async (walletId: string) => {
    setSyncing(walletId);
    try {
      const result = await api.post<{ created: number; updated: number; status: string }>(
        `/api/usdt/wallets/${walletId}`,
        { action: 'sync' },
      );

      if (result.status === 'ERROR') {
        toast.error(t('usdt.status.ERROR'), t('usdt.providerNotConfigured'));
      } else {
        toast.success(t('common.saved'), `${result.created} ${t('usdt.transactions')}`);
      }
      router.refresh();
    } catch (caught) {
      toast.error(
        t('errors.title'),
        caught instanceof ApiError ? caught.message : t('errors.generic'),
      );
    } finally {
      setSyncing(null);
    }
  };

  const save = async () => {
    if (!editing) return;
    setError(null);
    setBusy(true);
    try {
      await api.patch(`/api/usdt/wallets/${editing.id}`, editForm);
      toast.success(t('common.saved'), editForm.label);
      setEditing(null);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? say(t, caught.messageKey, caught.params) || caught.message
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.delete(`/api/usdt/wallets/${deleting.id}`);
      toast.success(t('usdt.walletDeleted'), deleting.label);
      setDeleting(null);
      router.refresh();
    } catch (caught) {
      // Refusing to delete an address with history is the expected answer, not
      // a failure — so it is said plainly rather than swallowed.
      toast.error(
        t('errors.title'),
        caught instanceof ApiError
          ? say(t, caught.messageKey, caught.params) || caught.message
          : t('errors.generic'),
      );
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.post('/api/usdt/wallets', form);
      toast.success(t('common.saved'), form.label);
      setAdding(false);
      setForm({ ...form, label: '', labelAr: '', address: '' });
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? say(t, caught.messageKey, caught.params) || caught.message
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  const manualOnly = networks.find((entry) => entry.network === form.network)?.configured === false;

  return (
    <div className="space-y-4">
      {/* --- Position --------------------------------------------------- */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {portfolio.byToken.map((entry) => (
          <StatTile
            key={entry.token}
            label={`${t('usdt.totalHoldings')} — ${entry.token}`}
            value={<Money value={entry.total} decimals={2} />}
            hint={`${entry.wallets} ${t('usdt.wallets')}`}
            icon={<WalletIcon />}
          />
        ))}
        {portfolio.byToken.length === 0 && (
          <StatTile label={t('usdt.totalHoldings')} value="0" icon={<WalletIcon />} />
        )}
      </div>

      {/* --- Wallets ---------------------------------------------------- */}
      <Card>
        <CardHeader
          title={t('usdt.wallets')}
          actions={
            <div className="flex items-center gap-2">
              {canManage && (
                <Button variant="primary" size="sm" icon={<Plus />} onClick={() => setAdding(true)}>
                  {t('usdt.addWallet')}
                </Button>
              )}
            </div>
          }
        />

        {wallets.length === 0 ? (
          <EmptyState
            icon={<WalletIcon />}
            title={t('usdt.noWallets')}
            description={t('usdt.noWalletsHint')}
            action={
              canManage && (
                <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
                  {t('usdt.addWallet')}
                </Button>
              )
            }
          />
        ) : (
          <ul className="divide-y divide-border-base">
            {wallets.map((wallet) => (
              <li key={wallet.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-content">{ln(wallet, 'label')}</span>
                    <Badge tone="neutral">{wallet.network}</Badge>
                    {!wallet.isActive && <Badge tone="danger">{t('common.inactive')}</Badge>}
                    {wallet.isCounterAddress && (
                      <Badge tone="primary">{t('usdt.counterAddress')}</Badge>
                    )}
                    {wallet.lastSyncStatus && (
                      <StatusBadge status={wallet.lastSyncStatus} scope="usdt" />
                    )}
                  </div>

                  <p className="mt-1 font-mono text-xs text-content-tertiary ltr-content">
                    {wallet.maskedAddress}
                  </p>

                  <p className="mt-0.5 text-xs text-content-tertiary">
                    {t('usdt.lastSynced')}:{' '}
                    {wallet.lastSyncedAt ? (
                      <DateText value={wallet.lastSyncedAt} relative />
                    ) : (
                      t('common.never')
                    )}
                    {' · '}
                    {wallet._count.transactions} {t('usdt.transactions')}
                  </p>

                  {wallet.lastSyncError && (
                    <p className="mt-1 truncate text-xs text-danger-text">{wallet.lastSyncError}</p>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <Money
                    value={wallet.balance}
                    currency={wallet.tokenSymbol}
                    className="text-sm font-semibold"
                  />
                  {canManage && (
                    <Switch
                      checked={wallet.isCounterAddress}
                      onCheckedChange={(next) => void setCounterAddress(wallet.id, next)}
                      label={t('usdt.counterAddress')}
                    />
                  )}
                  {canSync && (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<RefreshCw />}
                      loading={syncing === wallet.id}
                      onClick={() => void sync(wallet.id)}
                    >
                      {t('usdt.sync')}
                    </Button>
                  )}
                  {canManage && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        title={t('common.edit')}
                        onClick={() => openEdit(wallet)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title={t('common.delete')}
                        onClick={() => setDeleting(wallet)}
                      >
                        <Trash2 className="size-4 text-danger-text" />
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* --- Provider status ------------------------------------------- */}
      <Card>
        <CardHeader title={t('settings.category.usdt')} />
        <ul className="divide-y divide-border-base">
          {networks.map((entry) => (
            <li key={entry.network} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div>
                <p className="text-sm text-content">{entry.name}</p>
                <p className="text-xs text-content-tertiary">{entry.network}</p>
              </div>
              {/*
                Not "enabled" — that word could not tell a working key from a
                key that never reached the server, because TronGrid answers
                anonymous requests too. This states which of the two it is.
              */}
              <Badge tone={providerBadge(entry).tone} dot>
                {t(providerBadge(entry).labelKey)}
              </Badge>
            </li>
          ))}
        </ul>
      </Card>

      {/* --- Edit wallet --------------------------------------------------- */}
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `${t('common.edit')} — ${editing.label}` : t('common.edit')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!editForm.label || !editForm.labelAr}
              onClick={() => void save()}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {error && <Alert tone="danger">{error}</Alert>}

          {/* The address is the wallet's identity: every transfer ever detected
              is attached to it. Changing it would reattach that history to
              somebody else's money. */}
          <Alert tone="neutral">{t('usdt.addressFixed')}</Alert>
          {editing && (
            <p className="break-all rounded-[var(--radius-control)] bg-surface-sunken p-2 font-mono text-xs text-content-secondary ltr-content">
              {editing.address}
            </p>
          )}

          <FormGrid columns={2}>
            <Field label={t('usdt.labelAr')} required>
              {(props) => (
                <Input
                  {...props}
                  value={editForm.labelAr}
                  onChange={(event) => setEditForm({ ...editForm, labelAr: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('usdt.label')} required>
              {(props) => (
                <Input
                  {...props}
                  value={editForm.label}
                  onChange={(event) => setEditForm({ ...editForm, label: event.target.value })}
                  dir="ltr"
                />
              )}
            </Field>
          </FormGrid>

          <FormGrid columns={2}>
            <Field label={t('usdt.minConfirmations')} hint={t('usdt.minConfirmationsHint')}>
              {(props) => (
                <NumberInput
                  {...props}
                  min={1}
                  max={200}
                  value={editForm.minConfirmations}
                  onValueChange={(minConfirmations) => setEditForm({ ...editForm, minConfirmations })}
                />
              )}
            </Field>
            <Field label={t('usdt.counterOrder')} hint={t('usdt.counterOrderHint')}>
              {(props) => (
                <NumberInput
                  {...props}
                  min={0}
                  max={999}
                  value={editForm.counterSortOrder}
                  onValueChange={(counterSortOrder) => setEditForm({ ...editForm, counterSortOrder })}
                />
              )}
            </Field>
          </FormGrid>

          <div className="space-y-2">
            <Switch
              checked={editForm.isCounterAddress}
              onCheckedChange={(next) => setEditForm({ ...editForm, isCounterAddress: next })}
              label={t('usdt.counterAddress')}
              description={t('usdt.counterAddressHint')}
            />
            <Switch
              checked={editForm.isActive}
              onCheckedChange={(next) => setEditForm({ ...editForm, isActive: next })}
              label={t('common.active')}
              description={t('usdt.activeHint')}
            />
          </div>
        </div>
      </Dialog>

      {/* --- Delete wallet ------------------------------------------------- */}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        title={t('usdt.deleteWallet')}
        message={deleting ? t('usdt.deleteWalletConfirm', { label: deleting.label }) : ''}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        loading={busy}
      >
        <Alert tone="warning">{t('usdt.deleteWalletHint')}</Alert>
      </ConfirmDialog>

      {/* --- Add wallet -------------------------------------------------- */}
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title={t('usdt.addWallet')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!form.label || !form.labelAr || !form.address}
              onClick={() => void create()}
            >
              {t('common.create')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          {manualOnly && <Alert tone="warning">{t('usdt.providerNotConfigured')}</Alert>}

          <FormGrid columns={2}>
            <Field label={t('usdt.label')} required>
              {(props) => (
                <Input
                  {...props}
                  value={form.label}
                  onChange={(event) => setForm({ ...form, label: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('usdt.labelAr')} required>
              {(props) => (
                <Input
                  {...props}
                  value={form.labelAr}
                  onChange={(event) => setForm({ ...form, labelAr: event.target.value })}
                />
              )}
            </Field>
          </FormGrid>

          <Field label={t('usdt.network')} required>
            {(props) => (
              <Select
                {...props}
                options={networks.map((entry) => ({
                  value: entry.network,
                  label: `${entry.network} — ${entry.name}`,
                }))}
                value={form.network}
                onChange={(event) => setForm({ ...form, network: event.target.value })}
              />
            )}
          </Field>

          <Field label={t('usdt.address')} required hint={t('validation.invalidAddress')}>
            {(props) => (
              <Input
                {...props}
                value={form.address}
                onChange={(event) => setForm({ ...form, address: event.target.value.trim() })}
                dir="ltr"
                className="font-mono text-xs"
              />
            )}
          </Field>

          <Field label={t('usdt.minConfirmations')}>
            {(props) => (
              <NumberInput
                {...props}
                min={1}
                max={200}
                value={form.minConfirmations}
                onValueChange={(minConfirmations) => setForm({ ...form, minConfirmations })}
              />
            )}
          </Field>

          <Checkbox
            checked={form.autoCreateTransaction}
            onChange={(event) =>
              setForm({ ...form, autoCreateTransaction: event.target.checked })
            }
            label={t('usdt.autoCreate')}
            description={t('usdt.autoCreateHint')}
          />

          <div className="flex gap-6">
            <Checkbox
              checked={form.notifyOnIncoming}
              onChange={(event) => setForm({ ...form, notifyOnIncoming: event.target.checked })}
              label={t('usdt.notifyIncoming')}
            />
            <Checkbox
              checked={form.notifyOnOutgoing}
              onChange={(event) => setForm({ ...form, notifyOnOutgoing: event.target.checked })}
              label={t('usdt.notifyOutgoing')}
            />
          </div>
        </div>
      </Dialog>
    </div>
  );
}

/**
 * How a network's provider is actually reaching the chain.
 *
 * The distinction that matters to a manager is not "on or off" but "is it using
 * the key I configured". TronGrid answers anonymous requests at a low rate, so
 * a key that never reached the server behaves identically to a working one
 * until volume arrives — which is exactly when nobody wants to discover it.
 */
function providerBadge(entry: {
  configured: boolean;
  credentials: 'NOT_REQUIRED' | 'KEYED' | 'ANONYMOUS' | 'REJECTED';
}): { tone: 'success' | 'warning' | 'danger' | 'neutral'; labelKey: TranslationKey } {
  if (!entry.configured) return { tone: 'neutral', labelKey: 'usdt.providerManual' };

  switch (entry.credentials) {
    case 'KEYED':
      return { tone: 'success', labelKey: 'usdt.providerKeyed' };
    case 'REJECTED':
      return { tone: 'danger', labelKey: 'usdt.providerRejected' };
    case 'ANONYMOUS':
      return { tone: 'warning', labelKey: 'usdt.providerAnonymous' };
    default:
      return { tone: 'neutral', labelKey: 'usdt.providerManual' };
  }
}
