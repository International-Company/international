import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import * as transfers from '@/modules/drawers/transfer.service';

/**
 * Recording a movement between the branch's own balances.
 *
 * Gated on `exchange.transfer.use`, which the manager holds through his role
 * and a delegate is given along with his first transfer grant. The permission
 * only decides who reaches the screen; which drawers he may actually touch is
 * decided per drawer, inside the service, next to the money.
 */

const querySchema = z.object({
  status: z
    .enum(['PENDING_APPROVAL', 'PENDING_ARRIVAL', 'COMPLETED', 'REVERSED', 'REJECTED'])
    .optional(),
  drawerId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  minAmount: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['exchange.transfer.use'],
  querySchema,
  handler: async ({ query, actor }) => {
    const [rows, waiting] = await Promise.all([
      transfers.list(
        {
          status: query.status,
          drawerId: query.drawerId,
          from: query.from ? new Date(query.from) : undefined,
          // Through the end of the named day, not its first instant — a filter
          // that silently excluded everything recorded today would look like a
          // day with no transfers in it.
          to: query.to ? new Date(`${query.to}T23:59:59.999`) : undefined,
          minAmount: query.minAmount ? parseMoney(query.minAmount) : undefined,
          limit: query.limit,
        },
        actor,
      ),
      transfers.outstanding(),
    ]);

    return { transfers: rows, outstanding: waiting };
  },
});

const bodySchema = z.object({
  fromDrawerId: z.string().min(1),
  toDrawerId: z.string().min(1),
  amount: z.string(),
  /** Omitted to take the account's standing rate. */
  commission: z.string().optional(),
  arrivedImmediately: z.boolean().default(false),
  account: z.string().max(80).optional(),
  note: z.string().max(500).optional(),
});

export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['exchange.transfer.use'],
  bodySchema,
  handler: async ({ body, actor }) => {
    const transfer = await transfers.create(
      {
        fromDrawerId: body.fromDrawerId,
        toDrawerId: body.toDrawerId,
        amount: parseMoney(body.amount),
        commission: body.commission !== undefined ? parseMoney(body.commission) : null,
        arrivedImmediately: body.arrivedImmediately,
        account: body.account ?? null,
        note: body.note ?? null,
      },
      actor,
    );

    return { id: transfer.id, reference: transfer.reference, status: transfer.status };
  },
});
