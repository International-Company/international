import 'server-only';
import { z } from 'zod';

/**
 * Environment contract. Parsed once, at first import, so a misconfigured
 * deployment fails loudly at boot instead of subtly at runtime.
 */
const schema = z.object({
  /**
   * Normalised rather than validated as an enum, and biased towards production.
   *
   * Hosting platforms set this to values outside the standard three, and a
   * strict enum would refuse to boot over a cosmetic mismatch. More importantly,
   * `isProduction` gates the `secure` flag on session cookies: treating an
   * unrecognised value as development would silently ship cookies that travel
   * over plain HTTP. Anything that is not explicitly development or test is
   * therefore production.
   */
  NODE_ENV: z
    .string()
    .default('development')
    .transform((value) => {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'development' || normalized === 'dev') return 'development' as const;
      if (normalized === 'test') return 'test' as const;
      return 'production' as const;
    }),

  DATABASE_URL: z.string().min(1),

  AUTH_SECRET: z
    .string()
    .min(32, 'AUTH_SECRET must be at least 32 characters — it keys session signing and secret encryption'),

  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(60),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(12),

  APP_NAME: z.string().default('International'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z
    .string()
    .default('info')
    .transform((value) => {
      const normalized = value.trim().toLowerCase();
      return (['debug', 'info', 'warn', 'error'] as const).includes(
        normalized as 'debug' | 'info' | 'warn' | 'error',
      )
        ? (normalized as 'debug' | 'info' | 'warn' | 'error')
        : ('info' as const);
    }),

  JOBS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  JOBS_TICK_SECONDS: z.coerce.number().int().positive().default(30),

  BACKUP_DIR: z.string().default('./storage/backups'),

  TRON_API_BASE: z.string().default('https://api.trongrid.io'),
  TRON_API_KEY: z.string().default(''),
  TRON_USDT_CONTRACT: z.string().default('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),

  ETH_API_BASE: z.string().default('https://api.etherscan.io/api'),
  ETH_API_KEY: z.string().default(''),
  ETH_USDT_CONTRACT: z.string().default('0xdAC17F958D2ee523a2206206994597C13D831ec7'),
});

function load() {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return parsed.data;
}

export const env = load();

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
