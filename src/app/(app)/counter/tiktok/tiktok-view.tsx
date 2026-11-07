'use client';

import { useCallback, useEffect, useState } from 'react';
import { Camera, Check, ImagePlus, Loader2, Trash2, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { normalizeDigits, parseMoney } from '@/core/money/money';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { ConfirmDialog, useToast } from '@/ui/overlay';
import { Field, Input } from '@/ui/form';
import { shrinkPhoto } from '@/ui/proof-photo';
import { tiktokPayout } from '@/modules/tiktok/tiktok-message';
import { formatFigure } from '@/modules/whatsapp/report-command';

/**
 * Writing down a TikTok withdrawal: a photo, then where it goes and to whom, the
 * dollars withdrawn and the price they are handed over at in shekels. Nothing here
 * touches a balance; the bot carries it to the group.
 */

interface Row {
  id: string;
  currency: string;
  amountText: string;
  rateText: string | null;
  egpText: string | null;
  payoutText: string | null;
  account: string;
  beneficiaryName: string;
  channel: string;
  createdAt: string;
  createdBy: { fullNameAr: string; fullNameEn: string };
}

/** Keeps only what a decimal can be. */
const decimal = (raw: string) =>
  normalizeDigits(raw)
    .replace(/[,٫٬]/g, '.')
    .replace(/[^\d.]/g, '')
    .replace(/(\..*)\./g, '$1');

/** A typed decimal as the scaled integer, or nothing while it is still being typed. */
function scaled(text: string): bigint {
  try {
    return parseMoney(text);
  } catch {
    return 0n;
  }
}

export function TiktokView({
  channels,
  defaultRate,
  permissions,
}: {
  channels: string[];
  defaultRate: string;
  permissions: string[];
}) {
  const { t, ln, locale } = useLocale();
  const toast = useToast();

  const [photo, setPhoto] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [account, setAccount] = useState('');
  const [beneficiaryName, setBeneficiaryName] = useState('');
  const [channel, setChannel] = useState(channels[0] ?? '');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState(defaultRate);
  // The pounds the photo shows, for the group's reconciliation.
  const [egp, setEgp] = useState('');
  const [posting, setPosting] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [deleting, setDeleting] = useState<Row | null>(null);

  const canDelete = permissions.includes('exchange.transaction.reverse');

  const load = useCallback(async () => {
    try {
      setRows(await api.get<Row[]>('/api/tiktok'));
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const failure = (cause: unknown) =>
    toast.error(
      t('errors.title'),
      cause instanceof ApiError
        ? say(t, cause.messageKey, cause.params) || cause.message
        : t('errors.generic'),
    );

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    try {
      setPhoto(await shrinkPhoto(file));
    } catch {
      toast.error(t('errors.title'), t('errors.proofImageInvalid'));
    } finally {
      setReading(false);
    }
  };

  const payout = tiktokPayout(scaled(amount), scaled(rate));
  const ready =
    Boolean(photo) &&
    account.trim().length > 0 &&
    beneficiaryName.trim().length > 0 &&
    Boolean(channel) &&
    payout > 0n;

  const submit = async () => {
    if (!ready || posting) return;
    setPosting(true);
    try {
      await api.post('/api/tiktok', {
        amount,
        rate,
        account,
        beneficiaryName,
        channel,
        photo,
        egpAmount: egp.trim() || null,
      });
      toast.success(t('tiktok.recorded'));
      setPhoto(null);
      setAccount('');
      setBeneficiaryName('');
      setAmount('');
      setEgp('');
      void load();
    } catch (cause) {
      failure(cause);
    } finally {
      setPosting(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const { id } = deleting;
    setDeleting(null);
    try {
      await api.delete(`/api/tiktok/${id}`);
      toast.success(t('tiktok.deleted'));
      void load();
    } catch (cause) {
      failure(cause);
    }
  };

  return (
    <div className="mx-auto w-full max-w-xl space-y-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        {/* ============ The photo ============ */}
        <div className="rounded-2xl bg-surface p-4 ring-1 ring-border-subtle">
          {photo ? (
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`data:image/jpeg;base64,${photo}`}
                alt={t('tiktok.photo')}
                className="max-h-96 w-full rounded-xl bg-surface-sunken object-contain"
              />
              <button
                type="button"
                onClick={() => setPhoto(null)}
                aria-label={t('common.delete')}
                className="absolute end-2 top-2 flex size-10 items-center justify-center rounded-full bg-surface text-content shadow-[var(--shadow-md)]"
              >
                <X className="size-5" />
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: t('tiktok.takePhoto'), Icon: Camera, capture: true },
                { label: t('tiktok.attachPhoto'), Icon: ImagePlus, capture: false },
              ].map(({ label, Icon, capture }) => (
                <label
                  key={label}
                  className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-base text-sm font-medium text-content-secondary transition-colors hover:border-primary hover:text-primary-text"
                >
                  {reading ? <Loader2 className="size-6 animate-spin" /> : <Icon className="size-6" />}
                  {label}
                  <input
                    type="file"
                    accept="image/*"
                    capture={capture ? 'environment' : undefined}
                    className="sr-only"
                    onChange={(event) => {
                      void pick(event.target.files?.[0]);
                      event.target.value = '';
                    }}
                  />
                </label>
              ))}
            </div>
          )}
        </div>

        {/* ============ Who it is for, how it is sent, and how much ============ */}
        <div className="space-y-3 rounded-2xl bg-surface p-4 ring-1 ring-border-subtle">
          <Field label={t('tiktok.account')} required>
            {(props) => (
              <Input
                {...props}
                dir="ltr"
                inputMode="tel"
                maxLength={60}
                autoComplete="off"
                value={account}
                onChange={(event) => setAccount(event.target.value)}
              />
            )}
          </Field>

          <Field label={t('tiktok.channel')} required>
            {(props) =>
              channels.length === 0 ? (
                <p className="rounded-xl bg-warning-subtle px-3 py-2 text-sm text-content-secondary">
                  {t('tiktok.noChannels')}
                </p>
              ) : (
                <select
                  {...props}
                  value={channel}
                  onChange={(event) => setChannel(event.target.value)}
                  className="h-11 w-full rounded-xl bg-surface-sunken px-3 text-base font-medium text-content outline-none ring-1 ring-transparent focus:ring-primary"
                >
                  {channels.map((entry) => (
                    <option key={entry} value={entry}>
                      {entry}
                    </option>
                  ))}
                </select>
              )
            }
          </Field>

          <Field label={t('tiktok.beneficiaryName')} required>
            {(props) => (
              <Input
                {...props}
                maxLength={200}
                autoComplete="off"
                value={beneficiaryName}
                onChange={(event) => setBeneficiaryName(event.target.value)}
              />
            )}
          </Field>

          <Field label={t('tiktok.egp')} hint={t('tiktok.egpHint')}>
            {(props) => (
              <Input
                {...props}
                dir="ltr"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                value={egp}
                onChange={(event) => setEgp(decimal(event.target.value))}
              />
            )}
          </Field>

        </div>

        {/* ============ The dollars, the price, the shekels ============ */}
        <section className="space-y-2 rounded-3xl bg-surface p-2 shadow-[var(--shadow-lg)] ring-1 ring-border-subtle">
          <div className="rounded-[1.35rem] bg-surface-sunken px-5 py-5">
            <span className="text-xs font-medium text-content-secondary">{t('tiktok.amount')}</span>
            <div className="mt-3 flex items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">
                $
              </span>
              <input
                type="text"
                dir="ltr"
                inputMode="decimal"
                autoComplete="off"
                data-zoom-safe=""
                aria-label={t('tiktok.amount')}
                value={amount}
                placeholder="0.00"
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setAmount(decimal(event.target.value))}
                className="min-w-0 flex-1 bg-transparent text-end text-3xl font-bold tabular-nums tracking-tight text-content outline-none placeholder:text-content-tertiary sm:text-4xl"
              />
            </div>
          </div>

          <div className="rounded-[1.35rem] bg-surface-sunken px-5 py-4">
            <span className="text-xs font-medium text-content-secondary">{t('tiktok.rate')}</span>
            <div className="mt-2 flex items-center gap-3">
              <span className="flex h-10 shrink-0 items-center rounded-full bg-surface px-4 text-sm font-semibold text-content shadow-[var(--shadow-sm)] ring-1 ring-border-subtle">
                ILS
              </span>
              <input
                type="text"
                dir="ltr"
                inputMode="decimal"
                autoComplete="off"
                data-zoom-safe=""
                aria-label={t('tiktok.rate')}
                value={rate}
                placeholder="0.0000"
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setRate(decimal(event.target.value))}
                className="min-w-0 flex-1 bg-transparent text-end text-2xl font-semibold tabular-nums text-content outline-none placeholder:text-content-tertiary"
              />
            </div>
          </div>

          <div className="rounded-[1.35rem] bg-primary-subtle px-5 py-6">
            <span className="text-xs font-medium text-content-secondary">{t('tiktok.payout')}</span>
            <p className="mt-3 text-end text-4xl font-bold tabular-nums tracking-tight text-primary-text ltr-content sm:text-5xl">
              {formatFigure(payout)} <span className="text-lg font-semibold">ILS</span>
            </p>
          </div>
        </section>

        <button
          type="submit"
          disabled={!ready || posting}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary text-base font-semibold text-white shadow-[var(--shadow-md)] transition-all duration-150 hover:bg-primary-hover active:scale-[0.98] disabled:opacity-40 disabled:shadow-none disabled:active:scale-100"
        >
          {posting ? <Loader2 className="size-5 animate-spin" /> : <Check className="size-5" />}
          {t('tiktok.record')}
        </button>
      </form>

      {/* ============ The latest ============ */}
      {rows.length > 0 && (
        <div className="rounded-2xl bg-surface ring-1 ring-border-subtle">
          <p className="px-4 pt-3 text-xs font-medium text-content-tertiary">
            {t('machine.recent')}
          </p>
          <ul className="divide-y divide-border-subtle">
            {rows.map((row) => (
              <li key={row.id} className="flex items-start gap-3 px-4 py-3">
                <a
                  href={`/api/tiktok/${row.id}/photo`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/tiktok/${row.id}/photo`}
                    alt={t('tiktok.photo')}
                    loading="lazy"
                    className="size-16 rounded-lg object-cover ring-1 ring-border-subtle"
                  />
                </a>
                <div className="min-w-0 flex-1">
                  <p className="ltr-content text-start text-sm font-semibold tabular-nums text-content">
                    {row.amountText} {row.currency}
                    {row.payoutText && ` × ${row.rateText} = ${row.payoutText} ILS`}
                    {row.egpText && ` · ${row.egpText} EGP`}
                  </p>
                  <p className="truncate text-sm text-content-secondary">
                    {[row.account, row.channel, row.beneficiaryName].filter(Boolean).join(' · ')}
                  </p>
                  <p className="mt-1 text-xs text-content-tertiary">
                    {ln(row.createdBy, 'fullName')} ·{' '}
                    {new Date(row.createdAt).toLocaleString(locale, {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </p>
                </div>
                {canDelete && (
                  <button
                    type="button"
                    onClick={() => setDeleting(row)}
                    aria-label={t('common.delete')}
                    className="flex size-10 shrink-0 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-danger-text"
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
        title={t('tiktok.deleteTitle')}
        message={t('tiktok.deleteBody')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
      />
    </div>
  );
}
