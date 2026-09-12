import { z } from 'zod';

/**
 * Validated, typed environment configuration.
 *
 * Parsed once at module load so a misconfigured deployment fails immediately
 * and loudly at boot, rather than silently behaving insecurely at 2am during an
 * election. Every consumer imports `env` instead of touching `process.env`.
 */

const PLACEHOLDER_PREFIX = 'CHANGE_ME';

/**
 * `next build` runs with NODE_ENV=production, but a build serves no requests and
 * issues no cookies. Treating it as "production" would mean a CI pipeline could
 * not compile the app without the real production secrets and an https URL in
 * scope, which pushes teams towards putting real secrets in CI - the opposite of
 * the intent.
 *
 * So the production-only rules degrade to warnings during the build phase, and
 * are enforced strictly the moment the server actually starts handling traffic.
 */
const isBuildPhase = process.env['NEXT_PHASE'] === 'phase-production-build';

/** Stand-in used only during a build, so compilation never needs a live database. */
const BUILD_PLACEHOLDER_DATABASE_URL = 'mysql://build:build@localhost:3306/build';

/** Integer read from a string env var, falling back when unset or blank. */
const intVar = (fallback: number, min = 1, max = 10_000_000) =>
  z
    .preprocess(
      (value) => (value === '' || value === undefined ? undefined : value),
      z.coerce.number().int().min(min).max(max).optional(),
    )
    .transform((value) => value ?? fallback);

/**
 * A 24+ character secret. Short secrets are rejected outright; unreplaced
 * placeholders are rejected in production and warned about in development.
 */
const secretVar = z
  .string({ required_error: 'Required. Generate one with: npm run secrets:generate' })
  .min(24, 'Must be at least 24 characters of high-entropy random data.');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    DATABASE_URL: z
      .string()
      .min(1, 'Required.')
      .refine(
        (value) => value.startsWith('mysql://'),
        'Must be a MySQL connection string, e.g. mysql://user:password@localhost:3306/voting_system',
      ),

    APP_URL: z.string().url('Must be an absolute URL, e.g. https://vote.example.com'),
    ADDITIONAL_ALLOWED_ORIGINS: z.string().default(''),

    IGN_HASH_PEPPER: secretVar,
    IP_HASH_PEPPER: secretVar,
    SESSION_TOKEN_PEPPER: secretVar,

    ADMIN_SESSION_TTL_HOURS: intVar(12, 1, 24 * 30),
    VOTER_SESSION_TTL_DAYS: intVar(30, 1, 365),

    RL_VOTE_SESSION_MAX: intVar(10),
    RL_VOTE_SESSION_WINDOW_SECONDS: intVar(3600),
    RL_VOTE_IP_MAX: intVar(40),
    RL_VOTE_IP_WINDOW_SECONDS: intVar(3600),
    RL_CLAIM_IP_MAX: intVar(30),
    RL_CLAIM_IP_WINDOW_SECONDS: intVar(900),
    RL_LOGIN_IP_MAX: intVar(10),
    RL_LOGIN_IP_WINDOW_SECONDS: intVar(900),

    ADMIN_LOCKOUT_THRESHOLD: intVar(8),
    ADMIN_LOCKOUT_MINUTES: intVar(15),

    CAPTCHA_PROVIDER: z.enum(['none', 'turnstile']).default('none'),
    TURNSTILE_SECRET_KEY: z.string().optional(),

    TRUSTED_PROXY_HOPS: intVar(0, 0, 10),
  })
  .superRefine((value, ctx) => {
    // Strict only when actually serving production traffic - see `isBuildPhase`.
    const isProduction = value.NODE_ENV === 'production' && !isBuildPhase;

    for (const key of ['IGN_HASH_PEPPER', 'IP_HASH_PEPPER', 'SESSION_TOKEN_PEPPER'] as const) {
      if (!value[key].startsWith(PLACEHOLDER_PREFIX)) continue;

      if (isProduction) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message:
            'Still set to the .env.example placeholder. Run `npm run secrets:generate` and set a real secret before deploying.',
        });
      } else {
        console.warn(
          `[env] ${key} is still the .env.example placeholder. Fine for local development, fatal in production.`,
        );
      }
    }

    if (value.CAPTCHA_PROVIDER === 'turnstile' && !value.TURNSTILE_SECRET_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TURNSTILE_SECRET_KEY'],
        message: 'Required when CAPTCHA_PROVIDER is "turnstile".',
      });
    }

    if (isProduction && value.APP_URL.startsWith('http://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_URL'],
        message:
          'Must be https in production: voter and admin session cookies are issued with the Secure attribute.',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const source: NodeJS.ProcessEnv = { ...process.env };

  /*
   * Treat a blank variable exactly like an absent one.
   *
   * Every hosting platform lets a variable be declared without a value, and
   * surfaces it as an empty string rather than leaving it undefined - Vercel,
   * Docker `ENV FOO=`, GitHub Actions and docker-compose all do this. Without
   * this pass, `CAPTCHA_PROVIDER=""` fails as "expected 'none' | 'turnstile',
   * received ''" instead of falling back to its default, and `??=` fallbacks
   * below never fire because the key technically exists.
   *
   * Blank means "I did not set this", so the schema's defaults should apply.
   */
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() === '') {
      delete source[key];
    }
  }

  // Compilation touches no database, so a build in CI does not need a real one.
  if (isBuildPhase && !source['DATABASE_URL']) {
    source['DATABASE_URL'] = BUILD_PLACEHOLDER_DATABASE_URL;
  }

  // Likewise, the build issues no cookies, so it does not need the real origin.
  if (isBuildPhase && !source['APP_URL']) {
    source['APP_URL'] = 'http://localhost:3000';
  }

  // Peppers are only used to hash values at request time.
  if (isBuildPhase) {
    const missing: string[] = [];

    for (const key of ['IGN_HASH_PEPPER', 'IP_HASH_PEPPER', 'SESSION_TOKEN_PEPPER'] as const) {
      if (source[key]) continue;

      source[key] = `${PLACEHOLDER_PREFIX}_build_time_placeholder_value_only`;
      missing.push(key);
    }

    if (missing.length > 0) {
      // Loud, but not fatal. The build genuinely does not need these; the
      // running server absolutely does, and this is the last chance to say so
      // somewhere the operator is actually looking (the deploy log).
      console.warn(
        `\n[env] WARNING: building without ${missing.join(', ')}.\n` +
          '[env] The build will succeed, but the server will refuse to start until\n' +
          '[env] these are set. Generate them with: npm run secrets:generate\n',
      );
    }
  }

  const parsed = EnvSchema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(
      `Invalid environment configuration:\n${details}\n\nSee .env.example for the full list of variables.`,
    );
  }

  return parsed.data;
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * Origins accepted for state-changing requests. Used by the same-origin check
 * that backs CSRF protection on every mutating route handler and server action.
 */
export const allowedOrigins: readonly string[] = (() => {
  const origins = new Set<string>();

  const add = (candidate: string) => {
    const trimmed = candidate.trim();
    if (!trimmed) return;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      throw new Error(`Invalid origin in ADDITIONAL_ALLOWED_ORIGINS: ${trimmed}`);
    }
  };

  add(env.APP_URL);
  env.ADDITIONAL_ALLOWED_ORIGINS.split(',').forEach(add);

  return Array.from(origins);
})();
