/**
 * Transaction vocabulary — types, statuses and their presentation metadata.
 *
 * Deliberately free of server-only imports: the transaction form, the filters
 * and the status badges all need this on the client, while the posting rules
 * need it on the server. One definition, both sides — a type that exists in the
 * dropdown but not in the posting rules is exactly the bug this prevents.
 */

export const TRANSACTION_TYPES = [
  'CASH_IN',
  'CASH_OUT',
  'EXCHANGE',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'DEPOSIT',
  'WITHDRAWAL',
  'USDT_IN',
  'USDT_OUT',
  'ADJUSTMENT',
] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'POSTED',
  'REJECTED',
  'CANCELLED',
  'REVERSED',
] as const;

export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const TRANSACTION_CHANNELS = ['COUNTER', 'ONLINE', 'BLOCKCHAIN', 'SYSTEM'] as const;
export type TransactionChannel = (typeof TRANSACTION_CHANNELS)[number];

/** Which transaction types move a customer's own balance with the company. */
export const AFFECTS_CUSTOMER_BALANCE: Record<TransactionType, 1 | -1 | 0> = {
  CASH_IN: 0,
  CASH_OUT: 0,
  EXCHANGE: 0,
  TRANSFER_IN: 0,
  TRANSFER_OUT: 0,
  DEPOSIT: 1,
  WITHDRAWAL: -1,
  USDT_IN: 1,
  USDT_OUT: -1,
  ADJUSTMENT: 0,
};

export interface TransactionTypeMeta {
  type: TransactionType;
  nameEn: string;
  nameAr: string;
  /** Does the operator enter a second currency and amount? */
  isCrossCurrency: boolean;
  /** Direction from the company's point of view, for colour and iconography. */
  direction: 'IN' | 'OUT' | 'NEUTRAL';
  requiresCustomer: boolean;
}

export const TRANSACTION_TYPE_META: Record<TransactionType, TransactionTypeMeta> = {
  CASH_IN: { type: 'CASH_IN', nameEn: 'Cash In', nameAr: 'قبض نقدي', isCrossCurrency: false, direction: 'IN', requiresCustomer: false },
  CASH_OUT: { type: 'CASH_OUT', nameEn: 'Cash Out', nameAr: 'صرف نقدي', isCrossCurrency: false, direction: 'OUT', requiresCustomer: false },
  EXCHANGE: { type: 'EXCHANGE', nameEn: 'Currency Exchange', nameAr: 'تبديل عملة', isCrossCurrency: true, direction: 'NEUTRAL', requiresCustomer: false },
  TRANSFER_IN: { type: 'TRANSFER_IN', nameEn: 'Incoming Transfer', nameAr: 'حوالة واردة', isCrossCurrency: false, direction: 'IN', requiresCustomer: false },
  TRANSFER_OUT: { type: 'TRANSFER_OUT', nameEn: 'Outgoing Transfer', nameAr: 'حوالة صادرة', isCrossCurrency: false, direction: 'OUT', requiresCustomer: false },
  DEPOSIT: { type: 'DEPOSIT', nameEn: 'Deposit', nameAr: 'إيداع', isCrossCurrency: false, direction: 'IN', requiresCustomer: true },
  WITHDRAWAL: { type: 'WITHDRAWAL', nameEn: 'Withdrawal', nameAr: 'سحب', isCrossCurrency: false, direction: 'OUT', requiresCustomer: true },
  USDT_IN: { type: 'USDT_IN', nameEn: 'USDT Received', nameAr: 'استلام USDT', isCrossCurrency: false, direction: 'IN', requiresCustomer: false },
  USDT_OUT: { type: 'USDT_OUT', nameEn: 'USDT Sent', nameAr: 'إرسال USDT', isCrossCurrency: false, direction: 'OUT', requiresCustomer: false },
  ADJUSTMENT: { type: 'ADJUSTMENT', nameEn: 'Internal Adjustment', nameAr: 'تسوية داخلية', isCrossCurrency: false, direction: 'NEUTRAL', requiresCustomer: false },
};

export function isTransactionType(value: string): value is TransactionType {
  return (TRANSACTION_TYPES as readonly string[]).includes(value);
}

export function isTransactionStatus(value: string): value is TransactionStatus {
  return (TRANSACTION_STATUSES as readonly string[]).includes(value);
}

/** Statuses a teller can still correct. Anything else is history. */
export const EDITABLE_STATUSES: TransactionStatus[] = ['DRAFT'];

/** Statuses that have reached the ledger. */
export const SETTLED_STATUSES: TransactionStatus[] = ['POSTED', 'REVERSED'];
