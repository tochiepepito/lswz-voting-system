import { readFileSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '@/lib/crypto';

/**
 * The seed script and `scripts/create-admin.ts` duplicate the password-hashing
 * code from `lib/crypto.ts`, because they run under plain `tsx` with no path
 * aliases and no validated env module.
 *
 * Duplication is a drift risk: if the application's scrypt parameters or digest
 * encoding ever change, a seeded or CLI-created administrator would silently
 * become unable to sign in. These tests make that drift a build failure instead
 * of a support ticket.
 */

/** Pull the scrypt parameters out of a standalone script's source. */
function extractScryptParams(path: string): { N: number; r: number; p: number } {
  const source = readFileSync(path, 'utf8');

  const match = /const SCRYPT = \{\s*N:\s*2 \*\* (\d+),\s*r:\s*(\d+),\s*p:\s*(\d+)/.exec(source);
  if (!match) throw new Error(`could not find SCRYPT parameters in ${path}`);

  return { N: 2 ** Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
}

function extractNumber(path: string, name: string): number {
  const source = readFileSync(path, 'utf8');

  const match = new RegExp(`const ${name} = ([0-9 *]+);`).exec(source);
  if (!match?.[1]) throw new Error(`could not find ${name} in ${path}`);

  // Handles both "64" and "96 * 1024 * 1024".
  return match[1]
    .split('*')
    .map((part) => Number(part.trim()))
    .reduce((product, value) => product * value, 1);
}

const SCRIPTS = ['prisma/seed.ts', 'scripts/create-admin.ts'];

describe('standalone scripts stay in step with lib/crypto', () => {
  it('the application emits the parameters the scripts hard-code', { timeout: 20_000 }, async () => {
    const digest = await hashPassword('a reference password');
    const [scheme, N, r, p] = digest.split('$');

    expect(scheme).toBe('scrypt');

    for (const path of SCRIPTS) {
      const params = extractScryptParams(path);

      expect(params.N, `${path} N`).toBe(Number(N));
      expect(params.r, `${path} r`).toBe(Number(r));
      expect(params.p, `${path} p`).toBe(Number(p));
    }
  });

  it('agrees on key length and the memory ceiling', () => {
    for (const path of SCRIPTS) {
      expect(extractNumber(path, 'KEY_LENGTH'), `${path} KEY_LENGTH`).toBe(64);
      expect(extractNumber(path, 'MAXMEM'), `${path} MAXMEM`).toBe(96 * 1024 * 1024);
    }
  });

  it('produces a digest the application can actually verify', { timeout: 20_000 }, async () => {
    // Reproduce what the scripts do, byte for byte, then hand it to the real
    // verifier. This is the assertion that matters: a seeded administrator must
    // be able to sign in.
    const params = extractScryptParams('prisma/seed.ts');
    const password = 'seeded-administrator-password';

    const salt = randomBytes(16);
    const derived = scryptSync(password.normalize('NFKC'), salt, 64, {
      ...params,
      maxmem: 96 * 1024 * 1024,
    });

    const scriptDigest = [
      'scrypt',
      params.N,
      params.r,
      params.p,
      salt.toString('base64'),
      derived.toString('base64'),
    ].join('$');

    expect(await verifyPassword(password, scriptDigest)).toBe(true);
    expect(await verifyPassword('the wrong password', scriptDigest)).toBe(false);
  });

  it('keeps the scripts free of path aliases, which tsx would not resolve', () => {
    for (const path of SCRIPTS) {
      const source = readFileSync(path, 'utf8');
      const aliasImports = source.match(/from '@\/[^']+'/g);

      expect(aliasImports, `${path} must not use @/ imports`).toBeNull();
    }
  });

  it('refuses to seed a production database', () => {
    // A guard worth asserting rather than trusting: the seed creates a known
    // password and sample ballots.
    const source = readFileSync('prisma/seed.ts', 'utf8');

    expect(source).toContain("NODE_ENV'] === 'production'");
    expect(source).toContain('Refusing to seed a production database');
  });
});
