import { z } from 'zod';
import { route } from '@/core/http/route';
import * as transactions from '@/modules/exchange/transaction.service';
import {
  isCategory,
  isTransactionStatus,
  isTransactionType,
} from '@/modules/exchange/transaction-types';

const querySchema = z.object({
  status: z.string().optional(),
  type: z.string().optional(),
  /** EXCHANGE, REMITTANCE or USDT — the three words the office uses. */
  category: z.string().optional(),
  createdById: z.string().optional(),
  search: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  /** The teller's own recent work, for reprinting from inside a tool. */
  recent: z.coerce.boolean().optional(),
});

export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['exchange.transaction.view'],
  querySchema,
  handler: async ({ query, actor }) => {
    if (query.recent) {
      const type = query.type && isTransactionType(query.type) ? query.type : undefined;
      return transactions.recentFor(actor, { limit: query.pageSize ?? 8, type });
    }

    return transactions.list(
      {
        status: query.status && isTransactionStatus(query.status) ? query.status : undefined,
        type: query.type && isTransactionType(query.type) ? query.type : undefined,
        category: query.category && isCategory(query.category) ? query.category : undefined,
        createdById: query.createdById,
        search: query.search,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
        page: query.page,
        pageSize: query.pageSize,
      },
      actor,
    );
  },
});
