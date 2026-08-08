import 'server-only';
import { prisma } from '@/core/db/prisma';
import { createLogger } from '@/core/logger/logger';
import { registerJob, startWorker } from '@/core/jobs/worker';
import { purgeCompleted } from '@/core/jobs/queue';
import { purgeExpiredSessions } from '@/modules/auth/session.service';
import { registerNotificationSubscribers } from '@/modules/notifications/subscribers';
import * as notifications from '@/modules/notifications/notifications.service';
import * as settings from '@/modules/settings/settings.service';
import * as drawers from '@/modules/drawers/drawer.service';
import * as backup from '@/modules/backup/backup.service';
import { syncAllWallets } from '@/modules/usdt/sync.service';
import { verifyChain } from '@/modules/audit/audit.service';
import { emit } from '@/core/events/bus';

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

  // --- Drawer integrity ----------------------------------------------------
  registerJob('drawers.verify', async () => {
    const result = await drawers.verifyBalances();

    if (!result.ok) {
      await notifications.notify(
        {
          severity: 'CRITICAL',
          eventKey: 'drawers.discrepancy',
          module: 'system',
          titleEn: 'A drawer balance disagrees with its movements',
          titleAr: 'رصيد صندوق لا يطابق حركاته',
          bodyEn: 'A drawer holds a different amount from the sum of everything recorded against it. Nothing should be able to cause this.',
          bodyAr: 'رصيد أحد الصناديق يخالف مجموع حركاته المسجّلة. لا يُفترض أن يحدث هذا إطلاقاً.',
          link: '/manage/drawers',
        },
        { permission: 'exchange.drawer.manage' },
      );
    }

    return { ok: result.ok };
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

  // --- Low drawer warning --------------------------------------------------
  registerJob('drawers.checkBalances', async () => {
    const low = (await drawers.listDrawers()).filter(
      (drawer) => drawer.lowBalanceThreshold > 0n && drawer.balance < drawer.lowBalanceThreshold,
    );

    for (const drawer of low) {
      await emit('drawer.balance.low', {
        currency: drawer.currencyCode,
        balance: drawer.balance.toString(),
        threshold: drawer.lowBalanceThreshold.toString(),
      });
    }

    return { alerts: low.length };
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
