/**
 * The single source of truth for authorisation.
 *
 * Permissions are declared here once and consumed by the seeder, the admin
 * screens, the API guards and the navigation filter. Adding a capability to the
 * system means adding one entry to this catalogue — nothing else needs editing.
 *
 * Naming: `<module>.<resource>.<action>`.
 * Isomorphic on purpose: the client needs it to hide unavailable actions, the
 * server needs it to actually enforce them.
 */

export interface PermissionDefinition {
  key: string;
  module: ModuleKey;
  action: string;
  nameEn: string;
  nameAr: string;
  descriptionEn: string;
  descriptionAr: string;
  /** Sensitive permissions are never granted implicitly and are always audited. */
  isSensitive?: boolean;
}

export const MODULES = [
  'dashboard',
  'exchange',
  'usdt',
  'customers',
  'reports',
  'notifications',
  'users',
  'audit',
  'settings',
  'system',
] as const;

export type ModuleKey = (typeof MODULES)[number];

export const MODULE_LABELS: Record<ModuleKey, { en: string; ar: string }> = {
  dashboard: { en: 'Dashboard', ar: 'لوحة المعلومات' },
  exchange: { en: 'Exchange', ar: 'الصرافة' },
  usdt: { en: 'USDT Monitoring', ar: 'مراقبة USDT' },
  customers: { en: 'Customers', ar: 'العملاء' },
  reports: { en: 'Reports', ar: 'التقارير' },
  notifications: { en: 'Notifications', ar: 'الإشعارات' },
  users: { en: 'Users & Permissions', ar: 'المستخدمون والصلاحيات' },
  audit: { en: 'Audit Logs', ar: 'سجل التدقيق' },
  settings: { en: 'Settings', ar: 'الإعدادات' },
  system: { en: 'System Services', ar: 'خدمات النظام' },
};

function def(
  key: string,
  module: ModuleKey,
  action: string,
  nameEn: string,
  nameAr: string,
  descriptionEn: string,
  descriptionAr: string,
  isSensitive = false,
): PermissionDefinition {
  return { key, module, action, nameEn, nameAr, descriptionEn, descriptionAr, isSensitive };
}

export const PERMISSIONS: PermissionDefinition[] = [
  // --- Dashboard -----------------------------------------------------------
  def('dashboard.view', 'dashboard', 'view', 'View dashboard', 'عرض لوحة المعلومات',
    'Access the main dashboard', 'الوصول إلى لوحة المعلومات الرئيسية'),
  def('dashboard.financials.view', 'dashboard', 'view', 'View financial widgets', 'عرض المؤشرات المالية',
    'See balances, volumes and profit figures', 'عرض الأرصدة وحجم العمليات والأرباح'),

  // --- Exchange: transactions ---------------------------------------------
  def('exchange.transaction.view', 'exchange', 'view', 'View transactions', 'عرض العمليات',
    'View transactions created by the user', 'عرض العمليات التي أنشأها المستخدم'),
  def('exchange.transaction.viewAll', 'exchange', 'view', 'View all transactions', 'عرض جميع العمليات',
    'View transactions of every employee and branch', 'عرض عمليات جميع الموظفين والفروع'),
  def('exchange.transaction.create', 'exchange', 'create', 'Create transaction', 'إنشاء عملية',
    'Record a new financial transaction', 'تسجيل عملية مالية جديدة'),
  def('exchange.transaction.update', 'exchange', 'update', 'Edit transaction', 'تعديل عملية',
    'Edit a transaction that has not been posted', 'تعديل عملية لم تُرحّل بعد'),
  def('exchange.transaction.delete', 'exchange', 'delete', 'Delete draft', 'حذف مسودة',
    'Delete an unposted draft transaction', 'حذف مسودة عملية غير مرحّلة'),
  def('exchange.transaction.reverse', 'exchange', 'reverse', 'Reverse transaction', 'عكس عملية',
    'Create a reversing entry for a posted transaction', 'إنشاء قيد عكسي لعملية مرحّلة', true),
  def('exchange.transaction.overrideLimit', 'exchange', 'override', 'Override limits', 'تجاوز الحدود',
    'Exceed configured transaction and balance limits', 'تجاوز حدود العمليات والأرصدة المحددة', true),
  def('exchange.receipt.print', 'exchange', 'print', 'Print receipts', 'طباعة الإيصالات',
    'Print and reprint transaction receipts', 'طباعة وإعادة طباعة إيصالات العمليات'),
  def('exchange.machine.use', 'exchange', 'use', 'Use the exchange machine', 'استخدام ماكينة التصريف',
    'Quote and record counter exchanges between cash currencies',
    'تسعير وتسجيل عمليات التصريف النقدي عند الشباك'),

  // --- Exchange: rates -----------------------------------------------------
  def('exchange.rate.view', 'exchange', 'view', 'View rates', 'عرض الأسعار',
    'View current exchange rates and history', 'عرض أسعار الصرف الحالية والسجل'),
  def('exchange.rate.manage', 'exchange', 'manage', 'Manage rates', 'إدارة الأسعار',
    'Create and supersede exchange rates', 'إنشاء وتحديث أسعار الصرف', true),

  // --- Exchange: accounts / cashboxes -------------------------------------
  def('exchange.account.view', 'exchange', 'view', 'View cashboxes', 'عرض الصناديق',
    'View cashbox and ledger account balances', 'عرض أرصدة الصناديق والحسابات'),
  def('exchange.account.manage', 'exchange', 'manage', 'Manage cashboxes', 'إدارة الصناديق',
    'Create and configure ledger accounts', 'إنشاء وضبط الحسابات والصناديق', true),

  // --- Exchange: daily closing --------------------------------------------
  def('exchange.day.view', 'exchange', 'view', 'View business day', 'عرض يوم العمل',
    'View the daily closing sheet', 'عرض كشف الإغلاق اليومي'),
  def('exchange.day.open', 'exchange', 'open', 'Open business day', 'فتح يوم العمل',
    'Open a new trading day for a branch', 'فتح يوم عمل جديد للفرع'),
  def('exchange.day.close', 'exchange', 'close', 'Close business day', 'إغلاق يوم العمل',
    'Perform the daily close and record cash counts', 'تنفيذ الإغلاق اليومي وتسجيل الجرد', true),
  def('exchange.day.reopen', 'exchange', 'reopen', 'Reopen business day', 'إعادة فتح يوم العمل',
    'Reopen a closed day for correction', 'إعادة فتح يوم مغلق للتصحيح', true),

  // --- USDT ----------------------------------------------------------------
  def('usdt.wallet.view', 'usdt', 'view', 'View wallets', 'عرض المحافظ',
    'View monitored wallet addresses and balances', 'عرض عناوين المحافظ المراقبة وأرصدتها'),
  def('usdt.wallet.manage', 'usdt', 'manage', 'Manage wallets', 'إدارة المحافظ',
    'Add, edit and deactivate monitored wallets', 'إضافة وتعديل وتعطيل المحافظ المراقبة', true),
  def('usdt.wallet.sync', 'usdt', 'sync', 'Synchronise wallets', 'مزامنة المحافظ',
    'Trigger an on-demand blockchain synchronisation', 'تشغيل مزامنة فورية مع الشبكة'),
  def('usdt.transaction.view', 'usdt', 'view', 'View chain transactions', 'عرض عمليات الشبكة',
    'View incoming and outgoing on-chain transfers', 'عرض التحويلات الواردة والصادرة على الشبكة'),
  def('usdt.transaction.link', 'usdt', 'link', 'Link to transaction', 'ربط بعملية',
    'Link an on-chain transfer to an internal transaction', 'ربط تحويل شبكي بعملية داخلية', true),
  def('usdt.transaction.reconcile', 'usdt', 'reconcile', 'Reconcile transfers', 'تسوية التحويلات',
    'Mark on-chain transfers as reconciled', 'تعليم التحويلات الشبكية كمسواة', true),

  // --- USDT counter --------------------------------------------------------
  def('usdt.counter.use', 'usdt', 'use', 'Use the USDT counter', 'استخدام شاشة استلام USDT',
    'Show a receiving address, quote a customer and settle the transfer',
    'عرض عنوان الاستقبال وتسعير العميل وتسوية التحويل'),
  def('usdt.counter.manage', 'usdt', 'manage', 'Manage counter addresses', 'إدارة عناوين الشباك',
    'Choose which monitored addresses tellers may show customers',
    'تحديد العناوين المراقبة التي يجوز للتلر عرضها على العملاء', true),

  // --- Customers -----------------------------------------------------------
  def('customers.view', 'customers', 'view', 'View customers', 'عرض العملاء',
    'Search and view customer records', 'البحث في سجلات العملاء وعرضها'),
  def('customers.create', 'customers', 'create', 'Create customer', 'إضافة عميل',
    'Register a new customer', 'تسجيل عميل جديد'),
  def('customers.update', 'customers', 'update', 'Edit customer', 'تعديل عميل',
    'Update customer details', 'تحديث بيانات العميل'),
  def('customers.delete', 'customers', 'delete', 'Delete customer', 'حذف عميل',
    'Remove a customer with no transactions', 'حذف عميل ليس لديه عمليات', true),
  def('customers.block', 'customers', 'block', 'Block customer', 'حظر عميل',
    'Block or unblock a customer', 'حظر العميل أو رفع الحظر عنه', true),
  def('customers.kyc.manage', 'customers', 'manage', 'Manage KYC', 'إدارة اعرف عميلك',
    'Verify identity documents and set risk level', 'التحقق من الوثائق وتحديد درجة المخاطر', true),
  def('customers.balance.view', 'customers', 'view', 'View customer balances', 'عرض أرصدة العملاء',
    'View amounts owed to and by customers', 'عرض المستحقات على العملاء ولهم'),

  // --- Reports -------------------------------------------------------------
  def('reports.view', 'reports', 'view', 'View reports', 'عرض التقارير',
    'Run operational reports', 'تشغيل التقارير التشغيلية'),
  def('reports.financial.view', 'reports', 'view', 'View financial reports', 'عرض التقارير المالية',
    'Run profit, balance and trial balance reports', 'تشغيل تقارير الأرباح والأرصدة وميزان المراجعة'),
  def('reports.export', 'reports', 'export', 'Export reports', 'تصدير التقارير',
    'Export report data to Excel and PDF', 'تصدير بيانات التقارير إلى Excel و PDF'),

  // --- Notifications -------------------------------------------------------
  def('notifications.view', 'notifications', 'view', 'View notifications', 'عرض الإشعارات',
    'View the notification centre', 'الوصول إلى مركز الإشعارات'),
  def('notifications.broadcast', 'notifications', 'create', 'Broadcast notification', 'بث إشعار',
    'Send a notification to other users', 'إرسال إشعار إلى المستخدمين الآخرين', true),

  // --- Users & permissions -------------------------------------------------
  def('users.view', 'users', 'view', 'View users', 'عرض المستخدمين',
    'View user accounts', 'عرض حسابات المستخدمين'),
  def('users.create', 'users', 'create', 'Create user', 'إنشاء مستخدم',
    'Create a new user account', 'إنشاء حساب مستخدم جديد', true),
  def('users.update', 'users', 'update', 'Edit user', 'تعديل مستخدم',
    'Edit user details and status', 'تعديل بيانات المستخدم وحالته', true),
  def('users.delete', 'users', 'delete', 'Disable user', 'تعطيل مستخدم',
    'Disable a user account', 'تعطيل حساب مستخدم', true),
  def('users.resetPassword', 'users', 'update', 'Reset password', 'إعادة تعيين كلمة المرور',
    "Reset another user's password", 'إعادة تعيين كلمة مرور مستخدم آخر', true),
  def('users.sessions.manage', 'users', 'manage', 'Manage sessions', 'إدارة الجلسات',
    'View and revoke active sessions', 'عرض الجلسات النشطة وإنهاؤها', true),
  def('users.roles.assign', 'users', 'manage', 'Assign roles', 'إسناد الأدوار',
    'Assign roles and permission overrides to users', 'إسناد الأدوار والصلاحيات للمستخدمين', true),
  def('users.roles.manage', 'users', 'manage', 'Manage roles', 'إدارة الأدوار',
    'Create roles and change their permissions', 'إنشاء الأدوار وتعديل صلاحياتها', true),

  // --- Audit ---------------------------------------------------------------
  def('audit.view', 'audit', 'view', 'View audit log', 'عرض سجل التدقيق',
    'Read the immutable audit trail', 'قراءة سجل التدقيق غير القابل للتعديل'),
  def('audit.verify', 'audit', 'verify', 'Verify audit chain', 'التحقق من سلسلة التدقيق',
    'Run integrity verification on the audit chain', 'تشغيل التحقق من سلامة سلسلة التدقيق'),
  def('audit.export', 'audit', 'export', 'Export audit log', 'تصدير سجل التدقيق',
    'Export audit records for external review', 'تصدير سجلات التدقيق للمراجعة الخارجية', true),

  // --- Settings ------------------------------------------------------------
  def('settings.view', 'settings', 'view', 'View settings', 'عرض الإعدادات',
    'View system configuration', 'عرض إعدادات النظام'),
  def('settings.manage', 'settings', 'manage', 'Manage settings', 'إدارة الإعدادات',
    'Change system configuration', 'تعديل إعدادات النظام', true),
  def('settings.api.manage', 'settings', 'manage', 'Manage API credentials', 'إدارة مفاتيح الربط',
    'Configure external provider credentials', 'ضبط بيانات اعتماد المزودين الخارجيين', true),

  // --- System services -----------------------------------------------------
  def('system.monitor', 'system', 'view', 'System monitoring', 'مراقبة النظام',
    'View system health, queue and job status', 'عرض حالة النظام والمهام والطوابير'),
  def('system.jobs.manage', 'system', 'manage', 'Manage jobs', 'إدارة المهام',
    'Retry, cancel and reschedule background jobs', 'إعادة تشغيل وإلغاء وجدولة المهام الخلفية', true),
  def('system.backup.view', 'system', 'view', 'View backups', 'عرض النسخ الاحتياطية',
    'View the backup history', 'عرض سجل النسخ الاحتياطية'),
  def('system.backup.create', 'system', 'create', 'Create backup', 'إنشاء نسخة احتياطية',
    'Run a manual backup', 'تشغيل نسخ احتياطي يدوي', true),
  def('system.backup.restore', 'system', 'restore', 'Restore backup', 'استعادة نسخة احتياطية',
    'Restore the database from a backup', 'استعادة قاعدة البيانات من نسخة احتياطية', true),
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const PERMISSIONS_BY_KEY = new Map(PERMISSIONS.map((p) => [p.key, p]));

export function permissionsForModule(module: ModuleKey): PermissionDefinition[] {
  return PERMISSIONS.filter((p) => p.module === module);
}

// ---------------------------------------------------------------------------
// Built-in roles
// ---------------------------------------------------------------------------

export interface RoleDefinition {
  key: string;
  nameEn: string;
  nameAr: string;
  descriptionEn: string;
  descriptionAr: string;
  /** Lower is more senior. Users may only manage roles with a higher number. */
  level: number;
  /** `'*'` grants everything, including permissions added in future releases. */
  permissions: string[] | '*';
}

/**
 * The system has exactly two roles: a manager who supervises, and a teller who
 * operates. Nothing else.
 *
 * A teller records and posts their own work; the manager sees all of it, holds
 * the actions that undo it, and controls rates, the daily close and the system
 * itself. Control is after the fact rather than in the way of it, which is what
 * a counter needs. Adding intermediate roles would blur that line without adding
 * capability, since the manager already holds everything.
 *
 * The permission catalogue remains complete, so a bespoke role can still be
 * created through Administration → Roles without touching this file.
 */
export const SYSTEM_ROLES: RoleDefinition[] = [
  {
    key: 'ADMIN',
    nameEn: 'Manager',
    nameAr: 'المدير',
    descriptionEn:
      'Supervises the teller and controls the system: reviews and reverses transactions, publishes rates, closes the day, and manages users, settings and backups',
    descriptionAr:
      'يشرف على عمل التلر ويتحكم بالنظام: يراجع العمليات ويعكسها وينشر الأسعار وينفذ الإغلاق اليومي ويدير المستخدمين والإعدادات والنسخ الاحتياطي',
    level: 0,
    permissions: '*',
  },
  {
    key: 'TELLER',
    nameEn: 'Teller',
    nameAr: 'التلر',
    descriptionEn:
      'Front-desk operator: records and posts transactions, serves customers and prints receipts. Cannot reverse a posting or change a rate.',
    descriptionAr:
      'موظف الواجهة: يسجل العمليات ويرحّلها ويخدم العملاء ويطبع الإيصالات. لا يستطيع عكس عملية مرحّلة ولا تغيير سعر.',
    level: 50,
    permissions: [
      'dashboard.view',
      'exchange.transaction.view', 'exchange.transaction.create', 'exchange.transaction.update',
      'exchange.transaction.delete', 'exchange.receipt.print',
      // The two counter tools. The manager controls what they may show and how
      // much they may quote; within that, the teller works unaided.
      'exchange.machine.use', 'usdt.counter.use',
      // Recording a transaction posts it. The teller's boundary is what they
      // may record and see — reversal and rates stay with the manager.
      'exchange.rate.view',
      'exchange.account.view',
      'exchange.day.view',
      'usdt.wallet.view', 'usdt.transaction.view',
      'customers.view', 'customers.create', 'customers.update', 'customers.balance.view',
      'reports.view',
      'notifications.view',
    ],
  },
];

/** Expands `'*'` to the full catalogue. */
export function resolveRolePermissions(role: RoleDefinition): string[] {
  return role.permissions === '*' ? [...PERMISSION_KEYS] : role.permissions;
}
