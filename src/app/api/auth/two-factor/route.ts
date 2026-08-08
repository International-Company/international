import { z } from 'zod';
import { route } from '@/core/http/route';
import { verifySecondFactor } from '@/modules/auth/auth.service';

const bodySchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const POST = route<z.infer<typeof bodySchema>>({
  allowPendingTwoFactor: true,
  bodySchema,
  rateLimit: { key: 'two-factor', limit: 10, windowSeconds: 300 },
  handler: async ({ body, session, meta }) => {
    await verifySecondFactor(session.sessionId, session.user.id, body.code, {
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { redirect: '/' };
  },
});
