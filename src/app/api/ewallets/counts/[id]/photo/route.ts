import { z } from 'zod';
import { route } from '@/core/http/route';
import { countScreenshot } from '@/modules/treasury/ewallet.service';

const paramsSchema = z.object({ id: z.string().min(1) });

/** The screenshot of the wallet's balance a count was made with. */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: ['treasury.handover.manage', 'ewallet.use'],
  paramsSchema,
  handler: async ({ params, actor }) => {
    const file = await countScreenshot(params.id, actor);
    return new Response(new Uint8Array(file.data), {
      headers: { 'content-type': file.mimeType, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' },
    });
  },
});
