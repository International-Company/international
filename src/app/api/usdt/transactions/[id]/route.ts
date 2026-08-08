import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import { markReconciled } from '@/modules/usdt/sync.service';
import { prisma } from '@/core/db/prisma';

const paramsSchema = z.object({ id: z.string().min(1) });

export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['usdt.transaction.view'],
  paramsSchema,
  handler: async ({ params }) => {
    const record = await prisma.chainTransaction.findUnique({
      where: { id: params.id },
      include: {
        wallet: true,
        linkedTransaction: {
          select: { id: true, reference: true, status: true, type: true },
        },
      },
    });
    if (!record) throw errors.notFound('Chain transaction', params.id);
    return record;
  },
});

/**
 * Marking an arrival as dealt with.
 *
 * Linking a transfer to a transaction is no longer possible from here, and that
 * is the point: a transfer only becomes a transaction when a teller matches it
 * to the customer in front of them at the counter. This is for the remainder —
 * a transfer nobody claimed, which the manager has satisfied themselves about
 * and does not want to keep seeing.
 */
const actionSchema = z.object({ action: z.literal('reconcile') });

export const POST = route<z.infer<typeof actionSchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['usdt.transaction.reconcile'],
  paramsSchema,
  bodySchema: actionSchema,
  handler: async ({ params, actor }) => {
    await markReconciled(params.id, actor);
    return { ok: true };
  },
});
