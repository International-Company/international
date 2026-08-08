'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, Check, Power, TrendingUp, TriangleAlert, Vault } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, StatTile } from '@/ui/primitives';
import { useToast } from '@/ui/overlay';
import { Field, Input, MoneyInput, Switch } from '@/ui/form';
import { Money } from '@/ui/display';
import { cn } from '@/ui/utils';

/**
 * The machine, from the manager's chair.
 *
 * A pair is tradeable only when three things line up: it is switched on, a rate
 * exists for it, and the drawer it pays out of has money. Those live in three
 * different places in the data and used to live on three different screens, so
 * a manager could switch a pair on and believe the counter could trade it. Here
 * each pair states all three, and says which one is missing.
 */

interface PairRow {
  key: string;
  from: string;
  to: string;
  enabled: boolean;
  hasRate: boolean;
  servedBy: string | null;
  payoutBalance: string;
  payoutDecimals: number;
}

interface Config {
  enabled: boolean;
  pairs: string[];
  quickAmounts: number[];
  maxAmount: string;
  requireCustomerAbove: string;
}

export function MachineControlView({
  config,
  pairs,
  drawers,
  today,
  canManage,
  canSeeMargin,
}: {
  config: Config;
  pairs: PairRow[];
  drawers: { currency: string; balance: string; decimals: number }[];
  today: { count: number; profit: string };
  canManage: boolean;
  canSeeMargin: boolean;
}) {
  const { t } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [busy, setBusy] = useState<string | null>(null);
  const [limit, setLimit] = useState(decimal(config.maxAmount));
  const [customerAbove, setCustomerAbove] = useState(decimal(config.requireCustomerAbove));
  const [quick, setQuick] = useState(config.quickAmounts.join(', '));

  const save = async (values: Record<string, unknown>, key: string) => {
    setBusy(key);
    try {
      await api.patch('/api/admin/settings', { values });
      toast.success(t('common.saved'));
      router.refresh();
    } catch (caught) {
      toast.error(
        t('errors.title'),
        caught instanceof ApiError
          ? t(caught.messageKey as never, caught.params as Record<string, string>) || caught.message
          : t('errors.generic'),
      );
    } finally {
      setBusy(null);
    }
  };

  /**
   * Turning a pair on or off.
   *
   * The setting is a comma-separated list, which is the right shape to store a
   * handful of fixed strings but a poor thing to hand a manager. The toggle
   * writes the list; nobody has to type it.
   */
  const togglePair = async (key: string, on: boolean) => {
    const next = pairs
      .filter((pair) => (pair.key === key ? on : pair.enabled))
      .map((pair) => pair.key);
    await save({ 'machine.pairs': next.join(',') }, key);
  };

  const blocked = pairs.filter((pair) => pair.enabled && !pair.hasRate);
  const dry = pairs.filter(
    (pair) => pair.enabled && pair.hasRate && BigInt(pair.payoutBalance) === 0n,
  );

  return (
    <div className="space-y-4">
      {/* --- Is the machine working? ------------------------------------- */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile
          label={t('machineControl.state')}
          value={config.enabled ? t('common.enabled') : t('common.disabled')}
          tone={config.enabled ? 'success' : 'danger'}
          icon={<Power />}
        />
        <StatTile
          label={t('machineControl.todayCount')}
          value={today.count}
          icon={<TrendingUp />}
        />
        {canSeeMargin && (
          <StatTile label={t('transactions.profit')} value={<Money value={today.profit} />} />
        )}
      </div>

      {(blocked.length > 0 || dry.length > 0) && (
        <Alert tone="warning" icon={<TriangleAlert />} title={t('machineControl.notReadyTitle')}>
          {blocked.length > 0 && (
            <p>
              {t('machineControl.needsRate', {
                pairs: blocked.map((p) => p.key).join('، '),
              })}{' '}
              <Link href="/manage/rates" className="underline">
                {t('nav.rates')}
              </Link>
            </p>
          )}
          {dry.length > 0 && (
            <p className="mt-1">
              {t('machineControl.needsCash', {
                currencies: [...new Set(dry.map((p) => p.to))].join('، '),
              })}{' '}
              <Link href="/manage/drawers" className="underline">
                {t('nav.drawers')}
              </Link>
            </p>
          )}
        </Alert>
      )}

      {/* --- The six pairs ----------------------------------------------- */}
      <Card>
        <CardHeader
          title={t('machineControl.pairs')}
          description={t('machineControl.pairsHint')}
          actions={
            canManage && (
              <Switch
                checked={config.enabled}
                onCheckedChange={(next) => void save({ 'machine.enabled': next }, 'enabled')}
                label={t('machineControl.state')}
              />
            )
          }
        />

        <ul className="divide-y divide-border-base">
          {pairs.map((pair) => {
            const balance = BigInt(pair.payoutBalance);
            const ready = pair.enabled && pair.hasRate && balance > 0n;

            return (
              <li
                key={pair.key}
                className={cn(
                  'flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4',
                  !pair.enabled && 'opacity-60',
                )}
              >
                <div className="flex items-center gap-2 sm:w-36">
                  <span className="font-mono text-sm font-semibold text-content ltr-content">
                    {pair.from}
                  </span>
                  <ArrowRight className="size-3 shrink-0 text-content-tertiary rtl:rotate-180" />
                  <span className="font-mono text-sm font-semibold text-content ltr-content">
                    {pair.to}
                  </span>
                </div>

                {/* The three conditions, each answered rather than implied. */}
                <div className="flex flex-1 flex-wrap items-center gap-2">
                  <Condition ok={pair.enabled} label={t('machineControl.offered')} />
                  <Condition
                    ok={pair.hasRate}
                    label={
                      pair.hasRate && pair.servedBy !== pair.key
                        ? `${t('rates.buyRate')} (${pair.servedBy})`
                        : t('rates.buyRate')
                    }
                  />
                  <Condition
                    ok={balance > 0n}
                    label={
                      <span className="ltr-content">
                        <Money value={pair.payoutBalance} decimals={pair.payoutDecimals} />{' '}
                        {pair.to}
                      </span>
                    }
                  />
                </div>

                <div className="flex items-center gap-3 sm:justify-end">
                  {ready ? (
                    <Badge tone="success">{t('machineControl.ready')}</Badge>
                  ) : pair.enabled ? (
                    <Badge tone="warning">{t('machineControl.notReady')}</Badge>
                  ) : (
                    <Badge tone="neutral">{t('common.disabled')}</Badge>
                  )}

                  {canManage && (
                    <Switch
                      checked={pair.enabled}
                      onCheckedChange={(next) => void togglePair(pair.key, next)}
                      disabled={busy === pair.key}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      {/* --- What the teller may do with it ------------------------------- */}
      {canManage && (
        <Card>
          <CardHeader
            title={t('machineControl.limits')}
            description={t('machineControl.limitsHint')}
          />
          <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Field
                label={t('machineControl.counterLimit')}
                hint={t('machineControl.zeroMeansNone')}
              >
                {(props) => <MoneyInput {...props} value={limit} onValueChange={setLimit} />}
              </Field>
              <Button
                size="sm"
                variant="secondary"
                icon={<Check />}
                loading={busy === 'limit'}
                onClick={() => void save({ 'machine.maxAmount': limit || '0' }, 'limit')}
              >
                {t('common.save')}
              </Button>
            </div>

            <div className="space-y-2">
              <Field
                label={t('machineControl.requireCustomer')}
                hint={t('machineControl.zeroMeansNone')}
              >
                {(props) => (
                  <MoneyInput {...props} value={customerAbove} onValueChange={setCustomerAbove} />
                )}
              </Field>
              <Button
                size="sm"
                variant="secondary"
                icon={<Check />}
                loading={busy === 'customer'}
                onClick={() =>
                  void save({ 'machine.requireCustomerAbove': customerAbove || '0' }, 'customer')
                }
              >
                {t('common.save')}
              </Button>
            </div>

            <div className="space-y-2">
              <Field label={t('machineControl.quickAmounts')} hint={t('machineControl.quickHint')}>
                {(props) => (
                  <Input
                    {...props}
                    value={quick}
                    onChange={(event) => setQuick(event.target.value)}
                    dir="ltr"
                  />
                )}
              </Field>
              <Button
                size="sm"
                variant="secondary"
                icon={<Check />}
                loading={busy === 'quick'}
                onClick={() => void save({ 'machine.quickAmounts': quick }, 'quick')}
              >
                {t('common.save')}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {/* --- Where the money is ------------------------------------------ */}
      <Card>
        <CardHeader
          title={t('nav.drawers')}
          description={t('machineControl.drawersHint')}
          actions={
            <Link
              href="/manage/drawers"
              className="inline-flex items-center gap-1.5 text-sm text-primary-text hover:underline"
            >
              <Vault className="size-4" />
              {t('machineControl.manageDrawers')}
            </Link>
          }
        />
        <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {drawers.map((drawer) => {
            const empty = BigInt(drawer.balance) === 0n;
            return (
              <div
                key={drawer.currency}
                className={cn(
                  'rounded-lg border p-3',
                  empty
                    ? 'border-warning bg-warning-subtle'
                    : 'border-border-base bg-surface-sunken',
                )}
              >
                <p className="font-mono text-xs text-content-secondary ltr-content">
                  {drawer.currency}
                </p>
                <p
                  className={cn(
                    'mt-1 font-mono text-lg font-semibold tabular-nums ltr-content',
                    empty ? 'text-warning-text' : 'text-content',
                  )}
                >
                  <Money value={drawer.balance} decimals={drawer.decimals} />
                </p>
              </div>
            );
          })}
        </CardBody>
      </Card>
    </div>
  );
}

/** One of the three things a pair needs, answered yes or no. */
function Condition({ ok, label }: { ok: boolean; label: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
        ok
          ? 'border-success bg-success-subtle text-success-text'
          : 'border-border-base bg-surface-sunken text-content-tertiary',
      )}
    >
      {ok ? <Check className="size-3" /> : <TriangleAlert className="size-3" />}
      {label}
    </span>
  );
}

/** Renders a 1e8-scaled string for an editable field. */
function decimal(scaled: string): string {
  const value = BigInt(scaled || '0');
  if (value === 0n) return '';
  const digits = value.toString().padStart(9, '0');
  const whole = digits.slice(0, -8);
  const fraction = digits.slice(-8).slice(0, 2).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
