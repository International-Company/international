/**
 * Reading a transfer request off a group message.
 *
 * Other offices and people write a transfer the way the office does: a line
 * each — the account, the name, the bank, the sum — in whatever order, with
 * blank lines between and the sum often with a unit: "500 ش", "1,200 شيكل",
 * "$300". This picks those four out, or says it could not, so a message that
 * is not a transfer — a "تم", a question — never becomes one.
 *
 * Pure: the banks the counter knows are passed in, so a test needs nothing else.
 */

export interface ReadRequest {
  account: string;
  name: string | null;
  channel: string | null;
  /** Scaled by 1e8, as every sum in the system. */
  amount: bigint;
  currency: string;
}

const ARABIC_DIGITS = /[٠-٩]/g;
const PERSIAN_DIGITS = /[۰-۹]/g;

/** Arabic and Persian digits as Western, the Arabic decimal mark as a point. */
export function westernDigits(text: string): string {
  return text
    .replace(ARABIC_DIGITS, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(PERSIAN_DIGITS, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',');
}

const UNITS: [RegExp, string][] = [
  [/(₪|شيكل|شيقل|شواكل|\bش\b|(^|\s)ش(\s|$)|ils|nis)/i, 'ILS'],
  [/(\$|دولار|usd)/i, 'USD'],
  [/(دينار|jod)/i, 'JOD'],
  [/(يورو|€|eur)/i, 'EUR'],
];

/** The money a line names, if it names one. */
function unitOf(line: string): string | null {
  for (const [pattern, code] of UNITS) if (pattern.test(line)) return code;
  return null;
}

/** A sum as written — "1,200", "1200.50", "500" — scaled, or null. */
function sumOf(text: string): bigint | null {
  const match = text.replace(/,/g, '').match(/\d+(?:\.\d{1,2})?/);
  if (!match) return null;
  const [whole, fraction = ''] = match[0].split('.');
  const value = BigInt(whole!) * 100_000_000n + BigInt((fraction + '00').slice(0, 2)) * 1_000_000n;
  return value > 0n ? value : null;
}

/** A line that is a bank or a wallet by its words, known to the counter or not. */
const BANKISH =
  /^(ال)?(محفظ[ةه]|محافظ|wallet|بنك|البنك|مصرف|bank|pal\s*pay|palpay|jawwal\s*pay|jawwalpay|bop|iban|ايبان)(\s|$)|^(بال|جوال)\s*(باي|بي|بى)$/i;

const letters = (line: string) => (line.match(/[\p{L}]/gu) ?? []).length;
const digitsIn = (line: string) => (line.match(/\d/g) ?? []).length;

export function readTransferRequest(text: string, channels: string[]): ReadRequest | null {
  const lines = westernDigits(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/[‎‏*_~]/g, '').trim())
    .filter(Boolean);
  if (lines.length < 2 || lines.length > 12) return null;

  const used = new Set<number>();

  // The account: a line that is a long number — a phone, an account, an IBAN.
  let account: string | null = null;
  for (const [index, line] of lines.entries()) {
    const compact = line.replace(/[\s\-+]/g, '');
    const iban = /^[A-Z]{2}\d{2}[A-Z0-9]{8,}$/i.test(compact);
    if (iban || (/^\d{6,}$/.test(compact) && !unitOf(line))) {
      account = compact;
      used.add(index);
      break;
    }
  }
  if (!account) return null;

  // The sum: a line with a unit first, else a short number on its own.
  let amount: bigint | null = null;
  let currency = 'ILS';
  for (const [index, line] of lines.entries()) {
    if (used.has(index)) continue;
    const unit = unitOf(line);
    const sum = sumOf(line);
    if (sum && unit && letters(line.replace(/[^\p{L}]/gu, '')) <= 8) {
      amount = sum;
      currency = unit;
      used.add(index);
      break;
    }
  }
  if (amount === null) {
    for (const [index, line] of lines.entries()) {
      if (used.has(index)) continue;
      const compact = line.replace(/[\s,]/g, '');
      if (/^\d{1,6}(\.\d{1,2})?$/.test(compact)) {
        amount = sumOf(compact);
        used.add(index);
        break;
      }
    }
  }
  if (!amount) return null;

  /*
   * The bank: a line naming one the counter knows, however it is spelt — "جوال
   * بي" is "جوال باي", "الاسلامي" the "الإسلامي". Failing that, a line that is
   * plainly a bank or a wallet — "محفظة", "بنك …", "pal pay" — is the bank as
   * written, and never mistaken for the name beside it.
   */
  let channel: string | null = null;
  const fold = (value: string) =>
    value
      .replace(/[أإآ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي')
      .replace(/باي|بى/g, 'بي')
      .replace(/\s+/g, '')
      .trim()
      .toLowerCase();
  for (const [index, line] of lines.entries()) {
    if (used.has(index)) continue;
    const known = channels.find(
      (entry) => fold(line).includes(fold(entry)) || fold(entry).includes(fold(line)),
    );
    if (known && letters(line) > 0) {
      channel = known;
      used.add(index);
      break;
    }
  }
  if (!channel) {
    for (const [index, line] of lines.entries()) {
      if (used.has(index)) continue;
      if (BANKISH.test(line) && digitsIn(line) === 0 && line.length <= 40) {
        channel = line;
        used.add(index);
        break;
      }
    }
  }

  // The name: the first line left that is words, not numbers.
  let name: string | null = null;
  for (const [index, line] of lines.entries()) {
    if (used.has(index)) continue;
    if (letters(line) >= 2 && digitsIn(line) <= 2 && line.length <= 60) {
      name = line;
      used.add(index);
      break;
    }
  }

  // An account and a sum alone are not enough: a bank or a name says it is a transfer.
  if (!channel && !name) return null;
  return { account, name, channel, amount, currency };
}
