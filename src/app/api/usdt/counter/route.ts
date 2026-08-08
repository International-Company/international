import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import { parseMoney } from '@/core/money/money';
import * as counter from '@/modules/usdt/counter.service';

const querySchema = z.object({
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

/** The teller's own open requests, newest first. */
export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['usdt.counter.use'],
  querySchema,
  handler: async ({ query, actor }) => {
    const status = query.status
      ?.split(',')
      .map((value) => value.trim().toUpperCase())
      .filter((value): value is counter.DepositStatus =>
        (counter.DEPOSIT_STATUSES as readonly string[]).includes(value),
      );

    return counter.listRequests(
      { status: status?.length ? status : undefined, page: query.page, pageSize: query.pageSize },
      actor,
    );
  },
});

const bodySchema = z.object({
  walletId: z.string().min(1),
  amount: z.string(),
  payoutCurrency: z.string().min(2).max(8),
  customerId: z.string().nullish(),
  counterpartyName: z.string().max(200).nullish(),
  counterpartyPhone: z.string().max(40).nullish(),
  notes: z.string().max(1000).nullish(),
});

/** Opens a request: reserves the amount, fixes the rate, starts the clock. */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['usdt.counter.use'],
  bodySchema,
  handler: async ({ body, actor }) => {
    if (!actor.branchId) throw errors.precondition('No branch is assigned', 'errors.noBranch');

    const request = await counter.openRequest(
      {
        walletId: body.walletId,
        branchId: actor.branchId,
        amount: parseMoney(body.amount),
        payoutCurrency: body.payoutCurrency.toUpperCase(),
        customerId: body.customerId ?? null,
        counterpartyName: body.counterpartyName ?? null,
        counterpartyPhone: body.counterpartyPhone ?? null,
        notes: body.notes ?? null,
      },
      actor,
    );

    return {
      id: request.id,
      reference: request.reference,
      address: request.address,
      network: request.network,
      expectedAmount: request.expectedAmount,
      quotedAmount: request.quotedAmount,
      quotedRate: request.quotedRate,
      payoutCurrency: request.payoutCurrency,
      expiresAt: request.expiresAt,
      status: request.status,
    };
  },
});
