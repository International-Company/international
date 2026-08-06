import { prisma } from '@/core/db/prisma';
import { bootstrap } from '@/core/bootstrap';

/**
 * Health check for the platform's load balancer.
 *
 * Public and deliberately uninformative on failure: it reports whether the
 * process can serve traffic, not what is wrong with it. Version numbers, stack
 * traces and connection strings do not belong on an unauthenticated endpoint.
 *
 * Hitting this also bootstraps the process (idempotent), so a deployment whose
 * first traffic is a health check still starts its background worker.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  bootstrap();

  try {
    // Cheapest possible round trip that proves the pool is actually usable.
    await prisma.$queryRaw`SELECT 1`;

    return Response.json(
      { status: 'ok', uptime: Math.round(process.uptime()) },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return Response.json(
      { status: 'unavailable' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
