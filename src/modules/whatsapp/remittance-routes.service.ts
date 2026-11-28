import 'server-only';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import * as remittances from '@/modules/exchange/remittance.service';

const log = createLogger('whatsapp:routes');

/**
 * Which agent's group a remittance goes to, by its country — and, where the
 * office uses different agents for one country, by its method. Kept by the
 * manager on one board, so the teller never looks for the group: the notice
 * of a remittance received is sent for checking, and the details of one sent
 * are sent for carrying out, to the group its country is linked to.
 */

export const ROUTE_DIRECTIONS = ['IN', 'OUT', 'BOTH'] as const;
export type RouteDirection = (typeof ROUTE_DIRECTIONS)[number];

/** A country as it is compared: one spelling of alif, ya and ta marbuta, no case, no spaces around. */
export function countryKey(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ');
}

export async function listRoutes() {
  return prisma.remittanceRoute.findMany({ orderBy: [{ country: 'asc' }, { network: 'asc' }, { direction: 'asc' }] });
}

export interface RouteInput {
  country: string;
  network: string | null;
  direction: RouteDirection;
  groupChat: string;
  groupName: string | null;
}

/** Two routes for the same country, method and direction would leave the choice to chance: refused. */
async function clash(input: RouteInput, except: string | null) {
  const same = await prisma.remittanceRoute.findMany({ where: { network: input.network } });
  const found = same.find(
    (row) =>
      row.id !== except &&
      countryKey(row.country) === countryKey(input.country) &&
      (row.direction === input.direction || row.direction === 'BOTH' || input.direction === 'BOTH'),
  );
  if (found) {
    throw errors.conflict('That country and method already have a group', 'errors.routeExists', {
      group: found.groupName ?? found.groupChat,
    });
  }
}

function clean(input: RouteInput): RouteInput {
  const country = input.country.trim().slice(0, 80);
  if (!country) throw errors.validation([{ path: 'country', message: 'Write the country' }]);
  if (!input.groupChat.endsWith('@g.us')) throw errors.validation([{ path: 'groupChat', message: 'Choose a group' }]);
  return {
    country,
    network: input.network?.trim() || null,
    direction: ROUTE_DIRECTIONS.includes(input.direction) ? input.direction : 'BOTH',
    groupChat: input.groupChat,
    groupName: input.groupName?.trim().slice(0, 120) || null,
  };
}

export async function createRoute(input: RouteInput, by: string) {
  const data = clean(input);
  await clash(data, null);
  const row = await prisma.remittanceRoute.create({ data: { ...data, byName: by } });
  log.info('A remittance route was added');
  return row;
}

export async function updateRoute(id: string, input: RouteInput, by: string) {
  const data = clean(input);
  const row = await prisma.remittanceRoute.findUnique({ where: { id } });
  if (!row) throw errors.notFound('RemittanceRoute', id);
  await clash(data, id);
  return prisma.remittanceRoute.update({ where: { id }, data: { ...data, byName: by } });
}

export async function deleteRoute(id: string) {
  await prisma.remittanceRoute.deleteMany({ where: { id } });
  return { id };
}

/**
 * The group for a remittance: its country's route for its method first, then
 * its country's route for every method; one for its own direction before one
 * for both. Null when its country has none.
 */
export async function routeFor(direction: 'IN' | 'OUT', country: string | null | undefined, network: string | null | undefined) {
  const key = countryKey(country);
  if (!key) return null;
  const rows = (await prisma.remittanceRoute.findMany({})).filter(
    (row) => countryKey(row.country) === key && (row.direction === direction || row.direction === 'BOTH'),
  );
  const score = (row: (typeof rows)[number]) =>
    (row.network && row.network === network ? 2 : row.network ? -100 : 0) + (row.direction === direction ? 1 : 0);
  const best = rows
    .map((row) => ({ row, points: score(row) }))
    .filter((entry) => entry.points >= 0)
    .sort((a, b) => b.points - a.points)[0];
  return best ? { chat: best.row.groupChat, name: best.row.groupName ?? best.row.groupChat } : null;
}

/** The countries a teller chooses from: the remittance destinations, and every country a route names. */
export async function routeCountries(): Promise<string[]> {
  const [listed, routed] = await Promise.all([
    remittances.destinations().catch(() => [] as string[]),
    prisma.remittanceRoute.findMany({ select: { country: true }, distinct: ['country'] }),
  ]);
  const all = [...listed, ...routed.map((row) => row.country)];
  const seen = new Set<string>();
  return all.filter((country) => {
    const key = countryKey(country);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The groups the board offers: every group a teller's number follows already,
 * and those of the manager's own number when it is linked — names alone, never
 * the groups' messages.
 */
export async function routeGroups(actorId: string): Promise<{ chat: string; name: string }[]> {
  const followed = await prisma.tellerChat.findMany({
    where: { chat: { endsWith: '@g.us' } },
    select: { chat: true, name: true },
    orderBy: { lastMessageAt: 'desc' },
    take: 500,
  });
  const own = await import('./teller-whatsapp.service')
    .then((teller) => teller.numberGroups(actorId))
    .catch(() => [] as { chat: string; name: string }[]);
  const byChat = new Map<string, string>();
  for (const group of [...own, ...followed]) {
    if (!byChat.has(group.chat)) byChat.set(group.chat, group.name?.trim() || group.chat);
  }
  return [...byChat.entries()]
    .map(([chat, name]) => ({ chat, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}
