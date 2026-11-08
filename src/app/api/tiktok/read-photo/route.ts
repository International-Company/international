import { z } from 'zod';
import { route } from '@/core/http/route';
import { readWithdrawalPhoto } from '@/modules/tiktok/photo-reader';

const bodySchema = z.object({
  /** The photo, shrunk by the screen, as base64. The service checks what it is. */
  photo: z.string().min(1).max(6_000_000),
});

/** The figures on a withdrawal's photo, to fill the form. Nothing is kept here. */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['exchange.remittance.use'],
  bodySchema,
  handler: async ({ body }) => readWithdrawalPhoto(body.photo),
});
