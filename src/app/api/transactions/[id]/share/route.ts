import { z } from 'zod';
import { route } from '@/core/http/route';
import { LOCALES } from '@/i18n/config';
import * as share from '@/modules/exchange/share.service';

const paramsSchema = z.object({ id: z.string().min(1) });
const querySchema = z.object({ locale: z.enum(LOCALES).optional() });

/**
 * A transaction written out as a message.
 *
 * Behind the receipt permission and not one of its own. It is the same
 * information on the same paper going to the same person — a separate
 * permission would be a second switch for one decision, and the office would
 * eventually find it turned the wrong way and not know why.
 *
 * Composing is a GET because composing changes nothing. What is worth recording
 * is the sending, and that is the POST below.
 */
export const GET = route<unknown, z.infer<typeof querySchema>, z.infer<typeof paramsSchema>>({
  permissions: ['exchange.receipt.print'],
  paramsSchema,
  querySchema,
  handler: async ({ params, query }) => share.shareable(params.id, query.locale ?? 'ar'),
});

const bodySchema = z.object({ channel: z.enum(share.SHARE_CHANNELS) });

/**
 * Records that it was actually sent.
 *
 * Separate from the GET so the browser can hold the text before the person
 * chooses what to do with it: a native share sheet has to open inside the click
 * that asked for it, and a round trip in between is enough for some browsers to
 * decide the gesture has passed and refuse.
 */
export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['exchange.receipt.print'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) => {
    await share.recordShare(params.id, body.channel, actor);
    return { recorded: true };
  },
});
