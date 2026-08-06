import 'server-only';
import { createHash } from 'node:crypto';
import { createGunzip, createGzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { prisma, type DbClient } from '@/core/db/prisma';
import { env } from '@/core/config/env';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import { emitAsync } from '@/core/events/bus';
import * as audit from '@/modules/audit/audit.service';

/**
 * Backup and restore.
 *
 * Backups are gzipped JSON snapshots rather than raw database files. That costs
 * a little size and buys three things that matter more: the archive is portable
 * across database engines, it can be inspected without restoring it, and its
 * integrity can be proven with a checksum rather than assumed.
 *
 * A backup nobody has verified is a guess, so every archive stores a SHA-256 of
 * its contents and `verifyBackup()` re-reads and re-hashes it.
 */

const log = createLogger('backup');

export interface Actor {
  id: string;
  name: string;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string;
}

/**
 * Tables in dependency order — parents first. Restore replays this order so
 * foreign keys resolve, and truncation walks it in reverse.
 */
const TABLES = [
  'branch',
  'currency',
  'role',
  'permission',
  'user',
  'userRole',
  'rolePermission',
  'userPermission',
  'account',
  'exchangeRate',
  'customer',
  'customerDocument',
  'customerBalance',
  'businessDay',
  'transaction',
  'receipt',
  'journalEntry',
  'journalLine',
  'dayClosingLine',
  'wallet',
  'walletSnapshot',
  'walletSyncRun',
  'chainTransaction',
  'notification',
  'notificationRecipient',
  'auditLog',
  'systemSetting',
  'apiCredential',
  'scheduledTask',
  'sequence',
  'draft',
  'passwordHistory',
] as const;

type TableName = (typeof TABLES)[number];

const SNAPSHOT_VERSION = 1;

interface Snapshot {
  version: number;
  createdAt: string;
  appVersion: string;
  tables: Record<string, unknown[]>;
}

/** bigint and Date have no JSON representation; tag them so restore can invert. */
function encode(value: unknown): unknown {
  if (typeof value === 'bigint') return { __t: 'bigint', v: value.toString() };
  if (value instanceof Date) return { __t: 'date', v: value.toISOString() };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, encode(v)]),
    );
  }
  return value;
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);

  if (value && typeof value === 'object') {
    const tagged = value as { __t?: string; v?: string };
    if (tagged.__t === 'bigint') return BigInt(tagged.v!);
    if (tagged.__t === 'date') return new Date(tagged.v!);

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, decode(v)]),
    );
  }
  return value;
}

function backupDirectory(): string {
  return path.resolve(process.cwd(), env.BACKUP_DIR);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createBackup(
  actor: Actor,
  options: { type?: 'MANUAL' | 'AUTOMATIC'; notes?: string } = {},
): Promise<{ id: string; filename: string; sizeBytes: number; checksum: string }> {
  const directory = backupDirectory();
  await mkdir(directory, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `ifms-${stamp}.json.gz`;
  const filePath = path.join(directory, filename);

  const record = await prisma.backup.create({
    data: {
      filename,
      path: filePath,
      type: options.type ?? 'MANUAL',
      status: 'RUNNING',
      notes: options.notes ?? null,
      appVersion: SNAPSHOT_VERSION.toString(),
      createdById: actor.id === 'system' ? null : actor.id,
    },
  });

  try {
    const snapshot: Snapshot = {
      version: SNAPSHOT_VERSION,
      createdAt: new Date().toISOString(),
      appVersion: SNAPSHOT_VERSION.toString(),
      tables: {},
    };

    let rowCount = 0;

    for (const table of TABLES) {
      const delegate = prisma[table] as unknown as { findMany: () => Promise<unknown[]> };
      const rows = await delegate.findMany();
      snapshot.tables[table] = rows.map(encode);
      rowCount += rows.length;
    }

    // Stream through gzip rather than buffering the whole archive in memory —
    // a busy branch's audit log alone will outgrow a comfortable buffer.
    const gzip = createGzip({ level: 9 });
    const write = createWriteStream(filePath);
    const done = pipeline(gzip, write);

    gzip.end(JSON.stringify(snapshot));
    await done;

    const [checksum, stats] = await Promise.all([sha256File(filePath), stat(filePath)]);

    await prisma.backup.update({
      where: { id: record.id },
      data: {
        status: 'COMPLETED',
        finishedAt: new Date(),
        sizeBytes: BigInt(stats.size),
        checksum,
        tableCount: TABLES.length,
        rowCount,
      },
    });

    log.info('Backup created', { filename, rows: rowCount, bytes: stats.size });

    await audit.record({
      action: 'BACKUP',
      module: 'system',
      entityType: 'Backup',
      entityId: record.id,
      summaryEn: `Created ${options.type === 'AUTOMATIC' ? 'automatic' : 'manual'} backup ${filename} (${rowCount} rows)`,
      summaryAr: `إنشاء نسخة احتياطية ${options.type === 'AUTOMATIC' ? 'تلقائية' : 'يدوية'} ${filename} (${rowCount} صف)`,
      actor,
      metadata: { filename, rowCount, sizeBytes: stats.size, checksum },
    });

    emitAsync('backup.completed', { backupId: record.id, status: 'COMPLETED' });

    return { id: record.id, filename, sizeBytes: stats.size, checksum };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await prisma.backup.update({
      where: { id: record.id },
      data: { status: 'FAILED', finishedAt: new Date(), error: message.slice(0, 1000) },
    });

    // Do not leave a half-written archive that looks like a real backup.
    await unlink(filePath).catch(() => undefined);

    log.error('Backup failed', { filename, error: message });
    emitAsync('backup.completed', { backupId: record.id, status: 'FAILED' });

    throw errors.internal('Backup failed', error);
  }
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export async function verifyBackup(
  backupId: string,
  actor: Actor,
): Promise<{ valid: boolean; reason?: string }> {
  const backup = await prisma.backup.findUnique({ where: { id: backupId } });
  if (!backup) throw errors.notFound('Backup', backupId);
  if (!backup.checksum) return { valid: false, reason: 'No checksum was recorded' };

  try {
    const actual = await sha256File(backup.path);
    const valid = actual === backup.checksum;

    await prisma.backup.update({
      where: { id: backupId },
      data: {
        status: valid ? 'VERIFIED' : 'CORRUPT',
        verifiedAt: new Date(),
        error: valid ? null : `Checksum mismatch: expected ${backup.checksum}, found ${actual}`,
      },
    });

    await audit.record({
      action: 'BACKUP',
      module: 'system',
      entityType: 'Backup',
      entityId: backupId,
      summaryEn: `Verified backup ${backup.filename}: ${valid ? 'intact' : 'CORRUPT'}`,
      summaryAr: `التحقق من النسخة ${backup.filename}: ${valid ? 'سليمة' : 'تالفة'}`,
      actor,
    });

    return valid ? { valid } : { valid, reason: 'Checksum does not match' };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : 'Unreadable' };
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Replaces the entire database with a backup's contents.
 *
 * The archive is verified before a single row is deleted — restoring from a
 * corrupt file would destroy the working data and replace it with nothing.
 * The whole replay runs in one transaction with foreign keys deferred, so a
 * failure mid-restore rolls back rather than leaving a half-populated system.
 */
export async function restoreBackup(
  backupId: string,
  actor: Actor,
): Promise<{ rowsRestored: number }> {
  const backup = await prisma.backup.findUnique({ where: { id: backupId } });
  if (!backup) throw errors.notFound('Backup', backupId);

  const verification = await verifyBackup(backupId, actor);
  if (!verification.valid) {
    throw errors.precondition(
      `Refusing to restore: ${verification.reason ?? 'the archive failed verification'}`,
      'errors.backupCorrupt',
    );
  }

  const run = await prisma.restoreRun.create({
    data: { backupId, status: 'RUNNING', requestedById: actor.id },
  });

  try {
    const chunks: Buffer[] = [];
    const gunzip = createGunzip();
    gunzip.on('data', (chunk: Buffer) => chunks.push(chunk));

    await pipeline(createReadStream(backup.path), gunzip);

    const snapshot = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Snapshot;
    if (snapshot.version !== SNAPSHOT_VERSION) {
      throw errors.precondition(
        `Backup format version ${snapshot.version} is not supported by this release`,
        'errors.backupVersion',
      );
    }

    let rowsRestored = 0;

    await prisma.$transaction(
      async (tx) => {
        // Self-referencing rows (a reversal points at its original) would fail
        // ordinary FK checks whatever order we choose; defer to commit time.
        await tx.$executeRawUnsafe('PRAGMA defer_foreign_keys = ON');

        for (const table of [...TABLES].reverse()) {
          const delegate = tx[table] as unknown as { deleteMany: () => Promise<unknown> };
          await delegate.deleteMany();
        }

        for (const table of TABLES) {
          const rows = (snapshot.tables[table] ?? []).map(decode) as Record<string, unknown>[];
          if (rows.length === 0) continue;

          const delegate = tx[table] as unknown as {
            create: (args: { data: unknown }) => Promise<unknown>;
          };

          // Row-at-a-time: `createMany` skips nested type coercion and would
          // silently drop the bigint columns this system depends on.
          for (const row of rows) {
            await delegate.create({ data: row });
            rowsRestored++;
          }
        }
      },
      { timeout: 600_000, maxWait: 30_000 },
    );

    await prisma.restoreRun.update({
      where: { id: run.id },
      data: { status: 'COMPLETED', finishedAt: new Date(), rowsRestored },
    });

    log.warn('Database restored from backup', { backupId, rowsRestored });

    // Recorded after the restore, so it survives as the first entry of the
    // rebuilt audit chain rather than being wiped by the truncation above.
    await audit.record({
      action: 'RESTORE',
      module: 'system',
      entityType: 'Backup',
      entityId: backupId,
      summaryEn: `Restored database from ${backup.filename} (${rowsRestored} rows)`,
      summaryAr: `استعادة قاعدة البيانات من ${backup.filename} (${rowsRestored} صف)`,
      actor,
      metadata: { backupId, rowsRestored },
    });

    return { rowsRestored };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.restoreRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', finishedAt: new Date(), error: message.slice(0, 1000) },
    });

    log.error('Restore failed', { backupId, error: message });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export async function listBackups(db: DbClient = prisma) {
  return db.backup.findMany({
    orderBy: { startedAt: 'desc' },
    take: 100,
    include: { createdBy: { select: { fullNameEn: true, fullNameAr: true } } },
  });
}

export async function deleteBackup(backupId: string, actor: Actor): Promise<void> {
  const backup = await prisma.backup.findUnique({ where: { id: backupId } });
  if (!backup) throw errors.notFound('Backup', backupId);

  await unlink(backup.path).catch(() => undefined);
  await prisma.backup.delete({ where: { id: backupId } });

  await audit.record({
    action: 'BACKUP',
    module: 'system',
    entityType: 'Backup',
    entityId: backupId,
    summaryEn: `Deleted backup ${backup.filename}`,
    summaryAr: `حذف النسخة الاحتياطية ${backup.filename}`,
    actor,
  });
}

/** Enforces the retention policy, keeping the newest `keep` archives. */
export async function pruneBackups(keep: number): Promise<number> {
  const stale = await prisma.backup.findMany({
    where: { status: { in: ['COMPLETED', 'VERIFIED'] } },
    orderBy: { startedAt: 'desc' },
    skip: keep,
    select: { id: true, path: true },
  });

  for (const backup of stale) {
    await unlink(backup.path).catch(() => undefined);
  }
  if (stale.length > 0) {
    await prisma.backup.deleteMany({ where: { id: { in: stale.map((b) => b.id) } } });
    log.info('Pruned old backups', { count: stale.length });
  }

  return stale.length;
}

/** Reads an archive for download. */
export async function readBackupFile(backupId: string): Promise<{ buffer: Buffer; filename: string }> {
  const backup = await prisma.backup.findUnique({ where: { id: backupId } });
  if (!backup) throw errors.notFound('Backup', backupId);

  const buffer = await readFile(backup.path);
  return { buffer, filename: backup.filename };
}
