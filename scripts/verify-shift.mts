import { prisma } from '../src/core/db/prisma';
import * as handovers from '../src/modules/treasury/handover.service';
import * as shifts from '../src/modules/treasury/shift.service';
import * as diffs from '../src/modules/treasury/discrepancy.service';
import * as drawers from '../src/modules/drawers/drawer.service';
import * as day from '../src/modules/exchange/business-day.service';
import * as ledger from '../src/modules/ledger/ledger.service';
import * as cutoff from '../src/modules/ledger/cutoff.service';
import * as machine from '../src/modules/exchange/machine.service';
import * as rates from '../src/modules/exchange/rates.service';

const unit = 100000000n;
const m = (v: bigint) => (Number(v) / 1e8).toFixed(2);
let bad = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) bad++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ' — ' + extra : ''}`);
};

const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
const teller = await prisma.user.findFirstOrThrow({ where: { username: 'teller' } });
const branch = await prisma.branch.findFirstOrThrow();
const own = drawers.tellerOwner(teller.id);

const manager = {
  id: admin.id,
  name: 'المدير',
  branchId: branch.id,
  permissions: [
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
  permissions: ['treasury.handover.receive', 'exchange.machine.use', 'exchange.transaction.create'],
};

await day.openDay(branch.id, manager);
await drawers.fund(
  { currency: 'ILS', kind: 'CASH', direction: 'IN', amount: 100000n * unit, category: 'OWNER_IN' },
  manager,
);
await drawers.fund(
  { currency: 'USD', kind: 'CASH', direction: 'IN', amount: 20000n * unit, category: 'OWNER_IN' },
  manager,
);
await rates.publishRate(
  { baseCode: 'USD', quoteCode: 'ILS', channel: 'CASH', buyRate: 355000000n, sellRate: 365000000n },
  manager,
);
await cutoff.setRate({ currencyCode: 'USD', rate: 360000000n }, manager);

const worth = async () => (await ledger.livePosition()).worth;
const bal = async (owner: string, cur: string, kind = 'CASH') => {
  const all = await drawers.listDrawers();
  return all.find((d) => d.ownerKey === owner && d.currencyCode === cur && d.kind === kind)?.balance ?? 0n;
};

// === Morning: the float ====================================================
console.log('\n— صباحاً: تسليم العهدة —');
let before = await worth();
const bag = await handovers.create(
  { direction: 'TO_TELLER', tellerId: teller.id, lines: [{ currency: 'ILS', amount: 5000n * unit }] },
  manager,
);
await handovers.confirm(bag.id, [{ currency: 'ILS', amount: 5000n * unit }], clerk);

const shift = await shifts.current(teller.id);
ok('a shift opens by itself when the bag is taken', shift?.status === 'OPEN', shift?.reference);
ok('the office is worth the same', (await worth()) === before);
ok('the float is in the hands of the teller', (await bal(own, 'ILS')) === 5000n * unit);

// === He trades =============================================================
console.log('\n— خلال الدوام —');
const treasuryBefore = await bal('TREASURY', 'ILS');
// Buys 10 USD from a customer, paying 35.50 shekels out of his own drawer.
await machine.record(
  { fromCurrency: 'USD', toCurrency: 'ILS', mode: 'CASH', fromAmount: 10n * unit, branchId: branch.id },
  clerk,
);

const tIls = await bal(own, 'ILS');
const tUsd = await bal(own, 'USD');
// 10 USD at 3.55 costs him 35.50 shekels.
ok('he paid out of his own drawer', tIls === 5000n * unit - 3550000000n, m(tIls));
ok('a dollar drawer opened for him on the spot', tUsd === 10n * unit, m(tUsd));
ok('the treasury drawer never moved', (await bal('TREASURY', 'ILS')) === treasuryBefore);

let refused = false;
try {
  await machine.record(
    // Buying 10,000 dollars would mean handing over 35,500 shekels, and he is
    // holding a few thousand.
    { fromCurrency: 'USD', toCurrency: 'ILS', mode: 'CASH', fromAmount: 10000n * unit, branchId: branch.id },
    clerk,
  );
} catch {
  refused = true;
}
ok('he cannot pay out money he does not have', refused);

// === Evening: 100 short ====================================================
console.log('\n— مساءً: الجرد، وينقص ١٠٠ —');
before = await worth();
const expected = await bal(own, 'ILS');
const handed = expected - 100n * unit;
const heldUsd = await bal(own, 'USD');

const back = await handovers.create(
  {
    direction: 'TO_TREASURY',
    tellerId: teller.id,
    lines: [
      { currency: 'ILS', amount: handed },
      { currency: 'USD', amount: heldUsd },
    ],
  },
  clerk,
);
await handovers.confirm(
  back.id,
  [
    { currency: 'ILS', amount: handed },
    { currency: 'USD', amount: heldUsd },
  ],
  manager,
);

ok('his shekel drawer ends at zero', (await bal(own, 'ILS')) === 0n);
ok('his dollar drawer ends at zero', (await bal(own, 'USD')) === 0n);
ok('the shortage sits in the differences balance', (await bal('TREASURY', 'ILS', 'DIFFERENCE')) === 100n * unit);
ok('the office is worth the same — nothing was lost yet', (await worth()) === before);
ok('the shift is closed', (await shifts.current(teller.id)) === null);

const open = await shifts.openDiscrepancies();
ok('one difference is waiting', open.length === 1 && open[0]!.amount === 100n * unit, open[0] ? m(open[0].amount) : '');
ok('and its age is reported', (await shifts.oldestOpenAgeDays()) === 0);

// === The cameras say it was his ============================================
console.log('\n— بعد مراجعة الكاميرات: على التلر —');
before = await worth();
await diffs.resolve(open[0]!.id, { resolution: 'CHARGED_TO_TELLER', note: 'الكاميرا' }, manager);
ok('he owes it', (await bal(own, 'ILS', 'RECEIVABLE')) === 100n * unit);
ok('the differences balance is cleared', (await bal('TREASURY', 'ILS', 'DIFFERENCE')) === 0n);
ok('still no loss — cash became a claim', (await worth()) === before);

await diffs.settleDebt({ tellerId: teller.id, currency: 'ILS', amount: 100n * unit }, manager);
ok('he pays, and owes nothing', (await bal(own, 'ILS', 'RECEIVABLE')) === 0n);
ok('the treasury has the cash back', (await worth()) === before);

// === A surplus, and a write-off ===========================================
console.log('\n— وردية ثانية: زيادة ٥٠ —');
const bag2 = await handovers.create(
  { direction: 'TO_TELLER', tellerId: teller.id, lines: [{ currency: 'ILS', amount: 1000n * unit }] },
  manager,
);
await handovers.confirm(bag2.id, [{ currency: 'ILS', amount: 1000n * unit }], clerk);

before = await worth();
const back2 = await handovers.create(
  { direction: 'TO_TREASURY', tellerId: teller.id, lines: [{ currency: 'ILS', amount: 1050n * unit }] },
  clerk,
);
await handovers.confirm(back2.id, [{ currency: 'ILS', amount: 1050n * unit }], manager);

ok('a surplus also leaves him at zero', (await bal(own, 'ILS')) === 0n);
ok('the differences balance goes negative, as it must', (await bal('TREASURY', 'ILS', 'DIFFERENCE')) === -50n * unit);
ok('the office is worth the same', (await worth()) === before);

const open2 = await shifts.openDiscrepancies();
let rejected = false;
try {
  await diffs.resolve(open2[0]!.id, { resolution: 'CHARGED_TO_TELLER' }, manager);
} catch {
  rejected = true;
}
ok('nobody can be charged for money that was found', rejected);

before = await worth();
await diffs.resolve(open2[0]!.id, { resolution: 'COMPANY_LOSS', note: 'زبون لم يعُد' }, manager);
ok('written off — and the office is worth 50 more', (await worth()) === before + 50n * unit);
ok('the differences balance is empty', (await bal('TREASURY', 'ILS', 'DIFFERENCE')) === 0n);
ok('nothing is left waiting', (await shifts.openDiscrepancies()).length === 0);

const check = await drawers.verifyBalances();
ok('every balance still agrees with its movements', check.ok);

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} FAILED`);
await prisma.$disconnect();
process.exit(bad === 0 ? 0 : 1);
