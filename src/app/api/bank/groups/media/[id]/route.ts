import { z } from 'zod';
import { route } from '@/core/http/route';
import { media } from '@/modules/bank/group-feed.service';

const paramsSchema = z.object({ id: z.string().min(1) });

/** A photo or document a followed group's message carried. */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  paramsSchema,
  handler: async ({ params, actor }) => {
    const file = await media(params.id, actor);
    return new Response(new Uint8Array(file.data), {
      headers: {
        'content-type': file.mimeType,
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
        ...(file.mimeType.startsWith('image/')
          ? {}
          : {
              'content-disposition': `attachment; filename="${encodeURIComponent(file.fileName ?? 'file')}"`,
            }),
      },
    });
  },
});
