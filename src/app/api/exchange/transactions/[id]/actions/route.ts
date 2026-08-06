import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import * as transactions from '@/modules/exchange/transaction.service';

const paramsSchema = z.object({ id: z.string().min(1) });

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('submit') }),
  z.object({ action: z.literal('approve'), comment: z.string().max(500).optional() }),
  z.object({ action: z.literal('reject'), reason: z.string().min(3).max(500) }),
  z.object({ action: z.literal('post') }),
  z.object({ action: z.literal('reverse'), reason: z.string().min(3).max(500) }),
  z.object({ action: z.literal('cancel'), reason: z.string().min(3).max(500) }),
]);

/**
 * State transitions for a transaction.
 *
 * One endpoint rather than six, because the permission required depends on the
 * action and keeping that mapping in a single place makes it reviewable. Each
 * branch checks its own permission before the service is reached.
 */
export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) => {
    const require = (permission: string) => {
      if (!actor.permissions.includes(permission)) throw errors.forbidden(permission);
    };

    switch (body.action) {
      case 'submit':
        require('exchange.transaction.create');
        return transactions.submit(params.id, actor);

      case 'approve':
        require('exchange.transaction.approve');
        return transactions.approve(params.id, actor, { comment: body.comment });

      case 'reject':
        require('exchange.transaction.reject');
        await transactions.reject(params.id, body.reason, actor);
        return { status: 'REJECTED' };

      case 'post':
        require('exchange.transaction.post');
        await transactions.post(params.id, actor);
        return { status: 'POSTED' };

      case 'reverse':
        require('exchange.transaction.reverse');
        return transactions.reverse(params.id, body.reason, actor);

      case 'cancel':
        require('exchange.transaction.delete');
        await transactions.cancel(params.id, body.reason, actor);
        return { status: 'CANCELLED' };
    }
  },
});
