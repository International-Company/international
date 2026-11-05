import { z } from 'zod';
import { route } from '@/core/http/route';
import { readPhoto } from '@/modules/tiktok/tiktok.service';

const paramsSchema = z.object({ id: z.string().min(1) });

export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['exchange.remittance.use'],
  paramsSchema,
  handler: async ({ params, actor }) => {
    const photo = await readPhoto(params.id, actor);
    return new Response(new Uint8Array(photo.data), {
      headers: {
        'content-type': photo.mimeType,
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
      },
    });
  },
});
