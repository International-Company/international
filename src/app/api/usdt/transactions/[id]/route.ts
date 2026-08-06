import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import { createInternalTransaction, markReconciled } from '@/modules/usdt/sync.service';
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

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('link'), customerId: z.string().optional() }),
  z.object({ action: z.literal('reconcile') }),
]);

export const POST = route<z.infer<typeof actionSchema>, unknown, z.infer<typeof paramsSchema>>({
  paramsSchema,
  bodySchema: actionSchema,
  handler: async ({ params, body, actor }) => {
    if (body.action === 'link') {
      if (!actor.permissions.includes('usdt.transaction.link')) {
        throw errors.forbidden('usdt.transaction.link');
      }
      const transactionId = await createInternalTransaction(params.id, prisma, {
        customerId: body.customerId,
        actorId: actor.id,
      });
      return { transactionId };
    }

    if (!actor.permissions.includes('usdt.transaction.reconcile')) {
      throw errors.forbidden('usdt.transaction.reconcile');
    }
    await markReconciled(params.id, actor);
    return { ok: true };
  },
});
