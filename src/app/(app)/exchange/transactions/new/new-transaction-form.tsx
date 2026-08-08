'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowRight, Check, Search, UserPlus, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError, queryString } from '@/lib/api-client';
import { Alert, Button, Card, CardBody, CardHeader, PageHeader } from '@/ui/primitives';
import { Field, FormGrid, Input, MoneyInput, Select, Textarea } from '@/ui/form';
import { Money, Rate } from '@/ui/display';
import { useToast } from '@/ui/overlay';
import { cn, debounce } from '@/ui/utils';
import { CustomerPicker, type CustomerHit } from '@/ui/customer-picker';
import {
  TRANSACTION_TYPE_META,
  TRANSACTION_TYPES,
  type TransactionType,
} from '@/modules/exchange/transaction-types';

/**
 * Transaction entry.
 *
 * Optimised for speed at the counter: the amount field takes focus on load,
 * pricing updates live as the operator types, and the draft is autosaved so a
 * dropped connection or an accidental navigation never costs a half-entered
 * transaction.
 *
 * The quote shown here is advisory. The server re-prices from the rate board
 * when the transaction is created, so a tab left open across a rate change
 * cannot lock in a stale price.
 */

interface Currency {
  code: string;
  nameEn: string;
  nameAr: string;
  decimals: number;
  kind: string;
}

interface Account {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  currencyCode: string;
  kind: string;
  balance: string;
}

interface Quote {
  toAmount: string;
  rate: string;
  midRate: string;
  side: string;
  inverted: boolean;
  profit: string;
}

const DRAFT_KEY = 'ifms.draft.newTransaction';

export function NewTransactionForm({
  currencies,
  accounts,
  permissions,
}: {
  currencies: Currency[];
  accounts: Account[];
  permissions: string[];
}) {
  const { t, ln, locale } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [type, setType] = useState<TransactionType>('EXCHANGE');
  const [fromCurrency, setFromCurrency] = useState(currencies[0]?.code ?? 'ILS');
  const [toCurrency, setToCurrency] = useState(currencies[1]?.code ?? 'USD');
  const [amount, setAmount] = useState('');
  const [feeAmount, setFeeAmount] = useState('');
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [counterpartyName, setCounterpartyName] = useState('');
  const [counterpartyPhone, setCounterpartyPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [sourceAccountId, setSourceAccountId] = useState('');
  const [destinationAccountId, setDestinationAccountId] = useState('');

  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const amountRef = useRef<HTMLInputElement>(null);
  const meta = TRANSACTION_TYPE_META[type];

  /**
   * An internal adjustment names both sides explicitly — it is the only way to
   * move value between two of the company's own accounts, and the mechanism a
   * manager uses to enter opening balances at go-live (equity → cash drawer).
   * Both sides must share a currency; crossing currencies is what an exchange
   * is for.
   */
  const isAdjustment = type === 'ADJUSTMENT';
  const adjustmentAccounts = useMemo(
    () => accounts.filter((account) => account.currencyCode === fromCurrency),
    [accounts, fromCurrency],
  );

  // --- Restore an interrupted draft ---------------------------------------
  useEffect(() => {
    try {
      const stored = localStorage.getItem(DRAFT_KEY);
      if (!stored) return;

      const draft = JSON.parse(stored) as Record<string, string>;
      if (draft.type) setType(draft.type as TransactionType);
      if (draft.fromCurrency) setFromCurrency(draft.fromCurrency);
      if (draft.toCurrency) setToCurrency(draft.toCurrency);
      if (draft.amount) setAmount(draft.amount);
      if (draft.notes) setNotes(draft.notes);
      if (draft.counterpartyName) setCounterpartyName(draft.counterpartyName);
    } catch {
      // A malformed draft is not worth surfacing — start clean.
    }
  }, []);

  // --- Autosave -------------------------------------------------------------
  useEffect(() => {
    const draft = { type, fromCurrency, toCurrency, amount, notes, counterpartyName };
    const timer = setTimeout(() => {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    }, 500);
    return () => clearTimeout(timer);
  }, [type, fromCurrency, toCurrency, amount, notes, counterpartyName]);

  useEffect(() => {
    amountRef.current?.focus();
  }, []);

  // --- Live quote -----------------------------------------------------------
  const fetchQuote = useCallback(
    async (from: string, to: string, value: string) => {
      if (!TRANSACTION_TYPE_META[type].isCrossCurrency || !value || Number(value) <= 0) {
        setQuote(null);
        setQuoteError(null);
        return;
      }
      if (from === to) {
        setQuote(null);
        setQuoteError(t('errors.sameCurrencyPair'));
        return;
      }

      setQuoting(true);
      setQuoteError(null);
      try {
        const result = await api.get<Quote>(
          `/api/exchange/quote${queryString({ from, to, amount: value })}`,
        );
        setQuote(result);
      } catch (error) {
        setQuote(null);
        setQuoteError(
          error instanceof ApiError
            ? t(error.messageKey as never, error.params) || error.message
            : t('errors.generic'),
        );
      } finally {
        setQuoting(false);
      }
    },
    [type, t],
  );

  const debouncedQuote = useMemo(
    () => debounce((from: string, to: string, value: string) => void fetchQuote(from, to, value), 250),
    [fetchQuote],
  );

  useEffect(() => {
    debouncedQuote(fromCurrency, toCurrency, amount);
  }, [fromCurrency, toCurrency, amount, debouncedQuote]);

  // --- Submit ----------------------------------------------------------------
  const submit = async () => {
    setFieldErrors({});
    setSubmitting(true);

    try {
      const result = await api.post<{ id: string; reference: string; status: string }>(
        '/api/exchange/transactions',
        {
          type,
          fromCurrency,
          fromAmount: amount,
          ...(meta.isCrossCurrency ? { toCurrency } : {}),
          ...(feeAmount ? { feeCurrency: fromCurrency, feeAmount } : {}),
          ...(isAdjustment ? { sourceAccountId, destinationAccountId } : {}),
          customerId: customer?.id ?? null,
          counterpartyName: counterpartyName || null,
          counterpartyPhone: counterpartyPhone || null,
          notes: notes || null,
          submit: true,
        },
      );

      localStorage.removeItem(DRAFT_KEY);

      toast.success(t('transactions.status.POSTED'), result.reference);

      router.push(`/exchange/transactions/${result.id}`);
      router.refresh();
    } catch (error) {
      if (error instanceof ApiError) {
        setFieldErrors(error.fieldErrors());
        toast.error(
          t('errors.title'),
          t(error.messageKey as never, error.params) || error.message,
        );
      } else {
        toast.error(t('errors.title'), t('errors.generic'));
      }
      setSubmitting(false);
    }
  };

  const canSubmit =
    Boolean(amount) &&
    Number(amount) > 0 &&
    !submitting &&
    (!meta.isCrossCurrency || (quote !== null && !quoteError)) &&
    // An adjustment with one side missing, or both sides the same, would be
    // rejected by the ledger — catch it before the round trip.
    (!isAdjustment ||
      (Boolean(sourceAccountId) &&
        Boolean(destinationAccountId) &&
        sourceAccountId !== destinationAccountId));

  const currencyOptions = currencies.map((currency) => ({
    value: currency.code,
    label: `${currency.code} — ${ln(currency, 'name')}`,
  }));

  const accountOptions = adjustmentAccounts.map((account) => ({
    value: account.id,
    label: `${account.code} — ${ln(account, 'name')}`,
  }));

  const typeOptions = TRANSACTION_TYPES.map((value) => ({
    value,
    label: t(`transactions.type.${value}` as never),
  }));

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('transactions.new')}
        description={t('transactions.newSubtitle')}
        actions={
          <Button variant="ghost" icon={<X />} onClick={() => router.back()}>
            {t('common.cancel')}
          </Button>
        }
      />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) void submit();
        }}
        className="grid grid-cols-1 gap-4 lg:grid-cols-3"
      >
        {/* ----------------------------------------------------------- */}
        {/* Operation                                                    */}
        {/* ----------------------------------------------------------- */}
        <Card className="lg:col-span-2">
          <CardHeader title={t('transactions.new')} />
          <CardBody className="space-y-4">
            <Field label={t('common.type')} required>
              {(props) => (
                <Select
                  {...props}
                  options={typeOptions}
                  value={type}
                  onChange={(event) => setType(event.target.value as TransactionType)}
                />
              )}
            </Field>

            <FormGrid columns={2}>
              <Field
                label={meta.isCrossCurrency ? t('transactions.youReceive') : t('common.amount')}
                required
                error={fieldErrors.fromAmount}
              >
                {(props) => (
                  <div className="flex gap-2">
                    <Select
                      options={currencyOptions}
                      value={fromCurrency}
                      onChange={(event) => setFromCurrency(event.target.value)}
                      className="max-w-[9rem]"
                      aria-label={t('transactions.fromCurrency')}
                    />
                    <MoneyInput
                      {...props}
                      ref={amountRef}
                      value={amount}
                      onValueChange={setAmount}
                      currency={fromCurrency}
                      placeholder="0.00"
                    />
                  </div>
                )}
              </Field>

              {meta.isCrossCurrency && (
                <Field
                  label={t('transactions.youGive')}
                  hint={quoting ? t('common.loading') : t('transactions.quoteHint')}
                  error={quoteError ?? undefined}
                >
                  {(props) => (
                    <div className="flex gap-2">
                      <Select
                        options={currencyOptions}
                        value={toCurrency}
                        onChange={(event) => setToCurrency(event.target.value)}
                        className="max-w-[9rem]"
                        aria-label={t('transactions.toCurrency')}
                      />
                      <div
                        {...props}
                        className={cn(
                          'flex h-[var(--control-height)] flex-1 items-center justify-end rounded-[var(--radius-control)]',
                          'border border-border-base bg-surface-sunken px-3',
                          'text-sm font-semibold tabular-nums text-content',
                        )}
                      >
                        {quote ? (
                          <Money value={quote.toAmount} currency={toCurrency} />
                        ) : (
                          <span className="text-content-tertiary">—</span>
                        )}
                      </div>
                    </div>
                  )}
                </Field>
              )}
            </FormGrid>

            {meta.isCrossCurrency && quote && (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-[var(--radius-control)] border border-border-base bg-surface-sunken px-3 py-2 text-xs">
                <span className="text-content-secondary">
                  {t('transactions.appliedRate')}:{' '}
                  <span className="font-medium text-content">
                    1 {fromCurrency} = <Rate value={quote.rate} /> {toCurrency}
                  </span>
                </span>
                {permissions.includes('dashboard.financials.view') && (
                  <span className="text-content-secondary">
                    {t('transactions.profit')}:{' '}
                    <Money value={quote.profit} currency={toCurrency} colored className="font-medium" />
                  </span>
                )}
              </div>
            )}

            {isAdjustment && (
              <>
                <FormGrid columns={2}>
                  <Field
                    label={t('transactions.adjustmentFrom')}
                    hint={t('transactions.adjustmentHint')}
                    required
                    error={fieldErrors.sourceAccountId}
                  >
                    {(props) => (
                      <Select
                        {...props}
                        options={accountOptions}
                        value={sourceAccountId}
                        placeholder={t('common.select')}
                        onChange={(event) => setSourceAccountId(event.target.value)}
                      />
                    )}
                  </Field>

                  <Field
                    label={t('transactions.adjustmentTo')}
                    required
                    error={fieldErrors.destinationAccountId}
                  >
                    {(props) => (
                      <Select
                        {...props}
                        options={accountOptions}
                        value={destinationAccountId}
                        placeholder={t('common.select')}
                        onChange={(event) => setDestinationAccountId(event.target.value)}
                      />
                    )}
                  </Field>
                </FormGrid>

                {sourceAccountId !== '' && sourceAccountId === destinationAccountId && (
                  <p className="text-xs text-danger-text">{t('transactions.adjustmentSameAccount')}</p>
                )}
              </>
            )}

            <FormGrid columns={2}>
              <Field label={t('transactions.feeAmount')} optionalLabel={t('common.optional')}>
                {(props) => (
                  <MoneyInput
                    {...props}
                    value={feeAmount}
                    onValueChange={setFeeAmount}
                    currency={fromCurrency}
                    placeholder="0.00"
                  />
                )}
              </Field>
            </FormGrid>

            <Field label={t('common.notes')} optionalLabel={t('common.optional')}>
              {(props) => (
                <Textarea
                  {...props}
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  rows={2}
                  maxLength={2000}
                />
              )}
            </Field>
          </CardBody>
        </Card>

        {/* ----------------------------------------------------------- */}
        {/* Counterparty                                                 */}
        {/* ----------------------------------------------------------- */}
        <div className="space-y-4">
          <Card>
            <CardHeader title={t('transactions.customer')} />
            <CardBody className="space-y-3">
              <CustomerPicker
                value={customer}
                onChange={setCustomer}
                permissions={permissions}
                required={meta.requiresCustomer}
                error={fieldErrors.customerId}
              />

              {!customer && !meta.requiresCustomer && (
                <>
                  <Field label={t('transactions.counterpartyName')}>
                    {(props) => (
                      <Input
                        {...props}
                        value={counterpartyName}
                        onChange={(event) => setCounterpartyName(event.target.value)}
                      />
                    )}
                  </Field>
                  <Field label={t('transactions.counterpartyPhone')}>
                    {(props) => (
                      <Input
                        {...props}
                        value={counterpartyPhone}
                        onChange={(event) => setCounterpartyPhone(event.target.value)}
                        dir="ltr"
                      />
                    )}
                  </Field>
                </>
              )}
            </CardBody>
          </Card>

          {meta.requiresCustomer && !customer && (
            <Alert tone="warning" icon={<AlertTriangle />}>
              {t('errors.preconditionFailed')}
            </Alert>
          )}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            loading={submitting}
            disabled={!canSubmit || (meta.requiresCustomer && !customer)}
            icon={<Check />}
            iconEnd={<ArrowRight />}
          >
            {t('transactions.submit')}
          </Button>
        </div>
      </form>
    </div>
  );
}
