'use client';

import { useEffect, useState } from 'react';
import { HandCoins } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { useToast } from '@/ui/overlay';
import { Button } from '@/ui/primitives';
import { Input, Select } from '@/ui/form';
import type { Remitted } from './remit-form';

interface Options {
  destinations: string[];
  channels: string[];
  currencies: { code: string; nameAr: string; nameEn: string }[];
  suggested: string | null;
}

/**
 * A remittance the customer sent, carried out by the agent, recorded as the
 * outgoing remittance it is: what the customer paid — in notes, by transfer
 * into one of the office's accounts, or both — and what the agent charges.
 * What the customer is told comes back to be read over first.
 */
export function RemitOutForm({
  noticeId,
  network,
  intakeMethod,
  intakeChannel,
  onDone,
}: {
  noticeId: string;
  network: string;
  intakeMethod: string | null;
  intakeChannel: string | null;
  onDone: (result: Remitted) => void;
}) {
  const { t } = useLocale();
  const toast = useToast();
  const [options, setOptions] = useState<Options | null>(null);
  const [destination, setDestination] = useState('');
  const [currency, setCurrency] = useState('ILS');
  const [collected, setCollected] = useState('');
  const [cost, setCost] = useState('');
  const [transfer, setTransfer] = useState('');
  const [channel, setChannel] = useState(intakeChannel ?? '');
  const [saving, setSaving] = useState(false);
  const paypal = network === 'PAYPAL';
  const method = intakeMethod ?? 'CASH';

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
        setChannel((current) => current || found.channels[0] || '');
        if (!found.currencies.some((entry) => entry.code === 'ILS')) setCurrency(found.currencies[0]?.code ?? 'USD');
      })
      .catch(failure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noticeId]);

  const ready =
    Number(collected) > 0 &&
    (paypal || Boolean(destination)) &&
    (method === 'CASH' || Boolean(channel)) &&
    (method !== 'SPLIT' || (Number(transfer) > 0 && Number(transfer) < Number(collected)));

  const submit = async () => {
    if (!ready || saving) return;
    setSaving(true);
    try {
      const result = await api.post<Remitted>(`/api/inbox/mine/notices/${noticeId}`, {
        action: 'remitOut',
        destination,
        currency,
        collected,
        cost: cost || null,
        intakeChannel: method === 'CASH' ? null : channel,
        intakeTransfer: method === 'SPLIT' ? transfer : null,
      });
      toast.success(t('inbox.out.recorded'));
      onDone(result);
    } catch (cause) {
      failure(cause);
    } finally {
      setSaving(false);
    }
  };

  const label = 'mb-1 block text-[11px] font-semibold text-content-tertiary';
  return (
    <section className="space-y-2.5 rounded-xl bg-surface p-3 ring-1 ring-success/30">
      <h4 className="flex items-center gap-1.5 text-xs font-bold text-content">
        <HandCoins className="size-4 text-success-text" />
        {t('inbox.out.recordTitle')}
      </h4>
      {!paypal && (
        <div>
          <span className={label}>{t('inbox.remit.destination')}</span>
          <Select
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            options={(options?.destinations ?? []).map((entry) => ({ value: entry, label: entry }))}
          />
        </div>
      )}
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <div>
          <span className={label}>{t('inbox.out.collected')}</span>
          <Input
            dir="ltr"
            inputMode="decimal"
            value={collected}
            onChange={(event) => setCollected(event.target.value.replace(/[^\d.]/g, ''))}
          />
        </div>
        <div>
        <span className={label}>&nbsp;</span>
        <Select
          value={currency}
          onChange={(event) => setCurrency(event.target.value)}
          options={(options?.currencies ?? [{ code: currency, nameAr: currency, nameEn: currency }]).map((entry) => ({
            value: entry.code,
            label: entry.code,
          }))}
        />
        </div>
      </div>
      <span className={label}>
        {t('inbox.out.cost')} <span className="font-normal">· {t('inbox.out.costHint')}</span>
      </span>
      <Input
        dir="ltr"
        inputMode="decimal"
        value={cost}
        onChange={(event) => setCost(event.target.value.replace(/[^\d.]/g, ''))}
      />
      {method !== 'CASH' && (
        <div>
          <span className={label}>{t('inbox.out.intakeChannel')}</span>
          <Select
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            options={(options?.channels ?? (channel ? [channel] : [])).map((entry) => ({ value: entry, label: entry }))}
          />
        </div>
      )}
      {method === 'SPLIT' && (
        <div>
          <span className={label}>{t('inbox.out.transferPart')}</span>
          <Input
            dir="ltr"
            inputMode="decimal"
            value={transfer}
            onChange={(event) => setTransfer(event.target.value.replace(/[^\d.]/g, ''))}
          />
        </div>
      )}
      <Button fullWidth loading={saving} disabled={!ready} onClick={() => void submit()} className="bg-success hover:bg-success/90">
        {t('inbox.out.record')}
      </Button>
    </section>
  );
}
