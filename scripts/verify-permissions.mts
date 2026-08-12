import { prisma } from '../src/core/db/prisma';
import * as users from '../src/modules/users/users.service';
import * as machine from '../src/modules/exchange/machine.service';
import * as rates from '../src/modules/exchange/rates.service';
import * as drawers from '../src/modules/drawers/drawer.service';
import * as handovers from '../src/modules/treasury/handover.service';
import * as day from '../src/modules/exchange/business-day.service';
import * as settings from '../src/modules/settings/settings.service';
import { ceilingFor } from '../src/modules/users/counter-limit';

/**
 * What one person may do, and how far.
 *
 * Two separate claims: that a denial written for a named person survives into
 * the permissions a session resolves — the thing every guard in the system then
 * reads — and that a ceiling set for that person actually stops money, with the
 * stricter of his and the office's applying either way round.
 */

const unit = 100000000n;
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
    'users.roles.assign',
    'users.update',
    'treasury.handover.manage',
    'exchange.drawer.manage',
    'exchange.day.open',
    'exchange.rate.manage',
  ],
};
const clerk = {
  id: teller.id,
  name: 'التلر',
  branchId: branch.id,
  permissions: ['exchange.machine.use', 'exchange.transaction.create', 'treasury.handover.receive'],
};

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
await rates.publishRate(
  { baseCode: 'USD', quoteCode: 'ILS', channel: 'CASH', buyRate: 355000000n, sellRate: 365000000n },
  manager,
);

// He sells dollars in this check, so he has to be holding some.
const float = [
  { currency: 'ILS', amount: 100000n * unit },
  { currency: 'USD', amount: 5000n * unit },
];
const bag = await handovers.create({ direction: 'TO_TELLER', tellerId: teller.id, lines: float }, manager);
await handovers.confirm(bag.id, float, clerk);

// === A denial written for one person ======================================
console.log('\n— المنع لشخص بعينه —');

await users.setUserPermissionOverrides(
  teller.id,
  [{ permissionKey: 'exchange.remittance.use', effect: 'DENY', reason: 'قرار المدير' }],
  manager,
);

const written = await prisma.userPermission.findFirst({
  where: { userId: teller.id },
  include: { permission: true },
});
ok('the denial is on his record', written?.permission.key === 'exchange.remittance.use');
ok('and it is a denial, not a grant', written?.effect === 'DENY');

/*
 * Resolved the way a session resolves it: the role grants, the override denies,
 * and denial wins. This mirrors `session.service`, and the point of checking it
 * here is that every guard in the system reads the result of exactly this.
 */
const resolve = async (userId: string): Promise<Set<string>> => {
  const row = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: {
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
      permissions: { include: { permission: true } },
    },
  });
  const granted = new Set<string>();
  const denied = new Set<string>();
  for (const userRole of row.roles) {
    if (!userRole.role.isActive) continue;
    for (const entry of userRole.role.permissions) granted.add(entry.permission.key);
  }
  for (const override of row.permissions) {
    if (override.expiresAt && override.expiresAt <= new Date()) continue;
    if (override.effect === 'DENY') denied.add(override.permission.key);
    else granted.add(override.permission.key);
  }
  return new Set([...granted].filter((key) => !denied.has(key)));
};

const after = await resolve(teller.id);
ok('the role no longer reaches him', !after.has('exchange.remittance.use'));
ok('and the rest of his tools are untouched', after.has('exchange.machine.use'));

// A grant on top of a role that does not give it.
await users.setUserPermissionOverrides(
  teller.id,
  [
    { permissionKey: 'exchange.remittance.use', effect: 'DENY' },
    { permissionKey: 'exchange.rate.view', effect: 'ALLOW' },
  ],
  manager,
);
const widened = await resolve(teller.id);
ok('a grant reaches him without touching the role', widened.has('exchange.rate.view'));
ok('and the denial still stands beside it', !widened.has('exchange.remittance.use'));

// === The ceiling ==========================================================
console.log('\n— السقف —');

const office = await settings.getMoney('machine.maxAmount');
ok('the office has no ceiling to begin with', office === 0n, office.toString());

// 2,000 shekels of his own, and nothing from the office.
await users.updateUser(teller.id, { counterLimit: 2000n * unit }, manager);
ok('his ceiling binds when the office has none', (await ceilingFor(teller.id, 0n)) === 2000n * unit);

await machine.record(
  { fromCurrency: 'ILS', toCurrency: 'USD', mode: 'CASH', fromAmount: 1500n * unit, branchId: branch.id },
  clerk,
);
ok('he may trade below it', true);

await refused(
  'and is stopped above it',
  () =>
    machine.record(
      { fromCurrency: 'ILS', toCurrency: 'USD', mode: 'CASH', fromAmount: 2500n * unit, branchId: branch.id },
      clerk,
    ),
  'errors.machineOverLimit',
);

// The manager, who has no ceiling of his own, is not touched by the teller's.
ok('it is his alone', (await ceilingFor(admin.id, 0n)) === 0n);

// Now the office sets a tighter one. The stricter of the two must win, whichever
// of them it happens to be.
await settings.set('machine.maxAmount', '1000', manager);
ok(
  "the office's binds when it is tighter",
  (await ceilingFor(teller.id, await settings.getMoney('machine.maxAmount'))) === 1000n * unit,
);
await refused(
  'so a deal his own ceiling would allow is still refused',
  () =>
    machine.record(
      { fromCurrency: 'ILS', toCurrency: 'USD', mode: 'CASH', fromAmount: 1500n * unit, branchId: branch.id },
      clerk,
    ),
  'errors.machineOverLimit',
);

// And clearing his own puts him back on the office's, not on nothing.
await users.updateUser(teller.id, { counterLimit: null }, manager);
ok(
  'clearing his own leaves the office ceiling standing',
  (await ceilingFor(teller.id, await settings.getMoney('machine.maxAmount'))) === 1000n * unit,
);

// === It takes effect at once ==============================================
console.log('\n— يسري فوراً —');
const live = await prisma.session.count({ where: { userId: teller.id, revokedAt: null } });
ok('no live session survives a change to his permissions', live === 0, String(live));

const check = await drawers.verifyBalances();
ok('every balance still agrees with its movements', check.ok);

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} FAILED`);
await prisma.$disconnect();
process.exit(bad === 0 ? 0 : 1);
