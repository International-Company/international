import { prisma } from '../src/core/db/prisma';
import * as rates from '../src/modules/exchange/rates.service';
import * as drawers from '../src/modules/drawers/drawer.service';
import * as machine from '../src/modules/exchange/machine.service';
import * as day from '../src/modules/exchange/business-day.service';
import * as settings from '../src/modules/settings/settings.service';

/**
 * The split, priced from the figure the customer names.
 *
 * A split used to be divided on the money the customer hands over — seventy
 * dollars through the broker — which is not how the conversation at a counter
 * goes. He says "put two hundred shekels in my account and give me the rest",
 * because two hundred is what will appear on his statement.
 *
 * So the transfer is now sized backwards from that figure, and this pins the
 * two things that makes true and easy to break: the bank leg is *exactly* what
 * was named, and the cash leg is whatever the remainder of his money buys at
 * the till's own price. The first of those cost a rounding argument — sizing
 * 200.00 through 2.85 costs 70.175, the dollar can only say 70.18, and 70.18
 * back through 2.85 is 200.01. Posting that would put a figure on a customer's
 * statement that nobody asked for.
 */

const unit = 100000000n;
const money = (v: bigint) => (Number(v) / 1e8).toFixed(2);
let bad = 0;
const ok = (l: string, c: boolean, e = '') => { if (!c) bad++; console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${e ? ' — ' + e : ''}`); };
const refused = async (l: string, run: () => Promise<unknown>, key?: string) => {
  try { await run(); ok(l, false, 'it went through'); }
  catch (e) { const k = (e as { messageKey?: string }).messageKey; ok(l, key ? k === key : true, k ?? String(e)); }
};

const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
const branch = await prisma.branch.findFirstOrThrow();
const actor = { id: admin.id, name: 'م', branchId: branch.id,
  permissions: ['exchange.machine.use', 'exchange.transaction.create', 'exchange.rate.manage', 'exchange.drawer.manage', 'exchange.day.open', 'settings.manage'] };

await day.openDay(branch.id, actor).catch(() => {});
await settings.set('machine.enabled', true, actor);

// The till pays 2.90 a dollar, the broker 2.85. They must differ.
await prisma.exchangeRate.updateMany({ where: { baseCode: 'USD', quoteCode: 'ILS' }, data: { isActive: false, effectiveTo: new Date() } });
for (const [channel, buy, sell] of [['CASH', 290_000_000n, 300_000_000n], ['BROKER', 285_000_000n, 295_000_000n]] as const) {
  await rates.publishRate({ baseCode: 'USD', quoteCode: 'ILS', channel, buyRate: buy, sellRate: sell, midRate: (buy + sell) / 2n }, actor);
}
for (const kind of ['CASH', 'BROKER'] as const) {
  await drawers.fund({ currency: 'ILS', kind, direction: 'IN', amount: 50_000n * unit, category: 'OWNER_IN' }, actor);
}
const channels = await machine.transferChannels();

console.log('\n— the customer names the transfer, in the money he takes away —');

// 100 USD in. He wants exactly 200.00 ILS to the bank.
const posted = await machine.record(
  { fromCurrency: 'USD', toCurrency: 'ILS', mode: 'SPLIT', fromAmount: 100n * unit,
    brokerPayout: 200n * unit, payoutChannel: channels[0], branchId: branch.id },
  actor,
);

const row = await prisma.transaction.findUniqueOrThrow({
  where: { id: posted.id },
  select: { fromAmount: true, toAmount: true, payoutCashAmount: true, payoutBankAmount: true, rate: true },
});

console.log(`   in ${money(row.fromAmount)} USD → out ${money(row.toAmount)} ILS = cash ${money(row.payoutCashAmount)} + bank ${money(row.payoutBankAmount)}`);

ok('the bank leg is exactly what he asked for', row.payoutBankAmount === 200n * unit, money(row.payoutBankAmount));
ok('the whole hundred was used', row.fromAmount === 100n * unit, money(row.fromAmount));
ok('the two legs add to the payout', row.payoutCashAmount + row.payoutBankAmount === row.toAmount);

// 200 ILS at 2.85 costs 70.175438… USD; the rest, 29.824561… USD, buys 86.49 at 2.90.
// The cost is what the dollar can express: 200 / 2.85 = 70.175…, so 70.18.
const brokerCost = 7018n * 1000000n;
const cashExpected = ((100n * unit - brokerCost) * 290_000_000n) / 100000000n;
console.log(`   expected: bank costs ${money(brokerCost)} USD, cash leg ≈ ${money(cashExpected)} ILS`);
// Compared as the shekel expresses them: the posting rounds to two places and
// the arithmetic above does not.
ok('the cash leg is the remainder at the till’s own price',
   money(row.payoutCashAmount) === money(cashExpected),
   `${money(row.payoutCashAmount)} vs ${money(cashExpected)}`);

console.log('\n— and a transfer bigger than his money is refused —');
await refused(
  'asking to transfer more than the hundred buys',
  () => machine.record(
    { fromCurrency: 'USD', toCurrency: 'ILS', mode: 'SPLIT', fromAmount: 100n * unit,
      brokerPayout: 400n * unit, payoutChannel: channels[0], branchId: branch.id },
    actor,
  ),
  'errors.splitOverPay',
);

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} FAILED`);
await prisma.$disconnect();
process.exit(bad === 0 ? 0 : 1);
