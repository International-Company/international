'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Check, Power, TrendingUp, TriangleAlert, Vault } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Button, Card, CardBody, CardHeader, StatTile } from '@/ui/primitives';
import { useToast } from '@/ui/overlay';
import { Field, Input, MoneyInput, Switch } from '@/ui/form';
import { Money } from '@/ui/display';
import { cn } from '@/ui/utils';
import {
  Board,
  BoardPrice,
  buildBoard,
  type BoardCell,
  type BoardRate,
} from '../../_machine/board';

/**
 * The machine, from the manager's chair — the same board the teller works off.
 *
 * Deliberately the same object. A manager who has just switched a column on
 * should be looking at what the counter is now looking at, not at a settings
 * form whose relationship to the counter has to be imagined. The only
 * difference is what sits in a cell: the teller gets a price to press, the
 * manager gets the switch that decides whether the price is there at all.
 *
 * A cell is tradeable only when three things line up — it is switched on, a
 * rate is published, and the drawer it pays out of has money. Those live in
 * three different places in the data and used to live on three different
 * screens, so a manager could switch a pair on and believe the counter could
 * trade it. Each cell now says which of the three it is missing.
 */

interface Config {
  enabled: boolean;
  pairs: string[];
  currencies: { code: string; nameEn: string; nameAr: string; decimals: number }[];
  quickAmounts: number[];
  maxAmount: string;
  requireCustomerAbove: string;
}

interface DrawerRow {
  currency: string;
  balance: string;
  decimals: number;
}

export function MachineControlView({
  config,
  board,
  drawers,
  today,
  canManage,
  canSeeMargin,
}: {
  config: Config;
  board: BoardRate[];
  drawers: DrawerRow[];
  today: { count: number; profit: string };
  canManage: boolean;
  canSeeMargin: boolean;
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [busy, setBusy] = useState<string | null>(null);
  const [limit, setLimit] = useState(decimal(config.maxAmount));
  const [customerAbove, setCustomerAbove] = useState(decimal(config.requireCustomerAbove));
  const [quick, setQuick] = useState(config.quickAmounts.join(', '));

  const rows = useMemo(
    () =>
      buildBoard(
        config.currencies.map((currency) => currency.code),
        board,
        config.pairs,
      ),
    [config.currencies, config.pairs, board],
  );

  const names = useMemo(
    () =>
      new Map(
        config.currencies.map((currency) => [
          currency.code,
          ln(currency as unknown as Record<string, unknown>, 'name'),
        ]),
      ),
    [config.currencies, ln],
  );

  const balances = useMemo(
    () => new Map(drawers.map((drawer) => [drawer.currency, BigInt(drawer.balance)])),
    [drawers],
  );

  const updatedAt = useMemo(() => {
    const stamps = board
      .map((rate) => rate.effectiveFrom)
      .filter(Boolean)
      .sort();
    return stamps.at(-1) ?? null;
  }, [board]);

  const cells = useMemo(() => rows.flatMap((row) => [row.buy, row.sell]), [rows]);

  /** Whether the counter could actually complete this direction right now. */
  const readiness = (cell: BoardCell) => {
    if (!cell.offered) return 'off' as const;
    if (cell.rate === null) return 'noRate' as const;
    if ((balances.get(cell.to) ?? 0n) === 0n) return 'noCash' as const;
    return 'ready' as const;
  };

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
   * Turning a direction on or off.
   *
   * The setting is a comma-separated list, which is the right shape to store a
   * handful of fixed strings and a poor thing to hand a manager. The switch
   * writes the list; nobody has to type it.
   *
   * Emptying the list is refused, because an empty setting means "every pair"
   * to the server — a manager switching the last column off would silently
   * switch all six back on. Closing the counter is what the machine's own
   * switch is for, and that is what the message says.
   */
  const togglePair = async (key: string, on: boolean) => {
    const next = cells
      .map((cell) => cell.pair)
      .filter((pair) => (pair === key ? on : config.pairs.includes(pair)));

    if (next.length === 0) {
      toast.error(t('machineControl.lastPairTitle'), t('machineControl.lastPairBody'));
      return;
    }

    await save({ 'machine.pairs': next.join(',') }, key);
  };

  const blocked = cells.filter((cell) => readiness(cell) === 'noRate');
  const dry = cells.filter((cell) => readiness(cell) === 'noCash');

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
                pairs: blocked.map((cell) => cell.pair).join('، '),
              })}{' '}
              <Link href="/manage/rates" className="underline">
                {t('nav.rates')}
              </Link>
            </p>
          )}
          {dry.length > 0 && (
            <p className="mt-1">
              {t('machineControl.needsCash', {
                currencies: [...new Set(dry.map((cell) => cell.to))].join('، '),
              })}{' '}
              <Link href="/manage/drawers" className="underline">
                {t('nav.drawers')}
              </Link>
            </p>
          )}
        </Alert>
      )}

      {/* --- The board, with the switches in it --------------------------- */}
      <Board
        rows={rows}
        title={t('machine.board')}
        headings={[t('machine.currency'), t('machine.weBuy'), t('machine.weSell')]}
        names={names}
        updatedAt={updatedAt}
        liveLabel={t('machine.live')}
        footer={
          canManage && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-base px-4 py-2.5">
              <span className="text-xs text-content-tertiary">{t('machineControl.pairsHint')}</span>
              <Switch
                checked={config.enabled}
                onCheckedChange={(next) => void save({ 'machine.enabled': next }, 'enabled')}
                label={t('machineControl.state')}
                disabled={busy === 'enabled'}
              />
            </div>
          )
        }
        cell={(cell) => {
          const state = readiness(cell);

          return (
            <div className="flex size-full flex-col items-center justify-center gap-1.5 px-2 py-3">
              <BoardPrice rate={cell.rate} muted={state !== 'ready'} />

              <span
                className={cn(
                  'flex items-center gap-1.5 text-center text-[11px]',
                  state === 'ready' ? 'text-success-text' : 'text-content-tertiary',
                )}
              >
                <span
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    state === 'ready' && 'bg-success',
                    state === 'off' && 'bg-border-strong',
                    (state === 'noRate' || state === 'noCash') && 'bg-warning',
                  )}
                  aria-hidden
                />
                {state === 'ready' && t('machineControl.ready')}
                {state === 'off' && t('common.disabled')}
                {state === 'noRate' && t('machineControl.noRateShort')}
                {state === 'noCash' && t('machineControl.noCashShort', { currency: cell.to })}
              </span>

              {canManage && (
                <Switch
                  checked={cell.offered}
                  onCheckedChange={(next) => void togglePair(cell.pair, next)}
                  disabled={busy === cell.pair}
                />
              )}
            </div>
          );
        }}
      />

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
                <p className="text-xs font-medium text-content-secondary ltr-content">
                  {drawer.currency}
                </p>
                <p
                  className={cn(
                    'mt-1 text-lg font-semibold tabular-nums ltr-content',
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

/** Renders a 1e8-scaled string for an editable field. */
function decimal(scaled: string): string {
  const value = BigInt(scaled || '0');
  if (value === 0n) return '';
  const digits = value.toString().padStart(9, '0');
  const whole = digits.slice(0, -8);
  const fraction = digits.slice(-8).slice(0, 2).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
