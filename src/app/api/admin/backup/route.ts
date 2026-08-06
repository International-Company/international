import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import {
  createBackup,
  deleteBackup,
  listBackups,
  restoreBackup,
  verifyBackup,
} from '@/modules/backup/backup.service';

export const GET = route({
  permissions: ['system.backup.view'],
  handler: async () => listBackups(),
});

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), notes: z.string().max(500).optional() }),
  z.object({ action: z.literal('verify'), backupId: z.string() }),
  z.object({
    action: z.literal('restore'),
    backupId: z.string(),
    /** Typed confirmation — restoring destroys current data. */
    confirm: z.literal('RESTORE'),
  }),
  z.object({ action: z.literal('delete'), backupId: z.string() }),
]);

export const POST = route<z.infer<typeof bodySchema>>({
  bodySchema,
  rateLimit: { key: 'backup', limit: 10, windowSeconds: 600 },
  handler: async ({ body, actor }) => {
    const require = (permission: string) => {
      if (!actor.permissions.includes(permission)) throw errors.forbidden(permission);
    };

    switch (body.action) {
      case 'create':
        require('system.backup.create');
        return createBackup(actor, { type: 'MANUAL', notes: body.notes });

      case 'verify':
        require('system.backup.view');
        return verifyBackup(body.backupId, actor);

      case 'restore':
        require('system.backup.restore');
        return restoreBackup(body.backupId, actor);

      case 'delete':
        require('system.backup.restore');
        await deleteBackup(body.backupId, actor);
        return { ok: true };
    }
  },
});
