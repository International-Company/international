import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import * as settings from '@/modules/settings/settings.service';
import {
  groupPlan,
  parseRoutes,
  ROUTE_CATEGORIES,
  withRoute,
} from '@/modules/whatsapp/group-routes';
import { linkedGroups, sendWelcomeNow, welcomeNewlyLinked } from '@/modules/whatsapp/welcome';
import { ACCOUNTS } from '@/modules/whatsapp/accounts';
import * as whatsapp from '@/modules/whatsapp/whatsapp.service';

/** Where the link stands, and which group the deals go to. */
export const GET = route({
  permissions: ['settings.view'],
  handler: async () => ({
    ...(await whatsapp.snapshot()),
    second: await whatsapp.snapshot('second'),
    private: await whatsapp.snapshot('private'),
    groupId: await settings.getString('whatsapp.groupId'),
    groupName: await settings.getString('whatsapp.groupName'),
    routes: parseRoutes(await settings.getString('whatsapp.groupRoutes')),
    welcomeMessage: await settings.getString('whatsapp.welcomeMessage'),
    enabled: await settings.getBoolean('whatsapp.enabled'),
  }),
});

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('connect'), account: z.enum(ACCOUNTS).default('main') }),
  z.object({ action: z.literal('disconnect'), account: z.enum(ACCOUNTS).default('main') }),
  z.object({ action: z.literal('group'), id: z.string().max(120), name: z.string().max(200) }),
  z.object({
    action: z.literal('route'),
    category: z.enum(ROUTE_CATEGORIES),
    id: z.string().max(120),
    name: z.string().max(200),
  }),
  z.object({ action: z.literal('test') }),
  z.object({ action: z.literal('welcome'), message: z.string().max(2000) }),
  z.object({ action: z.literal('welcomeSend') }),
]);

/** Link, unlink, choose the groups, or send a line to each to check it arrives. */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['settings.manage'],
  bodySchema,
  handler: async ({ body, actor }) => {
    switch (body.action) {
      case 'connect':
        await whatsapp.connect(body.account);
        break;
      case 'disconnect':
        await whatsapp.disconnect(body.account);
        break;
      case 'group': {
        const before = await linkedGroups();
        await settings.setMany(
          { 'whatsapp.groupId': body.id, 'whatsapp.groupName': body.name },
          actor,
        );
        await welcomeNewlyLinked(before, actor);
        break;
      }
      case 'welcome':
        await settings.setMany({ 'whatsapp.welcomeMessage': body.message.trim() }, actor);
        break;
      case 'welcomeSend':
        await sendWelcomeNow(actor);
        break;
      case 'route': {
        const before = await linkedGroups();
        const routes = parseRoutes(await settings.getString('whatsapp.groupRoutes'));
        await settings.setMany(
          {
            'whatsapp.groupRoutes': JSON.stringify(
              withRoute(routes, body.category, body.id, body.name),
            ),
          },
          actor,
        );
        await welcomeNewlyLinked(before, actor);
        break;
      }
      case 'test': {
        const plan = groupPlan(
          parseRoutes(await settings.getString('whatsapp.groupRoutes')),
          (await settings.getString('whatsapp.groupId')).trim(),
        );
        if (plan.length === 0) {
          throw errors.precondition('Choose a group first', 'errors.whatsappNoGroup');
        }
        for (const { id, hears } of plan) {
          await whatsapp.sendText(
            id,
            `✅ تم ربط النظام بهذه المجموعة — ستصل هنا عمليات: ${hears.join('، ')}.`,
          );
        }
        break;
      }
    }
    return whatsapp.snapshot();
  },
});
