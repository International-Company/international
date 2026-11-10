import { createLogger } from '@/core/logger/logger';

/**
 * The WhatsApp encryption library writes straight to the console. Once a linked
 * device falls out of step it writes thousands of lines a minute, enough to make
 * the host drop the log, and some of those lines print session keys. They are
 * taken out here and reported as a count, so that it still shows that it happened.
 */

const log = createLogger('whatsapp:signal');
const REPORT_EVERY = 10 * 60 * 1000;

const PHRASES = [
  'Session error:',
  'Failed to decrypt message with any known session',
  'Closing session:',
  'Opening session:',
  'Removing old closed session:',
  'Closing open session in favor of incoming prekey bundle',
  'Decrypted message with closed session',
  'Session already closed',
  'Session already open',
];

/** Whether a console line is the library's own chatter. */
export function isSignalNoise(first: unknown): boolean {
  return typeof first === 'string' && PHRASES.some((phrase) => first.startsWith(phrase));
}

/** A failure to read one's own message from another device: nothing a customer sent. */
export function isOwnDecryptFailure(detail: unknown, message?: string): boolean {
  if (message !== 'failed to decrypt message') return false;
  const key = (detail as { key?: { fromMe?: boolean } } | null)?.key;
  return key?.fromMe === true;
}

const counts = globalThis as unknown as { __ifmsSignalNoise?: { hidden: number } };

/** Counts a line kept out of the log. */
export function countHidden(): void {
  (counts.__ifmsSignalNoise ??= { hidden: 0 }).hidden += 1;
}

const installed = globalThis as unknown as { __ifmsSignalFilter?: boolean };

/** Once per process, however many bundles load this. */
export function installSignalFilter(): void {
  if (installed.__ifmsSignalFilter) return;
  installed.__ifmsSignalFilter = true;

  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      if (isSignalNoise(args[0])) countHidden();
      else original(...args);
    };
  }

  setInterval(() => {
    const state = counts.__ifmsSignalNoise;
    if (!state?.hidden) return;
    log.info('Encryption messages kept out of the log', { lines: state.hidden });
    state.hidden = 0;
  }, REPORT_EVERY).unref();
}
