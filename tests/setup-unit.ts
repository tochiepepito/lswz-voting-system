/**
 * Unit-suite setup.
 *
 * Supplies a complete, valid environment before any module is imported, because
 * `lib/env.ts` validates at import time and several modules under test import it
 * transitively. The values are fixed constants rather than random ones so that
 * hash assertions are reproducible across runs.
 *
 * No database and no network are touched by anything in `tests/unit`.
 */

const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'mysql://test:test@localhost:3306/test',
  APP_URL: 'http://localhost:3000',
  // Deterministic 32+ character peppers. Never used outside the test suite.
  IGN_HASH_PEPPER: 'unit-test-ign-pepper-0123456789abcdef',
  IP_HASH_PEPPER: 'unit-test-ip-pepper-0123456789abcdef',
  SESSION_TOKEN_PEPPER: 'unit-test-session-pepper-0123456789abcdef',
  TRUSTED_PROXY_HOPS: '1',
  CAPTCHA_PROVIDER: 'none',
};

for (const [key, value] of Object.entries(TEST_ENV)) {
  process.env[key] = value;
}
