import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import {
  deleteUser,
  getUser,
  resetPassword,
  setUserPermissionOverrides,
  setUserRoles,
  updateUser,
} from '@/modules/users/users.service';
import { listUserSessions, revokeAllUserSessions, revokeSession } from '@/modules/auth/session.service';

const paramsSchema = z.object({ id: z.string().min(1) });

export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['users.view'],
  paramsSchema,
  handler: async ({ params, actor }) => {
    const user = await getUser(params.id);

    return {
      user,
      sessions: actor.permissions.includes('users.sessions.manage')
        ? await listUserSessions(params.id)
        : [],
    };
  },
});

const updateSchema = z.object({
  email: z.string().email().max(200).optional(),
  fullNameEn: z.string().min(2).max(200).optional(),
  fullNameAr: z.string().min(2).max(200).optional(),
  employeeCode: z.string().max(40).nullable().optional(),
  jobTitleEn: z.string().max(120).nullable().optional(),
  jobTitleAr: z.string().max(120).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  branchId: z.string().nullable().optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']).optional(),
});

export const PATCH = route<z.infer<typeof updateSchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['users.update'],
  paramsSchema,
  bodySchema: updateSchema,
  handler: async ({ params, body, actor }) => {
    await updateUser(params.id, body, actor);
    return { ok: true };
  },
});

/**
 * Removing an account outright.
 *
 * Separate from disabling, and refused the moment the person has done any work
 * — their name is the answer to who did it. The service checks that for itself.
 */
export const DELETE = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['users.delete'],
  paramsSchema,
  handler: async ({ params, actor }) => {
    await deleteUser(params.id, actor);
    return { ok: true };
  },
});

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('resetPassword') }),
  z.object({ action: z.literal('setRoles'), roleIds: z.array(z.string()) }),
  z.object({
    action: z.literal('setPermissions'),
    overrides: z.array(
      z.object({
        permissionKey: z.string(),
        effect: z.enum(['ALLOW', 'DENY']),
        reason: z.string().max(300).optional(),
      }),
    ),
  }),
  z.object({ action: z.literal('revokeSession'), sessionId: z.string() }),
  z.object({ action: z.literal('revokeAllSessions') }),
]);

export const POST = route<z.infer<typeof actionSchema>, unknown, z.infer<typeof paramsSchema>>({
  paramsSchema,
  bodySchema: actionSchema,
  handler: async ({ params, body, actor }) => {
    const require = (permission: string) => {
      if (!actor.permissions.includes(permission)) throw errors.forbidden(permission);
    };

    switch (body.action) {
      case 'resetPassword':
        require('users.resetPassword');
        return resetPassword(params.id, actor);

      case 'setRoles':
        require('users.roles.assign');
        await setUserRoles(params.id, body.roleIds, actor);
        return { ok: true };

      case 'setPermissions':
        require('users.roles.assign');
        await setUserPermissionOverrides(params.id, body.overrides, actor);
        return { ok: true };

      case 'revokeSession':
        require('users.sessions.manage');
        await revokeSession(body.sessionId, 'REVOKED_BY_ADMIN');
        return { ok: true };

      case 'revokeAllSessions': {
        require('users.sessions.manage');
        const count = await revokeAllUserSessions(params.id, 'REVOKED_BY_ADMIN');
        return { revoked: count };
      }
    }
  },
});
