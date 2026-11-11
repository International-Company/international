import { foldName } from './report-command';

/**
 * Which WhatsApp group hears of which deals.
 *
 * The main group hears of everything unless a kind has a group of its own, so
 * an office that chose nothing here goes on exactly as it did.
 */

export const ROUTE_CATEGORIES = [
  'EXCHANGE',
  'USDT',
  'USDT_SALE',
  'USDT_SALE_COPY',
  'REMITTANCE',
  'REMITTANCE_COPY',
  'TIKTOK',
  'TIKTOK_NAME',
  'PRIVATE_LEADS',
  'PRIVATE_FORWARD',
  'WESTERN_NOTICES',
] as const;
export type RouteCategory = (typeof ROUTE_CATEGORIES)[number];

export type GroupRoutes = Partial<Record<RouteCategory, { id: string; name: string }>>;

const CATEGORY_OF: Record<string, RouteCategory> = {
  EXCHANGE: 'EXCHANGE',
  WALLET_CASHOUT: 'EXCHANGE',
  WALLET_TOPUP: 'EXCHANGE',
  USDT_RECEIVE: 'USDT',
  USDT_SEND: 'USDT',
  USDT_SALE: 'USDT_SALE',
  REMITTANCE_OUT: 'REMITTANCE',
  REMITTANCE_IN: 'REMITTANCE',
  TIKTOK_WITHDRAWAL: 'TIKTOK',
};

const CATEGORY_WORDS: Record<RouteCategory, string> = {
  EXCHANGE: 'الصرافة',
  USDT: 'USDT',
  USDT_SALE: 'بيع USDT',
  USDT_SALE_COPY: 'عنوان الإيداع ومبلغه',
  REMITTANCE: 'الحوالات',
  REMITTANCE_COPY: 'رقم الحوالة ومبلغها',
  TIKTOK: 'تيكتوك',
  TIKTOK_NAME: 'صورة تيكتوك والاسم',
  PRIVATE_LEADS: 'طلبات عملاء الرقم الخاص',
  PRIVATE_FORWARD: 'الصور والملفات التي تصل إلى الرقم الخاص',
  WESTERN_NOTICES: 'إشعارات الويسترن',
};

/**
 * The group a remittance's number and sum also go to, or '' for none. Not the one
 * it has just gone to: that group has them already.
 */
export function copyGroupFor(type: string, routes: GroupRoutes, main: string): string {
  const category = COPY_OF[type];
  if (!category) return '';
  const copy = routes[category]?.id ?? '';
  return copy === groupFor(type, routes, main) ? '' : copy;
}

/** The kinds a part of a deal also goes to a group of its own: never unless one is chosen. */
const COPY_OF: Record<string, RouteCategory> = {
  REMITTANCE_OUT: 'REMITTANCE_COPY',
  USDT_SALE: 'USDT_SALE_COPY',
  TIKTOK_WITHDRAWAL: 'TIKTOK_NAME',
};
const COPIES: RouteCategory[] = [
  ...Object.values(COPY_OF),
  'PRIVATE_LEADS',
  'PRIVATE_FORWARD',
  'WESTERN_NOTICES',
];

/** The stored routes. Anything unreadable counts as none: the main group still hears. */
export function parseRoutes(raw: string): GroupRoutes {
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof stored !== 'object' || stored === null) return {};
  const routes: GroupRoutes = {};
  for (const category of ROUTE_CATEGORIES) {
    const route = (stored as Record<string, { id?: unknown; name?: unknown }>)[category];
    if (typeof route?.id === 'string' && route.id.trim()) {
      routes[category] = {
        id: route.id.trim(),
        name: typeof route.name === 'string' ? route.name : '',
      };
    }
  }
  return routes;
}

/** The routes with one kind pointed at a group, or back at the main group when id is empty. */
export function withRoute(
  routes: GroupRoutes,
  category: RouteCategory,
  id: string,
  name: string,
): GroupRoutes {
  const next = { ...routes };
  if (id.trim()) next[category] = { id: id.trim(), name };
  else delete next[category];
  return next;
}

/** Where a kind goes: its own group, else the USDT group for a sale, else the main one. */
function routedTo(category: RouteCategory, routes: GroupRoutes, main: string): string {
  // Sent only where it is asked for: it would say nothing new in the main group.
  if (COPIES.includes(category)) return routes[category]?.id ?? '';
  return routes[category]?.id || (category === 'USDT_SALE' ? routes.USDT?.id : undefined) || main;
}

/** The group a deal of this type goes to, or '' when none is chosen. */
export function groupFor(type: string, routes: GroupRoutes, main: string): string {
  const category = CATEGORY_OF[type];
  return category ? routedTo(category, routes, main) : main;
}

/** The groups already welcomed, as they are stored: separated by commas. */
export function parseWelcomed(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Groups that have just come into use and were never welcomed. */
export function newlyLinked(before: string[], after: string[], welcomed: string[]): string[] {
  return after.filter((id) => !before.includes(id) && !welcomed.includes(id));
}

/** The groups whose name holds what was typed, however it is spelled. */
export function groupsMatching<T extends { name: string }>(groups: T[], query: string): T[] {
  const wanted = foldName(query);
  return wanted ? groups.filter((group) => foldName(group.name).includes(wanted)) : groups;
}

/** The kinds of deal a group is sent, by what the office chose and what falls back to it. */
export function categoriesOf(group: string, routes: GroupRoutes, main: string): RouteCategory[] {
  if (!group) return [];
  return ROUTE_CATEGORIES.filter((category) => routedTo(category, routes, main) === group);
}

/** Each group in use, with the words for what reaches it: what the test message says. */
export function groupPlan(routes: GroupRoutes, main: string): { id: string; hears: string[] }[] {
  const plan = new Map<string, string[]>();
  for (const category of ROUTE_CATEGORIES) {
    const id = routedTo(category, routes, main);
    if (id) plan.set(id, [...(plan.get(id) ?? []), CATEGORY_WORDS[category]]);
  }
  return [...plan].map(([id, hears]) => ({ id, hears }));
}
