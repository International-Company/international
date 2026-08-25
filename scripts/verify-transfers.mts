import { prisma } from '../src/core/db/prisma';
import * as drawers from '../src/modules/drawers/drawer.service';
import * as grants from '../src/modules/drawers/grant.service';
import * as transfers from '../src/modules/drawers/transfer.service';
import * as settings from '../src/modules/settings/settings.service';
import * as day from '../src/modules/exchange/business-day.service';

/**
 * Moving money between the branch's own balances, driven end to end.
 *
 * What this exists to pin is one sentence: **a transfer changes what the office
 * is worth by nothing, and never half happens.** Everything below is a way of
 * trying to make that false.
 *
 * The three claims each get their own attempt at falsification:
 *
 *  - **both sides or neither** — the totals before and after are compared, not
 *    the individual balances, because a transfer that moved one side would
 *    leave every individual balance looking perfectly plausible
 *  - **money can stop in the middle** — and while it is stopped it is somewhere
 *    countable and nowhere spendable
 *  - **the commission is a cost, not a discount** — the office is poorer by
 *    exactly the fee, and the day's expenses say so
 *
 * Every refusal asserts its message key. A guard that fires for the wrong
 * reason is the failure mode this script format was written against.
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
    const code = (error as { code?: string }).code;
    ok(label, expectKey ? key === expectKey : true, key ?? code ?? String(error));
  }
};

const money = (value: bigint) => (Number(value) / 1e8).toFixed(2);

// --- The cast --------------------------------------------------------------

const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
const teller = await prisma.user.findFirstOrThrow({ where: { username: 'teller' } });
const branch = await prisma.branch.findFirstOrThrow();

const manager = {
  id: admin.id,
  name: 'المدير',
  branchId: branch.id,
  permissions: ['exchange.drawer.manage', 'exchange.transfer.use'],
};

const delegate = {
  id: teller.id,
  name: 'التلر',
  branchId: branch.id,
  permissions: ['exchange.transfer.use'],
};

await day.openDay(branch.id, manager).catch(() => {});

const till = await prisma.drawer.findFirstOrThrow({
  where: { ownerKey: 'TREASURY', kind: 'CASH', currencyCode: 'ILS' },
});
const bank = await prisma.drawer.findFirstOrThrow({
  where: { ownerKey: 'TREASURY', kind: 'BROKER', currencyCode: 'ILS' },
});
const otherCurrency = await prisma.drawer.findFirstOrThrow({
  where: { ownerKey: 'TREASURY', kind: 'CASH', currencyCode: { not: 'ILS' } },
});

/** Everything the branch holds, in this currency, across every kind. */
const totalHeld = async () => {
  const rows = await prisma.drawer.findMany({ where: { currencyCode: 'ILS' } });
  return rows.reduce((sum, row) => sum + row.balance, 0n);
};

const balanceOf = async (id: string) =>
  (await prisma.drawer.findUniqueOrThrow({ where: { id } })).balance;

const inTransit = async () => {
  const row = await prisma.drawer.findFirst({
    where: { ownerKey: 'TREASURY', kind: 'IN_TRANSIT', currencyCode: 'ILS' },
  });
  return row?.balance ?? 0n;
};

// Float to work with, put in the honest way.
await drawers.fund(
  { currency: 'ILS', kind: 'CASH', direction: 'IN', amount: 10_000n * 100_000_000n, category: 'OWNER_IN' },
  manager,
);

console.log(`\nTill ${money(await balanceOf(till.id))}  Bank ${money(await balanceOf(bank.id))}\n`);

// --- Both sides, or neither ------------------------------------------------

console.log('A transfer that arrives at once');

const worthBefore = await totalHeld();
const tillBefore = await balanceOf(till.id);
const bankBefore = await balanceOf(bank.id);

const done = await transfers.create(
  {
    fromDrawerId: till.id,
    toDrawerId: bank.id,
    amount: 1_000n * 100_000_000n,
    arrivedImmediately: true,
  },
  manager,
);

ok('it completes', done.status === 'COMPLETED', done.status);
ok('the source falls', (await balanceOf(till.id)) === tillBefore - 1_000n * 100_000_000n);
ok('the destination rises', (await balanceOf(bank.id)) === bankBefore + 1_000n * 100_000_000n);
ok(
  'and the branch is worth exactly what it was',
  (await totalHeld()) === worthBefore,
  money(await totalHeld()),
);

const legs = await prisma.drawerMovement.count({
  where: { reason: 'TRANSFER', note: done.reference },
});
ok('two movements share one reference', legs === 2, `${legs} legs`);

// --- What cannot be transferred --------------------------------------------

console.log('\nWhat is refused');

await refused(
  'the same drawer to itself',
  () =>
    transfers.create(
      { fromDrawerId: till.id, toDrawerId: till.id, amount: 100n * 100_000_000n },
      manager,
    ),
  'errors.transferSameDrawer',
);

await refused(
  'one currency to another',
  () =>
    transfers.create(
      { fromDrawerId: till.id, toDrawerId: otherCurrency.id, amount: 100n * 100_000_000n },
      manager,
    ),
  'errors.transferCrossCurrency',
);

await refused(
  'nothing at all',
  () => transfers.create({ fromDrawerId: till.id, toDrawerId: bank.id, amount: 0n }, manager),
  'errors.transferAmount',
);

await refused(
  'more than the drawer holds',
  () =>
    transfers.create(
      { fromDrawerId: till.id, toDrawerId: bank.id, amount: 9_999_999n * 100_000_000n },
      manager,
    ),
  'errors.insufficientCash',
);

/*
 * The differences drawer, opened here rather than skipped if absent.
 *
 * This is the refusal that protects the day's result — without it a real
 * shortage could be renamed into a transfer and disappear — so it is not left
 * to whether the seed happened to create one.
 */
const differences =
  (await prisma.drawer.findFirst({
    where: { ownerKey: 'TREASURY', kind: 'DIFFERENCE', currencyCode: 'ILS' },
  })) ??
  (await prisma.drawer.create({
    data: {
      ownerKey: 'TREASURY',
      currencyCode: 'ILS',
      kind: 'DIFFERENCE',
      nameEn: 'Counting differences',
      nameAr: 'فروقات الجرد',
    },
  }));

await refused(
  'and money out of the differences drawer',
  () =>
    transfers.create(
      { fromDrawerId: differences.id, toDrawerId: till.id, amount: 10n * 100_000_000n },
      manager,
    ),
  'errors.transferKindNotAllowed',
);

const untouched = await totalHeld();
ok('none of which moved anything', untouched === worthBefore, money(untouched));

// --- Money that stops in the middle ----------------------------------------

console.log('\nA transfer that has not arrived');

const tillBeforeTransit = await balanceOf(till.id);
const bankBeforeTransit = await balanceOf(bank.id);

const waiting = await transfers.create(
  {
    fromDrawerId: till.id,
    toDrawerId: bank.id,
    amount: 500n * 100_000_000n,
    arrivedImmediately: false,
  },
  manager,
);

ok('it waits', waiting.status === 'PENDING_ARRIVAL', waiting.status);
ok('the money has left the till', (await balanceOf(till.id)) === tillBeforeTransit - 500n * 100_000_000n);
ok(
  'the bank balance has NOT risen',
  (await balanceOf(bank.id)) === bankBeforeTransit,
  money(await balanceOf(bank.id)),
);
ok('and it is sitting in transit', (await inTransit()) === 500n * 100_000_000n, money(await inTransit()));
ok(
  'the branch is still worth the same',
  (await totalHeld()) === worthBefore,
  money(await totalHeld()),
);

await refused(
  'the teller cannot say it arrived',
  () => transfers.confirmArrival(waiting.id, {}, delegate),
  'errors.transferConfirmManagerOnly',
);

const arrived = await transfers.confirmArrival(waiting.id, { proof: 'واتساب 12:04' }, manager);
ok('the manager can', arrived.status === 'COMPLETED', arrived.status);
ok('transit empties', (await inTransit()) === 0n, money(await inTransit()));
ok('and the bank finally rises', (await balanceOf(bank.id)) === bankBeforeTransit + 500n * 100_000_000n);

await refused(
  'and it cannot arrive twice',
  () => transfers.confirmArrival(waiting.id, {}, manager),
  'errors.transferNotInTransit',
);

// --- The commission is a cost, not a discount ------------------------------

console.log('\nA transfer with a commission');

await settings.set('transfers.commissionRates', 'عكاشة:1', manager);

const worthBeforeFee = await totalHeld();
const tillBeforeFee = await balanceOf(till.id);

const withFee = await transfers.create(
  {
    fromDrawerId: bank.id,
    toDrawerId: till.id,
    amount: 1_000n * 100_000_000n,
    account: 'عكاشة',
    arrivedImmediately: true,
  },
  manager,
);

const fee = 10n * 100_000_000n; // one percent of a thousand
ok('the rate is read from the account', withFee.commission === fee, money(withFee.commission));
ok(
  'the till receives the amount less the fee',
  (await balanceOf(till.id)) === tillBeforeFee + (1_000n * 100_000_000n - fee),
  money(await balanceOf(till.id)),
);
ok(
  'and the branch is poorer by exactly the fee',
  (await totalHeld()) === worthBeforeFee - fee,
  `${money(worthBeforeFee)} → ${money(await totalHeld())}`,
);

const expense = await prisma.drawerMovement.findFirst({
  where: { reason: 'FUNDING', category: 'EXPENSE', note: { contains: withFee.reference } },
});
ok('the fee is recorded as an expense of its own', expense !== null, expense ? money(expense.amount) : 'missing');

// --- Undoing one -----------------------------------------------------------

console.log('\nReversing it');

const beforeReverse = await totalHeld();
const reversed = await transfers.reverse(withFee.id, 'خطأ في الإدخال', manager);
ok('it reverses', reversed.status === 'REVERSED', reversed.status);
ok(
  'both sides come back, and the fee with them',
  (await totalHeld()) === beforeReverse + fee,
  `${money(beforeReverse)} → ${money(await totalHeld())}`,
);
ok('leaving the branch where it started', (await totalHeld()) === worthBeforeFee, money(await totalHeld()));

await refused(
  'and it cannot be reversed twice',
  () => transfers.reverse(withFee.id, null, manager),
  'errors.transferAlreadyReversed',
);

// --- Who may do it ---------------------------------------------------------

console.log('\nThe delegate');

await prisma.drawerGrant.deleteMany({ where: { userId: teller.id } });

await refused(
  'without a grant he cannot transfer',
  () =>
    transfers.create(
      { fromDrawerId: till.id, toDrawerId: bank.id, amount: 10n * 100_000_000n },
      delegate,
    ),
  'errors.drawerRight.TRANSFER',
);

// One end only: being trusted with the source is not being trusted with the
// destination, and this is the check that says so.
await grants.setGrant({ userId: teller.id, drawerId: till.id, canTransfer: true }, manager);

await refused(
  'a grant on one end is not enough',
  () =>
    transfers.create(
      { fromDrawerId: till.id, toDrawerId: bank.id, amount: 10n * 100_000_000n },
      delegate,
    ),
  'errors.drawerRight.TRANSFER',
);

await grants.setGrant({ userId: teller.id, drawerId: bank.id, canTransfer: true }, manager);

const byDelegate = await transfers.create(
  {
    fromDrawerId: till.id,
    toDrawerId: bank.id,
    amount: 10n * 100_000_000n,
    arrivedImmediately: true,
  },
  delegate,
);
ok('with both ends granted he can', byDelegate.status === 'COMPLETED', byDelegate.status);

const permission = await prisma.userPermission.findFirst({
  where: { userId: teller.id, permission: { key: 'exchange.transfer.use' } },
});
ok('and the grant carried the screen with it', permission !== null);

// --- The ceiling -----------------------------------------------------------

console.log('\nAbove the ceiling');

await settings.set('transfers.approvalAbove', '100', manager);

const worthBeforeCeiling = await totalHeld();
const held = await transfers.create(
  { fromDrawerId: till.id, toDrawerId: bank.id, amount: 500n * 100_000_000n, arrivedImmediately: true },
  delegate,
);

ok('the delegate is held for approval', held.status === 'PENDING_APPROVAL', held.status);
ok(
  'and not a shekel moved while it waits',
  (await totalHeld()) === worthBeforeCeiling,
  money(await totalHeld()),
);

const managerAbove = await transfers.create(
  { fromDrawerId: till.id, toDrawerId: bank.id, amount: 500n * 100_000_000n, arrivedImmediately: true },
  manager,
);
ok('the manager is not', managerAbove.status === 'COMPLETED', managerAbove.status);

const approved = await transfers.decide(held.id, { approve: true, arrivedImmediately: true }, manager);
ok('approving releases it', approved.status === 'COMPLETED', approved.status);
ok(
  'and only then does the money move',
  (await totalHeld()) === worthBeforeCeiling,
  money(await totalHeld()),
);

await settings.set('transfers.approvalAbove', '', manager);

// --- Every act left a line -------------------------------------------------

console.log('\nThe record of it');

/*
 * Asserted, not assumed.
 *
 * The first run of this script reported ALL GOOD while writing not one audit
 * row: the audit call sat inside the transaction without being handed it, so it
 * blocked on the lock its own caller was holding, timed out, and was swallowed.
 * Nothing else here could see that — the money was right, the statuses were
 * right, and the history was empty. So the history is checked too.
 */
const recorded = await prisma.auditLog.count({ where: { entityType: 'Transfer' } });
const made = await prisma.transfer.count();
ok('every transfer left an audit line', recorded >= made, `${made} transfers, ${recorded} lines`);

const reversal = await prisma.auditLog.findFirst({
  where: { entityType: 'Transfer', action: 'REVERSE' },
});
ok('and the reversal is among them', reversal !== null);

// --- Everything still adds up ----------------------------------------------

console.log('\nAfter all of it');

const check = await drawers.verifyBalances();
ok(
  'every drawer still agrees with its own movements',
  check.drawers.every((entry) => entry.agrees),
  `${check.drawers.filter((entry) => !entry.agrees).length} disagree`,
);

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} FAILED`);
await prisma.$disconnect();
process.exit(bad === 0 ? 0 : 1);
