'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { describeFailure } from '@/lib/failure';
import { normalizeDigits } from '@/core/money/money';
import { Alert, Button } from '@/ui/primitives';
import { useToast } from '@/ui/overlay';
import { Money } from '@/ui/display';
import { ShareButton } from '@/ui/share';

/**
 * Cash out of a customer's wallet, or cash into it.
 *
 * The teller types the figure on the customer's phone — what was transferred
 * to the office, or what is to be transferred to the customer — and the fee he
 * agreed. The notes are worked out from those two and shown large, because
 * that is the figure counted across the counter.
 */

type Op = 'CASHOUT' | 'TOPUP';

interface Currency {
  code: string;
  nameAr: string;
  nameEn: string;
  decimals: number;
}

/** Keeps only what an amount can be, to the currency's own precision. */
function clean(raw: string, places: number): string {
  const cleaned = normalizeDigits(raw)
    .replace(/[,٫٬]/g, '.')
    .replace(/[^\d.]/g, '');
  const [whole = '', ...rest] = cleaned.split('.');
  return rest.length > 0 && places > 0 ? `${whole}.${rest.join('').slice(0, places)}` : whole;
}

/** A typed amount at the 1e8 scale the server speaks. */
function scaled(value: string): bigint {
  const [whole = '0', fraction = ''] = value.trim().split('.');
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) return 0n;
  return BigInt(whole || '0') * 100_000_000n + BigInt((fraction + '00000000').slice(0, 8));
}

export function WalletOps({
  op,
  currencies,
  channels,
  permissions,
}: {
  op: Op;
  currencies: Currency[];
  channels: string[];
  permissions: string[];
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [currency, setCurrency] = useState(
    currencies.find((entry) => entry.code === 'ILS')?.code ?? currencies[0]?.code ?? 'ILS',
  );
  const [channel, setChannel] = useState(channels[0] ?? '');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('');
  const [account, setAccount] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: string; reference: string } | null>(null);

  const places = currencies.find((entry) => entry.code === currency)?.decimals ?? 2;
  const cashOut = op === 'CASHOUT';

  const moved = scaled(amount);
  const kept = scaled(fee);
  // The notes across the counter: less the fee on a cash-out, plus it on a top-up.
  const cash = cashOut ? moved - kept : moved + kept;

  const ready =
    moved > 0n &&
    kept >= 0n &&
    (!cashOut || kept < moved) &&
    Boolean(channel) &&
    name.trim().length > 0 &&
    phone.trim().length > 0 &&
    (cashOut || account.trim().length > 0);

  const record = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const result = await api.post<{ id: string; reference: string }>('/api/exchange/wallet', {
        op,
        currency,
        amount: amount.trim(),
        fee: fee.trim() || '0',
        channel,
        account: cashOut ? null : account.trim(),
        counterpartyName: name.trim(),
        counterpartyPhone: phone.trim(),
      });
      toast.success(t('walletOps.recorded'), result.reference);
      setDone(result);
      setAmount('');
      setFee('');
      setAccount('');
      setName('');
      setPhone('');
      router.refresh();
    } catch (cause) {
      const failure = describeFailure(cause, t as never);
      toast.error(failure.title, failure.body);
    } finally {
      setBusy(false);
    }
  };

  const field =
    'mt-1 h-12 w-full rounded-xl bg-surface-sunken px-3 text-base font-medium text-content outline-none ring-1 ring-transparent focus:ring-primary';

  return (
    <form
      className="mx-auto w-full max-w-xl space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void record();
      }}
    >
      <p className="text-sm text-content-secondary">
        {cashOut ? t('walletOps.cashoutHint') : t('walletOps.topupHint')}
      </p>

      {done && (
        <Alert tone="success" icon={<Check />} title={t('walletOps.recorded')}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono ltr-content">{done.reference}</span>
            {permissions.includes('exchange.receipt.print') && (
              <ShareButton transactionId={done.id} variant="secondary" />
            )}
          </div>
        </Alert>
      )}

      <section className="space-y-3 rounded-3xl bg-surface p-4 shadow-[var(--shadow-lg)] ring-1 ring-border-subtle">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-content-tertiary">{t('walletOps.currency')}</span>
            <select
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
              className={field}
            >
              {currencies.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {ln(entry, 'name')} ({entry.code})
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-content-tertiary">{t('walletOps.channel')}</span>
            <select
              value={channel}
              onChange={(event) => setChannel(event.target.value)}
              className={field}
            >
              {channels.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-content-tertiary">
              {cashOut ? t('walletOps.amountCashout') : t('walletOps.amountTopup')}
            </span>
            <input
              type="text"
              dir="ltr"
              inputMode="decimal"
              autoComplete="off"
              autoFocus
              value={amount}
              onChange={(event) => setAmount(clean(event.target.value, places))}
              className={`${field} text-end text-xl tabular-nums`}
            />
          </label>
          <label className="block">
            <span className="text-xs text-content-tertiary">{t('walletOps.fee')}</span>
            <input
              type="text"
              dir="ltr"
              inputMode="decimal"
              autoComplete="off"
              value={fee}
              placeholder="0"
              onChange={(event) => setFee(clean(event.target.value, places))}
              className={`${field} text-end text-xl tabular-nums`}
            />
          </label>
        </div>

        {/* The notes counted across the counter: the figure read aloud. */}
        <div className="flex items-center justify-between rounded-2xl bg-primary-subtle px-4 py-3">
          <span className="text-sm text-content-secondary">
            {cashOut ? t('walletOps.customerGets') : t('walletOps.customerPays')}
          </span>
          <span className="text-2xl font-bold tabular-nums text-primary-text ltr-content">
            <Money
              value={(cash > 0n ? cash : 0n).toString()}
              currency={currency}
              decimals={places}
            />
          </span>
        </div>
      </section>

      <section className="space-y-3 rounded-2xl bg-surface p-4 ring-1 ring-border-subtle">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs text-content-tertiary">{t('walletOps.name')}</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              className={field}
            />
          </label>
          <label className="block">
            <span className="text-xs text-content-tertiary">{t('walletOps.phone')}</span>
            <input
              type="tel"
              dir="ltr"
              value={phone}
              onChange={(event) => {
                // The wallet number is usually the phone; offered, never forced.
                if (!account || account === phone) setAccount(event.target.value);
                setPhone(event.target.value);
              }}
              required
              className={field}
            />
          </label>
        </div>

        {!cashOut && (
          <label className="block">
            <span className="text-xs text-content-tertiary">{t('walletOps.account')}</span>
            <input
              type="text"
              dir="ltr"
              value={account}
              onChange={(event) => setAccount(event.target.value)}
              required
              className={`${field} font-mono`}
            />
          </label>
        )}
      </section>

      <Button
        type="submit"
        size="md"
        loading={busy}
        disabled={!ready}
        className="h-14 w-full text-lg"
      >
        {t('walletOps.record')}
      </Button>
    </form>
  );
}
