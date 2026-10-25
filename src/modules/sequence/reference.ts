import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';

/**
 * Human-readable document references: `TXN-20260806-00042`.
 *
 * Financial staff quote these over the phone and write them on paper receipts,
 * so they must be short, gapless within a day, and never reused. The counter
 * lives in the database and is incremented with an atomic upsert, so two
 * concurrent tellers cannot be issued the same number.
 */

export type SequencePrefix = 'TXN' | 'JRN' | 'RCP' | 'CUS' | 'BKP' | 'DAY' | 'DEP' | 'HND' | 'SHF' | 'PEX' | 'TRF' | 'CNT';

function dateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Reserves and returns the next reference for the prefix.
 * Must be called inside the same transaction as the row it identifies, so a
 * rolled-back operation does not burn a number.
 */
export async function nextReference(
  prefix: SequencePrefix,
  db: DbClient = prisma,
  options: { daily?: boolean; padding?: number } = {},
): Promise<string> {
  const { daily = true, padding = 5 } = options;

  const period = daily ? dateKey() : 'ALL';
  const key = `${prefix}:${period}`;

  // `upsert` compiles to a single atomic statement; concurrent callers are
  // serialised by the row lock rather than by application code.
  const sequence = await db.sequence.upsert({
    where: { key },
    create: { key, value: 1 },
    update: { value: { increment: 1 } },
  });

  const counter = String(sequence.value).padStart(padding, '0');
  return daily ? `${prefix}-${period}-${counter}` : `${prefix}-${counter}`;
}

/** Reads the current counter without consuming a number. */
export async function peekSequence(
  prefix: SequencePrefix,
  db: DbClient = prisma,
  options: { daily?: boolean } = {},
): Promise<number> {
  const period = options.daily === false ? 'ALL' : dateKey();
  const row = await db.sequence.findUnique({ where: { key: `${prefix}:${period}` } });
  return row?.value ?? 0;
}
