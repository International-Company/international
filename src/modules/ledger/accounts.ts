/**
 * Chart of accounts.
 *
 * Account codes are stable identifiers the posting rules resolve by name, so
 * the rules never hard-code a database id and the chart can be re-seeded or
 * extended per branch without touching accounting logic.
 */

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
export type AccountKind = 'CASH' | 'BANK' | 'CRYPTO' | 'INTERNAL';

/** Debit increases the balance of asset and expense accounts; credit the rest. */
export function normalBalance(type: AccountType): 'DEBIT' | 'CREDIT' {
  return type === 'ASSET' || type === 'EXPENSE' ? 'DEBIT' : 'CREDIT';
}

/** Signed effect of a debit/credit pair on an account of the given type. */
export function balanceDelta(type: AccountType, debit: bigint, credit: bigint): bigint {
  return normalBalance(type) === 'DEBIT' ? debit - credit : credit - debit;
}

export const ACCOUNT_CODES = {
  /** Physical notes and coins held in the branch drawer. */
  cash: (currency: string) => `CASH-${currency}`,
  /** Balance held at a correspondent bank. */
  bank: (currency: string) => `BANK-${currency}`,
  /** On-chain holdings mirrored from a monitored wallet. */
  crypto: (currency: string) => `CRYPTO-${currency}`,
  /**
   * Per-currency exchange clearing account.
   *
   * Each currency keeps its own self-balancing book — a journal entry must
   * balance within every currency it touches, because summing ILS and USD into
   * one total is arithmetic without meaning. A currency exchange is therefore
   * two single-currency postings joined through these clearing accounts: the
   * ILS leg credits clearing-ILS, the USD leg debits clearing-USD. Valued at
   * market the two offset, and what remains across the pair is the desk's
   * realised spread.
   */
  fxPosition: (currency: string) => `FXPOS-${currency}`,
  /** What the company owes customers who hold balances with it. */
  customerLiability: (currency: string) => `CUSTLIAB-${currency}`,
  /** Received funds whose owner is not yet identified. */
  suspense: (currency: string) => `SUSP-${currency}`,
  /** Realised spread on currency exchange. */
  incomeFx: (currency: string) => `INC-FX-${currency}`,
  /** Commission and service charges. */
  incomeFees: (currency: string) => `INC-FEE-${currency}`,
  /** Blockchain network fees the company absorbs. */
  expenseNetwork: (currency: string) => `EXP-NET-${currency}`,
  /** Cash differences found during the daily count. */
  expenseShortage: (currency: string) => `EXP-SHORT-${currency}`,
  /** Opening balances at system go-live. */
  openingBalance: (currency: string) => `EQ-OPEN-${currency}`,
} as const;

export interface AccountBlueprint {
  code: string;
  nameEn: string;
  nameAr: string;
  type: AccountType;
  kind: AccountKind;
  currencyCode: string;
  allowNegative: boolean;
  isSystem: boolean;
  sortOrder: number;
}

/**
 * Builds the full chart for one currency. Called by the seeder for every
 * active currency, and again whenever an administrator adds a currency.
 */
export function chartForCurrency(currency: string, options: { isCrypto?: boolean } = {}): AccountBlueprint[] {
  const { isCrypto = false } = options;

  const accounts: AccountBlueprint[] = [
    {
      code: ACCOUNT_CODES.fxPosition(currency),
      nameEn: `Exchange Clearing — ${currency}`,
      nameAr: `مقاصة الصرافة — ${currency}`,
      type: 'ASSET',
      kind: 'INTERNAL',
      currencyCode: currency,
      // A short position in a currency is a normal trading state.
      allowNegative: true,
      isSystem: true,
      sortOrder: 300,
    },
    {
      code: ACCOUNT_CODES.customerLiability(currency),
      nameEn: `Customer Balances — ${currency}`,
      nameAr: `أرصدة العملاء — ${currency}`,
      type: 'LIABILITY',
      kind: 'INTERNAL',
      currencyCode: currency,
      allowNegative: true,
      isSystem: true,
      sortOrder: 400,
    },
    {
      code: ACCOUNT_CODES.suspense(currency),
      nameEn: `Suspense — ${currency}`,
      nameAr: `حساب معلّق — ${currency}`,
      type: 'LIABILITY',
      kind: 'INTERNAL',
      currencyCode: currency,
      allowNegative: true,
      isSystem: true,
      sortOrder: 500,
    },
    {
      code: ACCOUNT_CODES.incomeFx(currency),
      nameEn: `Exchange Income — ${currency}`,
      nameAr: `إيرادات الصرافة — ${currency}`,
      type: 'INCOME',
      kind: 'INTERNAL',
      currencyCode: currency,
      allowNegative: true,
      isSystem: true,
      sortOrder: 600,
    },
    {
      code: ACCOUNT_CODES.incomeFees(currency),
      nameEn: `Commission Income — ${currency}`,
      nameAr: `إيرادات العمولات — ${currency}`,
      type: 'INCOME',
      kind: 'INTERNAL',
      currencyCode: currency,
      allowNegative: true,
      isSystem: true,
      sortOrder: 610,
    },
    {
      code: ACCOUNT_CODES.expenseNetwork(currency),
      nameEn: `Network Fees — ${currency}`,
      nameAr: `رسوم الشبكة — ${currency}`,
      type: 'EXPENSE',
      kind: 'INTERNAL',
      currencyCode: currency,
      allowNegative: true,
      isSystem: true,
      sortOrder: 700,
    },
    {
      code: ACCOUNT_CODES.expenseShortage(currency),
      nameEn: `Cash Differences — ${currency}`,
      nameAr: `فروقات الصندوق — ${currency}`,
      type: 'EXPENSE',
      kind: 'INTERNAL',
      currencyCode: currency,
      allowNegative: true,
      isSystem: true,
      sortOrder: 710,
    },
    {
      code: ACCOUNT_CODES.openingBalance(currency),
      nameEn: `Opening Balance — ${currency}`,
      nameAr: `رصيد افتتاحي — ${currency}`,
      type: 'EQUITY',
      kind: 'INTERNAL',
      currencyCode: currency,
      allowNegative: true,
      isSystem: true,
      sortOrder: 800,
    },
  ];

  if (isCrypto) {
    accounts.unshift({
      code: ACCOUNT_CODES.crypto(currency),
      nameEn: `${currency} Wallets`,
      nameAr: `محافظ ${currency}`,
      type: 'ASSET',
      kind: 'CRYPTO',
      currencyCode: currency,
      allowNegative: false,
      isSystem: true,
      sortOrder: 200,
    });
  } else {
    accounts.unshift(
      {
        code: ACCOUNT_CODES.cash(currency),
        nameEn: `Cash Drawer — ${currency}`,
        nameAr: `صندوق النقد — ${currency}`,
        type: 'ASSET',
        kind: 'CASH',
        currencyCode: currency,
        allowNegative: false,
        isSystem: true,
        sortOrder: 100,
      },
      {
        code: ACCOUNT_CODES.bank(currency),
        nameEn: `Bank Account — ${currency}`,
        nameAr: `الحساب البنكي — ${currency}`,
        type: 'ASSET',
        kind: 'BANK',
        currencyCode: currency,
        allowNegative: false,
        isSystem: true,
        sortOrder: 150,
      },
    );
  }

  return accounts;
}
