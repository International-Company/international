import 'server-only';
import { PrismaClient } from '@prisma/client';
import { env, isProduction } from '@/core/config/env';

/**
 * A single PrismaClient per process. Next.js hot-reloads modules in dev, which
 * would otherwise leak a new connection pool on every edit.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.LOG_LEVEL === 'debug' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (!isProduction) globalForPrisma.prisma = prisma;

/**
 * The transaction-scoped client type. Every service method that participates in
 * a unit of work accepts this so callers can compose them atomically.
 */
export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export type DbClient = PrismaClient | Tx;

/**
 * Runs `fn` inside a database transaction. Nested calls reuse the outer
 * transaction rather than opening a second one, so services stay composable.
 */
export async function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  existing?: DbClient,
): Promise<T> {
  if (existing && existing !== prisma) {
    return fn(existing as Tx);
  }
  return prisma.$transaction((tx) => fn(tx), {
    maxWait: 10_000,
    timeout: 30_000,
  });
}
