import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { env } from '@/core/config/env';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import * as settings from '@/modules/settings/settings.service';
import * as audit from '@/modules/audit/audit.service';
import * as notifications from '@/modules/notifications/notifications.service';
import type { Actor } from '@/modules/exchange/transaction.service';
import { addressOf, encodeTransfer, parsePrivateKey, signTxId } from './tron-signer';
import { fromTokenUnits, toTokenUnits, USDT_DECIMALS } from './providers/types';

/**
 * Putting a transfer on the chain, once a manager has released it.
 *
 * ## What this changes about the system
 *
 * Everything before this file records money. This one *holds* it: the key that
 * moves the office's coins lives in the environment this process reads. That is
 * a different kind of program, and the guards below are what make it a
 * defensible one rather than a convenience with a hole in it.
 *
 * ## The five things that must all be true
 *
 * A key is configured; the office has turned sending on; the wallet the sale
 * names is the hot wallet that key opens; the amount is inside the per-transfer
 * ceiling; and the day's sends so far plus this one are inside the daily one.
 * Any of them false and this refuses and the office sends by hand, exactly as
 * it did before.
 *
 * The ceilings are the point. A key on a server is a key somebody may one day
 * hold; ceilings decide what that is worth to them. They are read fresh on
 * every send rather than cached, so lowering one takes effect on the next
 * transfer rather than the next restart.
 *
 * ## Why the hash is written before anything else
 *
 * A broadcast cannot be undone and cannot be asked about reliably in the
 * seconds after it. So the moment the node accepts it, the hash goes on the
 * transaction — before the status, before the notice, before anything that
 * could fail and leave the office having sent coins it has no record of
 * sending. A row with a hash and a stale status is a bookkeeping problem; a
 * transfer with no hash anywhere is lost money.
 */

const log = createLogger('usdt:broadcast');

/** TRON's own units: the contract counts in millionths. */
const TOKEN_DECIMALS = USDT_DECIMALS;

export interface HotWallet {
  /** The address the configured key controls. */
  address: string;
  key: Uint8Array;
}

/**
 * The wallet the program can actually sign for, or nothing.
 *
 * Derived from the key rather than configured beside it. A key pasted one
 * character short still parses and still produces an address — of an account
 * nobody has ever funded — and the first anybody would know is a transfer that
 * never arrives. Deriving means the address and the key cannot disagree.
 */
export function hotWallet(): HotWallet | null {
  if (!env.TRON_HOT_WALLET_KEY) return null;
  const key = parsePrivateKey(env.TRON_HOT_WALLET_KEY);
  return { key, address: addressOf(key) };
}

export interface SendingLimits {
  enabled: boolean;
  perTransfer: bigint;
  perDay: bigint;
}

export async function limits(db: DbClient = prisma): Promise<SendingLimits> {
  const [enabled, perTransfer, perDay] = await Promise.all([
    settings.getBoolean('usdt.autoSendEnabled', db),
    settings.getMoney('usdt.autoSendMaxPerTransfer', db),
    settings.getMoney('usdt.autoSendMaxPerDay', db),
  ]);
  return { enabled, perTransfer, perDay };
}

/** What the program has already sent today, by its own record of doing so. */
export async function sentToday(db: DbClient = prisma): Promise<bigint> {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);

  const rows = await db.transaction.findMany({
    where: {
      type: 'USDT_SEND',
      status: { not: 'REVERSED' },
      chainTransaction: { isNot: null },
      transferConfirmedAt: { gte: midnight },
    },
    select: { toAmount: true },
  });

  return rows.reduce((total, row) => total + row.toAmount, 0n);
}

export interface Readiness {
  /** Whether a send would be attempted at all. */
  ready: boolean;
  /** The address the program signs for, when it can sign. */
  address: string | null;
  limits: SendingLimits;
  sentToday: bigint;
}

/** Everything the settings screen needs to say what the program will do. */
export async function readiness(db: DbClient = prisma): Promise<Readiness> {
  const wallet = hotWallet();
  const configured = await limits(db);
  return {
    ready: Boolean(wallet) && configured.enabled,
    address: wallet?.address ?? null,
    limits: configured,
    sentToday: await sentToday(db),
  };
}

interface BuiltTransaction {
  txID?: string;
  raw_data?: unknown;
  raw_data_hex?: string;
  result?: { result?: boolean; message?: string };
  Error?: string;
}

/** One call to the node, with a deadline and no swallowed failures. */
async function callNode<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${env.TRON_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': env.TRON_API_KEY } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw errors.external(`TronGrid answered ${response.status}`);
  }
  return (await response.json()) as T;
}

export interface SendResult {
  txHash: string;
  amount: bigint;
  to: string;
  from: string;
}

/**
 * Sends the coins a released sale promised.
 *
 * The transaction is built by the node — it knows the current block reference
 * and the fee limit — signed here, and handed back. Only the signature is ours,
 * which is the only part that has to be.
 */
export async function send(transactionId: string, actor: Actor, db: DbClient = prisma) {
  const wallet = hotWallet();
  if (!wallet) {
    throw errors.precondition('No sending wallet is configured', 'errors.noHotWallet');
  }

  const configured = await limits(db);
  if (!configured.enabled) {
    throw errors.precondition('Automatic sending is switched off', 'errors.autoSendDisabled');
  }

  const row = await db.transaction.findUnique({
    where: { id: transactionId },
    select: {
      id: true,
      reference: true,
      type: true,
      status: true,
      approvalState: true,
      toAmount: true,
      payoutAddress: true,
      chainTransaction: { select: { id: true, txHash: true } },
      payoutWallet: { select: { address: true, network: true, tokenSymbol: true } },
    },
  });

  if (!row) throw errors.notFound('Transaction', transactionId);
  if (row.type !== 'USDT_SEND') {
    throw errors.precondition('Only a USDT sale is sent this way', 'errors.notAWithdrawal');
  }
  if (row.status !== 'PENDING_TRANSFER') {
    throw errors.conflict('This sale is not waiting on a transfer', 'errors.notPendingTransfer');
  }
  if (row.approvalState === 'PENDING') {
    throw errors.precondition(
      'A manager has not released this send yet',
      'errors.withdrawalNotApproved',
    );
  }
  if (row.chainTransaction) {
    throw errors.conflict('This sale has already been sent', 'errors.alreadyBroadcast');
  }
  if (!row.payoutAddress) {
    throw errors.precondition('This sale has no destination address', 'errors.invalidAddress');
  }

  /*
   * The sale must be leaving the wallet this key opens. Signing for one address
   * a transfer recorded against another would move coins the books say are
   * somewhere else — and it is the kind of mismatch that only shows up when
   * somebody reconciles a wallet weeks later.
   */
  if (row.payoutWallet?.address !== wallet.address) {
    throw errors.precondition(
      'That sale leaves a wallet this program cannot sign for',
      'errors.notTheHotWallet',
      { expected: wallet.address },
    );
  }
  if (row.payoutWallet.network !== 'TRON') {
    throw errors.precondition('Only TRON transfers can be sent automatically', 'errors.notTron');
  }

  if (configured.perTransfer > 0n && row.toAmount > configured.perTransfer) {
    throw errors.precondition(
      `Automatic sending stops at ${toDecimalString(configured.perTransfer, 2)} in one transfer`,
      'errors.autoSendOverTransfer',
      { maximum: toDecimalString(configured.perTransfer, 2) },
    );
  }

  if (configured.perDay > 0n) {
    const already = await sentToday(db);
    if (already + row.toAmount > configured.perDay) {
      throw errors.precondition(
        `Automatic sending stops at ${toDecimalString(configured.perDay, 2)} a day, and ${toDecimalString(already, 2)} has gone already`,
        'errors.autoSendOverDay',
        {
          maximum: toDecimalString(configured.perDay, 2),
          already: toDecimalString(already, 2),
        },
      );
    }
  }

  // --- Build, sign, broadcast ------------------------------------------------
  const units = toTokenUnits(row.toAmount, TOKEN_DECIMALS);
  const built = await callNode<BuiltTransaction>('/wallet/triggersmartcontract', {
    owner_address: wallet.address,
    contract_address: env.TRON_USDT_CONTRACT,
    function_selector: 'transfer(address,uint256)',
    parameter: encodeTransfer(row.payoutAddress, units).slice(8),
    fee_limit: 100_000_000, // 100 TRX, the usual ceiling for a TRC-20 transfer
    call_value: 0,
    visible: true,
  });

  if (!built.txID || built.result?.result !== true) {
    log.error('The node refused to build the transfer', {
      reference: row.reference,
      message: built.result?.message ?? built.Error,
    });
    throw errors.external('TronGrid would not build the transfer');
  }

  const signature = signTxId(built.txID, wallet.key);

  const broadcast = await callNode<{ result?: boolean; code?: string; message?: string; txid?: string }>(
    '/wallet/broadcasttransaction',
    { ...built, signature: [signature] },
  );

  if (broadcast.result !== true) {
    log.error('The node refused to broadcast', {
      reference: row.reference,
      code: broadcast.code,
      message: broadcast.message,
    });
    throw errors.external(`TronGrid refused the transfer: ${broadcast.code ?? 'unknown'}`);
  }

  const txHash = built.txID;

  /*
   * On the record before anything else. The coins are gone the instant the
   * node accepted this, and every line after here is bookkeeping that can be
   * repaired — but only if the hash was written first.
   */
  // The link lives on the chain row, which points at the posting. There is no
  // column the other way round, and adding one would give the same fact two
  // homes that could disagree.
  await db.chainTransaction.create({
    data: {
      walletId: (await db.wallet.findFirstOrThrow({ where: { address: wallet.address } })).id,
      network: 'TRON',
      txHash,
      direction: 'OUT',
      amount: row.toAmount,
      fromAddress: wallet.address,
      toAddress: row.payoutAddress,
      tokenSymbol: row.payoutWallet.tokenSymbol,
      status: 'PENDING',
      confirmations: 0,
      linkedTransactionId: row.id,
      isReconciled: true,
      processedAt: new Date(),
    },
  });

  await db.transaction.update({
    where: { id: row.id },
    data: {
      status: 'POSTED',
      transferConfirmedAt: new Date(),
      transferConfirmedById: actor.id,
    },
  });

  await audit.record(
    {
      action: 'POST',
      module: 'usdt',
      entityType: 'Transaction',
      entityId: row.id,
      summaryEn: `Sent ${toDecimalString(row.toAmount, 2)} USDT for ${row.reference} to ${row.payoutAddress}: ${txHash}`,
      summaryAr: `أُرسل ${toDecimalString(row.toAmount, 2)} USDT للعملية ${row.reference} إلى ${row.payoutAddress}: ${txHash}`,
      actor,
      after: { txHash, amount: row.toAmount.toString() },
    },
    db,
  );

  await notifications
    .notify(
      {
        severity: 'SUCCESS',
        eventKey: 'usdt.withdrawal.sent',
        module: 'usdt',
        titleEn: 'USDT was sent',
        titleAr: 'أُرسلت العملة',
        bodyEn: `${row.reference}: ${toDecimalString(row.toAmount, 2)} USDT is on the chain.`,
        bodyAr: `${row.reference}: ${toDecimalString(row.toAmount, 2)} USDT على السلسلة الآن.`,
        entityType: 'Transaction',
        entityId: row.id,
        link: `/manage/transactions/${row.id}`,
        createdById: actor.id,
      },
      { permission: 'usdt.withdrawal.approve' },
      db,
    )
    .catch((error) => log.warn('Sent notice failed', { id: row.id, error }));

  log.info('USDT sent', {
    reference: row.reference,
    amount: fromTokenUnits(units, TOKEN_DECIMALS).toString(),
    txHash,
  });

  return { txHash, amount: row.toAmount, to: row.payoutAddress, from: wallet.address } satisfies SendResult;
}
