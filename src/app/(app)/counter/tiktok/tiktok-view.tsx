'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Check, ImagePlus, Loader2, Paperclip, Printer, Trash2, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { normalizeDigits, parseMoney } from '@/core/money/money';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { ConfirmDialog, useToast } from '@/ui/overlay';
import { Field, Input } from '@/ui/form';
import { shrinkPhoto } from '@/ui/proof-photo';
import { AutoPrintToggle, printAfterRecording } from '@/ui/auto-print';
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
  /** Photos beyond the first. */
  photos?: { id: string }[];
}

/** Photos a withdrawal may carry beyond its first; the server holds to the same. */
const MAX_EXTRA = 4;

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
  /** How it is handed over: by transfer, in notes, or part of each. */
  const [payVia, setPayVia] = useState<'TRANSFER' | 'CASH' | 'SPLIT'>('TRANSFER');
  /** Split: the part sent by transfer, in shekels. */
  const [transferPart, setTransferPart] = useState('');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState(defaultRate);
  // The pounds the photo shows, for the group's reconciliation.
  const [egp, setEgp] = useState('');
  // Reading the figures off the photo, and how it went. Null: nothing to say.
  const [scan, setScan] = useState<'READING' | 'READ' | 'FAILED' | null>(null);
  const scanId = useRef(0);
  const [posting, setPosting] = useState(false);
  /** Further photos — the transfer's receipt, say — shrunk and waiting to go with it. */
  const [extras, setExtras] = useState<string[]>([]);
  const [attaching, setAttaching] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [deleting, setDeleting] = useState<Row | null>(null);
  /** Whom withdrawals are sent to, as set on the WhatsApp panel; and whom this one goes to. */
  const [recipients, setRecipients] = useState<string[]>([]);
  const [recipient, setRecipient] = useState('');
  useEffect(() => {
    api
      .get<string[]>('/api/tiktok/recipients')
      .then((names) => {
        setRecipients(names);
        // One alone is chosen already; with several, the teller chooses.
        if (names.length === 1) setRecipient(names[0]!);
      })
      .catch(() => setRecipients([]));
  }, []);

  const canDelete = permissions.includes('exchange.transaction.reverse');
  const canPrint = permissions.includes('exchange.receipt.print');
  const print = (id: string) => window.open(`/print/tiktok/${id}`, '_blank');

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

  /** Fills in what the photo shows. A later photo, or none, makes this one's answer stale. */
  const readFigures = async (shrunk: string) => {
    const id = ++scanId.current;
    setScan('READING');
    try {
      const found = await api.post<{
        available: boolean;
        usd: string | null;
        egp: string | null;
      }>('/api/tiktok/read-photo', { photo: shrunk });
      if (id !== scanId.current) return;
      if (found.usd) setAmount(decimal(found.usd));
      if (found.egp) setEgp(decimal(found.egp));
      setScan(!found.available ? null : found.usd && found.egp ? 'READ' : 'FAILED');
    } catch {
      if (id === scanId.current) setScan('FAILED');
    }
  };

  const addExtra = async (file: File | undefined) => {
    if (!file || extras.length >= MAX_EXTRA) return;
    try {
      const shrunk = await shrinkPhoto(file);
      setExtras((current) => [...current, shrunk].slice(0, MAX_EXTRA));
    } catch {
      toast.error(t('errors.title'), t('errors.proofImageInvalid'));
    }
  };

  /** A further photo for a withdrawal already recorded: it goes to the group too. */
  const attachLater = async (id: string, file: File | undefined) => {
    if (!file) return;
    setAttaching(id);
    try {
      const shrunk = await shrinkPhoto(file);
      await api.post(`/api/tiktok/${id}/photos`, { photo: shrunk });
      toast.success(t('tiktok.photoAdded'));
      void load();
    } catch (cause) {
      failure(cause);
    } finally {
      setAttaching(null);
    }
  };

  const clearPhoto = () => {
    scanId.current += 1;
    setScan(null);
    setPhoto(null);
  };

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    try {
      const shrunk = await shrinkPhoto(file);
      setPhoto(shrunk);
      void readFigures(shrunk);
    } catch {
      toast.error(t('errors.title'), t('errors.proofImageInvalid'));
    } finally {
      setReading(false);
    }
  };

  const payout = tiktokPayout(scaled(amount), scaled(rate));
  const cash = payVia === 'CASH';
  const sentPart = scaled(transferPart);
  const ready =
    Boolean(photo) &&
    (cash || account.trim().length > 0) &&
    beneficiaryName.trim().length > 0 &&
    (cash || Boolean(channel)) &&
    payout > 0n &&
    (recipients.length === 0 || recipients.includes(recipient)) &&
    (payVia !== 'SPLIT' || (sentPart > 0n && sentPart < payout)) &&
    scan !== 'READING';

  const submit = async () => {
    if (!ready || posting) return;
    setPosting(true);
    try {
      const created = await api.post<{ id: string }>('/api/tiktok', {
        amount,
        rate,
        account,
        beneficiaryName,
        channel: cash ? '' : channel,
        photo,
        egpAmount: egp.trim() || null,
        payVia,
        transferPart: payVia === 'SPLIT' ? transferPart : null,
        extraPhotos: extras,
        recipient: recipients.length > 0 ? recipient : null,
      });
      toast.success(t('tiktok.recorded'));
      printAfterRecording(created.id, permissions, 'tiktok');
      clearPhoto();
      setAccount('');
      setTransferPart('');
      setExtras([]);
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
                onClick={clearPhoto}
                aria-label={t('common.delete')}
                className="absolute end-2 top-2 flex size-10 items-center justify-center rounded-full bg-surface text-content shadow-[var(--shadow-md)]"
              >
                <X className="size-5" />
              </button>
              {scan && (
                <p
                  role="status"
                  className="mt-2 flex items-center justify-center gap-2 text-center text-xs font-medium text-content-secondary"
                >
                  {scan === 'READING' && <Loader2 className="size-4 animate-spin" />}
                  {t(`tiktok.scan.${scan}`)}
                </p>
              )}
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

        {/* ============ Further photos: the transfer's receipt, a second screenshot ============ */}
        {photo && (
          <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-surface p-3 ring-1 ring-border-subtle">
            {extras.map((extra, index) => (
              <div key={index} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:image/jpeg;base64,${extra}`}
                  alt={t('tiktok.extraPhoto')}
                  className="size-16 rounded-lg object-cover ring-1 ring-border-subtle"
                />
                <button
                  type="button"
                  aria-label={t('common.delete')}
                  onClick={() => setExtras((current) => current.filter((_, at) => at !== index))}
                  className="absolute -end-2 -top-2 flex size-6 items-center justify-center rounded-full bg-surface text-content shadow ring-1 ring-border-subtle"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
            {extras.length < MAX_EXTRA && (
              <label className="flex h-16 cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border-base px-3 text-sm text-content-secondary transition-colors hover:border-primary hover:text-primary-text">
                <ImagePlus className="size-5" />
                {t('tiktok.addExtraPhoto')}
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={(event) => {
                    void addExtra(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
              </label>
            )}
          </div>
        )}

        {/* ============ Who it is for, how it is sent, and how much ============ */}
        <div className="space-y-3 rounded-2xl bg-surface p-4 ring-1 ring-border-subtle">
          {/* How it is handed over: the account and the bank only matter for a transfer. */}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-content-secondary">{t('tiktok.payVia')}</span>
            <div dir="ltr" className="flex gap-1 rounded-full bg-surface-sunken p-1">
              {(['CASH', 'TRANSFER', 'SPLIT'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={payVia === option}
                  disabled={option !== 'CASH' && channels.length === 0}
                  onClick={() => setPayVia(option)}
                  className={`h-9 rounded-full px-4 text-sm font-medium transition-colors disabled:opacity-40 ${
                    payVia === option
                      ? 'bg-surface text-content shadow-[var(--shadow-sm)]'
                      : 'text-content-tertiary hover:text-content-secondary'
                  }`}
                >
                  {option === 'CASH'
                    ? t('machine.payoutCash')
                    : option === 'TRANSFER'
                      ? t('tiktok.payTransfer')
                      : t('machine.payoutSplit')}
                </button>
              ))}
            </div>
          </div>

          {recipients.length > 0 && (
            <Field label={t('tiktok.recipient')} hint={t('tiktok.recipientHint')} required>
              {() => (
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('tiktok.recipient')}>
                  {recipients.map((name) => (
                    <button
                      key={name}
                      type="button"
                      role="radio"
                      aria-checked={recipient === name}
                      onClick={() => setRecipient(name)}
                      className={
                        recipient === name
                          ? 'h-11 flex-1 rounded-xl bg-primary px-4 text-base font-bold text-white shadow-sm'
                          : 'h-11 flex-1 rounded-xl bg-surface-sunken px-4 text-base font-semibold text-content-secondary ring-1 ring-border-subtle hover:text-content'
                      }
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}
            </Field>
          )}

          <Field label={t('tiktok.account')} required={!cash}>
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

          {!cash && (
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
          )}

          {payVia === 'SPLIT' && (
            <Field label={t('tiktok.transferPart')} hint={t('tiktok.transferPartHint')} required>
              {(props) => (
                <Input
                  {...props}
                  dir="ltr"
                  inputMode="decimal"
                  autoComplete="off"
                  value={transferPart}
                  onChange={(event) => setTransferPart(event.target.value)}
                />
              )}
            </Field>
          )}

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
          <div className="flex items-center justify-between gap-2 px-4 pt-3">
            <p className="text-xs font-medium text-content-tertiary">{t('machine.recent')}</p>
            {canPrint && <AutoPrintToggle />}
          </div>
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
                  {(row.photos?.length ?? 0) > 0 && (
                    <div className="mt-1 flex gap-1">
                      {row.photos!.map((extra) => (
                        <a
                          key={extra.id}
                          href={`/api/tiktok/${row.id}/photos/${extra.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/tiktok/${row.id}/photos/${extra.id}`}
                            alt={t('tiktok.extraPhoto')}
                            loading="lazy"
                            className="size-9 rounded object-cover ring-1 ring-border-subtle"
                          />
                        </a>
                      ))}
                    </div>
                  )}
                  <p className="mt-1 text-xs text-content-tertiary">
                    {ln(row.createdBy, 'fullName')} ·{' '}
                    {new Date(row.createdAt).toLocaleString(locale, {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </p>
                </div>
                {(row.photos?.length ?? 0) < MAX_EXTRA && (
                  <label
                    title={t('tiktok.addExtraPhoto')}
                    aria-label={t('tiktok.addExtraPhoto')}
                    className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-content"
                  >
                    {attaching === row.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Paperclip className="size-4" />
                    )}
                    <input
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      disabled={attaching !== null}
                      onChange={(event) => {
                        void attachLater(row.id, event.target.files?.[0]);
                        event.target.value = '';
                      }}
                    />
                  </label>
                )}
                {canPrint && (
                  <button
                    type="button"
                    onClick={() => print(row.id)}
                    title={t('transactions.printReceipt')}
                    aria-label={t('transactions.printReceipt')}
                    className="flex size-10 shrink-0 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-content"
                  >
                    <Printer className="size-4" />
                  </button>
                )}
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
