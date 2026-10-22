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
    key: 'company.name.en', category: 'company', type: 'string',
    defaultValue: 'International Financial Services & Jewellery Co.',
    labelEn: 'Company name (English)', labelAr: 'اسم الشركة (إنجليزي)',
    descriptionEn: 'Printed on receipts and reports', descriptionAr: 'يُطبع على الإيصالات والتقارير',
  },
  {
    key: 'company.name.ar', category: 'company', type: 'string',
    defaultValue: 'شركة انترنشونال للخدمات المالية والمجوهرات',
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
    // On by the office's decision: nobody opens the day by hand. The first act
    // that needs a day opens it, and a day closed for review reopens itself
    // when somebody records into it — both written to the audit log.
    key: 'day.automatic', category: 'operations', type: 'boolean', defaultValue: true,
    labelEn: 'Automatic business day',
    labelAr: 'يوم العمل التلقائي',
    descriptionEn:
      'When on, the first operation of the day opens the business day, and recording into a closed day reopens it. Every automatic open or reopen is in the audit log. Off: the manager opens and reopens days by hand.',
    descriptionAr:
      'عند التفعيل، أول عملية في اليوم تفتح يوم العمل تلقائياً، والتسجيل في يوم مغلق يعيد فتحه. كل فتح أو إعادة فتح تلقائي يُسجَّل في سجل التدقيق. عند الإيقاف: المدير يفتح الأيام ويعيد فتحها بنفسه.',
  },
  {
    key: 'operations.receiptCopies', category: 'operations', type: 'number', defaultValue: 2, min: 1, max: 5,
    labelEn: 'Receipt copies', labelAr: 'عدد نسخ الإيصال',
    descriptionEn: 'Copies printed per transaction', descriptionAr: 'عدد النسخ المطبوعة لكل عملية',
  },

  // --- Exchange machine ----------------------------------------------------
  {
    // On by the office's decision: a drawer that runs short goes negative
    // rather than stopping the counter, and the balance shows it. Never for a
    // crypto drawer — a wallet cannot send coins it does not hold, so allowing
    // it would only move the refusal from this screen to the chain.
    key: 'drawers.allowOverdraw', category: 'machine', type: 'boolean', defaultValue: true,
    labelEn: 'Pay out despite a short balance',
    labelAr: 'الصرف رغم نقص الرصيد',
    descriptionEn:
      'When on, a cash or bank drawer that does not hold enough is allowed to go negative instead of refusing the payout. Crypto drawers are never allowed below zero.',
    descriptionAr:
      'عند التفعيل، يُسمح للصندوق النقدي أو البنكي بأن يصبح سالباً بدل رفض الصرف عند نقص الرصيد. صناديق العملات الرقمية لا تنزل تحت الصفر أبداً.',
  },
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
    key: 'transfers.commissionRates', category: 'machine', type: 'string', defaultValue: '',
    labelEn: 'Commission per account', labelAr: 'عمولة كل حساب',
    descriptionEn:
      'Comma-separated name:percent pairs, such as "Akasha:0.5". What each account keeps for moving money, applied automatically when a transfer names it. Set once here rather than typed on every transfer, so the month’s cost of moving money can be totalled honestly.',
    descriptionAr:
      'أزواج الاسم:النسبة مفصولة بفواصل، مثل «عكاشة:0.5». ما يحتفظ به كل حساب مقابل تحريك المال، يُحسب تلقائياً حين يُسمّى الحساب في التحويل. يُضبط مرة هنا لا في كل حركة، حتى يمكن جمع كلفة نقل المال في الشهر بصدق.',
  },
  {
    key: 'transfers.approvalAbove', category: 'machine', type: 'string', defaultValue: '',
    labelEn: 'Transfer needing approval above', labelAr: 'سقف التحويل بلا موافقة',
    descriptionEn:
      'A delegated employee moving more than this waits for the manager. Empty means no ceiling. Never applies to the manager, who has nobody above him to ask.',
    descriptionAr:
      'الموظف المفوّض الذي ينقل أكثر من هذا ينتظر موافقة المدير. والفراغ يعني بلا سقف. لا يسري على المدير، إذ لا أحد فوقه ليسأله.',
  },
  {
    key: 'transfers.standingDays', category: 'machine', type: 'number', defaultValue: '2',
    labelEn: 'Days before a transfer is chased', labelAr: 'أيام قبل التنبيه على تحويل واقف',
    descriptionEn:
      'How long money may sit in transit before the screen marks it as standing. Money that left one balance and never reached the next is the failure this whole feature exists to prevent, so it is not left to memory.',
    descriptionAr:
      'كم يبقى المال في الطريق قبل أن تعلّمه الشاشة كواقف. المال الذي خرج من رصيد ولم يصل إلى التالي هو الخلل الذي بُنيت هذه الميزة لمنعه، فلا يُترك للذاكرة.',
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
    key: 'exchange.priceException.minutes', category: 'machine', type: 'number', defaultValue: 10,
    labelEn: 'A broken price lives for', labelAr: 'مدة صلاحية كسر السعر',
    descriptionEn:
      'Minutes an approved price stays usable. It is meant to cover the customer still standing at the counter — long enough to finish the deal, short enough that an unused approval cannot become a discount tomorrow.',
    descriptionAr:
      'عدد الدقائق التي يبقى فيها السعر المُوافق عليه صالحاً. المقصود هو الزبون الواقف الآن — مدة تكفي لإتمام الصفقة ولا تكفي لتتحول موافقة غير مستعملة إلى خصم جاهز غداً.',
  },
  {
    key: 'market.enabled', category: 'machine', type: 'boolean', defaultValue: true,
    labelEn: 'Market strip', labelAr: 'شريط السوق',
    descriptionEn:
      'Show the market ticker across the top of every screen. It is never used to price anything — the branch quotes the board its manager publishes.',
    descriptionAr:
      'عرض شريط السوق أعلى كل شاشة. لا يُسعَّر به شيء إطلاقاً — المكتب يسعّر بلوحته المنشورة.',
  },
  {
    key: 'market.liveSource', category: 'machine', type: 'boolean', defaultValue: true,
    labelEn: 'Live market prices', labelAr: 'أسعار البورصة اللحظية',
    descriptionEn:
      'Ask the live market for each pair, falling back to the free daily reference for anything it does not answer. Turn this off to use the reference alone.',
    descriptionAr:
      'سؤال السوق اللحظي عن كل زوج، والرجوع إلى المرجع اليومي المجاني لما لا يجيب عنه. أوقفه للاكتفاء بالمرجع.',
  },
  {
    key: 'market.pairs', category: 'machine', type: 'string',
    defaultValue: 'USD/ILS,EUR/USD,GBP/USD,USD/JOD,USD/TRY,USD/EGP,XAU/USD',
    labelEn: 'Ticker pairs', labelAr: 'أزواج الشريط',
    descriptionEn:
      'Comma-separated, in the order they scroll. Any pair the sources can price works — XAU is gold the ounce, USDT the coin. A pair nothing can price is simply left out.',
    descriptionAr:
      'مفصولة بفواصل، بالترتيب الذي تمرّ به. أي زوج تستطيع المصادر تسعيره يعمل — XAU هو الذهب للأونصة، وUSDT العملة. والزوج الذي لا يُسعَّر يُترك.',
  },
  {
    key: 'market.refreshMinutes', category: 'machine', type: 'number', defaultValue: 10,
    labelEn: 'Market refresh', labelAr: 'تحديث السوق',
    descriptionEn:
      'Minutes between calls to the rate source. One call serves every screen in the office, so this is not per device.',
    descriptionAr:
      'الدقائق بين كل استعلام والذي يليه. الاستعلام الواحد يخدم كل شاشات المكتب، فهذا ليس لكل جهاز.',
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
    key: 'usdt.autoSendEnabled', category: 'usdt', type: 'boolean', defaultValue: false,
    labelEn: 'The program sends the coins itself', labelAr: 'البرنامج يرسل العملة بنفسه',
    descriptionEn:
      'After a manager releases a sale, put the transfer on the chain automatically instead of somebody opening a wallet. It needs a hot wallet key in the server environment; without one this does nothing.',
    descriptionAr:
      'بعد إفراج المدير، يضع التحويل على السلسلة تلقائياً بدل أن يفتح أحدهم محفظته. يحتاج مفتاح محفظة ساخنة في بيئة الخادم، وبدونه لا يفعل شيئاً.',
  },
  {
    key: 'usdt.autoSendMaxPerTransfer', category: 'usdt', type: 'money', defaultValue: '500',
    labelEn: 'Most the program sends at once', labelAr: 'أكبر ما يرسله البرنامج دفعة واحدة',
    descriptionEn:
      'Above this the sale waits for somebody to send it by hand. Zero removes the ceiling, which is not advised while a key sits on the server.',
    descriptionAr:
      'ما فوقه ينتظر من يرسله بيده. والصفر يلغي السقف، وهو غير محبّذ ومفتاحٌ على الخادم.',
  },
  {
    key: 'usdt.autoSendMaxPerDay', category: 'usdt', type: 'money', defaultValue: '2000',
    labelEn: 'Most the program sends in a day', labelAr: 'أكبر ما يرسله البرنامج في يوم',
    descriptionEn:
      'Counted across every automatic send since midnight. It is what a stolen key is worth in a day, so keep it near what the counter actually needs.',
    descriptionAr:
      'يُحسب على كل ما أُرسل آلياً منذ منتصف الليل. وهو ما يساويه مفتاحٌ مسروق في يوم، فاجعله قريباً مما يحتاجه الشباك فعلاً.',
  },
  {
    key: 'usdt.withdrawalRequiresApproval', category: 'usdt', type: 'boolean', defaultValue: true,
    labelEn: 'A manager releases every USDT send', labelAr: 'المدير يُفرج عن كل سحب USDT',
    descriptionEn:
      'The customer pays and the coins are reserved as usual, but nobody may put the transfer on the chain until a manager approves it. A decline reverses the sale.',
    descriptionAr:
      'يدفع العميل وتُحجز العملة كالعادة، لكن لا يضع أحد التحويل على السلسلة حتى يوافق المدير. والرفض يعكس العملية.',
  },
  {
    key: 'usdt.withdrawalEnabled', category: 'usdt', type: 'boolean', defaultValue: true,
    labelEn: 'USDT withdrawals', labelAr: 'سحب USDT',
    descriptionEn: 'Let tellers sell USDT and send it to a customer wallet',
    descriptionAr: 'السماح للتلر ببيع USDT وإرساله إلى محفظة العميل',
  },
  {
    key: 'usdt.withdrawalMaxAmount', category: 'usdt', type: 'money', defaultValue: '0',
    labelEn: 'Withdrawal limit', labelAr: 'حد السحب',
    descriptionEn:
      'Largest amount of USDT a teller may send in one withdrawal. Zero removes the limit.',
    descriptionAr:
      'أكبر مبلغ USDT يستطيع التلر إرساله في عملية سحب واحدة. القيمة صفر تلغي الحد.',
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
