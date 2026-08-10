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
  'exchange',
  'usdt',
  'customers',
  'notifications',
  'users',
  'audit',
  'settings',
] as const;

export type ModuleKey = (typeof MODULES)[number];

export const MODULE_LABELS: Record<ModuleKey, { en: string; ar: string }> = {
  exchange: { en: 'Exchange', ar: 'الصرافة' },
  usdt: { en: 'USDT Monitoring', ar: 'مراقبة USDT' },
  customers: { en: 'Customers', ar: 'العملاء' },
  notifications: { en: 'Notifications', ar: 'الإشعارات' },
  users: { en: 'Users & Permissions', ar: 'المستخدمون والصلاحيات' },
  audit: { en: 'Audit Logs', ar: 'سجل التدقيق' },
  settings: { en: 'Settings', ar: 'الإعدادات' },
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
  // --- Seeing the margin ----------------------------------------------------
  def('exchange.margin.view', 'exchange', 'view', 'See the margin', 'عرض هامش الربح',
    'See the spread earned on a quote and on the day', 'عرض الفارق المحقق على التسعيرة وعلى اليوم'),

  // --- Exchange: transactions ---------------------------------------------
  def('exchange.transaction.view', 'exchange', 'view', 'View transactions', 'عرض العمليات',
    'View transactions created by the user', 'عرض العمليات التي أنشأها المستخدم'),
  def('exchange.transaction.viewAll', 'exchange', 'view', 'View all transactions', 'عرض جميع العمليات',
    'View transactions of every employee and branch', 'عرض عمليات جميع الموظفين والفروع'),
  def('exchange.transaction.create', 'exchange', 'create', 'Create transaction', 'إنشاء عملية',
    'Record a new financial transaction', 'تسجيل عملية مالية جديدة'),
  def('exchange.transaction.reverse', 'exchange', 'reverse', 'Reverse transaction', 'عكس عملية',
    'Create a reversing entry for a posted transaction', 'إنشاء قيد عكسي لعملية مرحّلة', true),
  def('exchange.transaction.edit', 'exchange', 'update', 'Edit and correct transactions', 'تعديل وتصحيح العمليات',
    'Edit the details of a posting, and correct an amount by reversing and reposting it',
    'تعديل بيانات العملية، وتصحيح مبلغها بعكسها وإعادة تسجيلها', true),
  def('exchange.remittance.use', 'exchange', 'use', 'Send and receive remittances', 'إرسال واستلام الحوالات',
    'Record remittances sent and received through the correspondent',
    'تسجيل الحوالات الصادرة والواردة عبر المراسل'),
  def('exchange.transfer.confirm', 'exchange', 'confirm', 'Confirm bank transfers', 'تأكيد التحويلات البنكية',
    'Mark a promised bank transfer as actually sent', 'تأكيد أن الحوالة البنكية الموعودة قد أُرسلت فعلاً', true),
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

  // --- The drawers ---------------------------------------------------------
  def('exchange.drawer.view', 'exchange', 'view', 'View drawers', 'عرض الصناديق',
    'See what the branch holds in each currency', 'عرض ما يحتفظ به الفرع من كل عملة'),
  def('exchange.drawer.manage', 'exchange', 'manage', 'Fund drawers', 'تمويل الصناديق',
    'Put money into a drawer or take it out', 'إيداع المال في صندوق أو سحبه منه', true),

  // --- The counter day --------------------------------------------
  def('exchange.day.view', 'exchange', 'view', 'View business day', 'عرض يوم العمل',
    'See whether the counter is open', 'معرفة ما إذا كان الشباك مفتوحاً'),
  def('exchange.day.open', 'exchange', 'open', 'Open business day', 'فتح يوم العمل',
    'Open the counter so the teller can record', 'فتح الشباك ليتمكن التلر من التسجيل'),
  def('exchange.day.close', 'exchange', 'close', 'Close business day', 'إغلاق يوم العمل',
    'Close the counter for the day', 'إغلاق الشباك لنهاية اليوم', true),
  def('exchange.day.reopen', 'exchange', 'reopen', 'Reopen business day', 'إعادة فتح يوم العمل',
    'Reopen a closed day for correction', 'إعادة فتح يوم مغلق للتصحيح', true),

  // --- The ledger ----------------------------------------------------------
  def('ledger.view', 'exchange', 'view', 'View the ledger', 'عرض دفتر الأستاذ',
    "See the branch's position, what it is worth and what the day produced",
    'عرض مركز الفرع وقيمته ونتيجة اليوم', true),
  def('ledger.cutoff.manage', 'exchange', 'manage', 'Approve cut-off rates', 'اعتماد أسعار القص',
    'Set the rates the position is valued at, and which the result is measured against',
    'تحديد الأسعار التي يُقيَّم بها المركز، والتي تُقاس عليها نتيجة اليوم', true),

  // --- USDT ----------------------------------------------------------------
  def('usdt.wallet.view', 'usdt', 'view', 'View wallets', 'عرض المحافظ',
    'View monitored wallet addresses and balances', 'عرض عناوين المحافظ المراقبة وأرصدتها'),
  def('usdt.wallet.manage', 'usdt', 'manage', 'Manage wallets', 'إدارة المحافظ',
    'Add, edit and deactivate monitored wallets', 'إضافة وتعديل وتعطيل المحافظ المراقبة', true),
  def('usdt.wallet.sync', 'usdt', 'sync', 'Synchronise wallets', 'مزامنة المحافظ',
    'Trigger an on-demand blockchain synchronisation', 'تشغيل مزامنة فورية مع الشبكة'),
  def('usdt.transaction.view', 'usdt', 'view', 'View chain transactions', 'عرض عمليات الشبكة',
    'View incoming and outgoing on-chain transfers', 'عرض التحويلات الواردة والصادرة على الشبكة'),
  def('usdt.transaction.reconcile', 'usdt', 'reconcile', 'Reconcile transfers', 'تسوية التحويلات',
    'Mark on-chain transfers as reconciled', 'تعليم التحويلات الشبكية كمسواة', true),

  // --- USDT counter --------------------------------------------------------
  def('usdt.counter.use', 'usdt', 'use', 'Use the USDT counter', 'استخدام شاشة استلام USDT',
    'Show a receiving address, quote a customer and settle the transfer',
    'عرض عنوان الاستقبال وتسعير العميل وتسوية التحويل'),
  def('usdt.withdrawal.use', 'usdt', 'use', 'Sell USDT', 'بيع USDT',
    "Take payment and send USDT to a customer's wallet",
    'استلام الدفعة وإرسال USDT إلى محفظة العميل'),
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
  def('customers.block', 'customers', 'block', 'Block customer', 'حظر عميل',
    'Block or unblock a customer', 'حظر العميل أو رفع الحظر عنه', true),

  // --- Notifications -------------------------------------------------------
  def('notifications.view', 'notifications', 'view', 'View notifications', 'عرض الإشعارات',
    'View the notification centre', 'الوصول إلى مركز الإشعارات'),

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

  // --- Audit ---------------------------------------------------------------
  def('audit.view', 'audit', 'view', 'View audit log', 'عرض سجل التدقيق',
    'Read the immutable audit trail', 'قراءة سجل التدقيق غير القابل للتعديل'),
  def('audit.verify', 'audit', 'verify', 'Verify audit chain', 'التحقق من سلسلة التدقيق',
    'Run integrity verification on the audit chain', 'تشغيل التحقق من سلامة سلسلة التدقيق'),

  // --- Settings ------------------------------------------------------------
  def('settings.view', 'settings', 'view', 'View settings', 'عرض الإعدادات',
    'View system configuration', 'عرض إعدادات النظام'),
  def('settings.manage', 'settings', 'manage', 'Manage settings', 'إدارة الإعدادات',
    'Change system configuration', 'تعديل إعدادات النظام', true),

  // --- System services -----------------------------------------------------
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
      'Works the counter tools and nothing else: takes and sells USDT, exchanges cash, sends and pays out remittances, prints receipts. Cannot reverse a posting, move a rate or fund a drawer.',
    descriptionAr:
      'يعمل على أدوات الشباك لا غير: يستلم USDT ويبيعه، ويصرّف النقد، ويرسل الحوالات ويسلّمها، ويطبع الإيصالات. لا يعكس عملية ولا يحرّك سعراً ولا يموّل صندوقاً.',
    level: 50,
    permissions: [
      // The two tools, and only what they cannot work without.
      //
      // Notably absent: viewing rates, drawers or the day. The machine prices
      // and checks the drawer on the server, inside the permission the teller
      // already holds — so granting those would buy the tools nothing and cost
      // something real, because the navigation is filtered by the same
      // permissions: manager entries would appear in a sidebar that is supposed
      // to hold the teller's own tools and nothing else.
      'exchange.machine.use',
      'exchange.remittance.use',
      'usdt.counter.use',
      'usdt.withdrawal.use',
      'exchange.transaction.view',
      'exchange.transaction.create',
      'exchange.receipt.print',
      // Attaching a customer, which both tools can require above an amount.
      'customers.view',
      'customers.create',
      'customers.update',
    ],
  },
];

/** Expands `'*'` to the full catalogue. */
export function resolveRolePermissions(role: RoleDefinition): string[] {
  return role.permissions === '*' ? [...PERMISSION_KEYS] : role.permissions;
}
