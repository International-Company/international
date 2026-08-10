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

export const SETTING_CATEGORIES = ['company', 'operations', 'machine', 'usdt', 'security', 'notifications', 'backup'] as const;

export type SettingCategory = (typeof SETTING_CATEGORIES)[number];

export const SETTING_CATEGORY_LABELS: Record<SettingCategory, { en: string; ar: string }> = {
  company: { en: 'Company', ar: 'بيانات الشركة' },
  operations: { en: 'Operations', ar: 'التشغيل' },
  machine: { en: 'Exchange Machine', ar: 'ماكينة التصريف' },
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
    key: 'operations.receiptCopies', category: 'operations', type: 'number', defaultValue: 2, min: 1, max: 5,
    labelEn: 'Receipt copies', labelAr: 'عدد نسخ الإيصال',
    descriptionEn: 'Copies printed per transaction', descriptionAr: 'عدد النسخ المطبوعة لكل عملية',
  },

  // --- Exchange machine ----------------------------------------------------
  {
    key: 'machine.enabled', category: 'machine', type: 'boolean', defaultValue: true,
    labelEn: 'Exchange machine', labelAr: 'ماكينة التصريف',
    descriptionEn: 'Give tellers the fast counter screen for cash exchange',
    descriptionAr: 'إتاحة شاشة التصريف السريع للتلر عند الشباك',
  },
  {
    key: 'machine.pairs', category: 'machine', type: 'string', defaultValue: 'ILS/USD,USD/ILS,ILS/JOD,JOD/ILS,USD/JOD,JOD/USD',
    labelEn: 'Pairs offered',
    labelAr: 'الأزواج المتاحة',
    descriptionEn:
      'Comma-separated, in the order the machine shows them. Remove a pair to take it off the counter. Leaving this empty offers all six rather than none.',
    descriptionAr:
      'مفصولة بفواصل، بالترتيب الذي تعرضه الماكينة. احذف زوجاً لسحبه من الشباك. تركه فارغاً يتيح الستة جميعاً لا العكس.',
  },
  {
    key: 'machine.quickAmounts', category: 'machine', type: 'string', defaultValue: '100,500,1000',
    labelEn: 'Quick amounts', labelAr: 'المبالغ السريعة',
    descriptionEn: 'Comma-separated shortcut buttons on the keypad, up to six',
    descriptionAr: 'أزرار اختصار على لوحة المفاتيح مفصولة بفواصل، حتى ستة',
  },
  {
    key: 'machine.transferChannels', category: 'machine', type: 'string',
    defaultValue: 'بنك فلسطين,بال باي,جوال',
    labelEn: 'Transfer destinations', labelAr: 'جهات التحويل',
    descriptionEn:
      'Comma-separated. Where a bank payout can be sent — the teller picks one, and the choice is on the record. Removing a name stops it being offered without touching transfers already sent through it.',
    descriptionAr:
      'مفصولة بفواصل. الجهات التي يجوز إرسال التسليم البنكي إليها — يختار التلر واحدة وتُثبَّت على العملية. حذف اسم يمنع عرضه دون أن يمسّ حوالات أُرسلت عبره.',
  },
  {
    key: 'remittance.destinations', category: 'machine', type: 'string', defaultValue: '',
    labelEn: 'Remittance destinations', labelAr: 'وجهات الحوالات',
    descriptionEn:
      "Comma-separated, from the correspondent's price list. The teller picks one and it is recorded on the transfer. Removing a name stops it being offered and leaves transfers already sent to it as they were recorded.",
    descriptionAr:
      'مفصولة بفواصل، من تسعيرة المراسل. يختار التلر واحدة وتُثبَّت على الحوالة. حذف اسم يمنع عرضه ويترك الحوالات المرسلة إليه كما سُجّلت.',
  },
  {
    key: 'machine.maxAmount', category: 'machine', type: 'money', defaultValue: '0',
    labelEn: 'Counter limit', labelAr: 'حد الشباك',
    descriptionEn:
      'Largest amount a teller may exchange on the machine, measured on what the customer hands over. Above it the manager records the transaction. Zero removes the limit.',
    descriptionAr:
      'أكبر مبلغ يستطيع التلر تصريفه على الماكينة، محسوباً على ما يدفعه العميل. فوقه يسجل المدير العملية بنفسه. القيمة صفر تلغي الحد.',
  },
  {
    key: 'machine.requireCustomerAbove', category: 'machine', type: 'money', defaultValue: '0',
    labelEn: 'Require a customer above', labelAr: 'اشتراط عميل فوق',
    descriptionEn:
      'At or above this amount the exchange must be attached to a registered customer. Zero never requires one.',
    descriptionAr:
      'عند هذا المبلغ أو فوقه يجب ربط العملية بعميل مسجّل. القيمة صفر تلغي الاشتراط.',
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
  {
    key: 'usdt.counterEnabled', category: 'usdt', type: 'boolean', defaultValue: true,
    labelEn: 'USDT counter', labelAr: 'شاشة استلام USDT',
    descriptionEn: 'Let tellers open counter requests and show a receiving address',
    descriptionAr: 'السماح للتلر بفتح طلبات استلام وعرض عنوان الاستقبال',
  },
  {
    key: 'usdt.counterRequestMinutes', category: 'usdt', type: 'number', defaultValue: 30, min: 5, max: 240,
    labelEn: 'Request validity (minutes)', labelAr: 'صلاحية الطلب (دقائق)',
    descriptionEn:
      'How long a quoted request stays open. The rate is held for this long, so a long window is a position the branch is carrying.',
    descriptionAr:
      'المدة التي يبقى فيها الطلب مفتوحاً. السعر مثبَّت طوال هذه المدة، فالمدة الطويلة مخاطرة سعرية يتحملها الفرع.',
  },
  {
    key: 'usdt.counterMaxAmount', category: 'usdt', type: 'money', defaultValue: '0',
    labelEn: 'Maximum per request', labelAr: 'الحد الأعلى للطلب',
    descriptionEn: 'Largest USDT amount a teller may quote at the counter. Zero removes the limit.',
    descriptionAr: 'أكبر مبلغ USDT يستطيع التلر تسعيره عند الشباك. القيمة صفر تلغي الحد.',
  },
  {
    key: 'usdt.counterUniqueAmount', category: 'usdt', type: 'boolean', defaultValue: true,
    labelEn: 'Reserve a distinct amount', labelAr: 'حجز مبلغ مميّز',
    descriptionEn:
      'Ask each customer for an amount no other open request is waiting for, so two people sending the same figure are never confused. Switching this off means the teller must identify every transfer by hash.',
    descriptionAr:
      'مطالبة كل عميل بمبلغ لا ينتظره طلب آخر مفتوح، حتى لا يختلط شخصان أرسلا نفس الرقم. إيقافه يعني أن على التلر تمييز كل تحويل ببصمته.',
    isSensitive: true,
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
    descriptionEn: 'Notify the manager when a posted transaction reaches the amount below',
    descriptionAr: 'تنبيه المدير عند بلوغ العملية المرحّلة المبلغ أدناه',
  },
  {
    key: 'notifications.largeTransactionThreshold', category: 'notifications', type: 'money', defaultValue: '0',
    labelEn: 'Large transaction amount',
    labelAr: 'مبلغ العملية الكبيرة',
    descriptionEn:
      'A posted transaction at or above this amount raises an alert. Zero alerts on every transaction, which quickly becomes noise nobody reads.',
    descriptionAr:
      'كل عملية مرحّلة تبلغ هذا المبلغ أو تتجاوزه تُصدر تنبيهاً. القيمة صفر تنبّه على كل عملية، وهو ما يتحول سريعاً إلى ضجيج لا يقرأه أحد.',
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
