'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Minus,
  Pencil,
  Plus,
  Trash2,
  Vault,
} from 'lucide-react';
import { FUNDING_CATEGORIES, type FundingCategory } from '@/modules/drawers/funding-categories';
import { useLocale } from '@/i18n/provider';
import { api, ApiError, queryString } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Alert, Badge, Button, Card, CardBody, CardHeader } from '@/ui/primitives';
import { ConfirmDialog, Dialog, useToast } from '@/ui/overlay';
import { Field, Input, MoneyInput, Select, Switch } from '@/ui/form';
import { DateText, Money } from '@/ui/display';
import { cn } from '@/ui/utils';
import { AccessButton } from './access-dialog';

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
  allowNegative: boolean;
  isActive: boolean;
  kind: string;
  tellerId: string | null;
  teller: { fullNameEn: string; fullNameAr: string } | null;
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

/** A currency and kind that has no drawer yet, and so can be opened. */
interface Openable {
  currency: string;
  kind: string;
  nameEn: string;
  nameAr: string;
}

export function DrawersView({
  drawers,
  openable,
  movements,
  permissions,
}: {
  drawers: Drawer[];
  openable: Openable[];
  movements: MovementGroup[];
  permissions: string[];
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [funding, setFunding] = useState<{ currency: string; kind: string; direction: 'IN' | 'OUT' } | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [category, setCategory] = useState<FundingCategory>('OWNER_IN');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(drawers[0] ? drawerKey(drawers[0]) : '');

  /*
   * Editing covers what a drawer *is* — its name, when to warn, whether it is
   * open — and never what it holds. A balance is the sum of the movements
   * beneath it; a field that set it directly would leave the drawer disagreeing
   * with its own history, and the one number that says how much money exists
   * would become an opinion. Money moves through Add and Take, which record why.
   */
  const [editing, setEditing] = useState<Drawer | null>(null);
  const [form, setForm] = useState({
    nameEn: '',
    nameAr: '',
    lowBalanceThreshold: '',
    allowNegative: false,
    isActive: true,
  });

  const openEditor = (drawer: Drawer) => {
    setEditing(drawer);
    setForm({
      nameEn: drawer.nameEn,
      nameAr: drawer.nameAr,
      lowBalanceThreshold: decimalOf(drawer.lowBalanceThreshold),
      allowNegative: drawer.allowNegative,
      isActive: drawer.isActive,
    });
  };

  const saveEdit = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await api.patch('/api/manage/drawers', {
        currency: editing.currencyCode,
        kind: editing.kind,
        nameEn: form.nameEn.trim(),
        nameAr: form.nameAr.trim(),
        lowBalanceThreshold: form.lowBalanceThreshold.trim() || '0',
        allowNegative: form.allowNegative,
        isActive: form.isActive,
      });
      toast.success(t('common.saved'), ln(editing, 'name'));
      setEditing(null);
      router.refresh();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError
          ? say(t, cause.messageKey, cause.params) || cause.message
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  // --- Opening a new one ----------------------------------------------------
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState(0);
  const [newNames, setNewNames] = useState({ nameEn: '', nameAr: '' });

  const chosen = openable[pick];

  const openAdd = () => {
    setPick(0);
    const first = openable[0];
    setNewNames(
      first
        ? nameFor(first)
        : { nameEn: '', nameAr: '' },
    );
    setAdding(true);
  };

  const createDrawer = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      await api.put('/api/manage/drawers', {
        currency: chosen.currency,
        kind: chosen.kind,
        nameEn: newNames.nameEn.trim(),
        nameAr: newNames.nameAr.trim(),
      });
      toast.success(t('common.saved'), `${chosen.currency} — ${chosen.kind}`);
      setAdding(false);
      router.refresh();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError
          ? say(t, cause.messageKey, cause.params) || cause.message
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  // --- Removing one that was never used -------------------------------------
  const [removing, setRemoving] = useState<Drawer | null>(null);

  const removeDrawer = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.delete(
        `/api/manage/drawers${queryString({ currency: removing.currencyCode, kind: removing.kind })}`,
      );
      toast.success(t('common.saved'), ln(removing, 'name'));
      setRemoving(null);
      router.refresh();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError
          ? say(t, cause.messageKey, cause.params) || cause.message
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

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
        category,
        note: note.trim() || undefined,
      });
      toast.success(t('common.saved'), `${funding.currency} — ${funding.kind}`);
      setFunding(null);
      setAmount('');
      setNote('');
      setCategory('OWNER_IN');
      router.refresh();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError
          ? say(t, cause.messageKey, cause.params) || cause.message
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  const shown = movements.find((group) => group.key === selected);

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex flex-wrap justify-end gap-2">
          {/*
            Beside the button that opens a drawer, because they are the two
            halves of the same decision: what the branch keeps money in, and who
            is allowed near it.
          */}
          <AccessButton />
          {openable.length > 0 && (
            <Button variant="secondary" icon={<Plus />} onClick={openAdd}>
              {t('drawers.open')}
            </Button>
          )}
        </div>
      )}

      {/* --- The balances ------------------------------------------------- */}
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
                    The kind is the distinction that matters here — several cards
                    now carry the same currency code, and only this says which of
                    them the money is actually in. The holder is named beside it
                    for the same reason: once tellers hold drawers of their own,
                    "the shekel drawer" stops identifying anything.
                  */}
                  <span className="flex flex-wrap items-center justify-end gap-1.5">
                    <Badge tone={drawer.tellerId ? 'warning' : 'neutral'}>
                      {drawer.teller ? ln(drawer.teller, 'fullName') : t('drawers.treasury')}
                    </Badge>
                    <Badge tone={drawer.kind === 'CASH' ? 'neutral' : 'primary'}>
                      {drawer.currencyCode} · {t(kindLabel(drawer.kind))}
                    </Badge>
                  </span>
                </span>

                <span className="mt-2 block font-mono text-2xl font-semibold text-content ltr-content tabular-nums">
                  <Money value={drawer.balance} decimals={drawer.currency.decimals} />
                </span>

                <span className="mt-2 flex flex-wrap gap-1">
                  {low && <Badge tone="warning">{t('drawers.low')}</Badge>}
                  {!drawer.agrees && <Badge tone="danger">{t('drawers.disagrees')}</Badge>}
                  {!drawer.isActive && <Badge tone="neutral">{t('common.inactive')}</Badge>}
                  {drawer.allowNegative && <Badge tone="neutral">{t('drawers.mayGoShort')}</Badge>}
                </span>
              </button>

              {canManage && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Plus />}
                    onClick={() =>
                      setFunding({
                        currency: drawer.currencyCode,
                        kind: drawer.kind,
                        direction: 'IN',
                      })
                    }
                  >
                    {t('drawers.add')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Minus />}
                    onClick={() =>
                      setFunding({
                        currency: drawer.currencyCode,
                        kind: drawer.kind,
                        direction: 'OUT',
                      })
                    }
                  >
                    {t('drawers.take')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Pencil />}
                    onClick={() => openEditor(drawer)}
                  >
                    {t('common.edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 />}
                    onClick={() => setRemoving(drawer)}
                  >
                    {t('common.delete')}
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
          {/*
            Why the money moved, with no default chosen for the manager.
            The day's result is the change in what the branch is worth with the
            owner's own money taken back out of it — so an owner's withdrawal
            recorded as anything else is reported as a loss, and an expense
            recorded as a withdrawal quietly disappears from the costs.
          */}
          <Field label={t('ledger.fundingCategory')} hint={t('ledger.fundingCategoryHint')} required>
            {(props) => (
              <Select
                {...props}
                value={category}
                onChange={(event) => setCategory(event.target.value as FundingCategory)}
                options={FUNDING_CATEGORIES.map((value) => ({
                  value,
                  label: t(`ledger.category.${value}` as never),
                }))}
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

      {/* --- Editing what a drawer is, never what it holds ---------------- */}
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={`${t('common.edit')} — ${editing ? ln(editing, 'name') : ''}`}
        description={t('drawers.editHint')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void saveEdit()}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('common.name')} required>
            {(props) => (
              <Input
                {...props}
                value={form.nameAr}
                onChange={(event) => setForm({ ...form, nameAr: event.target.value })}
              />
            )}
          </Field>

          <Field label={`${t('common.name')} (EN)`} required>
            {(props) => (
              <Input
                {...props}
                dir="ltr"
                value={form.nameEn}
                onChange={(event) => setForm({ ...form, nameEn: event.target.value })}
              />
            )}
          </Field>

          <Field label={t('drawers.lowThreshold')} hint={t('drawers.lowThresholdHint')}>
            {(props) => (
              <MoneyInput
                {...props}
                value={form.lowBalanceThreshold}
                onValueChange={(value) => setForm({ ...form, lowBalanceThreshold: value })}
                decimals={editing?.currency.decimals ?? 2}
              />
            )}
          </Field>

          <Switch
            checked={form.allowNegative}
            onCheckedChange={(next) => setForm({ ...form, allowNegative: next })}
            label={t('drawers.allowNegative')}
            description={t('drawers.allowNegativeHint')}
          />

          <Switch
            checked={form.isActive}
            onCheckedChange={(next) => setForm({ ...form, isActive: next })}
            label={t('common.active')}
            description={t('drawers.activeHint')}
          />
        </div>
      </Dialog>

      {/* --- Opening a drawer for a pair that has none -------------------- */}
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title={t('drawers.open')}
        description={t('drawers.openHint')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!chosen}
              onClick={() => void createDrawer()}
            >
              {t('common.create')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('common.currency')} required>
            {(props) => (
              <Select
                {...props}
                value={String(pick)}
                onChange={(event) => {
                  const index = Number(event.target.value);
                  setPick(index);
                  const target = openable[index];
                  if (target) setNewNames(nameFor(target));
                }}
                options={openable.map((target, index) => ({
                  value: String(index),
                  label: `${target.currency} — ${t(kindLabel(target.kind))}`,
                }))}
              />
            )}
          </Field>

          <Field label={t('common.name')} required>
            {(props) => (
              <Input
                {...props}
                value={newNames.nameAr}
                onChange={(event) => setNewNames({ ...newNames, nameAr: event.target.value })}
              />
            )}
          </Field>

          <Field label={`${t('common.name')} (EN)`} required>
            {(props) => (
              <Input
                {...props}
                dir="ltr"
                value={newNames.nameEn}
                onChange={(event) => setNewNames({ ...newNames, nameEn: event.target.value })}
              />
            )}
          </Field>
        </div>
      </Dialog>

      {/* --- Removing one that was never used ----------------------------- */}
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => void removeDrawer()}
        title={`${t('common.delete')} — ${removing ? ln(removing, 'name') : ''}`}
        message={t('drawers.deleteHint')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        loading={busy}
      />
    </div>
  );
}

/** A sensible starting name, so the manager usually just presses Save. */
function nameFor(target: Openable): { nameEn: string; nameAr: string } {
  if (target.kind === 'BROKER') {
    return { nameEn: `${target.nameEn} — broker`, nameAr: `الوسيط — ${target.nameAr}` };
  }
  if (target.kind === 'CORRESPONDENT') {
    return { nameEn: `${target.nameEn} — correspondent`, nameAr: `المراسل — ${target.nameAr}` };
  }
  return { nameEn: `${target.nameEn} drawer`, nameAr: `صندوق ${target.nameAr}` };
}

/**
 * What to call a kind.
 *
 * Three now, not two. The earlier version asked whether the kind was the broker
 * and called everything else cash, which quietly relabelled the correspondent's
 * balance as a till the moment that kind existed — and a liability displayed as
 * money on hand is exactly the error this screen exists to prevent.
 */
function kindLabel(kind: string): 'drawers.broker' | 'drawers.correspondent' | 'drawers.cash' {
  if (kind === 'BROKER') return 'drawers.broker';
  if (kind === 'CORRESPONDENT') return 'drawers.correspondent';
  return 'drawers.cash';
}

/** A 1e8-scaled string as something an editable field can hold. */
function decimalOf(scaled: string): string {
  const value = BigInt(scaled || '0');
  if (value === 0n) return '';
  const digits = value.toString().padStart(9, '0');
  const whole = digits.slice(0, -8);
  const fraction = digits.slice(-8).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
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
