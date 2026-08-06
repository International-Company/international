import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { parseMoney } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import * as audit from '@/modules/audit/audit.service';
import { SETTINGS, SETTINGS_BY_KEY, type SettingDefinition } from './settings.catalog';

/**
 * System settings.
 *
 * Values are read on almost every request, so they are cached in process and
 * invalidated on write. The cache is short-lived rather than permanent, which
 * keeps multi-process deployments eventually consistent without needing a
 * cross-process invalidation channel.
 */

const log = createLogger('settings');
const CACHE_TTL_MS = 30_000;

const globalForSettings = globalThis as unknown as {
  __ifmsSettingsCache?: { values: Map<string, unknown>; loadedAt: number };
};

function cache() {
  return globalForSettings.__ifmsSettingsCache;
}

export function invalidateSettingsCache(): void {
  globalForSettings.__ifmsSettingsCache = undefined;
}

async function loadAll(db: DbClient): Promise<Map<string, unknown>> {
  const current = cache();
  if (current && Date.now() - current.loadedAt < CACHE_TTL_MS) return current.values;

  const rows = await db.systemSetting.findMany();
  const values = new Map<string, unknown>();

  // Defaults first, so a setting added in a new release works before it is
  // ever written to the database.
  for (const definition of SETTINGS) values.set(definition.key, definition.defaultValue);

  for (const row of rows) {
    try {
      values.set(row.key, JSON.parse(row.value));
    } catch {
      log.warn('Ignoring malformed setting value', { key: row.key });
    }
  }

  globalForSettings.__ifmsSettingsCache = { values, loadedAt: Date.now() };
  return values;
}

export async function get<T = unknown>(key: string, db: DbClient = prisma): Promise<T> {
  const values = await loadAll(db);
  if (!values.has(key)) {
    const definition = SETTINGS_BY_KEY.get(key);
    if (!definition) throw errors.notFound('Setting', key);
    return definition.defaultValue as T;
  }
  return values.get(key) as T;
}

export async function getString(key: string, db: DbClient = prisma): Promise<string> {
  return String((await get(key, db)) ?? '');
}

export async function getNumber(key: string, db: DbClient = prisma): Promise<number> {
  const value = Number(await get(key, db));
  return Number.isFinite(value) ? value : 0;
}

export async function getBoolean(key: string, db: DbClient = prisma): Promise<boolean> {
  return Boolean(await get(key, db));
}

/** Reads a money setting into scaled minor units. */
export async function getMoney(key: string, db: DbClient = prisma): Promise<bigint> {
  const raw = await get(key, db);
  try {
    return parseMoney(String(raw ?? '0'));
  } catch {
    log.warn('Malformed money setting, treating as zero', { key, raw });
    return 0n;
  }
}

export async function getAll(db: DbClient = prisma): Promise<Record<string, unknown>> {
  return Object.fromEntries(await loadAll(db));
}

/** Catalogue plus current values — the shape the settings screen renders. */
export async function describeAll(
  db: DbClient = prisma,
): Promise<(SettingDefinition & { value: unknown })[]> {
  const values = await loadAll(db);
  return SETTINGS.map((definition) => ({
    ...definition,
    value: values.get(definition.key) ?? definition.defaultValue,
  }));
}

function validate(definition: SettingDefinition, value: unknown): unknown {
  switch (definition.type) {
    case 'boolean':
      return Boolean(value);

    case 'number': {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        throw errors.validation([{ path: definition.key, message: 'Must be a number' }]);
      }
      if (definition.min !== undefined && numeric < definition.min) {
        throw errors.validation([
          { path: definition.key, message: `Must be at least ${definition.min}` },
        ]);
      }
      if (definition.max !== undefined && numeric > definition.max) {
        throw errors.validation([
          { path: definition.key, message: `Must be at most ${definition.max}` },
        ]);
      }
      return numeric;
    }

    case 'money': {
      try {
        parseMoney(String(value));
      } catch {
        throw errors.validation([{ path: definition.key, message: 'Must be a valid amount' }]);
      }
      return String(value);
    }

    case 'select': {
      const allowed = definition.options?.map((o) => o.value) ?? [];
      if (!allowed.includes(String(value))) {
        throw errors.validation([
          { path: definition.key, message: `Must be one of: ${allowed.join(', ')}` },
        ]);
      }
      return String(value);
    }

    case 'json':
      return value;

    case 'string':
    default:
      return String(value ?? '');
  }
}

export async function set(
  key: string,
  value: unknown,
  actor: { id: string; name: string; ip?: string | null; sessionId?: string },
  db: DbClient = prisma,
): Promise<void> {
  const definition = SETTINGS_BY_KEY.get(key);
  if (!definition) throw errors.notFound('Setting', key);

  const validated = validate(definition, value);
  const previous = await get(key, db);

  await db.systemSetting.upsert({
    where: { key },
    create: {
      key,
      value: JSON.stringify(validated),
      valueType: definition.type,
      category: definition.category,
      isSecret: definition.isSensitive ?? false,
      description: definition.descriptionEn,
      updatedById: actor.id,
    },
    update: { value: JSON.stringify(validated), updatedById: actor.id },
  });

  invalidateSettingsCache();

  await audit.record(
    {
      action: 'SETTING_CHANGE',
      module: 'settings',
      entityType: 'SystemSetting',
      entityId: key,
      summaryEn: `Setting "${definition.labelEn}" changed`,
      summaryAr: `تم تغيير الإعداد "${definition.labelAr}"`,
      actor,
      before: { [key]: previous },
      after: { [key]: validated },
    },
    db,
  );
}

export async function setMany(
  entries: Record<string, unknown>,
  actor: { id: string; name: string; ip?: string | null; sessionId?: string },
  db: DbClient = prisma,
): Promise<void> {
  for (const [key, value] of Object.entries(entries)) {
    await set(key, value, actor, db);
  }
}

// ---------------------------------------------------------------------------
// Typed accessors for hot paths
// ---------------------------------------------------------------------------

export interface ApprovalPolicy {
  enabled: boolean;
  threshold: bigint;
  allowSelfApproval: boolean;
  reversalRequiresApproval: boolean;
  baseCurrency: string;
}

export async function approvalPolicy(db: DbClient = prisma): Promise<ApprovalPolicy> {
  const [enabled, threshold, allowSelfApproval, reversalRequiresApproval, baseCurrency] =
    await Promise.all([
      getBoolean('approvals.enabled', db),
      getMoney('approvals.threshold', db),
      getBoolean('approvals.selfApproval', db),
      getBoolean('approvals.reversalRequiresApproval', db),
      getString('operations.baseCurrency', db),
    ]);

  return { enabled, threshold, allowSelfApproval, reversalRequiresApproval, baseCurrency };
}
