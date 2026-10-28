/**
 * Transaction vocabulary.
 *
 * Underneath, every one of these is the same shape: one balance rises and
 * another falls. What separates them is which balances, and what the evidence
 * is — a blockchain, a drawer, or a correspondent's statement.
 *
 * A remittance is the odd one only in that both sides are usually the same
 * currency: the customer hands over shekels and the correspondent is owed
 * shekels, and the difference between the two is the margin.
 *
 * Free of server-only imports: the screens need this in the browser and the
 * services need it on the server. One definition, both sides.
 */

/*
 * Never reuse a retired name. scripts/pre-deploy-schema.mjs deletes rows of the
 * types the reduction retired (CASH_IN, CASH_OUT, DEPOSIT, WITHDRAWAL and the
 * rest) on every deploy, so a new type called "DEPOSIT" would vanish with each
 * one. tests/pre-deploy-safety.test.ts fails if that ever happens.
 */
export const TRANSACTION_TYPES = [
  'EXCHANGE',
  'WALLET_CASHOUT',
  'WALLET_TOPUP',
  'USDT_RECEIVE',
  'USDT_SEND',
  'USDT_SALE',
  'REMITTANCE_OUT',
  'REMITTANCE_IN',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/**
 * Everything the exchange machine records: a conversion, and the two same-
 * currency services beside it — cash out of a customer's wallet, and cash into
 * it. One account, one set of totals, one list of the teller's work.
 */
export const MACHINE_TYPES = ['EXCHANGE', 'WALLET_CASHOUT', 'WALLET_TOPUP'] as const;

/** The same-currency services: the office's income on them is the fee, not a spread. */
export function isWalletType(type: string): boolean {
  return type === 'WALLET_CASHOUT' || type === 'WALLET_TOPUP';
}

/**
 * Recording is posting. A mistake is undone by reversal, which leaves both
 * entries standing rather than erasing the first.
 */
export const TRANSACTION_STATUSES = ['POSTED', 'PENDING_TRANSFER', 'REVERSED'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export interface TransactionTypeMeta {
  type: TransactionType;
  nameEn: string;
  nameAr: string;
}

export const TRANSACTION_TYPE_META: Record<TransactionType, TransactionTypeMeta> = {
  EXCHANGE: { type: 'EXCHANGE', nameEn: 'Currency Exchange', nameAr: 'تصريف عملة' },
  WALLET_CASHOUT: {
    type: 'WALLET_CASHOUT',
    nameEn: 'Wallet cash-out',
    nameAr: 'سحب من محفظة',
  },
  WALLET_TOPUP: { type: 'WALLET_TOPUP', nameEn: 'Wallet top-up', nameAr: 'إيداع في محفظة' },
  REMITTANCE_OUT: { type: 'REMITTANCE_OUT', nameEn: 'Remittance Sent', nameAr: 'حوالة صادرة' },
  REMITTANCE_IN: { type: 'REMITTANCE_IN', nameEn: 'Remittance Received', nameAr: 'حوالة واردة' },
  USDT_RECEIVE: { type: 'USDT_RECEIVE', nameEn: 'USDT Received', nameAr: 'استلام USDT' },
  USDT_SEND: { type: 'USDT_SEND', nameEn: 'USDT Sent', nameAr: 'سحب USDT' },
  USDT_SALE: { type: 'USDT_SALE', nameEn: 'USDT Sold', nameAr: 'بيع USDT' },
};

/**
 * Which balances a type moves between.
 *
 * Derived from the type rather than passed in with each posting, and that is
 * the point: a reversal has to know it too, and there is nowhere on the row it
 * could have been recorded. Sending a remittance always takes cash in and puts
 * the branch in debt to the correspondent; receiving one always draws on that
 * debt and pays cash out. Deciding it in one place means the mirror can never
 * disagree with the original — which, when it did, left a debt standing that
 * had already been undone.
 *
 * `null` on a side means that side has no single balance: it can go through
 * the till, the broker, or both at once, and the two legs recorded on the row
 * are what say how. Both sides can be null, because both sides can go through
 * the broker — the branch pays out that way on the machine, and takes money in
 * that way when a customer buys USDT.
 */
export type BalanceSide = 'CASH' | 'CORRESPONDENT' | 'NONE' | null;

export function balancesFor(type: TransactionType): {
  intake: BalanceSide;
  payout: BalanceSide;
} {
  if (type === 'REMITTANCE_OUT') return { intake: 'CASH', payout: 'CORRESPONDENT' };
  if (type === 'REMITTANCE_IN') return { intake: 'CORRESPONDENT', payout: 'CASH' };
  // A withdrawal is the machine reversed: the customer pays through the till or
  // the broker, and what they take away is USDT out of the one wallet balance.
  if (type === 'USDT_SEND') return { intake: null, payout: 'CASH' };
  /*
   * A USDT sale recorded and nothing more: the teller sent the coins himself,
   * from wherever he holds them, and the office keeps no balance of those. So
   * the customer's money comes in as on any sale, and nothing goes out.
   */
  if (type === 'USDT_SALE') return { intake: null, payout: 'NONE' };
  /*
   * The machine's work goes through either balance on either side: a customer
   * can pay by transfer and take notes, and a wallet cash-out comes in by
   * transfer and goes out in cash while a top-up does the reverse. The legs on
   * the row say which; an old row with none recorded was all cash, and the
   * posting and the reversal both read it that way.
   */
  if (type === 'EXCHANGE' || isWalletType(type)) return { intake: null, payout: null };
  return { intake: 'CASH', payout: null };
}

/**
 * The three words the office uses for its work — صرافة، حوالات، USDT — and the
 * types under each. A manager asks about a teller's day in these, so the
 * screens that answer him group by them.
 */
export const CATEGORIES = {
  EXCHANGE: ['EXCHANGE', 'WALLET_CASHOUT', 'WALLET_TOPUP'],
  REMITTANCE: ['REMITTANCE_OUT', 'REMITTANCE_IN'],
  USDT: ['USDT_RECEIVE', 'USDT_SEND', 'USDT_SALE'],
} as const satisfies Record<string, readonly TransactionType[]>;

export type Category = keyof typeof CATEGORIES;
export const CATEGORY_KEYS = Object.keys(CATEGORIES) as Category[];

export function categoryOf(type: string): Category | null {
  for (const key of CATEGORY_KEYS) {
    if ((CATEGORIES[key] as readonly string[]).includes(type)) return key;
  }
  return null;
}

export function isCategory(value: string): value is Category {
  return (CATEGORY_KEYS as string[]).includes(value);
}

export function isTransactionType(value: string): value is TransactionType {
  return (TRANSACTION_TYPES as readonly string[]).includes(value);
}

export function isTransactionStatus(value: string): value is TransactionStatus {
  return (TRANSACTION_STATUSES as readonly string[]).includes(value);
}
