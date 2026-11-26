/**
 * Where a deal's transfer goes, as the desk shows it and the group is told:
 * the account written on it, or — a wallet often being just the number — the
 * phone of whoever receives it.
 */
export interface DealAccountRow {
  type: string;
  payoutAccount: string | null;
  recipientPhone: string | null;
  counterpartyPhone: string | null;
  customer: { phone: string | null } | null;
}

export const DEAL_ACCOUNT_SELECT = {
  type: true,
  payoutAccount: true,
  recipientPhone: true,
  counterpartyPhone: true,
  customer: { select: { phone: true } },
} as const;

export function dealPhone(row: DealAccountRow): string | null {
  const received = row.type === 'REMITTANCE_IN' || row.type === 'PAYPAL_IN';
  return (
    (received ? row.recipientPhone : null) ??
    row.customer?.phone ??
    row.counterpartyPhone ??
    row.recipientPhone ??
    null
  );
}

export function dealAccount(row: DealAccountRow): string | null {
  return row.payoutAccount?.trim() || dealPhone(row);
}
