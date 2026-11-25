'use client';

import { useEffect, useRef, useState } from 'react';
import { Banknote, Building2, HandCoins, Split, UserRound } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { useToast } from '@/ui/overlay';
import { Button } from '@/ui/primitives';
import { Input, Select } from '@/ui/form';
import { cn } from '@/ui/utils';

interface SavedPayout {
  id: string;
  channel: string;
  account: string;
  isDefault: boolean;
}

interface Options {
  destinations: string[];
  channels: string[];
  currencies: { code: string; nameAr: string; nameEn: string }[];
  suggested: string | null;
  /** The office's file the customer's phone is on, if any. */
  customer: { id: string; code: string; name: string; idNumber: string | null } | null;
  /** The accounts they were paid to before, the latest first. */
  payouts: SavedPayout[];
}

export interface Remitted {
  notice: unknown;
  transaction: { id: string; reference: string };
  draft: string;
}

/** One way the customer is paid: the money, the sum, and in notes or to an account. */
interface Leg {
  to: string;
  paid: string;
  edited: boolean;
  mode: 'cash' | 'bank';
  channel: string;
  account: string;
}

const plain = (scaled: string | number) => {
  const value = typeof scaled === 'string' ? Number(scaled) / 1e8 : scaled;
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '';
};

const label = 'mb-1 block text-[11px] font-semibold text-content-tertiary';

/**
 * A share of what was received, paid in one money: worked out at the board as
 * the figures change — unless the teller wrote their own — in notes or to one
 * of the customer's accounts, the ones used before offered first.
 */
function LegFields({
  noticeId,
  from,
  share,
  leg,
  onChange,
  options,
}: {
  noticeId: string;
  from: string;
  share: string;
  leg: Leg;
  onChange: (next: Partial<Leg>) => void;
  options: Options | null;
}) {
  const { t } = useLocale();
  const [rate, setRate] = useState<string | null>(null);
  const asked = useRef(0);
  useEffect(() => {
    const sum = Number(share);
    if (!sum || sum <= 0) {
      setRate(null);
      if (!leg.edited) onChange({ paid: '' });
      return;
    }
    const mine = ++asked.current;
    const timer = setTimeout(() => {
      api
        .post<{ toAmount: string; rate: string }>(`/api/inbox/mine/notices/${noticeId}`, {
          action: 'quote',
          amount: share,
          from,
          to: leg.to,
        })
        .then((quote) => {
          if (mine !== asked.current) return;
          setRate(from === leg.to ? null : plain(quote.rate));
          if (!leg.edited) onChange({ paid: plain(quote.toAmount) });
        })
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [share, from, leg.to, leg.edited, noticeId]);

  const currencies = options?.currencies ?? [];
  const saved = options?.payouts ?? [];
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
        <div>
          <span className={label}>
            {t('inbox.remit.paid')}
            {rate && <span className="ms-1 font-normal">· {t('inbox.remit.rate', { rate })}</span>}
          </span>
          <Input
            value={leg.paid}
            onChange={(event) => onChange({ paid: event.target.value, edited: true })}
            inputMode="decimal"
            dir="ltr"
            className="font-bold"
          />
        </div>
        <div>
          <span className={label}>&nbsp;</span>
          <Select
            value={leg.to}
            onChange={(event) => onChange({ to: event.target.value, edited: false })}
            options={currencies.map((entry) => ({ value: entry.code, label: entry.code }))}
          />
        </div>
      </div>
      {leg.edited && (
        <button
          type="button"
          onClick={() => onChange({ edited: false })}
          className="text-[11px] font-semibold text-primary-text hover:underline"
        >
          {t('inbox.remit.atBoard')}
        </button>
      )}

      <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface-sunken p-1">
        {(['bank', 'cash'] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            aria-pressed={leg.mode === entry}
            onClick={() => onChange({ mode: entry })}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-semibold',
              leg.mode === entry ? 'bg-surface text-content shadow-sm' : 'text-content-secondary',
            )}
          >
            {entry === 'bank' ? <Building2 className="size-3.5" /> : <Banknote className="size-3.5" />}
            {t(`inbox.remit.${entry}`)}
          </button>
        ))}
      </div>
      {leg.mode === 'bank' && (
        <div className="space-y-2">
          {saved.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {saved.map((entry) => {
                const chosen = entry.channel === leg.channel && entry.account === leg.account;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => onChange({ channel: entry.channel, account: entry.account })}
                    className={cn(
                      'rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1',
                      chosen
                        ? 'bg-primary text-white ring-primary'
                        : 'bg-surface-sunken text-content-secondary ring-border-subtle hover:text-content',
                    )}
                  >
                    {entry.channel} · <span className="ltr-content tabular-nums">{entry.account}</span>
                  </button>
                );
              })}
            </div>
          )}
          <Select
            value={leg.channel}
            onChange={(event) => onChange({ channel: event.target.value })}
            options={(options?.channels ?? []).map((entry) => ({ value: entry, label: entry }))}
          />
          <Input
            value={leg.account}
            onChange={(event) => onChange({ account: event.target.value })}
            placeholder={t('inbox.remit.account')}
            dir="ltr"
          />
        </div>
      )}
    </div>
  );
}

/**
 * A confirmed notice paid out as the incoming remittance it is: from the
 * correspondent, to the customer in the money they want at the board's rate —
 * or in two moneys, a share each — in notes or to their bank; a transfer to
 * make goes to the bank desk with the others. It is put on the customer's
 * file, and the accounts used are remembered for their next one. What the
 * customer is told comes back to be read over first.
 */
export function RemitForm({
  noticeId,
  network,
  amount,
  currency,
  customerName,
  onDone,
}: {
  noticeId: string;
  network: string;
  amount: string | null;
  currency: string | null;
  customerName: string | null;
  onDone: (result: Remitted) => void;
}) {
  const { t } = useLocale();
  const toast = useToast();
  const [options, setOptions] = useState<Options | null>(null);
  const [destination, setDestination] = useState('');
  const [from, setFrom] = useState((currency || 'USD').toUpperCase());
  const [credited, setCredited] = useState(amount ? plain(amount) : '');
  const [first, setFirst] = useState<Leg>({ to: 'ILS', paid: '', edited: false, mode: 'bank', channel: '', account: '' });
  const [split, setSplit] = useState(false);
  const [secondShare, setSecondShare] = useState('');
  const [second, setSecond] = useState<Leg>({ to: 'USD', paid: '', edited: false, mode: 'cash', channel: '', account: '' });
  const [recipient, setRecipient] = useState(customerName ?? '');
  const [idNumber, setIdNumber] = useState('');
  const [saving, setSaving] = useState(false);
  const paypal = network === 'PAYPAL';

  // A record that is not there is named, in the words the server gives it, so its cause can be found.
  const failure = (cause: unknown) =>
    toast.error(
      t('errors.title'),
      cause instanceof ApiError
        ? [say(t, cause.messageKey, cause.params) || cause.message, cause.messageKey === 'errors.notFound' ? cause.message : null]
            .filter(Boolean)
            .join(' — ')
        : t('errors.generic'),
    );

  useEffect(() => {
    api
      .post<Options>(`/api/inbox/mine/notices/${noticeId}`, { action: 'options' })
      .then((found) => {
        setOptions(found);
        setDestination(found.suggested ?? found.destinations[0] ?? '');
        // The account they were paid to last time, else the first the counter offers.
        const last = found.payouts.find((entry) => entry.isDefault) ?? found.payouts[0];
        setFirst((leg) => ({
          ...leg,
          channel: last?.channel ?? found.channels[0] ?? '',
          account: last?.account ?? '',
          to: found.currencies.some((entry) => entry.code === 'ILS') ? leg.to : (found.currencies[0]?.code ?? from),
        }));
        setSecond((leg) => ({ ...leg, channel: found.channels[0] ?? '' }));
        if (found.customer) {
          if (found.customer.name) setRecipient((current) => current || found.customer!.name);
          if (found.customer.idNumber) setIdNumber(found.customer.idNumber);
        }
      })
      .catch(failure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noticeId]);

  const total = Number(credited) || 0;
  const secondPart = split ? Number(secondShare) || 0 : 0;
  const firstShare = split ? String(Math.round((total - secondPart) * 100) / 100) : credited;
  const legReady = (leg: Leg) =>
    Number(leg.paid) > 0 && (leg.mode === 'cash' || (Boolean(leg.channel) && Boolean(leg.account.trim())));
  const ready =
    total > 0 &&
    legReady(first) &&
    (!split || (secondPart > 0 && secondPart < total && legReady(second))) &&
    (paypal || Boolean(destination));

  const submit = async () => {
    if (!ready || saving) return;
    setSaving(true);
    try {
      const result = await api.post<Remitted>(`/api/inbox/mine/notices/${noticeId}`, {
        action: 'remit',
        destination,
        currency: from,
        credited,
        payCurrency: first.to,
        paid: first.paid,
        payoutChannel: first.mode === 'bank' ? first.channel : null,
        payoutAccount: first.mode === 'bank' ? first.account : null,
        recipientName: recipient,
        recipientIdNumber: idNumber || null,
        second: split
          ? {
              credited: secondShare,
              payCurrency: second.to,
              paid: second.paid,
              payoutChannel: second.mode === 'bank' ? second.channel : null,
              payoutAccount: second.mode === 'bank' ? second.account : null,
            }
          : null,
      });
      toast.success(t('inbox.remit.done'), result.transaction.reference);
      onDone(result);
    } catch (cause) {
      failure(cause);
    } finally {
      setSaving(false);
    }
  };

  const currencies = options?.currencies ?? [];

  return (
    <section className="space-y-3 rounded-xl bg-surface p-3 ring-1 ring-success/40">
      <p className="flex items-center gap-1.5 text-xs font-bold text-success-text">
        <HandCoins className="size-4" />
        {t('inbox.remit.title')}
      </p>

      {/* Whose file it goes on. */}
      {options && (
        <p className="flex items-center gap-1.5 rounded-lg bg-surface-sunken px-2.5 py-1.5 text-[11px] text-content-secondary">
          <UserRound className="size-3.5 shrink-0" />
          {options.customer ? (
            <span className="truncate">
              {t('inbox.remit.customerFile')}{' '}
              <span className="font-bold text-content">{options.customer.name}</span>{' '}
              <span className="ltr-content font-mono">{options.customer.code}</span>
            </span>
          ) : (
            <span>{t('inbox.remit.customerNew')}</span>
          )}
        </p>
      )}

      {!paypal && (
        <div>
          <span className={label}>{t('inbox.remit.destination')}</span>
          <Select
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            options={(options?.destinations ?? []).map((entry) => ({ value: entry, label: entry }))}
            placeholder={options && options.destinations.length === 0 ? t('inbox.remit.noDestinations') : undefined}
          />
        </div>
      )}

      {/* Received. */}
      <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
        <div>
          <span className={label}>{t('inbox.remit.received')}</span>
          <Input value={credited} onChange={(event) => setCredited(event.target.value)} inputMode="decimal" dir="ltr" />
        </div>
        <div>
          <span className={label}>&nbsp;</span>
          <Select
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            options={currencies.map((entry) => ({ value: entry.code, label: entry.code }))}
          />
        </div>
      </div>

      {/* Paid: one money, or two. */}
      <div className={cn('space-y-2', split && 'rounded-lg p-2 ring-1 ring-border-subtle')}>
        {split && (
          <p className="text-[11px] font-bold text-content-secondary">
            {t('inbox.remit.partOne', { amount: firstShare, currency: from })}
          </p>
        )}
        <LegFields
          noticeId={noticeId}
          from={from}
          share={firstShare}
          leg={first}
          onChange={(next) => setFirst((leg) => ({ ...leg, ...next }))}
          options={options}
        />
      </div>

      {split ? (
        <div className="space-y-2 rounded-lg p-2 ring-1 ring-primary/30">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-bold text-primary-text">{t('inbox.remit.partTwo')}</p>
            <button
              type="button"
              onClick={() => {
                setSplit(false);
                setSecondShare('');
              }}
              className="text-[11px] font-semibold text-content-tertiary hover:text-danger-text"
            >
              {t('inbox.remit.splitOff')}
            </button>
          </div>
          <div>
            <span className={label}>{t('inbox.remit.partTwoShare', { currency: from })}</span>
            <Input
              value={secondShare}
              onChange={(event) => setSecondShare(event.target.value.replace(/[^\d.]/g, ''))}
              inputMode="decimal"
              dir="ltr"
            />
          </div>
          <LegFields
            noticeId={noticeId}
            from={from}
            share={secondShare}
            leg={second}
            onChange={(next) => setSecond((leg) => ({ ...leg, ...next }))}
            options={options}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setSplit(true)}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary-text hover:underline"
        >
          <Split className="size-3.5" />
          {t('inbox.remit.splitOn')}
        </button>
      )}

      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-2">
        <div>
          <span className={label}>{t('inbox.remit.recipient')}</span>
          <Input value={recipient} onChange={(event) => setRecipient(event.target.value)} />
        </div>
        <div>
          <span className={label}>{t('inbox.remit.idNumber')}</span>
          <Input value={idNumber} onChange={(event) => setIdNumber(event.target.value)} dir="ltr" />
        </div>
      </div>

      <Button className="w-full" loading={saving} disabled={!ready} onClick={() => void submit()}>
        {t('inbox.remit.create')}
        {Number(first.paid) > 0 && ` · ${first.paid} ${first.to}`}
        {split && Number(second.paid) > 0 && ` + ${second.paid} ${second.to}`}
      </Button>
      <p className="text-[11px] text-content-tertiary">
        {first.mode === 'bank' || (split && second.mode === 'bank') ? t('inbox.remit.bankHint') : t('inbox.remit.cashHint')}
      </p>
    </section>
  );
}
