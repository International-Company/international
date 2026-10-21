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

export const TRANSACTION_TYPES = [
  'EXCHANGE',
  'USDT_RECEIVE',
  'USDT_SEND',
  'REMITTANCE_OUT',
  'REMITTANCE_IN',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

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
  REMITTANCE_OUT: { type: 'REMITTANCE_OUT', nameEn: 'Remittance Sent', nameAr: 'حوالة صادرة' },
  REMITTANCE_IN: { type: 'REMITTANCE_IN', nameEn: 'Remittance Received', nameAr: 'حوالة واردة' },
  USDT_RECEIVE: { type: 'USDT_RECEIVE', nameEn: 'USDT Received', nameAr: 'استلام USDT' },
  USDT_SEND: { type: 'USDT_SEND', nameEn: 'USDT Sent', nameAr: 'سحب USDT' },
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
export type BalanceSide = 'CASH' | 'CORRESPONDENT' | null;

export function balancesFor(type: TransactionType): {
  intake: BalanceSide;
  payout: BalanceSide;
} {
  if (type === 'REMITTANCE_OUT') return { intake: 'CASH', payout: 'CORRESPONDENT' };
  if (type === 'REMITTANCE_IN') return { intake: 'CORRESPONDENT', payout: 'CASH' };
  // A withdrawal is the machine reversed: the customer pays through the till or
  // the broker, and what they take away is USDT out of the one wallet balance.
  if (type === 'USDT_SEND') return { intake: null, payout: 'CASH' };
  return { intake: 'CASH', payout: null };
}

/**
 * The three words the office uses for its work — صرافة، حوالات، USDT — and the
 * types under each. A manager asks about a teller's day in these, so the
 * screens that answer him group by them.
 */
export const CATEGORIES = {
  EXCHANGE: ['EXCHANGE'],
  REMITTANCE: ['REMITTANCE_OUT', 'REMITTANCE_IN'],
  USDT: ['USDT_RECEIVE', 'USDT_SEND'],
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
