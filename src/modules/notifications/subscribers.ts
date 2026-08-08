import 'server-only';
import { prisma } from '@/core/db/prisma';
import { on } from '@/core/events/bus';
import { toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import * as settings from '@/modules/settings/settings.service';

import { notify } from './notifications.service';

/**
 * Event subscribers.
 *
 * This is the seam that keeps the monolith modular: the exchange module
 * announces that a transaction was submitted and knows nothing about who cares.
 * Notification rules live here, so changing who gets told about what never
 * requires touching financial code.
 */

const log = createLogger('notifications:subscribers');

let registered = false;

export function registerNotificationSubscribers(): void {
  if (registered) return;
  registered = true;

  // --- Large transactions --------------------------------------------------
  on('transaction.posted', 'notify-large-transaction', async ({ transactionId, reference }) => {
    if (!(await settings.getBoolean('notifications.notifyOnLargeTransaction'))) return;

    const transaction = await prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!transaction) return;

    // Without a threshold every posting would raise an alert, and an inbox that
    // flags everything flags nothing.
    const threshold = await settings.getMoney('notifications.largeTransactionThreshold');
    if (threshold > 0n && transaction.fromAmount < threshold) return;

    await notify(
      {
        severity: 'INFO',
        eventKey: 'transaction.large',
        module: 'exchange',
        titleEn: 'Large transaction posted',
        titleAr: 'ترحيل عملية كبيرة',
        bodyEn: `${reference} — ${toDecimalString(transaction.fromAmount, 2)} ${transaction.fromCurrency}`,
        bodyAr: `${reference} — ${toDecimalString(transaction.fromAmount, 2)} ${transaction.fromCurrency}`,
        entityType: 'Transaction',
        entityId: transactionId,
        link: `/manage/transactions/${transactionId}`,
      },
      { permission: 'exchange.margin.view' },
    );
  });

  // --- Reversals are always worth a manager's attention ---------------------
  on('transaction.reversed', 'notify-reversal', async ({ transactionId, reversalId, actorId }) => {
    const original = await prisma.transaction.findUnique({
      where: { id: transactionId },
      select: { reference: true },
    });
    if (!original) return;

    await notify(
      {
        severity: 'WARNING',
        eventKey: 'transaction.reversed',
        module: 'exchange',
        titleEn: 'Transaction reversed',
        titleAr: 'تم عكس عملية',
        bodyEn: `${original.reference} was reversed. A mirror entry has been posted.`,
        bodyAr: `تم عكس العملية ${original.reference}. تم ترحيل قيد معاكس.`,
        entityType: 'Transaction',
        entityId: reversalId,
        link: `/manage/transactions/${reversalId}`,
      },
      { permission: 'exchange.transaction.reverse', exceptUserId: actorId },
    );
  });

  // --- Security ------------------------------------------------------------
  on('user.locked', 'notify-account-locked', async ({ userId, username }) => {
    await notify(
      {
        severity: 'CRITICAL',
        eventKey: 'security.accountLocked',
        module: 'users',
        titleEn: 'Account locked',
        titleAr: 'تم قفل حساب',
        bodyEn: `"${username}" was locked after repeated failed sign-in attempts.`,
        bodyAr: `تم قفل الحساب "${username}" بعد محاولات دخول فاشلة متكررة.`,
        entityType: 'User',
        entityId: userId,
        link: '/manage/staff',
      },
      { permission: 'users.update' },
    );
  });

  // --- A drawer running low ------------------------------------------------
  //
  // Sent before the drawer is empty rather than after: once it is, the machine
  // refuses payouts and the teller finds out with a customer in front of them.
  on('drawer.balance.low', 'notify-low-drawer', async ({ currency, balance, threshold }) => {
    const held = toDecimalString(BigInt(balance), 2);
    const limit = toDecimalString(BigInt(threshold), 2);

    await notify(
      {
        severity: 'WARNING',
        eventKey: 'drawer.low',
        module: 'exchange',
        titleEn: 'A drawer is running low',
        titleAr: 'رصيد صندوق منخفض',
        bodyEn: `The ${currency} drawer holds ${held}, below the ${limit} you set.`,
        bodyAr: `رصيد صندوق ${currency} هو ${held}، دون الحد ${limit} الذي حددته.`,
        entityType: 'Drawer',
        entityId: currency,
        link: '/manage/drawers',
      },
      { permission: 'exchange.drawer.manage' },
    );
  });

  log.info('Notification subscribers registered');
}
