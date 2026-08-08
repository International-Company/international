/**
 * The default background schedule.
 *
 * Pure data, kept separate from the worker so the seeder can install it without
 * pulling in the server-only runtime. Intervals are conservative: this runs on
 * a branch server, not a cluster.
 */

export interface ScheduledTaskDefinition {
  key: string;
  nameEn: string;
  nameAr: string;
  jobName: string;
  intervalSeconds: number;
}

export const DEFAULT_SCHEDULE: ScheduledTaskDefinition[] = [
  {
    key: 'usdt-sync',
    nameEn: 'Synchronise USDT wallets',
    nameAr: 'مزامنة محافظ USDT',
    jobName: 'usdt.syncAll',
    intervalSeconds: 120,
  },
  {
    key: 'balance-check',
    nameEn: 'Check cashbox balances',
    nameAr: 'فحص أرصدة الصناديق',
    jobName: 'drawers.checkBalances',
    intervalSeconds: 900,
  },
  {
    key: 'drawers-verify',
    nameEn: 'Reconcile ledger balances',
    nameAr: 'تسوية أرصدة القيود',
    jobName: 'drawers.verify',
    intervalSeconds: 3600,
  },
  {
    key: 'audit-verify',
    nameEn: 'Verify audit chain',
    nameAr: 'التحقق من سلسلة التدقيق',
    jobName: 'audit.verify',
    intervalSeconds: 21_600,
  },
  {
    key: 'automatic-backup',
    nameEn: 'Automatic backup',
    nameAr: 'نسخ احتياطي تلقائي',
    jobName: 'backup.automatic',
    intervalSeconds: 86_400,
  },
  {
    key: 'maintenance-purge',
    nameEn: 'Housekeeping',
    nameAr: 'التنظيف الدوري',
    jobName: 'maintenance.purge',
    intervalSeconds: 86_400,
  },
];
