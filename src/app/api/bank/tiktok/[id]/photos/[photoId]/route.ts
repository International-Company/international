import { z } from 'zod';
import { route } from '@/core/http/route';
import { tiktokPhoto } from '@/modules/bank/bank-tiktok.service';

const paramsSchema = z.object({ id: z.string().min(1), photoId: z.string().min(1) });

/** A photo a TikTok withdrawal carries — `main`, one of the rest, or `receipt` — for the bank desk. */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  paramsSchema,
  handler: async ({ params, actor }) => {
    const photo = await tiktokPhoto(params.id, params.photoId, actor);
    return new Response(new Uint8Array(photo.data), {
      headers: {
        'content-type': photo.mimeType,
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
      },
    });
  },
});
