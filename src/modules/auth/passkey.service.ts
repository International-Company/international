import 'server-only';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import { checkRateLimit, RATE_LIMITS } from '@/core/security/rate-limit';
import * as audit from '@/modules/audit/audit.service';
import { issueSession, type LoginContext, type LoginResult } from './auth.service';

/**
 * Signing in with a fingerprint.
 *
 * A passkey, which is a key pair the phone or laptop creates and keeps in its
 * secure element. The private half never leaves the device and is released only
 * after the device has verified the person holding it — so one touch of a
 * sensor proves two things at once: possession of this device, and that the
 * right person is holding it.
 *
 * It is stronger than the password it replaces, not weaker, and in one specific
 * way that matters here: the browser binds every signature to this origin. A
 * copy of the login page on a lookalike domain gets a signature the real server
 * will not accept — which no password, however long, can promise.
 *
 * What the server stores is the public half. Someone who steals this whole
 * table can sign in as nobody.
 */

const log = createLogger('auth:passkey');

/** Long enough to find the sensor, short enough that a stolen one is stale. */
const CHALLENGE_TTL_MS = 3 * 60_000;

const RP_NAME = 'انترنشونال';

/**
 * Which origin the credential belongs to.
 *
 * This has to be the domain **the browser thinks it is on**, exactly. A key
 * registered for one domain is refused on any other — that is what makes a
 * passkey phishing-resistant, and it is also what makes a wrong answer here
 * fail every sign-in with a security error rather than a subtle bug.
 *
 * `request.url` is the wrong source behind a proxy. The platform terminates TLS
 * and forwards to the process over plain HTTP on an internal hostname, so the
 * URL the handler sees can be `http://0.0.0.0:8080/…` while the browser is on
 * `https://exchange.example.com`. The forwarded headers are what carry the real
 * one, which is why they are read first.
 *
 * A forged header cannot steal anything: the browser refuses to sign for an RP
 * ID that is not a suffix of its own origin, so the worst case is a failure.
 */
export function relyingParty(request: { url: string; headers: Headers }): {
  rpId: string;
  origin: string;
} {
  if (process.env.WEBAUTHN_RP_ID && process.env.WEBAUTHN_ORIGIN) {
    return { rpId: process.env.WEBAUTHN_RP_ID, origin: process.env.WEBAUTHN_ORIGIN };
  }

  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || request.headers.get('host') || new URL(request.url).host;
  const proto =
    request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ||
    new URL(request.url).protocol.replace(':', '');

  // The RP ID is a domain, never a port: `localhost:3000` is not one.
  const rpId = process.env.WEBAUTHN_RP_ID || host.split(':')[0]!;
  const origin = process.env.WEBAUTHN_ORIGIN || `${proto}://${host}`;

  return { rpId, origin };
}

async function newChallenge(challenge: string, purpose: 'REGISTER' | 'LOGIN', userId?: string) {
  // Anything left from an abandoned attempt goes now, so the table cannot grow
  // without bound on a login page somebody keeps open.
  await prisma.webAuthnChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } });

  return prisma.webAuthnChallenge.create({
    data: {
      challenge,
      purpose,
      userId: userId ?? null,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    },
  });
}

/**
 * Takes a challenge, once.
 *
 * The delete is the race: two answers to the same challenge arrive, and the one
 * whose delete reports a row is the one that counts. That is what stops a
 * captured response being replayed a second time.
 */
async function consumeChallenge(id: string, purpose: 'REGISTER' | 'LOGIN') {
  const row = await prisma.webAuthnChallenge.findUnique({ where: { id } });
  if (!row || row.purpose !== purpose) {
    throw errors.precondition('That sign-in attempt is no longer valid', 'errors.challengeInvalid');
  }

  const { count } = await prisma.webAuthnChallenge.deleteMany({ where: { id } });
  if (count === 0) {
    throw errors.precondition('That sign-in attempt is no longer valid', 'errors.challengeInvalid');
  }
  if (row.expiresAt < new Date()) {
    throw errors.precondition('That sign-in attempt has expired', 'errors.challengeExpired');
  }

  return row;
}

// ---------------------------------------------------------------------------
// Enrolling a device
// ---------------------------------------------------------------------------

/**
 * Offers a device the chance to create a key for this user.
 *
 * Only ever called inside an authenticated session. Adding a way into an
 * account is as consequential as changing its password, so it is done from
 * inside the account and never from the login screen.
 */
export async function registrationOptions(
  user: { id: string; username: string; fullNameEn: string },
  request: { url: string; headers: Headers },
) {
  const { rpId } = relyingParty(request);

  const existing = await prisma.passkey.findMany({
    where: { userId: user.id },
    select: { credentialId: true, transports: true },
  });

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpId,
    userID: new TextEncoder().encode(user.id),
    userName: user.username,
    userDisplayName: user.fullNameEn,
    // No attestation. It would tell us which brand of authenticator this is,
    // which we would never act on, at the cost of collecting a device
    // identifier we have no use for.
    attestationType: 'none',
    // Offering what is already registered stops the authenticator creating a
    // second key for the same account on the same device.
    excludeCredentials: existing.map((key) => ({
      id: key.credentialId,
      transports: parseTransports(key.transports),
    })),
    authenticatorSelection: {
      // The sensor built into this device, not a key on a keyring. It is the
      // phone in the teller's hand that we are binding to.
      authenticatorAttachment: 'platform',
      /*
       * Required, not preferred — and the difference is the whole feature.
       *
       * Sign-in offers no username and no credential list, so the authenticator
       * has to be able to produce the key from nothing but the domain. A
       * credential created as merely "preferred" may not be discoverable, and
       * the button would then find nothing on a device that had plainly
       * enrolled.
       */
      residentKey: 'required',
      // The whole point. Without it the key proves possession of the device and
      // nothing about who is holding it, which is not what was asked for.
      userVerification: 'required',
    },
  });

  const row = await newChallenge(options.challenge, 'REGISTER', user.id);
  return { challengeId: row.id, options };
}

export async function verifyRegistration(
  input: { challengeId: string; response: unknown; label: string },
  user: { id: string; fullNameEn: string; fullNameAr: string },
  context: LoginContext & { request: { url: string; headers: Headers } },
) {
  const challenge = await consumeChallenge(input.challengeId, 'REGISTER');
  if (challenge.userId !== user.id) {
    throw errors.forbidden('users.update');
  }

  const { rpId, origin } = relyingParty(context.request);

  const verification = await verifyRegistrationResponse({
    // The library validates the shape; a malformed body fails verification
    // rather than being trusted through a cast we made up.
    response: input.response as Parameters<typeof verifyRegistrationResponse>[0]['response'],
    expectedChallenge: challenge.challenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    requireUserVerification: true,
  }).catch(() => {
    throw errors.precondition('That device could not be registered', 'errors.passkeyRejected');
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw errors.precondition('That device could not be registered', 'errors.passkeyRejected');
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  const label = input.label.trim().slice(0, 60) || 'جهاز';

  const saved = await prisma.passkey.create({
    data: {
      userId: user.id,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: BigInt(credential.counter),
      transports: credential.transports ? JSON.stringify(credential.transports) : null,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      label,
      createdIp: context.ip,
    },
  });

  await audit.record({
    action: 'SECURITY',
    module: 'auth',
    entityType: 'Passkey',
    entityId: saved.id,
    summaryEn: `${user.fullNameEn} registered a passkey: ${label}`,
    summaryAr: `${user.fullNameAr} سجّل بصمة على جهاز: ${label}`,
    actor: { id: user.id, name: user.fullNameEn, ip: context.ip, userAgent: context.userAgent },
  });

  log.info('Passkey registered', { userId: user.id, label });
  return { id: saved.id, label: saved.label, createdAt: saved.createdAt };
}

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

/**
 * Offers a challenge to whoever is at the login screen.
 *
 * No username is asked for and none is implied. The credentials are
 * discoverable, so the device knows which accounts it holds keys for and
 * offers them; the server learns who this is only from a signature it has
 * verified.
 */
export async function authenticationOptions(request: { url: string; headers: Headers }) {
  const { rpId } = relyingParty(request);

  const options = await generateAuthenticationOptions({
    rpID: rpId,
    userVerification: 'required',
    // Empty on purpose — see above. Listing credentials for a username typed at
    // the login screen would tell an attacker which usernames exist.
    allowCredentials: [],
  });

  const row = await newChallenge(options.challenge, 'LOGIN');
  return { challengeId: row.id, options };
}

/**
 * Verifies a signature and, if it holds, signs the user in.
 *
 * Every gate the password path applies is applied here too — a locked account,
 * a suspended one, an expired password — because a second door into the same
 * building has to have the same lock. The session itself is issued by the very
 * function the password path calls, rather than by a copy of it.
 */
export async function verifyAuthentication(
  input: { challengeId: string; response: unknown },
  context: LoginContext & { request: { url: string; headers: Headers } },
): Promise<LoginResult> {
  const limit = checkRateLimit(`passkey:ip:${context.ip ?? 'unknown'}`, RATE_LIMITS.login);
  if (!limit.allowed) throw errors.rateLimited(limit.retryAfterSeconds);

  const challenge = await consumeChallenge(input.challengeId, 'LOGIN');

  const response = input.response as Parameters<
    typeof verifyAuthenticationResponse
  >[0]['response'];

  const passkey = await prisma.passkey.findUnique({
    where: { credentialId: response?.id ?? '' },
    include: { user: true },
  });
  if (!passkey) {
    throw errors.unauthenticated('Invalid credentials');
  }

  const { user } = passkey;

  // The same gates, in the same order, as a password sign-in.
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw errors.accountLocked(user.lockedUntil);
  }
  if (user.status !== 'ACTIVE') {
    throw errors.unauthenticated('Invalid credentials');
  }

  const { rpId, origin } = relyingParty(context.request);

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    requireUserVerification: true,
    credential: {
      id: passkey.credentialId,
      publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
      counter: Number(passkey.counter),
      transports: parseTransports(passkey.transports),
    },
  }).catch(() => {
    throw errors.unauthenticated('Invalid credentials');
  });

  if (!verification.verified) {
    throw errors.unauthenticated('Invalid credentials');
  }

  await prisma.passkey.update({
    where: { id: passkey.id },
    data: {
      counter: BigInt(verification.authenticationInfo.newCounter),
      lastUsedAt: new Date(),
    },
  });

  /*
   * The second factor is already satisfied, and this is a deliberate ruling.
   *
   * A policy that demanded a code on top would be asking for a second factor
   * twice: the key proves the device, and the device would not have released it
   * without verifying the person. Sending them to fetch a six-digit code after
   * that adds friction and no security.
   */
  return issueSession(user, user.username, context, {
    twoFactorSatisfied: true,
    method: 'PASSKEY',
  });
}

// ---------------------------------------------------------------------------
// Managing them
// ---------------------------------------------------------------------------

export async function listForUser(userId: string) {
  return prisma.passkey.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, label: true, createdAt: true, lastUsedAt: true, backedUp: true },
  });
}

/**
 * Removes a device.
 *
 * Scoped to its owner in the `where`, not checked afterwards: an id belonging
 * to somebody else's account deletes nothing rather than deleting theirs.
 */
export async function remove(
  id: string,
  user: { id: string; fullNameEn: string; fullNameAr: string },
  context: LoginContext,
) {
  const passkey = await prisma.passkey.findFirst({ where: { id, userId: user.id } });
  if (!passkey) throw errors.notFound('Passkey', id);

  await prisma.passkey.delete({ where: { id: passkey.id } });

  await audit.record({
    action: 'SECURITY',
    module: 'auth',
    entityType: 'Passkey',
    entityId: id,
    summaryEn: `${user.fullNameEn} removed a passkey: ${passkey.label}`,
    summaryAr: `${user.fullNameAr} أزال بصمة جهاز: ${passkey.label}`,
    actor: { id: user.id, name: user.fullNameEn, ip: context.ip, userAgent: context.userAgent },
  });
}

function parseTransports(value: string | null): AuthenticatorTransportFuture[] | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as AuthenticatorTransportFuture[]) : undefined;
  } catch {
    return undefined;
  }
}
