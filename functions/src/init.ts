import { log } from './Logger';
import { queryOne } from './Database';

/**
 * Eagerly verify middleware tables exist at startup.
 * Calls after DB pool is ready, before the server starts listening.
 *
 * The canonical schema is in functions/schema.sql — run `pnpm run db:setup`
 * to apply it. This check only logs warnings; the middleware handles
 * missing tables gracefully by degrading (e.g. skipping rate limiting).
 */
export async function ensureMiddlewareTables(): Promise<void> {
  try {
    await queryOne(`SELECT 1 FROM rate_limits LIMIT 1`);
    log('rate_limits table: OK');
  } catch {
    log('WARNING: rate_limits table not found');
    log('  Run "pnpm run db:setup" to initialize the database schema.');
    log('  Until then, rate limiting will be unavailable.');
  }

  // Check sessions table (used by auth middleware)
  try {
    await queryOne(`SELECT 1 FROM sessions LIMIT 1`);
    log('sessions table: OK');
  } catch {
    log('WARNING: sessions table not found');
  }
}
