import 'server-only';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { errors } from '@/core/errors/app-error';
import { resolveSession, touchSession, SESSION_COOKIE, type ResolvedSession } from './session.service';

/**
 * Per-request authentication context.
 *
 * `cache()` memoises within a single React server request, so a page that
 * checks permissions in six places still performs exactly one session lookup.
 */

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export const getRequestMeta = cache(async (): Promise<RequestMeta> => {
  const headerList = await headers();

  /*
   * The right-most entry of X-Forwarded-For, not the left-most.
   *
   * Each proxy *appends* the address it received the request from, so the
   * chain reads `client, proxy1, proxy2` and the left-most looks like the
   * client. It is not — it is the first thing in the header, and the header
   * arrives from the client. Anyone can send
   *
   *     X-Forwarded-For: 10.0.0.1
   *
   * and our one real proxy appends the true address after it, leaving a chain
   * whose left-most entry is whatever the caller felt like typing. Reading
   * that put an attacker-chosen value into the audit log's actor IP and made
   * every rate limit keyed on the address escapable by changing one header per
   * request.
   *
   * The right-most entry is the one *our* proxy wrote, about the hop it
   * actually spoke to, and is the only entry no caller can forge. This
   * deployment sits behind exactly one proxy; a second layer in front would
   * mean counting one further in from the right rather than taking the last.
   */
  const chain =
    headerList
      .get('x-forwarded-for')
      ?.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const ip = chain.at(-1) || headerList.get('x-real-ip') || null;

  return { ip, userAgent: headerList.get('user-agent') };
});

export const getSessionToken = cache(async (): Promise<string | undefined> => {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
});

/** Resolves the current session, or null when signed out. */
export const getSession = cache(async (): Promise<ResolvedSession | null> => {
  const token = await getSessionToken();
  if (!token) return null;

  const session = await resolveSession(token);
  if (!session) return null;

  // Sliding expiry. Fire-and-forget: a failed touch must not fail the request.
  void touchSession(session.sessionId, session.absoluteExpiresAt);

  return session;
});

/** Resolves the session or throws — use in any authenticated code path. */
export async function requireSession(): Promise<ResolvedSession> {
  const session = await getSession();
  if (!session) throw errors.unauthenticated();
  return session;
}

/**
 * A session that has cleared every gate: authenticated, second factor
 * satisfied, and not parked on a forced password change.
 */
export async function requireActiveSession(): Promise<ResolvedSession> {
  const session = await requireSession();
  if (session.user.twoFactorEnabled && !session.twoFactorSatisfied) {
    throw errors.unauthenticated('Two-factor verification required');
  }
  return session;
}

export function hasPermission(session: ResolvedSession | null, permission: string): boolean {
  if (!session) return false;
  return session.user.permissions.includes(permission);
}

export function hasAnyPermission(session: ResolvedSession | null, permissions: string[]): boolean {
  if (!session) return false;
  return permissions.some((p) => session.user.permissions.includes(p));
}

export function hasAllPermissions(session: ResolvedSession | null, permissions: string[]): boolean {
  if (!session) return false;
  return permissions.every((p) => session.user.permissions.includes(p));
}

/** Throws `FORBIDDEN` unless the caller holds every listed permission. */
export async function requirePermission(...permissions: string[]): Promise<ResolvedSession> {
  const session = await requireActiveSession();
  const missing = permissions.find((p) => !session.user.permissions.includes(p));
  if (missing) throw errors.forbidden(missing);
  return session;
}

/** Throws `FORBIDDEN` unless the caller holds at least one listed permission. */
export async function requireAnyPermission(...permissions: string[]): Promise<ResolvedSession> {
  const session = await requireActiveSession();
  if (!permissions.some((p) => session.user.permissions.includes(p))) {
    throw errors.forbidden(permissions.join(' | '));
  }
  return session;
}

/** Shapes the session into the actor record the audit log expects. */
export async function auditActor(session: ResolvedSession) {
  const meta = await getRequestMeta();
  return {
    id: session.user.id,
    name: session.user.fullNameEn,
    ip: meta.ip,
    userAgent: meta.userAgent,
    sessionId: session.sessionId,
  };
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

/**
 * The same check, for a screen rather than an endpoint.
 *
 * An endpoint that refuses should throw: the caller is code, and a status is
 * the answer it understands. A person who follows a link they no longer have
 * the right to is not an error — it is the ordinary consequence of a manager
 * taking a permission away, and it happens most to the people least able to
 * make sense of a crash page. So this sends them somewhere that says so in
 * words, in their own language, with a way back.
 *
 * Kept beside the throwing versions rather than replacing them, because the two
 * audiences genuinely want different answers to the same question.
 */
export async function requirePagePermission(
  ...permissions: string[]
): Promise<ResolvedSession> {
  const session = await requireActiveSession();
  const missing = permissions.find((p) => !session.user.permissions.includes(p));
  if (missing) redirect(`/no-access?need=${encodeURIComponent(missing)}`);
  return session;
}

/** As above, for a screen reachable by any one of several permissions. */
export async function requirePageAnyPermission(
  ...permissions: string[]
): Promise<ResolvedSession> {
  const session = await requireActiveSession();
  if (!permissions.some((p) => session.user.permissions.includes(p))) {
    redirect(`/no-access?need=${encodeURIComponent(permissions[0] ?? '')}`);
  }
  return session;
}
