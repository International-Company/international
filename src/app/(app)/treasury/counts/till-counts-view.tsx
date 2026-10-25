'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowDownUp, Calculator, ClipboardCheck, EyeOff, FileText } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { describeFailure } from '@/lib/failure';
import { normalizeDigits } from '@/core/money/money';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState } from '@/ui/primitives';
import { ConfirmDialog, Dialog, useToast } from '@/ui/overlay';
import { Field, Input, Select } from '@/ui/form';
import { DateText } from '@/ui/display';
import { cn } from '@/ui/utils';
import { DenominationCounter, hasNotes } from '../handovers/denomination-counter';
import { plain } from '../handovers/count-record';
import { TillRecordDialog, useVerdict, verdictTone } from './till-record';

/**
 * جرد الصناديق — the cash proof, teller by teller.
 *
 * Each card shows what a teller should be holding right now, worked out from
 * their own deals since they were last counted. Counting opens the same figures
 * with a field for each currency; the difference is shown as it is typed,
 * unless the count is blind, in which case nothing is shown until it is saved —
 * the way a bank counts a window, so the person counting is not led by the
 * number they are meant to be checking.
 */

interface Person {
  id: string;
  fullNameEn: string;
  fullNameAr: string;
}

interface Currency {
  code: string;
  nameEn: string;
  nameAr: string;
  decimals: number;
}

interface PreviewLine {
  currency: string;
  opening: string;
  received: string;
  paid: string;
  toppedUp: string;
  drawn: string;
  expected: string;
}

interface Preview {
  teller: Person;
  periodStart: string;
  previous: { reference: string; createdAt: string } | null;
  deals: number;
  onShift: boolean;
  lines: PreviewLine[];
}

interface RecentCount {
  id: string;
  reference: string;
  teller: Person;
  countedBy: { fullNameEn: string; fullNameAr: string };
  createdAt: string;
  lines: { currency: string; expected: string; counted: string; difference: string }[];
}

interface Entry {
  counted: string;
  kept: string;
  opening: string;
  notes: boolean;
}

const EMPTY: Entry = { counted: '', kept: '', opening: '', notes: false };

export function TillCountsView({
  tellers,
  currencies,
}: {
  tellers: Person[];
  currencies: Currency[];
}) {
  const { t, ln } = useLocale();
  const toast = useToast();

  const decimalsOf = useCallback(
    (code: string) => currencies.find((currency) => currency.code === code)?.decimals ?? 2,
    [currencies],
  );
  const verdict = useVerdict(decimalsOf);

  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [recent, setRecent] = useState<RecentCount[] | null>(null);

  const [counting, setCounting] = useState<Preview | null>(null);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [extra, setExtra] = useState<string[]>([]);
  const [blind, setBlind] = useState(false);
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);

  const [adjusting, setAdjusting] = useState<Person | null>(null);
  const [adjustment, setAdjustment] = useState({
    currency: '',
    direction: 'IN',
    amount: '',
    note: '',
  });

  const [record, setRecord] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [list, ...books] = await Promise.all([
      api.get<{ recent: RecentCount[] }>('/api/treasury/till-counts').catch(() => ({ recent: [] })),
      ...tellers.map((person) =>
        api.get<Preview>(`/api/treasury/till-counts?tellerId=${person.id}`).catch(() => null),
      ),
    ]);
    setRecent(list.recent);
    setPreviews(
      Object.fromEntries(
        books
          .filter((book): book is Preview => book !== null)
          .map((book) => [book.teller.id, book]),
      ),
    );
  }, [tellers]);

  useEffect(() => {
    void load();
  }, [load]);

  const fail = (caught: unknown) => {
    const { title, body } = describeFailure(caught, t as never);
    toast.error(title, body);
  };

  const startCount = async (person: Person) => {
    try {
      // Fresh figures, not the card's: a deal may have been recorded since.
      const books = await api.get<Preview>(`/api/treasury/till-counts?tellerId=${person.id}`);
      setCounting(books);
      setEntries({});
      setExtra([]);
      setNote('');
    } catch (caught) {
      fail(caught);
    }
  };

  // The currencies on the form: whatever the books know about, plus any added.
  const formLines: PreviewLine[] = counting
    ? [
        ...counting.lines,
        ...extra.map((currency) => ({
          currency,
          opening: '0',
          received: '0',
          paid: '0',
          toppedUp: '0',
          drawn: '0',
          expected: '0',
        })),
      ]
    : [];

  const entryOf = (currency: string) => entries[currency] ?? EMPTY;
  const setEntry = (currency: string, patch: Partial<Entry>) =>
    setEntries((current) => ({ ...current, [currency]: { ...entryOf(currency), ...patch } }));

  const firstCount = counting?.previous === null;

  /** The expected figure with a typed opening, on a first count. */
  const expectedOf = (line: PreviewLine) => {
    const opening =
      firstCount && entryOf(line.currency).opening !== ''
        ? toScaled(entryOf(line.currency).opening)
        : BigInt(line.opening);
    return (
      opening +
      BigInt(line.received) -
      BigInt(line.paid) +
      BigInt(line.toppedUp) -
      BigInt(line.drawn)
    );
  };

  const missing = formLines.some(
    (line) => entryOf(line.currency).counted === '' && expectedOf(line) !== 0n,
  );
  const differences = formLines.filter((line) => {
    const typed = entryOf(line.currency).counted;
    return typed !== '' && expectedOf(line) - toScaled(typed) !== 0n;
  });

  const save = async () => {
    if (!counting) return;
    setBusy(true);
    try {
      const result = await api.post<{ id: string; reference: string }>(
        '/api/treasury/till-counts',
        {
          action: 'count',
          tellerId: counting.teller.id,
          note: note.trim() || null,
          lines: formLines
            .filter((line) => entryOf(line.currency).counted !== '' || expectedOf(line) !== 0n)
            .map((line) => {
              const entry = entryOf(line.currency);
              return {
                currency: line.currency,
                counted: entry.counted || '0',
                kept: entry.kept || null,
                opening: firstCount && entry.opening ? entry.opening : null,
              };
            }),
        },
      );
      toast.success(t('till.saved', { reference: result.reference }));
      setCounting(null);
      setConfirming(false);
      setRecord(result.id);
      await load();
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  const adjust = async () => {
    if (!adjusting) return;
    setBusy(true);
    try {
      await api.post('/api/treasury/till-counts', {
        action: 'adjust',
        tellerId: adjusting.id,
        currency: adjustment.currency || currencies[0]?.code,
        direction: adjustment.direction,
        amount: adjustment.amount,
        note: adjustment.note.trim() || null,
      });
      toast.success(t('till.adjusted'));
      setAdjusting(null);
      await load();
      if (counting && counting.teller.id === adjusting.id) await startCount(counting.teller);
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  const addable = currencies.filter(
    (currency) => !formLines.some((line) => line.currency === currency.code),
  );

  return (
    <div className="space-y-4">
      {/* --- The tellers, each with what their drawer should hold now --- */}
      {tellers.length === 0 ? (
        <EmptyState title={t('till.tellers')} description={t('till.none')} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {tellers.map((person) => {
            const books = previews[person.id];
            const holding = books?.lines.filter((line) => line.expected !== '0') ?? [];
            return (
              <Card key={person.id}>
                <CardBody className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold">{ln(person, 'fullName')}</p>
                      {books && (
                        <p className="text-xs text-content-tertiary">
                          {books.previous
                            ? t('till.sinceLast', { reference: books.previous.reference })
                            : t('till.firstCount')}
                          {' · '}
                          {t('till.deals', { count: books.deals })}
                        </p>
                      )}
                    </div>
                    {books?.onShift && <Badge tone="warning">{t('till.onShiftBadge')}</Badge>}
                  </div>

                  <div>
                    <p className="mb-1 text-xs text-content-secondary">{t('till.nowInDrawer')}</p>
                    {!books ? (
                      <p className="text-sm text-content-tertiary">{t('common.loading')}</p>
                    ) : holding.length === 0 ? (
                      <p className="text-sm text-content-tertiary">{t('till.nothingYet')}</p>
                    ) : (
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {holding.map((line) => (
                          <span
                            key={line.currency}
                            className="text-lg font-bold tabular-nums ltr-content"
                          >
                            {plain(line.expected, decimalsOf(line.currency))}{' '}
                            <span className="text-xs font-medium text-content-secondary">
                              {line.currency}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {books?.onShift && (
                    <p className="rounded-lg bg-warning-subtle px-2.5 py-2 text-xs text-warning-text">
                      {t('till.onShiftCard')}
                    </p>
                  )}

                  <div className="flex gap-2">
                    <Button
                      className="flex-1"
                      icon={<ClipboardCheck />}
                      disabled={!books || books.onShift}
                      onClick={() => void startCount(person)}
                    >
                      {t('till.count')}
                    </Button>
                    <Button
                      variant="secondary"
                      icon={<ArrowDownUp />}
                      onClick={() => {
                        setAdjustment({
                          currency: currencies[0]?.code ?? '',
                          direction: 'IN',
                          amount: '',
                          note: '',
                        });
                        setAdjusting(person);
                      }}
                    >
                      {t('till.adjust')}
                    </Button>
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      {/* --- Recent counts --- */}
      <Card>
        <CardHeader title={t('till.recent')} description={t('till.recentHint')} />
        <CardBody>
          {recent === null ? (
            <p className="text-sm text-content-tertiary">{t('common.loading')}</p>
          ) : recent.length === 0 ? (
            <p className="text-sm text-content-tertiary">{t('till.none')}</p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {recent.map((count) => (
                <li key={count.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
                  <div className="min-w-40">
                    <p className="font-medium">{ln(count.teller, 'fullName')}</p>
                    <p className="text-xs text-content-tertiary">
                      <span className="font-mono ltr-content">{count.reference}</span> ·{' '}
                      <DateText value={count.createdAt} withTime />
                    </p>
                  </div>
                  <div className="flex flex-1 flex-wrap gap-1.5">
                    {count.lines.map((line) => {
                      const result = verdict(line.currency, line.difference);
                      return (
                        <Badge
                          key={line.currency}
                          tone={
                            result.tone === 'ok'
                              ? 'success'
                              : result.tone === 'short'
                                ? 'danger'
                                : 'warning'
                          }
                        >
                          {line.currency}: {result.text}
                        </Badge>
                      );
                    })}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<FileText />}
                    onClick={() => setRecord(count.id)}
                  >
                    {t('till.record')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* --- The count --- */}
      <Dialog
        open={counting !== null}
        onClose={() => setCounting(null)}
        size="lg"
        title={counting ? t('till.countTitle', { name: ln(counting.teller, 'fullName') }) : ''}
        description={
          counting
            ? `${
                counting.previous
                  ? t('till.sinceLast', { reference: counting.previous.reference })
                  : t('till.firstCount')
              } · ${t('till.deals', { count: counting.deals })}`
            : undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setCounting(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              icon={<ClipboardCheck />}
              loading={busy}
              disabled={missing || counting?.onShift}
              onClick={() => (differences.length > 0 && !blind ? setConfirming(true) : void save())}
            >
              {t('till.save')}
            </Button>
          </>
        }
      >
        {counting && (
          <div className="space-y-4">
            {counting.onShift && <Alert tone="warning">{t('till.onShift')}</Alert>}

            <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-surface-sunken p-2.5 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={blind}
                onChange={(event) => setBlind(event.target.checked)}
              />
              <span>
                <span className="flex items-center gap-1 font-medium">
                  <EyeOff className="size-3.5" /> {t('till.blind')}
                </span>
                <span className="text-xs text-content-secondary">{t('till.blindHint')}</span>
              </span>
            </label>

            {formLines.map((line) => {
              const decimals = decimalsOf(line.currency);
              const entry = entryOf(line.currency);
              const expected = expectedOf(line);
              const typed = entry.counted !== '' ? toScaled(entry.counted) : null;
              const result =
                typed !== null && !blind
                  ? verdict(line.currency, (expected - typed).toString())
                  : null;
              const currency = currencies.find((row) => row.code === line.currency);

              return (
                <div
                  key={line.currency}
                  className="space-y-2 rounded-xl border border-border-subtle p-3"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-semibold">
                      {currency
                        ? ln(currency as unknown as Record<string, unknown>, 'name')
                        : line.currency}{' '}
                      <span className="text-xs text-content-tertiary ltr-content">
                        ({line.currency})
                      </span>
                    </p>
                    {!blind && (
                      <p className="text-sm">
                        {t('till.expected')}:{' '}
                        <span className="text-base font-bold tabular-nums ltr-content">
                          {plain(expected.toString(), decimals)}
                        </span>
                      </p>
                    )}
                  </div>

                  {/* How the expected figure was reached, term by term. */}
                  {!blind && (
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-content-secondary">
                      {(['opening', 'received', 'paid', 'toppedUp', 'drawn'] as const).map(
                        (term) => {
                          const value =
                            term === 'opening' && firstCount && entry.opening !== ''
                              ? toScaled(entry.opening).toString()
                              : line[term];
                          if (term !== 'opening' && value === '0') return null;
                          const sign =
                            term === 'paid' || term === 'drawn'
                              ? '−'
                              : term === 'opening'
                                ? ''
                                : '+';
                          return (
                            <span key={term}>
                              {sign} {t(`till.${term}`)}{' '}
                              <span className="font-semibold tabular-nums ltr-content">
                                {plain(value, decimals)}
                              </span>
                            </span>
                          );
                        },
                      )}
                    </div>
                  )}

                  {firstCount && (
                    <Field label={t('till.opening')} hint={t('till.openingHint')}>
                      {(props) => (
                        <Input
                          {...props}
                          dir="ltr"
                          inputMode="decimal"
                          placeholder="0"
                          value={entry.opening}
                          onChange={(event) =>
                            setEntry(line.currency, {
                              opening: sanitise(event.target.value, decimals),
                            })
                          }
                        />
                      )}
                    </Field>
                  )}

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t('till.counted')} required>
                      {(props) => (
                        <div className="space-y-1.5">
                          <div className="flex gap-2">
                            <Input
                              {...props}
                              dir="ltr"
                              inputMode="decimal"
                              placeholder="0"
                              className="text-lg font-semibold"
                              value={entry.counted}
                              onChange={(event) =>
                                setEntry(line.currency, {
                                  counted: sanitise(event.target.value, decimals),
                                })
                              }
                            />
                            {hasNotes(line.currency) && (
                              <Button
                                variant={entry.notes ? 'primary' : 'secondary'}
                                icon={<Calculator />}
                                aria-label={t('handover.byNotes')}
                                onClick={() => setEntry(line.currency, { notes: !entry.notes })}
                              />
                            )}
                          </div>
                          {result && (
                            <p className={cn('text-xs font-semibold', verdictTone[result.tone])}>
                              {result.text}
                            </p>
                          )}
                        </div>
                      )}
                    </Field>

                    <Field label={t('till.kept')} hint={t('till.keptHint')}>
                      {(props) => (
                        <div className="flex gap-2">
                          <Input
                            {...props}
                            dir="ltr"
                            inputMode="decimal"
                            placeholder={entry.counted || '0'}
                            value={entry.kept}
                            onChange={(event) =>
                              setEntry(line.currency, {
                                kept: sanitise(event.target.value, decimals),
                              })
                            }
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEntry(line.currency, { kept: '0' })}
                          >
                            {t('till.keepNone')}
                          </Button>
                        </div>
                      )}
                    </Field>
                  </div>

                  {entry.notes && (
                    <DenominationCounter
                      currency={line.currency}
                      decimals={decimals}
                      onUse={(amount) => setEntry(line.currency, { counted: amount, notes: false })}
                    />
                  )}
                </div>
              );
            })}

            {addable.length > 0 && (
              <div className="flex items-end gap-2">
                <Field label={t('till.addCurrency')}>
                  {(props) => (
                    <Select
                      {...props}
                      value=""
                      onChange={(event) => {
                        const code = event.target.value;
                        if (code) setExtra((current) => [...current, code]);
                      }}
                      options={[
                        { value: '', label: '—' },
                        ...addable.map((currency) => ({
                          value: currency.code,
                          label: currency.code,
                        })),
                      ]}
                    />
                  )}
                </Field>
              </div>
            )}

            <Field label={t('till.note')}>
              {(props) => (
                <Input {...props} value={note} onChange={(event) => setNote(event.target.value)} />
              )}
            </Field>
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => void save()}
        title={t('till.confirmTitle')}
        message={`${differences
          .map(
            (line) =>
              `${line.currency}: ${verdict(line.currency, (expectedOf(line) - toScaled(entryOf(line.currency).counted)).toString()).text}`,
          )
          .join(' · ')}\n${t('till.confirmBody')}`}
        confirmLabel={t('till.save')}
        cancelLabel={t('common.back')}
        tone="danger"
        loading={busy}
      />

      {/* --- Cash given to or taken from a teller between counts --- */}
      <Dialog
        open={adjusting !== null}
        onClose={() => setAdjusting(null)}
        title={t('till.adjustTitle')}
        description={adjusting ? ln(adjusting, 'fullName') : undefined}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdjusting(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              loading={busy}
              disabled={adjustment.amount === '' || toScaled(adjustment.amount) <= 0n}
              onClick={() => void adjust()}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Alert tone="neutral">{t('till.adjustHint')}</Alert>
          <div className="grid grid-cols-2 gap-2">
            {(['IN', 'OUT'] as const).map((direction) => (
              <Button
                key={direction}
                variant={adjustment.direction === direction ? 'primary' : 'secondary'}
                onClick={() => setAdjustment((current) => ({ ...current, direction }))}
              >
                {direction === 'IN' ? t('till.giveTo') : t('till.takeFrom')}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('till.currency')}>
              {(props) => (
                <Select
                  {...props}
                  value={adjustment.currency}
                  onChange={(event) =>
                    setAdjustment((current) => ({ ...current, currency: event.target.value }))
                  }
                  options={currencies.map((currency) => ({
                    value: currency.code,
                    label: currency.code,
                  }))}
                />
              )}
            </Field>
            <Field label={t('till.amount')} required>
              {(props) => (
                <Input
                  {...props}
                  dir="ltr"
                  inputMode="decimal"
                  placeholder="0"
                  value={adjustment.amount}
                  onChange={(event) =>
                    setAdjustment((current) => ({
                      ...current,
                      amount: sanitise(event.target.value, decimalsOf(current.currency)),
                    }))
                  }
                />
              )}
            </Field>
          </div>
          <Field label={t('till.note')}>
            {(props) => (
              <Input
                {...props}
                value={adjustment.note}
                onChange={(event) =>
                  setAdjustment((current) => ({ ...current, note: event.target.value }))
                }
              />
            )}
          </Field>
        </div>
      </Dialog>

      <TillRecordDialog id={record} onClose={() => setRecord(null)} decimalsOf={decimalsOf} />
    </div>
  );
}

/** A typed amount at the 1e8 scale the server speaks. */
function toScaled(value: string): bigint {
  const [whole = '0', fraction = ''] = value.trim().replace(/,/g, '').split('.');
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) return 0n;
  return BigInt(whole || '0') * 100_000_000n + BigInt((fraction + '00000000').slice(0, 8));
}

/** Digits and one decimal point, at most `limit` places after it. */
function sanitise(raw: string, limit: number): string {
  const cleaned = normalizeDigits(raw)
    .replace(/[,٫٬]/g, '.')
    .replace(/[^\d.]/g, '');
  const [whole = '', ...rest] = cleaned.split('.');
  const fraction = rest.join('').slice(0, limit);
  const next = rest.length > 0 && limit > 0 ? `${whole}.${fraction}` : whole;
  return next.replace(/^0+(?=\d)/, '');
}
