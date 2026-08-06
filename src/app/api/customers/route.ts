import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import { createCustomer, listCustomers, quickSearch } from '@/modules/customers/customers.service';

const querySchema = z.object({
  search: z.string().optional(),
  type: z.enum(['INDIVIDUAL', 'COMPANY']).optional(),
  kycStatus: z.enum(['NONE', 'PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED']).optional(),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  blocked: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  quick: z.coerce.boolean().default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['customers.view'],
  querySchema,
  handler: async ({ query }) => {
    // The transaction form's type-ahead needs a small, fast result set rather
    // than a full paginated listing.
    if (query.quick) return quickSearch(query.search ?? '');
    return listCustomers(query);
  },
});

const createSchema = z.object({
  type: z.enum(['INDIVIDUAL', 'COMPANY']).default('INDIVIDUAL'),
  fullNameEn: z.string().min(2).max(200),
  fullNameAr: z.string().min(2).max(200),
  phone: z.string().max(40).nullable().optional(),
  altPhone: z.string().max(40).nullable().optional(),
  email: z.string().email().max(200).nullable().optional().or(z.literal('')),
  nationalId: z.string().max(40).nullable().optional(),
  passportNo: z.string().max(40).nullable().optional(),
  taxNumber: z.string().max(40).nullable().optional(),
  address: z.string().max(400).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  country: z.string().max(4).default('PS'),
  notes: z.string().max(2000).nullable().optional(),
  creditLimit: z.string().or(z.number()).optional(),
  creditCurrency: z.string().max(8).nullable().optional(),
});

export const POST = route<z.infer<typeof createSchema>>({
  permissions: ['customers.create'],
  bodySchema: createSchema,
  handler: async ({ body, actor }) =>
    createCustomer(
      {
        ...body,
        email: body.email || null,
        creditLimit: body.creditLimit ? parseMoney(body.creditLimit) : 0n,
        branchId: actor.branchId,
      },
      actor,
    ),
});
