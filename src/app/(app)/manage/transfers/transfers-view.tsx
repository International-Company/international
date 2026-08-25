'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeftRight, Check, Clock, RotateCcw, Search, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError, queryString } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Alert, Badge, Button, Card, CardBody, CardHeader } from '@/ui/primitives';
import { ConfirmDialog, Dialog, useToast } from '@/ui/overlay';
import { Field, Input, MoneyInput, Select, Switch } from '@/ui/form';
import { DateText, Money } from '@/ui/display';
import { cn } from '@/ui/utils';

/**
 * The transfers screen.
 *
 * ## Why what is waiting comes first
 *
 * The log is history and reads at leisure; the tray above it is work. Money
 * that left one balance and has not reached the next is the exact failure this
 * feature exists to prevent, so it is not something to go looking for — it sits
 * at the top until somebody closes it, and turns red when it has been sitting
 * too long.
 *
 * ## Why "arrived immediately" is off by default
 *
 * Because the expensive mistake is one-directional. Marking a transfer arrived
 * when it has not shows a bank balance nobody can draw on, and a customer is
 * paid out of money that is not there. Leaving one open that had in fact
 * arrived costs one click. The default is the cheap error.
 */

interface DrawerOption {
  id: string;
  nameAr: string;
  nameEn: string;
  kind: string;
  currencyCode: string;
  balance: string;
  decimals: number;
}

interface Party {
  id?: string;
  nameAr: string;
  nameEn: string;
  kind?: string;
  currencyCode: string;
}

interface TransferRow {
  id: string;
  reference: string;
  amount: string;
  commission: string;
  status: string;
  account: string | null;
  note: string | null;
  createdAt: string;
  fromDrawer: Party;
  toDrawer: Party;
  createdBy: { fullNameAr: string; fullNameEn: string };
  confirmedBy?: { fullNameAr: string; fullNameEn: string } | null;
}

interface WaitingRow extends TransferRow {
  waitingDays: number;
  standing: boolean;
}

const STATUSES = [
  'PENDING_APPROVAL',
  'PENDING_ARRIVAL',
  'COMPLETED',
  'REVERSED',
  'REJECTED',
] as const;

function statusTone(status: string): 'neutral' | 'primary' | 'success' | 'warning' | 'danger' {
  if (status === 'COMPLETED') return 'success';
  if (status === 'PENDING_ARRIVAL') return 'warning';
  if (status === 'PENDING_APPROVAL') return 'primary';
  if (status === 'REJECTED') return 'danger';
  return 'neutral';
}

export function TransfersView({
  drawers,
  initial,
  waiting,
  channels,
  rates,
  canManage,
}: {
  drawers: DrawerOption[];
  initial: TransferRow[];
  waiting: WaitingRow[];
  channels: string[];
  rates: Record<string, number>;
  canManage: boolean;
}) {
  const { t, locale } = useLocale();
  const router = useRouter();
  const toast = useToast();
  const arabic = locale === 'ar';

  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState(false);

  const fail = (cause: unknown) =>
    toast.error(
      t('errors.title'),
      cause instanceof ApiError
        ? say(t, cause.messageKey, cause.params) || cause.message
        : t('errors.generic'),
    );

  // --- Making one -----------------------------------------------------------
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    fromDrawerId: '',
    toDrawerId: '',
    amount: '',
    account: '',
    note: '',
    arrivedImmediately: false,
  });

  const source = drawers.find((drawer) => drawer.id === form.fromDrawerId);

  /*
   * Only the drawers the money could actually go to.
   *
   * Same currency, and not the one it is leaving. Offering the rest and
   * refusing them afterwards would teach the same lesson one error message at a
   * time; a list that cannot express the mistake never has to explain it.
   */
  const destinations = useMemo(
    () =>
      source
        ? drawers.filter(
            (drawer) => drawer.id !== source.id && drawer.currencyCode === source.currencyCode,
          )
        : [],
    [drawers, source],
  );

  /** What the named account keeps, shown before anything is recorded. */
  const commission = useMemo(() => {
    const percent = rates[form.account.trim()];
    if (!percent || !form.amount.trim()) return null;
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return { percent, value: (amount * percent) / 100 };
  }, [rates, form.account, form.amount]);

  const submit = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ reference: string; status: string }>(
        '/api/manage/transfers',
        {
          fromDrawerId: form.fromDrawerId,
          toDrawerId: form.toDrawerId,
          amount: form.amount.trim(),
          account: form.account.trim() || undefined,
          note: form.note.trim() || undefined,
          arrivedImmediately: form.arrivedImmediately,
        },
      );

      // Three outcomes that look alike if the message does not tell them apart:
      // done, waiting for the manager, waiting for the money.
      const message =
        result.status === 'PENDING_APPROVAL'
          ? t('transfers.sentForApproval')
          : result.status === 'PENDING_ARRIVAL'
            ? t('transfers.recordedInTransit')
            : t('transfers.recorded');

      toast.success(message, result.reference);
      setOpen(false);
      setForm({
        fromDrawerId: '',
        toDrawerId: '',
        amount: '',
        account: '',
        note: '',
        arrivedImmediately: false,
      });
      router.refresh();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  // --- Acting on one --------------------------------------------------------
  const [reversing, setReversing] = useState<TransferRow | null>(null);
  const [confirming, setConfirming] = useState<WaitingRow | null>(null);
  const [proof, setProof] = useState('');

  const act = async (id: string, body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      const result = await api.post<{ reference: string }>(`/api/manage/transfers/${id}`, body);
      toast.success(done, result.reference);
      setReversing(null);
      setConfirming(null);
      setProof('');
      router.refresh();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  // --- Filtering ------------------------------------------------------------
  const [filters, setFilters] = useState({
    status: '',
    drawerId: '',
    from: '',
    to: '',
    minAmount: '',
  });

  const search = async () => {
    setBusy(true);
    try {
      const data = await api.get<{ transfers: TransferRow[] }>(
        `/api/manage/transfers${queryString({
          status: filters.status || undefined,
          drawerId: filters.drawerId || undefined,
          from: filters.from || undefined,
          to: filters.to || undefined,
          minAmount: filters.minAmount.trim() || undefined,
        })}`,
      );
      setRows(data.transfers);
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    setFilters({ status: '', drawerId: '', from: '', to: '', minAmount: '' });
    setRows(initial);
  };

  const filtered = Object.values(filters).some(Boolean);
  const drawerLabel = (party: Party) => (arabic ? party.nameAr : party.nameEn);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button icon={<ArrowLeftRight />} onClick={() => setOpen(true)} disabled={drawers.length < 2}>
          {t('transfers.new')}
        </Button>
      </div>

      {drawers.length < 2 && (
        <Alert tone="warning">{t('transfers.needTwoDrawers')}</Alert>
      )}

      {/* --- What is still in the air ------------------------------------- */}
      {waiting.length > 0 && (
        <Card>
          <CardHeader
            title={t('transfers.waitingTitle')}
            description={t('transfers.waitingHint')}
          />
          <CardBody className="space-y-2">
            {waiting.map((row) => (
              <div
                key={row.id}
                className={cn(
                  'flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3',
                  row.standing
                    ? 'border-danger/40 bg-danger/5'
                    : 'border-border bg-surface-sunken',
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge tone={statusTone(row.status)}>
                      {t(`transfers.status.${row.status}` as never)}
                    </Badge>
                    <span className="font-mono text-xs text-content-tertiary">{row.reference}</span>
                    {row.standing && (
                      <span className="flex items-center gap-1 text-xs font-medium text-danger">
                        <Clock className="size-3" />
                        {t('transfers.standing', { days: String(Math.floor(row.waitingDays)) })}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-sm text-content">
                    {drawerLabel(row.fromDrawer)} ← {drawerLabel(row.toDrawer)}
                    {' · '}
                    <Money value={row.amount} currency={row.fromDrawer.currencyCode} />
                  </div>
                </div>

                {canManage && (
                  <div className="flex gap-2">
                    {row.status === 'PENDING_APPROVAL' && (
                      <>
                        <Button
                          size="sm"
                          icon={<Check />}
                          disabled={busy}
                          onClick={() =>
                            void act(row.id, { action: 'approve' }, t('transfers.approved'))
                          }
                        >
                          {t('transfers.approve')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<X />}
                          disabled={busy}
                          onClick={() =>
                            void act(row.id, { action: 'reject' }, t('transfers.rejected'))
                          }
                        >
                          {t('transfers.reject')}
                        </Button>
                      </>
                    )}
                    {row.status === 'PENDING_ARRIVAL' && (
                      <Button
                        size="sm"
                        icon={<Check />}
                        disabled={busy}
                        onClick={() => setConfirming(row)}
                      >
                        {t('transfers.confirmArrival')}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      {/* --- The log ------------------------------------------------------ */}
      <Card>
        <CardHeader title={t('transfers.logTitle')} />
        <CardBody className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Field label={t('transfers.filterFrom')}>
              {(props) => (
                <Input
                  {...props}
                  type="date"
                  value={filters.from}
                  onChange={(event) => setFilters({ ...filters, from: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('transfers.filterTo')}>
              {(props) => (
                <Input
                  {...props}
                  type="date"
                  value={filters.to}
                  onChange={(event) => setFilters({ ...filters, to: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('transfers.filterDrawer')}>
              {(props) => (
                <Select
                  {...props}
                  value={filters.drawerId}
                  onChange={(event) => setFilters({ ...filters, drawerId: event.target.value })}
                  placeholder={t('transfers.any')}
                  options={drawers.map((drawer) => ({
                    value: drawer.id,
                    label: arabic ? drawer.nameAr : drawer.nameEn,
                  }))}
                />
              )}
            </Field>
            <Field label={t('transfers.filterStatus')}>
              {(props) => (
                <Select
                  {...props}
                  value={filters.status}
                  onChange={(event) => setFilters({ ...filters, status: event.target.value })}
                  placeholder={t('transfers.any')}
                  options={STATUSES.map((status) => ({
                    value: status,
                    label: t(`transfers.status.${status}` as never),
                  }))}
                />
              )}
            </Field>
            <Field label={t('transfers.filterMin')}>
              {(props) => (
                <MoneyInput
                  {...props}
                  value={filters.minAmount}
                  onValueChange={(value) => setFilters({ ...filters, minAmount: value })}
                />
              )}
            </Field>
            <div className="flex items-end gap-2">
              <Button size="sm" icon={<Search />} disabled={busy} onClick={() => void search()}>
                {t('transfers.search')}
              </Button>
              {filtered && (
                <Button size="sm" variant="ghost" onClick={clear}>
                  {t('transfers.clear')}
                </Button>
              )}
            </div>
          </div>

          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-content-tertiary">
              {t('transfers.none')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-content-tertiary">
                    <th className="py-2 text-start font-medium">{t('transfers.when')}</th>
                    <th className="py-2 text-start font-medium">{t('transfers.fromLabel')}</th>
                    <th className="py-2 text-start font-medium">{t('transfers.toLabel')}</th>
                    <th className="py-2 text-end font-medium">{t('transfers.amount')}</th>
                    <th className="py-2 text-end font-medium">{t('transfers.commission')}</th>
                    <th className="py-2 text-start font-medium">{t('transfers.filterStatus')}</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b border-border/50 last:border-0">
                      <td className="py-2 align-top">
                        <DateText value={row.createdAt} withTime />
                        <div className="font-mono text-xs text-content-tertiary">
                          {row.reference}
                        </div>
                      </td>
                      <td className="py-2 align-top">{drawerLabel(row.fromDrawer)}</td>
                      <td className="py-2 align-top">
                        {drawerLabel(row.toDrawer)}
                        {row.account && (
                          <div className="text-xs text-content-tertiary">{row.account}</div>
                        )}
                      </td>
                      <td className="py-2 text-end align-top tabular-nums">
                        <Money value={row.amount} currency={row.fromDrawer.currencyCode} />
                      </td>
                      <td className="py-2 text-end align-top tabular-nums text-content-tertiary">
                        {BigInt(row.commission) > 0n ? (
                          <Money value={row.commission} currency={row.fromDrawer.currencyCode} />
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2 align-top">
                        <Badge tone={statusTone(row.status)}>
                          {t(`transfers.status.${row.status}` as never)}
                        </Badge>
                      </td>
                      <td className="py-2 text-end align-top">
                        {canManage &&
                          (row.status === 'COMPLETED' || row.status === 'PENDING_ARRIVAL') && (
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={<RotateCcw />}
                              disabled={busy}
                              onClick={() => setReversing(row)}
                            >
                              {t('transfers.reverse')}
                            </Button>
                          )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {/* --- Recording one ------------------------------------------------ */}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('transfers.new')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => void submit()}
              loading={busy}
              disabled={!form.fromDrawerId || !form.toDrawerId || !form.amount.trim()}
            >
              {t('transfers.record')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('transfers.fromLabel')} required>
            {(props) => (
              <Select
                {...props}
                value={form.fromDrawerId}
                onChange={(event) =>
                  // The destination is cleared with the source: a shekel drawer
                  // chosen under a dollar source is a refusal waiting to happen.
                  setForm({ ...form, fromDrawerId: event.target.value, toDrawerId: '' })
                }
                placeholder={t('transfers.choose')}
                options={drawers.map((drawer) => ({
                  value: drawer.id,
                  label: `${arabic ? drawer.nameAr : drawer.nameEn} — ${drawer.currencyCode}`,
                }))}
              />
            )}
          </Field>

          <Field label={t('transfers.toLabel')} required hint={source ? undefined : t('transfers.chooseSourceFirst')}>
            {(props) => (
              <Select
                {...props}
                value={form.toDrawerId}
                disabled={!source}
                onChange={(event) => setForm({ ...form, toDrawerId: event.target.value })}
                placeholder={t('transfers.choose')}
                options={destinations.map((drawer) => ({
                  value: drawer.id,
                  label: arabic ? drawer.nameAr : drawer.nameEn,
                }))}
              />
            )}
          </Field>

          <Field label={t('transfers.amount')} required>
            {(props) => (
              <MoneyInput
                {...props}
                value={form.amount}
                onValueChange={(value) => setForm({ ...form, amount: value })}
                currency={source?.currencyCode}
                decimals={source?.decimals ?? 2}
              />
            )}
          </Field>

          {channels.length > 0 && (
            <Field label={t('transfers.account')} hint={t('transfers.accountHint')}>
              {(props) => (
                <Select
                  {...props}
                  value={form.account}
                  onChange={(event) => setForm({ ...form, account: event.target.value })}
                  placeholder={t('transfers.none2')}
                  options={channels.map((name) => ({
                    value: name,
                    label: rates[name] ? `${name} — ${rates[name]}%` : name,
                  }))}
                />
              )}
            </Field>
          )}

          {commission && (
            <Alert tone="warning">
              {t('transfers.commissionNotice', {
                percent: String(commission.percent),
                value: commission.value.toFixed(2),
              })}
            </Alert>
          )}

          <Switch
            checked={form.arrivedImmediately}
            onCheckedChange={(value) => setForm({ ...form, arrivedImmediately: value })}
            label={t('transfers.arrived')}
            description={t('transfers.arrivedHint')}
          />

          <Field label={t('transfers.note')}>
            {(props) => (
              <Input
                {...props}
                value={form.note}
                onChange={(event) => setForm({ ...form, note: event.target.value })}
              />
            )}
          </Field>
        </div>
      </Dialog>

      {/* --- Saying it landed --------------------------------------------- */}
      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={t('transfers.confirmArrival')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              loading={busy}
              onClick={() =>
                confirming &&
                void act(
                  confirming.id,
                  { action: 'confirm', proof: proof.trim() || undefined },
                  t('transfers.arrivedDone'),
                )
              }
            >
              {t('transfers.confirmArrival')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Alert tone="warning">{t('transfers.confirmWarning')}</Alert>
          <Field label={t('transfers.proof')} hint={t('transfers.proofHint')}>
            {(props) => (
              <Input {...props} value={proof} onChange={(event) => setProof(event.target.value)} />
            )}
          </Field>
        </div>
      </Dialog>

      <ConfirmDialog
        open={reversing !== null}
        onClose={() => setReversing(null)}
        onConfirm={() =>
          reversing && void act(reversing.id, { action: 'reverse' }, t('transfers.reversed'))
        }
        title={t('transfers.reverse')}
        message={t('transfers.reverseConfirm', { reference: reversing?.reference ?? '' })}
        confirmLabel={t('transfers.reverse')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        loading={busy}
      />
    </div>
  );
}
