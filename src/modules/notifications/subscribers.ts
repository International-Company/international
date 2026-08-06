import 'server-only';
import { prisma } from '@/core/db/prisma';
import { on } from '@/core/events/bus';
import { toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import * as settings from '@/modules/settings/settings.service';
import { formatDayKey } from '@/modules/exchange/business-day.service';
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

  // --- Approval queue ------------------------------------------------------
  on('transaction.submitted', 'notify-approvers', async ({ transactionId, reference, actorId }) => {
    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: {
        createdBy: { select: { fullNameEn: true, fullNameAr: true } },
        customer: { select: { fullNameEn: true, fullNameAr: true } },
      },
    });
    if (!transaction) return;

    const amount = `${toDecimalString(transaction.fromAmount, 2)} ${transaction.fromCurrency}`;

    await notify(
      {
        severity: 'WARNING',
        eventKey: 'transaction.awaitingApproval',
        module: 'exchange',
        titleEn: 'Transaction awaiting approval',
        titleAr: 'عملية بانتظار الاعتماد',
        bodyEn: `${reference} — ${amount} recorded by ${transaction.createdBy.fullNameEn}`,
        bodyAr: `${reference} — ${amount} سجّلها ${transaction.createdBy.fullNameAr}`,
        entityType: 'Transaction',
        entityId: transactionId,
        link: `/exchange/transactions/${transactionId}`,
      },
      // Never notify the person who submitted it — they already know.
      { permission: 'exchange.transaction.approve', exceptUserId: actorId },
    );
  });

  // --- Outcome back to the originator --------------------------------------
  on('transaction.approved', 'notify-creator-approved', async ({ transactionId, reference }) => {
    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      select: { createdById: true },
    });
    if (!transaction) return;

    await notify(
      {
        severity: 'SUCCESS',
        eventKey: 'transaction.approved',
        module: 'exchange',
        titleEn: 'Transaction approved',
        titleAr: 'تم اعتماد العملية',
        bodyEn: `${reference} has been approved and posted to the ledger.`,
        bodyAr: `تم اعتماد العملية ${reference} وترحيلها إلى الدفاتر.`,
        entityType: 'Transaction',
        entityId: transactionId,
        link: `/exchange/transactions/${transactionId}`,
      },
      { userIds: [transaction.createdById] },
    );
  });

  on('transaction.rejected', 'notify-creator-rejected', async ({ transactionId, reference, reason }) => {
    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      select: { createdById: true },
    });
    if (!transaction) return;

    await notify(
      {
        severity: 'CRITICAL',
        eventKey: 'transaction.rejected',
        module: 'exchange',
        titleEn: 'Transaction rejected',
        titleAr: 'تم رفض العملية',
        bodyEn: `${reference} was rejected: ${reason}`,
        bodyAr: `تم رفض العملية ${reference}: ${reason}`,
        entityType: 'Transaction',
        entityId: transactionId,
        link: `/exchange/transactions/${transactionId}`,
      },
      { userIds: [transaction.createdById] },
    );
  });

  // --- Large transactions --------------------------------------------------
  on('transaction.posted', 'notify-large-transaction', async ({ transactionId, reference }) => {
    if (!(await settings.getBoolean('notifications.notifyOnLargeTransaction'))) return;

    const transaction = await prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!transaction || !transaction.requiresApproval) return;

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
        link: `/exchange/transactions/${transactionId}`,
      },
      { permission: 'dashboard.financials.view' },
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
        link: `/exchange/transactions/${reversalId}`,
      },
      { permission: 'exchange.transaction.approve', exceptUserId: actorId },
    );
  });

  // --- Daily close ---------------------------------------------------------
  on('day.closed', 'notify-day-closed', async ({ businessDayId, branchId, hasDifference }) => {
    if (!hasDifference) return;

    const day = await prisma.businessDay.findUnique({
      where: { id: businessDayId },
      include: { branch: true, closingLines: { where: { difference: { not: 0 } } } },
    });
    if (!day) return;

    await notify(
      {
        severity: 'CRITICAL',
        eventKey: 'day.difference',
        module: 'exchange',
        titleEn: 'Cash differences at daily close',
        titleAr: 'فروقات في الجرد عند الإغلاق اليومي',
        bodyEn: `${day.branch.nameEn} closed ${formatDayKey(day.date)} with ${day.closingLines.length} unexplained difference(s).`,
        bodyAr: `أغلق فرع ${day.branch.nameAr} يوم ${formatDayKey(day.date)} مع ${day.closingLines.length} فرق غير مفسّر.`,
        entityType: 'BusinessDay',
        entityId: businessDayId,
        link: `/exchange/business-day`,
      },
      { permission: 'exchange.day.close', branchId },
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
        link: `/admin/users/${userId}`,
      },
      { permission: 'users.update' },
    );
  });

  // --- Low balance ---------------------------------------------------------
  on('account.balance.low', 'notify-low-balance', async ({ accountId, code, balance }) => {
    await notify(
      {
        severity: 'WARNING',
        eventKey: 'account.lowBalance',
        module: 'exchange',
        titleEn: 'Cashbox running low',
        titleAr: 'رصيد الصندوق منخفض',
        bodyEn: `${code} has fallen to ${toDecimalString(BigInt(balance), 2)}.`,
        bodyAr: `انخفض رصيد ${code} إلى ${toDecimalString(BigInt(balance), 2)}.`,
        entityType: 'Account',
        entityId: accountId,
        link: '/exchange/cashboxes',
      },
      { permission: 'exchange.account.manage' },
    );
  });

  log.info('Notification subscribers registered');
}
