import { prisma } from '../src/core/db/prisma';
import * as machine from '../src/modules/exchange/machine.service';
import * as day from '../src/modules/exchange/business-day.service';

/**
 * A transfer belongs to somebody the office can name and reach.
 *
 * Cash across a counter is anonymous by its nature. A transfer is not: it
 * leaves a trail with the broker's name on it, and the office is the only
 * party that knows whose money it was. An office that cannot say who a
 * transfer was for has a problem it discovers on the day somebody asks.
 *
 * So this pins three things — the refusal without a name, the refusal without
 * a number, and that the posting's own audit line spells the transfer out:
 * how much of it went by bank, to which account, and for whom. The last is the
 * part that matters a year later, when the figures are the only witness left.
 */

const unit = 100000000n;
let bad = 0;
const ok = (l: string, c: boolean, e = '') => { if (!c) bad++; console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${e ? ' — ' + e : ''}`); };
const refused = async (l: string, run: () => Promise<unknown>, key?: string) => {
  try { await run(); ok(l, false, 'it went through'); }
  catch (e) { const k = (e as { messageKey?: string }).messageKey; ok(l, key ? k === key : true, k ?? String(e)); }
};

const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
const branch = await prisma.branch.findFirstOrThrow();
const actor = { id: admin.id, name: 'م', branchId: branch.id,
  permissions: ['exchange.machine.use', 'exchange.transaction.create', 'exchange.day.open'] };
await day.openDay(branch.id, actor).catch(() => {});
const channels = await machine.transferChannels();

const deal = (extra: Record<string, unknown>) => ({
  fromCurrency: 'ILS', toCurrency: 'USD', mode: 'BROKER' as const,
  fromAmount: 100n * unit, payoutChannel: channels[0], branchId: branch.id, ...extra,
});

console.log('\n— a transfer without a person —');
await refused('no name at all is refused', () => machine.record(deal({}), actor), 'errors.transferNeedsCustomer');
await refused('a name with no number is refused',
  () => machine.record(deal({ counterpartyName: 'أبو خالد' }), actor), 'errors.transferNeedsPhone');

console.log('\n— and with both, it goes —');
const posted = await machine.record(
  deal({ counterpartyName: 'أبو خالد', counterpartyPhone: '0599123456' }), actor,
);
const row = await prisma.transaction.findUniqueOrThrow({
  where: { id: posted.id },
  select: { counterpartyName: true, counterpartyPhone: true, payoutBankAmount: true, payoutBankChannel: true },
});
ok('the name is kept', row.counterpartyName === 'أبو خالد', String(row.counterpartyName));
ok('and the number', row.counterpartyPhone === '0599123456', String(row.counterpartyPhone));

console.log('\n— and the log says what happened, in detail —');
const line = await prisma.auditLog.findFirst({
  where: { entityId: posted.id, action: 'POST' },
  select: { summaryAr: true, afterData: true },
});
console.log('   ' + (line?.summaryAr ?? '(none)'));
ok('the audit line names the transfer', /حوالة/.test(line?.summaryAr ?? ''));
ok('and where it went', line?.summaryAr?.includes(channels[0] ?? '') ?? false);
ok('and who it was for, with the number',
   /أبو خالد/.test(line?.summaryAr ?? '') && /0599123456/.test(line?.summaryAr ?? ''));

const after = JSON.parse(line?.afterData ?? '{}');
console.log('   kept:', JSON.stringify({ bank: after.payoutBankAmount, channel: after.payoutBankChannel, phone: after.counterpartyPhone }));
ok('the bank half is recorded on its own', after.payoutBankAmount === row.payoutBankAmount?.toString());

console.log('\n— and a cash-only trade is untouched —');
const cash = await machine.record(
  { fromCurrency: 'ILS', toCurrency: 'USD', mode: 'CASH', fromAmount: 50n * unit, branchId: branch.id },
  actor,
);
const cashLine = await prisma.auditLog.findFirst({
  where: { entityId: cash.id, action: 'POST' }, select: { summaryAr: true },
});
ok('it still records with no name or number', Boolean(cash.reference));
ok('and its line says nothing about a transfer', !/حوالة/.test(cashLine?.summaryAr ?? ''), cashLine?.summaryAr?.slice(0, 70));

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} FAILED`);
await prisma.$disconnect();
process.exit(bad === 0 ? 0 : 1);
