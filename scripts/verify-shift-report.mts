import { prisma } from '../src/core/db/prisma';
import * as reports from '../src/modules/treasury/shift-report.service';
import * as handovers from '../src/modules/treasury/handover.service';
import * as drawers from '../src/modules/drawers/drawer.service';
import * as machine from '../src/modules/exchange/machine.service';
import * as rates from '../src/modules/exchange/rates.service';
import * as cutoff from '../src/modules/ledger/cutoff.service';
import * as day from '../src/modules/exchange/business-day.service';

/**
 * The report the system files on the teller's behalf.
 *
 * What is under test is not that a row appears — it is that the row says
 * something true and worth reading, and that the noticing changes as the man's
 * own record changes.
 */

const unit = 100000000n;
const money = (v: bigint) => (Number(v) / 1e8).toFixed(2);

let bad = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) bad++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ' — ' + extra : ''}`);
};

const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
const teller = await prisma.user.findFirstOrThrow({ where: { username: 'teller' } });
const branch = await prisma.branch.findFirstOrThrow();

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
    'ledger.view',
  ],
};
const clerk = {
  id: teller.id,
  name: 'التلر',
  branchId: branch.id,
  permissions: ['treasury.handover.receive', 'exchange.machine.use', 'exchange.transaction.create'],
};

try {
  await day.openDay(branch.id, manager);
} catch {
  /* already open */
}
await drawers.fund(
  { currency: 'ILS', kind: 'CASH', direction: 'IN', amount: 1000000n * unit, category: 'OWNER_IN' },
  manager,
);
await drawers.fund(
  { currency: 'USD', kind: 'CASH', direction: 'IN', amount: 100000n * unit, category: 'OWNER_IN' },
  manager,
);
await rates.publishRate(
  { baseCode: 'USD', quoteCode: 'ILS', channel: 'CASH', buyRate: 350000000n, sellRate: 360000000n },
  manager,
);
await cutoff.setRate({ currencyCode: 'USD', rate: 355000000n }, manager);

/**
 * One whole shift: take a float, trade `deals` times at `size` dollars each,
 * and hand it back short by `short`.
 *
 * The size matters to what is being tested: margin scales with the amount, so
 * trading smaller is how a shift ends up genuinely below his usual margin per
 * deal without anybody breaking a price.
 */
const workAShift = async (deals: number, short: bigint, size = 100n) => {
  const float = [
    { currency: 'ILS', amount: 20000n * unit },
    { currency: 'USD', amount: 2000n * unit },
  ];
  const bag = await handovers.create(
    { direction: 'TO_TELLER', tellerId: teller.id, lines: float },
    manager,
  );
  await handovers.confirm(bag.id, float, clerk);

  for (let i = 0; i < deals; i++) {
    await machine.record(
      { fromCurrency: 'USD', toCurrency: 'ILS', mode: 'CASH', fromAmount: size * unit, branchId: branch.id },
      clerk,
    );
  }

  const held = await drawers.listDrawers();
  const own = drawers.tellerOwner(teller.id);
  const lines = held
    .filter((d) => d.ownerKey === own && d.kind === 'CASH' && d.balance > 0n)
    .map((d) => ({
      currency: d.currencyCode,
      amount: d.currencyCode === 'ILS' ? d.balance - short : d.balance,
    }));
  const back = await handovers.create(
    { direction: 'TO_TREASURY', tellerId: teller.id, lines },
    clerk,
  );
  await handovers.confirm(back.id, lines, manager);
};

const latest = async () =>
  prisma.shiftReport.findFirstOrThrow({
    where: { tellerId: teller.id },
    orderBy: { closedAt: 'desc' },
  });
const codes = (raw: string) => reports.parseObservations(raw).map((entry) => entry.code);

// === The first shift, clean ================================================
console.log('\n— أول ورديّة، نظيفة —');
await workAShift(4, 0n);

let report = await latest();
ok('a report exists without anyone asking for one', report !== null);
ok('it counted the deals', report.deals === 4, String(report.deals));
ok('it recorded what he took', report.floatWorth > 0n, money(report.floatWorth));
ok('and what came back', report.returnedWorth > 0n, money(report.returnedWorth));
ok('it earned a margin', report.margin > 0n, money(report.margin));
ok('no difference', report.differences === 0n);
ok('the three add up', report.net === report.margin + report.differences + report.concessions);
ok('and it says this is his first', codes(report.observations).includes('FIRST_SHIFT'), codes(report.observations).join(', '));

const told = await prisma.notificationRecipient.findFirst({
  where: { userId: admin.id, notification: { eventKey: 'treasury.shiftReport.ready' } },
});
ok('the manager was told, unprompted', told !== null);
const notTold = await prisma.notificationRecipient.findFirst({
  where: { userId: teller.id, notification: { eventKey: 'treasury.shiftReport.ready' } },
});
ok('and the teller was not copied on his own report', notTold === null);

// === A second, also clean ==================================================
console.log('\n— ورديّة ثانية، نظيفة —');
await workAShift(4, 0n);
report = await latest();
ok('a clean shift is said to be clean', codes(report.observations).includes('CLEAN'), codes(report.observations).join(', '));

// === Then he is short ======================================================
console.log('\n— ثم ينقص —');
await workAShift(4, 300n * unit);
report = await latest();
let seen = codes(report.observations);
ok('the shortage is the first thing said', seen[0] === 'SHORT', seen.join(', '));
ok('and it costs him in the numbers', report.differences === -300n * unit, money(report.differences));
ok('a shortage is not yet called a pattern', !seen.includes('SHORT_REPEATED'));

// === Short again, and again ================================================
console.log('\n— ونقص، ونقص —');
await workAShift(4, 100n * unit);
await workAShift(4, 100n * unit);
report = await latest();
seen = codes(report.observations);
ok('now it is called a pattern', seen.includes('SHORT_REPEATED'), seen.join(', '));

// === Measured against his own usual, not against the others ================
console.log('\n— يُقاس على نفسه —');

// The same number of deals at a fifth of the size, so the margin per deal
// really is down and nothing else about the shift has changed.
await workAShift(4, 0n, 20n);
report = await latest();
seen = codes(report.observations);
ok('a thinner shift is noticed', seen.includes('MARGIN_BELOW'), seen.join(', '));

const drop = reports
  .parseObservations(report.observations)
  .find((entry) => entry.code === 'MARGIN_BELOW');
ok('with a real number, not an adjective', Number(drop?.params?.percent) >= 50, `${drop?.params?.percent}%`);

// Back at his usual size, the same man should stop being remarked upon.
await workAShift(4, 0n);
report = await latest();
seen = codes(report.observations);
ok('and a shift back at his usual is not scolded', !seen.includes('MARGIN_BELOW'), seen.join(', '));

// === Nothing is invented ===================================================
console.log('\n— لا شيء مخترع —');
const all = await prisma.shiftReport.findMany({ where: { tellerId: teller.id } });
ok('every report is frozen with its own base currency', all.every((row) => row.baseCurrency.length > 0));
ok(
  'and every observation is a code, never a sentence',
  all.every((row) =>
    reports.parseObservations(row.observations).every((entry) => /^[A-Z_]+$/.test(entry.code)),
  ),
);
ok(
  'each closed shift has exactly one',
  all.length === (await prisma.shift.count({ where: { tellerId: teller.id, status: 'CLOSED' } })),
  `${all.length} reports`,
);

const check = await drawers.verifyBalances();
ok('every balance still agrees with its movements', check.ok);

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} FAILED`);
await prisma.$disconnect();
process.exit(bad === 0 ? 0 : 1);
