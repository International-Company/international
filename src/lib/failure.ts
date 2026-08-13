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
      body: t(caught.messageKey as never, caught.params as Record<string, string>) || caught.message,
    };
  }

  return { title: t('errors.title' as never), body: t('errors.generic' as never) };
}
