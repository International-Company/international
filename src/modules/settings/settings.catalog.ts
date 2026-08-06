/**
 * Declarative settings catalogue.
 *
 * Each entry defines its type, default, category and bilingual labels, so the
 * settings screen is generated from this list rather than hand-built — adding a
 * setting means adding one entry here.
 */

export type SettingType = 'string' | 'number' | 'boolean' | 'money' | 'json' | 'select';

export interface SettingDefinition {
  key: string;
  category: SettingCategory;
  type: SettingType;
  defaultValue: unknown;
  labelEn: string;
  labelAr: string;
  descriptionEn: string;
  descriptionAr: string;
  options?: { value: string; labelEn: string; labelAr: string }[];
  /** Requires `settings.manage`; sensitive ones are additionally audited. */
  isSensitive?: boolean;
  min?: number;
  max?: number;
}

export const SETTING_CATEGORIES = [
  'company',
  'operations',
  'approvals',
  'security',
  'usdt',
  'notifications',
  'backup',
] as const;

export type SettingCategory = (typeof SETTING_CATEGORIES)[number];

export const SETTING_CATEGORY_LABELS: Record<SettingCategory, { en: string; ar: string }> = {
  company: { en: 'Company', ar: 'بيانات الشركة' },
  operations: { en: 'Operations', ar: 'التشغيل' },
  approvals: { en: 'Approvals', ar: 'الاعتمادات' },
  security: { en: 'Security', ar: 'الأمان' },
  usdt: { en: 'USDT Monitoring', ar: 'مراقبة USDT' },
  notifications: { en: 'Notifications', ar: 'الإشعارات' },
  backup: { en: 'Backup', ar: 'النسخ الاحتياطي' },
};

export const SETTINGS: SettingDefinition[] = [
  // --- Company -------------------------------------------------------------
  {
    key: 'company.name.en', category: 'company', type: 'string', defaultValue: 'International Exchange Co.',
    labelEn: 'Company name (English)', labelAr: 'اسم الشركة (إنجليزي)',
    descriptionEn: 'Printed on receipts and reports', descriptionAr: 'يُطبع على الإيصالات والتقارير',
  },
  {
    key: 'company.name.ar', category: 'company', type: 'string', defaultValue: 'شركة الصرافة الدولية',
    labelEn: 'Company name (Arabic)', labelAr: 'اسم الشركة (عربي)',
    descriptionEn: 'Printed on receipts and reports', descriptionAr: 'يُطبع على الإيصالات والتقارير',
  },
  {
    key: 'company.licenseNumber', category: 'company', type: 'string', defaultValue: '',
    labelEn: 'License number', labelAr: 'رقم الترخيص',
    descriptionEn: 'Regulatory licence number shown on receipts', descriptionAr: 'رقم الترخيص الرسمي على الإيصالات',
  },
  {
    key: 'company.phone', category: 'company', type: 'string', defaultValue: '',
    labelEn: 'Phone', labelAr: 'الهاتف',
    descriptionEn: 'Contact number on receipts', descriptionAr: 'رقم التواصل على الإيصالات',
  },
  {
    key: 'company.address', category: 'company', type: 'string', defaultValue: '',
    labelEn: 'Address', labelAr: 'العنوان',
    descriptionEn: 'Head office address', descriptionAr: 'عنوان المركز الرئيسي',
  },

  // --- Operations ----------------------------------------------------------
  {
    key: 'operations.baseCurrency', category: 'operations', type: 'select', defaultValue: 'ILS',
    labelEn: 'Reporting currency', labelAr: 'عملة التقارير',
    descriptionEn: 'Currency used to consolidate multi-currency reports',
    descriptionAr: 'العملة المستخدمة لتوحيد التقارير متعددة العملات',
    options: [
      { value: 'ILS', labelEn: 'Israeli Shekel', labelAr: 'شيكل' },
      { value: 'USD', labelEn: 'US Dollar', labelAr: 'دولار أمريكي' },
      { value: 'JOD', labelEn: 'Jordanian Dinar', labelAr: 'دينار أردني' },
    ],
  },
  {
    key: 'operations.requireBusinessDay', category: 'operations', type: 'boolean', defaultValue: true,
    labelEn: 'Require an open business day', labelAr: 'اشتراط يوم عمل مفتوح',
    descriptionEn: 'Block posting when the branch day is closed',
    descriptionAr: 'منع الترحيل عندما يكون يوم الفرع مغلقاً',
  },
  {
    key: 'operations.allowBackdating', category: 'operations', type: 'boolean', defaultValue: false,
    labelEn: 'Allow back-dated value dates', labelAr: 'السماح بتاريخ استحقاق سابق',
    descriptionEn: 'Permit a value date earlier than today', descriptionAr: 'السماح بتاريخ استحقاق أقدم من اليوم',
    isSensitive: true,
  },
  {
    key: 'operations.receiptCopies', category: 'operations', type: 'number', defaultValue: 2, min: 1, max: 5,
    labelEn: 'Receipt copies', labelAr: 'عدد نسخ الإيصال',
    descriptionEn: 'Copies printed per transaction', descriptionAr: 'عدد النسخ المطبوعة لكل عملية',
  },
  {
    key: 'operations.lowBalanceThreshold', category: 'operations', type: 'money', defaultValue: '0',
    labelEn: 'Low balance alert',
    labelAr: 'تنبيه الرصيد المنخفض',
    descriptionEn:
      'Notify when a cash drawer falls below this amount. Zero disables the alert — set the figure your branch actually works to, rather than inheriting one.',
    descriptionAr:
      'تنبيه عندما ينخفض رصيد الصندوق عن هذا المبلغ. القيمة صفر تعطّل التنبيه — اضبط الرقم الذي يعمل به فرعك فعلاً بدل قيمة موروثة.',
  },

  // --- Approvals -----------------------------------------------------------
  {
    key: 'approvals.enabled', category: 'approvals', type: 'boolean', defaultValue: false,
    labelEn: 'Enable approval workflow', labelAr: 'تفعيل مسار الاعتماد',
    descriptionEn:
      'Off: every transaction posts to the ledger immediately, whatever its value. On: transactions at or above the threshold below wait for a second signature.',
    descriptionAr:
      'معطّل: تُرحَّل كل عملية إلى الدفاتر فوراً مهما بلغت قيمتها. مفعّل: العمليات التي تبلغ الحد أدناه أو تتجاوزه تنتظر توقيعاً ثانياً.',
  },
  {
    key: 'approvals.threshold', category: 'approvals', type: 'money', defaultValue: '0',
    labelEn: 'Approval threshold',
    labelAr: 'حد الاعتماد',
    descriptionEn:
      'Transactions at or above this value require approval, in the reporting currency. Zero means every transaction does — so switching approvals on without setting a figure fails safe rather than doing nothing.',
    descriptionAr:
      'العمليات التي تبلغ هذه القيمة أو تتجاوزها تتطلب اعتماداً، بعملة التقارير. القيمة صفر تعني أن كل عملية تتطلب اعتماداً — فتفعيل الاعتمادات دون ضبط رقم يفشل إلى الجانب الآمن بدل ألا يفعل شيئاً.',
  },
  {
    key: 'approvals.selfApproval', category: 'approvals', type: 'boolean', defaultValue: false,
    labelEn: 'Allow self-approval', labelAr: 'السماح بالاعتماد الذاتي',
    descriptionEn: 'Let a user approve a transaction they created — disabling this enforces segregation of duties',
    descriptionAr: 'السماح للمستخدم باعتماد عملية أنشأها بنفسه — تعطيله يفرض الفصل بين المهام',
    isSensitive: true,
  },
  {
    key: 'approvals.reversalRequiresApproval', category: 'approvals', type: 'boolean', defaultValue: true,
    labelEn: 'Reversals require approval', labelAr: 'العكس يتطلب اعتماداً',
    descriptionEn: 'Reversing a posted transaction always needs a second signature',
    descriptionAr: 'عكس عملية مرحّلة يتطلب دائماً توقيعاً ثانياً',
  },

  // --- Security ------------------------------------------------------------
  {
    key: 'security.sessionIdleMinutes', category: 'security', type: 'number', defaultValue: 60, min: 5, max: 480,
    labelEn: 'Idle timeout (minutes)', labelAr: 'مهلة الخمول (دقائق)',
    descriptionEn: 'Sign out an inactive session after this long', descriptionAr: 'إنهاء الجلسة غير النشطة بعد هذه المدة',
    isSensitive: true,
  },
  {
    key: 'security.passwordMaxAgeDays', category: 'security', type: 'number', defaultValue: 90, min: 0, max: 365,
    labelEn: 'Password expiry (days)', labelAr: 'انتهاء كلمة المرور (أيام)',
    descriptionEn: 'Force a password change after this many days — 0 disables expiry',
    descriptionAr: 'إجبار تغيير كلمة المرور بعد هذه المدة — القيمة 0 تعطّل الانتهاء',
    isSensitive: true,
  },
  {
    key: 'security.requireTwoFactorForAdmins', category: 'security', type: 'boolean', defaultValue: false,
    labelEn: 'Require 2FA for administrators', labelAr: 'اشتراط التحقق بخطوتين للمدراء',
    descriptionEn: 'Administrators must enrol a second factor', descriptionAr: 'يجب على المدراء تفعيل التحقق بخطوتين',
    isSensitive: true,
  },

  // --- USDT ----------------------------------------------------------------
  {
    key: 'usdt.syncIntervalSeconds', category: 'usdt', type: 'number', defaultValue: 120, min: 30, max: 3600,
    labelEn: 'Sync interval (seconds)', labelAr: 'فترة المزامنة (ثواني)',
    descriptionEn: 'How often monitored wallets are polled', descriptionAr: 'معدل تحديث المحافظ المراقبة',
  },
  {
    key: 'usdt.minConfirmations', category: 'usdt', type: 'number', defaultValue: 19, min: 1, max: 100,
    labelEn: 'Minimum confirmations', labelAr: 'الحد الأدنى للتأكيدات',
    descriptionEn: 'Confirmations required before a transfer counts as final',
    descriptionAr: 'عدد التأكيدات المطلوبة قبل اعتبار التحويل نهائياً',
  },
  {
    key: 'usdt.autoCreateTransactions', category: 'usdt', type: 'boolean', defaultValue: true,
    labelEn: 'Auto-create internal transactions', labelAr: 'إنشاء عمليات داخلية تلقائياً',
    descriptionEn: 'Draft an internal transaction when a confirmed transfer is detected',
    descriptionAr: 'إنشاء مسودة عملية داخلية عند اكتشاف تحويل مؤكد',
  },
  {
    key: 'usdt.provider', category: 'usdt', type: 'select', defaultValue: 'MANUAL',
    labelEn: 'Blockchain provider', labelAr: 'مزود بيانات الشبكة',
    descriptionEn: 'MANUAL records transfers entered by staff; the others poll a public API',
    descriptionAr: 'الوضع اليدوي يسجل التحويلات المدخلة من الموظفين؛ الباقي يستعلم من واجهة عامة',
    options: [
      { value: 'MANUAL', labelEn: 'Manual entry', labelAr: 'إدخال يدوي' },
      { value: 'TRON', labelEn: 'TRON (TronGrid)', labelAr: 'ترون (TronGrid)' },
      { value: 'ETHEREUM', labelEn: 'Ethereum (Etherscan)', labelAr: 'إيثيريوم (Etherscan)' },
    ],
  },

  // --- Notifications -------------------------------------------------------
  {
    key: 'notifications.retentionDays', category: 'notifications', type: 'number', defaultValue: 90, min: 7, max: 730,
    labelEn: 'Retention (days)', labelAr: 'مدة الاحتفاظ (أيام)',
    descriptionEn: 'Delete read notifications after this long', descriptionAr: 'حذف الإشعارات المقروءة بعد هذه المدة',
  },
  {
    key: 'notifications.notifyOnLargeTransaction', category: 'notifications', type: 'boolean', defaultValue: true,
    labelEn: 'Alert on large transactions', labelAr: 'تنبيه عند العمليات الكبيرة',
    descriptionEn: 'Notify managers when a transaction exceeds the approval threshold',
    descriptionAr: 'تنبيه المدراء عند تجاوز العملية لحد الاعتماد',
  },

  // --- Backup --------------------------------------------------------------
  {
    key: 'backup.automatic', category: 'backup', type: 'boolean', defaultValue: true,
    labelEn: 'Automatic backups', labelAr: 'النسخ الاحتياطي التلقائي',
    descriptionEn: 'Run a scheduled backup without operator action', descriptionAr: 'تشغيل نسخ احتياطي مجدول دون تدخل',
  },
  {
    key: 'backup.intervalHours', category: 'backup', type: 'number', defaultValue: 24, min: 1, max: 168,
    labelEn: 'Backup interval (hours)', labelAr: 'فترة النسخ الاحتياطي (ساعات)',
    descriptionEn: 'How often an automatic backup runs', descriptionAr: 'معدل تشغيل النسخ الاحتياطي التلقائي',
  },
  {
    key: 'backup.retentionCount', category: 'backup', type: 'number', defaultValue: 30, min: 3, max: 365,
    labelEn: 'Backups to keep', labelAr: 'عدد النسخ المحفوظة',
    descriptionEn: 'Older backups beyond this count are deleted', descriptionAr: 'تُحذف النسخ الأقدم بعد هذا العدد',
  },
];

export const SETTINGS_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

export function settingsForCategory(category: SettingCategory): SettingDefinition[] {
  return SETTINGS.filter((s) => s.category === category);
}
