'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Check, FileText, Plus, Undo2, Wallet } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Alert, Badge, Button, Card, EmptyState, Skeleton } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Field, Input, Select, Textarea } from '@/ui/form';
import { DateText, Money } from '@/ui/display';
import { cn } from '@/ui/utils';
import { AssignmentRow, MovementList, WalletSummary, type CountRow, type Report } from './wallet-report';

interface WalletRow {
  id: string;
  name: string;
  currency: string;
  balance: string;
  isActive: boolean;
  teller: { id: string; fullNameAr: string } | null;
  waiting: number;
  waitingSum: string;
  lastCount: CountRow | null;
  pendingCount: CountRow | null;
}

interface PendingCount extends CountRow {
  drawerId: string;
  tellerId: string;
  currency: string;
}

export function EwalletsView({ tellers }: { tellers: { id: string; fullNameAr: string }[] }) {
  const { t } = useLocale();
  const toast = useToast();
  const [data, setData] = useState<{ wallets: WalletRow[]; counts: PendingCount[] } | null>(null);
  const [opening, setOpening] = useState(false);
  const [openForm, setOpenForm] = useState({ tellerId: '', label: 'جوال باي' });
  const [moving, setMoving] = useState<{ wallet: WalletRow; direction: 'IN' | 'OUT' } | null>(null);
  const [moveForm, setMoveForm] = useState({ source: 'BROKER' as 'BROKER' | 'CASH', amount: '', note: '' });
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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
      .get<{ wallets: WalletRow[]; counts: PendingCount[] }>('/api/ewallets')
      .then(setData)
      .catch((cause) => {
        setData({ wallets: [], counts: [] });
        failure(cause);
      });
  }, [failure]);

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 20_000);
    return () => clearInterval(timer);
  }, [load]);

  const run = async (key: string, work: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await work();
      if (done) toast.success(done);
      load();
      return true;
    } catch (cause) {
      failure(cause);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const showReport = (id: string) =>
    api
      .get<Report>(`/api/ewallets/${id}`)
      .then(setReport)
      .catch(failure);

  if (!data) return <Skeleton className="h-48" />;
  const nameOf = (tellerId: string) => tellers.find((teller) => teller.id === tellerId)?.fullNameAr ?? '';

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button icon={<Plus />} onClick={() => setOpening(true)}>
          {t('ewallet.open')}
        </Button>
      </div>

      {/* --- Counts waiting on the manager --- */}
      {data.counts.length > 0 && (
        <Card className="p-0">
          <h3 className="border-b border-border-subtle px-4 py-2.5 text-sm font-bold text-content">{t('ewallet.countsWaiting')}</h3>
          <ul className="divide-y divide-border-subtle">
            {data.counts.map((count) => {
              const gap = BigInt(count.difference);
              return (
                <li key={count.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  {count.screenshotId && (
                    <a href={`/api/ewallets/counts/${count.id}/photo`} target="_blank" rel="noopener noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/ewallets/counts/${count.id}/photo`}
                        alt=""
                        className="h-20 w-14 rounded-lg object-cover ring-1 ring-border-subtle"
                      />
                    </a>
                  )}
                  <div className="min-w-0 flex-1 space-y-1 text-sm">
                    <p className="font-bold text-content">
                      {nameOf(count.tellerId)} · <span className="font-mono text-xs text-content-tertiary">{count.reference}</span>
                    </p>
                    <p className="text-content-secondary">
                      {t('ewallet.expected')}: <Money value={count.expected} currency={count.currency} /> · {t('ewallet.actual')}:{' '}
                      <Money value={count.actual} currency={count.currency} />
                    </p>
                    <p
                      className={cn(
                        'font-semibold',
                        gap === 0n ? 'text-success-text' : gap > 0n ? 'text-danger-text' : 'text-warning-text',
                      )}
                    >
                      {gap === 0n
                        ? t('ewallet.matches')
                        : gap > 0n
                          ? t('ewallet.short', { amount: (Number(gap) / 1e8).toFixed(2) })
                          : t('ewallet.over', { amount: (Number(-gap) / 1e8).toFixed(2) })}
                    </p>
                    {count.note && <p className="text-xs text-content-tertiary">{count.note}</p>}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Undo2 />}
                      loading={busy === `return-${count.id}`}
                      onClick={() =>
                        void run(`return-${count.id}`, () => api.post(`/api/ewallets/counts/${count.id}`, { confirm: false }), t('ewallet.returned'))
                      }
                    >
                      {t('ewallet.return')}
                    </Button>
                    <Button
                      size="sm"
                      icon={<Check />}
                      loading={busy === `confirm-${count.id}`}
                      onClick={() =>
                        void run(`confirm-${count.id}`, () => api.post(`/api/ewallets/counts/${count.id}`, { confirm: true }), t('ewallet.confirmed'))
                      }
                    >
                      {t('ewallet.confirm')}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* --- The wallets --- */}
      {data.wallets.length === 0 ? (
        <EmptyState icon={<Wallet />} title={t('ewallet.none')} description={t('ewallet.noneHint')} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.wallets.map((wallet) => (
            <Card key={wallet.id} className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-content">{wallet.teller?.fullNameAr}</p>
                  <p className="truncate text-xs text-content-tertiary">{wallet.name}</p>
                </div>
                <span className="text-xl font-extrabold tabular-nums text-content">
                  <Money value={wallet.balance} currency={wallet.currency} />
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5 text-[11px]">
                {wallet.waiting > 0 ? (
                  <Badge tone="warning">
                    {t('ewallet.waitingCount', { count: wallet.waiting })} · <Money value={wallet.waitingSum} currency={wallet.currency} />
                  </Badge>
                ) : (
                  <Badge tone="neutral">{t('ewallet.nothingWaiting')}</Badge>
                )}
                {wallet.pendingCount ? (
                  <Badge tone="primary">{t('ewallet.countSubmitted')}</Badge>
                ) : wallet.lastCount ? (
                  <Badge tone={BigInt(wallet.lastCount.difference) === 0n ? 'success' : 'danger'}>
                    {t('ewallet.lastCount')} <DateText value={wallet.lastCount.createdAt} relative />
                  </Badge>
                ) : (
                  <Badge tone="neutral">{t('ewallet.neverCounted')}</Badge>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Button size="sm" icon={<ArrowDownToLine />} onClick={() => { setMoveForm({ source: 'BROKER', amount: '', note: '' }); setMoving({ wallet, direction: 'IN' }); }}>
                  {t('ewallet.topUp')}
                </Button>
                <Button size="sm" variant="secondary" icon={<ArrowUpFromLine />} onClick={() => { setMoveForm({ source: 'BROKER', amount: '', note: '' }); setMoving({ wallet, direction: 'OUT' }); }}>
                  {t('ewallet.withdraw')}
                </Button>
                <Button size="sm" variant="secondary" icon={<FileText />} onClick={() => void showReport(wallet.id)}>
                  {t('ewallet.report')}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* --- Opening a wallet --- */}
      <Dialog
        open={opening}
        onClose={() => setOpening(false)}
        title={t('ewallet.open')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpening(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              loading={busy === 'open'}
              disabled={!openForm.tellerId}
              onClick={() =>
                void run('open', () => api.post('/api/ewallets', openForm), t('ewallet.opened')).then((ok) => ok && setOpening(false))
              }
            >
              {t('ewallet.open')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('ewallet.teller')} required>
            {(props) => (
              <Select
                {...props}
                value={openForm.tellerId}
                onChange={(event) => setOpenForm((current) => ({ ...current, tellerId: event.target.value }))}
                options={[{ value: '', label: t('ewallet.chooseTeller') }, ...tellers.map((teller) => ({ value: teller.id, label: teller.fullNameAr }))]}
              />
            )}
          </Field>
          <Field label={t('ewallet.label')}>
            {(props) => (
              <Input {...props} value={openForm.label} onChange={(event) => setOpenForm((current) => ({ ...current, label: event.target.value }))} />
            )}
          </Field>
          <Alert tone="primary">{t('ewallet.openHint')}</Alert>
        </div>
      </Dialog>

      {/* --- Topping up, or taking back --- */}
      <Dialog
        open={moving !== null}
        onClose={() => setMoving(null)}
        title={moving ? `${moving.direction === 'IN' ? t('ewallet.topUp') : t('ewallet.withdraw')} — ${moving.wallet.teller?.fullNameAr ?? ''}` : ''}
        footer={
          <>
            <Button variant="secondary" onClick={() => setMoving(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              loading={busy === 'move'}
              disabled={!(Number(moveForm.amount) > 0)}
              onClick={() =>
                moving &&
                void run(
                  'move',
                  () =>
                    api.post(`/api/ewallets/${moving.wallet.id}`, {
                      action: 'topup',
                      source: moveForm.source,
                      direction: moving.direction,
                      amount: moveForm.amount,
                      note: moveForm.note || null,
                    }),
                  moving.direction === 'IN' ? t('ewallet.toppedUpDone') : t('ewallet.withdrawnDone'),
                ).then((ok) => ok && setMoving(null))
              }
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={moving?.direction === 'OUT' ? t('ewallet.to') : t('ewallet.from')} required>
            {(props) => (
              <Select
                {...props}
                value={moveForm.source}
                onChange={(event) => setMoveForm((current) => ({ ...current, source: event.target.value as 'BROKER' | 'CASH' }))}
                options={[
                  { value: 'BROKER', label: t('ewallet.sourceBroker') },
                  { value: 'CASH', label: t('ewallet.sourceCash') },
                ]}
              />
            )}
          </Field>
          <Field label={t('ewallet.amount')} required>
            {(props) => (
              <Input
                {...props}
                dir="ltr"
                inputMode="decimal"
                value={moveForm.amount}
                onChange={(event) => setMoveForm((current) => ({ ...current, amount: event.target.value.replace(/[^\d.]/g, '') }))}
                placeholder="0"
              />
            )}
          </Field>
          <Field label={t('ewallet.note')}>
            {(props) => (
              <Textarea {...props} rows={2} value={moveForm.note} onChange={(event) => setMoveForm((current) => ({ ...current, note: event.target.value }))} />
            )}
          </Field>
        </div>
      </Dialog>

      {/* --- A wallet's report since its last count --- */}
      <Dialog open={report !== null} onClose={() => setReport(null)} title={report ? `${t('ewallet.report')} — ${report.wallet.teller?.fullNameAr ?? ''}` : ''} size="lg">
        {report && (
          <div className="space-y-4">
            <p className="text-xs text-content-tertiary">
              {report.since ? (
                <>
                  {t('ewallet.since')} <DateText value={report.since} withTime />
                </>
              ) : (
                t('ewallet.sinceOpened')
              )}
            </p>
            <WalletSummary report={report} />
            {report.waiting.length > 0 && (
              <section>
                <h4 className="mb-1 text-xs font-semibold text-content-tertiary">{t('ewallet.waiting')}</h4>
                <ul className="divide-y divide-border-subtle rounded-xl ring-1 ring-border-subtle">
                  {report.waiting.map((row) => (
                    <AssignmentRow key={row.id} row={row} />
                  ))}
                </ul>
              </section>
            )}
            <section>
              <h4 className="mb-1 text-xs font-semibold text-content-tertiary">{t('ewallet.done')}</h4>
              {report.done.length === 0 ? (
                <p className="text-xs text-content-tertiary">{t('ewallet.noneDone')}</p>
              ) : (
                <ul className="divide-y divide-border-subtle rounded-xl ring-1 ring-border-subtle">
                  {report.done.map((row) => (
                    <AssignmentRow key={row.id} row={row} />
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h4 className="mb-1 text-xs font-semibold text-content-tertiary">{t('ewallet.movements')}</h4>
              <div className="rounded-xl ring-1 ring-border-subtle">
                <MovementList report={report} />
              </div>
            </section>
          </div>
        )}
      </Dialog>
    </div>
  );
}
