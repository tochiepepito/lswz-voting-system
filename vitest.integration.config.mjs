/** @type {import('vitest/config')} */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Integration suite: exercises the real services against a real PostgreSQL
 * database (including the concurrency and duplicate-vote constraint tests).
 *
 * Requires TEST_DATABASE_URL. Every spec self-skips when it is absent so the
 * suite never produces false failures on a machine without Postgres.
 *
 * Runs single-threaded: the specs share one database and several of them
 * deliberately race transactions against each other.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '~tests': fileURLToPath(new URL('./tests', import.meta.url)),
      // The services read the voter session through next/headers. Outside a
      // Next request that throws, so it is swapped for an in-memory cookie jar.
      // Everything under src/ is exercised unchanged - only the transport moves.
      'next/headers': fileURLToPath(new URL('./tests/helpers/next-headers-stub.ts', import.meta.url)),
    },
  },
  test: {
    name: 'integration',
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/setup-integration.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
