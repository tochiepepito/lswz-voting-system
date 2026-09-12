import {
  createHmac,
  randomBytes,
  randomInt,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { env } from './env';

/**
 * All cryptographic primitives used by the system, in one place.
 *
 * Two deliberate choices worth knowing about:
 *
 * 1. Passwords use Node's built-in `scrypt` rather than bcrypt. It needs no
 *    native build toolchain (which matters on Windows and in slim containers),
 *    it is memory-hard, and unlike bcrypt it does not silently truncate input at
 *    72 bytes. The cost parameters are stored inside each digest, so they can be
 *    raised later without invalidating existing passwords.
 *
 * 2. Every stored digest of a *low-entropy or privacy-sensitive* value (IGN, IP,
 *    user agent) is a keyed HMAC, not a bare hash. A bare SHA-256 of an IGN or
 *    an IPv4 address is trivially brute-forced from a database dump; an HMAC
 *    under a secret pepper is not. Session tokens are high-entropy, but are
 *    hashed too so that a database leak yields no usable session.
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// --------------------------------------------------------------------------
// Keyed hashing
// --------------------------------------------------------------------------

/**
 * Domain separators. Hashing `"ign:PlayerOne"` rather than `"PlayerOne"` means a
 * digest computed for one purpose can never be replayed as a digest for
 * another, even where two purposes share a pepper.
 */
const DOMAIN = {
  ign: 'ign',
  ip: 'ip',
  userAgent: 'ua',
  sessionToken: 'session',
  csrfToken: 'csrf',
  rateLimitBucket: 'rl-bucket',
  rateLimitIdentifier: 'rl-id',
} as const;

type Domain = (typeof DOMAIN)[keyof typeof DOMAIN];

function keyedHash(pepper: string, domain: Domain, value: string): string {
  return createHmac('sha256', pepper).update(`${domain}:${value}`).digest('hex');
}

/**
 * Stable identity digest for a *normalised* IGN.
 *
 * Always pass the output of `normalizeIgn()`. Hashing a raw IGN would defeat
 * duplicate detection, so callers go through `VoterService` rather than calling
 * this directly.
 */
export function hashNormalizedIgn(normalizedName: string): string {
  return keyedHash(env.IGN_HASH_PEPPER, DOMAIN.ign, normalizedName);
}

/** Digest of a client IP. Raw addresses are never persisted. */
export function hashIp(ip: string): string {
  return keyedHash(env.IP_HASH_PEPPER, DOMAIN.ip, ip);
}

/** Digest of a user-agent string, for correlating abuse without storing it. */
export function hashUserAgent(userAgent: string): string {
  return keyedHash(env.IP_HASH_PEPPER, DOMAIN.userAgent, userAgent);
}

/** Lookup digest for an opaque session token held in a cookie. */
export function hashSessionToken(token: string): string {
  return keyedHash(env.SESSION_TOKEN_PEPPER, DOMAIN.sessionToken, token);
}

/** Lookup digest for a double-submit CSRF token. */
export function hashCsrfToken(token: string): string {
  return keyedHash(env.SESSION_TOKEN_PEPPER, DOMAIN.csrfToken, token);
}

/** Upsert key for one rate-limit window. */
export function hashRateLimitBucket(scope: string, identifier: string, windowStart: number): string {
  return keyedHash(
    env.SESSION_TOKEN_PEPPER,
    DOMAIN.rateLimitBucket,
    `${scope}|${identifier}|${windowStart}`,
  );
}

/** Window-independent digest of a rate-limit identifier, for correlation. */
export function hashRateLimitIdentifier(scope: string, identifier: string): string {
  return keyedHash(env.IP_HASH_PEPPER, DOMAIN.rateLimitIdentifier, `${scope}|${identifier}`);
}

// --------------------------------------------------------------------------
// Token generation
// --------------------------------------------------------------------------

/**
 * Cryptographically random, URL-safe opaque token.
 * 32 bytes = 256 bits, which is far beyond guessable for a session credential.
 */
export function generateToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

/**
 * Crockford base32 alphabet: no I, L, O or U, so a receipt code cannot be
 * misread down the line and cannot accidentally spell anything unfortunate.
 */
const RECEIPT_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Voter-facing receipt code, e.g. `K3M9-7TQW-2XRB`.
 *
 * Exists so the confirmation page can show the voter something referenceable
 * without the internal vote `id` ever reaching the browser. 60 bits of entropy:
 * unguessable, but short enough to read out over voice chat.
 */
export function generateReceiptCode(): string {
  const groups: string[] = [];

  for (let group = 0; group < 3; group += 1) {
    let chunk = '';
    for (let position = 0; position < 4; position += 1) {
      chunk += RECEIPT_ALPHABET[randomInt(RECEIPT_ALPHABET.length)];
    }
    groups.push(chunk);
  }

  return groups.join('-');
}

// --------------------------------------------------------------------------
// Comparison
// --------------------------------------------------------------------------

/**
 * Length-safe, timing-safe string comparison.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak length,
 * so both sides are hashed to a fixed 32 bytes before comparison.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const digest = (value: string) => createHmac('sha256', 'compare').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

// --------------------------------------------------------------------------
// Password hashing
// --------------------------------------------------------------------------

const SCRYPT_PARAMS = {
  /** CPU/memory cost. 2^15 needs ~32 MiB and ~100ms on modern hardware. */
  N: 2 ** 15,
  r: 8,
  p: 1,
} as const;

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_LENGTH = 16;
/** Must exceed 128 * N * r (32 MiB at N=2^15, r=8) or scrypt refuses to run. */
const SCRYPT_MAXMEM = 96 * 1024 * 1024;

const PASSWORD_SCHEME = 'scrypt';

// Re-exported so server-side callers have one import for password concerns.
export { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from './password-policy';

/**
 * Hash a password into `scrypt$N$r$p$salt$hash`.
 * The parameters travel with the digest so they can be raised without a reset.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_LENGTH);
  const derived = await scrypt(password.normalize('NFKC'), salt, SCRYPT_KEY_LENGTH, {
    ...SCRYPT_PARAMS,
    maxmem: SCRYPT_MAXMEM,
  });

  return [
    PASSWORD_SCHEME,
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

type ParsedDigest = {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
};

function parseDigest(stored: string): ParsedDigest | null {
  const parts = stored.split('$');
  if (parts.length !== 6) return null;

  const [scheme, rawN, rawR, rawP, rawSalt, rawHash] = parts;
  if (scheme !== PASSWORD_SCHEME) return null;

  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  // Refuse absurd parameters from a tampered row rather than exhausting memory.
  if (N < 2 ** 12 || N > 2 ** 20 || r < 1 || r > 32 || p < 1 || p > 16) return null;

  try {
    return {
      N,
      r,
      p,
      salt: Buffer.from(rawSalt ?? '', 'base64'),
      hash: Buffer.from(rawHash ?? '', 'base64'),
    };
  } catch {
    return null;
  }
}

/**
 * Verify a password against a stored digest. Returns false for malformed or
 * unrecognised digests rather than throwing, so a corrupted row cannot be used
 * to distinguish "no such admin" from "bad password".
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseDigest(stored);
  if (!parsed || parsed.hash.length === 0) return false;

  const derived = await scrypt(password.normalize('NFKC'), parsed.salt, parsed.hash.length, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    maxmem: SCRYPT_MAXMEM,
  });

  return timingSafeEqual(derived, parsed.hash);
}

/** True when a stored digest was produced with weaker parameters than current. */
export function passwordNeedsRehash(stored: string): boolean {
  const parsed = parseDigest(stored);
  if (!parsed) return true;

  return (
    parsed.N < SCRYPT_PARAMS.N || parsed.r < SCRYPT_PARAMS.r || parsed.hash.length < SCRYPT_KEY_LENGTH
  );
}

/**
 * A valid digest of an unguessable value, cached after first use.
 *
 * Login verifies against this when the e-mail is unknown, so a request for a
 * nonexistent account costs the same wall-clock time as one for a real account.
 * Without it, response latency alone enumerates valid administrator e-mails.
 */
let decoyDigest: Promise<string> | null = null;

export function getDecoyPasswordDigest(): Promise<string> {
  decoyDigest ??= hashPassword(generateToken(32));
  return decoyDigest;
}
