import { PrismaClient } from '@prisma/client';
import { generatePassword, hashPassword } from '../src/core/security/scrypt';
import { PERMISSIONS, SYSTEM_ROLES, resolveRolePermissions } from '../src/core/security/permissions';
import { chartForCurrency } from '../src/modules/ledger/accounts';
import { SETTINGS } from '../src/modules/settings/settings.catalog';
import { DEFAULT_SCHEDULE } from '../src/core/jobs/schedule';

/**
 * Database seeder.
 *
 * Installs **reference data only** — the branch, currencies, chart of accounts,
 * permissions, roles, settings, the background schedule, and the accounts needed
 * to sign in. Nothing operational.
 *
 * There are deliberately no sample customers, no exchange rates and no opening
 * balances. Invented rates are dangerous on a live desk — a teller can trade
 * against a placeholder nobody remembered to replace — and invented balances
 * mean the books disagree with the drawer from the first day. With no rates
 * published, pricing fails closed until a manager publishes real ones.
 *
 * Idempotent: every write is an upsert on a natural key, so re-running against
 * an existing database refreshes reference data without touching operational
 * records or resetting anybody's password.
 */

const prisma = new PrismaClient();

const CURRENCIES = [
  { code: 'ILS', nameEn: 'Israeli Shekel', nameAr: 'شيكل إسرائيلي', symbol: '₪', decimals: 2, kind: 'FIAT', isBase: true, sortOrder: 10 },
  { code: 'USD', nameEn: 'US Dollar', nameAr: 'دولار أمريكي', symbol: '$', decimals: 2, kind: 'FIAT', isBase: false, sortOrder: 20 },
  { code: 'JOD', nameEn: 'Jordanian Dinar', nameAr: 'دينار أردني', symbol: 'د.ا', decimals: 3, kind: 'FIAT', isBase: false, sortOrder: 30 },
  { code: 'USDT', nameEn: 'Tether USD', nameAr: 'تيثر USD', symbol: '₮', decimals: 2, kind: 'CRYPTO', isBase: false, sortOrder: 40 },
];

/**
 * The accounts needed to sign in on a fresh installation.
 *
 * Every one is flagged `mustChangePassword`, and outside development only the
 * manager is created — with a generated password printed once to the deploy log.
 * The manager then creates real staff accounts through the interface.
 */
const USERS = [
  { username: 'admin', email: 'admin@ifms.local', fullNameEn: 'Manager', fullNameAr: 'المدير', jobTitleEn: 'Manager', jobTitleAr: 'المدير', role: 'ADMIN', password: 'Admin!Pass2026' },
  { username: 'teller', email: 'teller@ifms.local', fullNameEn: 'Front Desk Teller', fullNameAr: 'موظف الواجهة', jobTitleEn: 'Teller', jobTitleAr: 'التلر', role: 'TELLER', password: 'Teller!Pass2026' },
];

async function main() {
  console.log('▶ Seeding IFMS…\n');

  // Whether to provision the extra teller account with a known password for
  // local testing. A production install gets the manager alone, with a password
  // that is generated rather than written down anywhere.
  const seedTestAccounts =
    process.env.SEED_TEST_ACCOUNTS === 'true' ||
    (process.env.SEED_TEST_ACCOUNTS !== 'false' && process.env.NODE_ENV !== 'production');

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
  // In production only the manager is provisioned, and never with the fixed
  // development password — those are published in the README, which would make
  // every deployment trivially compromised. The password comes from
  // ADMIN_PASSWORD if supplied, otherwise it is generated and printed once to
  // the deploy log.
  const created: { username: string; password: string; role: string }[] = [];

  const accountsToCreate = seedTestAccounts
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

  // --- Summary ----------------------------------------------------------------
  console.log('\n✔ Seed complete — reference data only, no operational records.\n');

  if (created.length > 0) {
    console.log('  Sign-in accounts — every one must change its password on first use:\n');
    for (const user of created) {
      console.log(`    ${user.username.padEnd(12)} ${user.password.padEnd(20)} ${user.role}`);
    }

    if (seedTestAccounts) {
      console.log('\n  ⚠  Development credentials. Change them before any real use,');
      console.log('     and set a strong AUTH_SECRET before deploying.');
    } else {
      console.log('\n  ⚠  This password is shown ONCE and only in this deploy log.');
      console.log('     Sign in and change it immediately.');
    }
  }

  // The system is deliberately empty. Say what has to happen before it can be
  // used, so nobody discovers it at the counter with a customer waiting.
  console.log('\n  Before the first transaction:\n');
  console.log('    1. Exchange → Rates        publish a rate for every pair you trade.');
  console.log('                               Until then pricing refuses to quote.');
  console.log('    2. Daily Closing           open the business day.');
  console.log('    3. Transactions → New      enter opening balances as an Internal');
  console.log('                               Adjustment, one per currency:');
  console.log('                               From "Opening Balance" → To "Cash Drawer".');
  console.log('    4. Administration → Users  create the real staff accounts.\n');
  console.log('  Recording a transaction posts it — there is no approval step.');
  console.log('  A posting that turns out to be wrong is reversed, which leaves');
  console.log('  both entries in the ledger rather than erasing the mistake.\n');
}

main()
  .catch((error) => {
    console.error('\n✖ Seed failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
