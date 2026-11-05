import 'server-only';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import type { Actor } from '@/modules/exchange/transaction.service';
import * as settings from '@/modules/settings/settings.service';
import { groupPlan, newlyLinked, parseRoutes, parseWelcomed } from './group-routes';
import { sendText } from './whatsapp.service';

/**
 * The message the office writes for a group the bot has just been linked to.
 * Each group gets it once on linking; the manager can send it again to all of them.
 */

const log = createLogger('whatsapp:welcome');

type Send = (jid: string, text: string) => Promise<unknown>;

/** The groups in use right now. */
export async function linkedGroups(): Promise<string[]> {
  const plan = groupPlan(
    parseRoutes(await settings.getString('whatsapp.groupRoutes')),
    (await settings.getString('whatsapp.groupId')).trim(),
  );
  return plan.map(({ id }) => id);
}

/** Sends to each, returning those it reached. A group that fails does not stop the rest. */
async function deliver(ids: string[], text: string, send: Send): Promise<string[]> {
  const reached: string[] = [];
  for (const id of ids) {
    try {
      await send(id, text);
      reached.push(id);
    } catch (error) {
      log.warn('Could not send the welcome message', { group: id, error });
    }
  }
  return reached;
}

async function remember(reached: string[], welcomed: string[], actor: Actor) {
  if (reached.length === 0) return;
  await settings.setMany(
    { 'whatsapp.welcomedGroups': [...new Set([...welcomed, ...reached])].join(',') },
    actor,
  );
}

/**
 * After the groups changed: welcomes any that came into use and never had it.
 * Never throws, because saving the group has already succeeded.
 */
export async function welcomeNewlyLinked(before: string[], actor: Actor, send: Send = sendText) {
  try {
    const text = (await settings.getString('whatsapp.welcomeMessage')).trim();
    if (!text) return;
    const welcomed = parseWelcomed(await settings.getString('whatsapp.welcomedGroups'));
    const reached = await deliver(newlyLinked(before, await linkedGroups(), welcomed), text, send);
    await remember(reached, welcomed, actor);
  } catch (error) {
    log.warn('Could not welcome a newly linked group', { error });
  }
}

/** The manager's button: to every group in use, whether or not it had it before. */
export async function sendWelcomeNow(actor: Actor, send: Send = sendText) {
  const text = (await settings.getString('whatsapp.welcomeMessage')).trim();
  if (!text) throw errors.precondition('Write the message first', 'errors.whatsappWelcomeEmpty');
  const groups = await linkedGroups();
  if (groups.length === 0) {
    throw errors.precondition('Choose a group first', 'errors.whatsappNoGroup');
  }
  const reached = await deliver(groups, text, send);
  await remember(reached, parseWelcomed(await settings.getString('whatsapp.welcomedGroups')), actor);
  if (reached.length < groups.length) {
    throw errors.precondition(
      'The message did not reach every group',
      'errors.whatsappWelcomeFailed',
      { reached: String(reached.length), total: String(groups.length) },
    );
  }
}
