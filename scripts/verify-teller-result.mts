import { prisma } from '../src/core/db/prisma';
import * as ledger from '../src/modules/ledger/ledger.service';
import * as evaluation from '../src/modules/ledger/teller-result.service';
import * as exceptions from '../src/modules/exchange/price-exception.service';
import * as machine from '../src/modules/exchange/machine.service';
import * as rates from '../src/modules/exchange/rates.service';
import * as cutoff from '../src/modules/ledger/cutoff.service';
import * as drawers from '../src/modules/drawers/drawer.service';
import * as handovers from '../src/modules/treasury/handover.service';
import * as day from '../src/modules/exchange/business-day.service';
import * as users from '../src/modules/users/users.service';

/**
 * The ledger over everything: where the office's money is, and what each teller
 * actually gave it.
 *
 * Built as the agreed table is built — a teller with the better margin and the
 * worse everything else — because the whole claim of the design is that the
 * first number alone points at the wrong man.
 */

const unit = 100000000n;
const money = (v: bigint) => (Number(v) / 1e8).toFixed(2);

let bad = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) bad++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ' — ' + extra : ''}`);
};

const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
const branch = await prisma.branch.findFirstOrThrow();

const manager = {
  id: admin.id,
  name: 'المدير',
  branchId: branch.id,
  permissions: [
    'ledger.view',
    'exchange.priceException.approve',
    'treasury.handover.manage',
    'exchange.drawer.manage',
    'exchange.day.open',
    'exchange.rate.manage',
    'ledger.cutoff.manage',
    'users.create',
    'users.roles.assign',
  ],
};

const clerkOf = (id: string, name: string) => ({
  id,
  name,
  branchId: branch.id,
  permissions: [
    'exchange.machine.use',
    'exchange.transaction.create',
    'exchange.priceException.request',
    'treasury.handover.receive',
  ],
});

try {
  await day.openDay(branch.id, manager);
} catch {
  /* already open */
}

// Two tellers, so the comparison the design is built on can actually be made.
const tellerRole = await prisma.role.findFirstOrThrow({ where: { key: 'TELLER' } });
const created = await users.createUser(
  {
    username: 'teller2',
    email: 'teller2@ifms.local',
    fullNameEn: 'Second Teller',
    fullNameAr: 'التلر الثاني',
    branchId: branch.id,
    roleIds: [tellerRole.id],
  },
  manager,
);
const second = await prisma.user.findUniqueOrThrow({ where: { id: created.id } });
const first = await prisma.user.findFirstOrThrow({ where: { username: 'teller' } });

const clerkA = clerkOf(first.id, 'أ');
const clerkB = clerkOf(second.id, 'ب');

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

const startedAt = new Date(Date.now() - 60_000);

// --- Both take a float ------------------------------------------------------
const float = [
  { currency: 'ILS', amount: 50000n * unit },
  { currency: 'USD', amount: 5000n * unit },
];
for (const [teller, clerk] of [
  [first, clerkA],
  [second, clerkB],
] as const) {
  const bag = await handovers.create(
    { direction: 'TO_TELLER', tellerId: teller.id, lines: float },
    manager,
  );
  await handovers.confirm(bag.id, float, clerk);
}

// === Where the money is ====================================================
console.log('\n— أين مال الشركة —');
const position = await ledger.livePosition();
const inTreasury = position.lines
  .filter((line) => line.ownerKey === 'TREASURY' && line.kind === 'CASH')
  .reduce((total, line) => total + line.worth, 0n);
const withTellers = position.lines
  .filter((line) => line.tellerId !== null)
  .reduce((total, line) => total + line.worth, 0n);

ok('the position says whose each balance is', position.lines.every((l) => l.ownerKey.length > 0));
ok('and some of it is in the tellers’ hands', withTellers > 0n, money(withTellers));
ok(
  'the total is the treasury plus them, not the treasury alone',
  position.worth > inTreasury,
  `${money(position.worth)} vs ${money(inTreasury)}`,
);

// === Teller A: the better margin, and everything else worse =================
console.log('\n— التلر أ —');

// He trades a lot, at the board.
for (let i = 0; i < 4; i++) {
  await machine.record(
    { fromCurrency: 'USD', toCurrency: 'ILS', mode: 'CASH', fromAmount: 500n * unit, branchId: branch.id },
    clerkA,
  );
}

// And gives a price away on a fifth.
const askedA = await exceptions.request(
  {
    fromCurrency: 'USD',
    toCurrency: 'ILS',
    channel: 'CASH',
    maxFromAmount: 1000n * unit,
    requestedRate: 352000000n,
    reason: 'زبون',
  },
  clerkA,
);
const grantedA = await exceptions.decide(askedA.id, { approve: true }, manager);
await machine.record(
  {
    fromCurrency: 'USD',
    toCurrency: 'ILS',
    mode: 'CASH',
    fromAmount: 1000n * unit,
    branchId: branch.id,
    priceExceptionId: grantedA.id,
  },
  clerkA,
);

const spent = await prisma.priceException.findUniqueOrThrow({ where: { id: grantedA.id } });
ok(
  'what the concession cost is frozen on the approval',
  spent.concededAmount === 20n * unit && spent.concededCurrency === 'ILS',
  money(spent.concededAmount ?? 0n),
);

// === Teller B: fewer deals, no concessions, counts straight =================
console.log('\n— التلر ب —');
for (let i = 0; i < 2; i++) {
  await machine.record(
    { fromCurrency: 'USD', toCurrency: 'ILS', mode: 'CASH', fromAmount: 500n * unit, branchId: branch.id },
    clerkB,
  );
}

// --- Evening: A is short, B is exact ---------------------------------------
const handBack = async (teller: { id: string }, clerk: typeof clerkA, short: bigint) => {
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

await handBack(first, clerkA, 300n * unit);
await handBack(second, clerkB, 0n);

// === The three numbers =====================================================
console.log('\n— الأرقام الثلاثة —');
const result = await evaluation.tellerResults(branch.id, startedAt, new Date());
const a = result.rows.find((row) => row.tellerId === first.id)!;
const b = result.rows.find((row) => row.tellerId === second.id)!;

console.log(
  `        margin   differences  concessions   net\n` +
    `   أ    ${money(a.margin).padStart(7)}  ${money(a.differences).padStart(9)}  ${money(a.concessions).padStart(10)}  ${money(a.net).padStart(8)}\n` +
    `   ب    ${money(b.margin).padStart(7)}  ${money(b.differences).padStart(9)}  ${money(b.concessions).padStart(10)}  ${money(b.net).padStart(8)}`,
);

ok('A wrote more margin than B', a.margin > b.margin, `${money(a.margin)} vs ${money(b.margin)}`);
ok('A was short and it counts against him', a.differences === -300n * unit, money(a.differences));
ok('B was exact', b.differences === 0n, money(b.differences));
ok('what A gave away is charged to him', a.concessions === -20n * unit, money(a.concessions));
ok('B gave nothing away', b.concessions === 0n);
ok('the three add up', a.net === a.margin + a.differences + a.concessions, money(a.net));
ok(
  'and B, on the worse margin, gave the office more',
  b.net > a.net,
  `${money(b.net)} vs ${money(a.net)}`,
);
ok('the list is ordered by what they gave, not what they wrote', result.rows[0]!.tellerId === second.id);

// A reversal must not leave a margin standing.
const beforeReversal = (await evaluation.tellerResults(branch.id, startedAt, new Date())).rows.find(
  (row) => row.tellerId === second.id,
)!;
const last = await prisma.transaction.findFirstOrThrow({
  where: { createdById: second.id },
  orderBy: { createdAt: 'desc' },
});
const { reverse } = await import('../src/modules/exchange/transaction.service');
await reverse(last.id, 'خطأ في الإدخال', {
  ...manager,
  permissions: [...manager.permissions, 'exchange.transaction.reverse'],
});
const afterReversal = (await evaluation.tellerResults(branch.id, startedAt, new Date())).rows.find(
  (row) => row.tellerId === second.id,
)!;
ok(
  'a reversed deal stops counting as margin',
  afterReversal.margin < beforeReversal.margin,
  `${money(beforeReversal.margin)} → ${money(afterReversal.margin)}`,
);

// === A word from the management ============================================
console.log('\n— التبليغ —');
const note = await evaluation.writeNote(
  { tellerId: first.id, body: 'انتبه للعدّ في نهاية الوردية.', tone: 'WARNING' },
  manager,
);
ok('the note is written', note.body.length > 0);
ok('and it is unread until he opens it', (await evaluation.unreadFor(first.id)).length === 1);

let refusedSelf = false;
try {
  await evaluation.writeNote({ tellerId: manager.id, body: 'ملاحظة لنفسي' }, manager);
} catch {
  refusedSelf = true;
}
ok('a note is written to somebody else', refusedSelf);

let refusedOther = false;
try {
  await evaluation.markNotesRead(first.id, manager);
} catch {
  refusedOther = true;
}
ok('only the person it is about can mark it read', refusedOther);

await evaluation.markNotesRead(first.id, clerkA);
ok('and once he does, it is delivered', (await evaluation.unreadFor(first.id)).length === 0);

// === Nothing moved that should not have ===================================
const check = await drawers.verifyBalances();
ok('every balance still agrees with its movements', check.ok);

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} FAILED`);
await prisma.$disconnect();
process.exit(bad === 0 ? 0 : 1);
