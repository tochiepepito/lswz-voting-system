/**
 * Integration-suite setup.
 *
 * Points the application at TEST_DATABASE_URL and truncates every table before
 * each test. Every spec self-skips when TEST_DATABASE_URL is absent, so the
 * suite is a no-op rather than a failure on a machine with no PostgreSQL.
 *
 * SAFETY: the suite truncates tables. It refuses to run against a URL that does
 * not look like a test database, so a stray `DATABASE_URL` in the environment
 * cannot wipe real election data.
 */

import { afterAll, beforeEach } from 'vitest';

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];

export const hasTestDatabase = Boolean(testDatabaseUrl);

if (testDatabaseUrl) {
  const looksLikeTestDatabase = /test|_ci|localhost|127\.0\.0\.1/i.test(testDatabaseUrl);

  if (!looksLikeTestDatabase) {
    throw new Error(
      'TEST_DATABASE_URL does not look like a test database. This suite TRUNCATES every table; ' +
        'point it at a database whose name contains "test" or that runs on localhost.',
    );
  }

  process.env['DATABASE_URL'] = testDatabaseUrl;
}

// A valid environment must exist before any module importing `lib/env` loads.
// NODE_ENV is already 'test' under Vitest and is typed read-only, so it is left
// alone rather than reassigned.
process.env['DATABASE_URL'] ??= 'mysql://test:test@localhost:3306/test';
process.env['APP_URL'] ??= 'http://localhost:3000';
process.env['IGN_HASH_PEPPER'] ??= 'integration-ign-pepper-0123456789abcdef';
process.env['IP_HASH_PEPPER'] ??= 'integration-ip-pepper-0123456789abcdef';
process.env['SESSION_TOKEN_PEPPER'] ??= 'integration-session-pepper-0123456789ab';
process.env['TRUSTED_PROXY_HOPS'] ??= '1';
process.env['CAPTCHA_PROVIDER'] ??= 'none';

// Generous limits by default; the rate-limit spec overrides them for itself.
process.env['RL_VOTE_SESSION_MAX'] ??= '1000';
process.env['RL_VOTE_IP_MAX'] ??= '1000';
process.env['RL_CLAIM_IP_MAX'] ??= '1000';
process.env['RL_LOGIN_IP_MAX'] ??= '1000';

/**
 * Tables in an order that satisfies the foreign keys, though CASCADE makes the
 * order moot. Listed explicitly rather than discovered, so a new table has to be
 * added here deliberately and cannot be silently left dirty between tests.
 */
const TABLES = [
  'vote_selections',
  'votes',
  'event_identity_claims',
  'voter_sessions',
  'voters',
  'voting_options',
  'audit_logs',
  'voting_events',
  'admin_sessions',
  'admins',
  'rate_limit_records',
];

if (hasTestDatabase) {
  const { prisma } = await import('@/lib/prisma');
  const { testCookieStore, setTestHeaders } = await import('./helpers/next-headers-stub');

  beforeEach(async () => {
    // MySQL has no `TRUNCATE ... CASCADE`, and truncating a table referenced by
    // a foreign key is refused outright. Constraint checks are therefore
    // disabled for the duration of the wipe and restored immediately after.
    // The statements are sequential rather than in a transaction because
    // TRUNCATE causes an implicit commit in MySQL.
    await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0;');

    try {
      for (const table of TABLES) {
        await prisma.$executeRawUnsafe(`TRUNCATE TABLE \`${table}\`;`);
      }
    } finally {
      await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1;');
    }

    // Each test starts from a fresh browser with no cookies.
    testCookieStore.reset();
    setTestHeaders();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });
}
