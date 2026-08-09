'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Minus, Plus, Vault } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Card, CardBody, CardHeader } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Field, Input, MoneyInput } from '@/ui/form';
import { DateText, Money } from '@/ui/display';
import { cn } from '@/ui/utils';

/**
 * What the branch holds, and how it came to hold it.
 *
 * Funding is on this screen rather than buried in a form because it is the only
 * way money enters or leaves without a customer, and because a machine that
 * refuses to trade for want of shekels is fixed here — the manager should not
 * have to learn where else to look.
 */

interface Drawer {
  id: string;
  currencyCode: string;
  nameEn: string;
  nameAr: string;
  balance: string;
  lowBalanceThreshold: string;
  kind: string;
  agrees: boolean;
  currency: { symbol: string; decimals: number; kind: string };
}

interface MovementGroup {
  key: string;
  rows: {
    id: string;
    direction: string;
    amount: string;
    balanceAfter: string;
    reason: string;
    note: string | null;
    createdAt: string;
    transaction: { id: string; reference: string; type: string } | null;
    createdBy: { fullNameEn: string; fullNameAr: string };
  }[];
}

export function DrawersView({
  drawers,
  movements,
  permissions,
}: {
  drawers: Drawer[];
  movements: MovementGroup[];
  permissions: string[];
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [funding, setFunding] = useState<{ currency: string; kind: string; direction: 'IN' | 'OUT' } | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(drawers[0] ? drawerKey(drawers[0]) : '');

  const canManage = permissions.includes('exchange.drawer.manage');

  const submit = async () => {
    if (!funding) return;
    setBusy(true);
    try {
      await api.post('/api/manage/drawers', {
        currency: funding.currency,
        kind: funding.kind,
        direction: funding.direction,
        amount: amount.trim(),
        note: note.trim() || undefined,
      });
      toast.success(t('common.saved'), `${funding.currency} — ${funding.kind}`);
      setFunding(null);
      setAmount('');
      setNote('');
      router.refresh();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError
          ? t(cause.messageKey as never, cause.params as Record<string, string>) || cause.message
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  const shown = movements.find((group) => group.key === selected);

  return (
    <div className="space-y-4">
      {/* --- The four balances ------------------------------------------- */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {drawers.map((drawer) => {
          const balance = BigInt(drawer.balance);
          const threshold = BigInt(drawer.lowBalanceThreshold);
          const low = threshold > 0n && balance < threshold;

          return (
            /*
              The card is a container, not a control. Making the whole card a
              button put the Add and Take buttons inside another button, which
              is invalid: the browser refuses to nest them and silently reparents
              them, so its DOM stops matching what the server sent. Splitting the
              selectable region out fixes the hydration failure and removes a
              nested-control trap for anyone using a keyboard or screen reader.
            */
            <div
              key={drawer.id}
              className={cn(
                'rounded-[var(--radius-card)] border bg-surface p-4 transition-colors',
                selected === drawerKey(drawer)
                  ? 'border-primary'
                  : 'border-border-base hover:border-primary',
              )}
            >
              <button
                type="button"
                onClick={() => setSelected(drawerKey(drawer))}
                aria-pressed={selected === drawerKey(drawer)}
                className="w-full text-start"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm text-content-secondary">{ln(drawer, 'name')}</span>
                  {/*
                    The kind is the distinction that matters here — two cards now
                    carry the same currency code, and only this says which of
                    them the money is actually in.
                  */}
                  <Badge tone={drawer.kind === 'BANK' ? 'primary' : 'neutral'}>
                    {drawer.currencyCode} ·{' '}
                    {drawer.kind === 'BANK' ? t('drawers.bank') : t('drawers.cash')}
                  </Badge>
                </span>

                <span className="mt-2 block font-mono text-2xl font-semibold text-content ltr-content tabular-nums">
                  <Money value={drawer.balance} decimals={drawer.currency.decimals} />
                </span>

                <span className="mt-2 flex flex-wrap gap-1">
                  {low && <Badge tone="warning">{t('drawers.low')}</Badge>}
                  {!drawer.agrees && <Badge tone="danger">{t('drawers.disagrees')}</Badge>}
                </span>
              </button>

              {canManage && (
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Plus />}
                    onClick={() => setFunding({ currency: drawer.currencyCode, kind: drawer.kind, direction: 'IN' })}
                  >
                    {t('drawers.add')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Minus />}
                    onClick={() => setFunding({ currency: drawer.currencyCode, kind: drawer.kind, direction: 'OUT' })}
                  >
                    {t('drawers.take')}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {drawers.some((drawer) => !drawer.agrees) && (
        <Alert tone="danger" icon={<AlertTriangle />} title={t('drawers.disagreesTitle')}>
          {t('drawers.disagreesBody')}
        </Alert>
      )}

      {/* --- How the selected balance came about ------------------------- */}
      <Card>
        {/* Named, not keyed: `ILS:BANK` is how the code finds it, not how a
            manager knows it. */}
        <CardHeader
          title={`${t('drawers.movements')} — ${
            (() => {
              const drawer = drawers.find((entry) => drawerKey(entry) === selected);
              return drawer ? ln(drawer, 'name') : selected;
            })()
          }`}
        />
        {shown && shown.rows.length > 0 ? (
          <ul className="divide-y divide-border-base">
            {shown.rows.map((movement) => {
              const incoming = movement.direction === 'IN';
              return (
                <li key={movement.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  {incoming ? (
                    <ArrowDownLeft className="h-4 w-4 shrink-0 text-success-text" />
                  ) : (
                    <ArrowUpRight className="h-4 w-4 shrink-0 text-danger-text" />
                  )}

                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-content">
                      {movement.transaction ? (
                        <a
                          href={`/manage/transactions/${movement.transaction.id}`}
                          className="font-mono ltr-content hover:text-primary-text"
                        >
                          {movement.transaction.reference}
                        </a>
                      ) : (
                        t(`drawers.reason.${movement.reason}` as never)
                      )}
                    </p>
                    {/* One string, not several adjacent expressions — see the
                        note in day-view about empty text children. */}
                    <p className="text-xs text-content-tertiary">
                      <DateText value={movement.createdAt} withTime />
                      <span>
                        {[ln(movement.createdBy, 'fullName'), movement.note]
                          .filter(Boolean)
                          .map((part) => ` · ${part}`)
                          .join('')}
                      </span>
                    </p>
                  </div>

                  <div className="text-end">
                    <p
                      className={cn(
                        'font-mono text-sm ltr-content',
                        incoming ? 'text-success-text' : 'text-danger-text',
                      )}
                    >
                      {incoming ? '+' : '−'}
                      <Money value={movement.amount} />
                    </p>
                    <p className="font-mono text-xs text-content-tertiary ltr-content">
                      <Money value={movement.balanceAfter} />
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <CardBody className="flex flex-col items-center gap-2 py-10 text-center">
            <Vault className="h-8 w-8 text-content-tertiary" />
            <p className="text-sm text-content-secondary">{t('drawers.noMovements')}</p>
          </CardBody>
        )}
      </Card>

      <Dialog
        open={funding !== null}
        onClose={() => setFunding(null)}
        title={
          funding?.direction === 'IN'
            ? `${t('drawers.add')} — ${funding?.currency}`
            : `${t('drawers.take')} — ${funding?.currency}`
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setFunding(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!amount.trim()}
              onClick={() => void submit()}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('common.amount')} required>
            {(props) => (
              <MoneyInput
                {...props}
                value={amount}
                onValueChange={setAmount}
                currency={funding?.currency}
              />
            )}
          </Field>
          <Field label={t('common.notes')} hint={t('drawers.noteHint')}>
            {(props) => (
              <Input {...props} value={note} onChange={(event) => setNote(event.target.value)} />
            )}
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

/**
 * A drawer's identity on this screen.
 *
 * The currency code stopped being unique the moment a currency could be held in
 * two places, so selecting a card and finding its movements both key on the
 * pair. Getting this wrong would show one drawer's history under another's
 * balance, which is the kind of mistake that gets believed.
 */
function drawerKey(drawer: { currencyCode: string; kind: string }): string {
  return `${drawer.currencyCode}:${drawer.kind}`;
}
