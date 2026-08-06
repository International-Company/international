import 'server-only';
import { z } from 'zod';

/**
 * Environment contract. Parsed once, at first import, so a misconfigured
 * deployment fails loudly at boot instead of subtly at runtime.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1),

  AUTH_SECRET: z
    .string()
    .min(32, 'AUTH_SECRET must be at least 32 characters — it keys session signing and secret encryption'),

  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(60),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(12),

  APP_NAME: z.string().default('IFMS'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

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
