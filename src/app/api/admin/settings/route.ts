import { z } from 'zod';
import { route } from '@/core/http/route';
import { describeAll, setMany } from '@/modules/settings/settings.service';
import { SETTING_CATEGORY_LABELS } from '@/modules/settings/settings.catalog';

export const GET = route({
  permissions: ['settings.view'],
  handler: async () => ({
    settings: await describeAll(),
    categories: SETTING_CATEGORY_LABELS,
  }),
});

const bodySchema = z.object({
  values: z.record(z.string(), z.unknown()),
});

export const PATCH = route<z.infer<typeof bodySchema>>({
  permissions: ['settings.manage'],
  bodySchema,
  handler: async ({ body, actor }) => {
    await setMany(body.values, actor);
    return { ok: true };
  },
});
