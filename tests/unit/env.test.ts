import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Environment loading.
 *
 * `lib/env.ts` validates at import time, so each case here resets the module
 * registry and re-imports it under a different `process.env`.
 *
 * The case that matters most: every hosting platform lets a variable be
 * declared without a value and surfaces it as an EMPTY STRING rather than
 * leaving it undefined. A deploy failed on exactly this - `CAPTCHA_PROVIDER=""`
 * was reported as "expected 'none' | 'turnstile', received ''" instead of
 * falling back to its default.
 */

const ORIGINAL_ENV = { ...process.env };

/** Load `lib/env` fresh under a given environment. */
async function loadEnv(overrides: Record<string, string | undefined>) {
  vi.resetModules();

  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[key] = value;
  }

  return import('@/lib/env');
}

const VALID_SECRET = 'a-sufficiently-long-test-secret-value';

const WORKING: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'mysql://user:pass@localhost:3306/db',
  APP_URL: 'http://localhost:3000',
  IGN_HASH_PEPPER: VALID_SECRET,
  IP_HASH_PEPPER: VALID_SECRET,
  SESSION_TOKEN_PEPPER: VALID_SECRET,
};

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
  vi.resetModules();
});

describe('blank variables are treated as unset', () => {
  it('falls back to the default for a blank enum instead of failing', async () => {
    const { env } = await loadEnv({ ...WORKING, CAPTCHA_PROVIDER: '' });

    expect(env.CAPTCHA_PROVIDER).toBe('none');
  });

  it('falls back to the default for a blank integer', async () => {
    const { env } = await loadEnv({
      ...WORKING,
      TRUSTED_PROXY_HOPS: '',
      RL_VOTE_IP_MAX: '',
    });

    expect(env.TRUSTED_PROXY_HOPS).toBe(0);
    expect(env.RL_VOTE_IP_MAX).toBe(40);
  });

  it('treats a whitespace-only value as unset', async () => {
    const { env } = await loadEnv({ ...WORKING, CAPTCHA_PROVIDER: '   ' });

    expect(env.CAPTCHA_PROVIDER).toBe('none');
  });

  it('still honours a real value', async () => {
    const { env } = await loadEnv({
      ...WORKING,
      CAPTCHA_PROVIDER: 'turnstile',
      TURNSTILE_SECRET_KEY: 'secret',
      TRUSTED_PROXY_HOPS: '2',
    });

    expect(env.CAPTCHA_PROVIDER).toBe('turnstile');
    expect(env.TRUSTED_PROXY_HOPS).toBe(2);
  });
});

describe('build phase vs runtime', () => {
  const BUILD = { NEXT_PHASE: 'phase-production-build', NODE_ENV: 'production' };

  it('compiles without any secrets, so CI needs no production credentials', async () => {
    const { env } = await loadEnv({
      ...BUILD,
      IGN_HASH_PEPPER: '',
      IP_HASH_PEPPER: '',
      SESSION_TOKEN_PEPPER: '',
      CAPTCHA_PROVIDER: '',
    });

    // A build serves no requests and issues no cookies.
    expect(env.CAPTCHA_PROVIDER).toBe('none');
    expect(env.DATABASE_URL).toContain('mysql://');
  });

  it('warns loudly about the secrets it substituted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await loadEnv({ ...BUILD, IGN_HASH_PEPPER: '', IP_HASH_PEPPER: '', SESSION_TOKEN_PEPPER: '' });

    const output = warn.mock.calls.flat().join('\n');
    expect(output).toContain('IGN_HASH_PEPPER');
    expect(output).toContain('secrets:generate');
  });

  it('allows http APP_URL during a build but refuses it at runtime', async () => {
    await expect(loadEnv({ ...BUILD, ...WORKING, NODE_ENV: 'production' })).resolves.toBeTruthy();

    // Same configuration, no NEXT_PHASE: now it is serving traffic, and the
    // Secure cookie policy makes plain http a misconfiguration.
    await expect(
      loadEnv({ ...WORKING, NODE_ENV: 'production', APP_URL: 'http://vote.example.com' }),
    ).rejects.toThrow(/https in production/);
  });

  it('refuses to start at runtime without real secrets', async () => {
    await expect(
      loadEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'mysql://user:pass@localhost:3306/db',
        APP_URL: 'https://vote.example.com',
        IGN_HASH_PEPPER: '',
      }),
    ).rejects.toThrow(/IGN_HASH_PEPPER/);
  });

  it('refuses an unreplaced placeholder secret in production', async () => {
    const placeholder = 'CHANGE_ME_run_npm_run_secrets_generate';

    await expect(
      loadEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'mysql://user:pass@localhost:3306/db',
        APP_URL: 'https://vote.example.com',
        IGN_HASH_PEPPER: placeholder,
        IP_HASH_PEPPER: placeholder,
        SESSION_TOKEN_PEPPER: placeholder,
      }),
    ).rejects.toThrow(/placeholder/);
  });
});

describe('connection string', () => {
  it('rejects a PostgreSQL URL, which would fail confusingly later', async () => {
    await expect(
      loadEnv({ ...WORKING, DATABASE_URL: 'postgresql://user:pass@localhost:5432/db' }),
    ).rejects.toThrow(/MySQL connection string/);
  });
});
