/**
 * Transaction vocabulary.
 *
 * Two tools, so two kinds of transaction — and underneath they are the same
 * shape: the customer hands over one currency and takes another. What separates
 * them is where the incoming side came from, which is worth keeping apart
 * because one of them is evidenced by a blockchain and the other by a drawer.
 *
 * Free of server-only imports: the screens need this in the browser and the
 * services need it on the server. One definition, both sides.
 */

export const TRANSACTION_TYPES = ['EXCHANGE', 'USDT_RECEIVE'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/**
 * Recording is posting. A mistake is undone by reversal, which leaves both
 * entries standing rather than erasing the first.
 */
export const TRANSACTION_STATUSES = ['POSTED', 'REVERSED'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export interface TransactionTypeMeta {
  type: TransactionType;
  nameEn: string;
  nameAr: string;
}

export const TRANSACTION_TYPE_META: Record<TransactionType, TransactionTypeMeta> = {
  EXCHANGE: { type: 'EXCHANGE', nameEn: 'Currency Exchange', nameAr: 'تصريف عملة' },
  USDT_RECEIVE: { type: 'USDT_RECEIVE', nameEn: 'USDT Received', nameAr: 'استلام USDT' },
};

export function isTransactionType(value: string): value is TransactionType {
  return (TRANSACTION_TYPES as readonly string[]).includes(value);
}

export function isTransactionStatus(value: string): value is TransactionStatus {
  return (TRANSACTION_STATUSES as readonly string[]).includes(value);
}
