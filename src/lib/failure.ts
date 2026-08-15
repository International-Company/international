import { ApiError } from './api-client';

/**
 * Turning a failed request into something worth showing a person.
 *
 * A refusal is not a malfunction. "There are no dinars in the drawer" is a
 * definite, correct answer to a definite question, and heading it "something
 * went wrong" tells the teller the system broke when the system in fact worked
 * — which is how people learn to retry instead of to read.
 *
 * So the title follows the status. Anything the server refused on purpose
 * (4xx) is headed as a refusal; only a genuine fault or an unreachable network
 * gets the apology.
 */
export function describeFailure(
  caught: unknown,
  t: (key: never, params?: Record<string, string>) => string,
): { title: string; body: string } {
  if (caught instanceof ApiError) {
    const refused = caught.status >= 400 && caught.status < 500 && caught.status !== 408;
    return {
      title: t((refused ? 'errors.refusedTitle' : 'errors.title') as never),
      body: say(t, caught.messageKey, caught.params) || caught.message,
    };
  }

  return { title: t('errors.title' as never), body: t('errors.generic' as never) };
}

/**
 * A translated sentence, or nothing at all.
 *
 * `translate` returns the key itself when it finds no entry, which is right for
 * a label — an untranslated button reads as obviously unfinished rather than
 * mysteriously blank. But it makes `t(key) || message` a fallback that can
 * never fire: the key is a truthy string, so the sentence the server wrote is
 * unreachable and the teller reads `errors.splitNeedsPayAmount` where a refusal
 * should be. Returning nothing for a missing key is what puts the server's own
 * words back within reach.
 */
export function say(
  t: (key: never, params?: Record<string, string>) => string,
  key: string | undefined | null,
  params?: unknown,
): string {
  if (!key) return '';
  const text = t(key as never, params as Record<string, string>);
  return text === key ? '' : text;
}
