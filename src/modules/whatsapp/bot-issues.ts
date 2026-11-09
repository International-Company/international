import 'server-only';
import { prisma } from '@/core/db/prisma';
import { createLogger, type LogContext, type Logger } from '@/core/logger/logger';
import { errors } from '@/core/errors/app-error';
import * as notifications from '@/modules/notifications/notifications.service';

/**
 * Whatever goes wrong with the bots, where the manager will see it.
 *
 * The same failure repeating is one row with a count, and rings the bell once
 * rather than every time. A failure here never affects what failed: it is only
 * ever a note about it.
 */

const raw = createLogger('whatsapp:issues');

interface Wording {
  title: string;
  action: string;
  critical?: boolean;
}

const CHECK_LINK = 'تأكد أن الرقم «مرتبط» في الإعدادات ← واتساب، وأن رقم البوت عضو في المجموعة.';

const WORDING: Record<string, Wording> = {
  'Could not announce a deal': { title: 'لم تُرسل عملية إلى المجموعة', action: CHECK_LINK, critical: true },
  'A deal went out without an id to reply to': { title: 'أُرسلت عملية دون الرد عليها بنوعها', action: CHECK_LINK },
  'Could not label a deal': { title: 'لم يُرسل نوع العملية تحت رسالتها', action: CHECK_LINK },
  'Could not send a deal’s photo; sending its words': { title: 'لم تُرسل صورة عملية، فأُرسل نصها فقط', action: CHECK_LINK },
  'Could not send one of a deal’s photos': { title: 'لم تُرسل إحدى صور العملية', action: CHECK_LINK },
  'Could not send a payment photo': { title: 'لم تُرسل صورة الدفع', action: CHECK_LINK },
  'Could not copy a deal’s part to its group': { title: 'لم يصل جزء العملية إلى مجموعته الثانية', action: CHECK_LINK },
  'Could not copy a sale’s address photo; sending its words': { title: 'لم تُرسل صورة عنوان الإيداع، فأُرسل نصها', action: CHECK_LINK },
  'Could not send a TikTok withdrawal': { title: 'لم يُرسل سحب تيكتوك إلى مجموعته', action: CHECK_LINK, critical: true },
  'Could not send a TikTok withdrawal’s name': { title: 'لم تصل صورة التيكتوك والاسم إلى المجموعة', action: CHECK_LINK },
  'Could not announce a TikTok deletion': { title: 'لم يُرسل إشعار حذف سحب تيكتوك', action: CHECK_LINK },
  'Could not cancel a TikTok withdrawal’s name': { title: 'لم يُرسل إلغاء اسم سحب التيكتوك', action: CHECK_LINK },
  'Could not announce a deletion': { title: 'لم يُرسل إشعار إلغاء عملية', action: CHECK_LINK, critical: true },
  'Could not cancel a remittance’s copy': { title: 'لم يُرسل إلغاء الحوالة إلى مجموعتها الثانية', action: CHECK_LINK },
  'Could not read a teller’s day for the group': { title: 'تعذر تجهيز #جرد', action: 'أعد المحاولة، وإذا تكرر أرسل التفاصيل للدعم.' },
  'Could not send the report as a picture; sending it as text': { title: 'أُرسل #جرد نصاً بدل الصورة', action: CHECK_LINK },
  'Could not answer a reconciliation': { title: 'لم يرد البوت على #مطابقة', action: CHECK_LINK },
  'Could not send the welcome message': { title: 'لم تُرسل رسالة الترحيب', action: CHECK_LINK },
  'Could not welcome a newly linked group': { title: 'لم تُرسل رسالة الترحيب لمجموعة جديدة', action: CHECK_LINK },
  'Could not tell the group of a customer': { title: 'لم يصل تنبيه عميل إلى مجموعة الطلبات', action: CHECK_LINK, critical: true },
  'Could not get an answer for a customer': { title: 'لم يتمكن البوت من الرد على عميل', action: 'راجع رصيد حساب Anthropic ومفتاح API.', critical: true },
  'The private number reached its daily limit': { title: 'وصل البوت إلى حد الردود اليومي', action: 'ارفع «عدد الردود في اليوم» من تبويب الإعداد إذا كان الاستخدام طبيعياً.', critical: true },
  'The panel could not get an answer': { title: 'تعذر الرد في «جرّب البوت»', action: 'راجع رصيد حساب Anthropic ومفتاح API.' },
  'A reply was held back by a blocked word': { title: 'مُنع رد للبوت لأنه يحتوي كلمة ممنوعة', action: 'حُوّل العميل إلى موظف. الكلمة مكتوبة في التفاصيل.' },
  'A customer message failed': { title: 'فشلت معالجة رسالة عميل', action: 'تأكد أن الرقم الخاص «مرتبط».', critical: true },
  'Could not keep a message': { title: 'لم تُحفظ رسالة في سجل المحادثات', action: 'تأكد من عمل قاعدة البيانات.' },
  'Could not keep a request': { title: 'لم يُحفظ طلب عميل في صفحة الطلبات', action: 'تأكد من عمل قاعدة البيانات.', critical: true },
  'Could not read a withdrawal photo': { title: 'تعذرت قراءة صورة سحب تيكتوك', action: 'راجع رصيد حساب Anthropic ومفتاح API. يستطيع التلر كتابة الأرقام يدوياً.' },
  'A withdrawal photo gave no figures': { title: 'لم تُقرأ أرقام صورة سحب تيكتوك', action: 'على الأغلب الصورة غير واضحة، ويكتب التلر الأرقام يدوياً.' },
  'WhatsApp was unlinked from the phone': { title: 'انفصل رقم واتساب عن النظام', action: 'أعد ربط الرقم من الإعدادات ← واتساب بمسح رمز QR.', critical: true },
  'WhatsApp connection failed': { title: 'فشل اتصال واتساب', action: 'افتح الإعدادات ← واتساب وتأكد من حالة الرقم، وأعد الربط إن لزم.', critical: true },
};

const CREDIT: Wording = {
  title: 'انتهى رصيد الذكاء الاصطناعي',
  action: 'اشحن الرصيد من console.anthropic.com ← Plans & Billing.',
  critical: true,
};

/** What is worth showing of a log's context: never a customer's words or a stack. */
export function detailOf(context?: LogContext): string {
  if (!context) return '';
  const error = context.error;
  const parts = [
    typeof context.reference === 'string' ? context.reference : null,
    typeof context.account === 'string' ? `account: ${context.account}` : null,
    typeof context.status === 'number' ? `status: ${context.status}` : null,
    typeof context.reason === 'string' ? context.reason : null,
    typeof context.stopReason === 'string' ? context.stopReason : null,
    error instanceof Error ? error.message : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(' — ').slice(0, 400);
}

/** The words the manager reads. One failure with different causes gets the cause that matters. */
export function wordingOf(message: string, detail: string): Wording & { key: string } {
  if (/credit balance/i.test(detail)) return { ...CREDIT, key: 'credit' };
  const known = WORDING[message];
  return known
    ? { ...known, key: message }
    : { title: message, action: 'إذا تكرر هذا الخطأ أرسل تفاصيله للدعم.', key: message };
}

const RENOTIFY_AFTER = 6 * 60 * 60 * 1000;
const KEEP_FOR = 30 * 24 * 60 * 60 * 1000;

async function save(scope: string, message: string, context?: LogContext): Promise<void> {
  const detail = detailOf(context);
  const wording = wordingOf(message, detail);
  const now = new Date();
  const before = await prisma.botIssue.findUnique({
    where: { key: wording.key },
    select: { lastAt: true },
  });
  await prisma.botIssue.upsert({
    where: { key: wording.key },
    create: {
      key: wording.key,
      scope,
      title: wording.title,
      action: wording.action,
      detail,
      critical: wording.critical ?? false,
      firstAt: now,
      lastAt: now,
    },
    update: { count: { increment: 1 }, detail, lastAt: now },
  });
  await prisma.botIssue.deleteMany({ where: { lastAt: { lt: new Date(now.getTime() - KEEP_FOR) } } });

  if (before && now.getTime() - before.lastAt.getTime() < RENOTIFY_AFTER) return;
  await notifications.notify(
    {
      severity: wording.critical ? 'CRITICAL' : 'WARNING',
      eventKey: 'bot.issue',
      module: 'whatsapp',
      titleEn: 'A bot problem needs attention',
      titleAr: wording.title,
      bodyEn: message,
      bodyAr: wording.action,
      link: '/manage/private-bot?tab=issues',
    },
    { permission: 'settings.view' },
  );
}

/** Notes a failure. Never throws, and never holds up what it is about. */
export function recordIssue(scope: string, message: string, context?: LogContext): void {
  void save(scope, message, context).catch((error) =>
    raw.warn('Could not note a bot problem', { error }),
  );
}

/** A logger whose warnings and errors also reach the manager. */
export function createBotLogger(scope: string): Logger {
  const log = createLogger(scope);
  return {
    ...log,
    warn: (message, context) => {
      log.warn(message, context);
      recordIssue(scope, message, context);
    },
    error: (message, context) => {
      log.error(message, context);
      recordIssue(scope, message, context);
    },
  };
}

export async function listIssues() {
  return prisma.botIssue.findMany({ orderBy: [{ critical: 'desc' }, { lastAt: 'desc' }], take: 100 });
}

export const issueCount = () => prisma.botIssue.count();

export async function dismissIssue(id: string): Promise<void> {
  const found = await prisma.botIssue.findUnique({ where: { id }, select: { id: true } });
  if (!found) throw errors.notFound('BotIssue', id);
  await prisma.botIssue.delete({ where: { id } });
}

export async function dismissAll(): Promise<void> {
  await prisma.botIssue.deleteMany({});
}
