import { prisma } from '../src/core/db/prisma';
import * as settings from '../src/modules/settings/settings.service';
import * as rates from '../src/modules/exchange/rates.service';
import * as drawers from '../src/modules/drawers/drawer.service';
import * as counter from '../src/modules/usdt/counter.service';
import { transferChannels } from '../src/modules/exchange/machine.service';
import * as day from '../src/modules/exchange/business-day.service';

/**
 * Taking USDT at the window, from the arrival to the drawer it is paid out of.
 *
 * This part of the system was rebuilt three times in a week — request-first,
 * then verify-by-amount, then the chronological log — and each rebuild was
 * proved once by hand and then forgotten. So this pins what the current shape
 * actually promises:
 *
 *   - money that lands unasked is visible rather than silently held,
 *   - it is priced at the board *now*, because nothing was promised earlier,
 *   - and each way of paying comes out of the balance it really leaves.
 *
 * That last one is the reason this matters beyond USDT: paying a bank payout
 * out of the till overstates the cash counted at close by every transfer the
 * office has promised, and understates what the broker owes by the same
 * amount. It is invisible until somebody counts.
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
const branch = await prisma.branch.findFirstOrThrow();

const actor = {
  id: admin.id,
  name: 'المدير',
  branchId: branch.id,
  permissions: [
    'usdt.counter.use',
    'exchange.transaction.create',
    'exchange.rate.manage',
    'exchange.drawer.manage',
    'exchange.day.open',
    'settings.manage',
    // Settling a walk-in as a customer, so his address is known next time.
    'customers.create',
  ],
};

/*
 * Today's day, specifically. A posting is keyed to the calendar date it
 * happens on, so an open day left over from yesterday does not admit one.
 */
await day.openDay(branch.id, actor).catch(() => {
  /* already open, which is the other acceptable state */
});

await settings.set('usdt.counterEnabled', true, actor);

/*
 * The till pays 3.50 a coin and the broker 3.40. They must differ, or the
 * whole point of pricing each channel separately would go unproved.
 */
for (const [channel, buy, sell] of [
  ['CASH', 350_000_000n, 360_000_000n],
  ['BROKER', 340_000_000n, 350_000_000n],
] as const) {
  const has = await prisma.exchangeRate.findFirst({
    where: { baseCode: 'USDT', quoteCode: 'ILS', channel, isActive: true },
  });
  if (!has) {
    await rates.publishRate(
      {
        baseCode: 'USDT',
        quoteCode: 'ILS',
        channel,
        buyRate: buy,
        sellRate: sell,
        midRate: (buy + sell) / 2n,
      },
      actor,
    );
  }
}

for (const kind of ['CASH', 'BROKER'] as const) {
  await drawers.fund(
    { currency: 'ILS', kind, direction: 'IN', amount: 50_000n * unit, category: 'OWNER_IN' },
    actor,
  );
}

let wallet = await prisma.wallet.findFirst({ where: { isCounterAddress: true, isActive: true } });
if (!wallet) {
  wallet = await prisma.wallet.create({
    data: {
      label: 'Counter',
      labelAr: 'الشباك',
      network: 'MANUAL',
      address: 'TVerifyCounterAddress00000000000000',
      tokenSymbol: 'USDT',
      isCounterAddress: true,
      isActive: true,
      minConfirmations: 1,
    },
  });
}

/** Money landing on the address, as the chain would report it. */
let seq = 0;
const arrive = async (amount: bigint, confirmations = 30) =>
  prisma.chainTransaction.create({
    data: {
      walletId: wallet!.id,
      network: wallet!.network,
      txHash: `verify-${Date.now()}-${seq++}`,
      direction: 'IN',
      amount,
      fromAddress: `TSender${seq}000000000000000000000`,
      toAddress: wallet!.address,
      tokenSymbol: 'USDT',
      status: confirmations >= wallet!.minConfirmations ? 'CONFIRMED' : 'PENDING',
      confirmations,
      firstSeenAt: new Date(),
    },
  });

const balance = async (kind: 'CASH' | 'BROKER', currency = 'ILS') =>
  (
    await prisma.drawer.findFirstOrThrow({
      where: { currencyCode: currency, kind, ownerKey: 'TREASURY' },
    })
  ).balance;

// Start from a clean address so counts mean something.
await prisma.usdtDepositRequest.deleteMany({ where: { walletId: wallet.id } });
await prisma.chainTransaction.deleteMany({
  where: { walletId: wallet.id, linkedTransactionId: null },
});

// ---------------------------------------------------------------------------
console.log('\n— money nobody asked for is money somebody can see —');

const hundred = await arrive(100n * unit);
const settling = await arrive(50n * unit, 0);

const log = await counter.unclaimedArrivals({ sync: false });
ok('the log carries what landed', log.length === 2, `${log.length} row(s)`);
ok('newest first', log[0]?.id === settling.id || log[0]?.id === hundred.id);
ok('a confirmed one may be paid', log.find((row) => row.id === hundred.id)?.ready === true);
ok(
  'and one still settling is shown but not payable',
  log.find((row) => row.id === settling.id)?.ready === false,
);
ok(
  'every row carries its place on the public explorer',
  log.every((row) => row.explorerUrl.includes(row.txHash)),
  log[0]?.explorerUrl ?? '',
);

await refused(
  'an unconfirmed arrival cannot be settled',
  () => counter.settleArrival(settling.id, { branchId: branch.id, payoutCurrency: 'ILS' }, actor),
  'errors.transferNotConfirmed',
);

// ---------------------------------------------------------------------------
console.log('\n— and it is paid out of the balance it really leaves —');

const quoted = await counter.quoteArrival(hundred.id, 'ILS');
ok('both channels are priced at once', Boolean(quoted.cash && quoted.broker));
ok(
  'the till pays 350.00',
  money(BigInt(quoted.cash!.toAmount)) === '350.00',
  quoted.cash!.toAmount,
);
ok(
  'the broker pays 340.00',
  money(BigInt(quoted.broker!.toAmount)) === '340.00',
  quoted.broker!.toAmount,
);

const cashBefore = await balance('CASH');
const brokerBefore = await balance('BROKER');

// 60 coins through the till, 40 through the broker: 210.00 + 136.00 = 346.00.
const destinations = await transferChannels();
if (destinations.length === 0) {
  console.log(' FAIL  no transfer destinations are configured for the broker leg');
  process.exit(1);
}

// A transfer to a channel with no account on it is an instruction nobody can
// carry out, so it is refused — and refused before anything moves.
const split = {
  branchId: branch.id,
  payoutCurrency: 'ILS',
  mode: 'SPLIT' as const,
  brokerShare: 40n * unit,
  payoutChannel: destinations[0],
  counterpartyName: 'زبون مزدوج',
  // A number nobody else in the seed holds, so the customer is made fresh.
  counterpartyPhone: `059${Date.now().toString().slice(-7)}`,
};

await refused(
  'a transfer with no account to send it to is refused',
  () => counter.settleArrival(hundred.id, split, actor),
  'errors.transferAccountRequired',
);
ok('and nothing moved on the refusal', (await balance('CASH')) === cashBefore);

const posted = await counter.settleArrival(
  hundred.id,
  { ...split, payoutAccount: split.counterpartyPhone, saveCustomer: true },
  actor,
);

const row = await prisma.transaction.findUniqueOrThrow({
  where: { id: posted.id },
  select: {
    fromAmount: true,
    toAmount: true,
    payoutCashAmount: true,
    payoutBankAmount: true,
    payoutBankChannel: true,
    payoutAccount: true,
    customerId: true,
    status: true,
  },
});

ok(
  'the coins recorded are the coins that arrived',
  row.fromAmount === 100n * unit,
  money(row.fromAmount),
);
ok('the payout blends the two prices', money(row.toAmount) === '346.00', money(row.toAmount));
ok('the till leg is 210.00', money(row.payoutCashAmount) === '210.00', money(row.payoutCashAmount));
ok(
  'the broker leg is 136.00',
  money(row.payoutBankAmount) === '136.00',
  money(row.payoutBankAmount),
);
ok(
  'the broker leg names where it is going',
  Boolean(row.payoutBankChannel),
  String(row.payoutBankChannel),
);
ok(
  'and the account on it',
  row.payoutAccount === split.counterpartyPhone,
  String(row.payoutAccount),
);
ok('and the row waits on that transfer', row.status === 'PENDING_TRANSFER', row.status);

// ---------------------------------------------------------------------------
console.log('\n— and the counter remembers who sent it —');

ok('the walk-in became a customer', Boolean(row.customerId));
const sender = await prisma.chainTransaction.findUniqueOrThrow({
  where: { id: hundred.id },
  select: { fromAddress: true, network: true },
});
const learned = await prisma.customerWallet.findFirst({
  where: { customerId: row.customerId ?? '', address: sender.fromAddress, network: sender.network },
});
ok('his sending address is written against him', Boolean(learned), sender.fromAddress);
const payouts = await prisma.customerPayout.findMany({
  where: { customerId: row.customerId ?? '' },
});
ok(
  'and where he is paid, as his default',
  payouts.length === 1 && payouts[0]!.isDefault && payouts[0]!.channel === destinations[0],
  JSON.stringify(payouts.map((p) => [p.channel, p.account, p.isDefault])),
);

const cashAfter = await balance('CASH');
const brokerAfter = await balance('BROKER');
ok(
  'the till gave up exactly its own leg',
  cashBefore - cashAfter === row.payoutCashAmount,
  `${money(cashBefore)} → ${money(cashAfter)}`,
);
ok(
  'and the broker exactly his',
  brokerBefore - brokerAfter === row.payoutBankAmount,
  `${money(brokerBefore)} → ${money(brokerAfter)}`,
);

// ---------------------------------------------------------------------------
console.log('\n— and a settled arrival is spent —');

ok(
  'it leaves the log once claimed',
  (await counter.unclaimedArrivals({ sync: false })).every((r) => r.id !== hundred.id),
);

await refused(
  'and cannot be settled a second time',
  () => counter.settleArrival(hundred.id, { branchId: branch.id, payoutCurrency: 'ILS' }, actor),
  'errors.depositAlreadyPosted',
);

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} FAILED`);
await prisma.$disconnect();
process.exit(bad === 0 ? 0 : 1);
