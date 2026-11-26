/**
 * What an agent's word under a notice means: it arrived, it did not, or
 * something else — a question, a sum, "wait". Read with care: only a short
 * answer made wholly of words of arrival counts as one, so «تم بس ناقص 50» or
 * «واصل؟» is never taken as a yes.
 */

export type AgentVerdict = 'yes' | 'no' | 'unclear';

/** Arabic spelt one way: no marks, one alif, one ya, one ha. */
function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

/** Words of arrival, each alone enough. */
const YES = new Set([
  'تم', 'تمت', 'واصل', 'واصله', 'وصل', 'وصلت', 'موجود', 'موجوده', 'تمام', 'صحيح', 'سليم', 'سليمه',
  'مضبوط', 'مضبوطه', 'نعم', 'اه', 'ايوه', 'ايوا', 'اوك', 'اوكي', 'ok', 'okay', 'done', 'yes', 'جاهز', 'جاهزه',
  'شغال', 'شغاله', 'ماشي', '100',
]);
/** Said around a yes, changing nothing. */
const FILLER = new Set([
  'و', 'يا', 'اخي', 'اخوي', 'حبيبي', 'غالي', 'الغالي', 'الحمد', 'لله', 'الله', 'يعطيك', 'العافيه', 'شكرا',
  'مشكور', 'تسلم', 'الحواله', 'حواله', 'الاشعار', 'اشعار', 'المبلغ', 'هي', 'هاي', 'هذه', 'هاد', 'هذا', 'معلم',
  'التشييك', 'تشييك', 'الاستلام', 'جاهزين', 'استلام', 'قبض', 'للقبض', 'للصرف', 'صرف', 'كامل', 'كامله',
]);
/** A no, wherever it stands in the answer. */
const NO_WORDS = ['مرفوض', 'مرفوضه', 'رفض', 'خطا', 'غلط', 'ناقص', 'ناقصه', 'مزور', 'ملغي', 'ملغيه', 'مسترجع', 'مش', 'غير', 'لم', 'مافي', 'مفيش', 'ليس', 'لا', 'مو'];
const NO_MARKS = /[❌✖⛔🚫]/u;
const YES_MARKS = /^[\s✅✔☑👍👌🙏💯🤝✓.!]+$/u;

export function agentVerdict(text: string | null | undefined): AgentVerdict {
  const raw = (text ?? '').trim();
  if (!raw) return 'unclear';
  if (NO_MARKS.test(raw)) return 'no';
  if (YES_MARKS.test(raw)) return 'yes';
  // A question is not an answer.
  if (/[?؟]/.test(raw)) return 'unclear';
  const words = plain(raw)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 'unclear';
  // «ما وصل», «مش واصل», «غير موجود», «مرفوض»: a no.
  const denied = words.some(
    (word, at) =>
      NO_WORDS.includes(word) ||
      (word.startsWith('ما') && YES.has(word.slice(2))) ||
      // «ما وصل», but not «ما شاء الله».
      (word === 'ما' && YES.has(words[at + 1] ?? '')),
  );
  if (denied) {
    return words.length <= 8 ? 'no' : 'unclear';
  }
  if (words.length > 8) return 'unclear';
  // Every word a yes or said around one, and at least one yes.
  if (words.some((word) => YES.has(word)) && words.every((word) => YES.has(word) || FILLER.has(word))) return 'yes';
  return 'unclear';
}
