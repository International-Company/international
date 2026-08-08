/**
 * Environment floor for tests that reach server modules.
 *
 * `src/core/config/env.ts` validates on import and refuses to load without a
 * database URL and a signing secret. Any test that imports a service — even one
 * that never touches a database, like a chain provider — pulls that validation
 * in transitively.
 *
 * These values exist only to satisfy the schema. Nothing here connects to
 * anything: a test that needs a real database sets its own `DATABASE_URL`
 * first, which the `??=` below leaves alone.
 *
 * Import this **before** the module under test — evaluation follows import
 * order, so moving it below is what makes it stop working.
 */

process.env.DATABASE_URL ??= 'file:./test-unused.db';
process.env.AUTH_SECRET ??= 'test-secret-with-enough-length-to-pass-validation';
process.env.LOG_LEVEL ??= 'error';
