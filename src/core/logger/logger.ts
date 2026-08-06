import { env } from '@/core/config/env';

/**
 * Structured logger. Emits one JSON object per line in production so log
 * aggregators can index it, and a readable single line in development.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = LEVEL_ORDER[env.LOG_LEVEL];

/** Keys whose values are replaced before a log line is written. */
const REDACTED = new Set([
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'token',
  'tokenHash',
  'secret',
  'twoFactorSecret',
  'authorization',
  'cookie',
  'recoveryCodes',
  'secretCiphertext',
  'apiKey',
]);

export type LogContext = Record<string, unknown>;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACTED.has(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: Level, scope: string, message: string, context?: LogContext) {
  if (LEVEL_ORDER[level] < threshold) return;

  const record = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(context ? (redact(context) as LogContext) : {}),
  };

  const line =
    env.NODE_ENV === 'production'
      ? JSON.stringify(record)
      : `${record.ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}` +
        (context && Object.keys(context).length ? ` ${JSON.stringify(redact(context))}` : '');

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, c) => emit('debug', scope, m, c),
    info: (m, c) => emit('info', scope, m, c),
    warn: (m, c) => emit('warn', scope, m, c),
    error: (m, c) => emit('error', scope, m, c),
    child: (child) => createLogger(`${scope}:${child}`),
  };
}

export const logger = createLogger('app');
