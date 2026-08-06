import { PrismaClient } from '@prisma/client';
import { generatePassword, hashPassword } from '../src/core/security/scrypt';
import { PERMISSIONS, SYSTEM_ROLES, resolveRolePermissions } from '../src/core/security/permissions';
import { chartForCurrency, ACCOUNT_CODES } from '../src/modules/ledger/accounts';
import { SETTINGS } from '../src/modules/settings/settings.catalog';
import { DEFAULT_SCHEDULE } from '../src/core/jobs/schedule';
import { parseMoney } from '../src/core/money/money';

/**
 * Database seeder.
 *
 * Idempotent by design — every write is an upsert keyed on a natural key, so
 * running it against an existing database refreshes reference data (permissions,
 * the chart of accounts, the schedule) without touching operational records or
 * resetting anybody's password.
 *
 * Demonstration data (customers, rates, a wallet, opening balances) is only
 * created when the database is empty, so a live deployment never grows sample
 * rows after an upgrade.
 */

const prisma = new PrismaClient();

const CURRENCIES = [
  { code: 'ILS', nameEn: 'Israeli Shekel', nameAr: 'شيكل إسرائيلي', symbol: '₪', decimals: 2, kind: 'FIAT', isBase: true, sortOrder: 10 },
  { code: 'USD', nameEn: 'US Dollar', nameAr: 'دولار أمريكي', symbol: '$', decimals: 2, kind: 'FIAT', isBase: false, sortOrder: 20 },
  { code: 'JOD', nameEn: 'Jordanian Dinar', nameAr: 'دينار أردني', symbol: 'د.ا', decimals: 3, kind: 'FIAT', isBase: false, sortOrder: 30 },
  { code: 'USDT', nameEn: 'Tether USD', nameAr: 'تيثر USD', symbol: '₮', decimals: 2, kind: 'CRYPTO', isBase: false, sortOrder: 40 },
];

/**
 * Development accounts. Passwords are printed once at the end of the run and
 * every account is flagged `mustChangePassword`, so none of these can survive
 * into production unchanged.
 */
const USERS = [
  { username: 'admin', email: 'admin@ifms.local', fullNameEn: 'Manager', fullNameAr: 'المدير', jobTitleEn: 'Manager', jobTitleAr: 'المدير', role: 'ADMIN', password: 'Admin!Pass2026' },
  { username: 'teller', email: 'teller@ifms.local', fullNameEn: 'Front Desk Teller', fullNameAr: 'موظف الواجهة', jobTitleEn: 'Teller', jobTitleAr: 'التلر', role: 'TELLER', password: 'Teller!Pass2026' },
];

/** Indicative mid-market rates; the desk publishes its own on day one. */
const RATES = [
  { baseCode: 'USD', quoteCode: 'ILS', buy: '3.6200', sell: '3.7100' },
  { baseCode: 'JOD', quoteCode: 'ILS', buy: '5.0800', sell: '5.2400' },
  { baseCode: 'USDT', quoteCode: 'ILS', buy: '3.6000', sell: '3.7300' },
  { baseCode: 'USD', quoteCode: 'JOD', buy: '0.7050', sell: '0.7150' },
];

async function main() {
  console.log('▶ Seeding IFMS…\n');

  // Governs both demonstration records and which accounts get provisioned.
  // Never true in production unless explicitly forced.
  const allowDemoData =
    process.env.SEED_DEMO_DATA === 'true' ||
    (process.env.SEED_DEMO_DATA !== 'false' && process.env.NODE_ENV !== 'production');

  // --- Branch ---------------------------------------------------------------
  const branch = await prisma.branch.upsert({
    where: { code: 'HQ' },
    create: {
      code: 'HQ',
      nameEn: 'Head Office',
      nameAr: 'المركز الرئيسي',
      address: 'Main Street',
      timezone: 'Asia/Hebron',
    },
    update: {},
  });
  console.log(`  branch          ${branch.code}`);

  // --- Currencies -----------------------------------------------------------
  for (const currency of CURRENCIES) {
    await prisma.currency.upsert({
      where: { code: currency.code },
      create: currency,
      update: {
        nameEn: currency.nameEn,
        nameAr: currency.nameAr,
        symbol: currency.symbol,
        decimals: currency.decimals,
        sortOrder: currency.sortOrder,
      },
    });
  }
  console.log(`  currencies      ${CURRENCIES.length}`);

  // --- Chart of accounts ----------------------------------------------------
  let accountCount = 0;
  for (const currency of CURRENCIES) {
    for (const blueprint of chartForCurrency(currency.code, {
      isCrypto: currency.kind === 'CRYPTO',
    })) {
      await prisma.account.upsert({
        where: { code: blueprint.code },
        create: { ...blueprint, branchId: branch.id },
        update: {
          nameEn: blueprint.nameEn,
          nameAr: blueprint.nameAr,
          allowNegative: blueprint.allowNegative,
          sortOrder: blueprint.sortOrder,
        },
      });
      accountCount++;
    }
  }
  console.log(`  accounts        ${accountCount}`);

  // --- Permissions ----------------------------------------------------------
  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      create: {
        key: permission.key,
        module: permission.module,
        action: permission.action,
        nameEn: permission.nameEn,
        nameAr: permission.nameAr,
        description: permission.descriptionEn,
        isSensitive: permission.isSensitive ?? false,
      },
      update: {
        module: permission.module,
        nameEn: permission.nameEn,
        nameAr: permission.nameAr,
        description: permission.descriptionEn,
        isSensitive: permission.isSensitive ?? false,
      },
    });
  }
  console.log(`  permissions     ${PERMISSIONS.length}`);

  // --- Roles ----------------------------------------------------------------
  const roleIdByKey = new Map<string, string>();

  for (const definition of SYSTEM_ROLES) {
    const role = await prisma.role.upsert({
      where: { key: definition.key },
      create: {
        key: definition.key,
        nameEn: definition.nameEn,
        nameAr: definition.nameAr,
        description: definition.descriptionEn,
        level: definition.level,
        isSystem: true,
      },
      update: {
        nameEn: definition.nameEn,
        nameAr: definition.nameAr,
        description: definition.descriptionEn,
        level: definition.level,
      },
    });
    roleIdByKey.set(definition.key, role.id);

    const keys = resolveRolePermissions(definition);
    const permissions = await prisma.permission.findMany({ where: { key: { in: keys } } });

    // Replace wholesale so a permission removed from the catalogue is also
    // revoked from the role on the next run.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id })),
    });
  }
  console.log(`  roles           ${SYSTEM_ROLES.length}`);

  // --- Retire roles removed from the catalogue -------------------------------
  //
  // Deleting a role here cascades to its permissions and its user assignments,
  // so a user who held only that role is left with none — and therefore with no
  // permissions at all. That is the safe direction (access fails closed rather
  // than lingering), but it must never happen silently: the affected accounts
  // are reported so an administrator can reassign them.
  //
  // Only system roles are pruned. A role an administrator created through the
  // UI is theirs, and is left alone.
  const obsolete = await prisma.role.findMany({
    where: { isSystem: true, key: { notIn: SYSTEM_ROLES.map((r) => r.key) } },
    include: { users: { include: { user: { select: { id: true, username: true } } } } },
  });

  if (obsolete.length > 0) {
    const stranded = new Map<string, string>();

    for (const role of obsolete) {
      for (const assignment of role.users) {
        // Count the roles this user will still hold once the pruning is done.
        const remaining = await prisma.userRole.count({
          where: {
            userId: assignment.userId,
            role: { key: { in: SYSTEM_ROLES.map((r) => r.key) } },
          },
        });
        if (remaining === 0) stranded.set(assignment.user.username, role.key);
      }

      await prisma.role.delete({ where: { id: role.id } });
    }

    console.log(`  retired roles   ${obsolete.map((r) => r.key).join(', ')}`);

    if (stranded.size > 0) {
      console.log('');
      console.log('  ⚠  These accounts now hold no role and can sign in but do nothing:');
      for (const [username, previousRole] of stranded) {
        console.log(`       ${username.padEnd(14)} (was ${previousRole})`);
      }
      console.log('     Assign a role under Administration → Users, or disable them.');
      console.log('');
    }
  }

  // --- Settings -------------------------------------------------------------
  for (const setting of SETTINGS) {
    await prisma.systemSetting.upsert({
      where: { key: setting.key },
      create: {
        key: setting.key,
        value: JSON.stringify(setting.defaultValue),
        valueType: setting.type,
        category: setting.category,
        isSecret: setting.isSensitive ?? false,
        description: setting.descriptionEn,
      },
      // Never overwrite a value an administrator has configured.
      update: { category: setting.category, description: setting.descriptionEn },
    });
  }
  console.log(`  settings        ${SETTINGS.length}`);

  // --- Scheduled tasks -------------------------------------------------------
  for (const task of DEFAULT_SCHEDULE) {
    await prisma.scheduledTask.upsert({
      where: { key: task.key },
      create: { ...task, nextRunAt: new Date(Date.now() + 60_000) },
      update: { nameEn: task.nameEn, nameAr: task.nameAr, jobName: task.jobName },
    });
  }
  console.log(`  scheduled tasks ${DEFAULT_SCHEDULE.length}`);

  // --- System account --------------------------------------------------------
  // Owns records the system creates on its own — auto-generated USDT
  // transactions, automatic backups — so those are never attributed to a person.
  await prisma.user.upsert({
    where: { username: 'system' },
    create: {
      username: 'system',
      email: 'system@ifms.local',
      fullNameEn: 'System',
      fullNameAr: 'النظام',
      // Not a usable credential: no plaintext hashes to this value.
      passwordHash: 'system-account-cannot-sign-in',
      status: 'DISABLED',
      isSystem: true,
      branchId: branch.id,
    },
    update: {},
  });

  // --- Users -----------------------------------------------------------------
  //
  // In production only the administrator is provisioned, and never with the
  // fixed development password — those are published in the README, which
  // would make every deployment trivially compromised. The password comes from
  // ADMIN_PASSWORD if supplied, otherwise it is generated and printed once to
  // the deploy log.
  const created: { username: string; password: string; role: string }[] = [];

  const accountsToCreate = allowDemoData
    ? USERS
    : USERS.filter((user) => user.role === 'ADMIN').map((user) => ({
        ...user,
        password: process.env.ADMIN_PASSWORD || generatePassword(16),
      }));

  for (const user of accountsToCreate) {
    const existing = await prisma.user.findUnique({ where: { username: user.username } });
    if (existing) continue;

    const account = await prisma.user.create({
      data: {
        username: user.username,
        email: user.email,
        fullNameEn: user.fullNameEn,
        fullNameAr: user.fullNameAr,
        jobTitleEn: user.jobTitleEn,
        jobTitleAr: user.jobTitleAr,
        passwordHash: await hashPassword(user.password),
        // Every seeded account must be re-credentialed before real use.
        mustChangePassword: true,
        status: 'ACTIVE',
        locale: 'ar',
        branchId: branch.id,
        roles: { create: { roleId: roleIdByKey.get(user.role)! } },
      },
    });

    await prisma.passwordHistory.create({
      data: { userId: account.id, hash: account.passwordHash },
    });

    created.push({ username: user.username, password: user.password, role: user.role });
  }
  console.log(
    `  users           ${created.length} created, ${accountsToCreate.length - created.length} existing`,
  );

  // --- Demonstration data ------------------------------------------------------
  //
  // Never seeded into production. Indicative rates and sample customers are
  // useful on a developer's machine and actively dangerous on a live desk: a
  // teller could trade against a placeholder rate that nobody published. With
  // no rates, pricing fails closed until an administrator publishes real ones,
  // which is the correct behaviour on day one.
  const hasRates = (await prisma.exchangeRate.count()) > 0;

  if (!allowDemoData) {
    console.log('  demo data       skipped (production — publish real rates in the UI)');
  } else if (!hasRates) {
    const admin = await prisma.user.findUnique({ where: { username: 'admin' } });

    for (const rate of RATES) {
      const buyRate = parseMoney(rate.buy);
      const sellRate = parseMoney(rate.sell);

      await prisma.exchangeRate.create({
        data: {
          baseCode: rate.baseCode,
          quoteCode: rate.quoteCode,
          buyRate,
          sellRate,
          midRate: (buyRate + sellRate) / 2n,
          source: 'MANUAL',
          note: 'Initial rate board',
          createdById: admin?.id ?? null,
        },
      });
    }
    console.log(`  rates           ${RATES.length}`);

    // Opening balances, posted as a proper balanced journal entry per currency
    // rather than written directly to the accounts — the ledger is the only
    // thing permitted to move a balance, including at go-live.
    const openingBalances: { currency: string; amount: string }[] = [
      { currency: 'ILS', amount: '250000' },
      { currency: 'USD', amount: '80000' },
      { currency: 'JOD', amount: '30000' },
      { currency: 'USDT', amount: '50000' },
    ];

    let sequence = 0;
    for (const opening of openingBalances) {
      const currency = CURRENCIES.find((c) => c.code === opening.currency)!;
      const assetCode =
        currency.kind === 'CRYPTO'
          ? ACCOUNT_CODES.crypto(opening.currency)
          : ACCOUNT_CODES.cash(opening.currency);

      const [asset, equity] = await Promise.all([
        prisma.account.findUnique({ where: { code: assetCode } }),
        prisma.account.findUnique({ where: { code: ACCOUNT_CODES.openingBalance(opening.currency) } }),
      ]);
      if (!asset || !equity) continue;

      const amount = parseMoney(opening.amount);
      sequence++;

      await prisma.$transaction(async (tx) => {
        const entry = await tx.journalEntry.create({
          data: {
            reference: `JRN-OPENING-${String(sequence).padStart(3, '0')}`,
            description: `Opening balance — ${opening.currency}`,
            descriptionAr: `رصيد افتتاحي — ${opening.currency}`,
          },
        });

        await tx.journalLine.createMany({
          data: [
            {
              entryId: entry.id,
              accountId: asset.id,
              currencyCode: opening.currency,
              debit: amount,
              credit: 0n,
              balanceAfter: amount,
              memo: 'Opening balance',
              sequence: 0,
            },
            {
              entryId: entry.id,
              accountId: equity.id,
              currencyCode: opening.currency,
              debit: 0n,
              credit: amount,
              balanceAfter: amount,
              memo: 'Opening balance',
              sequence: 1,
            },
          ],
        });

        await tx.account.update({ where: { id: asset.id }, data: { balance: amount } });
        await tx.account.update({ where: { id: equity.id }, data: { balance: amount } });
      });
    }
    console.log(`  opening entries ${sequence}`);

    // Sample customers
    const customers = [
      { code: 'CUS-000001', fullNameEn: 'Ahmad Mahmoud', fullNameAr: 'أحمد محمود', phone: '0599123456', nationalId: '401234567', kycStatus: 'VERIFIED' },
      { code: 'CUS-000002', fullNameEn: 'Layla Hassan', fullNameAr: 'ليلى حسن', phone: '0567891234', nationalId: '402345678', kycStatus: 'VERIFIED' },
      { code: 'CUS-000003', fullNameEn: 'Nour Trading Co.', fullNameAr: 'شركة نور التجارية', phone: '0227654321', taxNumber: '556677889', kycStatus: 'PENDING', type: 'COMPANY' },
    ];

    for (const customer of customers) {
      await prisma.customer.upsert({
        where: { code: customer.code },
        create: { ...customer, branchId: branch.id, city: 'Ramallah', country: 'PS' },
        update: {},
      });
    }

    // Keep the reference counter ahead of the codes just inserted.
    await prisma.sequence.upsert({
      where: { key: 'CUS:ALL' },
      create: { key: 'CUS:ALL', value: customers.length },
      update: { value: customers.length },
    });
    console.log(`  customers       ${customers.length}`);

    // A monitored wallet on the MANUAL network.
    //
    // Deliberately not TRON: a placeholder address is not a real one, and
    // pointing a live provider at it would fail validation on every sync cycle
    // and fill the log with errors that look like an outage. Add real addresses
    // through the UI, where the provider validates them on entry.
    const cryptoAccount = await prisma.account.findUnique({
      where: { code: ACCOUNT_CODES.crypto('USDT') },
    });

    await prisma.wallet.upsert({
      where: {
        network_address_tokenSymbol: {
          network: 'MANUAL',
          address: 'TREASURY-USDT-DEMO',
          tokenSymbol: 'USDT',
        },
      },
      create: {
        label: 'Main Treasury Wallet',
        labelAr: 'محفظة الخزينة الرئيسية',
        network: 'MANUAL',
        address: 'TREASURY-USDT-DEMO',
        tokenSymbol: 'USDT',
        isWatchOnly: true,
        minConfirmations: 19,
        accountId: cryptoAccount?.id ?? null,
        balance: parseMoney('50000'),
        balanceUpdatedAt: new Date(),
        lastSyncStatus: 'NEVER',
      },
      update: {},
    });
    console.log('  wallets         1 (manual — add real addresses in the UI)');
  } else {
    console.log('  demo data       skipped (database already has rates)');
  }

  // --- Summary ----------------------------------------------------------------
  console.log('\n✔ Seed complete.\n');

  if (created.length > 0) {
    console.log('  Sign-in accounts — every one must change its password on first use:\n');
    for (const user of created) {
      console.log(`    ${user.username.padEnd(12)} ${user.password.padEnd(20)} ${user.role}`);
    }

    if (allowDemoData) {
      console.log('\n  ⚠  Development credentials. Change them before any real use,');
      console.log('     and set a strong AUTH_SECRET before deploying.\n');
    } else {
      console.log('\n  ⚠  This password is shown ONCE and only in this deploy log.');
      console.log('     Sign in, change it immediately, then create real accounts.\n');
    }
  }
}

main()
  .catch((error) => {
    console.error('\n✖ Seed failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
