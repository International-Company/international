import { prisma } from '../src/core/db/prisma';
import { randomBytes } from 'node:crypto';
import * as wallets from '../src/modules/usdt/wallet.service';
import { addressOf } from '../src/modules/usdt/tron-signer';

/**
 * Which addresses can be let go of, and which cannot.
 *
 * The rule the office needs is not "never delete anything that has a row
 * against it" — that keeps a test address on the screen forever. It is
 * "never delete the evidence behind money that moved."
 *
 * So this pins the line: a clean address goes, an address littered with
 * arrivals nobody claimed goes and takes them with it, and an address behind a
 * posting or a promise stays and says why.
 */

let bad = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) bad++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ' — ' + extra : ''}`);
};
const refused = async (label: string, run: () => Promise<unknown>, expectKey?: string) => {
  try {
    await run();
    ok(label, false, 'it went through');
  } catch (error) {
    const key = (error as { messageKey?: string }).messageKey;
    ok(label, expectKey ? key === expectKey : true, key ?? String(error));
  }
};

const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
const branch = await prisma.branch.findFirstOrThrow();
const actor = { id: admin.id, name: 'المدير' };

let seq = 0;
const makeWallet = async (label: string) =>
  wallets.createWallet(
    {
      label,
      labelAr: label,
      network: 'TRON',
      // A real address, derived from a throwaway key: the provider validates
      // the checksum, and an invented string does not survive it.
      address: addressOf(new Uint8Array(randomBytes(32))),
      tokenSymbol: 'USDT',
      minConfirmations: 1,
    },
    actor,
  );

const arrival = async (walletId: string, linkedTransactionId: string | null) =>
  prisma.chainTransaction.create({
    data: {
      walletId,
      network: 'TRON',
      txHash: `removal-${Date.now()}-${seq++}`,
      direction: 'IN',
      amount: 10n * 100_000_000n,
      fromAddress: 'TSomebody00000000000000000000000000',
      toAddress: 'TSomewhere0000000000000000000000000',
      tokenSymbol: 'USDT',
      status: 'CONFIRMED',
      confirmations: 20,
      firstSeenAt: new Date(),
      linkedTransactionId,
    },
  });

// ---------------------------------------------------------------------------
console.log('\n— an address nobody used goes —');

const clean = await makeWallet('Clean');
await wallets.deleteWallet(clean.id, actor);
ok(
  'it is gone',
  (await prisma.wallet.findUnique({ where: { id: clean.id } })) === null,
);

// ---------------------------------------------------------------------------
console.log('\n— and one littered with unclaimed arrivals goes with them —');

const littered = await makeWallet('Littered');
await arrival(littered.id, null);
await arrival(littered.id, null);
const before = await prisma.chainTransaction.count({ where: { walletId: littered.id } });
ok('it has arrivals against it', before === 2, String(before));

await wallets.deleteWallet(littered.id, actor);
ok('the address is gone', (await prisma.wallet.findUnique({ where: { id: littered.id } })) === null);
ok(
  'and the arrivals nobody claimed went with it',
  (await prisma.chainTransaction.count({ where: { walletId: littered.id } })) === 0,
);

// ---------------------------------------------------------------------------
console.log('\n— but one behind money that moved stays —');

/*
 * A posting, and a transfer that is its evidence. Deleting the address would
 * cascade the transfer away and leave a receipt the office handed over with
 * nothing behind it.
 */
const posted = await makeWallet('Evidence');
const posting = await prisma.transaction.findFirst({
  where: { status: 'POSTED' },
  select: { id: true },
});

if (posting) {
  await arrival(posted.id, posting.id);
  await refused(
    'it refuses, and says the evidence is the reason',
    () => wallets.deleteWallet(posted.id, actor),
    'errors.walletHasHistory',
  );
  ok(
    'and it is still there to explain the posting',
    (await prisma.wallet.findUnique({ where: { id: posted.id } })) !== null,
  );
} else {
  console.log('   (skipped: this database has no posted transaction to stand behind)');
  await prisma.wallet.delete({ where: { id: posted.id } });
}

// ---------------------------------------------------------------------------
console.log('\n— and one with a sale still waiting to be sent stays —');

const owing = await makeWallet('Owing');
const waiting = await prisma.transaction.findFirst({
  where: { type: 'USDT_SEND', status: 'PENDING_TRANSFER' },
  select: { id: true, payoutWalletId: true },
});

if (waiting) {
  await prisma.transaction.update({
    where: { id: waiting.id },
    data: { payoutWalletId: owing.id },
  });
  await refused(
    'it refuses while coins are still promised from it',
    () => wallets.deleteWallet(owing.id, actor),
    'errors.walletHasPending',
  );
  // Put it back so this script leaves the database as it found it.
  await prisma.transaction.update({
    where: { id: waiting.id },
    data: { payoutWalletId: waiting.payoutWalletId },
  });
  await prisma.wallet.delete({ where: { id: owing.id } });
} else {
  console.log('   (skipped: nothing is waiting to be sent in this database)');
  await prisma.wallet.delete({ where: { id: owing.id } });
}

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} FAILED`);
await prisma.$disconnect();
process.exit(bad === 0 ? 0 : 1);
