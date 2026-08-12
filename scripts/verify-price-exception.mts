import { prisma } from '../src/core/db/prisma';
import * as exceptions from '../src/modules/exchange/price-exception.service';
import * as machine from '../src/modules/exchange/machine.service';
import * as rates from '../src/modules/exchange/rates.service';
import * as cutoff from '../src/modules/ledger/cutoff.service';
import * as drawers from '../src/modules/drawers/drawer.service';
import * as handovers from '../src/modules/treasury/handover.service';
import * as day from '../src/modules/exchange/business-day.service';

/**
 * A broken price, from the ask to the deal it was spent on.
 *
 * The four leashes are the point of the feature, so each of them is pulled
 * here: the approval is refused after it expires, on the wrong pair, on the
 * wrong channel, over its amount, in somebody else's hands, and a second time.
 */

const unit = 100000000n;
const rate = (v: bigint) => (Number(v) / 1e8).toFixed(4);
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
    'exchange.priceException.approve',
    'exchange.machine.use',
    'exchange.transaction.create',
    'treasury.handover.manage',
    'exchange.drawer.manage',
    'exchange.day.open',
    'exchange.rate.manage',
    'ledger.cutoff.manage',
  ],
};
const clerk = {
  id: teller.id,
  name: 'التلر',
  branchId: branch.id,
  permissions: [
    'exchange.priceException.request',
    'exchange.machine.use',
    'exchange.transaction.create',
    'treasury.handover.receive',
  ],
};

// Tolerated so this can run after another check on the same database, which
// is how CI runs it — a day already open is the state it wants either way.
try {
  await day.openDay(branch.id, manager);
} catch {
  /* already open */
}
await drawers.fund(
  { currency: 'ILS', kind: 'CASH', direction: 'IN', amount: 500000n * unit, category: 'OWNER_IN' },
  manager,
);
await drawers.fund(
  { currency: 'USD', kind: 'CASH', direction: 'IN', amount: 50000n * unit, category: 'OWNER_IN' },
  manager,
);

// The board: the office buys a dollar for 3.55 shekels and sells it for 3.65.
await rates.publishRate(
  { baseCode: 'USD', quoteCode: 'ILS', channel: 'CASH', buyRate: 355000000n, sellRate: 365000000n },
  manager,
);
// And carries dollars at 3.54 — this is the cost the manager is shown.
await cutoff.setRate({ currencyCode: 'USD', rate: 354000000n }, manager);

// The teller works out of his own drawer, so he needs one.
const bag = await handovers.create(
  { direction: 'TO_TELLER', tellerId: teller.id, lines: [{ currency: 'ILS', amount: 50000n * unit }] },
  manager,
);
await handovers.confirm(bag.id, [{ currency: 'ILS', amount: 50000n * unit }], clerk);

// === What the office pays for a dollar =====================================
console.log('\n— التكلفة —');
const cost = await exceptions.costRateFor('USD', 'ILS');
ok('cost comes from the cut-off rate the manager set', cost === 354000000n, rate(cost ?? 0n));

// === Asking ================================================================
console.log('\n— الطلب —');
await refused(
  'a price better than the board needs no permission',
  () =>
    exceptions.request(
      { fromCurrency: 'USD', toCurrency: 'ILS', channel: 'CASH', maxFromAmount: 1000n * unit, requestedRate: 350000000n },
      clerk,
    ),
  'errors.exceptionNotAConcession',
);

// He wants to pay 3.58 for the customer's dollars — worse for the office than
// the board's 3.55, and worse than the 3.54 it carries them at.
const asked = await exceptions.request(
  {
    fromCurrency: 'USD',
    toCurrency: 'ILS',
    channel: 'CASH',
    maxFromAmount: 1000n * unit,
    requestedRate: 358000000n,
    reason: 'زبون دائم',
  },
  clerk,
);
ok('the request is waiting', asked.status === 'PENDING', asked.reference);
ok('the board is frozen on it', asked.boardRate === 355000000n, rate(asked.boardRate));

const told = await prisma.notificationRecipient.findFirst({
  where: { userId: admin.id, notification: { eventKey: 'exchange.priceException.requested' } },
});
ok('the manager is told on his screen', told !== null);

// === Deciding ==============================================================
console.log('\n— القرار —');
await refused(
  'nobody approves his own',
  () => exceptions.decide(asked.id, { approve: true }, clerk as never),
  'errors.forbidden',
);
await refused(
  'and not even with the permission',
  () =>
    exceptions.decide(asked.id, { approve: true }, {
      ...clerk,
      permissions: [...clerk.permissions, 'exchange.priceException.approve'],
    }),
  'errors.exceptionSamePerson',
);
await refused(
  'the office does not bid against itself',
  () => exceptions.decide(asked.id, { approve: true, rate: 360000000n }, manager),
  'errors.exceptionWorseThanAsked',
);

// He grants less than was asked: 3.57 rather than 3.58.
const granted = await exceptions.decide(
  asked.id,
  { approve: true, rate: 357000000n, note: 'مرة واحدة' },
  manager,
);
ok('approved for less than was asked', granted.approvedRate === 357000000n, rate(granted.approvedRate ?? 0n));
ok('the cost is stamped on the decision', granted.costRate === 354000000n, rate(granted.costRate ?? 0n));
ok('and it expires', granted.expiresAt !== null && granted.expiresAt > new Date());
ok('below cost, which the manager could see', (granted.approvedRate ?? 0n) > (granted.costRate ?? 0n));

const heard = await prisma.notificationRecipient.findFirst({
  where: { userId: teller.id, notification: { eventKey: 'exchange.priceException.approved' } },
});
ok('the teller is told', heard !== null);

// === What the board would have paid ========================================
console.log('\n— الصفقة —');
const board = await machine.record(
  { fromCurrency: 'USD', toCurrency: 'ILS', mode: 'CASH', fromAmount: 1000n * unit, branchId: branch.id },
  clerk,
);
const boardRow = await prisma.transaction.findUniqueOrThrow({ where: { id: board.id } });
ok('without an approval the board applies', boardRow.rate === 355000000n, rate(boardRow.rate));
ok('and the customer is paid 3,550', boardRow.toAmount === 3550n * unit, money(boardRow.toAmount));

// === The same deal, on the approval ========================================
const deal = await machine.record(
  {
    fromCurrency: 'USD',
    toCurrency: 'ILS',
    mode: 'CASH',
    fromAmount: 1000n * unit,
    branchId: branch.id,
    priceExceptionId: granted.id,
  },
  clerk,
);
const row = await prisma.transaction.findUniqueOrThrow({ where: { id: deal.id } });
ok('the granted price applies', row.rate === 357000000n, rate(row.rate));
ok('the customer is paid 3,570', row.toAmount === 3570n * unit, money(row.toAmount));
ok(
  'and the margin given up is 20 shekels',
  boardRow.profitAmount - row.profitAmount === 20n * unit,
  money(boardRow.profitAmount - row.profitAmount),
);

const spent = await prisma.priceException.findUniqueOrThrow({ where: { id: granted.id } });
ok('the approval is spent', spent.status === 'USED');
ok('and stamped on the deal', spent.usedByTransactionId === deal.id, row.reference);

// === The leashes ===========================================================
console.log('\n— القيود —');
await refused(
  'it cannot be spent twice',
  () =>
    machine.record(
      {
        fromCurrency: 'USD',
        toCurrency: 'ILS',
        mode: 'CASH',
        fromAmount: 1000n * unit,
        branchId: branch.id,
        priceExceptionId: granted.id,
      },
      clerk,
    ),
  'errors.exceptionNotApproved',
);

const fresh = async (over: Partial<Parameters<typeof exceptions.request>[0]> = {}) => {
  const asked = await exceptions.request(
    {
      fromCurrency: 'USD',
      toCurrency: 'ILS',
      channel: 'CASH',
      maxFromAmount: 1000n * unit,
      requestedRate: 358000000n,
      ...over,
    },
    clerk,
  );
  return exceptions.decide(asked.id, { approve: true }, manager);
};

const overAmount = await fresh();
await refused(
  'nor beyond the amount it covers',
  () =>
    machine.record(
      {
        fromCurrency: 'USD',
        toCurrency: 'ILS',
        mode: 'CASH',
        fromAmount: 1001n * unit,
        branchId: branch.id,
        priceExceptionId: overAmount.id,
      },
      clerk,
    ),
  'errors.exceptionOverAmount',
);

const wrongWay = await fresh();
await refused(
  'nor on the other way of paying',
  () =>
    machine.record(
      {
        fromCurrency: 'USD',
        toCurrency: 'ILS',
        mode: 'BROKER',
        fromAmount: 500n * unit,
        branchId: branch.id,
        priceExceptionId: wrongWay.id,
      },
      clerk,
    ),
  'errors.exceptionWrongChannel',
);

const notYours = await fresh();
await refused(
  'nor in another person’s hands',
  () =>
    machine.record(
      {
        fromCurrency: 'USD',
        toCurrency: 'ILS',
        mode: 'CASH',
        fromAmount: 500n * unit,
        branchId: branch.id,
        priceExceptionId: notYours.id,
      },
      manager,
    ),
  'errors.exceptionNotYours',
);

const stale = await fresh();
await prisma.priceException.update({
  where: { id: stale.id },
  data: { expiresAt: new Date(Date.now() - 60_000) },
});
await refused(
  'nor after it expires',
  () =>
    machine.record(
      {
        fromCurrency: 'USD',
        toCurrency: 'ILS',
        mode: 'CASH',
        fromAmount: 500n * unit,
        branchId: branch.id,
        priceExceptionId: stale.id,
      },
      clerk,
    ),
  'errors.exceptionExpired',
);
const swept = await exceptions.sweepExpired();
ok('and a stale one leaves the queue', swept >= 1, String(swept));

// A refusal moves nothing and cannot be spent.
const askedAgain = await exceptions.request(
  { fromCurrency: 'USD', toCurrency: 'ILS', channel: 'CASH', maxFromAmount: 100n * unit, requestedRate: 358000000n },
  clerk,
);
const refusedOne = await exceptions.decide(askedAgain.id, { approve: false, note: 'لا' }, manager);
ok('a refusal is recorded as one', refusedOne.status === 'REJECTED');
await refused(
  'and cannot be spent',
  () =>
    machine.record(
      {
        fromCurrency: 'USD',
        toCurrency: 'ILS',
        mode: 'CASH',
        fromAmount: 100n * unit,
        branchId: branch.id,
        priceExceptionId: refusedOne.id,
      },
      clerk,
    ),
  'errors.exceptionNotApproved',
);

// === Nothing was left half-done ============================================
console.log('\n— بعد كل ذلك —');
const check = await drawers.verifyBalances();
ok('every balance still agrees with its movements', check.ok);
ok(
  'no approval was burnt on a deal that never happened',
  (await prisma.priceException.count({ where: { status: 'USED', usedByTransactionId: null } })) === 0,
);
ok(
  'and no deal carries an approval that was not spent',
  (await prisma.priceException.count({
    where: { usedByTransactionId: { not: null }, status: { not: 'USED' } },
  })) === 0,
);

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} FAILED`);
await prisma.$disconnect();
process.exit(bad === 0 ? 0 : 1);
