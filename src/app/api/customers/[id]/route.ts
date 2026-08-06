import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import { parseMoney } from '@/core/money/money';
import {
  addDocument,
  deleteCustomer,
  getCustomer,
  setBlocked,
  setKyc,
  updateCustomer,
} from '@/modules/customers/customers.service';

const paramsSchema = z.object({ id: z.string().min(1) });

export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.view'],
  paramsSchema,
  handler: async ({ params }) => getCustomer(params.id),
});

const updateSchema = z.object({
  type: z.enum(['INDIVIDUAL', 'COMPANY']).optional(),
  fullNameEn: z.string().min(2).max(200).optional(),
  fullNameAr: z.string().min(2).max(200).optional(),
  phone: z.string().max(40).nullable().optional(),
  altPhone: z.string().max(40).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  nationalId: z.string().max(40).nullable().optional(),
  passportNo: z.string().max(40).nullable().optional(),
  taxNumber: z.string().max(40).nullable().optional(),
  address: z.string().max(400).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  country: z.string().max(4).optional(),
  notes: z.string().max(2000).nullable().optional(),
  creditLimit: z.string().or(z.number()).optional(),
  creditCurrency: z.string().max(8).nullable().optional(),
});

export const PATCH = route<z.infer<typeof updateSchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.update'],
  paramsSchema,
  bodySchema: updateSchema,
  handler: async ({ params, body, actor }) =>
    updateCustomer(
      params.id,
      {
        ...body,
        creditLimit: body.creditLimit !== undefined ? parseMoney(body.creditLimit) : undefined,
      },
      actor,
    ),
});

export const DELETE = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.delete'],
  paramsSchema,
  handler: async ({ params, actor }) => {
    await deleteCustomer(params.id, actor);
    return { ok: true };
  },
});

const actionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('kyc'),
    status: z.enum(['NONE', 'PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED']),
    riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
    note: z.string().max(500).optional(),
  }),
  z.object({
    action: z.literal('block'),
    blocked: z.boolean(),
    reason: z.string().max(500).default(''),
  }),
  z.object({
    action: z.literal('addDocument'),
    type: z.enum(['ID_CARD', 'PASSPORT', 'TRADE_LICENSE', 'OTHER']),
    number: z.string().min(1).max(60),
    issuedAt: z.coerce.date().nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    issuer: z.string().max(120).nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
  }),
]);

export const POST = route<z.infer<typeof actionSchema>, unknown, z.infer<typeof paramsSchema>>({
  paramsSchema,
  bodySchema: actionSchema,
  handler: async ({ params, body, actor }) => {
    const require = (permission: string) => {
      if (!actor.permissions.includes(permission)) throw errors.forbidden(permission);
    };

    if (body.action === 'kyc') {
      require('customers.kyc.manage');
      await setKyc(params.id, body, actor);
      return { ok: true };
    }

    if (body.action === 'block') {
      require('customers.block');
      await setBlocked(params.id, body.blocked, body.reason, actor);
      return { ok: true };
    }

    require('customers.update');
    return addDocument(params.id, body, actor);
  },
});
