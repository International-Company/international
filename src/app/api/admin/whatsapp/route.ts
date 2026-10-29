import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import * as settings from '@/modules/settings/settings.service';
import * as whatsapp from '@/modules/whatsapp/whatsapp.service';

/** Where the link stands, and which group the deals go to. */
export const GET = route({
  permissions: ['settings.view'],
  handler: async () => ({
    ...(await whatsapp.snapshot()),
    groupId: await settings.getString('whatsapp.groupId'),
    groupName: await settings.getString('whatsapp.groupName'),
    enabled: await settings.getBoolean('whatsapp.enabled'),
  }),
});

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('connect') }),
  z.object({ action: z.literal('disconnect') }),
  z.object({ action: z.literal('group'), id: z.string().max(120), name: z.string().max(200) }),
  z.object({ action: z.literal('test') }),
]);

/** Link, unlink, choose the group, or send a line to check it arrives. */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['settings.manage'],
  bodySchema,
  handler: async ({ body, actor }) => {
    switch (body.action) {
      case 'connect':
        await whatsapp.connect();
        break;
      case 'disconnect':
        await whatsapp.disconnect();
        break;
      case 'group':
        await settings.setMany(
          { 'whatsapp.groupId': body.id, 'whatsapp.groupName': body.name },
          actor,
        );
        break;
      case 'test': {
        const group = (await settings.getString('whatsapp.groupId')).trim();
        if (!group) {
          throw errors.precondition('Choose a group first', 'errors.whatsappNoGroup');
        }
        await whatsapp.sendText(
          group,
          '✅ تم ربط النظام بهذه المجموعة — ستصل العمليات هنا فور تسجيلها.',
        );
        break;
      }
    }
    return whatsapp.snapshot();
  },
});
