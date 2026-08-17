import { randomBytes } from 'node:crypto';
import { addressOf } from '../src/modules/usdt/tron-signer';

/**
 * Makes a wallet for the program to send from.
 *
 * ## Why not just export the key of the wallet you already have
 *
 * Because that wallet holds the office's coins, and this key goes onto a
 * server. Whoever reaches the server reaches the key, and the key *is* the
 * coins — so the address whose key lives there should hold what the counter
 * needs for a day or two and nothing more. This makes that second address.
 *
 * ## Why generated here rather than on a website
 *
 * A key typed into a page is a key that page has seen. This one is made from
 * the operating system's own randomness, on this machine, and never leaves it:
 * there is no network call in this file and nothing is written to disk.
 *
 * ## What to do with what it prints
 *
 *   1. The address goes into the program, under "عناوين المحافظ", so the
 *      office can watch it and send from it.
 *   2. The key goes into Railway's variables as TRON_HOT_WALLET_KEY. Nowhere
 *      else — not a file in this repository, not a chat, not a note app.
 *   3. Keep one offline copy of the key somewhere safe. If Railway loses it
 *      and you have no copy, whatever is on that address is gone for good.
 *   4. Fund it with a small float, and with some TRX — a TRC-20 transfer burns
 *      energy, and an address holding USDT but no TRX cannot send.
 */

/*
 * A private key is a number below the curve's order. Values at or above it are
 * invalid, and zero is invalid, so the draw repeats on the (vanishingly rare)
 * occasion it lands outside. Rejection sampling rather than a modulo, because a
 * modulo would quietly bias the low end of the range.
 */
const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function draw(): { hex: string; bytes: Uint8Array } {
  for (let attempt = 0; attempt < 16; attempt++) {
    const bytes = new Uint8Array(randomBytes(32));
    const value = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
    if (value > 0n && value < ORDER) {
      return { hex: Buffer.from(bytes).toString('hex'), bytes };
    }
  }
  throw new Error('Could not draw a key; try again');
}

const key = draw();
const address = addressOf(key.bytes);

console.log('');
console.log('  A new TRON address, and the key that opens it.');
console.log('');
console.log('  العنوان — ضعه في «عناوين المحافظ» داخل البرنامج:');
console.log('');
console.log(`      ${address}`);
console.log('');
console.log('  المفتاح — ضعه في Railway باسم TRON_HOT_WALLET_KEY، ولا شيء غير ذلك:');
console.log('');
console.log(`      ${key.hex}`);
console.log('');
console.log('  ⚠  من يملك هذا المفتاح يملك كل ما على هذا العنوان.');
console.log('     • لا تضعه في ملف داخل المشروع، ولا في محادثة، ولا في تطبيق ملاحظات.');
console.log('     • احتفظ بنسخة واحدة خارج الإنترنت — إن ضاع، ضاع ما على العنوان.');
console.log('     • موّله برصيد صغير فقط، وبقليل من TRX ليدفع رسوم الشبكة.');
console.log('     • أغلق هذه النافذة بعد النسخ.');
console.log('');
