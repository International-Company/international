import { z } from 'zod';
import { route } from '@/core/http/route';
import { prisma } from '@/core/db/prisma';
import { LOCALES } from '@/i18n/config';

const bodySchema = z.object({
  locale: z.enum(LOCALES).optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  density: z.enum(['comfortable', 'compact']).optional(),
});

/**
 * Persists interface preferences to the user's profile so they follow the
 * operator to any workstation. The cookie already made the change take effect
 * locally; this is the durable copy.
 */
export const PATCH = route<z.infer<typeof bodySchema>>({
  allowPendingTwoFactor: true,
  bodySchema,
  handler: async ({ body, session }) => {
    if (Object.keys(body).length === 0) return { ok: true };

    await prisma.user.update({
      where: { id: session.user.id },
      data: body,
    });

    return { ok: true };
  },
});
