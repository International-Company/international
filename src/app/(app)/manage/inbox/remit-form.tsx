'use client';

import { useEffect, useRef, useState } from 'react';
import { Banknote, Building2, HandCoins } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { useToast } from '@/ui/overlay';
import { Button } from '@/ui/primitives';
import { Input, Select } from '@/ui/form';

interface Options {
  destinations: string[];
  channels: string[];
  currencies: { code: string; nameAr: string; nameEn: string }[];
  suggested: string | null;
}

export interface Remitted {
  notice: unknown;
  transaction: { id: string; reference: string };
  draft: string;
}

const plain = (scaled: string | number) => {
  const value = typeof scaled === 'string' ? Number(scaled) / 1e8 : scaled;
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '';
};

/**
 * A confirmed notice paid out as the incoming remittance it is: from the
 * correspondent, to the customer in the money they want at the board's rate,
 * in notes or to their bank — a transfer to make goes to the bank desk with
 * the others. What the customer is told comes back to be read over first.
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
  const [to, setTo] = useState('ILS');
  const [paid, setPaid] = useState('');
  const [rate, setRate] = useState<string | null>(null);
  const [edited, setEdited] = useState(false);
  const [mode, setMode] = useState<'cash' | 'bank'>('bank');
  const [channel, setChannel] = useState('');
  const [account, setAccount] = useState('');
  const [recipient, setRecipient] = useState(customerName ?? '');
  const [saving, setSaving] = useState(false);
  const paypal = network === 'PAYPAL';

  const failure = (cause: unknown) =>
    toast.error(
      t('errors.title'),
      cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'),
    );

  useEffect(() => {
    api
      .post<Options>(`/api/inbox/mine/notices/${noticeId}`, { action: 'options' })
      .then((found) => {
        setOptions(found);
        setDestination(found.suggested ?? found.destinations[0] ?? '');
        setChannel(found.channels[0] ?? '');
        if (!found.currencies.some((entry) => entry.code === 'ILS')) setTo(found.currencies[0]?.code ?? from);
      })
      .catch(failure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noticeId]);

  // What it comes to at the board, worked out again as the figures change — unless the teller wrote their own.
  const asked = useRef(0);
  useEffect(() => {
    const sum = Number(credited);
    if (!sum || sum <= 0) {
      setRate(null);
      if (!edited) setPaid('');
      return;
    }
    const mine = ++asked.current;
    const timer = setTimeout(() => {
      api
        .post<{ toAmount: string; rate: string }>(`/api/inbox/mine/notices/${noticeId}`, {
          action: 'quote',
          amount: credited,
          from,
          to,
        })
        .then((quote) => {
          if (mine !== asked.current) return;
          setRate(from === to ? null : plain(quote.rate));
          if (!edited) setPaid(plain(quote.toAmount));
        })
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [credited, from, to, edited, noticeId]);

  const ready =
    Number(credited) > 0 &&
    Number(paid) > 0 &&
    (paypal || Boolean(destination)) &&
    (mode === 'cash' || (Boolean(channel) && Boolean(account.trim())));

  const submit = async () => {
    if (!ready || saving) return;
    setSaving(true);
    try {
      const result = await api.post<Remitted>(`/api/inbox/mine/notices/${noticeId}`, {
        action: 'remit',
        destination,
        currency: from,
        credited,
        payCurrency: to,
        paid,
        payoutChannel: mode === 'bank' ? channel : null,
        payoutAccount: mode === 'bank' ? account : null,
        recipientName: recipient,
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
  const label = 'mb-1 block text-[11px] font-semibold text-content-tertiary';

  return (
    <section className="space-y-3 rounded-xl bg-surface p-3 ring-1 ring-success/40">
      <p className="flex items-center gap-1.5 text-xs font-bold text-success-text">
        <HandCoins className="size-4" />
        {t('inbox.remit.title')}
      </p>

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

      {/* Received, and what it comes to in the money paid out. */}
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
      <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
        <div>
          <span className={label}>
            {t('inbox.remit.paid')}
            {rate && <span className="ms-1 font-normal">· {t('inbox.remit.rate', { rate })}</span>}
          </span>
          <Input
            value={paid}
            onChange={(event) => {
              setPaid(event.target.value);
              setEdited(true);
            }}
            inputMode="decimal"
            dir="ltr"
            className="font-bold"
          />
        </div>
        <div>
          <span className={label}>&nbsp;</span>
          <Select
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              setEdited(false);
            }}
            options={currencies.map((entry) => ({ value: entry.code, label: entry.code }))}
          />
        </div>
      </div>
      {edited && (
        <button type="button" onClick={() => setEdited(false)} className="text-[11px] font-semibold text-primary-text hover:underline">
          {t('inbox.remit.atBoard')}
        </button>
      )}

      {/* How the customer gets it. */}
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface-sunken p-1">
        {(['bank', 'cash'] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            aria-pressed={mode === entry}
            onClick={() => setMode(entry)}
            className={`inline-flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-semibold ${
              mode === entry ? 'bg-surface text-content shadow-sm' : 'text-content-secondary'
            }`}
          >
            {entry === 'bank' ? <Building2 className="size-3.5" /> : <Banknote className="size-3.5" />}
            {t(`inbox.remit.${entry}`)}
          </button>
        ))}
      </div>
      {mode === 'bank' && (
        <div className="space-y-2">
          <Select
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            options={(options?.channels ?? []).map((entry) => ({ value: entry, label: entry }))}
          />
          <Input
            value={account}
            onChange={(event) => setAccount(event.target.value)}
            placeholder={t('inbox.remit.account')}
            dir="ltr"
          />
        </div>
      )}
      <div>
        <span className={label}>{t('inbox.remit.recipient')}</span>
        <Input value={recipient} onChange={(event) => setRecipient(event.target.value)} />
      </div>

      <Button className="w-full" loading={saving} disabled={!ready} onClick={() => void submit()}>
        {t('inbox.remit.create')}
        {Number(paid) > 0 && ` · ${paid} ${to}`}
      </Button>
      <p className="text-[11px] text-content-tertiary">
        {mode === 'bank' ? t('inbox.remit.bankHint') : t('inbox.remit.cashHint')}
      </p>
    </section>
  );
}
