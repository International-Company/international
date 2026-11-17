import { z } from 'zod';
import { route } from '@/core/http/route';
import { addPhoto } from '@/modules/tiktok/tiktok.service';

const paramsSchema = z.object({ id: z.string().min(1) });

/** A further photo, shrunk by the screen, as base64. */
const bodySchema = z.object({ photo: z.string().min(1).max(6_000_000) });

/** Attaches a further photo to a withdrawal already recorded: the transfer's receipt, say. */
export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['exchange.remittance.use'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) => addPhoto(params.id, body.photo, actor),
});
