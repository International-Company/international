import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import * as audit from '@/modules/audit/audit.service';

const querySchema = z.object({
  actorId: z.string().optional(),
  module: z.string().optional(),
  action: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  search: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['audit.view'],
  querySchema,
  handler: async ({ query }) => audit.query(query),
});

const bodySchema = z.object({ action: z.literal('verify') });

/**
 * Runs the chain verification. Kept as a POST because on a large log it is a
 * full table scan, and should not be triggered by a page prefetch.
 */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['audit.verify'],
  bodySchema,
  rateLimit: { key: 'audit-verify', limit: 5, windowSeconds: 300 },
  handler: async ({ body }) => {
    if (body.action !== 'verify') throw errors.precondition('Unsupported action');
    return audit.verifyChain();
  },
});
