/**
 * Which WhatsApp group hears of which deals.
 *
 * The main group hears of everything unless a kind has a group of its own, so
 * an office that chose nothing here goes on exactly as it did.
 */

export const ROUTE_CATEGORIES = ['EXCHANGE', 'USDT', 'REMITTANCE', 'TIKTOK'] as const;
export type RouteCategory = (typeof ROUTE_CATEGORIES)[number];

export type GroupRoutes = Partial<Record<RouteCategory, { id: string; name: string }>>;

const CATEGORY_OF: Record<string, RouteCategory> = {
  EXCHANGE: 'EXCHANGE',
  WALLET_CASHOUT: 'EXCHANGE',
  WALLET_TOPUP: 'EXCHANGE',
  USDT_RECEIVE: 'USDT',
  USDT_SEND: 'USDT',
  USDT_SALE: 'USDT',
  REMITTANCE_OUT: 'REMITTANCE',
  REMITTANCE_IN: 'REMITTANCE',
  TIKTOK_WITHDRAWAL: 'TIKTOK',
};

const CATEGORY_WORDS: Record<RouteCategory, string> = {
  EXCHANGE: 'الصرافة',
  USDT: 'USDT',
  REMITTANCE: 'الحوالات',
  TIKTOK: 'تيكتوك',
};

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

/** The group a deal of this type goes to, or '' when none is chosen. */
export function groupFor(type: string, routes: GroupRoutes, main: string): string {
  const category = CATEGORY_OF[type];
  return (category && routes[category]?.id) || main;
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

/** Each group in use, with the words for what reaches it: what the test message says. */
export function groupPlan(routes: GroupRoutes, main: string): { id: string; hears: string[] }[] {
  const plan = new Map<string, string[]>();
  for (const category of ROUTE_CATEGORIES) {
    const id = routes[category]?.id || main;
    if (id) plan.set(id, [...(plan.get(id) ?? []), CATEGORY_WORDS[category]]);
  }
  return [...plan].map(([id, hears]) => ({ id, hears }));
}
