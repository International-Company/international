import { z } from 'zod';
import { route } from '@/core/http/route';
import { readImage } from '@/modules/whatsapp/chat-images';

const paramsSchema = z.object({ id: z.string().min(1) });

/** A photo sent from the inbox, to whoever may read its conversation. */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.whatsapp'],
  paramsSchema,
  handler: async ({ params, actor }) => {
    const image = await readImage(params.id, actor);
    return new Response(new Uint8Array(image.data), {
      headers: {
        'content-type': image.mimeType,
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff',
      },
    });
  },
});
