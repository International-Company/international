import 'server-only';
import type { NextRequest } from 'next/server';
import { z, type ZodTypeAny } from 'zod';
import { AppError, errors, isAppError, type FieldIssue } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import { checkRateLimit } from '@/core/security/rate-limit';
import { getRequestMeta, requireActiveSession, requireSession } from '@/modules/auth/context';
import type { ResolvedSession } from '@/modules/auth/session.service';
import { bootstrap } from '@/core/bootstrap';
import { jsonResponse } from './json';

/**
 * Route handler factory.
 *
 * Every API endpoint is declared through this wrapper so that authentication,
 * authorisation, input validation, rate limiting, error shaping and logging are
 * applied uniformly instead of being re-implemented (and eventually forgotten)
 * per route.
 */

const log = createLogger('http');

export interface RouteContext<TBody, TQuery, TParams> {
  request: NextRequest;
  body: TBody;
  query: TQuery;
  params: TParams;
  session: ResolvedSession;
  meta: { ip: string | null; userAgent: string | null };
  /** Ready-made actor for service calls: identity, audit context and rights. */
  actor: {
    id: string;
    name: string;
    ip: string | null;
    userAgent: string | null;
    sessionId: string;
    permissions: string[];
    branchId: string | null;
  };
}

export interface RouteConfig<TBody, TQuery, TParams> {
  /** Every listed permission is required. */
  permissions?: string[];
  /** At least one listed permission is required. */
  anyPermission?: string[];
  /** Skip authentication entirely (login, health). */
  public?: boolean;
  /** Allow sessions that have not yet cleared the second factor. */
  allowPendingTwoFactor?: boolean;

  bodySchema?: ZodTypeAny;
  querySchema?: ZodTypeAny;
  paramsSchema?: ZodTypeAny;

  rateLimit?: { key: string; limit: number; windowSeconds: number };

  handler: (context: RouteContext<TBody, TQuery, TParams>) => Promise<unknown>;
}

/**
 * The context Next.js passes as the second argument to a route handler.
 *
 * `params` is deliberately `Promise<any>`: Next generates a per-route context
 * type (`Promise<{}>` for a static route, `Promise<{ id: string }>` for a
 * dynamic one) and validates our handler against it. A concrete type here would
 * be assignable to some routes and not others; `any` keeps this single wrapper
 * usable for every route, and the values are validated by `paramsSchema` on the
 * way in regardless.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NextRouteArgs = { params: Promise<any> };

export function route<TBody = unknown, TQuery = unknown, TParams = Record<string, string>>(
  config: RouteConfig<TBody, TQuery, TParams>,
) {
  return async function handle(request: NextRequest, args: NextRouteArgs): Promise<Response> {
    const startedAt = Date.now();
    const path = new URL(request.url).pathname;

    // Registers job handlers, event subscribers and the worker on first use.
    // Guarded by a process-global flag, so this is one boolean check per
    // request after the first. It lives here — and in the authenticated layout
    // — rather than in `instrumentation.ts` because Next also compiles that
    // file for the edge runtime, where this module graph (node:crypto, fs,
    // zlib) cannot be bundled. Every request enters through one of the two.
    bootstrap();

    try {
      const meta = await getRequestMeta();

      // --- Authentication ------------------------------------------------
      let session: ResolvedSession | null = null;
      if (!config.public) {
        session = config.allowPendingTwoFactor
          ? await requireSession()
          : await requireActiveSession();
      }

      // --- Authorisation --------------------------------------------------
      if (session && config.permissions?.length) {
        const missing = config.permissions.find((p) => !session!.user.permissions.includes(p));
        if (missing) throw errors.forbidden(missing);
      }
      if (session && config.anyPermission?.length) {
        const allowed = config.anyPermission.some((p) => session!.user.permissions.includes(p));
        if (!allowed) throw errors.forbidden(config.anyPermission.join(' | '));
      }

      // --- Rate limiting ---------------------------------------------------
      if (config.rateLimit) {
        const scope = session?.user.id ?? meta.ip ?? 'anonymous';
        const result = checkRateLimit(`${config.rateLimit.key}:${scope}`, config.rateLimit);
        if (!result.allowed) throw errors.rateLimited(result.retryAfterSeconds);
      }

      // --- Input ------------------------------------------------------------
      const rawParams = args?.params ? await args.params : {};
      const params = config.paramsSchema
        ? parseOrThrow<TParams>(config.paramsSchema, rawParams, 'params')
        : (rawParams as TParams);

      const query = config.querySchema
        ? parseOrThrow<TQuery>(
            config.querySchema,
            Object.fromEntries(new URL(request.url).searchParams),
            'query',
          )
        : ({} as TQuery);

      let body = {} as TBody;
      if (config.bodySchema) {
        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          throw errors.validation([{ path: 'body', message: 'Request body must be valid JSON' }]);
        }
        body = parseOrThrow(config.bodySchema, raw, 'body');
      }

      // --- Handler -----------------------------------------------------------
      const result = await config.handler({
        request,
        body,
        query,
        params: params as TParams,
        session: session as ResolvedSession,
        meta,
        actor: {
          id: session?.user.id ?? 'anonymous',
          name: session?.user.fullNameEn ?? 'Anonymous',
          ip: meta.ip,
          userAgent: meta.userAgent,
          sessionId: session?.sessionId ?? '',
          permissions: session?.user.permissions ?? [],
          branchId: session?.user.branchId ?? null,
        },
      });

      log.debug('request', { path, method: request.method, ms: Date.now() - startedAt });

      if (result instanceof Response) return result;
      if (result === undefined || result === null) return new Response(null, { status: 204 });
      return jsonResponse({ data: result });
    } catch (error) {
      return handleError(error, { path, method: request.method, ms: Date.now() - startedAt });
    }
  };
}

function parseOrThrow<T>(schema: ZodTypeAny, value: unknown, source: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data as T;

  const issues: FieldIssue[] = result.error.issues.map((issue) => ({
    path: issue.path.length ? issue.path.join('.') : source,
    message: issue.message,
    code: issue.code,
  }));
  throw errors.validation(issues);
}

function handleError(error: unknown, context: { path: string; method: string; ms: number }): Response {
  if (isAppError(error)) {
    // 4xx are expected outcomes, not incidents — log them quietly.
    if (error.status >= 500) log.error(error.message, { ...context, code: error.code, error });
    else log.debug('request rejected', { ...context, code: error.code });

    return jsonResponse(
      { error: error.toJSON() },
      {
        status: error.status,
        headers:
          error.code === 'RATE_LIMITED' && error.params.retryAfterSeconds
            ? { 'retry-after': String(error.params.retryAfterSeconds) }
            : undefined,
      },
    );
  }

  if (error instanceof z.ZodError) {
    return handleError(
      errors.validation(
        error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
      ),
      context,
    );
  }

  // Prisma unique-constraint violations surface as user-correctable conflicts.
  if (isPrismaError(error) && error.code === 'P2002') {
    const target = Array.isArray(error.meta?.target) ? error.meta.target.join(', ') : 'value';
    return handleError(
      new AppError('CONFLICT', `A record with this ${target} already exists`, {
        messageKey: 'errors.duplicate',
        params: { field: String(target) },
      }),
      context,
    );
  }
  if (isPrismaError(error) && error.code === 'P2025') {
    return handleError(errors.notFound('Record'), context);
  }

  log.error('Unhandled route error', { ...context, error });
  return jsonResponse({ error: errors.internal().toJSON() }, { status: 500 });
}

function isPrismaError(error: unknown): error is { code: string; meta?: { target?: unknown } } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('P')
  );
}

// ---------------------------------------------------------------------------
// Shared query schemas
// ---------------------------------------------------------------------------

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type Pagination = z.infer<typeof paginationSchema>;

export interface Paginated<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export function paginate<T>(rows: T[], total: number, pagination: Pagination): Paginated<T> {
  return {
    rows,
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
    pageCount: Math.max(1, Math.ceil(total / pagination.pageSize)),
  };
}
