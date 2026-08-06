import 'server-only';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import {
  DEFAULT_PASSWORD_POLICY,
  hashPassword,
  needsRehash,
  validatePassword,
  verifyPassword,
} from '@/core/security/password';
import { verifyTotp } from '@/core/security/totp';
import { checkRateLimit, RATE_LIMITS, resetRateLimit } from '@/core/security/rate-limit';
import { createLogger } from '@/core/logger/logger';
import { emitAsync } from '@/core/events/bus';
import * as audit from '@/modules/audit/audit.service';
import {
  createSession,
  markTwoFactorSatisfied,
  revokeAllUserSessions,
  revokeSessionByToken,
  type CreatedSession,
} from './session.service';

const log = createLogger('auth');

/** After this many consecutive failures the account is locked temporarily. */
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

export interface LoginContext {
  ip: string | null;
  userAgent: string | null;
}

export type LoginResult =
  | { status: 'SUCCESS'; session: CreatedSession; mustChangePassword: boolean; locale: string }
  | { status: 'TWO_FACTOR_REQUIRED'; session: CreatedSession }
  | { status: 'PASSWORD_EXPIRED'; session: CreatedSession };

/**
 * Authenticates a user.
 *
 * Failures are intentionally indistinguishable to the caller — unknown user,
 * wrong password and disabled account all raise the same error, so the endpoint
 * cannot be used to enumerate valid usernames.
 */
export async function login(
  input: { identifier: string; password: string; totp?: string },
  context: LoginContext,
): Promise<LoginResult> {
  const identifier = input.identifier.trim().toLowerCase();

  const ipLimit = checkRateLimit(`login:ip:${context.ip ?? 'unknown'}`, RATE_LIMITS.login);
  if (!ipLimit.allowed) throw errors.rateLimited(ipLimit.retryAfterSeconds);

  const accountLimit = checkRateLimit(`login:user:${identifier}`, RATE_LIMITS.loginPerAccount);
  if (!accountLimit.allowed) throw errors.rateLimited(accountLimit.retryAfterSeconds);

  const user = await prisma.user.findFirst({
    where: { OR: [{ username: identifier }, { email: identifier }] },
  });

  const fail = async (reason: string) => {
    await prisma.loginAttempt.create({
      data: {
        username: identifier,
        ip: context.ip,
        userAgent: context.userAgent?.slice(0, 500) ?? null,
        successful: false,
        reason,
      },
    });
    emitAsync('user.login.failed', { username: identifier, ip: context.ip, reason });
  };

  if (!user) {
    // Spend comparable time to a real verification so timing does not leak
    // whether the account exists.
    await verifyPassword(input.password, 'scrypt$32768$8$1$AAAA$AAAA');
    await fail('UNKNOWN_USER');
    throw errors.unauthenticated('Invalid credentials');
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await fail('LOCKED');
    throw errors.accountLocked(user.lockedUntil);
  }

  if (user.status !== 'ACTIVE') {
    await fail(`STATUS_${user.status}`);
    throw errors.unauthenticated('Invalid credentials');
  }

  const passwordOk = await verifyPassword(input.password, user.passwordHash);

  if (!passwordOk) {
    const failedCount = user.failedLoginCount + 1;
    const shouldLock = failedCount >= MAX_FAILED_LOGINS;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: failedCount,
        ...(shouldLock
          ? {
              lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60_000),
              status: 'LOCKED',
            }
          : {}),
      },
    });

    await fail('BAD_PASSWORD');

    if (shouldLock) {
      emitAsync('user.locked', { userId: user.id, username: user.username });
      await audit.record({
        action: 'SECURITY',
        module: 'users',
        entityType: 'User',
        entityId: user.id,
        summaryEn: `Account "${user.username}" locked after ${failedCount} failed sign-in attempts`,
        summaryAr: `تم قفل حساب "${user.username}" بعد ${failedCount} محاولات دخول فاشلة`,
        actor: { id: user.id, name: user.username, ip: context.ip, userAgent: context.userAgent },
        metadata: { failedCount, lockoutMinutes: LOCKOUT_MINUTES },
      });
      throw errors.accountLocked();
    }

    throw errors.unauthenticated('Invalid credentials');
  }

  // --- Password accepted --------------------------------------------------

  // Transparently upgrade hashes produced with older, cheaper parameters.
  if (needsRehash(user.passwordHash)) {
    const upgraded = await hashPassword(input.password);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: upgraded } });
    log.info('Upgraded password hash parameters', { userId: user.id });
  }

  const requiresTwoFactor = user.twoFactorEnabled && !!user.twoFactorSecret;
  let twoFactorSatisfied = !requiresTwoFactor;

  if (requiresTwoFactor && input.totp) {
    const totpLimit = checkRateLimit(`totp:${user.id}`, RATE_LIMITS.twoFactor);
    if (!totpLimit.allowed) throw errors.rateLimited(totpLimit.retryAfterSeconds);

    if (!verifyTotp(input.totp, user.twoFactorSecret!)) {
      await fail('BAD_TOTP');
      throw errors.unauthenticated('Invalid verification code');
    }
    twoFactorSatisfied = true;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      lastLoginIp: context.ip,
    },
  });

  resetRateLimit(`login:user:${identifier}`);

  const session = await createSession(user.id, {
    ip: context.ip,
    userAgent: context.userAgent,
    twoFactorSatisfied,
  });

  await prisma.loginAttempt.create({
    data: {
      username: identifier,
      ip: context.ip,
      userAgent: context.userAgent?.slice(0, 500) ?? null,
      successful: true,
      reason: twoFactorSatisfied ? null : 'PENDING_2FA',
    },
  });

  if (!twoFactorSatisfied) {
    return { status: 'TWO_FACTOR_REQUIRED', session };
  }

  emitAsync('user.login', { userId: user.id, ip: context.ip });
  await audit.record({
    action: 'LOGIN',
    module: 'auth',
    entityType: 'User',
    entityId: user.id,
    summaryEn: `${user.fullNameEn} signed in`,
    summaryAr: `${user.fullNameAr} سجّل الدخول`,
    actor: {
      id: user.id,
      name: user.fullNameEn,
      ip: context.ip,
      userAgent: context.userAgent,
      sessionId: session.sessionId,
    },
  });

  if (isPasswordExpired(user.passwordUpdatedAt) || user.mustChangePassword) {
    return { status: 'PASSWORD_EXPIRED', session };
  }

  return {
    status: 'SUCCESS',
    session,
    mustChangePassword: user.mustChangePassword,
    locale: user.locale,
  };
}

/** Completes a session that stopped at the second-factor step. */
export async function verifySecondFactor(
  sessionId: string,
  userId: string,
  code: string,
  context: LoginContext,
): Promise<void> {
  const limit = checkRateLimit(`totp:${userId}`, RATE_LIMITS.twoFactor);
  if (!limit.allowed) throw errors.rateLimited(limit.retryAfterSeconds);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.twoFactorSecret) throw errors.precondition('Two-factor authentication is not configured');

  if (!verifyTotp(code, user.twoFactorSecret)) {
    throw errors.unauthenticated('Invalid verification code');
  }

  await markTwoFactorSatisfied(sessionId);
  resetRateLimit(`totp:${userId}`);

  emitAsync('user.login', { userId, ip: context.ip });
  await audit.record({
    action: 'LOGIN',
    module: 'auth',
    entityType: 'User',
    entityId: userId,
    summaryEn: `${user.fullNameEn} completed two-factor verification`,
    summaryAr: `${user.fullNameAr} أكمل التحقق بخطوتين`,
    actor: { id: userId, name: user.fullNameEn, ip: context.ip, sessionId },
  });
}

export async function logout(
  token: string,
  actor: { id: string; name: string; sessionId: string },
  context: LoginContext,
): Promise<void> {
  await revokeSessionByToken(token, 'USER_LOGOUT');
  await audit.record({
    action: 'LOGOUT',
    module: 'auth',
    entityType: 'User',
    entityId: actor.id,
    summaryEn: `${actor.name} signed out`,
    summaryAr: `${actor.name} سجّل الخروج`,
    actor: { ...actor, ip: context.ip, userAgent: context.userAgent },
  });
}

// ---------------------------------------------------------------------------
// Password management
// ---------------------------------------------------------------------------

export function isPasswordExpired(passwordUpdatedAt: Date): boolean {
  const maxAge = DEFAULT_PASSWORD_POLICY.maxAgeDays;
  if (maxAge <= 0) return false;
  return Date.now() - passwordUpdatedAt.getTime() > maxAge * 86_400_000;
}

/**
 * Changes the caller's own password. Requires the current password, enforces
 * the policy and the reuse window, then revokes every other session — a
 * password change is how an operator responds to a suspected compromise, so it
 * must actually evict anyone else holding a token.
 */
export async function changeOwnPassword(
  userId: string,
  input: { currentPassword: string; newPassword: string },
  context: LoginContext & { sessionId: string },
): Promise<void> {
  const limit = checkRateLimit(`pwd:${userId}`, RATE_LIMITS.passwordChange);
  if (!limit.allowed) throw errors.rateLimited(limit.retryAfterSeconds);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw errors.notFound('User', userId);

  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw errors.unauthenticated('Current password is incorrect');
  }

  await applyNewPassword(user.id, input.newPassword, {
    username: user.username,
    email: user.email,
    fullName: user.fullNameEn,
  });

  const revoked = await revokeAllUserSessions(userId, 'PASSWORD_CHANGED', {
    exceptSessionId: context.sessionId,
  });

  await audit.record({
    action: 'PASSWORD_CHANGE',
    module: 'auth',
    entityType: 'User',
    entityId: userId,
    summaryEn: `${user.fullNameEn} changed their password`,
    summaryAr: `${user.fullNameAr} غيّر كلمة المرور الخاصة به`,
    actor: {
      id: userId,
      name: user.fullNameEn,
      ip: context.ip,
      userAgent: context.userAgent,
      sessionId: context.sessionId,
    },
    metadata: { otherSessionsRevoked: revoked },
  });
}

/**
 * Validates, hashes and stores a new password, recording it in the reuse
 * history. Shared by self-service change and administrative reset.
 */
export async function applyNewPassword(
  userId: string,
  newPassword: string,
  identity: { username: string; email: string; fullName: string },
  options: { mustChangePassword?: boolean } = {},
): Promise<void> {
  const issues = validatePassword(newPassword, DEFAULT_PASSWORD_POLICY, identity);
  if (issues.length > 0) throw errors.passwordPolicy(issues);

  const depth = DEFAULT_PASSWORD_POLICY.historyDepth;
  if (depth > 0) {
    const history = await prisma.passwordHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: depth,
    });
    for (const previous of history) {
      if (await verifyPassword(newPassword, previous.hash)) {
        throw errors.passwordPolicy([
          {
            path: 'newPassword',
            code: 'reuse',
            message: `Password was used within the last ${depth} changes`,
          },
        ]);
      }
    }
  }

  const hash = await hashPassword(newPassword);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        passwordHash: hash,
        passwordUpdatedAt: new Date(),
        mustChangePassword: options.mustChangePassword ?? false,
        failedLoginCount: 0,
        lockedUntil: null,
        ...(options.mustChangePassword ? {} : { status: 'ACTIVE' }),
      },
    });

    await tx.passwordHistory.create({ data: { userId, hash } });

    // Keep the history table bounded to the configured depth.
    const stale = await tx.passwordHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: depth,
      select: { id: true },
    });
    if (stale.length > 0) {
      await tx.passwordHistory.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    }
  });
}
