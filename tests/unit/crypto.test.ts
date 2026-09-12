import { describe, expect, it } from 'vitest';
import {
  constantTimeEquals,
  generateReceiptCode,
  generateToken,
  hashIp,
  hashNormalizedIgn,
  hashSessionToken,
  hashUserAgent,
  hashPassword,
  passwordNeedsRehash,
  verifyPassword,
} from '@/lib/crypto';

/**
 * Cryptographic guarantees the rest of the system leans on.
 *
 * scrypt is intentionally slow, so the password tests get a generous timeout and
 * hash as few times as possible.
 */

describe('keyed hashing', () => {
  it('is deterministic for the same input', () => {
    expect(hashNormalizedIgn('playerone')).toBe(hashNormalizedIgn('playerone'));
  });

  it('produces different digests for different inputs', () => {
    expect(hashNormalizedIgn('playerone')).not.toBe(hashNormalizedIgn('playertwo'));
  });

  it('is domain-separated, so one digest cannot be replayed as another', () => {
    // Same input, different purpose - the digests must not collide, or a value
    // hashed as an IP could be presented as a session token.
    const value = 'same-input-everywhere';

    const digests = new Set([
      hashNormalizedIgn(value),
      hashIp(value),
      hashUserAgent(value),
      hashSessionToken(value),
    ]);

    expect(digests.size).toBe(4);
  });

  it('produces a full-length SHA-256 hex digest', () => {
    expect(hashNormalizedIgn('playerone')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is case-sensitive, which is why callers must pass a NORMALISED name', () => {
    // Documents the contract: hashing a raw IGN would defeat duplicate
    // detection entirely, so VoterService always normalises first.
    expect(hashNormalizedIgn('PlayerOne')).not.toBe(hashNormalizedIgn('playerone'));
  });
});

describe('generateToken', () => {
  it('produces URL-safe tokens with no padding', () => {
    const token = generateToken(32);

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain('=');
  });

  it('does not repeat across many draws', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateToken(32)));
    expect(tokens.size).toBe(500);
  });
});

describe('generateReceiptCode', () => {
  it('uses the grouped Crockford format', () => {
    expect(generateReceiptCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it('never emits the ambiguous letters I, L, O or U', () => {
    const sample = Array.from({ length: 300 }, () => generateReceiptCode()).join('');
    expect(sample).not.toMatch(/[ILOU]/);
  });

  it('is unguessable enough to be collision-free in practice', () => {
    const codes = new Set(Array.from({ length: 1000 }, () => generateReceiptCode()));
    expect(codes.size).toBe(1000);
  });
});

describe('constantTimeEquals', () => {
  it('matches identical strings and rejects different ones', () => {
    expect(constantTimeEquals('abc123', 'abc123')).toBe(true);
    expect(constantTimeEquals('abc123', 'abc124')).toBe(false);
  });

  it('handles different lengths without throwing', () => {
    // The naive timingSafeEqual would throw here, which would itself leak length.
    expect(constantTimeEquals('short', 'much-much-longer')).toBe(false);
    expect(constantTimeEquals('', 'x')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });
});

describe('password hashing', () => {
  const PASSWORD = 'correct horse battery staple';

  it('verifies a correct password and rejects a wrong one', { timeout: 20_000 }, async () => {
    const digest = await hashPassword(PASSWORD);

    expect(await verifyPassword(PASSWORD, digest)).toBe(true);
    expect(await verifyPassword('wrong password entirely', digest)).toBe(false);
    // One character off.
    expect(await verifyPassword('correct horse battery stapl', digest)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', { timeout: 20_000 }, async () => {
    const [first, second] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);

    expect(first).not.toBe(second);
    expect(await verifyPassword(PASSWORD, first)).toBe(true);
    expect(await verifyPassword(PASSWORD, second)).toBe(true);
  });

  it('encodes its parameters so cost can be raised later', { timeout: 20_000 }, async () => {
    const digest = await hashPassword(PASSWORD);
    const [scheme, N, r, p] = digest.split('$');

    expect(scheme).toBe('scrypt');
    expect(Number(N)).toBe(32768);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
    expect(digest.split('$')).toHaveLength(6);
  });

  it('does not truncate long passwords the way bcrypt does', { timeout: 20_000 }, async () => {
    // bcrypt ignores everything past 72 bytes, so these two would collide there.
    const long = 'a'.repeat(80) + 'DIFFERENT_TAIL';
    const alsoLong = 'a'.repeat(80) + 'ANOTHER_TAIL__';

    const digest = await hashPassword(long);

    expect(await verifyPassword(long, digest)).toBe(true);
    expect(await verifyPassword(alsoLong, digest)).toBe(false);
  });

  it('normalises Unicode so an equivalent password still works', { timeout: 20_000 }, async () => {
    // Same string, composed vs decomposed. A user switching keyboards should
    // not be locked out.
    const composed = 'pässwörd-ünïcode';
    const decomposed = composed.normalize('NFD');

    expect(composed).not.toBe(decomposed);

    const digest = await hashPassword(composed);
    expect(await verifyPassword(decomposed, digest)).toBe(true);
  });

  it('rejects malformed or tampered digests instead of throwing', { timeout: 20_000 }, async () => {
    for (const bad of [
      '',
      'not-a-digest',
      'scrypt$32768$8$1$onlyfivefields',
      'bcrypt$32768$8$1$c2FsdA==$aGFzaA==',
      // Absurd cost parameters from a tampered row must not exhaust memory.
      'scrypt$999999999$8$1$c2FsdA==$aGFzaA==',
      'scrypt$32768$8$1$c2FsdA==$',
    ]) {
      expect(await verifyPassword('anything', bad), `digest: ${bad}`).toBe(false);
    }
  });

  it('flags weak or unparseable digests for rehashing', { timeout: 20_000 }, async () => {
    expect(passwordNeedsRehash(await hashPassword(PASSWORD))).toBe(false);
    // An older, cheaper digest.
    expect(passwordNeedsRehash('scrypt$16384$8$1$c2FsdA==$aGFzaA==')).toBe(true);
    expect(passwordNeedsRehash('garbage')).toBe(true);
  });
});
