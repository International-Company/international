import 'server-only';
import type { Tx } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import type { JournalLineInput } from '@/modules/ledger/ledger.service';
import { ACCOUNT_CODES } from '@/modules/ledger/accounts';
import { TRANSACTION_TYPE_META, type TransactionType } from './transaction-types';

/**
 * Posting rules — the single place that decides which accounts a transaction
 * type touches.
 *
 * Keeping this as pure data-in/lines-out means the accounting treatment of a
 * transaction type can be reviewed by an accountant in one file, and changing
 * it does not require touching the workflow, the API, or the UI.
 *
 * The type vocabulary itself lives in `./transaction-types`, which the browser
 * can import; only the posting logic below is server-bound.
 */

export * from './transaction-types';

export interface PostingContext {
  type: TransactionType;
  reference: string;
  fromCurrency: string;
  fromAmount: bigint;
  toCurrency: string;
  toAmount: bigint;
  feeCurrency: string | null;
  feeAmount: bigint;
  customerId: string | null;
  sourceAccountId: string | null;
  destinationAccountId: string | null;
  branchId: string | null;
}

/** Resolves a well-known account code to its id, preferring the branch's own. */
async function accountId(tx: Tx, code: string, branchId: string | null): Promise<string> {
  const account = await tx.account.findUnique({ where: { code } });
  if (!account) {
    throw errors.precondition(
      `Chart of accounts is missing "${code}" — run the account setup for this currency`,
      'errors.missingAccount',
    );
  }
  if (!account.isActive) {
    throw errors.precondition(`Account ${code} is inactive`, 'errors.accountInactive');
  }
  return account.id;
}

/** The account holding physical/settled funds for a currency. */
async function fundsAccount(
  tx: Tx,
  currency: string,
  branchId: string | null,
  override: string | null,
): Promise<string> {
  if (override) return override;

  const currencyRow = await tx.currency.findUnique({ where: { code: currency } });
  if (!currencyRow) throw errors.notFound('Currency', currency);

  return accountId(
    tx,
    currencyRow.kind === 'CRYPTO' ? ACCOUNT_CODES.crypto(currency) : ACCOUNT_CODES.cash(currency),
    branchId,
  );
}

/**
 * The counterparty account: a known customer's balance, or suspense when the
 * money belongs to a walk-in whose identity is not on file.
 */
async function counterpartyAccount(
  tx: Tx,
  currency: string,
  customerId: string | null,
  branchId: string | null,
): Promise<string> {
  return accountId(
    tx,
    customerId ? ACCOUNT_CODES.customerLiability(currency) : ACCOUNT_CODES.suspense(currency),
    branchId,
  );
}

/**
 * Builds the journal lines for a transaction. The result is always balanced
 * within each currency it touches — `postEntry` re-verifies this before writing.
 */
export async function buildJournalLines(
  tx: Tx,
  context: PostingContext,
): Promise<JournalLineInput[]> {
  const lines: JournalLineInput[] = [];
  const { type, branchId, customerId } = context;

  switch (type) {
    // --- Cash received at the counter -------------------------------------
    case 'CASH_IN':
    case 'TRANSFER_IN': {
      const cash = await fundsAccount(tx, context.fromCurrency, branchId, context.destinationAccountId);
      const counterparty =
        context.sourceAccountId ??
        (await counterpartyAccount(tx, context.fromCurrency, customerId, branchId));

      lines.push(
        { accountId: cash, debit: context.fromAmount, memo: `${context.reference} — funds in` },
        { accountId: counterparty, credit: context.fromAmount, memo: context.reference },
      );
      break;
    }

    // --- Cash paid out at the counter -------------------------------------
    case 'CASH_OUT':
    case 'TRANSFER_OUT': {
      const cash = await fundsAccount(tx, context.fromCurrency, branchId, context.sourceAccountId);
      const counterparty =
        context.destinationAccountId ??
        (await counterpartyAccount(tx, context.fromCurrency, customerId, branchId));

      lines.push(
        { accountId: counterparty, debit: context.fromAmount, memo: context.reference },
        { accountId: cash, credit: context.fromAmount, memo: `${context.reference} — funds out` },
      );
      break;
    }

    // --- Customer moves money into or out of their balance with us --------
    case 'DEPOSIT':
    case 'USDT_IN': {
      const funds = await fundsAccount(tx, context.fromCurrency, branchId, context.destinationAccountId);
      const liability = await counterpartyAccount(tx, context.fromCurrency, customerId, branchId);

      lines.push(
        { accountId: funds, debit: context.fromAmount, memo: `${context.reference} — deposit` },
        { accountId: liability, credit: context.fromAmount, memo: context.reference },
      );
      break;
    }

    case 'WITHDRAWAL':
    case 'USDT_OUT': {
      const funds = await fundsAccount(tx, context.fromCurrency, branchId, context.sourceAccountId);
      const liability = await counterpartyAccount(tx, context.fromCurrency, customerId, branchId);

      lines.push(
        { accountId: liability, debit: context.fromAmount, memo: context.reference },
        { accountId: funds, credit: context.fromAmount, memo: `${context.reference} — withdrawal` },
      );
      break;
    }

    // --- Currency exchange -------------------------------------------------
    case 'EXCHANGE': {
      if (context.fromCurrency === context.toCurrency) {
        throw errors.precondition('An exchange must involve two currencies', 'errors.sameCurrencyPair');
      }

      const receiveInto = await fundsAccount(
        tx,
        context.fromCurrency,
        branchId,
        context.destinationAccountId,
      );
      const payFrom = await fundsAccount(tx, context.toCurrency, branchId, context.sourceAccountId);

      const clearingFrom = await accountId(tx, ACCOUNT_CODES.fxPosition(context.fromCurrency), branchId);
      const clearingTo = await accountId(tx, ACCOUNT_CODES.fxPosition(context.toCurrency), branchId);

      // Leg 1 — the currency the customer hands over. Balances within `from`.
      lines.push(
        {
          accountId: receiveInto,
          debit: context.fromAmount,
          memo: `${context.reference} — received ${context.fromCurrency}`,
        },
        { accountId: clearingFrom, credit: context.fromAmount, memo: context.reference },
      );

      // Leg 2 — the currency we hand back. Balances within `to`.
      lines.push(
        { accountId: clearingTo, debit: context.toAmount, memo: context.reference },
        {
          accountId: payFrom,
          credit: context.toAmount,
          memo: `${context.reference} — paid ${context.toCurrency}`,
        },
      );
      break;
    }

    // --- Explicit internal movement ----------------------------------------
    case 'ADJUSTMENT': {
      if (!context.sourceAccountId || !context.destinationAccountId) {
        throw errors.precondition(
          'An adjustment requires an explicit source and destination account',
          'errors.adjustmentNeedsAccounts',
        );
      }

      const [source, destination] = await Promise.all([
        tx.account.findUnique({ where: { id: context.sourceAccountId } }),
        tx.account.findUnique({ where: { id: context.destinationAccountId } }),
      ]);
      if (!source) throw errors.notFound('Account', context.sourceAccountId);
      if (!destination) throw errors.notFound('Account', context.destinationAccountId);

      if (source.currencyCode !== destination.currencyCode) {
        throw errors.precondition(
          'An adjustment must stay within one currency — use an exchange to cross currencies',
          'errors.adjustmentCrossCurrency',
        );
      }

      lines.push(
        { accountId: destination.id, debit: context.fromAmount, memo: context.reference },
        { accountId: source.id, credit: context.fromAmount, memo: context.reference },
      );
      break;
    }

    default: {
      const exhaustive: never = type;
      throw errors.precondition(`Unsupported transaction type: ${String(exhaustive)}`);
    }
  }

  // --- Commission, charged on top and always income -----------------------
  if (context.feeAmount > 0n && context.feeCurrency) {
    const feeCash = await fundsAccount(tx, context.feeCurrency, branchId, null);
    const feeIncome = await accountId(tx, ACCOUNT_CODES.incomeFees(context.feeCurrency), branchId);

    lines.push(
      { accountId: feeCash, debit: context.feeAmount, memo: `${context.reference} — commission` },
      { accountId: feeIncome, credit: context.feeAmount, memo: context.reference },
    );
  }

  return lines;
}

/** Re-exported so posting code can label an entry without a second import. */
export { TRANSACTION_TYPE_META };
