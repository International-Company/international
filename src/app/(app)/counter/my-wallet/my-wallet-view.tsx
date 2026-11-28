'use client';

import { useCallback, useEffect, useState } from 'react';
import { Camera, CheckCircle2, ClipboardCheck, Hourglass, ImagePlus, Send, Wallet } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Alert, Button, Card, EmptyState, Skeleton } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Field, Input, Textarea } from '@/ui/form';
import { Money } from '@/ui/display';
import { cn } from '@/ui/utils';
import { AssignmentRow, MovementList, WalletSummary, type Assignment, type Report } from '../../treasury/ewallets/wallet-report';

/** A photo chosen or pasted, as a data URL the server reads. */
function readPhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** A field that takes a photo: chosen, taken with the camera, or pasted. */
function PhotoPicker({ value, onChange, label }: { value: string | null; onChange: (value: string | null) => void; label: string }) {
  const pick = async (file: File | null | undefined) => {
    if (file && file.type.startsWith('image/')) onChange(await readPhoto(file));
  };
  return (
    <label
      className={cn(
        'flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-3 text-center text-xs',
        value ? 'border-primary bg-primary-subtle/30' : 'border-border-base text-content-tertiary hover:border-primary',
      )}
      onPaste={(event) => void pick([...event.clipboardData.files][0])}
      tabIndex={0}
    >
      {value ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={value} alt="" className="max-h-48 rounded-lg object-contain" />
      ) : (
        <>
          <ImagePlus className="size-6" />
          {label}
        </>
      )}
      <input type="file" accept="image/*" className="hidden" onChange={(event) => void pick(event.target.files?.[0])} />
    </label>
  );
}

export function MyWalletView() {
  const { t } = useLocale();
  const toast = useToast();
  const [report, setReport] = useState<Report | null | undefined>(undefined);
  const [sending, setSending] = useState<Assignment | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [sentAmount, setSentAmount] = useState('');
  const [counting, setCounting] = useState(false);
  const [countForm, setCountForm] = useState({ actual: '', screenshot: null as string | null, note: '' });
  const [busy, setBusy] = useState(false);

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
      .get<{ report: Report | null }>('/api/ewallets/mine')
      .then((result) => setReport(result.report))
      .catch((cause) => {
        setReport(null);
        failure(cause);
      });
  }, [failure]);

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  if (report === undefined) return <Skeleton className="h-48" />;
  if (report === null) return <EmptyState icon={<Wallet />} title={t('ewallet.noWallet')} description={t('ewallet.noWalletHint')} />;

  const send = async () => {
    if (!sending || !receipt) return;
    setBusy(true);
    try {
      const next = await api.post<Report>(`/api/ewallets/mine/execute/${sending.id}`, {
        receipt,
        amount: sentAmount.trim() && Number(sentAmount) !== Number(sending.amount) / 1e8 ? sentAmount.trim() : null,
      });
      setReport(next);
      setSending(null);
      toast.success(t('ewallet.sentDone'));
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(false);
    }
  };

  const count = async () => {
    if (!countForm.screenshot || !countForm.actual) return;
    setBusy(true);
    try {
      await api.post('/api/ewallets/mine/count', { actual: countForm.actual, screenshot: countForm.screenshot, note: countForm.note || null });
      setCounting(false);
      toast.success(t('ewallet.countSent'));
      load();
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(false);
    }
  };

  const pending = report.pendingCount;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-4">
        {/* --- What waits to be sent --- */}
        <Card className="p-0">
          <h3 className="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5 text-sm font-bold text-content">
            <Send className="size-4 text-primary" />
            {t('ewallet.toSend', { count: report.waiting.length })}
          </h3>
          {report.waiting.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-content-tertiary">{t('ewallet.nothingToSend')}</p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {report.waiting.map((row) => (
                <AssignmentRow
                  key={row.id}
                  row={row}
                  action={
                    <Button
                      size="sm"
                      icon={<CheckCircle2 />}
                      onClick={() => {
                        setReceipt(null);
                        setSentAmount(String(Number(row.amount) / 1e8));
                        setSending(row);
                      }}
                    >
                      {t('ewallet.markSent')}
                    </Button>
                  }
                />
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-0">
          <h3 className="border-b border-border-subtle px-4 py-2.5 text-sm font-bold text-content">{t('ewallet.done')}</h3>
          {report.done.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-content-tertiary">{t('ewallet.noneDone')}</p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {report.done.map((row) => (
                <AssignmentRow key={row.id} row={row} />
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-0">
          <h3 className="border-b border-border-subtle px-4 py-2.5 text-sm font-bold text-content">{t('ewallet.movements')}</h3>
          <MovementList report={report} />
        </Card>
      </div>

      {/* --- The wallet, and its count --- */}
      <div className="space-y-4">
        <Card className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-content-secondary">{report.wallet.name}</span>
            <span className="text-2xl font-extrabold tabular-nums text-content">
              <Money value={report.wallet.balance} currency={report.wallet.currency} />
            </span>
          </div>
          <WalletSummary report={report} />
          {pending ? (
            <Alert tone="primary" icon={<Hourglass />}>
              {t('ewallet.countPending', {
                actual: (Number(pending.actual) / 1e8).toFixed(2),
              })}
            </Alert>
          ) : (
            <Button
              fullWidth
              icon={<ClipboardCheck />}
              onClick={() => {
                setCountForm({ actual: '', screenshot: null, note: '' });
                setCounting(true);
              }}
            >
              {t('ewallet.countNow')}
            </Button>
          )}
        </Card>
      </div>

      {/* --- Sent: the receipt, and what left the wallet --- */}
      <Dialog
        open={sending !== null}
        onClose={() => setSending(null)}
        title={t('ewallet.markSent')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setSending(null)}>
              {t('common.cancel')}
            </Button>
            <Button icon={<CheckCircle2 />} loading={busy} disabled={!receipt} onClick={() => void send()}>
              {t('ewallet.confirmSent')}
            </Button>
          </>
        }
      >
        {sending && (
          <div className="space-y-3">
            <ul className="rounded-xl ring-1 ring-border-subtle">
              <AssignmentRow row={sending} />
            </ul>
            <PhotoPicker value={receipt} onChange={setReceipt} label={t('ewallet.receiptHint')} />
            <Field label={t('ewallet.sentAmount')} hint={t('ewallet.sentAmountHint')}>
              {(props) => (
                <Input {...props} dir="ltr" inputMode="decimal" value={sentAmount} onChange={(event) => setSentAmount(event.target.value.replace(/[^\d.]/g, ''))} />
              )}
            </Field>
          </div>
        )}
      </Dialog>

      {/* --- The count: the app's balance, and its screenshot --- */}
      <Dialog
        open={counting}
        onClose={() => setCounting(false)}
        title={t('ewallet.countNow')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCounting(false)}>
              {t('common.cancel')}
            </Button>
            <Button icon={<Camera />} loading={busy} disabled={!countForm.screenshot || !countForm.actual} onClick={() => void count()}>
              {t('ewallet.sendCount')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('ewallet.actualLabel')} required hint={t('ewallet.actualHint')}>
            {(props) => (
              <Input
                {...props}
                dir="ltr"
                inputMode="decimal"
                value={countForm.actual}
                onChange={(event) => setCountForm((current) => ({ ...current, actual: event.target.value.replace(/[^\d.]/g, '') }))}
              />
            )}
          </Field>
          <PhotoPicker
            value={countForm.screenshot}
            onChange={(screenshot) => setCountForm((current) => ({ ...current, screenshot }))}
            label={t('ewallet.screenshotHint')}
          />
          <Field label={t('ewallet.note')}>
            {(props) => (
              <Textarea {...props} rows={2} value={countForm.note} onChange={(event) => setCountForm((current) => ({ ...current, note: event.target.value }))} />
            )}
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
