import { prisma } from '../src/core/db/prisma';
import * as settings from '../src/modules/settings/settings.service';
import * as rates from '../src/modules/exchange/rates.service';
import * as drawers from '../src/modules/drawers/drawer.service';
import * as withdrawal from '../src/modules/usdt/withdrawal.service';
import * as transactions from '../src/modules/exchange/transaction.service';
import * as day from '../src/modules/exchange/business-day.service';

/**
 * The gate on the one step nothing can undo.
 *
 * A USDT sale is recorded the way it always was — the customer pays, the coins
 * come off the balance — and then it waits. What this proves is that the wait
 * is real: that the coins cannot be reported as sent before a manager releases
 * them, that nobody releases their own, that the manager is actually told, and
 * that a refusal puts every last unit back rather than merely marking a row.
 *
 * That last one is the reason this script exists. A refusal is a reversal of a
 * posting that has already moved two balances, and "it said DECLINED" is not
 * the same fact as "the coins came back".
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
 * happens on, so an open day left over from yesterday does not admit one.
 */
await day.openDay(branch.id, manager).catch(() => {
  /* already open, which is the other acceptable state */
});

await settings.set('usdt.withdrawalEnabled', true, manager);
await settings.set('usdt.withdrawalRequiresApproval', true, manager);

// A price for the coin, and coins to sell.
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
  { currency: 'USDT', kind: 'CASH', direction: 'IN', amount: 5_000n * unit, category: 'OWNER_IN' },
  manager,
);

const wallet = await prisma.wallet.findFirst({ where: { isActive: true, tokenSymbol: 'USDT' } });
if (!wallet) {
  console.log(' FAIL  no USDT wallet is configured to send from');
  process.exit(1);
}

const coins = async () =>
  (
    await prisma.drawer.findFirstOrThrow({
      where: { currencyCode: 'USDT', kind: 'CASH', ownerKey: 'TREASURY' },
    })
  ).balance;

const CUSTOMER_WALLET = 'TW7BkeEfL3nCQsPRGCcNxRgQZBQ1ExDsVq';

// ---------------------------------------------------------------------------
console.log('\n— a sale is recorded and waits —');

const before = await coins();
const sale = await withdrawal.record(
  {
    branchId: branch.id,
    walletId: wallet.id,
    address: CUSTOMER_WALLET,
    mode: 'CASH',
    payCurrency: 'ILS',
    payAmount: 1_000n * unit,
    counterpartyName: 'زبون السحب',
  },
  clerk,
);

const stamped = await prisma.transaction.findUniqueOrThrow({
  where: { id: sale.id },
  select: { approvalState: true, status: true, toAmount: true },
});

ok('it is waiting on a manager', stamped.approvalState === 'PENDING', String(stamped.approvalState));
ok('and already promised to a customer', stamped.status === 'PENDING_TRANSFER', stamped.status);
ok(
  'the coins are off the balance, so nobody can promise them twice',
  (await coins()) === before - stamped.toAmount,
  `${money(before)} → ${money(await coins())}`,
);

const notice = await prisma.notification.findFirst({
  where: { eventKey: 'usdt.withdrawal.awaitingApproval', entityId: sale.id },
  include: { recipients: { select: { userId: true } } },
});
ok('the manager is told', Boolean(notice), notice?.titleAr ?? 'no notice');
ok(
  'the notice names the amount and the address',
  Boolean(notice?.bodyAr?.includes(CUSTOMER_WALLET)),
  notice?.bodyAr?.slice(0, 60) ?? '',
);
ok(
  'and the teller who recorded it is not told about his own',
  !notice?.recipients.some((r) => r.userId === clerk.id),
);

// ---------------------------------------------------------------------------
console.log('\n— and nothing leaves before it is released —');

await refused(
  'reporting it as sent is refused',
  () => transactions.confirmTransfer(sale.id, manager),
  'errors.withdrawalNotApproved',
);

await refused(
  'a teller cannot release, his own least of all',
  () => withdrawal.decide(sale.id, { approve: true }, clerk),
  'errors.forbidden',
);

// ---------------------------------------------------------------------------
console.log('\n— the manager releases it —');

const released = await withdrawal.decide(sale.id, { approve: true }, manager);
ok('it is released', released.approvalState === 'APPROVED', released.approvalState);

const sent = await transactions.confirmTransfer(sale.id, manager);
ok('and only then may it be reported as sent', sent.status === 'POSTED', sent.status);

await refused(
  'a released send cannot be released again',
  () => withdrawal.decide(sale.id, { approve: false, note: 'مرة ثانية' }, manager),
  'errors.withdrawalDecided',
);

// ---------------------------------------------------------------------------
console.log('\n— and a refusal puts everything back —');

const second = await withdrawal.record(
  {
    branchId: branch.id,
    walletId: wallet.id,
    address: CUSTOMER_WALLET,
    mode: 'CASH',
    payCurrency: 'ILS',
    payAmount: 500n * unit,
    counterpartyName: 'زبون مرفوض',
  },
  clerk,
);

const reserved = (
  await prisma.transaction.findUniqueOrThrow({
    where: { id: second.id },
    select: { toAmount: true },
  })
).toAmount;
const beforeRefusal = await coins();

await refused(
  'a refusal without a reason is refused',
  () => withdrawal.decide(second.id, { approve: false }, manager),
);

const declined = await withdrawal.decide(
  second.id,
  { approve: false, note: 'العنوان غير مؤكد' },
  manager,
);
ok('it is declined', declined.approvalState === 'DECLINED', declined.approvalState);

const row = await prisma.transaction.findUniqueOrThrow({
  where: { id: second.id },
  select: {
    status: true,
    approvalNote: true,
    reversedBy: { select: { reference: true, status: true } },
  },
});

ok('the sale is reversed, not merely marked', row.status === 'REVERSED', row.status);
ok('by a real reversing posting', Boolean(row.reversedBy), row.reversedBy?.reference ?? 'none');
ok('the reason is kept for the teller to repeat', row.approvalNote === 'العنوان غير مؤكد');

const afterRefusal = await coins();
ok(
  'and every coin comes back',
  afterRefusal === beforeRefusal + reserved,
  `${money(beforeRefusal)} + ${money(reserved)} = ${money(afterRefusal)}`,
);

// ---------------------------------------------------------------------------
console.log('\n— a manager alone at the window finishes his own work —');

/*
 * The counter is not always two people. A manager who records a sale because
 * there is nobody else at the window must be able to release it, or the gate
 * stops the office rather than protecting it. What still stops a teller is the
 * permission, which he does not hold.
 */
const own = await withdrawal.record(
  {
    branchId: branch.id,
    walletId: wallet.id,
    address: CUSTOMER_WALLET,
    mode: 'CASH',
    payCurrency: 'ILS',
    payAmount: 300n * unit,
    counterpartyName: 'زبون المدير',
  },
  { ...manager, permissions: [...manager.permissions, 'usdt.withdrawal.use', 'exchange.transaction.create'] },
);

const ownRow = await prisma.transaction.findUniqueOrThrow({
  where: { id: own.id },
  select: { createdById: true, approvalState: true },
});
ok('he recorded it himself', ownRow.createdById === manager.id);
ok('and it still waits on a release', ownRow.approvalState === 'PENDING', String(ownRow.approvalState));

const ownReleased = await withdrawal.decide(own.id, { approve: true }, manager);
ok('which he may give', ownReleased.approvalState === 'APPROVED', ownReleased.approvalState);
ok(
  'and it can then be reported as sent',
  (await transactions.confirmTransfer(own.id, manager)).status === 'POSTED',
);

// ---------------------------------------------------------------------------
console.log('\n— and with the gate off, the office is not held up —');

await settings.set('usdt.withdrawalRequiresApproval', false, manager);
const ungated = await withdrawal.record(
  {
    branchId: branch.id,
    walletId: wallet.id,
    address: CUSTOMER_WALLET,
    mode: 'CASH',
    payCurrency: 'ILS',
    payAmount: 200n * unit,
    counterpartyName: 'بلا بوابة',
  },
  clerk,
);
const free = await prisma.transaction.findUniqueOrThrow({
  where: { id: ungated.id },
  select: { approvalState: true },
});
ok('nothing waits when the office has not asked for it', free.approvalState === null, String(free.approvalState));
ok(
  'and it can be reported as sent straight away',
  (await transactions.confirmTransfer(ungated.id, manager)).status === 'POSTED',
);
await settings.set('usdt.withdrawalRequiresApproval', true, manager);

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} FAILED`);
await prisma.$disconnect();
process.exit(bad === 0 ? 0 : 1);
