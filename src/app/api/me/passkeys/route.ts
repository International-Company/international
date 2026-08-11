import { z } from 'zod';
import { route } from '@/core/http/route';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import * as passkeys from '@/modules/auth/passkey.service';

/**
 * The devices a person may sign in from.
 *
 * Everything here is scoped to whoever is asking — enrolling a device is as
 * consequential as changing a password, so it happens from inside the account
 * and never from the sign-in screen. There is no route that lets one user touch
 * another's devices; the manager's tool for that is revoking the account.
 */

export const GET = route({
  handler: async ({ actor }) => passkeys.listForUser(actor.id),
});

const bodySchema = z.discriminatedUnion('step', [
  z.object({ step: z.literal('options') }),
  z.object({
    step: z.literal('verify'),
    challengeId: z.string().min(1).max(60),
    response: z.unknown(),
    label: z.string().min(1).max(60),
  }),
]);

export const POST = route<z.infer<typeof bodySchema>>({
  bodySchema,
  rateLimit: { key: 'passkey-enrol', limit: 20, windowSeconds: 600 },
  handler: async ({ body, request, actor, meta }) => {
    const user = await prisma.user.findUnique({
      where: { id: actor.id },
      select: { id: true, username: true, fullNameEn: true, fullNameAr: true },
    });
    if (!user) throw errors.notFound('User', actor.id);

    if (body.step === 'options') {
      return passkeys.registrationOptions(user, request);
    }

    return passkeys.verifyRegistration(
      { challengeId: body.challengeId, response: body.response, label: body.label },
      user,
      { ip: meta.ip, userAgent: meta.userAgent, request },
    );
  },
});

const removeSchema = z.object({ id: z.string().min(1).max(60) });

export const DELETE = route<unknown, z.infer<typeof removeSchema>>({
  querySchema: removeSchema,
  handler: async ({ query, actor, meta }) => {
    const user = await prisma.user.findUnique({
      where: { id: actor.id },
      select: { id: true, fullNameEn: true, fullNameAr: true },
    });
    if (!user) throw errors.notFound('User', actor.id);

    await passkeys.remove(query.id, user, { ip: meta.ip, userAgent: meta.userAgent });
    return { removed: query.id };
  },
});
