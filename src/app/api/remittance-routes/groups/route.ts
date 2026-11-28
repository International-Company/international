import { route } from '@/core/http/route';
import { routeGroups } from '@/modules/whatsapp/remittance-routes.service';

/** The groups a country may be linked to: those the tellers' numbers follow, and the manager's own number's. */
export const GET = route({
  permissions: ['customers.whatsapp.monitor'],
  handler: async ({ actor }) => routeGroups(actor.id),
});
