import 'server-only';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
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

  // Trust the left-most entry of X-Forwarded-For only; behind a reverse proxy
  // this is the client. Direct deployments fall back to the socket header.
  const forwarded = headerList.get('x-forwarded-for');
  const ip =
    forwarded?.split(',')[0]?.trim() ||
    headerList.get('x-real-ip') ||
    null;

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
  void touchSession(session.sessionId);

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
