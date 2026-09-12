import { cookies } from 'next/headers';
import { createHmac } from 'node:crypto';
import { env, isProduction } from './env';
import { constantTimeEquals } from './crypto';

/**
 * Cookie policy for the two session credentials in the system.
 *
 * Both cookies contain nothing but an opaque random token. No IGN, no vote, no
 * event id, no "hasVoted" flag - everything the server needs is looked up from
 * the token, so a voter editing their own cookies can only invalidate their
 * session, never change what the server believes about them.
 */

/**
 * `__Host-` is a browser-enforced prefix: the cookie is rejected unless it is
 * Secure, Path=/ and has no Domain attribute, which makes it impossible for a
 * sibling subdomain to overwrite it (a real attack against session fixation).
 * It requires HTTPS, so the prefix is dropped in local development.
 */
function cookieName(base: string): string {
  return isProduction ? `__Host-${base}` : base;
}

export const VOTER_SESSION_COOKIE = cookieName('gev_voter');
export const ADMIN_SESSION_COOKIE = cookieName('gev_admin');

type CookieOptions = {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict';
  path: string;
  maxAge?: number;
};

/**
 * `sameSite: 'lax'` for the voter cookie: voters follow links to a ballot from
 * Discord and Reddit, and 'strict' would drop the session on that first
 * navigation, forcing them to re-enter their IGN.
 */
function voterCookieOptions(maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/**
 * `sameSite: 'strict'` for the admin cookie: nothing should ever link into an
 * authenticated admin action from another site, so the stricter policy costs
 * nothing and removes a whole class of cross-site request.
 */
function adminCookieOptions(maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export const VOTER_SESSION_MAX_AGE = env.VOTER_SESSION_TTL_DAYS * 24 * 60 * 60;
export const ADMIN_SESSION_MAX_AGE = env.ADMIN_SESSION_TTL_HOURS * 60 * 60;

// --------------------------------------------------------------------------
// Read / write
// --------------------------------------------------------------------------

export async function readVoterSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(VOTER_SESSION_COOKIE)?.value ?? null;
}

export async function writeVoterSessionToken(token: string): Promise<void> {
  const store = await cookies();
  store.set(VOTER_SESSION_COOKIE, token, voterCookieOptions(VOTER_SESSION_MAX_AGE));
}

export async function clearVoterSessionToken(): Promise<void> {
  const store = await cookies();
  store.set(VOTER_SESSION_COOKIE, '', { ...voterCookieOptions(0), maxAge: 0 });
}

export async function readAdminSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(ADMIN_SESSION_COOKIE)?.value ?? null;
}

export async function writeAdminSessionToken(token: string): Promise<void> {
  const store = await cookies();
  store.set(ADMIN_SESSION_COOKIE, token, adminCookieOptions(ADMIN_SESSION_MAX_AGE));
}

export async function clearAdminSessionToken(): Promise<void> {
  const store = await cookies();
  store.set(ADMIN_SESSION_COOKIE, '', { ...adminCookieOptions(0), maxAge: 0 });
}

// --------------------------------------------------------------------------
// CSRF
// --------------------------------------------------------------------------

/**
 * Derive the CSRF token for a session.
 *
 * The token is a keyed HMAC of the session token, so:
 *   - it needs no second cookie and no extra database column;
 *   - it cannot be computed by anyone who does not already hold the session
 *     cookie, which is exactly the property a synchroniser token needs;
 *   - it is stable for the life of the session, so it can be rendered into a
 *     server component and posted back from a form.
 *
 * A cross-site attacker's request *does* carry the victim's cookie, but it
 * cannot carry this value, because the attacker cannot read the cookie to
 * derive it.
 */
export function deriveCsrfToken(sessionToken: string): string {
  return createHmac('sha256', env.SESSION_TOKEN_PEPPER)
    .update(`csrf-token:${sessionToken}`)
    .digest('base64url');
}

/** Constant-time check of a submitted CSRF token against the session cookie. */
export function isValidCsrfToken(
  sessionToken: string | null,
  submittedToken: string | null | undefined,
): boolean {
  if (!sessionToken || !submittedToken) return false;
  return constantTimeEquals(deriveCsrfToken(sessionToken), submittedToken);
}

/** Form field name carrying the CSRF token. */
export const CSRF_FIELD = 'csrfToken';
/** Header carrying the CSRF token on JSON requests. */
export const CSRF_HEADER = 'x-csrf-token';
