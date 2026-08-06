import { z } from 'zod';
import { route } from '@/core/http/route';
import { createUser, listUsers } from '@/modules/users/users.service';
import { prisma } from '@/core/db/prisma';

const querySchema = z.object({
  search: z.string().optional(),
  status: z.string().optional(),
  roleKey: z.string().optional(),
  branchId: z.string().optional(),
  withMeta: z.coerce.boolean().default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['users.view'],
  querySchema,
  handler: async ({ query }) => {
    const result = await listUsers(query);
    if (!query.withMeta) return result;

    const [roles, branches] = await Promise.all([
      prisma.role.findMany({
        where: { isActive: true },
        orderBy: { level: 'asc' },
        select: { id: true, key: true, nameEn: true, nameAr: true, level: true },
      }),
      prisma.branch.findMany({
        where: { isActive: true },
        select: { id: true, nameEn: true, nameAr: true },
      }),
    ]);

    return { ...result, roles, branches };
  },
});

const createSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[a-z0-9._-]+$/i, 'Use letters, numbers, dot, underscore or hyphen only'),
  email: z.string().email().max(200),
  fullNameEn: z.string().min(2).max(200),
  fullNameAr: z.string().min(2).max(200),
  employeeCode: z.string().max(40).nullable().optional(),
  jobTitleEn: z.string().max(120).nullable().optional(),
  jobTitleAr: z.string().max(120).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  branchId: z.string().nullable().optional(),
  roleIds: z.array(z.string()).min(1),
  locale: z.enum(['ar', 'en']).default('ar'),
});

export const POST = route<z.infer<typeof createSchema>>({
  permissions: ['users.create'],
  bodySchema: createSchema,
  handler: async ({ body, actor }) => createUser(body, actor),
});
