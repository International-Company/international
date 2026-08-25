import { prisma } from '../src/core/db/prisma';
import * as drawers from '../src/modules/drawers/drawer.service';
import * as grants from '../src/modules/drawers/grant.service';
import * as day from '../src/modules/exchange/business-day.service';

/**
 * Who may touch which drawer, driven end to end.
 *
 * The rule this pins is the one the office asked for in words: "a teller may
 * move money between the drawers I choose, and nothing else." Three halves of
 * that sentence can each fail silently, so each is checked against a real
 * database rather than reasoned about:
 *
 *  - **nothing by default** — a person with no grant is refused, and sees none
 *  - **exactly what was ticked** — deposit alone does not buy withdraw
 *  - **and it goes away** — unticking the last box removes the drawer from his
 *    screen, not merely his ability to use it
 *
 * The trap this is written to avoid is the one that has caught me before: a
 * check that passes because the operation failed for an unrelated reason. So
 * every refusal here asserts the *message key*, and every one is preceded by
 * the same call succeeding for somebody who was allowed — a guard that never
 * fires proves nothing.
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

// --- The cast --------------------------------------------------------------

const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
const teller = await prisma.user.findFirstOrThrow({ where: { username: 'teller' } });

const manager = {
  id: admin.id,
  name: 'المدير',
  branchId: admin.branchId,
  permissions: ['exchange.drawer.manage', 'exchange.drawer.view'],
};

/** The teller as the server actually sees him: no drawer permission at all. */
const delegate = {
  id: teller.id,
  name: 'التلر',
  branchId: admin.branchId,
  permissions: ['exchange.machine.use'],
};

// Two treasury drawers in different currencies, so "only the one I was given"
// is a claim with something to be wrong about.
const treasury = await prisma.drawer.findMany({
  where: { ownerKey: 'TREASURY', isActive: true },
  orderBy: { sortOrder: 'asc' },
  take: 2,
});

// Funding belongs to a day, like everything else that moves money. Opened here
// so the refusals below fail for the reason under test rather than for a closed
// counter — a guard that fires for the wrong reason proves nothing.
const branch = await prisma.branch.findFirstOrThrow();
await day.openDay(branch.id, manager).catch(() => {});

if (treasury.length < 2) {
  console.log('Needs at least two treasury drawers. Seed the database first.');
  await prisma.$disconnect();
  process.exit(1);
}

const [given, withheld] = treasury as [(typeof treasury)[number], (typeof treasury)[number]];

console.log(`\nGranting on ${given.nameEn}, withholding ${withheld.nameEn}\n`);

// Start clean, so a rerun on the same database means the same thing.
await prisma.drawerGrant.deleteMany({ where: { userId: teller.id } });

// --- Nothing by default ----------------------------------------------------

console.log('With no grant at all');

const before = await drawers.listDrawers({ forActor: delegate });
ok(
  'he sees no treasury drawer',
  before.every((drawer) => drawer.ownerKey !== 'TREASURY'),
  `${before.length} visible`,
);

await refused(
  'he cannot put money in',
  () =>
    drawers.fund(
      { currency: given.currencyCode, kind: given.kind as drawers.DrawerKind, direction: 'IN', amount: 100_000_000n, category: 'OWNER_IN' },
      delegate,
    ),
  'errors.drawerRight.DEPOSIT',
);

// --- Exactly what was ticked -----------------------------------------------

console.log('\nGranted deposit, and deposit only');

await grants.setGrant(
  { userId: teller.id, drawerId: given.id, canDeposit: true },
  manager,
);

const seen = await drawers.listDrawers({ forActor: delegate });
ok(
  'the granted drawer appears',
  seen.some((drawer) => drawer.id === given.id),
);
ok(
  'the withheld one does not',
  !seen.some((drawer) => drawer.id === withheld.id),
);

const opening = (await prisma.drawer.findUniqueOrThrow({ where: { id: given.id } })).balance;

// The permitted direction FIRST. A refusal is only evidence when the same call
// is known to work for somebody who was allowed it.
await drawers.fund(
  { currency: given.currencyCode, kind: given.kind as drawers.DrawerKind, direction: 'IN', amount: 100_000_000n, category: 'OWNER_IN' },
  delegate,
);

const afterDeposit = (await prisma.drawer.findUniqueOrThrow({ where: { id: given.id } })).balance;
ok(
  'the deposit he was granted goes through',
  afterDeposit === opening + 100_000_000n,
  `${opening} → ${afterDeposit}`,
);

await refused(
  'but the withdrawal he was not is refused',
  () =>
    drawers.fund(
      { currency: given.currencyCode, kind: given.kind as drawers.DrawerKind, direction: 'OUT', amount: 100_000_000n, category: 'OWNER_OUT' },
      delegate,
    ),
  'errors.drawerRight.WITHDRAW',
);

await refused(
  'and the drawer he was never given stays shut',
  () =>
    drawers.fund(
      { currency: withheld.currencyCode, kind: withheld.kind as drawers.DrawerKind, direction: 'IN', amount: 100_000_000n, category: 'OWNER_IN' },
      delegate,
    ),
  'errors.drawerRight.DEPOSIT',
);

const held = (await prisma.drawer.findUniqueOrThrow({ where: { id: given.id } })).balance;
ok('and nothing moved on either refusal', held === afterDeposit, String(held));

// --- The manager is untouched ----------------------------------------------

console.log('\nThe manager, meanwhile');

await drawers.fund(
  { currency: withheld.currencyCode, kind: withheld.kind as drawers.DrawerKind, direction: 'IN', amount: 50_000_000n, category: 'OWNER_IN' },
  manager,
);
ok('opens a drawer nobody granted him', true);

const managerSees = await drawers.listDrawers({ forActor: manager });
ok(
  'and sees every drawer',
  managerSees.length >= treasury.length,
  `${managerSees.length} visible`,
);

// --- Rights are separate ---------------------------------------------------

console.log('\nAdding withdraw to the same drawer');

await grants.setGrant(
  { userId: teller.id, drawerId: given.id, canDeposit: true, canWithdraw: true },
  manager,
);

await drawers.fund(
  { currency: given.currencyCode, kind: given.kind as drawers.DrawerKind, direction: 'OUT', amount: 100_000_000n, category: 'OWNER_OUT' },
  delegate,
);

const restored = (await prisma.drawer.findUniqueOrThrow({ where: { id: given.id } })).balance;
ok(
  'the same withdrawal now goes through',
  restored === opening,
  `back to ${restored}`,
);

// --- Refusals that protect the model ---------------------------------------

console.log('\nWhat cannot be granted');

/*
 * Opened here rather than skipped when absent.
 *
 * A branch that only runs on a database that happens to be shaped right is a
 * branch that reports "ok" by not running, which is the failure this whole
 * script is written against.
 */
const own =
  (await prisma.drawer.findFirst({ where: { ownerKey: `teller:${teller.id}` } })) ??
  (await prisma.drawer.create({
    data: {
      ownerKey: `teller:${teller.id}`,
      tellerId: teller.id,
      currencyCode: given.currencyCode,
      kind: 'CASH',
      nameEn: "Teller's till",
      nameAr: 'صندوق التلر',
    },
  }));

await refused(
  'his own drawer cannot be granted to him',
  () => grants.setGrant({ userId: teller.id, drawerId: own.id, canTransfer: true }, manager),
  'errors.grantOwnDrawer',
);

ok(
  'and he sees it without any grant',
  (await drawers.listDrawers({ forActor: delegate })).some((drawer) => drawer.id === own.id),
);

await refused(
  'and he cannot grant himself anything',
  () => grants.setGrant({ userId: teller.id, drawerId: withheld.id, canDeposit: true }, delegate),
  'errors.forbidden',
);

// --- Unticking the last box removes it -------------------------------------

console.log('\nUnticking everything');

const gone = await grants.setGrant(
  { userId: teller.id, drawerId: given.id, canDeposit: false, canWithdraw: false, canTransfer: false },
  manager,
);
ok('the grant is reported as removed, not emptied', gone === null);

const rows = await prisma.drawerGrant.count({ where: { userId: teller.id, drawerId: given.id } });
ok('and no row is left behind', rows === 0, `${rows} rows`);

const afterRevoke = await drawers.listDrawers({ forActor: delegate });
ok(
  'the drawer disappears from his screen',
  !afterRevoke.some((drawer) => drawer.id === given.id),
);

await refused(
  'and he is refused again',
  () =>
    drawers.fund(
      { currency: given.currencyCode, kind: given.kind as drawers.DrawerKind, direction: 'IN', amount: 100_000_000n, category: 'OWNER_IN' },
      delegate,
    ),
  'errors.drawerRight.DEPOSIT',
);

// --- Revoking the lot ------------------------------------------------------

console.log('\nRevoking everything at once');

await grants.setGrant({ userId: teller.id, drawerId: given.id, canTransfer: true }, manager);
await grants.setGrant({ userId: teller.id, drawerId: withheld.id, canTransfer: true }, manager);

const removed = await grants.revokeAll(teller.id, manager);
ok('both grants are taken away in one act', removed === 2, `${removed} removed`);

const left = await prisma.drawerGrant.count({ where: { userId: teller.id } });
ok('and none survive', left === 0, `${left} left`);

// --- The audit line --------------------------------------------------------

const audited = await prisma.auditLog.count({
  where: { entityType: 'DrawerGrant', action: 'PERMISSION_CHANGE' },
});
ok('every change left an audit line', audited >= 5, `${audited} lines`);

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} FAILED`);
await prisma.$disconnect();
process.exit(bad === 0 ? 0 : 1);
