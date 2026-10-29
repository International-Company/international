import 'server-only';
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { prisma, type DbClient } from '@/core/db/prisma';

/**
 * The linked number's session, in the database.
 *
 * The library's own file-based store would live on the container's disk and
 * be gone after the next deploy, unlinking the number every time anyone
 * pushes. So every key it reads and writes is a row instead — the same JSON
 * it would have put in a file, buffers and all.
 */

const CREDS = 'creds';

async function read(key: string, db: DbClient): Promise<unknown> {
  const row = await db.whatsappAuth.findUnique({ where: { key } });
  return row ? JSON.parse(row.value, BufferJSON.reviver) : null;
}

async function write(key: string, value: unknown, db: DbClient): Promise<void> {
  const json = JSON.stringify(value, BufferJSON.replacer);
  await db.whatsappAuth.upsert({
    where: { key },
    create: { key, value: json },
    update: { value: json },
  });
}

export async function databaseAuthState(
  db: DbClient = prisma,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const creds = ((await read(CREDS, db)) as AuthenticationCreds | null) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const found: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = (await read(`${type}-${id}`, db)) as unknown;
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
              }
              if (value) found[id] = value as SignalDataTypeMap[T];
            }),
          );
          return found;
        },
        set: async (data) => {
          const tasks: Promise<unknown>[] = [];
          for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
            for (const [id, value] of Object.entries(data[category] ?? {})) {
              const key = `${category}-${id}`;
              tasks.push(
                value ? write(key, value, db) : db.whatsappAuth.deleteMany({ where: { key } }),
              );
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write(CREDS, creds, db),
  };
}

/** Whether a number has been linked before — a session worth resuming at start. */
export async function hasSession(db: DbClient = prisma): Promise<boolean> {
  const creds = (await read(CREDS, db)) as AuthenticationCreds | null;
  return Boolean(creds?.registered || creds?.me);
}

/** Forgets the linked number entirely. */
export async function clearSession(db: DbClient = prisma): Promise<void> {
  await db.whatsappAuth.deleteMany({});
}
