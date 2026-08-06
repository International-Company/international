import { z } from 'zod';
import { route } from '@/core/http/route';
import { listRoles, setRolePermissions } from '@/modules/users/users.service';
import { MODULE_LABELS, PERMISSIONS } from '@/core/security/permissions';

export const GET = route({
  permissions: ['users.view'],
  handler: async () => ({
    roles: await listRoles(),
    // The catalogue drives the permission matrix UI, so it ships with the data.
    permissions: PERMISSIONS,
    modules: MODULE_LABELS,
  }),
});

const bodySchema = z.object({
  roleId: z.string().min(1),
  permissionKeys: z.array(z.string()),
});

export const PATCH = route<z.infer<typeof bodySchema>>({
  permissions: ['users.roles.manage'],
  bodySchema,
  handler: async ({ body, actor }) => {
    await setRolePermissions(body.roleId, body.permissionKeys, actor);
    return { ok: true };
  },
});
