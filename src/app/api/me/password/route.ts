import { z } from 'zod';
import { route } from '@/core/http/route';
import { changeOwnPassword } from '@/modules/auth/auth.service';

const bodySchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(1),
    confirmPassword: z.string().min(1),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    path: ['newPassword'],
    message: 'The new password must differ from the current one',
  });

export const POST = route<z.infer<typeof bodySchema>>({
  // A user parked on a forced password change has not cleared every gate yet,
  // but must still be able to complete exactly this action.
  allowPendingTwoFactor: true,
  bodySchema,
  rateLimit: { key: 'password-change', limit: 5, windowSeconds: 900 },
  handler: async ({ body, session, meta }) => {
    await changeOwnPassword(
      session.user.id,
      { currentPassword: body.currentPassword, newPassword: body.newPassword },
      { ip: meta.ip, userAgent: meta.userAgent, sessionId: session.sessionId },
    );

    return { ok: true, redirect: '/' };
  },
});
