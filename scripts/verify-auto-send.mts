import { prisma } from '../src/core/db/prisma';
import * as settings from '../src/modules/settings/settings.service';
import * as rates from '../src/modules/exchange/rates.service';
import * as drawers from '../src/modules/drawers/drawer.service';
import * as withdrawal from '../src/modules/usdt/withdrawal.service';
import * as broadcast from '../src/modules/usdt/broadcast.service';
import * as day from '../src/modules/exchange/business-day.service';
import { addressOf, parsePrivateKey } from '../src/modules/usdt/tron-signer';

/**
 * The guards around the key that moves the office's coins.
 *
 * ## What this proves, and what it cannot
 *
 * It proves every refusal: no key, switched off, over the per-transfer
 * ceiling, over the day's, a wallet the key does not open, a sale no manager
 * released, and one already sent. Each of those is a line between a key on a
 * server and a loss, and each is checked here without a network in sight.
 *
 * It does **not** prove that a real transfer reaches the chain. That needs a
 * funded key and a live node, and no test that runs on every push should have
 * either. The bytes it would sign are pinned separately in
 * `tests/tron-signer.test.ts` against the public USDT contract; what remains
 * unproven until somebody sends a small amount on Shasta is the round trip
 * through TronGrid itself.
 *
 * The distinction matters: everything here is the reason a stolen key is worth
 * a bounded amount, and none of it is the reason a transfer arrives.
 */

const unit = 100000000n;
const money = (v: bigint) => (Number(v) / 1e8).toFixed(2);

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
const teller = await prisma.user.findFirstOrThrow({ where: { username: 'teller' } });
const branch = await prisma.branch.findFirstOrThrow();

const manager = {
  id: admin.id,
  name: 'المدير',
  branchId: branch.id,
  permissions: [
    'usdt.withdrawal.approve',
    'exchange.transaction.reverse',
    'exchange.transfer.confirm',
    'exchange.rate.manage',
    'exchange.drawer.manage',
    'exchange.day.open',
    'settings.manage',
  ],
};
const clerk = {
  id: teller.id,
  name: 'التلر',
  branchId: branch.id,
  permissions: ['usdt.withdrawal.use', 'exchange.transaction.create'],
};

/*
 * Today's day, specifically. A posting is keyed to the calendar date it
 * happens on, so an open day left over from yesterday does not admit one —
 * and asking "is any day open" is how these scripts used to fail at midnight.
 */
await day.openDay(branch.id, manager).catch(() => {
  /* already open, which is the other acceptable state */
});

await settings.set('usdt.withdrawalEnabled', true, manager);
await settings.set('usdt.withdrawalRequiresApproval', true, manager);

const priced = await prisma.exchangeRate.findFirst({
  where: { baseCode: 'ILS', quoteCode: 'USDT', channel: 'CASH', isActive: true },
});
if (!priced) {
  await rates.publishRate(
    {
      baseCode: 'ILS',
      quoteCode: 'USDT',
      channel: 'CASH',
      buyRate: 27_000_000n,
      sellRate: 28_000_000n,
      midRate: 27_500_000n,
    },
    manager,
  );
}
await drawers.fund(
  { currency: 'USDT', kind: 'CASH', direction: 'IN', amount: 20_000n * unit, category: 'OWNER_IN' },
  manager,
);

const CUSTOMER = 'TW7BkeEfL3nCQsPRGCcNxRgQZBQ1ExDsVq';

/** A sale, released or not, to point the guards at. */
const sell = async (payIls: bigint, walletId: string) =>
  withdrawal.record(
    {
      branchId: branch.id,
      walletId,
      address: CUSTOMER,
      mode: 'CASH',
      payCurrency: 'ILS',
      payAmount: payIls,
      counterpartyName: 'زبون',
    },
    clerk,
  );

// ---------------------------------------------------------------------------
console.log('\n— with no key on the server, the program cannot send at all —');

const configuredKey = process.env.TRON_HOT_WALLET_KEY ?? '';
const wallet = broadcast.hotWallet();

ok(
  'the wallet is derived from the key rather than trusted beside it',
  configuredKey ? wallet?.address === addressOf(parsePrivateKey(configuredKey)) : wallet === null,
  wallet?.address ?? 'no key configured',
);

/*
 * The sales below must leave the wallet the key opens, or the guard that
 * checks exactly that would fire first and every ceiling below it would go
 * unexercised — passing for the wrong reason, which is worse than failing.
 */
const someWallet = wallet
  ? ((await prisma.wallet.findFirst({ where: { address: wallet.address } })) ??
    (await prisma.wallet.create({
      data: {
        label: 'Hot',
        labelAr: 'الساخنة',
        network: 'TRON',
        address: wallet.address,
        tokenSymbol: 'USDT',
        isActive: true,
        minConfirmations: 1,
      },
    })))
  : ((await prisma.wallet.findFirst({ where: { isActive: true, tokenSymbol: 'USDT' } })) ??
    (await prisma.wallet.create({
      data: {
        label: 'Sending',
        labelAr: 'الإرسال',
        network: 'TRON',
        address: 'TVerifyAutoSendWallet00000000000000',
        tokenSymbol: 'USDT',
        isActive: true,
        minConfirmations: 1,
      },
    })));

if (!wallet) {
  const sale = await sell(500n * unit, someWallet.id);
  await refused(
    'a send is refused outright',
    () => broadcast.send(sale.id, manager),
    'errors.noHotWallet',
  );

  const released = await withdrawal.decide(sale.id, { approve: true }, manager);
  ok(
    'and releasing still works — it simply waits for a person',
    released.approvalState === 'APPROVED' && released.txHash === null,
    String(released.txHash),
  );
}

// ---------------------------------------------------------------------------
console.log('\n— and the ceilings hold before anything is signed —');

await settings.set('usdt.autoSendEnabled', false, manager);
const offSale = await sell(300n * unit, someWallet.id);
await refused(
  'with sending switched off, nothing goes',
  () => broadcast.send(offSale.id, manager),
  wallet ? 'errors.autoSendDisabled' : 'errors.noHotWallet',
);

/*
 * The ceilings are set low *before* the sale is released, so the send that a
 * release attempts is refused by the ceiling itself and never reaches the
 * network. That keeps this script offline — and it is also the order that
 * exercises the guard rather than tripping over the approval check first,
 * which is how an earlier version of this file passed without testing
 * anything at all.
 */
await settings.set('usdt.autoSendEnabled', true, manager);
await settings.set('usdt.autoSendMaxPerTransfer', '1', manager);
await settings.set('usdt.autoSendMaxPerDay', '100000', manager);

const bigSale = await sell(1_000n * unit, someWallet.id);
await withdrawal.decide(bigSale.id, { approve: true }, manager);

await refused(
  'a transfer above its own ceiling is refused',
  () => broadcast.send(bigSale.id, manager),
  wallet ? 'errors.autoSendOverTransfer' : 'errors.noHotWallet',
);

await settings.set('usdt.autoSendMaxPerTransfer', '100000', manager);
await settings.set('usdt.autoSendMaxPerDay', '1', manager);
await refused(
  'and one that would break the day’s total is refused',
  () => broadcast.send(bigSale.id, manager),
  wallet ? 'errors.autoSendOverDay' : 'errors.noHotWallet',
);

await settings.set('usdt.autoSendMaxPerDay', '100000', manager);

// ---------------------------------------------------------------------------
console.log('\n— and a sale nobody released is not sent —');

const unreleased = await sell(200n * unit, someWallet.id);
await refused(
  'an unreleased sale is refused',
  () => broadcast.send(unreleased.id, manager),
  wallet ? 'errors.withdrawalNotApproved' : 'errors.noHotWallet',
);

// ---------------------------------------------------------------------------
console.log('\n— and the office is told what the program will do —');

const state = await broadcast.readiness();
console.log(
  '   readiness:',
  JSON.stringify({
    ready: state.ready,
    address: state.address,
    perTransfer: money(state.limits.perTransfer),
    perDay: money(state.limits.perDay),
    sentToday: money(state.sentToday),
  }),
);
ok('readiness answers without a network', typeof state.ready === 'boolean');
ok(
  'and admits it cannot send when there is no key',
  wallet ? true : state.ready === false,
  String(state.ready),
);

console.log(
  wallet
    ? '\n   NOTE: a key is configured, so a real broadcast was NOT attempted here on purpose.'
    : '\n   NOTE: no key is configured, which is the safe default and what CI runs with.',
);

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} FAILED`);
await prisma.$disconnect();
process.exit(bad === 0 ? 0 : 1);
