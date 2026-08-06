'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ExternalLink, Plus, RefreshCw, Wallet as WalletIcon } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, StatTile } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Checkbox, Field, FormGrid, Input, Select } from '@/ui/form';
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
  networks: { network: string; name: string; configured: boolean }[];
  permissions: string[];
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [adding, setAdding] = useState(false);
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
          ? t(caught.messageKey as never, caught.params) || caught.message
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
                    <Link
                      href={`/usdt/transactions?walletId=${wallet.id}`}
                      className="text-sm font-medium text-content hover:text-primary-text"
                    >
                      {ln(wallet, 'label')}
                    </Link>
                    <Badge tone="neutral">{wallet.network}</Badge>
                    {!wallet.isActive && <Badge tone="danger">{t('common.inactive')}</Badge>}
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
              <Badge tone={entry.configured ? 'success' : 'neutral'} dot>
                {entry.configured ? t('common.enabled') : t('usdt.providerManual')}
              </Badge>
            </li>
          ))}
        </ul>
      </Card>

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
              <Input
                {...props}
                type="number"
                min={1}
                max={200}
                value={form.minConfirmations}
                onChange={(event) =>
                  setForm({ ...form, minConfirmations: Number(event.target.value) })
                }
                dir="ltr"
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
