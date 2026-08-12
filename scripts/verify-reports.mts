import ExcelJS from 'exceljs';
import { prisma } from '../src/core/db/prisma';
import * as reports from '../src/modules/reports/report.service';
import { REPORTS } from '../src/modules/reports/report.catalog';
import * as machine from '../src/modules/exchange/machine.service';
import * as rates from '../src/modules/exchange/rates.service';
import * as cutoff from '../src/modules/ledger/cutoff.service';
import * as drawers from '../src/modules/drawers/drawer.service';
import * as handovers from '../src/modules/treasury/handover.service';
import * as day from '../src/modules/exchange/business-day.service';

/**
 * The reports, and the spreadsheet they become.
 *
 * The claim being tested is not that a file appears — it is that the file is a
 * real workbook whose money is money: selectable, summable, and equal to what
 * the database holds down to the last agura.
 */

const unit = 100000000n;
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
    'ledger.view',
    'exchange.transaction.viewAll',
    'exchange.drawer.view',
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
  { baseCode: 'USD', quoteCode: 'ILS', channel: 'CASH', buyRate: 350000000n, sellRate: 360000000n },
  manager,
);
await cutoff.setRate({ currencyCode: 'USD', rate: 355000000n }, manager);

const float = [
  { currency: 'ILS', amount: 50000n * unit },
  { currency: 'USD', amount: 5000n * unit },
];
const bag = await handovers.create(
  { direction: 'TO_TELLER', tellerId: teller.id, lines: float },
  manager,
);
await handovers.confirm(bag.id, float, clerk);

// Three deals, so there is something with a margin to add up.
for (let i = 0; i < 3; i++) {
  await machine.record(
    { fromCurrency: 'USD', toCurrency: 'ILS', mode: 'CASH', fromAmount: 500n * unit, branchId: branch.id },
    clerk,
  );
}

const from = new Date(Date.now() - 86_400_000);
const to = new Date(Date.now() + 86_400_000);
const filters = { branchId: branch.id, from, to };

// === Every report runs ======================================================
console.log('\n— كل تقرير يعمل —');
for (const definition of REPORTS) {
  const ran = await reports.run(definition.key, filters, manager);
  ok(`${definition.key} runs and knows its own columns`, ran.columns.length > 0, `${ran.count} rows`);
  ok(
    `${definition.key}: every column has a label in both languages`,
    ran.columns.every((column) => column.labelAr.length > 0 && column.labelEn.length > 0),
  );
}

// === Nobody runs what they may not read =====================================
console.log('\n— لا أحد يقرأ ما ليس له —');
let refused = false;
try {
  await reports.run('tellers', filters, { ...manager, permissions: ['exchange.transaction.viewAll'] });
} catch {
  refused = true;
}
ok('a report refuses somebody without its own permission', refused);
ok(
  'and the list offered is only what they hold',
  reports.availableTo(['exchange.drawer.view']).map((r) => r.key).join(',') === 'movements',
  reports.availableTo(['exchange.drawer.view']).map((r) => r.key).join(','),
);

// === The spreadsheet ========================================================
console.log('\n— ملف Excel —');
const ran = await reports.run('transactions', filters, manager);
const decimals = new Map(
  (await prisma.currency.findMany({ select: { code: true, decimals: true } })).map((c) => [
    c.code,
    c.decimals,
  ]),
);
const buffer = await reports.toWorkbook(ran, 'ar', decimals);

ok('a file comes out', buffer.byteLength > 0, `${Math.round(buffer.byteLength / 1024)} kB`);
ok('and it is a real zip-backed workbook', buffer.subarray(0, 2).toString() === 'PK');

// Read it back the way a spreadsheet would.
const book = new ExcelJS.Workbook();
await book.xlsx.load(new Uint8Array(buffer) as never);
const sheet = book.worksheets[0]!;

ok('it opens right-to-left for an Arabic reader', sheet.views[0]?.rightToLeft === true);
ok('the header is the Arabic labels', sheet.getRow(1).getCell(1).value === 'الرقم', String(sheet.getRow(1).getCell(1).value));
ok('every row is there', sheet.rowCount - 1 === ran.count, `${sheet.rowCount - 1} of ${ran.count}`);

/*
 * The point of the whole exercise: select the margin column and the total is
 * right. Written as text it would read the same on screen and add to nothing.
 */
const marginColumn = ran.columns.findIndex((column) => column.key === 'margin') + 1;
let sheetTotal = 0;
for (let row = 2; row <= sheet.rowCount; row++) {
  const cell = sheet.getRow(row).getCell(marginColumn);
  ok(`row ${row}: the margin is a number, not text`, typeof cell.value === 'number', typeof cell.value);
  sheetTotal += Number(cell.value ?? 0);
}

const dbTotal = ran.rows.reduce((total, row) => total + (row.margin as bigint), 0n);
ok(
  'and the column adds up to what the database holds',
  Math.round(sheetTotal * 100) === Number(dbTotal / 1000000n),
  `${sheetTotal.toFixed(2)} vs ${(Number(dbTotal) / 1e8).toFixed(2)}`,
);

ok(
  'money carries a money format',
  String(sheet.getRow(2).getCell(marginColumn).numFmt ?? '').includes('0.00'),
  String(sheet.getRow(2).getCell(marginColumn).numFmt),
);

// === Taking the books out is written down ===================================
console.log('\n— التصدير يُسجَّل —');
await reports.recordExport(ran, 'xlsx', manager);
const noted = await prisma.auditLog.findFirst({
  where: { action: 'EXPORT', entityType: 'Report' },
  orderBy: { at: 'desc' },
});
ok('an export leaves a trail', noted !== null, noted?.summaryAr ?? '');

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} FAILED`);
await prisma.$disconnect();
process.exit(bad === 0 ? 0 : 1);
