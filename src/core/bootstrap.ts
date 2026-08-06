import 'server-only';
import { prisma } from '@/core/db/prisma';
import { createLogger } from '@/core/logger/logger';
import { registerJob, startWorker } from '@/core/jobs/worker';
import { purgeCompleted } from '@/core/jobs/queue';
import { purgeExpiredSessions } from '@/modules/auth/session.service';
import { registerNotificationSubscribers } from '@/modules/notifications/subscribers';
import * as notifications from '@/modules/notifications/notifications.service';
import * as settings from '@/modules/settings/settings.service';
import * as ledger from '@/modules/ledger/ledger.service';
import * as backup from '@/modules/backup/backup.service';
import { syncAllWallets } from '@/modules/usdt/sync.service';
import { verifyChain } from '@/modules/audit/audit.service';
import { emit } from '@/core/events/bus';
import { ACCOUNT_CODES } from '@/modules/ledger/accounts';

/**
 * Application bootstrap.
 *
 * Registers background job handlers and event subscribers, then starts the
 * worker. Called from the authenticated layout so it runs once the server is
 * actually serving requests — and guarded so Next.js hot reloads and multiple
 * route entry points cannot start a second worker.
 */

const log = createLogger('bootstrap');

const globalForBootstrap = globalThis as unknown as { __ifmsBootstrapped?: boolean };

const SYSTEM_ACTOR = { id: 'system', name: 'System' };

export function bootstrap(): void {
  if (globalForBootstrap.__ifmsBootstrapped) return;
  globalForBootstrap.__ifmsBootstrapped = true;

  registerNotificationSubscribers();
  registerJobHandlers();
  startWorker();

  log.info('Application bootstrapped');
}

function registerJobHandlers(): void {
  // --- USDT ---------------------------------------------------------------
  registerJob('usdt.syncAll', async () => {
    const results = await syncAllWallets();
    return {
      wallets: results.length,
      created: results.reduce((sum, r) => sum + r.created, 0),
      errors: results.filter((r) => r.status === 'ERROR').length,
    };
  });

  registerJob('usdt.syncWallet', async (payload) => {
    const walletId = String(payload.walletId ?? '');
    if (!walletId) throw new Error('walletId is required');

    const { syncWallet } = await import('@/modules/usdt/sync.service');
    return syncWallet(walletId);
  });

  // --- Ledger integrity ----------------------------------------------------
  registerJob('ledger.reconcile', async () => {
    const issues = await ledger.reconcile();

    if (issues.length > 0) {
      await notifications.notify(
        {
          severity: 'CRITICAL',
          eventKey: 'ledger.discrepancy',
          module: 'system',
          titleEn: 'Ledger reconciliation failed',
          titleAr: 'فشل تسوية القيود',
          bodyEn: `${issues.length} account balance(s) disagree with their journal lines. Investigate immediately.`,
          bodyAr: `${issues.length} رصيد حساب لا يطابق قيوده. يجب التحقق فوراً.`,
          link: '/admin/system',
        },
        { permission: 'system.monitor' },
      );
    }

    return { issues: issues.length };
  });

  registerJob('audit.verify', async () => {
    const result = await verifyChain();

    if (!result.valid) {
      await notifications.notify(
        {
          severity: 'CRITICAL',
          eventKey: 'audit.chainBroken',
          module: 'audit',
          titleEn: 'Audit chain integrity failure',
          titleAr: 'فشل سلامة سلسلة التدقيق',
          bodyEn: result.reason ?? 'The audit chain could not be verified.',
          bodyAr: 'تعذّر التحقق من سلامة سلسلة التدقيق.',
          link: '/admin/audit',
        },
        { permission: 'audit.view' },
      );
    }

    return { valid: result.valid, checked: result.checked };
  });

  // --- Balance monitoring --------------------------------------------------
  registerJob('accounts.checkBalances', async () => {
    const threshold = await settings.getMoney('operations.lowBalanceThreshold');
    if (threshold <= 0n) return { checked: 0, alerts: 0 };

    const accounts = await prisma.account.findMany({
      where: { isActive: true, kind: { in: ['CASH', 'BANK'] } },
    });

    let alerts = 0;
    for (const account of accounts) {
      // Only cash-like asset accounts are meaningful here; a clearing account
      // sitting negative is normal trading, not a shortage.
      if (account.code.startsWith(ACCOUNT_CODES.fxPosition(''))) continue;

      if (account.balance < threshold) {
        alerts++;
        await emit('account.balance.low', {
          accountId: account.id,
          code: account.code,
          balance: account.balance.toString(),
          threshold: threshold.toString(),
        });
      }
    }

    return { checked: accounts.length, alerts };
  });

  // --- Backups -------------------------------------------------------------
  registerJob('backup.automatic', async () => {
    if (!(await settings.getBoolean('backup.automatic'))) {
      return { skipped: 'disabled' };
    }

    const result = await backup.createBackup(SYSTEM_ACTOR, { type: 'AUTOMATIC' });
    const keep = await settings.getNumber('backup.retentionCount');
    const pruned = await backup.pruneBackups(keep);

    return { filename: result.filename, pruned };
  });

  // --- Housekeeping --------------------------------------------------------
  registerJob('maintenance.purge', async () => {
    const retentionDays = await settings.getNumber('notifications.retentionDays');

    const [sessions, notificationsPurged, jobs] = await Promise.all([
      purgeExpiredSessions(7),
      notifications.purgeOld(retentionDays),
      purgeCompleted(7),
    ]);

    // Failed sign-in attempts are a security signal, but only recent ones.
    const attempts = await prisma.loginAttempt.deleteMany({
      where: { at: { lt: new Date(Date.now() - 90 * 86_400_000) } },
    });

    return {
      sessions,
      notifications: notificationsPurged,
      jobs,
      loginAttempts: attempts.count,
    };
  });

  log.info('Job handlers registered');
}

/** Re-exported for convenience; the definitions live in a seeder-safe module. */
export { DEFAULT_SCHEDULE } from '@/core/jobs/schedule';
